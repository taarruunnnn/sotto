import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import KeyField from "./KeyField";
import Meter from "./Meter";
import { PROVIDERS } from "./providers";
import { isMac, MOD, PRIVACY_PANES, testDeepgramKey, testProvider } from "../lib/checks";
import { errorMessage } from "../lib/llm";
import type { Provider, Settings } from "../lib/settings";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onDone: () => void;
}

const STEPS = ["Transcription", "AI model", "Audio check", "Ready"];

export default function Onboarding({ settings: s, onChange, onDone }: Props) {
  const [step, setStep] = useState(0);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...s, [key]: value });
  const provider = PROVIDERS.find((p) => p.id === s.provider)!;

  return (
    <main className="onboarding">
      <ol className="steps">
        {STEPS.map((name, i) => (
          <li key={name} className={i === step ? "active" : i < step ? "done" : ""}>{name}</li>
        ))}
      </ol>

      {step === 0 && (
        <>
          <h2>Welcome to Sotto</h2>
          <p className="muted">
            Sotto listens to your calls, transcribes both sides live and suggests what to say. It
            uses your own API keys, which stay on this computer.
          </p>
          <KeyField
            label="Deepgram API key (live transcription)"
            value={s.deepgramKey}
            placeholder="Paste key"
            hint="Free credit at console.deepgram.com → API Keys."
            onChange={(v) => set("deepgramKey", v)}
            onTest={() => testDeepgramKey(s.deepgramKey)}
          />
        </>
      )}

      {step === 1 && (
        <>
          <h2>Pick an AI model</h2>
          <label>
            Provider
            <select value={s.provider} onChange={(e) => set("provider", e.target.value as Provider)}>
              {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <KeyField
            label="API key"
            value={s.apiKeys[s.provider]}
            placeholder={provider.keyHint}
            hint={`${provider.keyUrl}. Add more keys separated by commas for automatic failover.`}
            onChange={(v) => set("apiKeys", { ...s.apiKeys, [s.provider]: v })}
            onTest={() => testProvider(s)}
          />
          <label>
            Model
            <input value={s.models[s.provider]} onChange={(e) => set("models", { ...s.models, [s.provider]: e.target.value })} />
            <span className="muted">Fast models give the quickest answers.</span>
          </label>
        </>
      )}

      {step === 2 && <AudioCheck settings={s} />}

      {step === 3 && (
        <>
          <h2>You're set</h2>
          <div className="segmented">
            {(["interview", "meeting"] as const).map((m) => (
              <button key={m} className={s.mode === m ? "active" : ""} onClick={() => set("mode", m)}>
                {m === "interview" ? "Interview" : "Regular call"}
              </button>
            ))}
          </div>
          {s.mode === "interview" && (
            <label>
              Resume (optional; you can also upload a PDF in Settings)
              <textarea rows={5} value={s.resume} onChange={(e) => set("resume", e.target.value)} placeholder="Paste your resume text" />
            </label>
          )}
          <ShortcutList />
        </>
      )}

      <footer className="wizard-nav">
        {step > 0 && <button onClick={() => setStep(step - 1)}>Back</button>}
        <span className="spacer" />
        {step < STEPS.length - 1 ? (
          <button className="primary" onClick={() => setStep(step + 1)}>
            {step === 0 && !s.deepgramKey ? "Skip" : "Next"}
          </button>
        ) : (
          <button className="primary" onClick={onDone}>Start using Sotto</button>
        )}
      </footer>
    </main>
  );
}

function AudioCheck({ settings }: { settings: Settings }) {
  const [error, setError] = useState("");

  useEffect(() => {
    invoke("start_audio_test", {
      micDevice: settings.micDevice || null,
      outputDevice: settings.outputDevice || null,
    }).catch((e) => setError(errorMessage(e)));
    return () => void invoke("stop_audio_test");
  }, [settings.micDevice, settings.outputDevice]);

  return (
    <>
      <h2>Check your audio</h2>
      <p className="muted">Play any video with sound and say something. Both bars should move.</p>
      <Meter source="them" label="Computer audio (the other side)" />
      <Meter source="me" label="Your microphone" />
      {error && <div className="error">{error}</div>}
      {isMac && (
        <div className="permission-links">
          <span className="muted">Bars not moving? Allow Sotto (or your terminal, in dev mode) here:</span>
          <button onClick={() => openUrl(PRIVACY_PANES.microphone)}>Microphone</button>
          <button onClick={() => openUrl(PRIVACY_PANES.audio)}>System audio</button>
          <button onClick={() => openUrl(PRIVACY_PANES.screen)}>Screen recording</button>
        </div>
      )}
    </>
  );
}

export function ShortcutList() {
  const rows: [string, string][] = [
    [`${MOD}↵`, "Answer the last question"],
    [`${MOD}⇧↵`, "Suggest something to say"],
    [`${MOD}⇧S`, "Screenshot and solve"],
    [`${MOD}⇧A`, "Add a screenshot (for multi-part problems)"],
    [`${MOD}⇧[ / ]`, "Previous / next answer"],
    [`${MOD}\\`, "Hide / show"],
    [`${MOD}⇧M`, "Click-through mode"],
    [`${MOD} arrows`, "Move the window"],
  ];
  return (
    <table className="shortcuts">
      <tbody>
        {rows.map(([keys, what]) => (
          <tr key={keys}><td><kbd>{keys}</kbd></td><td>{what}</td></tr>
        ))}
      </tbody>
    </table>
  );
}
