import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {mono, sans, theme} from '../theme';

/** Scene 9 — final outro: thesis + repo + pulse. */
export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const fadeIn = spring({frame, fps, config: {damping: 200}, durationInFrames: 22});
  const pulse = 0.5 + 0.5 * Math.abs(Math.sin(frame / 10));

  return (
    <AbsoluteFill
      style={{
        background: theme.bg,
        color: theme.fg,
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily: sans,
        padding: 80,
        textAlign: 'center',
      }}
    >
      <div style={{fontSize: 22, color: theme.muted, letterSpacing: 6, textTransform: 'uppercase', fontFamily: mono, opacity: fadeIn}}>
        The primitive
      </div>
      <div style={{fontSize: 56, fontWeight: 800, marginTop: 18, maxWidth: 1500, opacity: fadeIn, lineHeight: 1.2}}>
        Autonomous agents need an <span style={{color: theme.accent}}>external failure oracle</span>.
      </div>
      <div style={{fontSize: 30, color: theme.muted, marginTop: 28, maxWidth: 1300, opacity: fadeIn, lineHeight: 1.4}}>
        WatchdogQuorum is reusable. Agent-911 is the first instance.
      </div>

      <div style={{marginTop: 80, display: 'flex', alignItems: 'center', gap: 16, opacity: fadeIn}}>
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: 11,
            background: theme.dead,
            opacity: 0.4 + 0.6 * pulse,
            boxShadow: `0 0 ${25 + 25 * pulse}px ${theme.dead}`,
          }}
        />
        <div style={{fontSize: 44, fontWeight: 800, color: theme.fg}}>Agent-911</div>
      </div>

      <div style={{marginTop: 36, fontSize: 26, color: theme.accent, fontFamily: mono, opacity: fadeIn}}>
        github.com/guzus/agent-911
      </div>
      <div style={{marginTop: 10, fontSize: 20, color: theme.muted, fontFamily: mono, opacity: fadeIn}}>
        live on 0G Testnet · chainscan-galileo.0g.ai
      </div>

      <div style={{position: 'absolute', bottom: 60, fontSize: 18, color: theme.muted, fontFamily: mono, opacity: fadeIn * 0.7}}>
        ETHGlobal OpenAgents 2026
      </div>
    </AbsoluteFill>
  );
};
