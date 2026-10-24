import { useState } from "react";
import { errorMessage } from "../lib/llm";

interface Props {
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  onChange: (value: string) => void;
  /** Resolves if the key works; throws with a readable reason if not. */
  onTest: () => Promise<void>;
}

/** Password field with a "Test" button that checks the key against the real API. */
export default function KeyField({ label, value, placeholder, hint, onChange, onTest }: Props) {
  const [state, setState] = useState<{ status: "idle" | "testing" | "ok" | "fail"; message?: string }>({
    status: "idle",
  });

  const test = async () => {
    setState({ status: "testing" });
    try {
      await onTest();
      setState({ status: "ok" });
    } catch (e) {
      setState({ status: "fail", message: errorMessage(e) });
    }
  };

  return (
    <label>
      {label}
      <span className="key-row">
        <input
          type="password"
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            setState({ status: "idle" });
          }}
        />
        <button type="button" onClick={test} disabled={!value.trim() || state.status === "testing"}>
          {state.status === "testing" ? "Testing…" : "Test"}
        </button>
      </span>
      {state.status === "ok" && <span className="ok">✓ Works</span>}
      {state.status === "fail" && <span className="fail">✕ {state.message}</span>}
      {hint && state.status === "idle" && <span className="muted">{hint}</span>}
    </label>
  );
}
