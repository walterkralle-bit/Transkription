export const OPENAI_AUDIO_LIMIT_BYTES = 25_000_000;
// Leave room below OpenAI's decimal 25 MB per-file limit.
export const SAFE_AUDIO_PART_BYTES = 24_000_000;
export const MAX_UPLOAD_BYTES = 250_000_000;
export const RECORDING_SEGMENT_MS = 10 * 60 * 1000;
export const TRANSCODE_SEGMENT_SECONDS = 10 * 60;
export const TRANSCODE_SAMPLE_RATE = 16_000;
export const TARGET_AUDIO_BITS_PER_SECOND = 32_000;
export const TRANSCRIPTION_TIMEOUT_MS = 5 * 60 * 1000;
export const SUMMARY_TIMEOUT_MS = 3 * 60 * 1000;
export const MAX_API_ATTEMPTS = 3;

export function formatBytes(bytes) {
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(0)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function assertTranscriptionPart(part) {
  if (!part || part.size === 0) {
    throw new Error("Die Audio-Datei ist leer.");
  }
  if (part.size > SAFE_AUDIO_PART_BYTES) {
    throw new Error(
      `Die Audio-Datei ist ${formatBytes(part.size)} groß. OpenAI akzeptiert pro ` +
      `Transkriptions-Anfrage maximal 25 MB. Die automatische Aufteilung hat ` +
      `keinen ausreichend kleinen Abschnitt erzeugt.`
    );
  }
}

export function uploadHandlingForBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error("Die Audio-Datei ist leer oder ungültig.");
  }
  if (bytes > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Die Audio-Datei ist ${formatBytes(bytes)} groß. Unterstützt werden Uploads bis ` +
      `${formatBytes(MAX_UPLOAD_BYTES)}.`,
    );
  }
  return bytes <= SAFE_AUDIO_PART_BYTES ? "direct" : "transcode";
}


export function extensionForMime(type = "") {
  const mime = type.split(";")[0].toLowerCase();
  return ({
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "video/mp4": "m4a",
    "audio/aac": "m4a",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/webm": "webm",
  })[mime] || "webm";
}

export function extensionForUpload(file = {}) {
  const match = String(file.name || "").toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  if (match) return match[1];
  return extensionForMime(file.type);
}

export function isPreparedUploadRequired(file) {
  return Boolean(file && file.size > SAFE_AUDIO_PART_BYTES);
}

export function pcmWavBytes(durationSeconds, sampleRate = TRANSCODE_SAMPLE_RATE) {
  return Math.ceil(durationSeconds * sampleRate) * 2 + 78;
}

export function buildTranscodeArguments(inputName, segmentSeconds = TRANSCODE_SEGMENT_SECONDS) {
  return [
    "-i", inputName,
    "-vn",
    "-map", "0:a:0",
    "-ac", "1",
    "-ar", String(TRANSCODE_SAMPLE_RATE),
    "-c:a", "pcm_s16le",
    "-f", "segment",
    "-segment_time", String(segmentSeconds),
    "-reset_timestamps", "1",
    "part-%03d.wav",
  ];
}

export function sortAudioPartNames(names) {
  return names.filter((name) => /^part-\d{3}\.wav$/.test(name)).sort();
}

export function preparationStatus(phase, value) {
  const phases = {
    download: ["Lade den Audio-Konverter (einmalig ca. 32 MB)...", 0, 0.1],
    copy: ["Lese die Audiodatei in den geschützten Browser-Arbeitsspeicher...", 0.1, 0.2],
    transcode: ["Erzeuge gültige 10-Minuten-Audioabschnitte im Browser...", 0.2, 1],
  };
  const [label, start, end] = phases[phase] || ["Verarbeite Audiodatei im Browser...", 0, 1];
  const boundedValue = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return { label, progress: start + ((end - start) * boundedValue) };
}

export function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export function retryDelayMs(attempt, retryAfterHeader) {
  const retryAfterSeconds = Number(retryAfterHeader);
  if (retryAfterHeader !== null && retryAfterHeader !== undefined && retryAfterHeader !== "" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1000, 30_000);
  }
  return Math.min(1000 * (2 ** (attempt - 1)), 8000);
}
