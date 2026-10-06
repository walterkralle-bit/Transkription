import { FFmpeg } from "./vendor/ffmpeg/index.js";
import {
  SAFE_AUDIO_PART_BYTES,
  TRANSCODE_SEGMENT_SECONDS,
  buildTranscodeArguments,
  extensionForUpload,
  isPreparedUploadRequired,
  sortAudioPartNames,
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

/**
 * Transcodes one oversized upload inside a Web Worker. The input never leaves
 * the browser here. Output is mono 16 kHz PCM WAV in independently valid files.
 */
export async function prepareLargeUpload(file, onProgress = () => {}) {
  const handling = uploadHandlingForBytes(file?.size);
  if (handling !== "transcode" || !isPreparedUploadRequired(file)) {
    throw new Error("prepareLargeUpload darf nur für Dateien über dem sicheren Upload-Limit verwendet werden.");
  }
  if (!globalThis.WebAssembly || !globalThis.Worker || !globalThis.crypto?.subtle) {
    throw friendlyTranscodeError(new Error("WebAssembly/Web Worker/Web Crypto wird nicht unterstützt"));
  }

  const ffmpeg = new FFmpeg();
  const objectUrls = [];
  const inputName = `input.${extensionForUpload(file)}`;
  let partNames = [];
  let cleaned = false;
  const logs = [];

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const name of partNames) {
      try { await ffmpeg.deleteFile(name); } catch { /* already consumed */ }
    }
    try { await ffmpeg.deleteFile(inputName); } catch { /* load/write may have failed */ }
    ffmpeg.terminate();
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
  };

  ffmpeg.on("log", ({ message }) => {
    logs.push(message);
    if (logs.length > 12) logs.shift();
  });
  ffmpeg.on("progress", ({ progress }) => {
    if (Number.isFinite(progress)) onProgress("transcode", Math.max(0, Math.min(1, progress)));
  });

  try {
    onProgress("download", 0);
    const coreURL = await fetchVerifiedAsset(CORE_ASSETS.js);
    objectUrls.push(coreURL);
    const wasmURL = await fetchVerifiedAsset(CORE_ASSETS.wasm);
    objectUrls.push(wasmURL);
    onProgress("download", 1);

    await ffmpeg.load({ coreURL, wasmURL });
    onProgress("copy", 0);
    await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
    onProgress("copy", 1);

    const exitCode = await ffmpeg.exec(
      buildTranscodeArguments(inputName, TRANSCODE_SEGMENT_SECONDS),
      TRANSCODE_TIMEOUT_MS,
    );
    if (exitCode !== 0) {
      throw new Error(`FFmpeg endete mit Code ${exitCode}. ${logs.slice(-3).join(" | ")}`);
    }

    partNames = sortAudioPartNames((await ffmpeg.listDir("/"))
      .filter((entry) => !entry.isDir)
      .map((entry) => entry.name));
    if (partNames.length === 0) throw new Error("Die Datei enthält keine dekodierbare Audiospur.");

    return {
      count: partNames.length,
      segmentSeconds: TRANSCODE_SEGMENT_SECONDS,
      async takePart(index) {
        const name = partNames[index];
        if (!name) throw new Error("Ungültiger Audioabschnitt.");
        const data = await ffmpeg.readFile(name);
        await ffmpeg.deleteFile(name);
        const blob = new Blob([data], { type: "audio/wav" });
        if (blob.size > SAFE_AUDIO_PART_BYTES) {
          throw new Error(`Erzeugter Audioabschnitt ist unerwartet zu groß (${blob.size} Bytes).`);
        }
        return blob;
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw friendlyTranscodeError(error);
  }
}
