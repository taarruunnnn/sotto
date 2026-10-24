import type { Provider } from "../lib/settings";

export const PROVIDERS: { id: Provider; label: string; keyHint: string; keyUrl: string; modelHint: string }[] = [
  { id: "openrouter", label: "OpenRouter", keyHint: "sk-or-…", keyUrl: "openrouter.ai/keys", modelHint: "e.g. google/gemini-3.8-flash or anthropic/claude-haiku-5.5" },
  { id: "anthropic", label: "Anthropic (Claude)", keyHint: "sk-ant-…", keyUrl: "console.anthropic.com", modelHint: "e.g. claude-haiku-5-5" },
  { id: "google", label: "Google (Gemini)", keyHint: "AIza…", keyUrl: "aistudio.google.com", modelHint: "e.g. gemini-3.8-flash" },
  { id: "openai", label: "OpenAI (GPT)", keyHint: "sk-…", keyUrl: "platform.openai.com", modelHint: "e.g. gpt-5-mini" },
  { id: "gateway", label: "Vercel AI Gateway", keyHint: "AI Gateway key", keyUrl: "vercel.com/ai-gateway", modelHint: "e.g. anthropic/claude-haiku-5.5" },
];

export const providerInfo = (id: Provider) => PROVIDERS.find((p) => p.id === id)!;

/**
 * Works out the provider from the key's format, so people only paste a key.
 * Order matters: OpenRouter and Anthropic keys also start with "sk-".
 * Returns undefined for formats it can't tell apart (e.g. AI Gateway keys).
 */
export function detectProvider(keys: string): Provider | undefined {
  const key = keys.split(",")[0]?.trim() ?? "";
  if (key.startsWith("sk-or-")) return "openrouter";
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("AIza")) return "google";
  if (key.startsWith("sk-")) return "openai";
  return undefined;
}
