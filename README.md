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
- Bereits vorhandene Dateien über 24 MB werden **vor dem Upload im Browser** mit
  FFmpeg WebAssembly dekodiert und als Mono-PCM (16 kHz, 16 Bit) in eigenständige
  10-Minuten-WAV-Dateien re-enkodiert. Ein voller Abschnitt ist ca. 19,2 MB groß.
  Es findet ausdrücklich kein Byte-Slicing von MP4-, WebM- oder anderen Containern
  statt.
- Die erzeugten Abschnitte werden einzeln aus dem WebAssembly-Dateisystem gelesen,
  sequenziell an OpenAI übertragen und danach sofort aus dem Arbeitsspeicher
  entfernt. Die Transkripte werden in zeitlicher Reihenfolge zusammengefügt.
- Während Laden, Konvertieren und Transkribieren zeigt die Oberfläche Phase und
  Fortschritt. Temporäre Netzwerkfehler, Rate Limits und 5xx-Antworten werden bis
  zu zweimal wiederholt; pro Transkriptionsabschnitt gilt ein Timeout von fünf
  Minuten, für die lokale Konvertierung 30 Minuten.

### Formate, Ressourcen und Fallback

FFmpeg dekodiert die üblichen Browser-Aufnahmeformate MP3, M4A/MP4 (AAC), WAV,
WebM/Opus, Ogg/Opus und FLAC. Welche seltenen Codecs tatsächlich verfügbar sind,
hängt vom FFmpeg-Core ab. Kann eine Datei nicht dekodiert werden, nennt die App die
unterstützten Formate und empfiehlt einen Export als MP3 oder M4A.

Der Single-Thread-FFmpeg-Core (Version 0.12.10, ca. 32 MB) wird nur für große
Uploads von jsDelivr geladen und per SHA-256 geprüft. Der kleine JS-Wrapper
`@ffmpeg/ffmpeg` 0.12.15 liegt versioniert unter `vendor/ffmpeg/`. Die Verarbeitung
läuft in einem Web Worker. Input und erzeugte Dateien belegen vorübergehend
Browser-Arbeitsspeicher; deshalb gilt eine Obergrenze von 250 MB. Bei 90-MB-Dateien
sollten andere speicherintensive Tabs geschlossen bleiben. Das ist speichersparender
als das vollständige Dekodieren einer 60–90-minütigen Datei in ein Web-Audio-`AudioBuffer`.

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
