import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const waitFor = async (predicate, timeout = 1500) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
};

const request = (socketPath, value) => new Promise((resolve, reject) => {
  const client = net.createConnection(socketPath);
  let response = '';
  client.setEncoding('utf8');
  client.on('connect', () => client.end(`${JSON.stringify(value)}\n`));
  client.on('data', chunk => { response += chunk; });
  client.on('end', () => resolve(JSON.parse(response)));
  client.on('error', reject);
});

test('a pre-send evidence collision rejects the request without killing the controller or dispatching', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdlm-controller-pre-send-'));
  const socketPath = path.join(root, 'controller.sock');
  const requestPath = path.join(root, 'turn-request.json');
  fs.writeFileSync(requestPath, 'manager-owned evidence', { flag: 'wx' });
  const child = spawn(process.execPath, [
    new URL('./agent-session-controller-fixture.mjs', import.meta.url).pathname,
    socketPath,
    requestPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  let exit = null;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('exit', (code, signal) => { exit = { code, signal }; });

  try {
    await waitFor(() => stdout.includes('ready') || exit !== null);
    assert.equal(exit, null, stderr);

    assert.deepEqual(await request(socketPath, { action: 'send', message: 'continue' }), {
      ok: false,
      error: 'pre-send-rejected',
    });
    assert.deepEqual(await request(socketPath, { action: 'status' }), {
      ok: true,
      sends: 0,
      failure: {
        code: 'EEXIST',
        name: 'Error',
        message: `EEXIST: file already exists, open '${requestPath}'`,
      },
    });
    assert.equal(exit, null, `controller exited after rejection: ${stderr}`);
  } finally {
    child.kill('SIGTERM');
  }
});
