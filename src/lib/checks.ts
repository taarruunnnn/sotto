import { proxyFetch } from "./net";
import { testModel } from "./llm";
import type { Settings } from "./settings";

export async function testDeepgramKey(key: string): Promise<void> {
  const res = await proxyFetch("https://api.deepgram.com/v1/projects", {
    headers: { Authorization: `Token ${key.trim()}` },
  });
  await res.body?.cancel();
  if (res.status === 401 || res.status === 403) throw new Error("Deepgram rejected this key.");
  if (!res.ok) throw new Error(`Deepgram returned HTTP ${res.status}.`);
}

export const testProvider = (settings: Settings) => testModel(settings);

export const isMac = navigator.userAgent.includes("Mac");
export const MOD = isMac ? "⌘" : "Ctrl+";

/** macOS System Settings privacy panes. */
export const PRIVACY_PANES = {
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  audio: "x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture",
};
