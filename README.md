# Voicetool

Interactive browser app that detects musical notes as you sing — powered by [SwiftF0](https://github.com/lars76/swift-f0) running client-side via ONNX Runtime Web.

## Run locally

```bash
npm install
npm run dev
```

Open the printed localhost URL, click **Start listening**, allow the microphone, and sing.

## Play the synth

- `A W S E D F T G Y H U J K` play a chromatic octave, Ableton-style.
- `Z` / `X` move the keyboard octave down or up.
- The on-screen piano also supports mouse and touch.

## Notes

- Audio never leaves your device; inference runs in a Web Worker.
- SwiftF0 covers roughly **G1–C7** (46.875–2093.75 Hz).
- HTTPS (or `localhost`) is required for microphone access.
