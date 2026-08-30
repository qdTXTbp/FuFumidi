# FuFumidi

<p align="center">
  <img src="docs/EN.png" alt="FuFumidi project logo" />
</p>

<p align="center"><strong>English</strong> | <a href="README-CN.md">中文</a></p>

[About](#about) | [Features](#features) | [Transcriber](#transcriber) | [Editor](#editor) | [Playback](#playback-and-visualization) | [Analysis](#analysis) | [Score](#score) | [Conversion](#conversion-and-video-export) | [Film Scoring](#film-scoring) | [Offline Runtime](#offline-runtime) | [Architecture](#architecture) | [Layout](#repository-layout) | [Getting Started](#getting-started) | [Building](#building-and-packaging) | [Testing](#testing) | [Plugins](#plugins) | [CI](#continuous-integration) | [Credits](#credits) | [License](#license)

---

## About

FuFumidi is a fully offline desktop workstation for MIDI. It targets musicians, arrangers, transcriptionists and film composers who need a single tool that can go from raw audio to a clean, editable, publishable MIDI/score asset without ever leaving the machine.

The application is packaged as a classic Electron desktop app with a modern Vue 3 + TypeScript renderer, a bundled Python transcriber/runtime, and an optional Rust core. All audio, model weights and inference execute locally. Nothing is uploaded.

Current release line: **3.1.16**.

### What it does

- **Audio to MIDI** using three interchangeable local engines (universal, piano-specialized, voice-separated).
- **MIDI editor** with a full piano-roll, CC automation lanes, drums, macros, a logic editor and a list editor.
- **Playback and visualization** with a Synthesia-style waterfall, spectrum, waveform, real-time chord reading and MIDI hardware output.
- **Analysis** that produces key, chord, density and statistical summaries of a song.
- **Score engraving** through Verovio, with automatic clefs and octaves, MusicXML import, and PDF export.
- **Conversion and video export** that renders MIDI back to audio (WAV / MP3 / OGG) or to MP4 with synchronized visualization.
- **Film scoring** support: SMPTE timecode, embedded video track, and two-way clicking between score and piano-roll.

### Highlights

- 100% offline after installation. Python runtime, transcription models and Demucs vocal-separation weights ship inside the full installer.
- Vue 3 + TypeScript + Vite renderer, rebuilt from the original monolithic renderer.
- 11 hash-routed views, in-app i18n, 10 built-in themes plus image-based custom theme generation, `Ctrl+K` command palette, onboarding guide, theme library and dynamic wallpaper gallery.
- Plugin sandbox that runs third-party code inside its own worker.
- Integrity check and one-click repair for the bundled runtime.
- Optional Rust core (`src-tauri/`) for performance-critical paths.
- GPU acceleration options for CUDA and DirectML, with a graceful fallback to CPU.

---

## Features

A short map of the main views. Each view is reachable from the sidebar or via the command palette.

| View | Purpose |
| --- | --- |
| Home | Playlist, recent files, quick actions. |
| Play | Transport, tempo, MIDI output device, mixer. |
| Lyrics | LRC editor with encoding detection and batch replace. |
| Edit | Piano-roll editor (see below). |
| Visualize | Real-time waterfall, spectrum, scope, chord overlay. |
| Analyze | Key, chord, density and statistical reports. |
| Score | Verovio score view and PDF export. |
| Transcribe | Audio to MIDI (see below). |
| Convert | MIDI to audio and MIDI to video. |
| Resources | Model, soundfont and asset management. |
| Settings | Appearance, engine, plugins, keyboard shortcuts, i18n. |

---

## Transcriber

The transcriber supports three modes and multiple sub-models. Every mode runs against the bundled Python runtime, and every model is bundled or resolved locally.

| Mode | Sub-models | What it is good for |
| --- | --- | --- |
| Universal | `basic-pitch` (ONNX int8), `MuScriptor` (small / medium / large) | Broad polyphonic material, mixing instruments. |
| Piano | `piano_pt`, `aria`, `transkun` | Piano recordings, including pedal detection. |
| Separate | `demucs` (htdemucs) | Vocal-first or stem-separated transcription. |

Advanced options exposed by the view include onset/frame thresholds, minimum note length, merge gap, pedal detection, drum extraction, denoising, normalization, automatic tempo detection, stem export (WAV) and a transcription queue with pause, cancel and reordering.

The engine layer is spread across a small family of Python modules so a specific transcriber can be swapped without touching the UI:

- `engine/engine.py` - front door and dispatch.
- `engine/engine_basic.py`, `engine/engine_muscriptor.py`, `engine/engine_aria.py`, `engine/engine_pt.py`, `engine/engine_transkun.py`, `engine/engine_separate.py` - per-model inference.
- `engine/engine_gpu.py` - CUDA / DirectML selection and fallback.
- `engine/smart_midi.py` - post-transcription correction and smart cleanup.
- `engine/midi_post.py`, `engine/midi_edit.py` - shared MIDI utilities used by the editor and by plugins.
- `engine/deps.py` - dependency check and auto-repair.
- `engine/diag.py` - diagnostic export for support reports.

Transcription results are validated by `engine/tests/`, which exercises the pipeline end-to-end with the fixture files `data/_test_melody.wav` and `data/_test_out.mid`.

---

## Editor

The editor is the largest single surface of the application.

- Piano roll with pencil, select and eraser tools, plus snap-to-grid from off up to 1/32.
- Undo and redo on full track snapshots, so multi-track operations can be rolled back in one step.
- Note-edge stretching for independent start and length edits.
- A velocity curve editor with envelope drawing over a selected range.
- CC automation lanes for CC1 (modulation), CC7 (velocity), CC10 (pan), CC11 (expression) and CC64 (sustain), each drawable with a freehand, line or curve brush.
- Drum editor with a 29-instrument by 8-bar grid and per-track visibility.
- Key Switch visualization and mapping, with C-2 to C0 technique names and Spitfire, VSL and EastWest presets.
- Smart quantize with Funk, Jazz, Rock, Latin and custom groove templates, plus an "extract selected as groove" workflow.
- Logic editor for batch rules (target x condition x operation).
- Macro system with built-in macros (project clean-up, batch transpose, velocity normalization) and user-defined macros that are persisted locally.
- Audio alignment tool: load the original audio, see the waveform at the bottom of the piano roll, snap note onsets within a +/-80 ms window, and audition in sync.
- Smart accompaniment that generates three tracks - bass, arpeggiated chords and pad - from a per-bar chord analysis.
- Timbre tools: GM voice picker, apply-to-all-non-drum, and smart timbre selection by range or by name.
- Batch operations: chord selection, delete short notes under 80 ms, loudness +/-10%, transpose +1 / +8 / -1 / -8 semitones.
- Lyrics injection directly from the editor onto selected notes.
- Fullscreen editing, an inspector panel, a help overlay and a `Ctrl+S` export to a native save dialog.

---

## Playback and Visualization

- Web Audio synthesis with js-synthesizer plus FluidSynth and GeneralUser.sf2 for MIDI output through the desktop.
- `navigator.requestMIDIAccess` selection of an external MIDI device; note-on / note-off events are mirrored, and an all-notes-off is sent on stop to prevent stuck notes.
- Tempo control is two-way with BPM. Changing the tempo multiplier updates the BPM field and vice versa.
- Mixer popup for volume, pan, solo and mute across tracks.
- Four visualization styles: Synthesia-style note waterfall, spectrum waterfall, oscilloscope waveform and real-time chord reading.
- Dashboard and waterfall layout toggle, plus fullscreen visualization.

---

## Analysis

The analysis view produces a report on the current song.

- Key detection and chord detection over time.
- Pitch, velocity and duration distributions.
- Timeline density (notes per bar, notes per second).
- Natural-language summary of the material, ready to paste into a brief or a caption.

The analysis engine is split between `frontend/src/core/analysis.js` (report assembly) and `engine/music2midi.py` (feature extraction used by the transcriber).

---

## Score

- Verovio-based engraving with automatic clef, 8va, 8vb and 15ma placement.
- Chord markers, lyrics and section marks.
- Score-to-piano-roll sync: click a note on the score and the playback head and piano-roll cursor move together.
- MusicXML import via `frontend/src/core/musicxml.js`, with support for multiple parts, time signatures, key signatures and ornaments.
- PDF export through `printToPDF`, and paginated SVG-to-PNG preview.
- Split preview of score and piano roll side by side.

---

## Conversion and Video Export

`ViewConvert` renders MIDI back to audio or to video.

Audio export supports WAV, MP3 and OGG, with a choice of 26 timbres (piano, electric piano, organ, strings, brass, flute, guitar, bass, lead, pad, violin, cello, harp, marimba, music box, vibraphone, choir, trumpet, sax, clarinet, oboe, nylon guitar, steel guitar, synth bass, bell, accordion, banjo) plus an auto-select mode that picks a preset per GM program number. Tempo multiplier, sample rate and gain are tunable, and a range selector lets you render the full song or a specific section.

The audio renderer is written as a bucketed offline synthesis (`renderAudioBuffer`), so a single long track does not need a single massive `OfflineAudioContext`.

Video export uses `canvas.captureStream` plus `MediaRecorder` to record the visualization canvas, then runs the captured stream through the bundled ffmpeg via the `video:transcode` bridge to produce an MP4 with the rendered audio. Available controls:

- Aspect ratio: landscape, portrait, subtitle-safe area.
- Resolution: 720p up to 4K.
- Frame rate: 24, 30, 60 fps.
- Quality preset or a custom bitrate.
- Clip length: 15 s, 30 s, 60 s, full song, or a custom range.
- Background: color or image.
- Watermark with adjustable opacity.
- Lyrics subtitles, progress bar and timecode toggles.

The visualization inside the video is one of the four styles above, so the same rendering code is reused for on-screen playback and for offline capture.

---

## Film Scoring

- SMPTE timecode display alongside the transport.
- Embedded video track with synchronized playback; the video is shown in a dock at the top-right of the editing surface.
- Click-to-locate: click a note on the score or the piano roll and the video head jumps to the corresponding timecode.

---

## Offline Runtime

- The full installer bundles the Python runtime, transcriber models and the Demucs weights. After installation the app does not need to reach the network.
- The base installer ships only the basic-pitch model and downloads additional models on first use, so it is much smaller.
- `engine/deps.py` performs a dependency check on startup and can auto-repair a broken environment.
- An integrity check runs in the background at startup and surfaces a warning banner plus a one-click repair action in the Settings view.
- A SQLite database (`main/db.js`) persists settings, playlists and plugin state locally.
- Wallpapers, video wallpapers and soundfonts ship inside the installer.

---

## Architecture

FuFumidi is a three-process application.

- **Main process** (`main.js`, `preload.js`, `main/`)
  Electron main process, IPC routing, dialogs, settings, playlist, database, updater, video transcode bridge, wallpaper service and plugin host.
- **Renderer** (`frontend/`)
  Vue 3 application built by Vite to `renderer/dist`. State is held in Pinia stores (`stores/app.ts`, `stores/playlist.ts`, `stores/settings.ts`). Views live under `views/`, reusable components under `components/`, and the audio/MIDI/analysis/scoring core lives under `core/`.
- **Python engine** (`engine/`)
  The transcriber and audio-tooling layer. Invoked through a JSON protocol so the renderer only needs a single `bridge.convert` / `bridge.engine.run` call.

Optional accelerations:

- **Rust core** (`rust-core/`, `src-tauri/`) - a Tauri v2 shell and a native library (`fufumidi_lib`) that expose performance-critical paths. Built via `npm run build:rust` and validated by `npm run test:rust`.
- **GPU runtime** (`engine/engine_gpu.py`, `main/gpu.js`, `main/gpu-ipc.js`) - selects CUDA or DirectML based on the local driver, and falls back to CPU when neither is available.
- **Plugins** (`plugins/`, `plugin-host.js`, `plugin-worker.js`) - a sandboxed extension system that runs each plugin in a dedicated worker with a scoped API.

---

## Repository Layout

```
FuFumidi/
  main.js                 Electron main entry
  preload.js              Secure bridge from renderer to main
  main/                   Main-process modules (engine, gpu, db, plugins, ...)
  frontend/               Vue 3 + TypeScript renderer
    src/
      views/              One component per app view
      components/         Reusable UI (PianoRoll, EditorCanvas, PlayerBar, ...)
      core/               MIDI, synth, player, analysis, score, viz, i18n
      stores/             Pinia stores
      bridge/             Electron bridge shims
      assets/             Logo and shared images
  renderer/               Built renderer output and vendor files (soundfonts, js-synthesizer, abcjs, verovio)
  engine/                 Python transcriber, models, ffmpeg wrapper, MIDI utilities
    tests/                Engine test suite with fixture wav/midi
  plugins/                Built-in plugins and the plugin developer guide
  src-tauri/              Tauri v2 shell for the optional Rust path
  rust-core/              Rust library used by the Tauri shell
  build/                  Icon, kachina config, installer artwork
  scripts/                Build and verification scripts
  .github/workflows/      CI pipelines
  docs/                   Language-specific README assets (EN.png, CN.png)
```

---

## Getting Started

### Prerequisites

- Windows 10 / 11, macOS 12+ or a recent Linux desktop.
- Node.js 20+ and npm.
- Python 3.11 (recommended for the separate mode) or Python 3.13 for a slimmer install. The `engine/deps.py` script can detect and repair what is missing.
- Optional: Rust toolchain (`rustc` / `cargo`) for `npm run build:rust`.
- Optional: CUDA toolkit or WSL + MSVC for GPU builds; MSVC is required for the Rust core.

### Installing

Download the installer from the releases page:

- **Full installer** - Python runtime, all transcriber models, Demucs weights. Recommended for offline use.
- **Base installer** - basic-pitch only. Additional models are downloaded on first use.

On first launch the app runs an integrity check and prompts you to repair if anything is missing.

### Running from source

```bash
cd frontend
npm install
npm run build

cd ..
npm install
npm start
```

`npm start` launches Electron against the freshly built renderer. The Python engine is resolved through the same `engine/deps.py` logic used in the installer, so point it at a Python 3.11 or 3.13 environment with the transcription dependencies installed.

---

## Building and Packaging

```bash
# Frontend
cd frontend && npm install && npm run build
cd ..

# Desktop runtime
npm install

# Full installer (Python + all models)
npm run dist:win

# Base installer (basic-pitch only)
electron-builder --config electron-builder.base.yml

# Source archive (7z -mx9)
npm run pack:source

# Rust core
npm run build:rust
```

Before running any of the installer commands, place the large binaries in the expected locations. The build scripts assume:

- `resources/` - Python runtime, `elevate.exe`, and any platform-specific helpers.
- `models/` - transcription model weights (basic-pitch, piano transcriber, Demucs).

Both `resources/` and `models/` are listed in `.gitignore` because they are large.

`engine/deps.py` can be run directly to check and repair the Python environment:

```bash
python engine/deps.py
```

---

## Testing

```bash
# Rust core
npm run test:rust

# Frontend unit tests (macro, i18n, util)
npm run test:ui

# Plugin sandbox
npm run test:plugin

# Everything
npm run test

# Frontend type check
npm run typecheck

# Engine tests
cd engine && pytest
```

`engine/tests/` covers audio I/O, engine configuration, MIDI post-processing and presets against the bundled fixtures.

---

## Plugins

FuFumidi supports plugins as third-party extensions that run without modifying the main program. A plugin is a directory with a `plugin.json` manifest and an entry script. The full developer guide is at `plugins/plugin-dev.html` and the concise index at `plugins/README.md`.

Built-in examples:

- `plugins/example-hello/` - minimal hello-world plugin.
- `plugins/beat-detect/` - beat detection against the loaded song.
- `plugins/midi-stats/` - statistics over the current MIDI file.
- `plugins/batch-rename/` - bulk renaming of imported files.

Each plugin runs in its own worker with a scoped `ctx` object that exposes `commands`, `events`, `engine.run`, `settings`, `ui`, `log` and `app.getSongMeta`. The engine is invoked through the same Python runtime as the built-in transcriber, so a plugin can call any script under `engine/`.

---

## Continuous Integration

- `.github/workflows/ci.yml` - lint and test.
- `.github/workflows/build.yml` - builds the frontend and the asar on Windows, macOS and Linux.
- `.github/workflows/build-installers.yml` - produces the platform installers.
- `.github/workflows/test-installers.yml` - installs the produced installers and runs a smoke test.

Coding conventions are documented in `.github/CODING_GUIDELINES.md`.


## License

MIT
