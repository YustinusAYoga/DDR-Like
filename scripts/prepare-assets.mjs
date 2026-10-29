import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const packageDirectory = dirname(require.resolve('@mediapipe/tasks-vision'));
const wasmDirectory = join(project, 'public', 'wasm');
const modelDirectory = join(project, 'public', 'models');
const modelFile = join(modelDirectory, 'pose_landmarker_lite.task');
const modelUrl = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

await mkdir(wasmDirectory, { recursive: true });
await mkdir(modelDirectory, { recursive: true });

for (const name of [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
]) {
  const destination = join(wasmDirectory, name);
  await copyFile(join(packageDirectory, 'wasm', name), destination);
  if (name.endsWith('.js')) {
    const source = await readFile(destination, 'utf8');
    // The vendor loader exposes ModuleFactory through a classic-script global.
    // Its module-worker import hook needs that same global published explicitly.
    await writeFile(`${destination}.mjs`, `${source}\n// Module-worker bridge.\nglobalThis.ModuleFactory = ModuleFactory;\n`);
  }
}
console.log('Copied pinned MediaPipe WASM assets and module-worker bridges.');

if (process.argv.includes('--wasm-only')) {
  console.log('Skipped model download (--wasm-only). Camera tracking still requires the .task model.');
  process.exit(0);
}

const exists = await stat(modelFile).then(() => true, () => false);
if (!exists) {
  const temporary = `${modelFile}.download-${process.pid}`;
  try {
    const result = spawnSync('curl', [
      '--fail', '--location', '--show-error', '--silent',
      '--connect-timeout', '20', '--max-time', '120',
      '--output', temporary, modelUrl,
    ], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      throw new Error([
        'Could not download the official pose model over verified HTTPS.',
        'Allow storage.googleapis.com in the environment network settings, then rerun npm run assets.',
        result.error?.message ?? result.stderr?.trim(),
      ].filter(Boolean).join('\n'));
    }
    const bytes = await readFile(temporary);
    if (bytes.length < 1_000_000 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      throw new Error('The model response is not the expected MediaPipe task archive; refusing to install it.');
    }
    await rename(temporary, modelFile);
  } finally {
    await rm(temporary, { force: true });
  }
}

const bytes = await readFile(modelFile);
if (bytes.length < 1_000_000 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
  throw new Error('The existing pose model is not a valid task archive. Remove it and rerun npm run assets.');
}
console.log(`Pose model ready (${bytes.length} bytes). SHA-256: ${createHash('sha256').update(bytes).digest('hex')}`);
