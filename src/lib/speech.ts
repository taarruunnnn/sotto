/**
 * Text-to-speech for the mock interviewer, using the OS voices through the Web
 * Speech API (no extra API key). Text is spoken sentence by sentence while it
 * streams in, so the interviewer starts talking before the whole reply arrives.
 */
export const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;

/** Voices load asynchronously in most engines. */
export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!ttsSupported) return Promise.resolve([]);
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1500);
  });
}

const SENTENCE = /^[\s\S]*?[.!?…](?=\s)/;

export class SpeechQueue {
  private buffer = "";
  private pending = new Set<SpeechSynthesisUtterance>();
  private closed = false;
  private voice?: SpeechSynthesisVoice;

  constructor(
    voiceName: string,
    voices: SpeechSynthesisVoice[],
    private readonly onStart: () => void,
    private readonly onIdle: () => void,
    private readonly clean: (text: string) => string = (t) => t,
  ) {
    this.voice = voices.find((v) => v.name === voiceName);
  }

  push(delta: string) {
    this.buffer += delta;
    let m: RegExpMatchArray | null;
    while ((m = this.buffer.match(SENTENCE))) {
      this.say(m[0]);
      this.buffer = this.buffer.slice(m[0].length);
    }
  }

  /** No more text is coming: speak what's left. */
  end() {
    this.closed = true;
    this.say(this.buffer);
    this.buffer = "";
    if (!this.pending.size) this.onIdle();
  }

  cancel() {
    this.closed = false;
    this.pending.clear();
    if (ttsSupported) speechSynthesis.cancel();
  }

  private say(raw: string) {
    const text = this.clean(raw).trim();
    if (!text || !ttsSupported) return;
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) {
      u.voice = this.voice;
      u.lang = this.voice.lang;
    }
    // Keep a reference: WebKit can garbage-collect utterances and never fire `end`.
    this.pending.add(u);
    u.onstart = () => this.onStart();
    u.onend = u.onerror = () => {
      if (!this.pending.delete(u)) return;
      if (this.closed && !this.pending.size) this.onIdle();
    };
    speechSynthesis.speak(u);
  }
}
