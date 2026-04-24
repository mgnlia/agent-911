import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {mono, sans, theme} from '../theme';

export const Title: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const titleOpacity = spring({frame, fps, config: {damping: 200}, durationInFrames: 25});
  const titleY = interpolate(titleOpacity, [0, 1], [40, 0]);

  const sub = spring({frame: frame - 18, fps, config: {damping: 200}, durationInFrames: 25});
  const subOpacity = interpolate(sub, [0, 1], [0, 1], {extrapolateLeft: 'clamp'});

  const dotPulse = Math.sin(frame / 6) * 0.5 + 0.5;

  return (
    <AbsoluteFill
      style={{
        background: theme.bg,
        color: theme.fg,
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily: sans,
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', gap: 18, opacity: titleOpacity, transform: `translateY(${titleY}px)`}}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            background: theme.dead,
            opacity: 0.4 + 0.6 * dotPulse,
            boxShadow: `0 0 ${40 + 40 * dotPulse}px ${theme.dead}`,
          }}
        />
        <div style={{fontSize: 140, fontWeight: 800, letterSpacing: -2, color: theme.fg}}>Agent-911</div>
      </div>

      <div
        style={{
          marginTop: 28,
          fontSize: 34,
          color: theme.muted,
          maxWidth: 1300,
          textAlign: 'center',
          opacity: subOpacity,
          fontFamily: sans,
        }}
      >
        the rescue layer for autonomous onchain agents
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 60,
          fontSize: 18,
          color: theme.muted,
          fontFamily: mono,
          opacity: subOpacity,
        }}
      >
        ETHGlobal OpenAgents — 2026
      </div>
    </AbsoluteFill>
  );
};
