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

let mediaRecorder = null;
let recordedChunks = [];
let recordedBlob = null;
let recordTimer = null;
let recordStartedAt = 0;

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
  const hasAudio = fileInput.files.length > 0 || recordedBlob !== null;
  runBtn.disabled = !apiKeyInput.value.trim() || !hasAudio;
  if (recordedBlob) {
    sourceHint.hidden = false;
    sourceHint.textContent = `Aufnahme bereit (${(recordedBlob.size / 1024).toFixed(0)} KB)`;
  } else if (fileInput.files.length) {
    sourceHint.hidden = false;
    sourceHint.textContent = `Datei: ${fileInput.files[0].name}`;
  } else {
    sourceHint.hidden = true;
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
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
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
    const mime = pickAudioMime();
    try {
      mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (ctorErr) {
      // iOS Safari sometimes rejects the mime; retry without it
      mediaRecorder = new MediaRecorder(stream);
    }
    recordedChunks = [];
    recordedBlob = null;
    fileInput.value = "";

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onerror = (e) => {
      showStatus(`Aufnahme-Fehler: ${e.error?.name || ""} ${e.error?.message || e}`);
    };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const type = mediaRecorder.mimeType || "audio/mp4";
      recordedBlob = new Blob(recordedChunks, { type });
      recordBtn.classList.remove("recording");
      recordBtn.textContent = "🎤 Neu aufnehmen";
      clearInterval(recordTimer);
      recordStatus.textContent = `Aufnahme: ${fmtDuration(Date.now() - recordStartedAt)}`;
      updateRunState();
    };

    // timeslice forces ondataavailable events; helps iOS Safari
    mediaRecorder.start(1000);
    recordStartedAt = Date.now();
    recordBtn.classList.add("recording");
    recordBtn.textContent = "⏹ Stoppen";
    recordStatus.textContent = "00:00";
    recordTimer = setInterval(() => {
      recordStatus.textContent = fmtDuration(Date.now() - recordStartedAt);
    }, 250);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    showStatus(`Aufnahme konnte nicht starten: ${e.name || ""} ${e.message || e}`);
    recordStatus.textContent = "";
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

async function transcribe(file, key) {
  const fd = new FormData();
  // file may be a File or a Blob from MediaRecorder; give it a filename either way
  const name = file.name || `recording.${(file.type.split("/")[1] || "webm").split(";")[0]}`;
  fd.append("file", file, name);
  fd.append("model", TRANSCRIBE_MODEL);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: fd,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Whisper-Fehler ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.text;
}

async function summarize(text, key) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
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
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Summary-Fehler ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "(keine Antwort)";
}

async function run() {
  const key = apiKeyInput.value.trim();
  const file = recordedBlob || fileInput.files[0];
  if (!key || !file) return;

  runBtn.disabled = true;
  transcriptCard.hidden = true;
  summaryCard.hidden = true;

  try {
    showStatus("Transkribiere...", true);
    const transcript = await transcribe(file, key);
    transcriptArea.value = transcript;
    transcriptCard.hidden = false;

    showStatus("Fasse zusammen...", true);
    const summary = await summarize(transcript, key);
    summaryDiv.textContent = summary;
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
fileInput.addEventListener("change", () => { recordedBlob = null; updateRunState(); });
recordBtn.addEventListener("click", toggleRecording);
runBtn.addEventListener("click", run);
copyTranscriptBtn.addEventListener("click", () => copyToClipboard(transcriptArea.value, copyTranscriptBtn));
copySummaryBtn.addEventListener("click", () => copyToClipboard(summaryDiv.textContent, copySummaryBtn));

loadKey();
