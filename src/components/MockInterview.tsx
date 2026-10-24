import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Meter from "./Meter";
import { MOD } from "../lib/checks";
import {
  consume,
  END_MARK,
  errorMessage,
  streamInterviewer,
  streamMockFeedback,
  type MockTurn,
} from "../lib/llm";
import { saveSession } from "../lib/sessions";
import type { MockType, Settings } from "../lib/settings";
import { loadVoices, SpeechQueue, ttsSupported } from "../lib/speech";
import type { TranscriptEvent } from "../lib/transcript";

const Markdown = lazy(() => import("react-markdown"));

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onExit: () => void;
}

type Phase = "setup" | "running" | "feedback";
type Status = "thinking" | "speaking" | "listening";

const TYPES: { id: MockType; label: string }[] = [
  { id: "behavioral", label: "Behavioural" },
  { id: "technical", label: "Technical" },
  { id: "mixed", label: "Mixed" },
];
/** Mic audio right after the interviewer stops is usually the tail of its own voice. */
const ECHO_GRACE_MS = 600;

const stripEnd = (text: string) => text.replace(END_MARK, "").replace(/\[END\]?$/, "").trim();

export default function MockInterview({ settings: s, onChange, onExit }: Props) {
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...s, [key]: value });
  const [phase, setPhase] = useState<Phase>("setup");
  const [status, setStatus] = useState<Status>("thinking");
  const [turns, setTurns] = useState<MockTurn[]>([]);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState({ committed: "", interim: "" });
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  const turnsRef = useRef<MockTurn[]>([]);
  const statusRef = useRef<Status>("thinking");
  const answerRef = useRef(answer);
  const listenFrom = useRef(0);
  const speech = useRef<SpeechQueue | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startedAt = useRef(0);
  const runningRef = useRef(false);

  const setStatusNow = (next: Status) => {
    statusRef.current = next;
    setStatus(next);
    if (next === "listening") listenFrom.current = Date.now() + ECHO_GRACE_MS;
  };
  const setAnswerNow = (next: typeof answer) => {
    answerRef.current = next;
    setAnswer(next);
  };

  useEffect(() => {
    loadVoices().then(setVoices);
  }, []);

  // Your answer comes from the mic transcript, but only while it's your turn, so the
  // interviewer's voice coming out of the speakers isn't recorded as your answer.
  useEffect(() => {
    const unlisten = listen<TranscriptEvent>("transcript", ({ payload: e }) => {
      if (e.source !== "me" || statusRef.current !== "listening" || Date.now() < listenFrom.current) return;
      const cur = { ...answerRef.current };
      if (e.isFinal) {
        cur.committed = `${cur.committed} ${e.text}`.trim();
        cur.interim = "";
      } else {
        cur.interim = e.text;
      }
      setAnswerNow(cur);
    });
    const unlistenShortcut = listen<string>("shortcut", ({ payload }) => {
      if (payload === "answer") submitRef.current();
    });
    return () => {
      unlisten.then((f) => f());
      unlistenShortcut.then((f) => f());
    };
  }, []);

  // Leaving the screen ends everything: speech, requests and the mic.
  useEffect(
    () => () => {
      speech.current?.cancel();
      abortRef.current?.abort();
      if (runningRef.current) invoke("stop_session");
    },
    [],
  );

  const stopAudio = () => {
    speech.current?.cancel();
    speech.current = null;
    abortRef.current?.abort();
    if (runningRef.current) invoke("stop_session");
    runningRef.current = false;
  };

  const askNext = async (history: MockTurn[]) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setStatusNow("thinking");
    setQuestion("");
    setAnswerNow({ committed: "", interim: "" });

    let text = "";
    let done = false;
    const afterSpeaking = () => {
      if (controller.signal.aborted) return;
      const turn: MockTurn = { role: "interviewer", text: stripEnd(text) };
      turnsRef.current = [...history, turn];
      setTurns(turnsRef.current);
      if (done) finish(turnsRef.current);
      else setStatusNow("listening");
    };
    const queue = new SpeechQueue(s.mockVoice, voices, () => setStatusNow("speaking"), afterSpeaking, stripEnd);
    speech.current = queue;

    try {
      const result = await streamInterviewer(s, history, controller.signal);
      await consume(result, (delta) => {
        text += delta;
        setQuestion(stripEnd(text));
        queue.push(delta);
      });
      done = text.includes(END_MARK);
      queue.end();
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(errorMessage(e));
        setStatusNow("listening");
      }
    }
  };

  const start = async () => {
    setError("");
    turnsRef.current = [];
    setTurns([]);
    setFeedback("");
    try {
      await invoke("start_session", {
        deepgramKey: s.deepgramKey,
        language: s.language,
        captureMic: true,
        micDevice: s.micDevice || null,
        outputDevice: null,
        captureSystem: false,
      });
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    runningRef.current = true;
    startedAt.current = Date.now();
    setPhase("running");
    askNext([]);
  };

  const submit = () => {
    if (phase !== "running" || statusRef.current !== "listening") return;
    const said = `${answerRef.current.committed} ${answerRef.current.interim}`.trim();
    const history: MockTurn[] = [...turnsRef.current, { role: "candidate", text: said || "(no answer)" }];
    turnsRef.current = history;
    setTurns(history);
    // Hard stop in case the interviewer never wraps up: two turns per main question.
    const answered = history.filter((t) => t.role === "candidate").length;
    if (answered >= s.mockQuestions * 2) finish(history);
    else askNext(history);
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;

  const repeat = () => {
    const last = turnsRef.current.at(-1);
    if (!last || last.role !== "interviewer" || statusRef.current !== "listening") return;
    const queue = new SpeechQueue(s.mockVoice, voices, () => setStatusNow("speaking"), () => setStatusNow("listening"));
    speech.current = queue;
    queue.push(last.text);
    queue.end();
  };

  const finish = async (history: MockTurn[]) => {
    stopAudio();
    setPhase("feedback");
    if (!history.some((t) => t.role === "candidate")) {
      setFeedback("_No answers were recorded, so there's nothing to review._");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    let text = "";
    try {
      await consume(await streamMockFeedback(s, history, controller.signal), (delta) => {
        text += delta;
        setFeedback(text);
      });
    } catch (e) {
      if (!controller.signal.aborted) setError(errorMessage(e));
    }
    let id = 0;
    saveSession({
      id: crypto.randomUUID(),
      startedAt: startedAt.current,
      endedAt: Date.now(),
      mode: "interview",
      mock: true,
      lines: history.map((t) => ({ id: id++, source: t.role === "interviewer" ? "them" : "me", text: t.text })),
      answers: text ? [{ id: 0, kind: "notes", prompt: "Mock interview feedback", text }] : [],
    }).catch(() => {});
  };

  // ---- render ----------------------------------------------------------------------

  if (phase === "setup") {
    return (
      <main className="settings mock">
        <h3>Mock interview</h3>
        <p className="muted">
          An AI interviewer asks questions out loud and you answer by speaking. At the end you get feedback on each
          answer. {s.resume.trim() ? "Questions are tailored to your resume." : "Add your resume in Settings to tailor the questions."}
        </p>
        <label>
          Role or job description
          <textarea
            rows={4}
            value={s.mockRole}
            onChange={(e) => set("mockRole", e.target.value)}
            placeholder="e.g. Senior frontend engineer at a fintech startup, or paste the job posting"
          />
        </label>
        <div className="segmented">
          {TYPES.map((t) => (
            <button key={t.id} className={s.mockType === t.id ? "active" : ""} onClick={() => set("mockType", t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <label>
          Questions
          <select value={s.mockQuestions} onChange={(e) => set("mockQuestions", +e.target.value)}>
            {[3, 5, 8, 10].map((n) => <option key={n} value={n}>{n} main questions</option>)}
          </select>
        </label>
        {ttsSupported ? (
          <label>
            Interviewer voice
            <select value={s.mockVoice} onChange={(e) => set("mockVoice", e.target.value)}>
              <option value="">System default</option>
              {voices.map((v) => <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>)}
            </select>
          </label>
        ) : (
          <p className="muted">Text-to-speech isn't available here, so questions will only be shown as text.</p>
        )}
        <p className="muted">Use headphones if you can, so the mic doesn't pick up the interviewer.</p>
        {error && <div className="error" onClick={() => setError("")}>{error}</div>}
        <div className="actions">
          <button onClick={onExit}>Cancel</button>
          <span className="spacer" />
          <button className="primary" onClick={start}>Start interview</button>
        </div>
      </main>
    );
  }

  if (phase === "feedback") {
    return (
      <main className="mock">
        {error && <div className="error" onClick={() => setError("")}>{error}</div>}
        <section className="answer">
          {feedback ? (
            <Suspense fallback={<p>{feedback}</p>}>
              <Markdown>{feedback}</Markdown>
            </Suspense>
          ) : (
            <p className="hint">Reviewing your answers…</p>
          )}
        </section>
        <div className="actions">
          <button onClick={() => setPhase("setup")}>Practise again</button>
          <span className="spacer" />
          <button className="primary" onClick={onExit}>Done</button>
        </div>
      </main>
    );
  }

  const live = `${answer.committed} ${answer.interim}`.trim();
  const asked = turns.filter((t) => t.role === "candidate").length;
  return (
    <main className="mock">
      {error && <div className="error" onClick={() => setError("")}>{error}</div>}
      <div className="mock-status">
        <span className={`dot ${status === "listening" ? "listening" : "connecting"}`} />
        <span>
          {status === "thinking" ? "Interviewer is thinking…" : status === "speaking" ? "Interviewer is speaking…" : "Your turn: answer out loud"}
        </span>
        <span className="spacer" />
        <span className="muted">{asked} answered</span>
      </div>

      <section className="answer mock-question">
        <p>{question || <span className="hint">…</span>}</p>
      </section>

      <div className="levels">
        <Meter source="me" label="You" />
      </div>
      <section className="transcript mock-answer">
        {live ? <p className="me"><b>You</b> {live}</p> : <p className="hint">{status === "listening" ? "Listening…" : ""}</p>}
      </section>

      <div className="actions">
        <button className="primary" onClick={submit} disabled={status !== "listening"} title={`${MOD}↵`}>
          Done answering
        </button>
        <button onClick={repeat} disabled={status !== "listening" || !ttsSupported}>Repeat question</button>
        <span className="spacer" />
        <button onClick={() => finish(turnsRef.current)}>End and get feedback</button>
      </div>
    </main>
  );
}
