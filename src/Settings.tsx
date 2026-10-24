import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import KeyField from "./components/KeyField";
import AiKeyField from "./components/AiKeyField";
import { ShortcutList } from "./components/Onboarding";
import { testDeepgramKey } from "./lib/checks";
import { DOCUMENT_ACCEPT, extractText } from "./lib/documents";
import { isMac } from "./lib/checks";
import { errorMessage } from "./lib/llm";
import {
  CODE_LANGUAGES,
  keysInKeychain,
  LANGUAGES,
  MAX_INSTRUCTIONS,
  type Settings,
} from "./lib/settings";

interface Device {
  id: string;
  name: string;
}

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onRerunSetup: () => void;
}

export default function SettingsView({ settings: s, onChange, onRerunSetup }: Props) {
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...s, [key]: value });
  const [devices, setDevices] = useState<{ inputs: Device[]; outputs: Device[] }>({ inputs: [], outputs: [] });
  const [docError, setDocError] = useState("");
  const [loadingDocs, setLoadingDocs] = useState(false);

  useEffect(() => {
    invoke<typeof devices>("list_audio_devices").then(setDevices).catch(() => {});
  }, []);

  const addDocuments = async (files: FileList | null, asResume = false) => {
    if (!files?.length) return;
    setDocError("");
    setLoadingDocs(true);
    try {
      const docs = await Promise.all([...files].map(async (f) => ({ name: f.name, text: await extractText(f) })));
      if (asResume) set("resume", docs.map((d) => d.text).join("\n\n"));
      else set("documents", [...s.documents, ...docs]);
    } catch (e) {
      setDocError(`Couldn't read that file: ${errorMessage(e)}`);
    } finally {
      setLoadingDocs(false);
    }
  };

  return (
    <main className="settings">
      <p className="muted">
        {keysInKeychain()
          ? `API keys are stored in ${isMac ? "your macOS Keychain" : "Windows Credential Manager"}, not in a file.`
          : "The system keychain isn't available, so API keys are stored in Sotto's settings file."}
      </p>
      <h3>Transcription</h3>
      <KeyField
        label="Deepgram API key"
        value={s.deepgramKey}
        placeholder="From console.deepgram.com"
        onChange={(v) => set("deepgramKey", v)}
        onTest={() => testDeepgramKey(s.deepgramKey)}
      />
      <label>
        Language
        <select value={s.language} onChange={(e) => set("language", e.target.value)}>
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
      </label>
      <label>
        Call audio comes from
        <select value={s.outputDevice} onChange={(e) => set("outputDevice", e.target.value)}>
          <option value="">System default output</option>
          {devices.outputs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <span className="muted">Pick the speakers or headset your meeting app plays through.</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={s.captureMic} onChange={(e) => set("captureMic", e.target.checked)} />
        Also transcribe my microphone
      </label>
      {s.captureMic && (
        <label>
          Microphone
          <select value={s.micDevice} onChange={(e) => set("micDevice", e.target.value)}>
            <option value="">System default microphone</option>
            {devices.inputs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
      )}

      <h3>AI model</h3>
      <AiKeyField settings={s} onChange={onChange} />

      <h3>Answers</h3>
      <div className="segmented">
        {(["interview", "meeting"] as const).map((m) => (
          <button key={m} className={s.mode === m ? "active" : ""} onClick={() => set("mode", m)}>
            {m === "interview" ? "Interview" : "Regular call"}
          </button>
        ))}
      </div>
      <div className="segmented">
        {(["short", "detailed"] as const).map((l) => (
          <button key={l} className={s.answerLength === l ? "active" : ""} onClick={() => set("answerLength", l)}>
            {l === "short" ? "Short answers" : "Detailed answers"}
          </button>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={s.autoAnswer} onChange={(e) => set("autoAnswer", e.target.checked)} />
        Answer automatically when the other side asks a question
      </label>
      <label>
        Coding language
        <select value={s.codeLanguage} onChange={(e) => set("codeLanguage", e.target.value)}>
          {CODE_LANGUAGES.map((l) => <option key={l}>{l}</option>)}
        </select>
      </label>

      <h3>Context</h3>
      {s.mode === "interview" && (
        <label>
          Resume
          <textarea rows={5} value={s.resume} onChange={(e) => set("resume", e.target.value)} placeholder="Paste text, or upload below" />
          <input type="file" accept=".pdf,.docx,.txt,.md" onChange={(e) => addDocuments(e.target.files, true)} />
        </label>
      )}
      <label>
        Instructions <span className="muted">{s.instructions.length.toLocaleString()} / {MAX_INSTRUCTIONS.toLocaleString()}</span>
        <textarea
          rows={4}
          maxLength={MAX_INSTRUCTIONS}
          value={s.instructions}
          onChange={(e) => set("instructions", e.target.value)}
          placeholder="Role, company, tone, things to emphasise…"
        />
      </label>
      <label>
        Documents (PDF, DOCX, TXT, MD)
        <input type="file" multiple accept={DOCUMENT_ACCEPT} onChange={(e) => addDocuments(e.target.files)} />
      </label>
      {loadingDocs && <span className="muted">Reading…</span>}
      {docError && <div className="error">{docError}</div>}
      {s.documents.map((d, i) => (
        <div key={i} className="doc">
          <span>{d.name}</span>
          <span className="muted">{d.text.length.toLocaleString()} chars</span>
          <button onClick={() => set("documents", s.documents.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}

      <h3>Appearance</h3>
      <label>
        Background opacity <span className="muted">{Math.round(s.opacity * 100)}%</span>
        <input type="range" min={0.35} max={1} step={0.01} value={s.opacity} onChange={(e) => set("opacity", +e.target.value)} />
      </label>
      <label>
        Text size <span className="muted">{s.fontSize}px</span>
        <input type="range" min={11} max={20} step={1} value={s.fontSize} onChange={(e) => set("fontSize", +e.target.value)} />
      </label>

      <h3>Privacy</h3>
      <label className="check">
        <input type="checkbox" checked={s.stealth} onChange={(e) => set("stealth", e.target.checked)} />
        Hide from screen share, recordings, Dock and taskbar
      </label>
      <label className="check">
        <input type="checkbox" checked={s.startHidden} onChange={(e) => set("startHidden", e.target.checked)} />
        Start hidden (open from the tray icon or the shortcut)
      </label>
      <p className="muted">Keys are stored on this computer and sent only to the providers you choose.</p>

      <h3>Shortcuts</h3>
      <ShortcutList />

      <button onClick={onRerunSetup}>Run setup again</button>
    </main>
  );
}
