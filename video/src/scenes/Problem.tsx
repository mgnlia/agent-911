import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {mono, sans, theme} from '../theme';

export const Problem: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const fadeIn = spring({frame, fps, config: {damping: 200}, durationInFrames: 20});

  // Big $400M counter that types up over ~2 seconds
  const targetDollars = 400;
  const dollarSpring = spring({
    frame: frame - 20,
    fps,
    config: {damping: 200},
    durationInFrames: 60,
  });
  const dollars = Math.round(interpolate(dollarSpring, [0, 1], [0, targetDollars]));

  // Stat pops in
  const statOpacity = interpolate(frame, [100, 120], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const concernOpacity = interpolate(frame, [150, 180], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        background: theme.bg,
        color: theme.fg,
        padding: '80px 120px',
        fontFamily: sans,
      }}
    >
      <div style={{fontSize: 24, color: theme.muted, opacity: fadeIn, fontFamily: mono}}>
        February 2026 — AI agent cascade
      </div>

      <div
        style={{
          marginTop: 20,
          fontSize: 220,
          fontWeight: 900,
          color: theme.dead,
          letterSpacing: -6,
          fontFamily: sans,
          opacity: fadeIn,
        }}
      >
        ${dollars}M
      </div>

      <div style={{fontSize: 42, color: theme.fg, fontWeight: 600, opacity: fadeIn, maxWidth: 1400}}>
        lost when autonomous trading agents simultaneously exited positions.
      </div>

      <div
        style={{
          marginTop: 60,
          padding: 28,
          background: theme.panel,
          border: `1px solid ${theme.border}`,
          borderRadius: 14,
          fontSize: 28,
          color: theme.muted,
          opacity: statOpacity,
          maxWidth: 1500,
          fontFamily: sans,
        }}
      >
        <span style={{color: theme.fg, fontWeight: 700}}>40%</span> of on-chain transactions are now agent-initiated.{' '}
        <span style={{color: theme.fg, fontWeight: 700}}>250,000+</span> agents active daily.
      </div>

      <div
        style={{
          marginTop: 30,
          fontSize: 34,
          color: theme.warn,
          opacity: concernOpacity,
          fontFamily: sans,
          fontWeight: 600,
        }}
      >
        When the agent dies, the position stays open.
      </div>
    </AbsoluteFill>
  );
};
