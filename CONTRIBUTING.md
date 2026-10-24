# Contributing to Sotto

Thanks for helping! Ideas, bug reports, docs fixes and code are all welcome.

## Ways to help

- **Suggest something:** open a [feature request](https://github.com/taarruunnnn/sotto/issues/new?template=feature_request.md).
  Say what you were trying to do and why; that matters more than the exact solution.
- **Report a bug:** open a [bug report](https://github.com/taarruunnnn/sotto/issues/new?template=bug_report.md)
  with your OS, Sotto version and the steps to reproduce it.
- **Write code:** look at the [good places to start](README.md#contributing) in the README,
  or any issue labelled `good first issue` or `help wanted`.
- **Spread the word:** a star or a share helps more people find Sotto.

## Development setup

You need [Rust](https://rustup.rs), [Node 22+](https://nodejs.org) and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
git clone https://github.com/taarruunnnn/sotto.git
cd sotto
npm install
npm run tauri dev
```

On macOS, `tauri dev` asks for microphone, system audio and screen recording permission
on behalf of your terminal app. You'll need a Deepgram key and an AI provider key to test
calls; the [README](README.md#which-api-keys-work) lists which ones work.

The [For developers](README.md#for-developers) section explains how the Rust backend,
React frontend, voice and AI parts fit together.

## Before you open a pull request

1. **Open an issue first for anything big**, so we can agree on the approach.
2. **Keep changes focused.** One feature or fix per pull request.
3. **Match the existing style.** Small, well-named functions, and comments that explain
   why rather than what.
4. **Run the checks:**
   ```sh
   npx tsc --noEmit                 # frontend types
   (cd src-tauri && cargo test)     # backend tests
   (cd src-tauri && cargo clippy)   # backend lints
   ```
5. **Test it in the app** with `npm run tauri dev`, on the OS you changed, and say in the
   pull request what you tested.
6. **Keep it light.** Sotto is a few megabytes; avoid large dependencies, and load heavy
   ones only when they're needed (see `lib/llm.ts` and `lib/documents.ts`).
7. **Never commit API keys.** Keys belong in the app's keychain storage, not in files.
   `.env` and `api.txt` are already ignored.

## What we won't merge

Sotto is for practice, meetings, accessibility and note-taking (see
[Responsible use](README.md#responsible-use)). We won't accept changes whose purpose is
helping people cheat or evade monitoring, such as hiding the process from system
monitors or hiding activity from proctoring or interview platforms.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
