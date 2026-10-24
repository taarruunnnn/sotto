import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Speaker } from "../lib/transcript";

/**
 * Audio level bar. It writes to the DOM directly instead of using React state, so
 * ~10 updates per second per source never re-render the rest of the app.
 */
export default function Meter({ source, label }: { source: Speaker; label?: string }) {
  const bar = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const unlisten = listen<{ source: Speaker; level: number }>("audio-level", ({ payload }) => {
      if (payload.source !== source || !bar.current) return;
      // Speech RMS sits around 0.01-0.2; a square-root curve makes quiet audio visible.
      const pct = Math.min(100, Math.sqrt(payload.level) * 220);
      bar.current.style.transform = `scaleX(${pct / 100})`;
    });
    return () => void unlisten.then((f) => f());
  }, [source]);

  return (
    <span className={`meter ${source}`} title={label}>
      {label && <span className="meter-label">{label}</span>}
      <span className="meter-track">
        <span className="meter-fill" ref={bar} />
      </span>
    </span>
  );
}
