import test from "node:test";
import assert from "node:assert/strict";
import { friendlyTranscodeError, prepareAudioUpload } from "./audio-transcoder.mjs";

function fakeTranscoder({ duration = 18000, unknown = false, exitCode = 0, mountResult = true } = {}) {
  const handlers = {};
  const calls = [];
  let outstanding = 0;
  let peak = 0;
  const engine = {
    on(name, callback) { handlers[name] = callback; },
    async load() {},
    async createDir() {},
    async mount(type, options) { calls.push(["mount", type, options]); return mountResult; },
    async unmount() { calls.push(["unmount"]); },
    async exec(args) {
      calls.push(["exec", args]);
      if (args.length === 2) {
        if (!unknown) handlers.log({ message: `Duration: ${String(Math.floor(duration / 3600)).padStart(2, "0")}:00:00.00` });
        return 1;
      }
      if (args.includes("null")) {
        handlers.progress({ time: duration * 1_000_000 });
        return 0;
      }
      outstanding++; peak = Math.max(peak, outstanding);
      return exitCode;
    },
    async readFile() { return new Uint8Array(100); },
    async deleteFile() { outstanding = Math.max(0, outstanding - 1); },
    terminate() { calls.push(["terminate"]); },
  };
  return { engine, calls, peak: () => peak };
}

async function prepared(fake, size = 3_456_000_044) {
  const original = globalThis.Worker;
  globalThis.Worker = class {};
  try {
    return await prepareAudioUpload({ size, name: "5-hours.wav", arrayBuffer() { throw new Error("Must not load full input"); } }, () => {}, {
      createFFmpeg: () => fake.engine,
      loadAsset: async () => "blob:test",
    });
  } finally { globalThis.Worker = original; }
}

test("returns useful errors for corrupt audio", () => {
  assert.match(friendlyTranscodeError(new Error("invalid data")).message, /invalid data/);
});

test("five-hour multi-GB input is mounted; output is generated and released one part at a time", async () => {
  const fake = fakeTranscoder();
  const audio = await prepared(fake);
  assert.equal(audio.count, 30);
  assert.equal(fake.calls.filter(([kind, args]) => kind === "exec" && args.includes("part.wav")).length, 0);
  for (let i = 0; i < 30; i++) assert.equal((await audio.takePart(i)).size, 100);
  assert.equal(fake.peak(), 1);
  const segments = fake.calls.filter(([kind, args]) => kind === "exec" && args.includes("part.wav"));
  assert.equal(segments.length, 30);
  assert.equal(segments[29][1][1], "17400");
  await audio.cleanup(); await audio.cleanup();
  assert.equal(fake.calls.filter(([kind]) => kind === "terminate").length, 1);
});

test("small imports also receive the duration check", async () => {
  const fake = fakeTranscoder({ duration: 3600 });
  const audio = await prepared(fake, 1_000_000);
  assert.equal(audio.count, 6);
  await audio.cleanup();
});

test("durationless audio is scanned without creating a full PCM output", async () => {
  const fake = fakeTranscoder({ unknown: true });
  const audio = await prepared(fake);
  assert.equal(audio.count, 30);
  assert.ok(fake.calls.some(([kind, args]) => kind === "exec" && args.includes("null")));
  await audio.cleanup();
});

test("rejects overlong audio before transcription and cleans up", async () => {
  const fake = fakeTranscoder({ duration: 21600 });
  await assert.rejects(prepared(fake), /länger als 5 Stunden/);
  assert.ok(fake.calls.some(([kind]) => kind === "unmount"));
});

test("failed conversion terminates the worker and input mount", async () => {
  const fake = fakeTranscoder({ exitCode: 1 });
  const audio = await prepared(fake);
  await assert.rejects(audio.takePart(0), /FFmpeg endete mit Code 1/);
  assert.ok(fake.calls.some(([kind]) => kind === "terminate"));
});

test("does not silently fall back to loading a multi-GB input when WORKERFS is unavailable", async () => {
  await assert.rejects(prepared(fakeTranscoder({ mountResult: false })), /WORKERFS/);
});
