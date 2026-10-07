import { FFmpeg } from "./vendor/ffmpeg/index.js";
import {
  SAFE_AUDIO_PART_BYTES,
  MAX_UPLOAD_DURATION_SECONDS,
  TRANSCODE_SEGMENT_SECONDS,
  assertUploadDuration,
  buildAudioPartArguments,
  durationFromLog,
  extensionForUpload,
  uploadHandlingForBytes,
} from "./audio-utils.mjs";

const CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
const CORE_ASSETS = {
  js: {
    url: `${CORE_BASE}/ffmpeg-core.js`,
    type: "text/javascript",
    sha256: "Z6SPEWRfhUOfP95PIRkELBazdLkQIGt6eiTzQuKNyuM=",
  },
  wasm: {
    url: `${CORE_BASE}/ffmpeg-core.wasm`,
    type: "application/wasm",
    sha256: "n1eUelvVMNjwDFs/LLKjSS+qfl2CMxU0LWqGVtCmt7c=",
  },
};
const TRANSCODE_TIMEOUT_MS = 30 * 60 * 1000;

function digestToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

async function fetchVerifiedAsset(asset) {
  const response = await fetch(asset.url, { mode: "cors" });
  if (!response.ok) {
    throw new Error(`Audio-Konverter konnte nicht geladen werden (HTTP ${response.status}).`);
  }
  const blob = await response.blob();
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  if (digestToBase64(digest) !== asset.sha256) {
    throw new Error("Integritätsprüfung des Audio-Konverters fehlgeschlagen.");
  }
  return URL.createObjectURL(new Blob([blob], { type: asset.type }));
}

export function friendlyTranscodeError(error) {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    "Diese Datei konnte im Browser nicht dekodiert werden. Unterstützt werden üblicherweise " +
      "MP3, M4A/MP4 (AAC), WAV, WebM/Opus, Ogg/Opus und FLAC. Bitte die Originaldatei " +
      "alternativ als MP3 oder M4A exportieren und erneut auswählen. Technisches Detail: " + detail,
  );
}

/** Mount the original file without copying it into WASM memory. Convert only
 * one part at a time; release it before creating the next part. */
export async function prepareAudioUpload(file, onProgress = () => {}, dependencies = {}) {
  uploadHandlingForBytes(file?.size);
  if (!globalThis.WebAssembly || !globalThis.Worker || !globalThis.crypto?.subtle) {
    throw friendlyTranscodeError(new Error("WebAssembly/Web Worker/Web Crypto wird nicht unterstützt"));
  }

  const ffmpeg = dependencies.createFFmpeg?.() || new FFmpeg();
  const loadAsset = dependencies.loadAsset || fetchVerifiedAsset;
  const objectUrls = [];
  const inputName = `/input/input.${extensionForUpload(file)}`;
  let mounted = false;
  let cleaned = false;
  let metadataDuration = null;
  let scannedDuration = 0;
  let progressListener = null;
  const logs = [];

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try { await ffmpeg.deleteFile("part.wav"); } catch { /* absent */ }
    if (mounted) {
      try { await ffmpeg.unmount("/input"); } catch { /* already terminated */ }
    }
    ffmpeg.terminate();
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
  };

  ffmpeg.on("log", ({ message }) => {
    logs.push(message);
    if (logs.length > 12) logs.shift();
    const seconds = durationFromLog(message);
    if (seconds !== null) {
      if (message.includes("Duration:")) metadataDuration = seconds;
      else scannedDuration = Math.max(scannedDuration, seconds);
    }
  });
  ffmpeg.on("progress", (event) => {
    if (progressListener) progressListener(event);
  });

  try {
    onProgress("download", 0);
    const coreURL = await loadAsset(CORE_ASSETS.js);
    objectUrls.push(coreURL);
    const wasmURL = await loadAsset(CORE_ASSETS.wasm);
    objectUrls.push(wasmURL);
    await ffmpeg.load({ coreURL, wasmURL });
    onProgress("download", 1);
    await ffmpeg.createDir("/input");
    mounted = await ffmpeg.mount("WORKERFS", {
      blobs: [{ name: `input.${extensionForUpload(file)}`, data: file }],
    }, "/input");
    if (!mounted) throw new Error("Der Audio-Konverter unterstützt kein dateibasiertes Lesen (WORKERFS).");

    onProgress("copy", 0);
    // An input-only FFmpeg call exits with 1 because there is no output, but
    // logs the container metadata. The pinned core does not provide ffprobe.
    await ffmpeg.exec(["-i", inputName], 60_000);
    if (metadataDuration === null) {
      // Some WebM/Opus files have no duration metadata. Scan into the null
      // muxer, never into a full-length PCM buffer, with a five-hour bound.
      progressListener = ({ time }) => {
        if (Number.isFinite(time)) scannedDuration = Math.max(scannedDuration, time / 1_000_000);
        onProgress("copy", Math.min(scannedDuration / MAX_UPLOAD_DURATION_SECONDS, 0.95));
      };
      const code = await ffmpeg.exec([
        "-i", inputName, "-map", "0:a:0", "-vn",
        "-t", String(MAX_UPLOAD_DURATION_SECONDS + 1), "-f", "null", "-",
      ], TRANSCODE_TIMEOUT_MS);
      progressListener = null;
      if (code !== 0) throw new Error(`Dauerprüfung fehlgeschlagen (Code ${code}). ${logs.slice(-3).join(" | ")}`);
    }
    const durationSeconds = metadataDuration ?? scannedDuration;
    assertUploadDuration(durationSeconds);
    const count = Math.ceil(Math.min(durationSeconds, MAX_UPLOAD_DURATION_SECONDS) / TRANSCODE_SEGMENT_SECONDS);
    onProgress("copy", 1);
    let nextIndex = 0;

    return {
      count,
      durationSeconds,
      segmentSeconds: TRANSCODE_SEGMENT_SECONDS,
      async takePart(index) {
        if (cleaned || index !== nextIndex || index >= count) throw new Error("Ungültiger Audioabschnitt.");
        try {
          onProgress("transcode", index / count);
          progressListener = ({ progress }) => {
            const bounded = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
            onProgress("transcode", (index + bounded) / count);
          };
          const code = await ffmpeg.exec(buildAudioPartArguments(inputName, index, durationSeconds), TRANSCODE_TIMEOUT_MS);
          progressListener = null;
          if (code !== 0) throw new Error(`FFmpeg endete mit Code ${code}. ${logs.slice(-3).join(" | ")}`);
          const data = await ffmpeg.readFile("part.wav");
          await ffmpeg.deleteFile("part.wav");
          const blob = new Blob([data], { type: "audio/wav" });
          if (blob.size <= 78 || blob.size > SAFE_AUDIO_PART_BYTES) {
            throw new Error(`Erzeugter Audioabschnitt hat eine ungültige Größe (${blob.size} Bytes).`);
          }
          nextIndex += 1;
          return blob;
        } catch (error) {
          await cleanup();
          throw friendlyTranscodeError(error);
        }
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    if (error.message?.includes("länger als 5 Stunden")) throw error;
    throw friendlyTranscodeError(error);
  }
}
