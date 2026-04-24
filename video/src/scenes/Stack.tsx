import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {mono, sans, theme} from '../theme';

/** Scene 8 — sponsor stack callout. 5 rows appearing in sequence. */
export const Stack: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const sponsors: {name: string; role: string; color: string}[] = [
    {name: '0G',       role: 'encrypted runbook on 0G Storage · contracts on 0G Chain · sealed inference path', color: theme.accent},
    {name: 'Gensyn',   role: 'AXL mesh — 3 distinct Yggdrasil peer ids, attestations over /send /recv',         color: '#d27bff'},
    {name: 'KeeperHub',role: 'guaranteed rescue — only executes after onchain quorum + runbook hash match',     color: '#ffbb33'},
    {name: 'Uniswap',  role: 'v3 SwapRouter exactInputSingle — optional exit-to-USDC rescue path',              color: '#ff69b4'},
    {name: 'ERC-7857', role: 'Agent911PolicyNFT — owner controls safe; transfer-NFT-changes-rescue',             color: theme.live},
  ];

  const titleOp = spring({frame, fps, config: {damping: 200}, durationInFrames: 18});

  return (
    <AbsoluteFill style={{background: theme.bg, color: theme.fg, padding: '80px', fontFamily: sans}}>
      <div style={{fontSize: 40, fontWeight: 700, marginBottom: 14, opacity: titleOp}}>
        Every sponsor is load-bearing.
      </div>
      <div style={{fontSize: 20, color: theme.muted, marginBottom: 48, fontFamily: mono, opacity: titleOp}}>
        remove any one — the rescue breaks
      </div>

      <div style={{display: 'flex', flexDirection: 'column', gap: 20}}>
        {sponsors.map((s, i) => {
          const at = 20 + i * 18;
          const row = spring({
            frame: frame - at,
            fps,
            config: {damping: 200},
            durationInFrames: 22,
          });
          const x = interpolate(row, [0, 1], [-60, 0]);
          return (
            <div
              key={s.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 32,
                padding: 28,
                background: theme.panel,
                border: `1px solid ${theme.border}`,
                borderRadius: 14,
                opacity: row,
                transform: `translateX(${x}px)`,
              }}
            >
              <div style={{width: 16, height: 60, background: s.color, borderRadius: 4, boxShadow: `0 0 30px ${s.color}80`}} />
              <div style={{width: 200, fontSize: 36, fontWeight: 800, color: s.color, fontFamily: sans}}>{s.name}</div>
              <div style={{flex: 1, fontSize: 20, color: theme.fg, fontFamily: mono, lineHeight: 1.4}}>{s.role}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
