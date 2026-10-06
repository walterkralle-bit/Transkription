import test from "node:test";
import assert from "node:assert/strict";

import {
  OPENAI_AUDIO_LIMIT_BYTES,
  MAX_UPLOAD_BYTES,
  RECORDING_SEGMENT_MS,
  SAFE_AUDIO_PART_BYTES,
  UPLOAD_AUDIO_BITS_PER_SECOND,
  UPLOAD_SEGMENT_SECONDS,
  assertTranscriptionPart,
  estimatedTranscodedPartBytes,
  extensionForMime,
  formatBytes,
  isRetryableStatus,
  retryDelayMs,
  uploadHandlingForBytes,
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

test("routes uploaded files over 24 MB through local conversion", () => {
  assert.equal(uploadHandlingForBytes(SAFE_AUDIO_PART_BYTES), "direct");
  assert.equal(uploadHandlingForBytes(SAFE_AUDIO_PART_BYTES + 1), "transcode");
  assert.equal(uploadHandlingForBytes(90_000_000), "transcode");
  assert.equal(uploadHandlingForBytes(MAX_UPLOAD_BYTES), "transcode");
  assert.throws(() => uploadHandlingForBytes(0), /leer oder ungültig/);
  assert.throws(() => uploadHandlingForBytes(MAX_UPLOAD_BYTES + 1), /bis 250.0 MB/);
});

test("20-minute fixed-bitrate upload parts remain well below the request limit", () => {
  assert.equal(UPLOAD_SEGMENT_SECONDS, 20 * 60);
  assert.equal(UPLOAD_AUDIO_BITS_PER_SECOND, 48_000);
  assert.equal(estimatedTranscodedPartBytes(), 7_328_000);
  assert.ok(estimatedTranscodedPartBytes() < SAFE_AUDIO_PART_BYTES);
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
