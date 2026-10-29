import type { PoseResult, PoseWorkerRequest, PoseWorkerResponse } from './pose-types';

export type { PoseResult, PoseLandmark } from './pose-types';

/** One worker, one inference in flight, and no frame queue. Owns no camera tracks. */
export class PoseTracker {
  private worker: Worker | null = null;
  private video: HTMLVideoElement | null = null;
  private generation = 0;
  private frameRequest: number | null = null;
  private frameRequestIsVideo = false;
  private busy = false;
  private lastVideoTime = -1;
  private samples: number[] = [];
  private latestInferenceMs = 0;
  private rejectInitialization: ((reason: Error) => void) | null = null;

  constructor(
    private readonly onFrame: (frame: PoseResult) => void,
    private readonly onStatus: (status: string) => void,
  ) {}

  get inferenceFps(): number {
    const now = performance.now();
    const samples = this.samples.filter((time) => now - time < 1500);
    if (samples.length < 2) return 0;
    return ((samples.length - 1) * 1000) / (samples[samples.length - 1]! - samples[0]!);
  }

  get inferenceMs(): number {
    return this.latestInferenceMs;
  }

  async start(video: HTMLVideoElement): Promise<void> {
    this.stop();
    if (typeof Worker === 'undefined' || typeof createImageBitmap === 'undefined') {
      throw new Error('This browser does not support worker-based camera tracking. Try current Chrome, Edge, or Firefox.');
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      throw new Error('Start the webcam before enabling pose tracking.');
    }

    this.video = video;
    const generation = this.generation;
    const worker = new Worker(new URL('./pose.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    this.onStatus('Loading pose model…');

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          this.rejectInitialization = null;
          reject(new Error('Pose model initialization timed out. Check that the local model assets are installed.'));
        }, 45_000);
        const fail = (error: Error): void => {
          window.clearTimeout(timeout);
          this.rejectInitialization = null;
          reject(error);
        };
        this.rejectInitialization = fail;
        worker.onerror = (event): void => {
          const error = new Error(event.message || 'The pose worker failed to start.');
          if (this.rejectInitialization) fail(error);
          else this.fail(error.message);
        };
        worker.onmessageerror = (): void => {
          const error = new Error('The browser could not transfer a camera frame to the pose worker.');
          if (this.rejectInitialization) fail(error);
          else this.fail(error.message);
        };
        worker.onmessage = (event: MessageEvent<PoseWorkerResponse>): void => {
          if (generation !== this.generation) return;
          const message = event.data;
          if (message.type === 'ready') {
            window.clearTimeout(timeout);
            this.rejectInitialization = null;
            resolve();
          } else if (message.type === 'error') {
            if (this.rejectInitialization) fail(new Error(message.message));
            else this.fail(message.message);
          } else {
            this.busy = false;
            const now = performance.now();
            this.samples.push(now);
            this.samples = this.samples.filter((time) => now - time < 1500);
            this.latestInferenceMs = message.inferenceMs;
            this.onFrame({
              landmarks: message.landmarks,
              capturedAtPerfMs: message.capturedAtPerfMs,
              completedAtPerfMs: now,
            });
          }
        };
        const base = new URL(import.meta.env.BASE_URL, window.location.href);
        const message: PoseWorkerRequest = {
          type: 'initialize',
          wasmUrl: new URL('wasm', base).href,
          modelUrl: new URL('models/pose_landmarker_lite.task', base).href,
        };
        worker.postMessage(message);
      });
    } catch (error) {
      if (generation === this.generation) this.stop();
      throw error;
    }

    if (generation !== this.generation) return;
    this.onStatus('Tracking');
    this.scheduleFrame(generation);
  }

  stop(): void {
    this.generation += 1;
    if (this.frameRequest !== null && this.video) {
      if (this.frameRequestIsVideo) this.video.cancelVideoFrameCallback(this.frameRequest);
      else cancelAnimationFrame(this.frameRequest);
    }
    this.frameRequest = null;
    this.rejectInitialization?.(new Error('Pose tracking initialization was cancelled.'));
    this.rejectInitialization = null;
    this.worker?.terminate();
    this.worker = null;
    this.video = null;
    this.busy = false;
    this.lastVideoTime = -1;
    this.samples = [];
    this.latestInferenceMs = 0;
  }

  dispose(): void {
    this.stop();
  }

  private fail(message: string): void {
    this.stop();
    this.onStatus(`Tracking unavailable: ${message}`);
  }

  private scheduleFrame(generation: number): void {
    const video = this.video;
    if (!video || generation !== this.generation) return;

    if (typeof video.requestVideoFrameCallback === 'function') {
      this.frameRequestIsVideo = true;
      this.frameRequest = video.requestVideoFrameCallback((now, metadata) => {
        this.frameRequest = null;
        const capture = (metadata as VideoFrameCallbackMetadata & { captureTime?: number }).captureTime;
        this.captureFrame(generation, capture ?? metadata.presentationTime ?? now);
        this.scheduleFrame(generation);
      });
    } else {
      this.frameRequestIsVideo = false;
      this.frameRequest = requestAnimationFrame((now) => {
        this.frameRequest = null;
        if (video.currentTime !== this.lastVideoTime) {
          this.lastVideoTime = video.currentTime;
          this.captureFrame(generation, now);
        }
        this.scheduleFrame(generation);
      });
    }
  }

  private captureFrame(generation: number, capturedAtPerfMs: number): void {
    const video = this.video;
    if (this.busy || !video || !this.worker || video.videoWidth === 0 || video.videoHeight === 0) return;
    this.busy = true;
    const width = Math.min(video.videoWidth, 640);
    const height = Math.max(1, Math.round(video.videoHeight * (width / video.videoWidth)));
    void createImageBitmap(video, { resizeWidth: width, resizeHeight: height }).then((bitmap) => {
      if (generation !== this.generation || !this.worker) {
        bitmap.close();
        return;
      }
      const request: PoseWorkerRequest = { type: 'frame', bitmap, capturedAtPerfMs };
      try {
        this.worker.postMessage(request, [bitmap]);
      } catch (error) {
        bitmap.close();
        this.fail(error instanceof Error ? error.message : 'Could not transfer a camera frame.');
      }
    }).catch((error: unknown) => {
      if (generation === this.generation) {
        this.fail(error instanceof Error ? error.message : 'Could not capture a camera frame.');
      }
    });
  }
}
