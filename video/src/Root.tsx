import {Composition} from 'remotion';
import {Agent911Video, FPS, DURATION_FRAMES, WIDTH, HEIGHT} from './Video';

export const RemotionRoot = () => {
  return (
    <Composition
      id="agent911"
      component={Agent911Video}
      durationInFrames={DURATION_FRAMES}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  );
};
