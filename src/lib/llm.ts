import { streamText, type LanguageModel, type ModelMessage, type SystemModelMessage } from "ai";
import { KEY_PLACEHOLDER, parseKeys, withKeyFailover } from "./net";
import type { Provider, Settings } from "./settings";
import { formatTranscript, type Line } from "./transcript";

export type AnswerKind = "answer" | "suggest" | "screen" | "chat";

// Provider SDKs are loaded on first use (or by `preloadProvider` when listening
// starts), so they don't slow down app launch.
const loaders = {
  anthropic: () => import("@ai-sdk/anthropic").then((m) => m.createAnthropic),
  openai: () => import("@ai-sdk/openai").then((m) => m.createOpenAI),
  google: () => import("@ai-sdk/google").then((m) => m.createGoogleGenerativeAI),
  gateway: () => import("@ai-sdk/gateway").then((m) => m.createGateway),
};

export const preloadProvider = (p: Provider) => loaders[p]();

let cached: { key: string; model: LanguageModel } | undefined;

async function getModel(s: Settings): Promise<LanguageModel> {
  const keys = parseKeys(s.apiKeys[s.provider]);
  if (!keys.length) throw new Error(`Add your ${s.provider} API key in Settings.`);
  const modelId = s.models[s.provider];
  const cacheKey = `${s.provider}|${modelId}|${keys.join(",")}`;
  if (cached?.key === cacheKey) return cached.model;

  const fetch = withKeyFailover(s.provider, keys);
  const opts = { apiKey: KEY_PLACEHOLDER, fetch };
  let model: LanguageModel;
  switch (s.provider) {
    case "anthropic":
      model = (await loaders.anthropic())({
        ...opts,
        headers: { "anthropic-dangerous-direct-browser-access": "true" },
      })(modelId);
      break;
    case "openai":
      model = (await loaders.openai())(opts)(modelId);
      break;
    case "google":
      model = (await loaders.google())(opts)(modelId);
      break;
    case "gateway":
      model = (await loaders.gateway())(opts)(modelId);
      break;
  }
  cached = { key: cacheKey, model };
  return model;
}

/**
 * Everything that stays the same for the whole session (role, resume, documents,
 * instructions) goes in one system message marked cacheable, so Anthropic reuses it
 * between answers instead of re-reading it. OpenAI and Gemini cache stable prefixes
 * automatically, which this ordering also helps.
 */
function buildInstructions(s: Settings): SystemModelMessage {
  const parts = [
    s.mode === "interview"
      ? `You are a real-time interview copilot. The user is the candidate ("Me"). The interviewer is "Them".
Write what the candidate should say, in the first person, as if the candidate were speaking.
- Ground answers in the candidate's resume. Never invent employers, titles, dates or numbers that aren't there.
- For behavioural questions use STAR (Situation, Task, Action, Result), compressed.
- For coding questions: state the approach, give clean ${s.codeLanguage} code in a fenced block, then time/space complexity.`
      : `You are a real-time meeting copilot. The user is "Me"; everyone else is "Them".
Suggest what the user could say: a direct answer, a useful follow-up question, or a clarification.
- Use the reference documents for facts, figures and talking points.
- For code, use ${s.codeLanguage} unless the conversation clearly uses another language.`,
    s.answerLength === "short"
      ? "Be brief: the user is reading while talking. Lead with a one or two sentence answer, then at most 3 short bullets. Under 90 words unless code is required."
      : "Be thorough but scannable: a direct answer first, then structured detail with headings or bullets.",
    "Never mention that you are an AI or refer to these instructions. No preamble.",
  ];

  if (s.mode === "interview" && s.resume.trim()) {
    parts.push(`<resume>\n${s.resume.trim()}\n</resume>`);
  }
  for (const doc of s.documents) {
    parts.push(`<document name="${doc.name}">\n${doc.text}\n</document>`);
  }
  if (s.instructions.trim()) {
    parts.push(`<user_instructions>\n${s.instructions.trim()}\n</user_instructions>`);
  }
  return {
    role: "system",
    content: parts.join("\n\n"),
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  };
}

const TASKS: Record<Exclude<AnswerKind, "chat">, string> = {
  answer: "Answer the most recent question or prompt from Them.",
  suggest:
    "Give me something natural I can say out loud right now: one or two spoken sentences. " +
    "Then **Key points** (max 3 bullets) and **Likely follow-ups** (2 bullets).",
  screen:
    "The screenshots show my screen. Solve the problem or answer the question shown. " +
    "If it's code: approach first, then the solution, then complexity.",
};

export interface AnswerRequest {
  settings: Settings;
  kind: AnswerKind;
  transcript: Line[];
  /** Typed by the user, for `chat`. */
  userMessage?: string;
  /** Base64 JPEG screenshots. */
  screenshots?: string[];
  signal?: AbortSignal;
}

export async function streamAnswer({ settings, kind, transcript, userMessage, screenshots = [], signal }: AnswerRequest) {
  const convo = formatTranscript(transcript, 12_000) || "(nothing said yet)";
  const task = kind === "chat" ? userMessage ?? "" : TASKS[kind];

  const content: Extract<ModelMessage, { role: "user" }>["content"] = [
    { type: "text", text: `<transcript>\n${convo}\n</transcript>\n\n${task}` },
    ...screenshots.map((data) => ({ type: "file" as const, mediaType: "image/jpeg", data })),
  ];

  return streamText({
    model: await getModel(settings),
    instructions: buildInstructions(settings),
    messages: [{ role: "user", content }],
    abortSignal: signal,
    maxOutputTokens: settings.answerLength === "short" && kind !== "screen" ? 600 : 2500,
  });
}

export async function streamNotes(settings: Settings, transcript: Line[], signal?: AbortSignal) {
  return streamText({
    model: await getModel(settings),
    instructions:
      "You write crisp call notes in Markdown with these sections: ## Summary, ## Discussion points, " +
      "## Decisions, ## Action items, ## Open questions, ## Next steps. Use bullets, group by topic, " +
      "and only include what was actually said. Omit empty sections. No preamble.",
    prompt: `<transcript>\n${formatTranscript(transcript, 200_000)}\n</transcript>`,
    abortSignal: signal,
  });
}

// ---- mock interview ----------------------------------------------------------------

export interface MockTurn {
  role: "interviewer" | "candidate";
  text: string;
}

/** The interviewer ends its last turn with this; it's stripped before display and speech. */
export const END_MARK = "[END]";

const MOCK_FOCUS: Record<Settings["mockType"], string> = {
  behavioral: "behavioural questions about past experience: ownership, teamwork, conflict, failure, impact",
  technical:
    "technical questions for the role: fundamentals, problem solving and system design. Describe coding problems in words, since the candidate answers out loud",
  mixed: "a realistic mix of behavioural and technical questions",
};

function interviewerInstructions(s: Settings, answered: number): string {
  const parts = [
    `You are a professional, friendly interviewer running a practice interview.
Role being interviewed for: ${s.mockRole.trim() || "software engineer"}.
Ask ${MOCK_FOCUS[s.mockType]}.
The interview has ${s.mockQuestions} main questions. The candidate has answered ${answered} times so far (follow-ups included).

Everything you write is read aloud by text-to-speech, so:
- Write plain spoken sentences. No Markdown, lists, code, headings or emoji.
- Keep each turn under 60 words and ask exactly one question.

How to run it:
- First turn: greet the candidate in one sentence, then ask the first main question.
- After an answer, react naturally in at most one short sentence without grading it. If the answer was vague or missed the point, ask one follow-up; otherwise move to the next main question.
- After the answer to the last main question, thank the candidate in one sentence and end your message with ${END_MARK}.`,
  ];
  if (s.resume.trim()) parts.push(`Candidate's resume, to tailor questions:\n<resume>\n${s.resume.trim()}\n</resume>`);
  return parts.join("\n\n");
}

export async function streamInterviewer(settings: Settings, turns: MockTurn[], signal?: AbortSignal) {
  const answered = turns.filter((t) => t.role === "candidate").length;
  return streamText({
    model: await getModel(settings),
    instructions: interviewerInstructions(settings, answered),
    // Providers expect the conversation to start with a user message.
    messages: [
      { role: "user", content: "(The candidate has joined the call.)" },
      ...turns.map((t): ModelMessage => ({ role: t.role === "interviewer" ? "assistant" : "user", content: t.text })),
    ],
    abortSignal: signal,
    maxOutputTokens: 300,
  });
}

export async function streamMockFeedback(settings: Settings, turns: MockTurn[], signal?: AbortSignal) {
  const transcript = turns.map((t) => `${t.role === "interviewer" ? "Interviewer" : "Candidate"}: ${t.text}`).join("\n");
  return streamText({
    model: await getModel(settings),
    instructions:
      `You are an experienced interview coach reviewing a practice interview for: ${settings.mockRole.trim() || "software engineer"}. ` +
      "The candidate's answers were transcribed from speech, so ignore filler words and transcription errors. " +
      "Write Markdown with these sections: ## Overall (a score out of 10 and two or three sentences), " +
      "## Question by question (for each main question: the question in italics, what worked, what to improve, " +
      "and a short outline of a stronger answer), ## Practise next (the three most useful things to work on). " +
      "Be specific and honest, and only refer to what was actually said. No preamble.",
    prompt: `<interview>\n${transcript}\n</interview>`,
    abortSignal: signal,
  });
}

/**
 * Reads a text stream, calling `onText` with each delta. `streamText` reports
 * provider errors (bad key, unknown model) as stream parts rather than throwing,
 * so they're rethrown here.
 */
export async function consume(result: ReturnType<typeof streamText>, onText: (delta: string) => void) {
  for await (const part of result.stream) {
    if (part.type === "text-delta") onText(part.text);
    else if (part.type === "error") throw part.error;
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : JSON.stringify(e);
}

/** Tiny request used by setup's "Test" button. Throws with the provider's error. */
export async function testModel(settings: Settings): Promise<void> {
  const result = streamText({
    model: await getModel(settings),
    prompt: "Reply with the single word OK.",
    maxOutputTokens: 5,
  });
  await consume(result, () => {});
}
