import fs from 'node:fs';
import { listenAgentSessionController } from 'mdlm-demo-orchestrator/controller';

const [socketPath, requestPath] = process.argv.slice(2);
let failure = null;
let sends = 0;

const server = await listenAgentSessionController({
  socketPath,
  currentState: () => ({ sends, failure }),
  beginSend(message) {
    fs.writeFileSync(requestPath, message, { flag: 'wx' });
    sends += 1;
    return { ok: true };
  },
  recordPreSendFailure(error) {
    failure = error;
  },
});

process.stdout.write('ready\n');
process.on('SIGTERM', () => server.close());
