# Transkriptions-App

Web-App: Audio-Datei hochladen → automatische Transkription via OpenAI Whisper → KI-Zusammenfassung.

## Live

https://walterkralle-bit.github.io/Transkription/

## Setup

1. Eigenen OpenAI API-Key bei [platform.openai.com](https://platform.openai.com/api-keys) erstellen.
2. Auf der Seite den Key einfügen → "Speichern" (wird nur lokal im Browser gespeichert).
3. Audio-Datei auswählen → "Transkribieren & Zusammenfassen".

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
