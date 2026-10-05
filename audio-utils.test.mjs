import test from "node:test";
import assert from "node:assert/strict";

import {
  OPENAI_AUDIO_LIMIT_BYTES,
  RECORDING_SEGMENT_MS,
  SAFE_AUDIO_PART_BYTES,
  assertTranscriptionPart,
  extensionForMime,
  formatBytes,
  isRetryableStatus,
  retryDelayMs,
} from "./audio-utils.mjs";

test("keeps transcription requests below OpenAI's 25 MB limit", () => {
  assert.equal(OPENAI_AUDIO_LIMIT_BYTES, 25_000_000);
  assert.ok(SAFE_AUDIO_PART_BYTES < OPENAI_AUDIO_LIMIT_BYTES);
  assert.equal(formatBytes(SAFE_AUDIO_PART_BYTES), "24.0 MB");
  assert.doesNotThrow(() => assertTranscriptionPart({ size: SAFE_AUDIO_PART_BYTES }));
  assert.throws(
    () => assertTranscriptionPart({ size: SAFE_AUDIO_PART_BYTES + 1 }),
    /maximal 25 MB/,
  );
});

test("segments a 90 minute recording into nine requests", () => {
  assert.equal(RECORDING_SEGMENT_MS, 10 * 60 * 1000);
  assert.equal(Math.ceil((90 * 60 * 1000) / RECORDING_SEGMENT_MS), 9);
});

test("uses supported filename extensions for browser recording MIME types", () => {
  assert.equal(extensionForMime("audio/webm;codecs=opus"), "webm");
  assert.equal(extensionForMime("audio/mp4"), "m4a");
  assert.equal(extensionForMime("audio/aac"), "m4a");
});

test("retries only temporary HTTP failures with bounded backoff", () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(retryDelayMs(1, null), 1000);
  assert.equal(retryDelayMs(2, "5"), 5000);
  assert.equal(retryDelayMs(2, "120"), 30_000);
});
