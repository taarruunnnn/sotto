# Sotto

An open-source, real-time AI copilot for calls and interviews. It's a floating overlay
that listens to both sides of a call, transcribes them live with Deepgram, and suggests
what to say next with the model of your choice (Claude, GPT, Gemini, or any model through
Vercel AI Gateway).

Built with **Tauri 2** (Rust) + **React** + **AI SDK 7**.

## Features

- **Live transcription of both sides.** System audio ("Them") is captured with OS loopback
  and the microphone ("Me") separately, each on its own Deepgram `nova-3` stream. Pick the
  input and output devices and the language (or multilingual auto-detect) in Settings.
- **Auto Answer.** When the other side asks a question, an answer starts streaming as soon
  as the sentence is finished, without waiting for them to pause. If they keep talking, it
  restarts with the full question.
- **Suggest.** Something natural to say out loud right now, plus key points and likely
  follow-ups.
- **Solve screen.** Screenshots the monitor and sends it to a vision model for coding or
  on-screen questions. For multi-part problems, add screenshots one at a time and send
  them together.
- **Interview and Regular call modes.** Interview mode grounds answers in your resume.
- **Context.** Up to 20,000 characters of instructions, plus reference documents
  (PDF, DOCX, TXT, Markdown, CSV, JSON). Your resume can be uploaded as a PDF or DOCX too.
- **Chat.** Ask anything about the call.
- **Notes.** Summary, discussion points, decisions, action items and next steps, generated
  from the transcript.
- **Call history.** Every call's transcript, answers and notes are saved locally (the last
  40 calls) and can be copied as Markdown.
- **Answer history.** Step back through earlier answers during a call. Click a transcript
  line to leave it out of AI prompts.
- **Key failover.** Enter several API keys separated by commas; when one is rejected or
  rate-limited, the next is used.
- **Privacy / stealth.** The overlay is excluded from screen sharing, recording and
  screenshots. It has no Dock icon or taskbar button (use the tray icon) and floats over
  fullscreen apps. Can be turned off in Settings, along with opacity and text size.

## Global shortcuts

| Shortcut (macOS / Windows) | Action |
|---|---|
| `⌘↵` / `Ctrl+Enter` | Answer the last question |
| `⌘⇧↵` / `Ctrl+Shift+Enter` | Suggest something to say |
| `⌘⇧S` / `Ctrl+Shift+S` | Screenshot and solve |
| `⌘⇧A` / `Ctrl+Shift+A` | Add a screenshot (sent with the next solve) |
| `⌘⇧[` `⌘⇧]` / `Ctrl+Shift+[` `Ctrl+Shift+]` | Previous / next answer |
| `⌘\` / `Ctrl+\` | Hide / show overlay |
| `⌘⇧M` / `Ctrl+Shift+M` | Click-through mode (mouse passes through the overlay) |
| `⌘ + arrows` / `Ctrl + arrows` | Move overlay |

The shortcuts work without focusing the overlay, so you never have to click away from the
call. With the overlay focused, `Esc` stops the answer that's streaming.

## Getting started

Prerequisites: [Rust](https://rustup.rs), Node 22+, and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri dev
```

On first launch a short setup walks you through:

1. A **Deepgram** API key ([console.deepgram.com](https://console.deepgram.com))
2. An API key for your AI provider, plus a model id (editable, so newer models work).
   Both keys have a **Test** button.
3. An audio check, with level meters for your mic and computer audio

Press **Listen** when the call starts. You can rerun the setup from Settings.

### Permissions

- **macOS (14.6+ required for system audio):** allow Microphone, System Audio Recording
  and Screen Recording when prompted. In `tauri dev` the permission is granted to your
  terminal app. The audio check links straight to the right System Settings panes.
- **Windows:** no extra permissions. Screen-capture exclusion needs Windows 10 2004+.

### Stealth troubleshooting

- **Overlay visible in a Zoom screen share:** in Zoom, open Settings → Share Screen →
  Advanced and turn on **Advanced capture with window filtering**. Without it, Zoom can
  capture the screen in a way that ignores capture exclusion.
- **Icon still in the macOS Dock:** turn off **Show suggested and recent apps** in
  System Settings → Desktop & Dock, then restart Sotto.
- Always do a test share with the app you'll actually use before a real call.

## Architecture

```
src-tauri/src/
  audio.rs       cpal capture: mic + system loopback → 16 kHz mono PCM, level meter
  deepgram.rs    one WebSocket per source → `transcript` events
  net.rs         pooled HTTP client that AI requests stream through (no CORS)
  stealth.rs     capture exclusion, no Dock/taskbar, always-on-top
  lib.rs         commands (sessions, audio check, screenshot), shortcuts, tray
src/
  App.tsx        overlay UI, question detection, answer streaming
  Settings.tsx   keys, devices, model, mode, resume, instructions, documents
  components/    setup wizard, call history, key field, audio meter
  lib/llm.ts     AI SDK providers and prompts
  lib/net.ts     fetch over net.rs, with multi-key failover
  lib/sessions.ts  saved calls
  lib/documents.ts PDF / DOCX / text extraction
```

API keys are stored locally in the app data folder (`settings.json`) and sent only to
the providers you configure.

## Roadmap

- Mock interview mode (AI interviewer with TTS)
- Local transcription (NVIDIA Parakeet / Whisper) for offline use
- Store keys in the OS keychain
