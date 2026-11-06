import { createSidecarClient } from './sidecar-base';

export const ytMusicRpc = createSidecarClient({
  binary: 'binaries/ytmusic-worker',
  stoppedMessage: 'YouTube Music worker stopped',
  startErrorMessage: 'Could not start YouTube Music support',
  sendErrorMessage: 'Could not send a request to YouTube Music support',
  suppressStderr: true,
});
