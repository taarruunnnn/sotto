import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Meter from "./components/Meter";
import { loadSettings, PROVIDER_ORIGINS, saveSettings, type Settings } from "./lib/settings";
import { looksLikeQuestion, type Line, type Speaker, type TranscriptEvent } from "./lib/transcript";
import { consume, errorMessage, preloadProvider, streamAnswer, streamNotes } from "./lib/llm";
import { saveSession, type Answer, type Session } from "./lib/sessions";
import { warm } from "./lib/net";
import { MOD } from "./lib/checks";
import "./App.css";

// Only the main overlay is in the startup bundle; everything else loads on demand.
const Markdown = lazy(() => import("react-markdown"));
const SettingsView = lazy(() => import("./Settings"));
const Onboarding = lazy(() => import("./components/Onboarding"));
const History = lazy(() => import("./components/History"));
const MockInterview = lazy(() => import("./components/MockInterview"));

type View = "main" | "settings" | "history" | "onboarding" | "mock";
type Live = Record<Speaker, { committed: string; interim: string }>;
interface Shot {
  id: number;
  data: string;
  included: boolean;
}
interface StatusEvent {
  source: Speaker;
  status: "connecting" | "listening" | "stopped" | "error";
  message?: string;
}

const EMPTY_LIVE: Live = { me: { committed: "", interim: "" }, them: { committed: "", interim: "" } };
const MAX_SHOTS = 4;
/** How long to wait for any computer audio before suggesting a permissions problem. */
const NO_AUDIO_MS = 15_000;
const KIND_LABEL: Record<Answer["kind"], string> = {
  answer: "Answer",
  suggest: "Suggestion",
  screen: "Screen",
  chat: "Chat",
  notes: "Notes",
};

// WKWebView (macOS) has no requestIdleCallback.
const whenIdle = (cb: () => void) =>
  "requestIdleCallback" in window ? requestIdleCallback(cb) : setTimeout(cb, 300);

/** Text that's being said right now, as lines, so answers don't miss the last sentence. */
const pendingLines = (live: Live): Line[] =>
  (["them", "me"] as const)
    .map((source) => ({ id: -1, source, text: `${live[source].committed} ${live[source].interim}`.trim() }))
    .filter((l) => l.text);

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [view, setView] = useState<View>("main");
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState<Partial<Record<Speaker, StatusEvent>>>({});
  const [lines, setLines] = useState<Line[]>([]);
  const [live, setLive] = useState<Live>(EMPTY_LIVE);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [viewIndex, setViewIndex] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const [shots, setShots] = useState<Shot[]>([]);
  const [showTranscript, setShowTranscript] = useState(true);
  const [clickThrough, setClickThrough] = useState(false);
  const [noAudio, setNoAudio] = useState(false);
  const [copied, setCopied] = useState(false);

  // Event listeners are registered once, so they read current values from refs.
  // Lines and answers are written through the refs first, so they're never stale.
  const settingsRef = useRef(settings);
  const viewRef = useRef(view);
  const linesRef = useRef(lines);
  const liveRef = useRef(live);
  const shotsRef = useRef(shots);
  const answersRef = useRef(answers);
  const abortRef = useRef<AbortController | null>(null);
  /** The answer currently streaming; auto answers can be replaced by newer ones. */
  const streamingRef = useRef<{ id: number; auto: boolean } | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const speculatedRef = useRef("");
  const lastSoundRef = useRef(0);
  const nextId = useRef(0);
  const transcriptEl = useRef<HTMLElement>(null);
  settingsRef.current = settings;
  viewRef.current = view;
  shotsRef.current = shots;

  const updateLines = (fn: (l: Line[]) => Line[]) => {
    linesRef.current = fn(linesRef.current);
    setLines(linesRef.current);
  };
  const updateAnswers = (fn: (a: Answer[]) => Answer[]) => {
    answersRef.current = fn(answersRef.current);
    setAnswers(answersRef.current);
  };

  // ---- startup -----------------------------------------------------------------

  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s);
      invoke("set_stealth", { enabled: s.stealth });
      if (!s.onboarded) setView("onboarding");
      // The window starts hidden so it never flashes unstyled; show it once ready.
      if (!s.startHidden || !s.onboarded) getCurrentWindow().show();
      // Warm up the provider SDK and connection in the background.
      whenIdle(() => {
        preloadProvider(s.provider);
        if (s.apiKeys[s.provider]) warm([PROVIDER_ORIGINS[s.provider]]);
      });
    });
  }, []);

  const updateSettings = (s: Settings) => {
    if (s.stealth !== settings?.stealth) invoke("set_stealth", { enabled: s.stealth });
    setSettings(s);
    saveSettings(s);
  };

  useEffect(() => {
    const el = transcriptEl.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, live]);

  // ---- sessions ------------------------------------------------------------------

  const persist = useCallback((ended = false) => {
    const session = sessionRef.current;
    if (!session) return;
    session.lines = linesRef.current;
    session.answers = answersRef.current.filter((a) => a.text);
    if (ended) session.endedAt = Date.now();
    if (session.lines.length || session.answers.length) saveSession({ ...session }).catch(() => {});
  }, []);

  // ---- answers -------------------------------------------------------------------

  const runAnswer = useCallback(
    async (kind: Answer["kind"], opts: { userMessage?: string; auto?: boolean } = {}) => {
      const s = settingsRef.current;
      if (!s) return;
      const current = streamingRef.current;
      // Auto answers never interrupt one the user asked for.
      if (opts.auto && current && !current.auto) return;
      abortRef.current?.abort();
      // An auto answer to a question that kept going is replaced, not kept.
      if (current?.auto) updateAnswers((a) => a.filter((x) => x.id !== current.id));

      const controller = new AbortController();
      abortRef.current = controller;
      const started = performance.now();
      setError("");
      setBusy(true);

      const transcript = [...linesRef.current, ...pendingLines(liveRef.current)];
      const id = nextId.current++;
      streamingRef.current = { id, auto: !!opts.auto };
      const lastQuestion = [...transcript].reverse().find((l) => l.source === "them")?.text;
      const prompt = kind === "chat" ? opts.userMessage : kind === "answer" || kind === "suggest" ? lastQuestion : undefined;
      updateAnswers((a) => [...a, { id, kind, prompt, text: "" }]);
      setViewIndex(-1);

      // Batch streamed tokens into one render per animation frame.
      let text = "";
      let ttft: number | undefined;
      let frame = 0;
      const flush = () => {
        frame = 0;
        updateAnswers((a) => a.map((x) => (x.id === id ? { ...x, text, ttft } : x)));
      };

      try {
        let screenshots: string[] = [];
        if (kind === "screen") {
          const data = await invoke<string>("capture_screen");
          screenshots = [...shotsRef.current.filter((x) => x.included).map((x) => x.data), data];
          setShots([]);
        }
        controller.signal.throwIfAborted();

        const result =
          kind === "notes"
            ? await streamNotes(s, transcript, controller.signal)
            : await streamAnswer({
                settings: s,
                kind,
                transcript,
                userMessage: opts.userMessage,
                screenshots,
                signal: controller.signal,
              });
        await consume(result, (delta) => {
          ttft ??= Math.round(performance.now() - started);
          text += delta;
          frame ||= requestAnimationFrame(flush);
        });
      } catch (e) {
        if (!controller.signal.aborted) setError(errorMessage(e));
      } finally {
        cancelAnimationFrame(frame);
        flush();
        // Don't leave empty bubbles behind for failed or cancelled answers.
        if (!text) updateAnswers((a) => a.filter((x) => x.id !== id));
        if (abortRef.current === controller) {
          abortRef.current = null;
          streamingRef.current = null;
          setBusy(false);
        }
        persist();
      }
    },
    [persist],
  );

  const stopAnswer = () => {
    abortRef.current?.abort();
  };

  const addShot = useCallback(async () => {
    try {
      const data = await invoke<string>("capture_screen");
      setShots((s) => [...s, { id: nextId.current++, data, included: true }].slice(-MAX_SHOTS));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  const step = useCallback((delta: -1 | 1) => {
    const count = answersRef.current.length;
    if (!count) return;
    setViewIndex((i) => {
      const next = (i === -1 ? count - 1 : i) + delta;
      if (next >= count - 1) return -1;
      return Math.max(0, next);
    });
  }, []);

  // ---- events --------------------------------------------------------------------

  useEffect(() => {
    const unlisten = [
      listen<TranscriptEvent>("transcript", ({ payload: e }) => {
        // The mock interview handles its own transcript.
        if (viewRef.current === "mock") return;
        const cur = { ...liveRef.current[e.source] };
        if (e.isFinal) {
          cur.committed = `${cur.committed} ${e.text}`.trim();
          cur.interim = "";
        } else {
          cur.interim = e.text;
        }

        const auto = e.source === "them" && settingsRef.current?.autoAnswer;
        let trigger = false;
        if (e.speechFinal) {
          if (cur.committed) {
            const line: Line = { id: nextId.current++, source: e.source, text: cur.committed };
            updateLines((l) => [...l, line]);
            cur.committed = "";
            // Skip it if the speculative answer below already covered this exact question.
            trigger = !!auto && line.text !== speculatedRef.current && looksLikeQuestion(line.text);
          }
          if (e.source === "them") speculatedRef.current = "";
        } else if (auto && e.isFinal && cur.committed !== speculatedRef.current && looksLikeQuestion(cur.committed)) {
          // Start answering as soon as a finished sentence reads like a question, rather
          // than waiting for the end-of-turn pause. If they keep talking, it restarts.
          speculatedRef.current = cur.committed;
          trigger = true;
        } else if (auto && !e.isFinal) {
          // Faster still: interim text that already ends in a question mark. Deepgram
          // usually finalises the same words, which then don't trigger a second answer.
          const said = `${cur.committed} ${cur.interim}`.trim();
          if (said.endsWith("?") && said !== speculatedRef.current && looksLikeQuestion(said)) {
            speculatedRef.current = said;
            trigger = true;
          }
        }

        // Update live text before answering, so the prompt has it exactly once.
        liveRef.current = { ...liveRef.current, [e.source]: cur };
        setLive(liveRef.current);
        if (trigger) runAnswer("answer", { auto: true });
      }),
      listen<StatusEvent>("transcriber-status", ({ payload }) => {
        setStatus((prev) => ({ ...prev, [payload.source]: payload }));
        if (payload.status === "error") {
          setError(`${payload.source === "me" ? "Microphone" : "Computer audio"}: ${payload.message}`);
        }
      }),
      listen<{ source: Speaker; level: number }>("audio-level", ({ payload }) => {
        if (payload.source === "them" && payload.level > 0.0005) {
          lastSoundRef.current = Date.now();
          setNoAudio(false);
        }
      }),
      listen<string>("shortcut", ({ payload }) => {
        if (viewRef.current === "mock") return;
        switch (payload) {
          case "answer":
            return void runAnswer("answer");
          case "suggest":
            return void runAnswer("suggest");
          case "screenshot":
            return void runAnswer("screen");
          case "add-screenshot":
            return void addShot();
          case "previous-answer":
            return step(-1);
          case "next-answer":
            return step(1);
        }
      }),
      listen<boolean>("click-through", ({ payload }) => setClickThrough(payload)),
      listen<View>("open-view", ({ payload }) => setView(payload)),
    ];
    return () => unlisten.forEach((p) => p.then((f) => f()));
  }, [runAnswer, addShot, step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") abortRef.current?.abort();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Silence from the start usually means a missing permission or the wrong output device.
  useEffect(() => {
    if (!listening) return setNoAudio(false);
    const timer = setTimeout(() => {
      if (!lastSoundRef.current) setNoAudio(true);
    }, NO_AUDIO_MS);
    return () => clearTimeout(timer);
  }, [listening]);

  // ---- listening -----------------------------------------------------------------

  const startListening = async (s: Settings) => {
    abortRef.current?.abort();
    updateLines(() => []);
    updateAnswers(() => []);
    liveRef.current = EMPTY_LIVE;
    setLive(EMPTY_LIVE);
    setShots([]);
    setStatus({});
    setViewIndex(-1);
    speculatedRef.current = "";
    lastSoundRef.current = 0;

    preloadProvider(s.provider);
    if (s.apiKeys[s.provider]) warm([PROVIDER_ORIGINS[s.provider]]);
    try {
      await invoke("start_session", {
        deepgramKey: s.deepgramKey,
        language: s.language,
        captureMic: s.captureMic,
        micDevice: s.micDevice || null,
        outputDevice: s.outputDevice || null,
      });
      sessionRef.current = { id: crypto.randomUUID(), startedAt: Date.now(), mode: s.mode, lines: [], answers: [] };
      setListening(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const stopListening = async () => {
    await invoke("stop_session");
    setListening(false);
    // Keep whatever was mid-sentence when Stop was pressed.
    const rest = pendingLines(liveRef.current).map((l) => ({ ...l, id: nextId.current++ }));
    if (rest.length) updateLines((l) => [...l, ...rest]);
    liveRef.current = EMPTY_LIVE;
    setLive(EMPTY_LIVE);
    persist(true);
    sessionRef.current = null;
  };

  const toggleListening = () => {
    if (!settings) return;
    setError("");
    if (listening) stopListening();
    else startListening(settings);
  };

  const toggleLine = (id: number) => updateLines((ls) => ls.map((l) => (l.id === id ? { ...l, excluded: !l.excluded } : l)));

  const send = () => {
    const msg = input.trim();
    if (!msg) return;
    setInput("");
    runAnswer("chat", { userMessage: msg });
  };

  // ---- render --------------------------------------------------------------------

  if (!settings) return <div className="shell" />;

  const shown = viewIndex === -1 ? answers.at(-1) : answers[viewIndex];
  const shownIndex = viewIndex === -1 ? answers.length - 1 : viewIndex;
  const statusDot = (s?: StatusEvent) => (s ? s.status : listening ? "connecting" : "stopped");
  const style = { "--bg-alpha": settings.opacity, "--font-size": `${settings.fontSize}px` } as CSSProperties;

  const copy = async () => {
    if (!shown) return;
    await navigator.clipboard.writeText(shown.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`shell ${clickThrough ? "click-through" : ""}`} style={style}>
      <header data-tauri-drag-region>
        <span className="brand" data-tauri-drag-region>Sotto</span>
        <span className="dots" data-tauri-drag-region>
          <span className={`dot ${statusDot(status.them)}`} title="Them (computer audio)" />
          {settings.captureMic && <span className={`dot ${statusDot(status.me)}`} title="Me (microphone)" />}
        </span>
        <span className="spacer" data-tauri-drag-region />
        {view === "main" ? (
          <>
            <button className={listening ? "danger" : "primary"} onClick={toggleListening}>
              {listening ? "Stop" : "Listen"}
            </button>
            <button onClick={() => setView("mock")} disabled={listening} title={listening ? "Stop listening to practise" : "Mock interview"}>
              Practice
            </button>
            <button onClick={() => setView("history")} title="Past calls">☰</button>
            <button onClick={() => setView("settings")} title="Settings">⚙︎</button>
          </>
        ) : (
          view !== "onboarding" && <button onClick={() => setView("main")} title="Back">✕</button>
        )}
        <button onClick={() => getCurrentWindow().hide()} title={`Hide (${MOD}\\)`}>–</button>
      </header>

      <Suspense fallback={<main />}>
        {view === "onboarding" && (
          <Onboarding
            settings={settings}
            onChange={updateSettings}
            onDone={() => {
              updateSettings({ ...settings, onboarded: true });
              setView("main");
            }}
          />
        )}
        {view === "settings" && (
          <SettingsView settings={settings} onChange={updateSettings} onRerunSetup={() => setView("onboarding")} />
        )}
        {view === "history" && <History />}
        {view === "mock" && (
          <MockInterview settings={settings} onChange={updateSettings} onExit={() => setView("main")} />
        )}
      </Suspense>

      {view === "main" && (
        <main>
          {error && <div className="error" onClick={() => setError("")}>{error}</div>}
          {noAudio && (
            <div className="warning" onClick={() => setNoAudio(false)}>
              No computer audio yet. Check the output device in Settings and that Sotto (or your terminal, in dev
              mode) is allowed to record system audio.
            </div>
          )}

          <section className="answer">
            {shown && (
              <div className="answer-meta">
                <span className="kind">{KIND_LABEL[shown.kind]}</span>
                <span className="prompt muted ellipsis" title={shown.prompt}>{shown.prompt}</span>
                {shown.ttft !== undefined && <span className="muted">{(shown.ttft / 1000).toFixed(1)}s</span>}
                {answers.length > 1 && (
                  <span className="pager">
                    <button onClick={() => step(-1)} disabled={shownIndex === 0} title={`Previous (${MOD}⇧[)`}>‹</button>
                    <span className="muted">{shownIndex + 1}/{answers.length}</span>
                    <button onClick={() => step(1)} disabled={viewIndex === -1} title={`Next (${MOD}⇧])`}>›</button>
                  </span>
                )}
                <button onClick={copy} disabled={!shown.text}>{copied ? "Copied" : "Copy"}</button>
              </div>
            )}
            {shown?.text ? (
              <Suspense fallback={<p>{shown.text}</p>}>
                <Markdown>{shown.text}</Markdown>
              </Suspense>
            ) : (
              <p className="hint">
                {busy ? "Thinking…" : (
                  <>
                    {settings.autoAnswer ? "Questions are answered automatically. " : ""}
                    <kbd>{MOD}↵</kbd> answer · <kbd>{MOD}⇧↵</kbd> suggest · <kbd>{MOD}⇧S</kbd> solve screen ·{" "}
                    <kbd>{MOD}\</kbd> hide · <kbd>{MOD}⇧M</kbd> click-through
                  </>
                )}
              </p>
            )}
          </section>

          {shots.length > 0 && (
            <div className="shots">
              {shots.map((shot) => (
                <span key={shot.id} className={`shot ${shot.included ? "" : "off"}`}>
                  <img
                    src={`data:image/jpeg;base64,${shot.data}`}
                    alt="Screenshot"
                    title={shot.included ? "Included in the next Solve screen (click to leave out)" : "Left out (click to include)"}
                    onClick={() => setShots((s) => s.map((x) => (x.id === shot.id ? { ...x, included: !x.included } : x)))}
                  />
                  <button onClick={() => setShots((s) => s.filter((x) => x.id !== shot.id))} title="Remove">×</button>
                </span>
              ))}
              <span className="muted">Sent with the next Solve screen</span>
            </div>
          )}

          <div className="actions">
            <button onClick={() => runAnswer("answer")}>Answer</button>
            <button onClick={() => runAnswer("suggest")}>Suggest</button>
            <button onClick={() => runAnswer("screen")}>Solve screen</button>
            <button onClick={() => runAnswer("notes")} disabled={!lines.length}>Notes</button>
            {busy && <button onClick={stopAnswer} title="Stop (Esc)">Stop</button>}
            <span className="spacer" />
            <button onClick={() => setShowTranscript(!showTranscript)}>
              {showTranscript ? "Hide" : "Show"} transcript
            </button>
          </div>

          {showTranscript && (
            <>
              {listening && (
                <div className="levels">
                  <Meter source="them" label="Them" />
                  {settings.captureMic && <Meter source="me" label="Me" />}
                </div>
              )}
              <section className="transcript" ref={transcriptEl}>
                {lines.slice(-60).map((l) => (
                  <p
                    key={l.id}
                    className={`${l.source} ${l.excluded ? "excluded" : ""}`}
                    onClick={() => toggleLine(l.id)}
                    title={l.excluded ? "Left out of AI prompts (click to include)" : "Click to leave out of AI prompts"}
                  >
                    <b>{l.source === "me" ? "Me" : "Them"}</b> {l.text}
                  </p>
                ))}
                {(["them", "me"] as const).map((src) => {
                  const t = `${live[src].committed} ${live[src].interim}`.trim();
                  return t ? <p key={src} className={`${src} live`}><b>{src === "me" ? "Me" : "Them"}</b> {t}</p> : null;
                })}
                {!lines.length && !listening && <p className="hint">Press Listen when your call starts.</p>}
              </section>
            </>
          )}

          <form className="chat" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask anything about this call…" />
          </form>
        </main>
      )}
    </div>
  );
}
