export type TransportStatus = 'empty' | 'ready' | 'playing' | 'paused' | 'ended';

export interface TransportState {
  readonly status: TransportStatus;
  readonly durationSec: number;
  readonly positionSec: number;
  readonly fileName: string;
}

export interface BeatState {
  readonly index: number;
  readonly beatInBar: number;
  readonly phase: number;
  readonly active: boolean;
}

/** Beat zero is the user-selected first beat. Negative offsets are supported. */
export function getBeatState(positionSec: number, bpm: number, offsetSec: number): BeatState {
  if (!Number.isFinite(positionSec) || !Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(offsetSec)) {
    return { index: 0, beatInBar: 0, phase: 0, active: false };
  }
  const beats = (positionSec - offsetSec) * bpm / 60;
  if (beats < 0) return { index: 0, beatInBar: 0, phase: 0, active: false };
  const index = Math.floor(beats);
  return { index, beatInBar: index % 4, phase: beats - index, active: true };
}

/** Local decoded-audio transport. The audio clock, never animation-frame time, drives position. */
export class AudioTransport {
  private context: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private status: TransportStatus = 'empty';
  private offsetSec = 0;
  private startedAtSec = 0;
  private fileName = '';
  private loadVersion = 0;
  private playVersion = 0;
  private disposed = false;

  constructor(private readonly createContext: () => AudioContext = () => new AudioContext()) {}

  get state(): TransportState {
    const durationSec = this.buffer?.duration ?? 0;
    const positionSec = this.status === 'playing' && this.context
      ? Math.min(durationSec, this.offsetSec + this.context.currentTime - this.startedAtSec)
      : this.offsetSec;
    return { status: this.status, durationSec, positionSec, fileName: this.fileName };
  }

  /** A failed or superseded load leaves the current track intact. */
  async load(file: File): Promise<void> {
    this.assertActive();
    if (file.size > 50 * 1024 * 1024) {
      throw new Error('Choose an audio file smaller than 50 MB.');
    }
    const version = ++this.loadVersion;
    const context = this.getContext();
    const bytes = await file.arrayBuffer();
    if (this.disposed || version !== this.loadVersion) return;
    const decoded = await context.decodeAudioData(bytes);
    if (this.disposed || version !== this.loadVersion) return;
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) {
      throw new Error('This file does not contain playable audio.');
    }
    if (decoded.duration > 600) {
      throw new Error('Choose an audio track no longer than 10 minutes.');
    }
    ++this.playVersion;
    this.stopSource();
    this.buffer = decoded;
    this.offsetSec = 0;
    this.fileName = file.name;
    this.status = 'ready';
  }

  /** Coarse track-relative loudness, sampled from channel zero; not beat or section detection. */
  getEnergyEnvelope(bins = 64): number[] {
    if (!this.buffer) return [];
    const binCount = Number.isFinite(bins) ? Math.max(1, Math.min(512, Math.floor(bins))) : 64;
    const samples = this.buffer.getChannelData(0);
    const energy = Array.from({ length: binCount }, (_, bin) => {
      const start = Math.floor(bin * samples.length / binCount);
      const end = Math.floor((bin + 1) * samples.length / binCount);
      let squaredSum = 0;
      let count = 0;
      for (let i = start; i < end; i += 32) {
        squaredSum += samples[i] * samples[i];
        ++count;
      }
      return count > 0 ? Math.sqrt(squaredSum / count) : 0;
    });
    const maximum = Math.max(...energy);
    return maximum > 0 ? energy.map((value) => value / maximum) : energy;
  }

  async play(): Promise<void> {
    this.assertActive();
    if (!this.buffer || this.status === 'playing') return;
    const version = ++this.playVersion;
    const context = this.getContext();
    await context.resume();
    if (this.disposed || version !== this.playVersion || !this.buffer) return;
    if (this.offsetSec >= this.buffer.duration) this.offsetSec = 0;
    this.startSource();
  }

  pause(): void {
    ++this.playVersion;
    if (this.status !== 'playing') return;
    this.offsetSec = this.state.positionSec;
    this.stopSource();
    this.status = this.offsetSec >= (this.buffer?.duration ?? 0) ? 'ended' : 'paused';
  }

  seek(seconds: number): void {
    this.assertActive();
    if (!this.buffer || !Number.isFinite(seconds)) return;
    const wasPlaying = this.status === 'playing';
    ++this.playVersion;
    this.stopSource();
    this.offsetSec = Math.max(0, Math.min(this.buffer.duration, seconds));
    if (this.offsetSec >= this.buffer.duration) this.status = 'ended';
    else if (wasPlaying) this.startSource();
    else this.status = this.status === 'ready' ? 'ready' : 'paused';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.loadVersion;
    ++this.playVersion;
    this.stopSource();
    const context = this.context;
    this.context = null;
    this.buffer = null;
    this.offsetSec = 0;
    this.fileName = '';
    this.status = 'empty';
    if (context) void context.close().catch(() => undefined);
  }

  private getContext(): AudioContext {
    this.context ??= this.createContext();
    return this.context;
  }

  private startSource(): void {
    const context = this.getContext();
    const buffer = this.buffer;
    if (!buffer) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      if (this.source !== source) return;
      source.disconnect();
      this.source = null;
      this.offsetSec = buffer.duration;
      this.status = 'ended';
    };
    this.startedAtSec = context.currentTime;
    source.start(this.startedAtSec, this.offsetSec);
    this.source = source;
    this.status = 'playing';
  }

  private stopSource(): void {
    if (!this.source) return;
    this.source.onended = null;
    this.source.stop();
    this.source.disconnect();
    this.source = null;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Audio transport has been disposed.');
  }
}
