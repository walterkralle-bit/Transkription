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
  verwendet deshalb ein konservatives Client-Limit von 24 MB.
- Direkt in der App erstellte Aufnahmen werden alle 10 Minuten als eigenständige
  Audiodatei abgeschlossen und anschließend nacheinander transkribiert. Dadurch
  bleiben auch 90-minütige Aufnahmen pro Request deutlich unter dem API-Limit.
- Temporäre Netzwerkfehler, Rate Limits und 5xx-Antworten werden bis zu zweimal
  wiederholt. Eine Transkription darf pro Abschnitt fünf Minuten dauern.
- Bereits vorhandene Upload-Dateien über 24 MB können im Browser nicht sicher an
  beliebigen Byte-Grenzen geteilt werden (MP4/WebM-Fragmente wären oft ungültig).
  Sie müssen vor dem Upload komprimiert oder in gültige Audiodateien geteilt werden.

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
