import {AbsoluteFill, Audio, Series, staticFile} from 'remotion';
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

// Scene durations are set to narration length + ~1s buffer so the voice
// finishes cleanly before the cut. See video/scripts/generate-narration.mjs
// for the exact text; measured mp3 durations ranged 4.5s (kill) to 9.8s
// (problem) after tightening.
const SCENES = [
  {id: 'title',     seconds: 6,  component: Title,     audio: 'narration/title.mp3'},
  {id: 'problem',   seconds: 11, component: Problem,   audio: 'narration/problem.mp3'},
  {id: 'healthy',   seconds: 10, component: Healthy,   audio: 'narration/healthy.mp3'},
  {id: 'kill',      seconds: 6,  component: Kill,      audio: 'narration/kill.mp3'},
  {id: 'watchdogs', seconds: 9,  component: Watchdogs, audio: 'narration/watchdogs.mp3'},
  {id: 'rescue',    seconds: 10, component: Rescue,    audio: 'narration/rescue.mp3'},
  {id: 'receipt',   seconds: 9,  component: Receipt,   audio: 'narration/receipt.mp3'},
  {id: 'stack',     seconds: 10, component: Stack,     audio: 'narration/stack.mp3'},
  {id: 'outro',     seconds: 8,  component: Outro,     audio: 'narration/outro.mp3'},
] as const;

export const DURATION_FRAMES = SCENES.reduce((n, s) => n + s.seconds * FPS, 0);

export const Agent911Video: React.FC = () => {
  return (
    <AbsoluteFill style={{background: theme.bg}}>
      <Series>
        {SCENES.map((s) => {
          const Scene = s.component;
          return (
            <Series.Sequence key={s.id} durationInFrames={s.seconds * FPS}>
              <Scene />
              <Audio src={staticFile(s.audio)} volume={0.95} />
            </Series.Sequence>
          );
        })}
      </Series>
    </AbsoluteFill>
  );
};
