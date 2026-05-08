const KEY_STORAGE = "openai_api_key";
const TRANSCRIBE_MODEL = "whisper-1";
const SUMMARY_MODEL = "gpt-4o-mini";

const $ = (id) => document.getElementById(id);

const apiKeyInput = $("api-key");
const saveKeyBtn = $("save-key");
const fileInput = $("audio-file");
const runBtn = $("run");
const statusCard = $("status-card");
const statusText = $("status-text");
const progress = $("progress");
const transcriptCard = $("transcript-card");
const transcriptArea = $("transcript");
const copyTranscriptBtn = $("copy-transcript");
const summaryCard = $("summary-card");
const summaryDiv = $("summary");
const copySummaryBtn = $("copy-summary");

function loadKey() {
  const k = localStorage.getItem(KEY_STORAGE);
  if (k) apiKeyInput.value = k;
  updateRunState();
}

function saveKey() {
  const k = apiKeyInput.value.trim();
  if (!k) return;
  localStorage.setItem(KEY_STORAGE, k);
  flashStatus("API-Key gespeichert.");
  updateRunState();
}

function updateRunState() {
  runBtn.disabled = !apiKeyInput.value.trim() || !fileInput.files.length;
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
  fd.append("file", file);
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
            "Du bist ein Assistent, der Sprachnotizen knapp zusammenfasst. Antworte auf Deutsch in 3–6 Bulletpoints. Hebe konkrete Aufgaben, Termine, Zahlen und Entscheidungen hervor.",
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
  const file = fileInput.files[0];
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
apiKeyInput.addEventListener("input", updateRunState);
fileInput.addEventListener("change", updateRunState);
runBtn.addEventListener("click", run);
copyTranscriptBtn.addEventListener("click", () => copyToClipboard(transcriptArea.value, copyTranscriptBtn));
copySummaryBtn.addEventListener("click", () => copyToClipboard(summaryDiv.textContent, copySummaryBtn));

loadKey();
