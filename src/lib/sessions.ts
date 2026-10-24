import { load, type Store } from "@tauri-apps/plugin-store";
import type { Mode } from "./settings";
import type { Line } from "./transcript";
import type { AnswerKind } from "./llm";

export interface Answer {
  id: number;
  kind: AnswerKind | "notes";
  /** What prompted it: the question, or the typed message. */
  prompt?: string;
  text: string;
  /** Milliseconds until the first token arrived. */
  ttft?: number;
}

export interface Session {
  id: string;
  startedAt: number;
  endedAt?: number;
  mode: Mode;
  /** A practice interview with the AI interviewer. */
  mock?: boolean;
  lines: Line[];
  answers: Answer[];
}

const MAX_SESSIONS = 40;

let store: Promise<Store> | undefined;
const getStore = () => (store ??= load("sessions.json", { defaults: {}, autoSave: 1000 }));

export async function listSessions(): Promise<Session[]> {
  return (await (await getStore()).get<Session[]>("sessions")) ?? [];
}

/** Inserts or replaces a session, keeping only the most recent ones. */
export async function saveSession(session: Session): Promise<void> {
  const s = await getStore();
  const all = ((await s.get<Session[]>("sessions")) ?? []).filter((x) => x.id !== session.id);
  await s.set("sessions", [session, ...all].slice(0, MAX_SESSIONS));
}

export async function deleteSession(id: string): Promise<void> {
  const s = await getStore();
  const all = (await s.get<Session[]>("sessions")) ?? [];
  await s.set("sessions", all.filter((x) => x.id !== id));
}

export function sessionToMarkdown(session: Session): string {
  const date = new Date(session.startedAt).toLocaleString();
  const notes = session.answers.filter((a) => a.kind === "notes").at(-1);
  const transcript = session.lines
    .map((l) => `**${l.source === "me" ? "Me" : "Them"}:** ${l.text}`)
    .join("\n\n");
  return [`# Call on ${date}`, notes ? `${notes.text}\n` : "", "## Transcript", transcript].join("\n\n");
}
