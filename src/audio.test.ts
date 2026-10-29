import { describe, expect, it, vi } from 'vitest';
import { AudioTransport, getBeatState } from './audio';

class FakeSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeContext {
  currentTime = 0;
  destination = {};
  sources: FakeSource[] = [];
  resume = vi.fn(async (): Promise<void> => undefined);
  close = vi.fn(async () => undefined);
  decodeAudioData = vi.fn(async (_bytes: ArrayBuffer) => ({ duration: 10 }) as AudioBuffer);
  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }
}

function file(name = 'dance.wav', size = 8): File {
  return { name, size, arrayBuffer: async () => new ArrayBuffer(8) } as File;
}

function setup() {
  const context = new FakeContext();
  const createContext = vi.fn(() => context as unknown as AudioContext);
  const transport = new AudioTransport(createContext);
  return { context, createContext, transport };
}

describe('beat grid', () => {
  it('uses the first beat offset and wraps four beats per bar', () => {
    expect(getBeatState(0.2, 120, 0.5).active).toBe(false);
    expect(getBeatState(0.5, 120, 0.5)).toEqual({ index: 0, beatInBar: 0, phase: 0, active: true });
    expect(getBeatState(2.75, 120, 0.5)).toEqual({ index: 4, beatInBar: 0, phase: 0.5, active: true });
  });

  it('supports a first beat before audio starts and rejects invalid grids', () => {
    expect(getBeatState(0, 120, -0.5).index).toBe(1);
    for (const bpm of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(getBeatState(1, bpm, 0).active).toBe(false);
    }
  });
});

describe('audio transport', () => {
  it('creates audio lazily and measures playback using the audio clock', async () => {
    const { transport, context, createContext } = setup();
    expect(createContext).not.toHaveBeenCalled();
    expect(transport.state.status).toBe('empty');
    await transport.load(file());
    expect(transport.state).toEqual({ status: 'ready', durationSec: 10, positionSec: 0, fileName: 'dance.wav' });
    context.currentTime = 100;
    await transport.play();
    context.currentTime = 102.25;
    expect(transport.state.positionSec).toBe(2.25);
    expect(context.sources[0]?.start).toHaveBeenCalledWith(100, 0);
    transport.pause();
    context.currentTime = 200;
    expect(transport.state.positionSec).toBe(2.25);
    await transport.play();
    expect(context.sources[1]?.start).toHaveBeenCalledWith(200, 2.25);
    context.currentTime = 201;
    expect(transport.state.positionSec).toBe(3.25);
  });

  it('seeks during playback, clamps to the track, and replays after ending', async () => {
    const { transport, context } = setup();
    await transport.load(file());
    await transport.play();
    transport.seek(6);
    expect(context.sources[0]?.stop).toHaveBeenCalledOnce();
    expect(context.sources[1]?.start).toHaveBeenCalledWith(0, 6);
    transport.seek(100);
    expect(transport.state.status).toBe('ended');
    expect(transport.state.positionSec).toBe(10);
    await transport.play();
    expect(context.sources[2]?.start).toHaveBeenCalledWith(0, 0);
    context.sources[2]?.onended?.();
    expect(transport.state.status).toBe('ended');
    expect(transport.state.positionSec).toBe(10);
  });

  it('ignores an older load that finishes after a newer file', async () => {
    const { transport, context } = setup();
    let resolveFirst: ((buffer: AudioBuffer) => void) | undefined;
    context.decodeAudioData.mockImplementationOnce(() => new Promise<AudioBuffer>((resolve) => { resolveFirst = resolve; }));
    const first = transport.load(file('first.wav'));
    await Promise.resolve();
    await transport.load(file('second.wav'));
    resolveFirst?.({ duration: 99 } as AudioBuffer);
    await first;
    expect(transport.state.fileName).toBe('second.wav');
    expect(transport.state.durationSec).toBe(10);
  });

  it('preserves the existing track when decoding fails', async () => {
    const { transport, context } = setup();
    await transport.load(file());
    context.decodeAudioData.mockRejectedValueOnce(new Error('unsupported codec'));
    await expect(transport.load(file('bad.ogg'))).rejects.toThrow('unsupported codec');
    expect(transport.state.fileName).toBe('dance.wav');
  });

  it('rejects oversized files before decoding and overlong tracks without replacing the current track', async () => {
    const { transport, context } = setup();
    await expect(transport.load(file('large.wav', 50 * 1024 * 1024 + 1))).rejects.toThrow('50 MB');
    expect(context.decodeAudioData).not.toHaveBeenCalled();
    await transport.load(file());
    context.decodeAudioData.mockResolvedValueOnce({ duration: 601 } as AudioBuffer);
    await expect(transport.load(file('long.wav'))).rejects.toThrow('10 minutes');
    expect(transport.state.fileName).toBe('dance.wav');
    expect(transport.state.durationSec).toBe(10);
  });

  it('computes normalized loudness bins and handles silence', async () => {
    const { transport, context } = setup();
    expect(transport.getEnergyEnvelope()).toEqual([]);
    const samples = Float32Array.from({ length: 128 }, (_, i) => i < 64 ? 0.5 : 1);
    context.decodeAudioData.mockResolvedValueOnce({ duration: 10, getChannelData: () => samples } as unknown as AudioBuffer);
    await transport.load(file());
    expect(transport.getEnergyEnvelope(2)).toEqual([0.5, 1]);
    expect(transport.getEnergyEnvelope(10_000)).toHaveLength(512);
    context.decodeAudioData.mockResolvedValueOnce({ duration: 10, getChannelData: () => new Float32Array(128) } as unknown as AudioBuffer);
    await transport.load(file());
    expect(transport.getEnergyEnvelope(2)).toEqual([0, 0]);
  });

  it('cancels a pending play when paused and releases resources on dispose', async () => {
    const { transport, context } = setup();
    await transport.load(file());
    let resume: (() => void) | undefined;
    context.resume.mockImplementationOnce(() => new Promise<void>((resolve) => { resume = resolve; }));
    const playing = transport.play();
    transport.pause();
    resume?.();
    await playing;
    expect(context.sources).toHaveLength(0);
    await transport.play();
    transport.dispose();
    transport.dispose();
    expect(context.sources[0]?.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    await expect(transport.play()).rejects.toThrow('disposed');
  });
});
