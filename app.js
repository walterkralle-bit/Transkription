import {
  MAX_API_ATTEMPTS,
  RECORDING_SEGMENT_MS,
  SAFE_AUDIO_PART_BYTES,
  SUMMARY_TIMEOUT_MS,
  TARGET_AUDIO_BITS_PER_SECOND,
  TRANSCRIPTION_TIMEOUT_MS,
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

const KEY_STORAGE = "openai_api_key";
const TRANSCRIBE_MODEL = "whisper-1";
const SUMMARY_MODEL = "gpt-4o-mini";
const FFMPEG_VERSION = "0.12.15";
const FFMPEG_CORE_VERSION = "0.12.10";
const CDN_BASE = "https://cdn.jsdelivr.net/npm";
const FFMPEG_SCRIPT_URL = `${CDN_BASE}/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/umd/ffmpeg.js`;
const FFMPEG_WORKER_URL = `${CDN_BASE}/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/umd/814.ffmpeg.js`;
const FFMPEG_CORE_BASE = `${CDN_BASE}/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/esm`;

const $ = (id) => document.getElementById(id);

const apiKeyInput = $("api-key");
const saveKeyBtn = $("save-key");
const editKeyBtn = $("edit-key");
const keyCollapsed = $("key-collapsed");
const keyExpanded = $("key-expanded");
const fileInput = $("audio-file");
const runBtn = $("run");
const recordBtn = $("record-btn");
const recordStatus = $("record-status");
const sourceHint = $("source-hint");
const statusCard = $("status-card");
const statusText = $("status-text");
const progress = $("progress");
const transcriptCard = $("transcript-card");
const transcriptArea = $("transcript");
const copyTranscriptBtn = $("copy-transcript");
const summaryCard = $("summary-card");
const summaryDiv = $("summary");
const copySummaryBtn = $("copy-summary");
const followupCard = $("followup-card");
const followupText = $("followup-text");
const followupRunBtn = $("followup-run");
const followupRecordBtn = $("followup-record-btn");
const followupRecordStatus = $("followup-record-status");
const followupSourceHint = $("followup-source-hint");

let mediaRecorder = null;
let recordedChunks = [];
let recordedBlobs = [];
let recordingStream = null;
let recordingMime = "";
let recordingSegmentTimer = null;
let recordingStopRequested = false;
let recordTimer = null;
let recordStartedAt = 0;
let followupMediaRecorder = null;
let followupRecordedChunks = [];
let followupRecordedBlob = null;
let followupRecordTimer = null;
let followupRecordStartedAt = 0;

function setKeyCollapsed(collapsed) {
  keyCollapsed.hidden = !collapsed;
  keyExpanded.hidden = collapsed;
}

function loadKey() {
  const k = localStorage.getItem(KEY_STORAGE);
  if (k) {
    apiKeyInput.value = k;
    setKeyCollapsed(true);
  } else {
    setKeyCollapsed(false);
  }
  updateRunState();
}

function saveKey() {
  const k = apiKeyInput.value.trim();
  if (!k) return;
  localStorage.setItem(KEY_STORAGE, k);
  flashStatus("API-Key gespeichert.");
  setKeyCollapsed(true);
  updateRunState();
}

function editKey() {
  setKeyCollapsed(false);
  apiKeyInput.focus();
}

function updateRunState() {
  const hasAudio = fileInput.files.length > 0 || recordedBlobs.length > 0;
  runBtn.disabled = !apiKeyInput.value.trim() || !hasAudio;
  if (recordedBlobs.length) {
    const totalBytes = recordedBlobs.reduce((sum, part) => sum + part.size, 0);
    sourceHint.hidden = false;
    sourceHint.textContent = `Aufnahme bereit (${fmtDuration(Date.now() - recordStartedAt)}, ${formatBytes(totalBytes)}, ${recordedBlobs.length} Abschnitt(e))`;
  } else if (fileInput.files.length) {
    const file = fileInput.files[0];
    sourceHint.hidden = false;
    sourceHint.textContent = `Datei: ${file.name} (${formatBytes(file.size)})` +
      (file.size > SAFE_AUDIO_PART_BYTES ? " – wird vor der Transkription lokal aufgeteilt" : "");
  } else {
    sourceHint.hidden = true;
  }

  const hasFollowupAudio = followupRecordedBlob !== null;
  followupRunBtn.disabled = !apiKeyInput.value.trim() || (!followupText.value.trim() && !hasFollowupAudio);
  if (followupRecordedBlob) {
    followupSourceHint.hidden = false;
    followupSourceHint.textContent = `Rückfrage-Aufnahme bereit (${(followupRecordedBlob.size / 1024).toFixed(0)} KB)`;
  } else {
    followupSourceHint.hidden = true;
  }
}

function pickAudioMime() {
  // iOS Safari supports only audio/mp4; put it first so we don't pick an unsupported one
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const candidates = isIOS
    ? ["audio/mp4", "audio/aac", "audio/webm"]
    : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  for (const m of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

async function toggleRecording() {
  if (recordingStream && !recordingStopRequested) {
    recordingStopRequested = true;
    clearTimeout(recordingSegmentTimer);
    if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
    return;
  }

  if (typeof MediaRecorder === "undefined") {
    showStatus("Browser unterstützt MediaRecorder nicht. Bitte Datei hochladen.");
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showStatus("Browser unterstützt keinen Mikrofonzugriff. (HTTPS aktiv? iOS: Safari verwenden, nicht in-App-Browser)");
    return;
  }

  recordStatus.textContent = "Mikrofon wird angefragt...";

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    showStatus(`Mikrofon-Zugriff verweigert: ${e.name || ""} ${e.message || e}`);
    recordStatus.textContent = "";
    return;
  }

  try {
    recordingStream = stream;
    recordingMime = pickAudioMime();
    recordingStopRequested = false;
    recordedBlobs = [];
    fileInput.value = "";
    recordStartedAt = Date.now();
    recordBtn.classList.add("recording");
    recordBtn.textContent = "⏹ Stoppen";
    recordStatus.textContent = "00:00";
    recordTimer = setInterval(() => {
      recordStatus.textContent = fmtDuration(Date.now() - recordStartedAt);
    }, 250);
    startRecordingSegment();
  } catch (e) {
    stream.getTracks().forEach((track) => track.stop());
    recordingStream = null;
    showStatus(`Aufnahme konnte nicht starten: ${e.name || ""} ${e.message || e}`);
    recordStatus.textContent = "";
  }
}

function createMainMediaRecorder() {
  const candidates = [
    { ...(recordingMime ? { mimeType: recordingMime } : {}), audioBitsPerSecond: TARGET_AUDIO_BITS_PER_SECOND },
    recordingMime ? { mimeType: recordingMime } : {},
    { audioBitsPerSecond: TARGET_AUDIO_BITS_PER_SECOND },
    {},
  ];
  for (const options of candidates) {
    try {
      return new MediaRecorder(recordingStream, options);
    } catch (e) {
      // Safari differs by release in which MIME/bitrate combinations it accepts.
    }
  }
  throw new Error("Kein unterstütztes Aufnahmeformat gefunden.");
}

function startRecordingSegment() {
  mediaRecorder = createMainMediaRecorder();
  recordedChunks = [];

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.onerror = (e) => {
    recordingStopRequested = true;
    showStatus(`Aufnahme-Fehler: ${e.error?.name || ""} ${e.error?.message || e}`);
  };
  mediaRecorder.onstop = () => {
    clearTimeout(recordingSegmentTimer);
    const type = mediaRecorder.mimeType || recordingMime || "audio/mp4";
    const blob = new Blob(recordedChunks, { type });
    if (blob.size > 0) recordedBlobs.push(blob);

    if (!recordingStopRequested) {
      startRecordingSegment();
      return;
    }

    recordingStream.getTracks().forEach((track) => track.stop());
    recordingStream = null;
    recordBtn.classList.remove("recording");
    recordBtn.textContent = "🎤 Neu aufnehmen";
    clearInterval(recordTimer);
    recordStatus.textContent = `Aufnahme: ${fmtDuration(Date.now() - recordStartedAt)}`;
    updateRunState();
  };

  // Each stop creates a self-contained media file. Byte-slicing WebM/MP4 would
  // create invalid fragments, so long recordings are split at recording time.
  mediaRecorder.start(1000);
  recordingSegmentTimer = setTimeout(() => {
    if (mediaRecorder.state === "recording") mediaRecorder.stop();
  }, RECORDING_SEGMENT_MS);
}

async function toggleFollowupRecording() {
  if (followupMediaRecorder && followupMediaRecorder.state === "recording") {
    followupMediaRecorder.stop();
    return;
  }

  if (typeof MediaRecorder === "undefined") {
    showStatus("Browser unterstützt MediaRecorder nicht. Bitte Rückfrage als Text schreiben.");
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showStatus("Browser unterstützt keinen Mikrofonzugriff für Rückfragen.");
    return;
  }

  followupRecordStatus.textContent = "Mikrofon wird angefragt...";

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    showStatus(`Mikrofon-Zugriff verweigert: ${e.name || ""} ${e.message || e}`);
    followupRecordStatus.textContent = "";
    return;
  }

  try {
    const mime = pickAudioMime();
    try {
      followupMediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (ctorErr) {
      followupMediaRecorder = new MediaRecorder(stream);
    }
    followupRecordedChunks = [];
    followupRecordedBlob = null;

    followupMediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) followupRecordedChunks.push(e.data);
    };
    followupMediaRecorder.onerror = (e) => {
      showStatus(`Rückfrage-Aufnahme-Fehler: ${e.error?.name || ""} ${e.error?.message || e}`);
    };
    followupMediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const type = followupMediaRecorder.mimeType || "audio/mp4";
      followupRecordedBlob = new Blob(followupRecordedChunks, { type });
      followupRecordBtn.classList.remove("recording");
      followupRecordBtn.textContent = "🎤 Rückfrage neu aufnehmen";
      clearInterval(followupRecordTimer);
      followupRecordStatus.textContent = `Aufnahme: ${fmtDuration(Date.now() - followupRecordStartedAt)}`;
      updateRunState();
    };

    followupMediaRecorder.start(1000);
    followupRecordStartedAt = Date.now();
    followupRecordBtn.classList.add("recording");
    followupRecordBtn.textContent = "⏹ Stoppen";
    followupRecordStatus.textContent = "00:00";
    followupRecordTimer = setInterval(() => {
      followupRecordStatus.textContent = fmtDuration(Date.now() - followupRecordStartedAt);
    }, 250);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    showStatus(`Rückfrage-Aufnahme konnte nicht starten: ${e.name || ""} ${e.message || e}`);
    followupRecordStatus.textContent = "";
  }
}

function showStatus(msg, busy = false) {
  statusCard.hidden = false;
  statusText.textContent = msg;
  progress.hidden = !busy;
}

function flashStatus(msg) {
  showStatus(msg);
  setTimeout(() => { statusCard.hidden = true; }, 2000);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadScript(url) {
  return new Promise((resolve, reject) => {
    if (window.FFmpegWASM?.FFmpeg) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = url;
    script.crossOrigin = "anonymous";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Audio-Werkzeug konnte nicht geladen werden."));
    document.head.appendChild(script);
  });
}

async function remoteAssetAsObjectUrl(url, type) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Audio-Werkzeug konnte nicht geladen werden (HTTP ${response.status}).`);
  return URL.createObjectURL(new Blob([await response.arrayBuffer()], { type }));
}

function inputExtension(file) {
  const match = file.name?.match(/\.([a-z0-9]{1,8})$/i);
  return match ? match[1].toLowerCase() : extensionForMime(file.type);
}

async function splitUploadedAudio(file) {
  if (typeof WebAssembly === "undefined" || typeof Worker === "undefined") {
    throw new Error("Dieser Browser kann große Audiodateien nicht lokal verarbeiten. Bitte einen aktuellen Browser verwenden.");
  }
  if (estimatedTranscodedPartBytes() >= SAFE_AUDIO_PART_BYTES) {
    throw new Error("Interner Fehler: Die geplanten Audio-Abschnitte sind zu groß.");
  }

  showStatus("Lade einmalig das Audio-Werkzeug (ca. 32 MB)...", true);
  await loadScript(FFMPEG_SCRIPT_URL);

  const objectUrls = [];
  let ffmpeg;
  try {
    // The wrapper worker is loaded from a same-origin blob. As a module worker it
    // then imports the ESM core; jsDelivr provides CORS headers for both assets.
    const classWorkerURL = await remoteAssetAsObjectUrl(FFMPEG_WORKER_URL, "text/javascript");
    const coreURL = `${FFMPEG_CORE_BASE}/ffmpeg-core.js`;
    const wasmURL = `${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`;
    objectUrls.push(classWorkerURL);

    const { FFmpeg } = window.FFmpegWASM;
    ffmpeg = new FFmpeg();
    ffmpeg.on("progress", ({ progress: fraction }) => {
      if (Number.isFinite(fraction) && fraction >= 0 && fraction <= 1) {
        showStatus(`Bereite Audio lokal vor... ${Math.round(fraction * 100)} %`, true);
      }
    });
    await ffmpeg.load({ classWorkerURL, coreURL, wasmURL });

    showStatus("Bereite Audio lokal vor...", true);
    const inputName = `input.${inputExtension(file)}`;
    await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
    const exitCode = await ffmpeg.exec([
      "-i", inputName,
      "-vn",
      "-map_metadata", "-1",
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "libmp3lame",
      "-b:a", `${UPLOAD_AUDIO_BITS_PER_SECOND / 1000}k`,
      "-f", "segment",
      "-segment_time", String(UPLOAD_SEGMENT_SECONDS),
      "-reset_timestamps", "1",
      "part-%03d.mp3",
    ]);
    if (exitCode !== 0) throw new Error(`Audio-Konvertierung fehlgeschlagen (Code ${exitCode}).`);

    const entries = await ffmpeg.listDir("/");
    const names = entries
      .filter(({ isDir, name }) => !isDir && /^part-\d{3}\.mp3$/.test(name))
      .map(({ name }) => name)
      .sort();
    if (!names.length) throw new Error("Audio-Konvertierung hat keine Abschnitte erzeugt.");

    const parts = [];
    for (let index = 0; index < names.length; index += 1) {
      const data = await ffmpeg.readFile(names[index]);
      const part = new File([data], `upload-teil-${index + 1}.mp3`, { type: "audio/mpeg" });
      assertTranscriptionPart(part);
      parts.push(part);
    }
    return parts;
  } catch (error) {
    if (typeof error === "string") throw new Error(error);
    throw error;
  } finally {
    ffmpeg?.terminate();
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
  }
}

async function prepareUploadedAudio(file) {
  const handling = uploadHandlingForBytes(file.size);
  return handling === "direct" ? [file] : splitUploadedAudio(file);
}

async function transcribe(file, key, fallbackName) {
  assertTranscriptionPart(file);
  const name = file.name || fallbackName || `recording.${extensionForMime(file.type)}`;

  for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt += 1) {
    const fd = new FormData();
    fd.append("file", file, name);
    fd.append("model", TRANSCRIBE_MODEL);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);
    try {
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: fd,
        signal: controller.signal,
      });
      if (res.ok) return (await res.json()).text;

      const err = await res.text();
      if (!isRetryableStatus(res.status) || attempt === MAX_API_ATTEMPTS) {
        throw new Error(`Whisper-Fehler ${res.status}: ${err}`);
      }
      await sleep(retryDelayMs(attempt, res.headers.get("Retry-After")));
    } catch (e) {
      if (e.message?.startsWith("Whisper-Fehler")) throw e;
      if (attempt === MAX_API_ATTEMPTS) {
        if (e.name === "AbortError") throw new Error("Zeitüberschreitung bei der Transkription.");
        throw e;
      }
      await sleep(retryDelayMs(attempt));
    } finally {
      clearTimeout(timer);
    }
  }
}

async function summarize(text, key) {
  const body = JSON.stringify({
    model: SUMMARY_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Rolle: Du bist Energieberater für erneuerbare Energien mit Spezialisierung auf Bestandsgebäude. Dein Fokus liegt auf Wärmepumpen sowie Solar- bzw. PV-Anlagen, und du bist dafür zuständig, diese in Häuser eingebaut zu bekommen.\n\nFasse das folgende Termin-/Gesprächstranskript aus dieser fachlichen Perspektive zusammen. Es kann sich um längere Gespräche (1–2 Stunden) handeln. Beschränke dich NICHT auf eine feste Anzahl Bulletpoints — verwende so viele Punkte wie nötig, um alle wichtigen Inhalte des Termins zu erfassen.\n\nWichtig: Korrigiere offensichtlich falsch transkribierte Fachbegriffe stillschweigend im Sinne (z.B. „Vermepompe“ → Wärmepumpe, JAZ, COP, kWp/kWh, Heizlast, KfW-/BAFA-Förderung, Pufferspeicher, Hybridanlage, Wallbox, Hydraulischer Abgleich etc.). Hebe hervor: Aufgaben, Termine, Zahlen, Entscheidungen sowie technisch/energetisch relevante Punkte (Anlagentypen, Leistung in kW/kWp, Speichergrößen, Förderungen, Sanierungsstand). Antworte auf Deutsch.",
      },
      { role: "user", content: text },
    ],
    temperature: 0.3,
  });

  for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      if (res.ok) {
        const data = await res.json();
        return data.choices?.[0]?.message?.content || "(keine Antwort)";
      }
      const err = await res.text();
      if (!isRetryableStatus(res.status) || attempt === MAX_API_ATTEMPTS) {
        throw new Error(`Summary-Fehler ${res.status}: ${err}`);
      }
      await sleep(retryDelayMs(attempt, res.headers.get("Retry-After")));
    } catch (e) {
      if (e.message?.startsWith("Summary-Fehler")) throw e;
      if (attempt === MAX_API_ATTEMPTS) {
        if (e.name === "AbortError") throw new Error("Zeitüberschreitung bei der Zusammenfassung.");
        throw e;
      }
      await sleep(retryDelayMs(attempt));
    } finally {
      clearTimeout(timer);
    }
  }
}

async function run() {
  const key = apiKeyInput.value.trim();
  const uploadedFile = fileInput.files[0];
  if (!key || (!recordedBlobs.length && !uploadedFile)) return;

  runBtn.disabled = true;
  transcriptCard.hidden = true;
  summaryCard.hidden = true;

  try {
    const parts = recordedBlobs.length ? recordedBlobs : await prepareUploadedAudio(uploadedFile);
    const transcripts = [];
    for (let index = 0; index < parts.length; index += 1) {
      showStatus(`Transkribiere Abschnitt ${index + 1} von ${parts.length}...`, true);
      const extension = extensionForMime(parts[index].type);
      transcripts.push(await transcribe(parts[index], key, `recording-${index + 1}.${extension}`));
    }
    const transcript = transcripts.join("\n\n");
    transcriptArea.value = transcript;
    transcriptCard.hidden = false;

    showStatus("Fasse zusammen...", true);
    const summary = await summarize(transcript, key);
    summaryDiv.textContent = summary;
    summaryCard.hidden = false;
    followupCard.hidden = false;

    statusCard.hidden = true;
  } catch (e) {
    showStatus(e.message || String(e));
  } finally {
    updateRunState();
  }
}

async function runFollowup() {
  const key = apiKeyInput.value.trim();
  const text = followupText.value.trim();
  const file = followupRecordedBlob;
  if (!key || (!text && !file)) return;

  followupRunBtn.disabled = true;

  try {
    let followup = text;
    if (file) {
      showStatus("Rückfrage transkribieren...", true);
      followup = await transcribe(file, key);
      followupText.value = followup;
    }
    showStatus("Rückfrage auswerten...", true);
    const reply = await summarize(`RÜCKFRAGE / FEHLENDE PUNKTE:\n${followup}`, key);
    summaryDiv.textContent = reply;
    summaryCard.hidden = false;
    statusCard.hidden = true;
  } catch (e) {
    showStatus(e.message || String(e));
  } finally {
    updateRunState();
  }
}

function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = "Kopiert ✓";
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });
}

saveKeyBtn.addEventListener("click", saveKey);
editKeyBtn.addEventListener("click", editKey);
apiKeyInput.addEventListener("input", updateRunState);
fileInput.addEventListener("change", () => { recordedBlobs = []; updateRunState(); });
recordBtn.addEventListener("click", toggleRecording);
runBtn.addEventListener("click", run);
followupText.addEventListener("input", updateRunState);
followupRecordBtn.addEventListener("click", toggleFollowupRecording);
followupRunBtn.addEventListener("click", runFollowup);
copyTranscriptBtn.addEventListener("click", () => copyToClipboard(transcriptArea.value, copyTranscriptBtn));
copySummaryBtn.addEventListener("click", () => copyToClipboard(summaryDiv.textContent, copySummaryBtn));

loadKey();
