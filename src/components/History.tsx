import { lazy, Suspense, useEffect, useState } from "react";
import { deleteSession, listSessions, sessionToMarkdown, type Session } from "../lib/sessions";

const Markdown = lazy(() => import("react-markdown"));

export default function History() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [open, setOpen] = useState<Session | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    listSessions().then(setSessions);
  }, []);

  if (!sessions) return <main />;

  if (open) {
    const notes = open.answers.filter((a) => a.kind === "notes").at(-1);
    return (
      <main className="history">
        <div className="actions">
          <button onClick={() => setOpen(null)}>← All calls</button>
          <span className="spacer" />
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(sessionToMarkdown(open));
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy as Markdown"}
          </button>
          <button
            onClick={async () => {
              await deleteSession(open.id);
              setSessions(sessions.filter((s) => s.id !== open.id));
              setOpen(null);
            }}
          >
            Delete
          </button>
        </div>
        <section className="answer">
          {notes ? (
            <Suspense><Markdown>{notes.text}</Markdown></Suspense>
          ) : (
            <p className="hint">No notes for this call. Press Notes during a call to create them.</p>
          )}
        </section>
        <section className="transcript">
          {open.lines.map((l) => (
            <p key={l.id} className={l.source}><b>{l.source === "me" ? "Me" : "Them"}</b> {l.text}</p>
          ))}
        </section>
      </main>
    );
  }

  return (
    <main className="history">
      {!sessions.length && <p className="hint">Past calls appear here once you've used Listen.</p>}
      {sessions.map((s) => {
        const minutes = s.endedAt ? Math.max(1, Math.round((s.endedAt - s.startedAt) / 60_000)) : undefined;
        const firstQuestion = s.lines.find((l) => l.source === "them")?.text;
        return (
          <button key={s.id} className="session-row" onClick={() => setOpen(s)}>
            <span>
              <b>{new Date(s.startedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</b>
              <span className="muted"> · {s.mock ? "Mock interview" : s.mode === "interview" ? "Interview" : "Call"}{minutes ? ` · ${minutes} min` : ""}</span>
            </span>
            <span className="muted ellipsis">{firstQuestion ?? "No transcript"}</span>
          </button>
        );
      })}
    </main>
  );
}
