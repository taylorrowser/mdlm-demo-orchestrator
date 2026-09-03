import net from 'node:net';
import { once } from 'node:events';

export async function listenAgentSessionController({
  socketPath,
  currentState,
  beginSend,
  recordClientDisconnect = () => {},
  recordPreSendFailure = () => {},
}) {
  const reply = (socket, value) => {
    if (socket.destroyed || !socket.writable) return;
    socket.end(`${JSON.stringify(value)}\n`);
  };

  const server = net.createServer(socket => {
    let input = '';
    socket.setEncoding('utf8');
    socket.on('error', error => {
      recordClientDisconnect(errorDetail(error));
    });
    socket.on('data', chunk => { input += chunk; });
    socket.on('end', () => {
      let request;
      try {
        request = JSON.parse(input);
      } catch {
        reply(socket, { ok: false, error: 'invalid-json' });
        return;
      }

      if (request.action === 'status' && Object.keys(request).length === 1) {
        reply(socket, { ok: true, ...currentState() });
        return;
      }
      if (request.action !== 'send' || typeof request.message !== 'string' || Object.keys(request).length !== 2) {
        reply(socket, { ok: false, error: 'exact-status-or-send-only' });
        return;
      }

      let result;
      try {
        result = beginSend(request.message);
      } catch (error) {
        recordPreSendFailure(errorDetail(error));
        reply(socket, { ok: false, error: 'pre-send-rejected' });
        return;
      }
      reply(socket, result);
    });
  });

  server.listen(socketPath);
  await once(server, 'listening');
  return server;
}

function errorDetail(error) {
  return {
    code: error.code ?? null,
    name: error.name,
    message: error.message,
  };
}
