import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {mono, sans, theme} from '../theme';

/** Scene 4 — the inflection point. `kill -9` types, heartbeat flatlines. */
export const Kill: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const typedCmd = 'kill -9 main.agent-911.eth';
  const typeProgress = interpolate(frame, [10, 60], [0, typedCmd.length], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const typed = typedCmd.slice(0, Math.round(typeProgress));
  const caret = frame % 20 < 10 ? '▌' : ' ';

  const killed = frame >= 60;
  const statusFlash = killed && frame < 80 ? (frame % 6 < 3 ? 1 : 0.3) : 1;
  const pulseAlive = !killed ? 0.3 + 0.7 * Math.abs(Math.sin(frame / 8)) : 0;

  // Timer
  const timerFrames = Math.max(0, frame - 60);
  const timerSec = timerFrames / fps;
  const mm = String(Math.floor(timerSec / 60)).padStart(2, '0');
  const ss = String(Math.floor(timerSec % 60)).padStart(2, '0');
  const hh = String(Math.floor((timerSec * 100) % 100)).padStart(2, '0');

  return (
    <AbsoluteFill style={{background: theme.bg, color: theme.fg, padding: '60px 80px', fontFamily: sans}}>
      <div style={{fontSize: 40, fontWeight: 700, marginBottom: 48}}>Something kills the agent.</div>

      {/* Terminal box */}
      <div
        style={{
          background: '#0a0c10',
          borderRadius: 10,
          border: `1px solid ${theme.border}`,
          padding: '18px 24px',
          marginBottom: 36,
          fontFamily: mono,
          fontSize: 28,
          maxWidth: 1400,
        }}
      >
        <div style={{color: theme.muted, fontSize: 14, marginBottom: 8}}>$ ops@vps — demo-kill</div>
        <div style={{color: theme.live}}>$ <span>{typed}</span><span style={{color: theme.accent}}>{caret}</span></div>
        {frame > 60 ? <div style={{color: theme.dead, marginTop: 8}}>[demo-kill] SIGKILL → main-agent pid=715299</div> : null}
      </div>

      {/* Status + ECG */}
      <div style={{display: 'flex', gap: 24, alignItems: 'stretch'}}>
        <div style={{flex: 1, padding: 28, background: theme.panel, borderRadius: 14, border: `1px solid ${theme.border}`}}>
          <div style={{fontSize: 18, color: theme.muted, fontFamily: mono, letterSpacing: 2, marginBottom: 14}}>MAIN AGENT</div>
          <div
            style={{
              fontSize: 64,
              fontWeight: 900,
              color: killed ? theme.dead : theme.live,
              opacity: statusFlash,
              fontFamily: mono,
            }}
          >
            {killed ? 'OFFLINE' : 'LIVE'}
          </div>
          <div style={{marginTop: 18, height: 90, background: '#0a0c10', borderRadius: 8, position: 'relative'}}>
            <svg viewBox="0 0 600 90" width="100%" height={90} style={{display: 'block'}}>
              {killed ? (
                <line x1={0} x2={600} y1={45} y2={45} stroke={theme.dead} strokeWidth={3} strokeDasharray="6 6" />
              ) : (
                <polyline
                  fill="none"
                  stroke={theme.live}
                  strokeWidth={3}
                  points={Array.from({length: 60}, (_, i) => {
                    const phase = (i + (frame * 2) % 60);
                    const y = 45 + (phase % 8 === 0 ? -30 * pulseAlive : phase % 8 === 1 ? 22 * pulseAlive : 0);
                    return `${i * 10},${y}`;
                  }).join(' ')}
                />
              )}
            </svg>
          </div>
        </div>

        <div style={{width: 380, padding: 28, background: theme.panel, borderRadius: 14, border: `1px solid ${killed ? theme.dead : theme.border}`}}>
          <div style={{fontSize: 18, color: theme.muted, fontFamily: mono, letterSpacing: 2, marginBottom: 14}}>KILL → SAFE</div>
          <div style={{fontSize: 72, color: killed ? theme.accent : theme.muted, fontFamily: mono}}>{mm}:{ss}.{hh}</div>
        </div>
      </div>

      <div style={{marginTop: 32, fontSize: 22, color: theme.muted, fontFamily: sans}}>
        {killed ? 'No one asks the dead agent what happened.' : 'Watch who comes to save it.'}
      </div>
    </AbsoluteFill>
  );
};
