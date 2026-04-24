import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {mono, sans, theme} from '../theme';

/** Scene 6 — FailureConfirmed on chain, KeeperHub rescues, safe fills. */
export const Rescue: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  // Timeline checkpoints (local frames)
  const quorumAt   = 10;  // quorum meter fills
  const confirmAt  = 45;  // FailureConfirmed
  const keeperAt   = 85;  // KeeperHub picks up
  const rescueAt   = 120; // Rescue tx
  const doneAt     = 160; // safe balance rolled

  const quorumProgress = interpolate(frame, [quorumAt, quorumAt + 20], [0, 2/3], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const confirmPop = spring({
    frame: frame - confirmAt,
    fps,
    config: {damping: 15, stiffness: 200},
    durationInFrames: 18,
  });

  const keeperPop = spring({
    frame: frame - keeperAt,
    fps,
    config: {damping: 15, stiffness: 180},
    durationInFrames: 20,
  });

  // vault balance drains, safe fills, between rescueAt and doneAt
  const rescueProgress = interpolate(frame, [rescueAt, doneAt], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const safeBal = Math.round(10000 * rescueProgress);
  const vaultBal = 10000 - safeBal;

  return (
    <AbsoluteFill style={{background: theme.bg, color: theme.fg, padding: '80px', fontFamily: sans}}>
      <div style={{fontSize: 38, fontWeight: 700, marginBottom: 36}}>
        Onchain: quorum confirms, KeeperHub rescues, funds land at the safe.
      </div>

      <div style={{display: 'flex', gap: 24, alignItems: 'stretch', marginBottom: 40}}>
        {/* Quorum meter */}
        <div style={{flex: 1, padding: 28, background: theme.panel, borderRadius: 14, border: `1px solid ${theme.border}`}}>
          <div style={{fontSize: 16, color: theme.muted, fontFamily: mono, letterSpacing: 2, marginBottom: 14}}>WATCHDOG QUORUM.SOL</div>
          <div style={{fontSize: 46, fontFamily: mono, fontWeight: 800, color: theme.accent}}>
            {Math.floor(quorumProgress * 3)} / 3
          </div>
          <div style={{marginTop: 12, height: 16, background: '#0a0c10', borderRadius: 8, overflow: 'hidden'}}>
            <div style={{width: `${quorumProgress * 100}%`, height: '100%', background: theme.accent, transition: 'none'}} />
          </div>
          <div style={{marginTop: 28, opacity: confirmPop, fontSize: 26, fontFamily: mono, color: theme.live, fontWeight: 700}}>
            ✓ FailureConfirmed
          </div>
          <div style={{fontSize: 14, color: theme.muted, fontFamily: mono, marginTop: 6, opacity: confirmPop}}>
            tx: 0xa74b14fd…<br />block 29,566,814 on 0G Testnet
          </div>
        </div>

        {/* KeeperHub executes */}
        <div style={{flex: 1, padding: 28, background: theme.panel, borderRadius: 14, border: `1px solid ${theme.border}`}}>
          <div style={{fontSize: 16, color: theme.muted, fontFamily: mono, letterSpacing: 2, marginBottom: 14}}>KEEPERHUB</div>
          <div style={{fontSize: 28, color: theme.fg, opacity: keeperPop, fontWeight: 700}}>🚑 picked up</div>
          <div style={{marginTop: 18, fontSize: 16, fontFamily: mono, color: theme.muted, opacity: keeperPop}}>
            <div>✓ onchain quorum</div>
            <div>✓ runbook hash matched</div>
            <div>✓ rescue calldata preauthorized</div>
            <div style={{color: theme.accent, marginTop: 6}}>→ Agent911Vault.rescue(policyId, mUSDC)</div>
          </div>
          <div style={{marginTop: 24, fontSize: 14, color: theme.muted, fontFamily: mono, opacity: keeperPop}}>
            tx: 0x52d85cb6…<br />block 29,566,831
          </div>
        </div>
      </div>

      {/* Safe wallet fills */}
      <div style={{display: 'flex', gap: 24}}>
        <div style={{flex: 1, padding: 28, background: theme.panel, borderRadius: 14, border: `1px solid ${theme.border}`}}>
          <div style={{fontSize: 16, color: theme.muted, fontFamily: mono, letterSpacing: 2, marginBottom: 14}}>AGENT911VAULT</div>
          <div style={{fontSize: 70, fontFamily: mono, fontWeight: 800, color: vaultBal === 0 ? theme.muted : theme.fg}}>
            {vaultBal.toLocaleString()}
          </div>
          <div style={{fontSize: 18, color: theme.muted, fontFamily: mono}}>mUSDC</div>
        </div>
        <div style={{flex: 1, padding: 28, background: theme.panel, borderRadius: 14, border: `2px solid ${safeBal > 0 ? theme.live : theme.border}`}}>
          <div style={{fontSize: 16, color: theme.muted, fontFamily: mono, letterSpacing: 2, marginBottom: 14}}>SAFE.AGENT911.ETH</div>
          <div style={{fontSize: 70, fontFamily: mono, fontWeight: 800, color: safeBal > 0 ? theme.live : theme.muted}}>
            {safeBal.toLocaleString()}
          </div>
          <div style={{fontSize: 18, color: theme.muted, fontFamily: mono}}>mUSDC — rescued</div>
        </div>
      </div>

      <div style={{marginTop: 36, fontSize: 22, color: theme.muted, fontFamily: mono}}>
        {safeBal > 0 ? (
          <span style={{color: theme.fg}}>The agent is still dead. The funds are not.</span>
        ) : (
          'rescue in flight...'
        )}
      </div>
    </AbsoluteFill>
  );
};
