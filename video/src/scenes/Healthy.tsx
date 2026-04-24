import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {mono, sans, theme} from '../theme';

const Panel: React.FC<{title: string; children: React.ReactNode; highlight?: string}> = ({title, children, highlight}) => (
  <div
    style={{
      flex: 1,
      background: theme.panel,
      border: `1px solid ${highlight ?? theme.border}`,
      borderRadius: 14,
      padding: 28,
    }}
  >
    <div style={{color: theme.muted, fontSize: 16, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 16, fontFamily: mono}}>{title}</div>
    {children}
  </div>
);

const KV: React.FC<{k: string; v: React.ReactNode}> = ({k, v}) => (
  <div style={{display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px dashed #2a2f3a`, fontSize: 22, fontFamily: mono}}>
    <span style={{color: theme.muted}}>{k}</span>
    <span>{v}</span>
  </div>
);

export const Healthy: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const fade = spring({frame, fps, config: {damping: 200}, durationInFrames: 20});
  // heartbeat counter ticks every ~fps frames (once per sec of video)
  const counter = Math.floor(frame / (fps / 2)) + 1;
  const pulse = 0.3 + 0.7 * Math.abs(Math.sin(frame / 8));

  return (
    <AbsoluteFill style={{background: theme.bg, color: theme.fg, padding: '80px 80px', fontFamily: sans, opacity: fade}}>
      <div style={{fontSize: 40, fontWeight: 700, marginBottom: 12}}>A treasury agent, running.</div>
      <div style={{fontSize: 22, color: theme.muted, marginBottom: 48}}>Every second: heartbeat. Every second: proof-of-life.</div>

      <div style={{display: 'flex', gap: 24, height: 560}}>
        <Panel title="The Agent">
          <KV k="name" v={<span style={{color: theme.accent}}>main.agent911.eth</span>} />
          <KV k="status" v={<span style={{color: theme.live, fontWeight: 700}}>LIVE</span>} />
          <KV k="heartbeat" v={<span>#{counter}</span>} />
          <KV k="last seen" v={<span>0 ms</span>} />
          <div style={{marginTop: 24, height: 120, position: 'relative', background: '#0a0c10', borderRadius: 8}}>
            {/* ECG-like pulse line */}
            <svg viewBox="0 0 600 120" width="100%" height="120" style={{display: 'block'}}>
              <polyline
                fill="none"
                stroke={theme.live}
                strokeWidth={3}
                points={Array.from({length: 60}, (_, i) => {
                  const phase = (i + (frame * 2) % 60);
                  const y = 60 + (phase % 8 === 0 ? -40 * pulse : phase % 8 === 1 ? 30 * pulse : 0);
                  return `${i * 10},${y}`;
                }).join(' ')}
              />
            </svg>
          </div>
        </Panel>

        <Panel title="Watchdog Quorum (2-of-3 via AXL)">
          {['watchdog-1', 'watchdog-2', 'watchdog-3'].map((id, i) => (
            <div key={id} style={{padding: '12px 14px', background: '#20242e', borderRadius: 8, marginBottom: 10, display: 'flex', justifyContent: 'space-between', fontFamily: mono, fontSize: 20}}>
              <span style={{color: theme.accent}}>{id}.agent911.eth</span>
              <span style={{color: theme.muted, fontSize: 14, padding: '2px 10px', background: '#2d2f37', borderRadius: 4}}>pending</span>
            </div>
          ))}
          <div style={{marginTop: 28, fontSize: 18, color: theme.muted, fontFamily: mono}}>
            each on a distinct Yggdrasil peer id
          </div>
        </Panel>

        <Panel title="Vault">
          <KV k="vault" v={<span style={{color: theme.accent}}>Agent911Vault</span>} />
          <KV k="holds" v={<span style={{color: theme.fg, fontWeight: 700}}>10,000 mUSDC</span>} />
          <KV k="safe" v={<span style={{color: theme.accent}}>safe.agent911.eth</span>} />
          <KV k="safe bal" v={<span style={{color: theme.muted}}>0 mUSDC</span>} />
        </Panel>
      </div>

      <div style={{marginTop: 40, fontSize: 20, color: theme.muted, fontFamily: mono}}>
        The vault rule is simple:{' '}
        <span style={{color: theme.fg}}>funds move only when the watchdog quorum says the agent is dead.</span>
      </div>
    </AbsoluteFill>
  );
};
