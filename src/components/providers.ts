import type { Provider } from "../lib/settings";

export const PROVIDERS: { id: Provider; label: string; keyHint: string; keyUrl: string }[] = [
  { id: "anthropic", label: "Anthropic (Claude)", keyHint: "sk-ant-…", keyUrl: "Get one at console.anthropic.com" },
  { id: "openai", label: "OpenAI (GPT)", keyHint: "sk-…", keyUrl: "Get one at platform.openai.com" },
  { id: "google", label: "Google (Gemini)", keyHint: "AIza…", keyUrl: "Get one at aistudio.google.com" },
  { id: "openrouter", label: "OpenRouter (any model)", keyHint: "sk-or-…", keyUrl: "Get one at openrouter.ai/keys" },
  { id: "gateway", label: "Vercel AI Gateway (any model)", keyHint: "AI Gateway key", keyUrl: "Get one at vercel.com/ai-gateway" },
];
