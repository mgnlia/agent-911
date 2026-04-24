import {AbsoluteFill, Series} from 'remotion';
import {Title} from './scenes/Title';
import {Problem} from './scenes/Problem';
import {Healthy} from './scenes/Healthy';
import {Kill} from './scenes/Kill';
import {Watchdogs} from './scenes/Watchdogs';
import {Rescue} from './scenes/Rescue';
import {Receipt} from './scenes/Receipt';
import {Stack} from './scenes/Stack';
import {Outro} from './scenes/Outro';
import {theme} from './theme';

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

// Scene durations in seconds
const SCENES = [
  {name: 'title',     seconds: 4},
  {name: 'problem',   seconds: 8},
  {name: 'healthy',   seconds: 8},
  {name: 'kill',      seconds: 6},
  {name: 'watchdogs', seconds: 10},
  {name: 'rescue',    seconds: 9},
  {name: 'receipt',   seconds: 9},
  {name: 'stack',     seconds: 10},
  {name: 'outro',     seconds: 6},
] as const;

export const DURATION_FRAMES = SCENES.reduce((n, s) => n + s.seconds * FPS, 0);

const sceneDurations = Object.fromEntries(SCENES.map((s) => [s.name, s.seconds * FPS])) as Record<typeof SCENES[number]['name'], number>;

export const Agent911Video: React.FC = () => {
  return (
    <AbsoluteFill style={{background: theme.bg}}>
      <Series>
        <Series.Sequence durationInFrames={sceneDurations.title}>
          <Title />
        </Series.Sequence>
        <Series.Sequence durationInFrames={sceneDurations.problem}>
          <Problem />
        </Series.Sequence>
        <Series.Sequence durationInFrames={sceneDurations.healthy}>
          <Healthy />
        </Series.Sequence>
        <Series.Sequence durationInFrames={sceneDurations.kill}>
          <Kill />
        </Series.Sequence>
        <Series.Sequence durationInFrames={sceneDurations.watchdogs}>
          <Watchdogs />
        </Series.Sequence>
        <Series.Sequence durationInFrames={sceneDurations.rescue}>
          <Rescue />
        </Series.Sequence>
        <Series.Sequence durationInFrames={sceneDurations.receipt}>
          <Receipt />
        </Series.Sequence>
        <Series.Sequence durationInFrames={sceneDurations.stack}>
          <Stack />
        </Series.Sequence>
        <Series.Sequence durationInFrames={sceneDurations.outro}>
          <Outro />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
