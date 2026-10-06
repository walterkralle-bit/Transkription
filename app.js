import {
  MAX_API_ATTEMPTS,
  RECORDING_SEGMENT_MS,
  SUMMARY_TIMEOUT_MS,
  TARGET_AUDIO_BITS_PER_SECOND,
  TRANSCRIPTION_TIMEOUT_MS,
  assertTranscriptionPart,
  extensionForMime,
  formatBytes,
  isPreparedUploadRequired,
  isRetryableStatus,
  preparationStatus,
  retryDelayMs,
} from "./audio-utils.mjs";
import { prepareLargeUpload } from "./audio-transcoder.mjs";

const KEY_STORAGE = "openai_api_key";
const TRANSCRIBE_MODEL = "whisper-1";
const SUMMARY_MODEL = "gpt-4o-mini";

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
    sourceHint.textContent = `Datei: ${file.name} (${formatBytes(file.size)})${
      isPreparedUploadRequired(file) ? " – wird vor dem Upload im Browser geteilt" : ""
    }`;
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

function showStatus(msg, busy = false, value = null) {
  statusCard.hidden = false;
  statusText.textContent = msg;
  progress.hidden = !busy;
  if (!busy || value === null) {
    progress.removeAttribute("value");
  } else {
    progress.max = 1;
    progress.value = Math.max(0, Math.min(1, value));
  }
}

function showPreparationProgress(phase, value) {
  const status = preparationStatus(phase, value);
  showStatus(status.label, true, status.progress);
}

function flashStatus(msg) {
  showStatus(msg);
  setTimeout(() => { statusCard.hidden = true; }, 2000);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const upload = fileInput.files[0];
  if (!key || (!recordedBlobs.length && !upload)) return;

  runBtn.disabled = true;
  transcriptCard.hidden = true;
  summaryCard.hidden = true;
  let preparedUpload = null;

  try {
    const transcripts = [];
    if (recordedBlobs.length) {
      for (let index = 0; index < recordedBlobs.length; index += 1) {
        showStatus(
          `Transkribiere Abschnitt ${index + 1} von ${recordedBlobs.length}...`,
          true,
          index / recordedBlobs.length,
        );
        const extension = extensionForMime(recordedBlobs[index].type);
        transcripts.push(await transcribe(
          recordedBlobs[index],
          key,
          `recording-${index + 1}.${extension}`,
        ));
      }
    } else if (isPreparedUploadRequired(upload)) {
      preparedUpload = await prepareLargeUpload(upload, showPreparationProgress);
      for (let index = 0; index < preparedUpload.count; index += 1) {
        showStatus(
          `Transkribiere erzeugten Abschnitt ${index + 1} von ${preparedUpload.count}...`,
          true,
          index / preparedUpload.count,
        );
        const part = await preparedUpload.takePart(index);
        transcripts.push(await transcribe(part, key, `upload-${index + 1}.wav`));
      }
    } else {
      showStatus("Transkribiere Datei...", true);
      transcripts.push(await transcribe(upload, key, upload.name));
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
    if (preparedUpload) await preparedUpload.cleanup();
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
