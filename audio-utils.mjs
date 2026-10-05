export const OPENAI_AUDIO_LIMIT_BYTES = 25_000_000;
// Leave room below OpenAI's decimal 25 MB per-file limit.
export const SAFE_AUDIO_PART_BYTES = 24_000_000;
export const RECORDING_SEGMENT_MS = 10 * 60 * 1000;
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
      `Transkriptions-Anfrage maximal 25 MB. Bitte die Datei komprimieren/teilen ` +
      `oder direkt in dieser App aufnehmen; App-Aufnahmen werden automatisch in ` +
      `sichere 10-Minuten-Abschnitte geteilt.`
    );
  }
}

export function extensionForMime(type = "") {
  const mime = type.split(";")[0].toLowerCase();
  return ({
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "m4a",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/webm": "webm",
  })[mime] || "webm";
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
