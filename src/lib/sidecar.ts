import { createSidecarClient } from './sidecar-base';

export const rpc = createSidecarClient({
  binary: 'binaries/local-api',
  stderrPrefix: '[local-api]',
  stoppedMessage: 'Local API stopped',
});
