import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateRoutine, targetPoseAt, type TargetPose } from './game';
import type { PoseResult } from './pose-types';

const fakes = vi.hoisted(() => ({
  trackerStart: vi.fn<() => Promise<void>>(),
  trackerStop: vi.fn(),
  onPose: null as ((frame: PoseResult) => void) | null,
  media: vi.fn<() => Promise<MediaStream>>(),
  saved: vi.fn<() => Promise<number>>(),
}));

vi.mock('./pose', () => ({
  PoseTracker: class {
    inferenceFps = 30;
    inferenceMs = 20;
    constructor(onFrame: (frame: PoseResult) => void) { fakes.onPose = onFrame; }
    start = fakes.trackerStart;
    stop = fakes.trackerStop;
    dispose = vi.fn();
  },
}));
vi.mock('./coach', () => ({ CoachRenderer: class { render = vi.fn(); dispose = vi.fn(); } }));
vi.mock('dexie', () => ({
  default: class {
    version() { return { stores: vi.fn() }; }
    table() { return { orderBy: () => ({ last: async () => undefined }), add: fakes.saved }; }
    close() {}
  },
}));
vi.mock('./audio', async importOriginal => {
  const original = await importOriginal<typeof import('./audio')>();
  return {
    getBeatState: original.getBeatState,
    AudioTransport: class {
      state = { status: 'empty', durationSec: 10, positionSec: 0, fileName: '' };
      async load(file: File) { this.state = { ...this.state, status: 'ready', fileName: file.name, positionSec: 0 }; }
      async play() { this.state.status = 'playing'; }
      pause() { if (this.state.status === 'playing') this.state.status = 'paused'; }
      seek(seconds: number) { this.state.positionSec = Math.max(0, Math.min(this.state.durationSec, seconds)); }
      getEnergyEnvelope() { return [0.5]; }
      dispose() {}
    },
  };
});

import { DanceRuntime, type Hud } from './runtime';

const indices = { leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14, leftWrist: 15, rightWrist: 16, leftHip: 23, rightHip: 24, leftKnee: 25, rightKnee: 26, leftAnkle: 27, rightAnkle: 28 } as const;

function cameraFrame(target: TargetPose, capturedAtPerfMs: number, completedAtPerfMs: number): PoseResult {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  for (const [name, index] of Object.entries(indices)) {
    const swapped = (name.startsWith('left') ? name.replace('left', 'right') : name.replace('right', 'left')) as keyof TargetPose;
    const point = target[swapped];
    landmarks[index] = { x: 0.5 - (point.x - 0.5) / (16 / 9), y: point.y, z: 0, visibility: 1 };
  }
  return { landmarks, capturedAtPerfMs, completedAtPerfMs };
}

describe('DanceRuntime integration lifecycle', () => {
  let now = 0;
  let nextId = 1;
  let callbacks: Map<number, FrameRequestCallback>;
  let hud: Hud | undefined;
  let runtime: DanceRuntime;
  let video: HTMLVideoElement;
  let stop: ReturnType<typeof vi.fn>;
  let stream: MediaStream;

  function step(timestamp: number): void {
    now = timestamp;
    const batch = [...callbacks.values()];
    callbacks.clear();
    for (const callback of batch) callback(timestamp);
  }

  function audioState(): { status: string; durationSec: number; positionSec: number; fileName: string } {
    return runtime.transport.state as { status: string; durationSec: number; positionSec: number; fileName: string };
  }

  beforeEach(() => {
    now = 0;
    callbacks = new Map();
    hud = undefined;
    vi.clearAllMocks();
    fakes.trackerStart.mockResolvedValue(undefined);
    fakes.saved.mockResolvedValue(1);
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = nextId++; callbacks.set(id, callback); return id; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
    vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: fakes.media } });
    stop = vi.fn();
    const track = { stop, addEventListener: vi.fn() };
    stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
    fakes.media.mockResolvedValue(stream);
    video = { srcObject: null, videoWidth: 1280, videoHeight: 720, play: vi.fn(async () => undefined) } as unknown as HTMLVideoElement;
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
    runtime = new DanceRuntime({ video, overlay: canvas, coach: canvas }, next => { hud = next; });
  });

  afterEach(() => {
    runtime.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('releases webcam tracks if pose model initialization fails', async () => {
    fakes.trackerStart.mockRejectedValueOnce(new Error('Local pose model missing'));
    await runtime.toggleCamera();
    step(100);
    expect(stop).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
    expect(hud?.cameraOn).toBe(false);
    expect(hud?.cameraBusy).toBe(false);
    expect(hud?.error).toBe('Local pose model missing');
  });

  it('releases a permission request that resolves after disposal', async () => {
    let resolve!: (stream: MediaStream) => void;
    fakes.media.mockImplementationOnce(() => new Promise(value => { resolve = value; }));
    const pending = runtime.toggleCamera();
    runtime.dispose();
    resolve(stream);
    await pending;
    expect(stop).toHaveBeenCalledOnce();
    expect(fakes.trackerStart).not.toHaveBeenCalled();
    expect(callbacks.size).toBe(0);
  });

  it('clears score on both forward and backward seeks', async () => {
    await runtime.load({ name: 'local.wav' } as File);
    await runtime.toggleCamera();
    await runtime.togglePlayback();
    const routine = generateRoutine(10, 120, 0, [0.5]);
    now = 250;
    audioState().positionSec = 0.25;
    fakes.onPose?.(cameraFrame(targetPoseAt(routine[0], 0.5), 250, 250));
    audioState().positionSec = 1;
    step(1000);
    expect(hud?.score).toBe(1_000_000);
    runtime.seek(3);
    step(1100);
    expect(hud?.score).toBe(0);
    expect(hud?.positionSec).toBe(3);
    now = 3250;
    audioState().positionSec = 3.25;
    fakes.onPose?.(cameraFrame(targetPoseAt(routine[1], 6.5), 3250, 3250));
    audioState().positionSec = 4;
    step(4000);
    expect(hud?.score).toBe(1_000_000);
    runtime.seek(1);
    step(4100);
    expect(hud?.score).toBe(0);
    expect(hud?.positionSec).toBe(1);
  });

  it('accepts the final captured pose when inference completes after audio ends', async () => {
    audioState().durationSec = 0.4;
    await runtime.load({ name: 'short.wav' } as File);
    await runtime.toggleCamera();
    await runtime.togglePlayback();
    audioState().positionSec = 0.2;
    step(200);
    audioState().positionSec = 0.4;
    audioState().status = 'ended';
    now = 450;
    const routine = generateRoutine(0.4, 120, 0, [0.5]);
    fakes.onPose?.(cameraFrame(targetPoseAt(routine[0], 0.5), 250, 450));
    step(950);
    expect(hud?.results).toBe(true);
    expect(hud?.score).toBe(1_000_000);
    expect(fakes.saved).toHaveBeenCalledOnce();
  });

  it('matches an asymmetric pose after semantic mirroring and aspect correction', async () => {
    await runtime.load({ name: 'local.wav' } as File);
    await runtime.toggleCamera();
    await runtime.togglePlayback();
    const routine = generateRoutine(10, 120, 0, [0.5]);
    // Phrase three is side-reach, whose arm directions differ by side.
    runtime.seek(4);
    now = 4250;
    audioState().positionSec = 4.25;
    fakes.onPose?.(cameraFrame(targetPoseAt(routine[2], 8.5), 4250, 4250));
    audioState().positionSec = 5;
    step(5000);
    expect(hud?.score).toBe(1_000_000);
  });
});
