import { useState } from "react";
import KeyField from "./KeyField";
import { detectProvider, PROVIDERS, providerInfo } from "./providers";
import { testProvider } from "../lib/checks";
import type { Provider, Settings } from "../lib/settings";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
}

/**
 * One API key box for the AI model. The provider is detected from the key, so
 * there's no provider list to pick from unless the key's format is unrecognised.
 */
export default function AiKeyField({ settings: s, onChange }: Props) {
  const [manual, setManual] = useState(false);
  const key = s.apiKeys[s.provider];
  const info = providerInfo(s.provider);
  const recognised = !key.trim() || detectProvider(key) !== undefined;

  const setKey = (value: string) => {
    const provider = detectProvider(value) ?? s.provider;
    onChange({ ...s, provider, apiKeys: { ...s.apiKeys, [provider]: value } });
  };
  const setProvider = (provider: Provider) =>
    // Move the pasted key over to the chosen provider.
    onChange({ ...s, provider, apiKeys: { ...s.apiKeys, [s.provider]: "", [provider]: key } });

  return (
    <>
      <KeyField
        label="AI API key"
        value={key}
        placeholder="Paste an OpenRouter, Anthropic, Google or OpenAI key"
        hint={`No key yet? OpenRouter (openrouter.ai/keys) gives you every model with one key. Separate several keys with commas for automatic failover.`}
        onChange={setKey}
        onTest={() => testProvider(s)}
      />
      {key.trim() && (
        <span className="muted detected">
          {recognised ? <>Detected: <b>{info.label}</b></> : <>Couldn't tell which service this key is for. Choose it below.</>}
          {recognised && !manual && (
            <button type="button" className="link" onClick={() => setManual(true)}>Not right?</button>
          )}
        </span>
      )}
      {(manual || !recognised) && (
        <label>
          Provider
          <select value={s.provider} onChange={(e) => setProvider(e.target.value as Provider)}>
            {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
      )}
      <label>
        Model
        <input value={s.models[s.provider]} onChange={(e) => onChange({ ...s, models: { ...s.models, [s.provider]: e.target.value } })} />
        <span className="muted">{info.modelHint}. Fast models give the quickest answers.</span>
      </label>
    </>
  );
}
