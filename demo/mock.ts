/**
 * Runs the real Sotto UI in a browser with the Tauri backend replaced by a script:
 * settings live in memory, "audio" is transcript events we emit, and AI replies are
 * canned OpenAI-format streams fed through the real AI SDK. No keys, no network.
 * Used by `demo/record.mjs` to make the README screenshots and trailer.
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { REPLIES, pickReply } from "./script";

const params = new URLSearchParams(location.search);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- in-memory plugin-store ---------------------------------------------------------

const stores = new Map<number, Map<string, unknown>>();
const storeIds = new Map<string, number>();
const DEMO_SETTINGS = {
  onboarded: params.get("onboarded") !== "0",
  provider: "openrouter",
  mode: "interview",
  answerLength: "short",
  autoAnswer: true,
  opacity: 0.9,
  mockRole: "Senior frontend engineer at a fintech startup",
  mockType: "mixed",
  mockQuestions: 3,
  resume: "Alex Rivera. Senior frontend engineer, 7 years. React, TypeScript, design systems, web performance.",
};

function storeFor(path: string) {
  let id = storeIds.get(path);
  if (id === undefined) {
    id = storeIds.size + 1;
    storeIds.set(path, id);
    const data = new Map<string, unknown>();
    if (path === "settings.json") data.set("settings", DEMO_SETTINGS);
    if (path === "sessions.json") data.set("sessions", REPLIES.pastSessions);
    stores.set(id, data);
  }
  return id;
}

// Fake keys, shaped like real ones so provider detection shows OpenRouter.
const SECRETS: Record<string, string> = {
  deepgram: params.get("onboarded") === "0" ? "" : "demo0000000000000000000000000000000000000",
  openrouter: params.get("onboarded") === "0" ? "" : "sk-or-v1-demo000000000000000000000000000000000000000000000000",
};

// ---- streamed AI replies --------------------------------------------------------------

let nextRequest = 1;
const FIRST_TOKEN_MS = 900;

function sse(obj: unknown) {
  return new TextEncoder().encode(`data: ${typeof obj === "string" ? obj : JSON.stringify(obj)}\n\n`).buffer;
}

async function streamReply(text: string, send: (chunk: ArrayBuffer) => void) {
  const base = { id: "demo", object: "chat.completion.chunk", created: 0, model: "google/gemini-3.8-flash" };
  await sleep(FIRST_TOKEN_MS);
  // A few words at a time, roughly how a fast model streams.
  const pieces = text.match(/\S+\s*|\s+/g) ?? [];
  for (let i = 0; i < pieces.length; i += 3) {
    const content = pieces.slice(i, i + 3).join("");
    send(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }));
    await sleep(45);
  }
  send(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  send(sse("[DONE]"));
  send(new ArrayBuffer(0));
}

// The mock keeps delivering events to listeners React has already removed; that's harmless.
const warn = console.warn;
console.warn = (...args) => String(args[0]).includes("Couldn't find callback id") || warn(...args);

// ---- IPC ------------------------------------------------------------------------------

mockWindows("main");
mockIPC(
  async (cmd, args: any) => {
    switch (cmd) {
      case "plugin:store|load":
        return storeFor(args.path);
      case "plugin:store|get": {
        const data = stores.get(args.rid)!;
        return [data.get(args.key), data.has(args.key)];
      }
      case "plugin:store|set":
        stores.get(args.rid)!.set(args.key, args.value);
        return null;
      case "get_secret":
        return SECRETS[args.name] ?? "";
      case "list_audio_devices":
        return {
          inputs: [{ id: "mic", name: "MacBook Air Microphone" }],
          outputs: [{ id: "spk", name: "MacBook Air Speakers" }],
        };
      case "proxy_fetch": {
        const body = JSON.parse(args.body ?? "{}");
        const text = pickReply(body);
        const send = (chunk: ArrayBuffer) => args.onBody.onmessage(chunk);
        setTimeout(() => streamReply(text, send));
        return { id: nextRequest++, status: 200, headers: [["content-type", "text/event-stream"]] };
      }
      case "start_session":
        setTimeout(() => {
          emit("transcriber-status", { source: "them", status: "listening" });
          if (args.captureMic !== false) emit("transcriber-status", { source: "me", status: "listening" });
        }, 300);
        return null;
      default:
        // set_stealth, warm, window show/hide, set_secret, stop_session…
        return null;
    }
  },
  { shouldMockEvents: true },
);

// ---- speech -----------------------------------------------------------------------

/** Headless browsers have no voices, so the interviewer "speaks" for a believable time. */
class FakeUtterance {
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  voice = null;
  lang = "en-US";
  constructor(public text: string) {}
}
const fakeSpeech = {
  speaking: false,
  queue: [] as FakeUtterance[],
  getVoices: () => [{ name: "Samantha", lang: "en-US" }],
  addEventListener() {},
  cancel() {
    this.queue = [];
  },
  async speak(u: FakeUtterance) {
    this.queue.push(u);
    if (this.speaking) return;
    this.speaking = true;
    while (this.queue.length) {
      const next = this.queue.shift()!;
      next.onstart?.();
      demo.speaking("them", next.text.split(/\s+/).length * 170);
      await sleep(next.text.split(/\s+/).length * 170);
      next.onend?.();
    }
    this.speaking = false;
  },
};
Object.defineProperty(window, "speechSynthesis", { value: fakeSpeech });
(window as any).SpeechSynthesisUtterance = FakeUtterance;
// Silence the "your turn" chime; there's no audio in recordings anyway.
(window as any).AudioContext = undefined;

// ---- the call -----------------------------------------------------------------------

type Source = "me" | "them";

/** Things the stage page (and the recorder) drive. */
const demo = {
  /** Called with (source, ms) whenever someone talks, so the stage can light up a tile. */
  onSpeaking: null as null | ((source: Source, ms: number) => void),

  speaking(source: Source, ms: number) {
    demo.onSpeaking?.(source, ms);
    const until = Date.now() + ms;
    const tick = () => {
      if (Date.now() > until) return void emit("audio-level", { source, level: 0 });
      emit("audio-level", { source, level: 0.01 + Math.random() * 0.06 });
      setTimeout(tick, 90);
    };
    tick();
  },

  /** Speaks `text` as `source`: interim words stream in, then the line is finalised. */
  async say(source: Source, text: string, wordMs = 230) {
    const words = text.split(" ");
    demo.speaking(source, words.length * wordMs);
    for (let i = 1; i <= words.length; i++) {
      await sleep(wordMs);
      emit("transcript", { source, text: words.slice(0, i).join(" "), isFinal: false, speechFinal: false });
    }
    await sleep(250);
    emit("transcript", { source, text, isFinal: true, speechFinal: true });
  },
};
(window as any).demo = demo;
