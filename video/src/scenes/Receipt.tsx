import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {mono, sans, theme} from '../theme';

/** Scene 7 — the final receipt card with live-0G timings + tx hashes. */
export const Receipt: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const card = spring({frame, fps, config: {damping: 200}, durationInFrames: 22});
  const cardScale = interpolate(card, [0, 1], [0.94, 1]);

  const rows: [string, React.ReactNode][] = [
    ['dead agent',       <span style={{color: theme.dead}}>main.agent-911.eth</span>],
    ['quorum',           <span style={{color: theme.live}}>watchdog-1 + watchdog-2 (2 / 3)</span>],
    ['0G runbook hash',  <span style={{fontFamily: mono}}>0xbc9e61cf…</span>],
    ['FailureConfirmed', <span style={{fontFamily: mono}}>0xa74b14fd…  block 29,566,814</span>],
    ['rescue tx',        <span style={{fontFamily: mono}}>0x52d85cb6…  block 29,566,831</span>],
    ['safe recipient',   <span style={{fontFamily: mono, color: theme.accent}}>0x5afe5afe5afe…</span>],
    ['rescued',          <span style={{color: theme.live, fontWeight: 700}}>1,000 mUSDC</span>],
  ];

  const rowDelays = rows.map((_, i) => 10 + i * 8);

  return (
    <AbsoluteFill style={{background: theme.bg, color: theme.fg, padding: '80px', fontFamily: sans}}>
      <div style={{fontSize: 36, fontWeight: 700, marginBottom: 14}}>Receipt: live on 0G Testnet</div>
      <div style={{fontSize: 20, color: theme.muted, marginBottom: 48, fontFamily: mono}}>
        chainscan-galileo.0g.ai
      </div>

      <div
        style={{
          background: theme.panel,
          border: `1px solid ${theme.border}`,
          borderRadius: 18,
          padding: 40,
          maxWidth: 1500,
          transform: `scale(${cardScale})`,
          transformOrigin: '0 0',
          opacity: card,
        }}
      >
        {rows.map(([k, v], i) => {
          const rowOpacity = interpolate(frame, [rowDelays[i], rowDelays[i] + 10], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          return (
            <div
              key={k}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '14px 0',
                borderBottom: i === rows.length - 1 ? 'none' : `1px dashed #2a2f3a`,
                fontSize: 22,
                opacity: rowOpacity,
              }}
            >
              <span style={{color: theme.muted, fontFamily: mono}}>{k}</span>
              <span>{v}</span>
            </div>
          );
        })}
      </div>

      {/* Timings strip */}
      <div style={{marginTop: 48, display: 'flex', gap: 40, fontFamily: mono}}>
        {([
          ['kill → attestations',      '5.48 s'],
          ['kill → FailureConfirmed',  '13.11 s'],
          ['kill → safe',              '20.51 s'],
        ] as const).map(([k, v], i) => {
          const o = interpolate(frame, [70 + i * 10, 90 + i * 10], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          return (
            <div key={k} style={{flex: 1, padding: 24, background: theme.panel, border: `1px solid ${theme.border}`, borderRadius: 12, opacity: o}}>
              <div style={{fontSize: 14, color: theme.muted, letterSpacing: 2, textTransform: 'uppercase'}}>{k}</div>
              <div style={{fontSize: 44, color: theme.accent, fontWeight: 800, marginTop: 6}}>{v}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
