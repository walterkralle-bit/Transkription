# Transkriptions-App

Web-App: Audio-Datei hochladen → automatische Transkription via OpenAI Whisper → KI-Zusammenfassung.

## Live

https://walterkralle-bit.github.io/Transkription/

## Setup

1. Eigenen OpenAI API-Key bei [platform.openai.com](https://platform.openai.com/api-keys) erstellen.
2. Auf der Seite den Key einfügen → "Speichern" (wird nur lokal im Browser gespeichert).
3. Audio-Datei auswählen → "Transkribieren & Zusammenfassen".

## Lange Aufnahmen

- OpenAIs Transkriptions-Endpunkt akzeptiert höchstens 25 MB pro Datei. Die App
  verwendet deshalb für jeden API-Request ein konservatives Limit von 24 MB.
- Direkt in der App erstellte Aufnahmen werden alle 10 Minuten als eigenständige
  Audiodatei abgeschlossen und anschließend nacheinander transkribiert. Dadurch
  bleiben auch 90-minütige Aufnahmen pro Request deutlich unter dem API-Limit.
- Temporäre Netzwerkfehler, Rate Limits und 5xx-Antworten werden bis zu zweimal
  wiederholt. Eine Transkription darf pro Abschnitt fünf Minuten dauern.
- Uploads bis 250 MB werden vollständig lokal im Browser mit ffmpeg.wasm in
  20-minütige Mono-MP3-Dateien (16 kHz, 48 kbit/s) umgewandelt. So werden auch
  etwa 90 MB große bzw. 90-minütige Dateien automatisch in gültige, deutlich
  unter 25 MB große Requests zerlegt. Die Originaldatei wird nicht an einen
  weiteren Dienst übertragen.
- Für große Uploads lädt der Browser beim ersten Mal die fest versionierte
  ffmpeg.wasm-Laufzeit (ca. 32 MB) von jsDelivr; danach kann der Browser-Cache
  sie wiederverwenden. Die lokale Umwandlung kann auf Mobilgeräten einige
  Minuten dauern und benötigt zusätzlichen Arbeitsspeicher.

## Stack

- Vanilla HTML/CSS/JS (kein Build-Step)
- ffmpeg.wasm 0.12 (nur für Uploads über 24 MB)
- Whisper-1 für Transkription
- gpt-4o-mini für Zusammenfassung
- Hosted via GitHub Pages

## Lokal entwickeln

```bash
python3 -m http.server 8000
# → http://localhost:8000
```
