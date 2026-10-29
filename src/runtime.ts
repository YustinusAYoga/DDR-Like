import Dexie, { type Table } from 'dexie';
import { AudioTransport, getBeatState } from './audio';
import { CoachRenderer } from './coach';
import { generateRoutine, gradeScore, scorePose, targetPoseAt, type RoutineMove, type TargetPose } from './game';
import { PoseTracker, type PoseResult } from './pose';

export interface Hud {
  status: string;
  cameraOn: boolean;
  cameraBusy: boolean;
  tracking: string;
  renderFps: number;
  inferenceFps: number;
  inferenceMs: number;
  fileName: string;
  durationSec: number;
  positionSec: number;
  playing: boolean;
  moveName: string;
  nextMoveName: string;
  beatInBar: number;
  beatPhase: number;
  beatActive: boolean;
  score: number;
  combo: number;
  judgment: string;
  coverage: number;
  results: boolean;
  bestScore: number;
  error: string;
}

interface SavedScore {
  id?: number;
  score: number;
  track: string;
  bpm: number;
  date: number;
  judgedPoses: number;
}

interface Candidate { quality: number; coverage: number }
interface Elements { video: HTMLVideoElement; overlay: HTMLCanvasElement; coach: HTMLCanvasElement }
const JOINTS = {
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
} as const;
const CONNECTIONS = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]] as const;

/** Owns frame-rate state. React only receives small HUD snapshots at 10 Hz. */
export class DanceRuntime {
  readonly transport = new AudioTransport();
  private readonly tracker: PoseTracker;
  private coach: CoachRenderer | null = null;
  private stream: MediaStream | null = null;
  private db: Dexie | null = null;
  private scores: Table<SavedScore, number> | null = null;
  private disposed = false;
  private cameraGeneration = 0;
  private cameraBusy = false;
  private pose: PoseResult | null = null;
  private tracking = 'Camera off';
  private error = '';
  private bpm = 120;
  private offsetSec = 0;
  private latencyMs = 0;
  private color = '#b7f66b';
  private routine: RoutineMove[] = [];
  private candidates = new Map<number, Candidate>();
  private finalizedBeat = -1;
  private qualitySum = 0;
  private validJudgments = 0;
  private combo = 0;
  private judgment = 'Ready';
  private coverage = 0;
  private bestScore = 0;
  private results = false;
  private endedAtPerfMs: number | null = null;
  private lastPlayingSample: { songSec: number; perfMs: number } | null = null;
  private lastPosition = 0;
  private frameTimes: number[] = [];
  private frameId = 0;
  private lastHudAt = -Infinity;
  private readonly idleMove: RoutineMove = { id: 'wide-arms', name: 'Open wide', startBeat: 0, durationBeats: 4, energy: 0.5 };

  constructor(private readonly elements: Elements, private readonly onUpdate: (hud: Hud) => void) {
    this.tracker = new PoseTracker(frame => this.receivePose(frame), status => {
      this.tracking = status;
      if (status.startsWith('Tracking unavailable:')) this.error = status;
    });
    try { this.coach = new CoachRenderer(elements.coach); }
    catch { this.error = 'The 3D coach needs WebGL. Try enabling hardware acceleration in your browser.'; }
    this.openStorage();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.frameId = requestAnimationFrame(this.tick);
  }

  async load(file: File): Promise<void> {
    this.error = '';
    try {
      this.transport.pause();
      await this.transport.load(file);
      if (this.disposed) return;
      this.rebuildRoutine();
      this.resetRun();
    } catch (error) { this.report(error, 'Could not decode this audio file.'); }
  }

  async togglePlayback(): Promise<void> {
    if (this.disposed) return;
    this.error = '';
    if (this.transport.state.status === 'playing') {
      this.transport.pause();
      return;
    }
    if (this.transport.state.status === 'ended') {
      this.transport.seek(0);
      this.resetRun();
    }
    try { await this.transport.play(); }
    catch (error) { this.report(error, 'Audio playback could not start.'); }
  }

  restart(): void {
    this.transport.pause();
    this.transport.seek(0);
    this.resetRun();
  }

  /** A scrub starts a fresh scored attempt at the selected position. */
  seek(seconds: number): void {
    if (this.disposed || !Number.isFinite(seconds)) return;
    this.transport.seek(seconds);
    this.resetRun();
  }

  setTiming(bpm: number, offsetSec: number, latencyMs: number): void {
    if (!Number.isFinite(bpm) || bpm < 40 || bpm > 240 || !Number.isFinite(offsetSec) || !Number.isFinite(latencyMs)) return;
    this.transport.pause();
    this.bpm = bpm;
    this.offsetSec = Math.max(-10, Math.min(30, offsetSec));
    this.latencyMs = Math.max(-500, Math.min(500, latencyMs));
    this.rebuildRoutine();
    this.resetRun();
  }

  setColor(color: string): void {
    if (/^#[0-9a-f]{6}$/i.test(color)) this.color = color;
  }

  async toggleCamera(): Promise<void> {
    if (this.disposed) return;
    if (this.stream || this.cameraBusy) {
      this.stopCamera();
      return;
    }
    const generation = ++this.cameraGeneration;
    this.cameraBusy = true;
    this.error = '';
    this.tracking = 'Requesting camera…';
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera access requires HTTPS or localhost and a supported browser.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, facingMode: 'user' },
        audio: false,
      });
      if (generation !== this.cameraGeneration || this.disposed) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      this.stream = stream;
      for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', () => {
          if (this.stream === stream && !this.disposed) {
            this.stopCamera();
            this.error = 'The camera disconnected. Reconnect it and enable the camera again.';
          }
        });
      }
      this.elements.video.srcObject = stream;
      await this.elements.video.play();
      if (generation !== this.cameraGeneration || this.disposed) return;
      await this.tracker.start(this.elements.video);
      if (generation !== this.cameraGeneration || this.disposed) return;
    } catch (error) {
      if (generation !== this.cameraGeneration || this.disposed) return;
      this.stopCamera();
      this.report(error, 'Camera access failed. Check permissions and try again.');
    } finally {
      if (generation === this.cameraGeneration) this.cameraBusy = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.stopCamera();
    this.tracker.dispose();
    this.transport.dispose();
    this.coach?.dispose();
    this.db?.close();
  }

  private readonly onVisibility = (): void => {
    if (document.hidden) this.transport.pause();
  };

  private stopCamera(): void {
    ++this.cameraGeneration;
    this.tracker.stop();
    const stream = this.stream;
    this.stream = null;
    stream?.getTracks().forEach(track => track.stop());
    this.elements.video.srcObject = null;
    this.cameraBusy = false;
    this.pose = null;
    this.coverage = 0;
    this.tracking = 'Camera off';
  }

  private rebuildRoutine(): void {
    this.routine = generateRoutine(this.transport.state.durationSec, this.bpm, this.offsetSec, this.transport.getEnergyEnvelope());
  }

  private resetRun(): void {
    this.candidates.clear();
    this.qualitySum = 0;
    this.validJudgments = 0;
    this.combo = 0;
    this.judgment = 'Ready';
    this.results = false;
    this.endedAtPerfMs = null;
    this.lastPlayingSample = null;
    this.lastPosition = this.transport.state.positionSec;
    // A reset after a seek starts evaluating only upcoming key poses.
    this.finalizedBeat = Math.floor((this.lastPosition - this.offsetSec) * this.bpm / 60 - 0.5);
    this.finalizedBeat = Math.max(-1, this.finalizedBeat);
  }

  private moveAt(beat: number): RoutineMove {
    const index = Math.max(0, Math.floor(beat / 4));
    return this.routine[index] ?? this.routine[this.routine.length - 1] ?? this.idleMove;
  }

  private receivePose(frame: PoseResult): void {
    if (this.disposed || !this.stream) return;
    this.pose = frame;
    const now = performance.now();
    if (now - frame.capturedAtPerfMs > 300) {
      this.tracking = 'Tracking delayed — improve lighting or reduce other apps';
      return;
    }
    const player = this.playerPose(frame);
    const state = this.transport.state;
    const endedAt = state.status === 'ended' ? this.playbackEndTime(now) : null;
    const capturedSongSec = state.status === 'ended'
      ? state.durationSec - ((endedAt ?? now) - frame.capturedAtPerfMs + this.latencyMs) / 1000
      : state.positionSec - (now - frame.capturedAtPerfMs + this.latencyMs) / 1000;
    const beatPosition = (capturedSongSec - this.offsetSec) * this.bpm / 60;
    const comparison = scorePose(targetPoseAt(this.moveAt(Math.max(0, beatPosition)), Math.max(0, beatPosition)), player);
    this.coverage = comparison.coverage;
    const fullFrame = Object.values(JOINTS).every(index => {
      const point = frame.landmarks[index];
      return point && point.visibility >= 0.6 && point.x > 0.02 && point.x < 0.98 && point.y > 0.02 && point.y < 0.98;
    });
    this.tracking = fullFrame ? 'Full body in frame' : 'Step back until shoulders, wrists, and ankles are visible';
    const acceptingFinalInference = endedAt !== null && !this.results && now - endedAt <= 500;
    if ((state.status !== 'playing' && !acceptingFinalInference) || !fullFrame) return;

    // Key poses fall halfway into beats, avoiding phrase-neutral boundaries.
    const beatIndex = Math.round(beatPosition - 0.5);
    const targetSongSec = this.offsetSec + (beatIndex + 0.5) * 60 / this.bpm;
    const timingError = Math.abs(capturedSongSec - targetSongSec);
    if (beatIndex < 0 || beatIndex <= this.finalizedBeat || targetSongSec >= state.durationSec || timingError > 0.15) return;
    const matched = scorePose(targetPoseAt(this.moveAt(beatIndex + 0.5), beatIndex + 0.5), player);
    if (matched.similarity === null) return;
    const quality = matched.similarity * (1 - 0.15 * timingError / 0.15);
    const previous = this.candidates.get(beatIndex);
    if (!previous || quality > previous.quality) this.candidates.set(beatIndex, { quality, coverage: matched.coverage });
  }

  private playerPose(frame: PoseResult): Partial<TargetPose> {
    const player: Partial<Record<keyof TargetPose, { x: number; y: number; confidence: number }>> = {};
    const aspect = this.elements.video.videoWidth / Math.max(1, this.elements.video.videoHeight);
    for (const [name, index] of Object.entries(JOINTS)) {
      // Reflect the picture and swap semantic sides to follow the on-screen coach.
      const swappedName = (name.startsWith('left') ? name.replace('left', 'right') : name.replace('right', 'left')) as keyof TargetPose;
      const point = frame.landmarks[index];
      if (point) player[swappedName] = { x: (1 - point.x) * aspect, y: point.y, confidence: point.visibility };
    }
    return player;
  }

  private finalizeThrough(songSec: number, complete = false): void {
    const durationSec = this.transport.state.durationSec;
    const lastKeyBeat = Math.ceil((durationSec - this.offsetSec) * this.bpm / 60 - 0.5) - 1;
    // Keep a bounded grace period so slow completed inference can still arrive.
    const dueBeat = complete ? lastKeyBeat : Math.floor((songSec - this.offsetSec - 0.65) * this.bpm / 60 - 0.5);
    const finalBeat = Math.min(lastKeyBeat, dueBeat);
    for (let beat = this.finalizedBeat + 1; beat <= finalBeat; beat += 1) {
      const candidate = this.candidates.get(beat);
      this.candidates.delete(beat);
      if (candidate) {
        this.qualitySum += candidate.quality;
        ++this.validJudgments;
        this.judgment = gradeScore(candidate.quality);
        this.combo = candidate.quality >= 0.55 ? this.combo + 1 : 0;
      } else if (this.stream) {
        this.judgment = 'Tracking';
        this.combo = 0;
      }
    }
    this.finalizedBeat = Math.max(this.finalizedBeat, finalBeat);
  }

  private score(): number {
    return this.validJudgments ? Math.round(this.qualitySum / this.validJudgments * 1_000_000) : 0;
  }

  private playbackEndTime(now: number): number {
    if (this.endedAtPerfMs === null) {
      const sample = this.lastPlayingSample;
      // Extrapolate from the last playing audio-clock sample. Inference may
      // finish after onended; its capture timestamp must retain the old clock.
      this.endedAtPerfMs = sample
        ? sample.perfMs + (this.transport.state.durationSec - sample.songSec) * 1000
        : now;
    }
    return this.endedAtPerfMs;
  }

  private readonly tick = (now: number): void => {
    if (this.disposed) return;
    const state = this.transport.state;
    if (state.positionSec + 0.05 < this.lastPosition) this.resetRun();
    this.lastPosition = state.positionSec;
    if (state.status === 'playing') this.lastPlayingSample = { songSec: state.positionSec, perfMs: now };
    const beat = getBeatState(state.positionSec, this.bpm, this.offsetSec);
    const beatPosition = beat.active ? beat.index + beat.phase : 0;
    const move = this.moveAt(beatPosition);
    const preview = state.status === 'empty';
    this.coach?.render(targetPoseAt(preview ? this.idleMove : move, preview ? 1.5 : beatPosition), beat.phase, this.color);
    this.drawOverlay(now);
    this.frameTimes.push(now);
    this.frameTimes = this.frameTimes.filter(time => now - time <= 1000);
    if (state.status === 'playing') this.finalizeThrough(state.positionSec);
    if (state.status === 'ended' && !this.results) {
      if (now - this.playbackEndTime(now) >= 500) {
        this.finalizeThrough(state.durationSec, true);
        this.results = true;
        this.saveScore();
      }
    }
    if (now - this.lastHudAt >= 100) {
      this.lastHudAt = now;
      const first = this.frameTimes[0];
      const fps = first !== undefined && now > first ? (this.frameTimes.length - 1) * 1000 / (now - first) : 0;
      const next = this.routine[Math.max(0, Math.floor(beatPosition / 4)) + 1];
      this.onUpdate({
        status: this.results ? 'Session complete' : state.status === 'playing' ? 'Follow the coach' : state.status === 'empty' ? 'Load a track to begin' : 'Ready to dance',
        cameraOn: this.stream !== null, cameraBusy: this.cameraBusy,
        tracking: this.stream && this.pose && now - this.pose.capturedAtPerfMs > 300 ? 'Waiting for a fresh camera pose…' : this.tracking,
        renderFps: fps, inferenceFps: this.tracker.inferenceFps, inferenceMs: this.tracker.inferenceMs,
        fileName: state.fileName, durationSec: state.durationSec, positionSec: state.positionSec,
        playing: state.status === 'playing', moveName: preview ? 'Your dance coach' : move.name,
        nextMoveName: next?.name ?? 'Finish strong', beatInBar: beat.beatInBar, beatPhase: beat.phase,
        beatActive: beat.active && state.status === 'playing', score: this.score(), combo: this.combo,
        judgment: this.judgment, coverage: this.coverage, results: this.results, bestScore: this.bestScore, error: this.error,
      });
    }
    this.frameId = requestAnimationFrame(this.tick);
  };

  private drawOverlay(now: number): void {
    const canvas = this.elements.overlay;
    const context = canvas.getContext('2d');
    if (!context) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const width = Math.round(canvas.clientWidth * dpr);
    const height = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    context.clearRect(0, 0, width, height);
    const pose = this.pose;
    if (!pose || now - pose.capturedAtPerfMs > 300) return;
    const video = this.elements.video;
    const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
    const imageWidth = video.videoWidth * scale;
    const imageHeight = video.videoHeight * scale;
    const left = (width - imageWidth) / 2;
    const top = (height - imageHeight) / 2;
    context.lineWidth = 3 * dpr;
    context.strokeStyle = '#b7f66b';
    for (const [a, b] of CONNECTIONS) {
      const first = pose.landmarks[a];
      const second = pose.landmarks[b];
      if (!first || !second || first.visibility < 0.6 || second.visibility < 0.6) continue;
      context.beginPath();
      context.moveTo(left + (1 - first.x) * imageWidth, top + first.y * imageHeight);
      context.lineTo(left + (1 - second.x) * imageWidth, top + second.y * imageHeight);
      context.stroke();
    }
    context.fillStyle = '#eaffdc';
    for (const point of pose.landmarks) {
      if (point.visibility < 0.6) continue;
      context.beginPath();
      context.arc(left + (1 - point.x) * imageWidth, top + point.y * imageHeight, 3.5 * dpr, 0, Math.PI * 2);
      context.fill();
    }
  }

  private openStorage(): void {
    try {
      this.db = new Dexie('DDRLike');
      this.db.version(1).stores({ scores: '++id,score,date' });
      this.scores = this.db.table<SavedScore, number>('scores');
      void this.scores.orderBy('score').last().then(row => {
        if (!this.disposed) this.bestScore = row?.score ?? 0;
      }).catch(() => {
        if (!this.disposed && !this.error) this.error = 'Local score storage is unavailable. You can still play.';
      });
    } catch {
      this.error = 'Local score storage is unavailable. You can still play.';
    }
  }

  private saveScore(): void {
    if (this.validJudgments === 0) return;
    const score = this.score();
    this.bestScore = Math.max(this.bestScore, score);
    void this.scores?.add({ score, track: this.transport.state.fileName, bpm: this.bpm, date: Date.now(), judgedPoses: this.validJudgments }).catch(() => {
      if (!this.disposed) this.error = 'This result could not be saved locally.';
    });
  }

  private report(error: unknown, fallback: string): void {
    this.error = error instanceof Error ? error.message : fallback;
  }
}
