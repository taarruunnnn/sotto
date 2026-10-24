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
- **Mock interview.** Practise with an AI interviewer that asks questions out loud
  (using your OS's text-to-speech voices) for the role you enter, follows up on vague
  answers, and gives you scored, question-by-question feedback at the end. Your answers
  are transcribed from the mic, and the session is saved to your call history.
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

## Install

Download the latest installer from the
[Releases page](https://github.com/taarruunnnn/sotto/releases/latest).

### macOS (14.6 or later)

1. Download the `.dmg` for your Mac: `aarch64` for Apple Silicon (M1 and later), `x64`
   for Intel. To check, open  → About This Mac and look at "Chip".
2. Open the `.dmg` and drag **Sotto** into **Applications**.
3. Open Sotto from Applications. The builds aren't notarized by Apple yet, so the first
   launch is blocked:
   - Go to **System Settings → Privacy & Security**, scroll down and click
     **Open Anyway** next to the message about Sotto, then confirm.
   - If macOS says the app **"is damaged and can't be opened"**, run this in Terminal,
     then open it again:
     ```sh
     xattr -dr com.apple.quarantine /Applications/Sotto.app
     ```
4. Sotto has no Dock icon. Look for it in the **menu bar** (top right).

### Windows (10 version 2004 or later, or 11)

1. Download `Sotto_x.y.z_x64-setup.exe` (or the `.msi` if you prefer).
2. Run it. The installer isn't code-signed yet, so SmartScreen may show
   **"Windows protected your PC"**: click **More info → Run anyway**.
3. Sotto has no taskbar button. Look for it in the **system tray** (bottom right; it may
   be under the **^** overflow arrow).

### First launch

On first launch a short setup walks you through:

1. A **Deepgram** API key ([console.deepgram.com](https://console.deepgram.com))
2. An API key for your AI provider, plus a model id (editable, so newer models work).
   Both keys have a **Test** button.
3. An audio check, with level meters for your mic and computer audio

Press **Listen** when the call starts. You can rerun the setup from Settings.

### Permissions

- **macOS (14.6+ required for system audio):** allow Microphone, System Audio Recording
  and Screen Recording when prompted. When running from source with `tauri dev`, the
  permission is granted to your terminal app instead. The audio check links straight to the right System Settings panes.
- **Windows:** no extra permissions. Screen-capture exclusion needs Windows 10 2004+.

### Stealth troubleshooting

- **Overlay visible in a Zoom screen share:** in Zoom, open Settings → Share Screen →
  Advanced and turn on **Advanced capture with window filtering**. Without it, Zoom can
  capture the screen in a way that ignores capture exclusion.
- **Icon still in the macOS Dock:** turn off **Show suggested and recent apps** in
  System Settings → Desktop & Dock, then restart Sotto.
- Always do a test share with the app you'll actually use before a real call.

## Build from source

Prerequisites: [Rust](https://rustup.rs), [Node 22+](https://nodejs.org), and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS (Xcode Command
Line Tools on macOS; Visual Studio C++ Build Tools and WebView2 on Windows).

```sh
git clone https://github.com/taarruunnnn/sotto.git
cd sotto
npm install
npm run tauri dev     # run in development
npm run tauri build   # build an installer for this machine
```

Installers are written to `src-tauri/target/release/bundle/` (`dmg/` on macOS, `nsis/`
and `msi/` on Windows). Each OS can only build its own installer.

### Releasing

`.github/workflows/release.yml` builds macOS (Apple Silicon and Intel) and Windows
installers on GitHub Actions and attaches them to a draft release. Bump `version` in
`src-tauri/tauri.conf.json`, `package.json` and `src-tauri/Cargo.toml`, then:

```sh
git tag v0.1.0
git push origin v0.1.0
```

Review the draft on the Releases page and publish it.

## Architecture

```
src-tauri/src/
  audio.rs       cpal capture: mic + system loopback → 16 kHz mono PCM, level meter
  deepgram.rs    one WebSocket per source → `transcript` events
  net.rs         pooled HTTP client that AI requests stream through (no CORS)
  secrets.rs     API keys in the macOS Keychain / Windows Credential Manager
  stealth.rs     capture exclusion, no Dock/taskbar, always-on-top
  lib.rs         commands (sessions, audio check, screenshot), shortcuts, tray
src/
  App.tsx        overlay UI, question detection, answer streaming
  Settings.tsx   keys, devices, model, mode, resume, instructions, documents
  components/    setup wizard, mock interview, call history, key field, audio meter
  lib/llm.ts     AI SDK providers and prompts
  lib/net.ts     fetch over net.rs, with multi-key failover
  lib/sessions.ts  saved calls
  lib/documents.ts PDF / DOCX / text extraction
  lib/speech.ts  text-to-speech for the mock interviewer
```

API keys are stored in the OS credential store (macOS Keychain, Windows Credential
Manager), never in a file, and are sent only to the providers you configure. Keys saved by
older versions in `settings.json` are moved to the keychain on first launch. Other
settings live in the app data folder (`settings.json`).

## Roadmap

- Local transcription (NVIDIA Parakeet / Whisper) for offline use

## License

[MIT](LICENSE)
