// Records the README screenshots and the trailer from the demo stage.
//
//   node demo/record.mjs            # screenshots + trailer.mp4 + hero.gif in demo/out/
//   node demo/record.mjs shots      # screenshots only
//
// Needs Google Chrome and ffmpeg. The app runs on a mocked backend (demo/mock.ts),
// so no API keys are used and nothing leaves the machine.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const OUT = join(import.meta.dirname, "out");
const FRAMES = join(OUT, "frames");
const only = process.argv[2];

const server = await createServer({ server: { port: 1430, strictPort: true }, logLevel: "warn" });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", args: ["--hide-scrollbars"] });

try {
  mkdirSync(OUT, { recursive: true });
  await run({ trailer: false });
  if (only !== "shots") await run({ trailer: true });
} finally {
  await browser.close();
  await server.close();
}

async function run({ trailer }) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
  await page.goto("http://localhost:1430/demo/index.html");
  await page.evaluate(() => window.stage.ready);
  const app = page.frameLocator("#sotto");
  const wait = (s) => page.waitForTimeout(s * 1000);
  const stage = (fn, ...args) => page.evaluate(([fn, args]) => window.stage[fn](...args), [fn, args]);
  const say = (source, text, wordMs) =>
    page.evaluate(([s, t, ms]) => window.stage.app().demo.say(s, t, ms), [source, text, wordMs]);
  const script = await page.evaluate(() => import("/demo/script.ts").then((m) => ({ CALL: m.CALL, MOCK: m.MOCK })));
  const { CALL, MOCK } = script;

  // Captions and title cards are for the trailer only; screenshots stay clean.
  const caption = (title, sub) => trailer && stage("caption", title, sub);
  // The outro stays up to the last frame.
  const card = async (id, seconds) => {
    if (!trailer) return;
    await stage("card", id, true);
    await wait(seconds);
  };
  const shot = async (name, target = "window") => {
    if (trailer) return;
    const path = join(OUT, `${name}.png`);
    if (target === "window") await page.locator("#sotto").screenshot({ path, omitBackground: true });
    else await page.screenshot({ path });
    console.log("saved", path);
  };
  // The answer's own Stop button is there exactly while it streams.
  const answerDone = async () => {
    const stop = app.getByTitle("Stop (Esc)");
    await stop.waitFor({ timeout: 5_000 }).catch(() => {});
    await stop.waitFor({ state: "detached", timeout: 30_000 });
  };

  const recording = trailer ? await startScreencast(page) : null;

  // ---- intro
  if (trailer) await stage("card", "intro", true);
  await wait(trailer ? 3.2 : 0.5);
  if (trailer) await stage("card", "intro", false);
  await wait(0.6);

  // ---- a live interview
  await app.getByRole("button", { name: "Listen" }).click();
  await page.mouse.move(400, 450);
  caption("Hears both sides of the call", "Live transcript of you and the interviewer");
  await wait(0.8);
  await say("them", CALL.q1);
  caption("Answers the moment they ask", "A short answer you can say out loud, in about a second");
  await answerDone();
  await wait(trailer ? 3 : 0.5);
  await shot("call", "page");
  await shot("answer");
  caption("");
  await say("me", CALL.a1, 200);
  await wait(0.6);

  caption("Follows the whole conversation", "Every new question gets a fresh answer");
  await say("them", CALL.q2);
  await answerDone();
  await wait(trailer ? 3.2 : 0.5);
  await shot("answer-2");

  caption("Ask it anything, mid-call", "Type a question about the call");
  const input = app.getByPlaceholder("Ask anything about this call…");
  await input.click();
  await input.pressSequentially(CALL.chat, { delay: 40 });
  await input.press("Enter");
  await answerDone();
  await wait(trailer ? 2.8 : 0.5);
  await shot("chat");
  caption("");

  // ---- invisible on screen share
  const sotto = await page.locator("#sotto").screenshot({ omitBackground: true });
  await page.evaluate((src) => (window.stage.sottoShot = src), `data:image/png;base64,${sotto.toString("base64")}`);
  await stage("share", true);
  await wait(trailer ? 5 : 0.8);
  await shot("screen-share", "page");
  await stage("share", false);
  await app.locator("header button.danger").click();
  await wait(0.6);

  // ---- mock interview
  await stage("practice", true);
  await stage("place", { left: 1000, top: 70, width: 540, height: 760 });
  caption("Practise with an AI interviewer", "It asks questions out loud, tailored to the role and your resume");
  await wait(0.9);
  await app.getByRole("button", { name: "Practice" }).click();
  await wait(trailer ? 2 : 0.6);
  await shot("practice-setup");
  await app.getByRole("button", { name: "Start interview" }).click();

  for (let i = 0; i < 2; i++) {
    await app.getByText("Your turn").waitFor({ timeout: 30_000 });
    await wait(0.4);
    await say("me", MOCK.answers[i], i === 0 ? 95 : 80);
    if (i === 0) await shot("practice");
    await wait(0.5);
    await app.getByRole("button", { name: "Done answering" }).click();
    await wait(0.5);
  }
  await app.getByText("Your turn").waitFor({ timeout: 30_000 });
  caption("Then get honest feedback", "A score, what worked, and what to practise next");
  await app.getByRole("button", { name: "End and get feedback" }).click();
  await app.getByText("Practise next").waitFor({ timeout: 30_000 });
  await wait(trailer ? 4 : 0.8);
  await shot("feedback");

  // ---- history and settings (screenshots only)
  if (!trailer) {
    await app.getByRole("button", { name: "Done", exact: true }).click();
    await app.getByTitle("Past calls").click();
    await wait(0.6);
    await shot("history");
    await app.getByTitle("Back").click();
    await app.getByTitle("Settings").click();
    await wait(0.8);
    await shot("settings");
  }

  // ---- outro
  caption("");
  await card("outro", 4.5);

  const frames = recording ? await recording.stop() : null;
  await page.close();
  if (frames) encode(frames);
}

/** Chrome's screencast gives sharper frames than Playwright's built-in recorder. */
async function startScreencast(page) {
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const file = join(FRAMES, `f${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, t: metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080 });
  return {
    async stop() {
      await cdp.send("Page.stopScreencast");
      return frames;
    },
  };
}

function encode(frames) {
  // Frames only arrive when something changes, so each one is held until the next.
  const list = frames
    .map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? f.t + 0.5) - f.t).toFixed(4)}`)
    .join("\n");
  writeFileSync(join(FRAMES, "list.txt"), `${list}\nfile '${frames.at(-1).file}'\n`);
  const mp4 = join(OUT, "trailer.mp4");
  const ff = (...args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
  ff("-f", "concat", "-safe", "0", "-i", join(FRAMES, "list.txt"),
    "-vf", "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p",
    "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart", mp4);
  console.log("saved", mp4);

  // A short loop of the live-answer scene for the top of the README.
  const gif = join(OUT, "hero.gif");
  ff("-ss", "3.6", "-t", "15", "-i", mp4,
    "-vf", "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
    gif);
  console.log("saved", gif);
}
