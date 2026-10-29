import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { PoseWorkerRequest, PoseWorkerResponse } from './pose-types';

// Keep the application's DOM TypeScript library; only use this worker's actual API.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<PoseWorkerRequest>) => void) | null;
  postMessage(message: PoseWorkerResponse): void;
  import?: (url: string) => Promise<unknown>;
};

// MediaPipe's loader calls this documented-in-runtime hook when importScripts
// is unavailable in a module worker. prepare-assets produces an ESM-compatible
// sibling of each unchanged upstream loader, publishing its ModuleFactory.
scope.import = async (url: string): Promise<unknown> => import(/* @vite-ignore */ `${url}.mjs`);

let landmarker: PoseLandmarker | null = null;
let initializing = false;

scope.onmessage = (event): void => {
  const message = event.data;
  if (message.type === 'initialize') {
    if (initializing || landmarker) return;
    initializing = true;
    void (async () => {
      try {
        const response = await fetch(message.modelUrl);
        if (!response.ok) throw new Error('The local pose model is missing. Run npm run assets, then reload.');
        const model = new Uint8Array(await response.arrayBuffer());
        if (model.length < 1_000_000 || model[0] !== 0x50 || model[1] !== 0x4b) {
          throw new Error('The local pose model is missing or invalid. Run npm run assets with access to storage.googleapis.com, then reload.');
        }
        const fileset = await FilesetResolver.forVisionTasks(message.wasmUrl);
        landmarker = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: model, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          outputSegmentationMasks: false,
        });
        scope.postMessage({ type: 'ready' });
      } catch (error) {
        scope.postMessage({
          type: 'error',
          message: error instanceof Error ? error.message : 'Could not initialize the local pose model.',
        });
      } finally {
        initializing = false;
      }
    })();
    return;
  }

  try {
    if (!landmarker) throw new Error('The pose model is not initialized.');
    const started = performance.now();
    const result = landmarker.detectForVideo(message.bitmap, message.capturedAtPerfMs);
    scope.postMessage({
      type: 'pose',
      landmarks: (result.landmarks[0] ?? []).map((point) => ({
        x: point.x,
        y: point.y,
        z: point.z,
        visibility: point.visibility ?? 0,
      })),
      capturedAtPerfMs: message.capturedAtPerfMs,
      inferenceMs: performance.now() - started,
    });
  } catch (error) {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Pose inference failed.',
    });
  } finally {
    message.bitmap.close();
  }
};
