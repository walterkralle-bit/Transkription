# Transkriptions-App

Web-App: Audio-Datei hochladen → automatische Transkription via OpenAI Whisper → KI-Zusammenfassung.

## Live

https://walterkralle-bit.github.io/Transkription/

## Setup

1. Eigenen OpenAI API-Key bei [platform.openai.com](https://platform.openai.com/api-keys) erstellen.
2. Auf der Seite den Key einfügen → "Speichern" (wird nur lokal im Browser gespeichert).
3. Audio-Datei auswählen → "Transkribieren & Zusammenfassen".

## Lange Aufnahmen und große Uploads

OpenAIs Transkriptions-Endpunkt akzeptiert höchstens 25 MB pro Datei. Die App
verwendet deshalb ein konservatives Limit von 24 MB je Request.

- Direkt in der App erstellte Aufnahmen werden alle 10 Minuten als eigenständige
  Audiodatei abgeschlossen.
- Importierte Audiodateien werden bis einschließlich **5 Stunden** unterstützt.
  Die frühere Begrenzung auf 250 MB entfällt, auch mehrgigabytegroße WAV-Dateien
  können ausgewählt werden. Die Laufzeit wird vor der Transkription geprüft.
- Die Originaldatei wird über FFmpegs WORKERFS direkt dateibasiert gelesen und
  nicht vollständig in den WebAssembly-Arbeitsspeicher kopiert. Es wird jeweils
  nur ein eigenständiger Zehn-Minuten-Abschnitt als Mono-PCM-WAV (16 kHz, 16 Bit)
  erzeugt. Ein voller Abschnitt ist ca. 19,2 MB groß, unter dem API-Limit.
- Nach jedem Abschnitt wird die temporäre WAV-Datei freigegeben. Die Transkripte
  werden in zeitlicher Reihenfolge zusammengefügt; fünf Stunden ergeben 30
  Requests. Es findet kein Byte-Slicing komprimierter Container statt.
- Bereits fertig transkribierte Abschnitte bleiben bei einem späteren Fehler in
  der Oberfläche sichtbar und kopierbar.
- Dateien ohne Laufzeitmetadaten, beispielsweise manche WebM-Aufnahmen, werden
  zunächst ohne Ausgabe einer kompletten WAV-Datei geprüft. Sehr lange Importe
  können entsprechend Zeit benötigen; die Seite muss geöffnet bleiben.
- Temporäre API-Netzwerkfehler, Rate Limits und 5xx-Antworten werden bis zu
  zweimal wiederholt. Pro API-Abschnitt gilt ein Timeout von fünf Minuten;
  lokale Dauerprüfung bzw. einzelne Konvertierung haben maximal 30 Minuten.

### Formate und Browser-Verarbeitung

Unterstützte Importformate: MP3, M4A/MP4 (AAC), WAV, WebM/Opus, Ogg/Opus und
FLAC, abhängig von den im FFmpeg-Core verfügbaren Codecs. Nicht dekodierbare
Dateien erhalten eine Fehlermeldung mit Format-Hinweis. Dateien über fünf Stunden
werden mit einem konkreten Hinweis zur Laufzeit abgelehnt.

Der Single-Thread-FFmpeg-Core (Version 0.12.10, ca. 32 MB) wird bei Dateiimporten
von jsDelivr geladen und per SHA-256 geprüft. Der JS-Wrapper `@ffmpeg/ffmpeg`
0.12.15 liegt unter `vendor/ffmpeg/`. Die Konvertierung läuft in einem Web Worker.
Der Spitzenbedarf für Audiodaten hängt von einem Abschnitt und dem Decoder ab,
nicht von allen erzeugten WAV-Dateien oder einer vollständigen PCM-Aufnahme.
Die In-App-Aufnahme verwendet weiterhin ihr bisheriges Aufnahmeverfahren.

**Datenschutz:** Die Originaldatei bleibt im Browser. Sie wird weder an jsDelivr
noch an einen eigenen Server übertragen. Erst die erzeugten Audioabschnitte gehen
sequenziell direkt vom Browser an `api.openai.com`. Der API-Key bleibt wie bisher
im lokalen `localStorage` und wird nur im Authorization-Header an OpenAI verwendet.

## Stack

- Vanilla HTML/CSS/JS (kein Build-Step)
- Whisper-1 für Transkription
- gpt-4o-mini für Zusammenfassung
- Hosted via GitHub Pages

## Lokal entwickeln

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

## Validierung langer Importe

`npm test` prüft unter anderem die Fünf-Stunden-Grenze, 30 sequenzielle Abschnitte,
Dateien über 3 GB, die Freigabe temporärer Daten und fehlende Laufzeitmetadaten.
Wenn native `ffmpeg` und `ffprobe` verfügbar sind, prüft ein Integrationstest den
Anfang und das Ende einer echten fünfstündigen 48-kHz-Stereo-WAV-Datei. Sie wird
als temporäre Sparse-Datei erzeugt und anschließend gelöscht. `npm run check`
prüft zusätzlich die JavaScript-Syntax.
