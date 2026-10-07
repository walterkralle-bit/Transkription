import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_API_ATTEMPTS,
  MAX_UPLOAD_DURATION_SECONDS,
  assertUploadDuration,
  durationFromLog,
  buildAudioPartArguments,
  OPENAI_AUDIO_LIMIT_BYTES,
  RECORDING_SEGMENT_MS,
  SUMMARY_TIMEOUT_MS,
  SAFE_AUDIO_PART_BYTES,
  TRANSCODE_SEGMENT_SECONDS,
  TRANSCRIPTION_TIMEOUT_MS,
  assertTranscriptionPart,
  buildTranscodeArguments,
  extensionForMime,
  extensionForUpload,
  formatBytes,
  isPreparedUploadRequired,
  isRetryableStatus,
  pcmWavBytes,
  preparationStatus,
  sortAudioPartNames,
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

test("segments a 90 minute recording into nine requests", () => {
  assert.equal(RECORDING_SEGMENT_MS, 10 * 60 * 1000);
  assert.equal(Math.ceil((90 * 60 * 1000) / RECORDING_SEGMENT_MS), 9);
});

test("uses supported filename extensions for browser recording MIME types", () => {
  assert.equal(extensionForMime("audio/webm;codecs=opus"), "webm");
  assert.equal(extensionForMime("audio/mp4"), "m4a");
  assert.equal(extensionForMime("audio/aac"), "m4a");
  assert.equal(extensionForMime("video/mp4"), "m4a");
  assert.equal(extensionForMime("audio/flac"), "flac");
  assert.equal(extensionForMime("audio/x-wav"), "wav");
});

test("recognizes oversized existing uploads without byte slicing", () => {
  assert.equal(uploadHandlingForBytes(SAFE_AUDIO_PART_BYTES), "direct");
  assert.equal(uploadHandlingForBytes(90_000_000), "transcode");
  assert.throws(() => uploadHandlingForBytes(0), /leer oder ungültig/);
  assert.equal(uploadHandlingForBytes(3_456_000_044), "transcode");
  assert.equal(isPreparedUploadRequired({ size: SAFE_AUDIO_PART_BYTES }), false);
  assert.equal(isPreparedUploadRequired({ size: 90_000_000 }), true);
  assert.equal(extensionForUpload({ name: "Termin.M4A", type: "" }), "m4a");
  assert.equal(extensionForUpload({ name: "aufnahme", type: "audio/flac" }), "flac");
});

test("re-encodes ten-minute parts as valid mono 16 kHz WAV below the API limit", () => {
  assert.equal(TRANSCODE_SEGMENT_SECONDS, 600);
  assert.equal(pcmWavBytes(TRANSCODE_SEGMENT_SECONDS), 19_200_078);
  assert.ok(pcmWavBytes(TRANSCODE_SEGMENT_SECONDS) < SAFE_AUDIO_PART_BYTES);

  const args = buildTranscodeArguments("input.m4a");
  assert.deepEqual(args.slice(0, 2), ["-i", "input.m4a"]);
  assert.deepEqual(args.slice(args.indexOf("-ac"), args.indexOf("-ac") + 4), ["-ac", "1", "-ar", "16000"]);
  assert.ok(args.includes("pcm_s16le"));
  assert.ok(args.includes("segment"));
  assert.equal(args.at(-1), "part-%03d.wav");
  assert.equal(args.includes("-c copy"), false);
});

test("selects only complete generated audio containers in sequence", () => {
  assert.deepEqual(
    sortAudioPartNames(["input.m4a", "part-010.wav", "part-002.wav", "part-001.wav", "part-x.wav"]),
    ["part-001.wav", "part-002.wav", "part-010.wav"],
  );
});

test("maps preparation phases to bounded UI progress", () => {
  assert.deepEqual(preparationStatus("download", 0.5), {
    label: "Lade den Audio-Konverter (einmalig ca. 32 MB)...",
    progress: 0.05,
  });
  assert.equal(preparationStatus("copy", 1).progress, 0.2);
  assert.ok(Math.abs(preparationStatus("transcode", 0.5).progress - 0.6) < Number.EPSILON);
  assert.equal(preparationStatus("transcode", 2).progress, 1);
  assert.equal(preparationStatus("unknown", Number.NaN).progress, 0);
});

test("retries only temporary HTTP failures with bounded backoff and timeouts", () => {
  assert.equal(MAX_API_ATTEMPTS, 3);
  assert.equal(TRANSCRIPTION_TIMEOUT_MS, 5 * 60 * 1000);
  assert.equal(SUMMARY_TIMEOUT_MS, 3 * 60 * 1000);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(retryDelayMs(1, null), 1000);
  assert.equal(retryDelayMs(2, "5"), 5000);
  assert.equal(retryDelayMs(2, "120"), 30_000);
});


test("accepts five-hour imports independently of their file size", () => {
  assert.equal(MAX_UPLOAD_DURATION_SECONDS, 18000);
  assert.doesNotThrow(() => assertUploadDuration(18000));
  assert.throws(() => assertUploadDuration(18001), /länger als 5 Stunden/);
  assert.throws(() => assertUploadDuration(NaN), /Dauer/);
  assert.equal(durationFromLog("Duration: 05:00:00.00, start: 0.0"), 18000);
  assert.equal(durationFromLog("frame=0 time=00:10:01.25 bitrate=N/A"), 601.25);
  assert.equal(durationFromLog("Duration: N/A, start: 0.0"), null);
});

test("converts five hours into 30 sequential bounded requests including the end", () => {
  assert.equal(Math.ceil(18000 / TRANSCODE_SEGMENT_SECONDS), 30);
  const last = buildAudioPartArguments("/input/file.wav", 29, 18000);
  assert.deepEqual(last.slice(0, 6), ["-ss", "17400", "-i", "/input/file.wav", "-t", "600"]);
  assert.equal(last.at(-1), "part.wav");
  const partial = buildAudioPartArguments("/input/file.wav", 2, 1201.5);
  assert.equal(partial[5], "1.5");
  assert.throws(() => buildAudioPartArguments("file", 30, 18000), /Ungültiger/);
});
