import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {mono, sans, theme} from '../theme';

/** Scene 5 — watchdogs observe, sign, send attestations over AXL. */
export const Watchdogs: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  // Stagger each watchdog signing
  const stages: {id: string; pk: string; at: number}[] = [
    {id: 'watchdog-1.agent911.eth', pk: '93c58b52…', at: 30},
    {id: 'watchdog-2.agent911.eth', pk: '77d8778f…', at: 60},
    {id: 'watchdog-3.agent911.eth', pk: '76698971…', at: 90},
  ];

  const signed = stages.map((s) => frame >= s.at);

  const titleOpacity = spring({frame, fps, config: {damping: 200}, durationInFrames: 18});

  return (
    <AbsoluteFill style={{background: theme.bg, color: theme.fg, padding: '80px', fontFamily: sans, opacity: titleOpacity}}>
      <div style={{fontSize: 40, fontWeight: 700, marginBottom: 12}}>
        Three watchdogs, three separate AXL nodes.
      </div>
      <div style={{fontSize: 22, color: theme.muted, marginBottom: 48, fontFamily: mono}}>
        each signs independently — no coordinator tells them what to see
      </div>

      <div style={{display: 'flex', gap: 24}}>
        {stages.map((s, i) => {
          const localFrame = frame - s.at;
          const signSpring = spring({
            frame: localFrame,
            fps,
            config: {damping: 12, stiffness: 180},
            durationInFrames: 20,
          });
          const scale = signed[i] ? 1 + 0.1 * (1 - signSpring) : 1;
          const borderColor = signed[i] ? theme.live : theme.border;

          return (
            <div
              key={s.id}
              style={{
                flex: 1,
                background: theme.panel,
                border: `2px solid ${borderColor}`,
                borderRadius: 16,
                padding: 28,
                transform: `scale(${scale})`,
                transformOrigin: 'center',
                transition: 'none',
              }}
            >
              <div style={{fontSize: 18, color: theme.muted, fontFamily: mono, letterSpacing: 2, marginBottom: 14}}>WATCHDOG {i + 1}</div>
              <div style={{fontSize: 24, color: theme.accent, fontFamily: mono, marginBottom: 18}}>{s.id}</div>
              <div style={{fontSize: 14, color: theme.muted, fontFamily: mono}}>AXL peer id</div>
              <div style={{fontSize: 20, color: theme.fg, fontFamily: mono, marginBottom: 24}}>{s.pk}</div>
              <div style={{fontSize: 14, color: theme.muted, fontFamily: mono}}>heartbeat miss</div>
              <div style={{fontSize: 22, color: theme.fg, fontFamily: mono, marginBottom: 16}}>
                {signed[i] ? '3 / 3' : frame >= s.at - 20 ? Math.min(3, Math.floor((frame - (s.at - 20)) / 6)) + ' / 3' : '0 / 3'}
              </div>
              <div
                style={{
                  padding: '10px 16px',
                  background: signed[i] ? theme.live : '#2d2f37',
                  color: signed[i] ? theme.bg : theme.muted,
                  fontSize: 22,
                  fontWeight: 700,
                  borderRadius: 8,
                  textAlign: 'center',
                  fontFamily: mono,
                }}
              >
                {signed[i] ? '✓ EIP-712 SIGNED' : 'pending'}
              </div>
              {signed[i] ? (
                <div style={{marginTop: 18, fontSize: 14, color: theme.muted, fontFamily: mono}}>
                  → coordinator AXL /send
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div style={{marginTop: 48, fontSize: 26, color: theme.muted, fontFamily: sans}}>
        {signed.filter(Boolean).length >= 2 ? (
          <>Quorum threshold met (<span style={{color: theme.live, fontFamily: mono}}>2 of 3</span>). Bundling into one onchain tx...</>
        ) : (
          'waiting for independent observations'
        )}
      </div>
    </AbsoluteFill>
  );
};
