export interface PoseLandmark {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly visibility: number;
}

export interface PoseResult {
  readonly landmarks: readonly PoseLandmark[];
  /** Best available frame timestamp in the main thread's performance.now() domain.
   * This is a presentation estimate when captureTime metadata is unavailable;
   * it does not measure camera exposure or driver buffering latency.
   */
  readonly capturedAtPerfMs: number;
  readonly completedAtPerfMs: number;
}

export type PoseWorkerRequest =
  | { readonly type: 'initialize'; readonly wasmUrl: string; readonly modelUrl: string }
  | { readonly type: 'frame'; readonly bitmap: ImageBitmap; readonly capturedAtPerfMs: number };

export type PoseWorkerResponse =
  | { readonly type: 'ready' }
  | { readonly type: 'error'; readonly message: string }
  | {
      readonly type: 'pose';
      readonly landmarks: readonly PoseLandmark[];
      readonly capturedAtPerfMs: number;
      readonly inferenceMs: number;
    };
