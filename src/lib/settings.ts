import { load, type Store } from "@tauri-apps/plugin-store";

export type Provider = "anthropic" | "openai" | "google" | "gateway";
export type Mode = "interview" | "meeting";
export type AnswerLength = "short" | "detailed";

export interface Settings {
  /** False until the first-run setup is finished. */
  onboarded: boolean;

  deepgramKey: string;
  language: string;
  captureMic: boolean;
  /** cpal device ids; empty means the system default. */
  micDevice: string;
  outputDevice: string;

  provider: Provider;
  /** Comma-separated; later keys are used when earlier ones fail or hit limits. */
  apiKeys: Record<Provider, string>;
  models: Record<Provider, string>;

  mode: Mode;
  answerLength: AnswerLength;
  codeLanguage: string;
  /** Used in interview mode only. */
  resume: string;
  instructions: string;
  /** Plain-text reference documents, keyed by file name. */
  documents: { name: string; text: string }[];

  autoAnswer: boolean;
  stealth: boolean;
  startHidden: boolean;
  opacity: number;
  fontSize: number;
}

export const MAX_INSTRUCTIONS = 20_000;

// Model ids are free text in Settings, so newer models work without an update.
export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-haiku-5-5",
  openai: "gpt-5-mini",
  google: "gemini-2.5-flash",
  gateway: "anthropic/claude-haiku-5.5",
};

export const PROVIDER_ORIGINS: Record<Provider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  google: "https://generativelanguage.googleapis.com",
  gateway: "https://ai-gateway.vercel.sh",
};

export const LANGUAGES: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "multi", label: "Multilingual (auto)" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "hi", label: "Hindi" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "ru", label: "Russian" },
];

export const CODE_LANGUAGES = ["Python", "JavaScript", "TypeScript", "Java", "C++", "Go", "C#", "Rust", "Kotlin", "Swift", "SQL"];

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  deepgramKey: "",
  language: "en",
  captureMic: true,
  micDevice: "",
  outputDevice: "",
  provider: "anthropic",
  apiKeys: { anthropic: "", openai: "", google: "", gateway: "" },
  models: { ...DEFAULT_MODELS },
  mode: "interview",
  answerLength: "short",
  codeLanguage: "Python",
  resume: "",
  instructions: "",
  documents: [],
  autoAnswer: true,
  stealth: true,
  startHidden: false,
  opacity: 0.88,
  fontSize: 14,
};

let store: Promise<Store> | undefined;
const getStore = () => (store ??= load("settings.json", { defaults: {}, autoSave: 300 }));

export async function loadSettings(): Promise<Settings> {
  const saved = await (await getStore()).get<Partial<Settings>>("settings");
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...saved?.apiKeys },
    models: { ...DEFAULT_SETTINGS.models, ...saved?.models },
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await (await getStore()).set("settings", settings);
}
