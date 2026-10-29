# DDR/LIKE

A local-first browser dance-game prototype in strict TypeScript. Load your music, follow a procedural 3D coach, and use a webcam to compare your movement with the routine.

## Included

- React controls and a separate imperative Three.js render loop; HUD snapshots update at 10 Hz.
- A procedural mannequin with four standing moves: step touch, side reach, reach high, and open wide. Coach colors are customizable.
- MediaPipe Pose Landmarker Lite in a CPU/WASM worker, a mirrored webcam skeleton, full-body framing feedback, render FPS, inference FPS, and inference duration.
- Local audio decoding and Web Audio clock-based playback, pause/resume, seek, and restart.
- Manual BPM, first-beat offset, and timing correction; a four-beat indicator and deterministic routines selected from coarse track-relative energy.
- Confidence-gated key-pose judgments, combo feedback, final scores, and a browser-local personal best using Dexie/IndexedDB.

This is an early prototype. It does not include VRM avatars, clothing meshes, automatic BPM/downbeat/section detection, hardware latency measurement, or a full calibration flow. Energy analysis uses subsampled RMS from the first audio channel; it is a loudness envelope, not musical section recognition.

## Run locally

Requirements: Node.js **22.12 or newer**, npm, and `curl` for the initial model download.

```sh
./setup.sh
./run.sh
```

Run setup once (and after dependency changes); it installs locked dependencies and downloads the local pose assets. Run `./run.sh` for subsequent sessions; press Ctrl+C to stop. Both scripts work from any working directory on macOS/Linux with Bash. If model download fails, allow `storage.googleapis.com` and rerun setup; the run script still permits camera-free practice.

Alternatively, use `npm run setup` and `npm start` directly, including on Windows with Node.js, npm, and curl installed. To choose a port, use `./run.sh --port 3000` or `npm start -- --port 3000`.

Open the local address printed by Vite. Webcam access requires a secure context: localhost during development or HTTPS when hosted. Camera permission is requested only after clicking **Enable camera**.

`npm run assets` copies WASM assets from the pinned `@mediapipe/tasks-vision` package and downloads the official Lite model over verified HTTPS from:

```text
storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task
```

Allow `storage.googleapis.com` through any environment network policy. Dependency installation also requires npm registry access. No API key or other secret is needed. Keep the inherited proxy and CA settings; do not disable TLS verification. Generated assets belong in `public/wasm` and `public/models` and are served from the app's own origin. They are not committed to Git. Rerun `npm run assets` after installing dependencies in a fresh checkout.

## How to play

1. Load an MP3, WAV, or OGG file you have permission to use. Actual codec support depends on your browser. Unsupported or malformed files produce a decode error.
2. Set the track's BPM and the offset, in seconds, of its first beat. The prototype assumes a 4/4 grid with fixed tempo. Use the four beat dots to check alignment by ear.
3. Enable the camera. Step back until shoulders, wrists, hips, knees, and ankles are visible, with good lighting and room to move.
4. Press play and mirror the coach. Audio and the coach work without a camera; scores require reliable full-body tracking.
5. Pause before adjusting timing. Positive **Timing correction** compares a captured pose with an earlier point in the song; negative values compare it later. This is a manual combined offset, not a measurement of Bluetooth or camera latency.
6. Let the song finish to save a result locally. Restart resets the current run. Switching away from the tab pauses playback.

Files are limited to **50 MiB** and **10 minutes**. Duration is checked after decoding, so unusually compressed files can still cause a temporary memory spike. No audio file is persisted by the app.

### Scoring limits

The prototype compares 2D limb directions and joint angles at key poses halfway into each beat, within a ±150 ms window. Reliable upper- and lower-body coverage is required. Tracking failures show a tracking warning rather than a dance judgment. Valid pose similarity produces Perfect, Good, OK, or Miss feedback.

The displayed score is average valid pose quality scaled to 1,000,000. Missing tracking is excluded, so this score is for experimentation and is not a competitive ranking. The personal best is global to this browser, rather than grouped by song or difficulty. Camera perspective, body proportions, lighting, and occlusion still affect results.

## Validate and build

```sh
npm test
npm run build
npm run preview
```

The build writes a static site to `dist`; serve that directory over HTTPS for a hosted installation. Unit tests cover the audio transport, beat grid, choreography, and pose comparison. The GitHub Actions workflow runs asset preparation, unit tests, and the production build.

Browser smoke tests use Playwright:

```sh
npm run test:browser
```

The browser configuration defaults to `/usr/bin/chromium`; set `CHROMIUM_PATH` to another Chromium executable if needed. To use Playwright's downloaded browser:

```sh
npx playwright install --with-deps chromium
CHROMIUM_PATH="$(node --input-type=module -e 'import { chromium } from "@playwright/test"; console.log(chromium.executablePath())')" npm run test:browser
```

Browser tests use fake media devices and software rendering. They do not establish real-camera accuracy, browser parity, or sustained laptop performance. Desktop Chrome, Edge, and Firefox are the intended targets; benchmark your actual machine. Neither 60 FPS rendering nor 25–30 FPS inference is guaranteed, and Firefox is not covered by the Chromium smoke-test configuration.

## Privacy and storage

Camera frames, audio, inference, and scoring stay on the device. The app has no backend, telemetry, or runtime CDN requests. Model and WASM requests go to the app's own origin; first-time setup downloads dependencies and the model. Browser permissions and normal hosting request logs still apply.

IndexedDB stores score metadata, including track filename, BPM, and date. Clearing site data removes local scores. The app remains playable if storage is unavailable, but saving results will fail visibly. Offline hosting is possible after assets have been prepared; an offline reload is not guaranteed because no service worker is included.

## Code map

| File | Responsibility |
| --- | --- |
| `src/App.tsx` | React controls and HUD |
| `src/runtime.ts` | Frame loop, capture-time scoring, session lifecycle, IndexedDB |
| `src/audio.ts` | Audio-clock transport, beat grid, coarse energy envelope |
| `src/pose.ts`, `src/pose.worker.ts` | Camera frame scheduling and local pose inference |
| `src/game.ts` | Four-move library, choreography, target poses, similarity |
| `src/coach.ts` | Procedural Three.js mannequin |
| `scripts/prepare-assets.mjs` | Self-hosted model/WASM preparation |

## Rights and licensing

Uploading a file locally does not grant rights to redistribute its music or publish recordings containing it. Supply music you are authorized to use. Review the licenses and notices for MediaPipe models, dependencies, and any future animation or avatar assets before distribution. This repository does not declare an application source-code license; do not infer one from dependency licenses.
