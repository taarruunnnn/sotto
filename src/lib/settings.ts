import { invoke } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";

export type Provider = "anthropic" | "openai" | "google" | "openrouter" | "gateway";
export type Mode = "interview" | "meeting";
export type AnswerLength = "short" | "detailed";
export type MockType = "behavioral" | "technical" | "mixed";

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

  /** Mock interview: the role or job description to practise for. */
  mockRole: string;
  mockType: MockType;
  /** Number of main questions (follow-ups don't count). */
  mockQuestions: number;
  /** speechSynthesis voice name; empty means the system default. */
  mockVoice: string;
}

export const MAX_INSTRUCTIONS = 20_000;

// Model ids are free text in Settings, so newer models work without an update.
export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-haiku-5-5",
  openai: "gpt-5-mini",
  google: "gemini-3.8-flash",
  openrouter: "google/gemini-3.8-flash",
  gateway: "anthropic/claude-haiku-5.5",
};

export const PROVIDER_ORIGINS: Record<Provider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  google: "https://generativelanguage.googleapis.com",
  openrouter: "https://openrouter.ai",
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
  apiKeys: { anthropic: "", openai: "", google: "", openrouter: "", gateway: "" },
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
  mockRole: "",
  mockType: "mixed",
  mockQuestions: 5,
  mockVoice: "",
};

let store: Promise<Store> | undefined;
const getStore = () => (store ??= load("settings.json", { defaults: {}, autoSave: 300 }));

// ---- API keys: OS keychain -------------------------------------------------------

type SecretName = "deepgram" | Provider;
const PROVIDERS: Provider[] = ["anthropic", "openai", "google", "openrouter", "gateway"];

/** False when the OS keychain can't be used; keys then stay in settings.json. */
let keychainOk = true;
/** What the keychain currently holds, so only changed keys are written. */
const stored = new Map<SecretName, string>();
const pending = new Map<SecretName, ReturnType<typeof setTimeout>>();

const secretsOf = (s: Pick<Settings, "deepgramKey" | "apiKeys">): [SecretName, string][] => [
  ["deepgram", s.deepgramKey],
  ...PROVIDERS.map((p): [SecretName, string] => [p, s.apiKeys[p]]),
];

async function readKeychain(): Promise<Map<SecretName, string> | null> {
  try {
    const names: SecretName[] = ["deepgram", ...PROVIDERS];
    const values = await Promise.all(names.map((name) => invoke<string>("get_secret", { name })));
    return new Map(names.map((name, i) => [name, values[i]]));
  } catch (e) {
    console.warn("Keychain unavailable, keeping API keys in settings.json:", e);
    return null;
  }
}

/** Keys are saved on every keystroke in Settings, so writes are debounced. */
function writeSecret(name: SecretName, value: string) {
  clearTimeout(pending.get(name));
  pending.set(
    name,
    setTimeout(() => {
      pending.delete(name);
      invoke("set_secret", { name, value })
        .then(() => stored.set(name, value))
        .catch((e) => console.error(`Could not save the ${name} key to the keychain:`, e));
    }, 400),
  );
}

const withoutKeys = (s: Settings): Settings => ({
  ...s,
  deepgramKey: "",
  apiKeys: { ...DEFAULT_SETTINGS.apiKeys },
});

export async function loadSettings(): Promise<Settings> {
  const st = await getStore();
  const saved = await st.get<Partial<Settings>>("settings");
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...saved?.apiKeys },
    models: { ...DEFAULT_SETTINGS.models, ...saved?.models },
  };

  const keychain = await readKeychain();
  if (!keychain) {
    keychainOk = false;
    return settings;
  }

  // Keys from older versions are in settings.json: move them to the keychain.
  let migrated = false;
  for (const [name, value] of secretsOf(settings)) {
    if (value && !keychain.get(name)) {
      try {
        await invoke("set_secret", { name, value });
        keychain.set(name, value);
        migrated = true;
      } catch (e) {
        console.error("Keychain migration failed, keeping API keys in settings.json:", e);
        keychainOk = false;
        return settings;
      }
    }
  }
  keychain.forEach((value, name) => stored.set(name, value));
  if (migrated || secretsOf(settings).some(([, v]) => v)) await st.set("settings", withoutKeys(settings));

  return {
    ...settings,
    deepgramKey: keychain.get("deepgram") ?? "",
    apiKeys: Object.fromEntries(PROVIDERS.map((p) => [p, keychain.get(p) ?? ""])) as Record<Provider, string>,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  if (!keychainOk) {
    await (await getStore()).set("settings", settings);
    return;
  }
  for (const [name, value] of secretsOf(settings)) {
    if (stored.get(name) !== value) writeSecret(name, value);
    else clearTimeout(pending.get(name));
  }
  await (await getStore()).set("settings", withoutKeys(settings));
}

export const keysInKeychain = () => keychainOk;
