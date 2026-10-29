import { useEffect, useRef, useState } from 'react';
import { DanceRuntime, type Hud } from './runtime';

const formatTime = (seconds: number): string => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const colors = ['#b9f36b', '#77d5f9', '#c5a1ff', '#ff997d'];

export function App() {
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const coach = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const runtime = useRef<DanceRuntime | null>(null);
  const [hud, setHud] = useState<Hud | null>(null);
  const [bpm, setBpm] = useState(120);
  const [offset, setOffset] = useState(0);
  const [latency, setLatency] = useState(0);
  const [color, setColor] = useState(colors[0]!);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    if (!video.current || !overlay.current || !coach.current) return;
    const game = new DanceRuntime({ video: video.current, overlay: overlay.current, coach: coach.current }, setHud);
    runtime.current = game;
    return () => { game.dispose(); runtime.current = null; };
  }, []);

  async function safely(action: () => Promise<void>) {
    setError('');
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Something went wrong. Please try again.'); }
  }

  async function load(file?: File) {
    if (!file || !runtime.current) return;
    setLoading(true);
    await safely(() => runtime.current!.load(file));
    setLoading(false);
    if (input.current) input.current.value = '';
  }

  function timing(nextBpm: number, nextOffset: number, nextLatency: number) {
    if (!Number.isFinite(nextBpm) || !Number.isFinite(nextOffset) || !Number.isFinite(nextLatency)) return;
    const safeBpm = Math.max(40, Math.min(220, nextBpm));
    const safeOffset = Math.max(-10, Math.min(30, nextOffset));
    const safeLatency = Math.max(-500, Math.min(500, nextLatency));
    setBpm(safeBpm); setOffset(safeOffset); setLatency(safeLatency);
    runtime.current?.setTiming(safeBpm, safeOffset, safeLatency);
  }

  const loaded = Boolean(hud?.durationSec);
  const playing = hud?.playing ?? false;
  const issue = error || hud?.error;

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="./" aria-label="DDR-Like home"><span className="brand-icon">↗</span> DDR<span className="brand-light">/LIKE</span><span className="version">LAB 01</span></a>
      <div className="header-actions"><span className="privacy"><span className="status-dot" /> PRIVATE BY DESIGN</span><button className="text-button" onClick={() => setHelp(!help)} aria-expanded={help}>How to play <span>↗</span></button></div>
    </header>

    <main>
      <section className="page-heading"><div><p className="eyebrow">YOUR MUSIC. YOUR MOVES.</p><h1>Find your rhythm<span>.</span></h1><p className="subtitle">Turn up a track. Follow the coach. Make it your own.</p></div><div className="session-tag"><span className="status-dot" /> DANCE STUDIO <span className="muted">/ PROTOTYPE</span></div></section>

      {help && <section className="help-panel"><h2>A little room. A lot of rhythm.</h2><ol><li>Load an MP3, WAV, or OGG file you have permission to use (up to 50 MiB / 10 minutes).</li><li>Set BPM and first-beat offset by ear. The four dots mark a 4/4 beat grid; automatic beat detection is not included.</li><li>Enable your camera and step back until your shoulders, hips, and ankles are visible. Good light helps.</li><li>Mirror the coach as if looking in a mirror. Playback works without a camera; scores require full-body tracking.</li><li>If feedback feels early or late, pause and adjust the timing correction. Bluetooth latency may vary.</li></ol><p>This prototype uses four standing moves and a procedural 3D mannequin. Model assets are served locally; no camera frames or music are uploaded. Scores are stored in this browser.</p></section>}

      {issue && <div className="error-banner" role="alert">{issue}</div>}

      <div className="studio-layout">
        <section className="stage-card" aria-label="Dance studio">
          <div className="stage-top"><span className="small-label"><span className={`status-dot ${playing ? '' : 'gray'}`} /> {playing ? 'SESSION LIVE' : 'READY WHEN YOU ARE'}</span><span className="small-label muted">MIRROR MODE</span></div>
          <canvas ref={coach} className="coach-canvas" aria-label="3D dance coach demonstrating the current move" />
          <div className="stage-text"><span className="pill">YOUR COACH</span><h2>{hud?.moveName || 'Step touch'}</h2><p>{playing ? 'Follow the movement. Feel the beat.' : 'Load a track to build your routine.'}</p></div>
          <div className="beat-meter" aria-label={`Beat ${(hud?.beatInBar ?? 0) + 1} of 4`}>{[0, 1, 2, 3].map(i => <span key={i} className={playing && hud?.beatActive && hud.beatInBar === i ? 'beat active' : 'beat'}>{i + 1}</span>)}</div>
          <div className="stage-bottom"><span>UP NEXT <strong>{hud?.nextMoveName || 'Open wide'}</strong></span><span className="stage-tempo">{bpm} <small>BPM</small></span></div>
        </section>

        <aside className="side-panel">
          <section className="camera-card">
            <div className="card-heading"><h2>Your space</h2><span className="micro-label">ON-DEVICE VISION</span></div>
            <div className={`camera-viewport ${hud?.cameraOn ? 'is-on' : ''}`}>
              <video ref={video} autoPlay playsInline muted className="webcam" />
              <canvas ref={overlay} className="pose-overlay" aria-label="Mirrored webcam skeleton overlay" />
              {!hud?.cameraOn && <div className="camera-placeholder"><svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><rect x="6" y="12" width="25" height="24" rx="6" /><path d="m31 21 11-7v20l-11-7" /></svg><strong>Step into the frame</strong><span>Your camera stays yours.</span></div>}
              <span className="corner corner-tl" /><span className="corner corner-tr" /><span className="corner corner-bl" /><span className="corner corner-br" />
              {hud?.cameraOn && <span className="tracking-badge">{hud.tracking}</span>}
            </div>
            <button className="camera-button" disabled={hud?.cameraBusy} onClick={() => void safely(() => runtime.current!.toggleCamera())}>{hud?.cameraBusy ? 'Starting camera…' : hud?.cameraOn ? 'Turn camera off' : 'Enable camera'} <span>{hud?.cameraOn ? '■' : '↗'}</span></button>
          </section>

          <section className="score-card"><div className="card-heading"><h2>{hud?.results ? 'Session complete' : 'Your session'}</h2><span className="micro-label">{hud?.results ? 'FINAL SCORE' : 'LIVE FEEDBACK'}</span></div><div className="score-number" data-testid="score">{(hud?.score ?? 0).toLocaleString()}</div><div className="score-detail"><span className={`judgment judgment-${(hud?.judgment || 'Ready').toLowerCase()}`}>{hud?.judgment || 'Ready'}</span><span className="combo">{hud?.combo ?? 0}<small> COMBO</small></span></div><div className="score-footer"><span>PERSONAL BEST</span><strong>{(hud?.bestScore ?? 0).toLocaleString()}</strong></div></section>

          <section className="outfit-card"><span className="small-label">COACH COLOR</span><div className="swatches">{colors.map(c => <button key={c} className={c === color ? 'swatch selected' : 'swatch'} style={{ backgroundColor: c }} aria-label={`Coach color ${c}`} aria-pressed={c === color} onClick={() => { setColor(c); runtime.current?.setColor(c); }} />)}</div></section>
        </aside>
      </div>

      <section className="transport-card" aria-label="Music and playback">
        <div className="track-controls"><button className="play-button" aria-label={playing ? 'Pause music' : 'Play music'} disabled={!loaded || loading} onClick={() => void safely(() => runtime.current!.togglePlayback())}>{playing ? 'Ⅱ' : '▶'}</button><div className="track-info"><span className="micro-label">{loading ? 'DECODING LOCAL AUDIO…' : 'NOW PLAYING'}</span><h2>{hud?.fileName || 'Bring your own soundtrack'}</h2><p>{loaded ? `${formatTime(hud?.durationSec ?? 0)} · Energy-matched routine · 4/4 grid` : 'MP3, WAV, OGG · Local files only'}</p></div><input ref={input} type="file" accept="audio/*,.mp3,.wav,.ogg" className="file-input" aria-label="Upload music file" onChange={e => void load(e.target.files?.[0])} /><button className="upload-button" disabled={loading || playing} onClick={() => input.current?.click()}>↑ <span>{loaded ? 'Change track' : 'Load a track'}</span></button><button className="restart-button" disabled={!loaded || loading} aria-label="Restart song and score" onClick={() => runtime.current?.restart()}>↺</button></div>
        <div className="timeline"><span>{formatTime(hud?.positionSec ?? 0)}</span><input type="range" aria-label="Song position" min="0" max={hud?.durationSec || 1} step="0.05" value={hud?.positionSec || 0} disabled={!loaded || playing || loading} onChange={e => runtime.current?.seek(Number(e.target.value))} /><span>{formatTime(hud?.durationSec ?? 0)}</span></div>
        <div className="timing-controls"><label>Tempo <input aria-label="Tempo BPM" type="number" min="40" max="220" value={bpm} disabled={playing || loading} onChange={e => timing(e.target.valueAsNumber, offset, latency)} /><span>BPM</span></label><label>First beat <input aria-label="First beat offset seconds" type="number" min="-10" max="30" step="0.05" value={offset} disabled={playing || loading} onChange={e => timing(bpm, e.target.valueAsNumber, latency)} /><span>sec</span></label><label>Timing correction <input aria-label="Timing correction milliseconds" type="number" min="-500" max="500" step="10" value={latency} disabled={playing || loading} onChange={e => timing(bpm, offset, e.target.valueAsNumber)} /><span>ms</span></label><span className="timing-note">Pause to adjust the beat grid.</span></div>
      </section>

      <footer className="footer"><span><span className="status-dot" /> NO UPLOADS. NO BACKEND. JUST YOU.</span><div className="performance"><span><strong data-testid="render-fps">{Math.round(hud?.renderFps ?? 0)}</strong> RENDER FPS</span><span><strong data-testid="inference-fps">{Math.round(hud?.inferenceFps ?? 0)}</strong> POSE FPS</span><span><strong>{Math.round(hud?.inferenceMs ?? 0)}</strong> MS INFERENCE</span></div></footer>
    </main>
  </div>;
}
