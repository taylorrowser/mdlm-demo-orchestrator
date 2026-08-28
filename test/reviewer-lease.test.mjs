import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(repository, 'bin', 'mdlm-demo-runner.mjs');
const packetDigest = `sha256:${'1'.repeat(64)}`;
const assignment = '11111111-1111-4111-8111-111111111111';

async function invoke(request) {
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [runner, 'reviewer-lease'], { cwd: repository });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('close', code => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
  if (result.code !== 0) {
    const error = new Error(`reviewer-lease exited ${result.code}: ${result.stderr}`);
    Object.assign(error, result);
    throw error;
  }
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function request(root, action, extra = {}) {
  return {
    contract: 'mdlm-demo-reviewer-lease-request@1',
    action,
    root,
    ...extra,
  };
}

test('reviewer receiver binds before activation and terminal closure authorizes one replacement', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-reviewer-lease-'));
  const root = path.join(scratch, 'reviewer-transport');
  await mkdir(root);

  const first = await invoke(request(root, 'open', {
    lane: 'hex-to-bytes-codex-terra-024-old-qualified', assignment, packetDigest,
  }));
  assert.equal(first.state, 'awaiting-session');
  assert.match(first.attempt, /^[0-9a-f-]{36}$/);
  assert.match(first.receiver.id, /^[0-9a-f-]{36}$/);

  const active = await invoke(request(root, 'bind', {
    attempt: first.attempt,
    session: 'reviewer-session-001',
  }));
  assert.equal(active.state, 'still-running');
  assert.equal(active.receiver.id, first.receiver.id);
  assert.equal((await invoke(request(root, 'status', { attempt: first.attempt }))).state, 'still-running');

  await assert.rejects(invoke(request(root, 'open', {
    lane: 'hex-to-bytes-codex-terra-024-old-qualified', assignment, packetDigest,
  })), error => error.code === 1 && error.stderr.includes('active reviewer lease already exists'));

  const lost = await invoke(request(root, 'terminal', {
    attempt: first.attempt,
    session: 'reviewer-session-001',
    outcome: 'disappeared',
  }));
  assert.equal(lost.state, 'closed-without-response');
  assert.equal(lost.terminal.outcome, 'disappeared');
  assert.equal((await invoke(request(root, 'status', { attempt: first.attempt }))).state, 'closed-without-response');

  const replacement = await invoke(request(root, 'open', {
    lane: 'hex-to-bytes-codex-terra-024-old-qualified', assignment, packetDigest,
  }));
  assert.notEqual(replacement.attempt, first.attempt);
  await invoke(request(root, 'bind', {
    attempt: replacement.attempt,
    session: 'reviewer-session-002',
  }));

  const responsePath = path.join(scratch, 'response.json');
  const response = `${JSON.stringify({
    contract: 'mdlm-assignment-response@1',
    assignment,
    kind: 'proposal',
    proposal: { outputs: [] },
  })}\n`;
  await writeFile(responsePath, response);
  const responseDigest = `sha256:${createHash('sha256').update(response).digest('hex')}`;
  const completed = await invoke(request(root, 'terminal', {
    attempt: replacement.attempt,
    session: 'reviewer-session-002',
    outcome: 'completed-with-response',
    response: { path: responsePath, digest: responseDigest },
  }));
  assert.equal(completed.state, 'completed-with-response');
  assert.equal(await readFile(completed.receiver.responsePath, 'utf8'), response);
  assert.equal((await invoke(request(root, 'status', { attempt: replacement.attempt }))).state, 'completed-with-response');
});

test('terminal closure authenticates a response already written to its canonical receiver path', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-reviewer-lease-'));
  const root = path.join(scratch, 'reviewer-transport');
  await mkdir(root);

  const opened = await invoke(request(root, 'open', {
    lane: 'hex-to-bytes-codex-terra-024-old-qualified', assignment, packetDigest,
  }));
  await invoke(request(root, 'bind', {
    attempt: opened.attempt,
    session: 'reviewer-session-001',
  }));

  const response = `${JSON.stringify({
    contract: 'mdlm-assignment-response@1',
    assignment,
    kind: 'proposal',
    proposal: { outputs: [] },
  })}\n`;
  const responseDigest = `sha256:${createHash('sha256').update(response).digest('hex')}`;
  await writeFile(opened.receiver.responsePath, response);

  await assert.rejects(invoke(request(root, 'terminal', {
    attempt: opened.attempt,
    session: 'reviewer-session-001',
    outcome: 'completed-with-response',
    response: { path: opened.receiver.responsePath, digest: `sha256:${'2'.repeat(64)}` },
  })), error => error.code === 1 && error.stderr.includes('reviewer response digest does not match'));
  assert.equal((await invoke(request(root, 'status', { attempt: opened.attempt }))).state, 'still-running');
  assert.equal(await readFile(opened.receiver.responsePath, 'utf8'), response);

  const completed = await invoke(request(root, 'terminal', {
    attempt: opened.attempt,
    session: 'reviewer-session-001',
    outcome: 'completed-with-response',
    response: { path: opened.receiver.responsePath, digest: responseDigest },
  }));

  assert.equal(completed.state, 'completed-with-response');
  assert.equal(completed.terminal.response.path, opened.receiver.responsePath);
  assert.equal(await readFile(opened.receiver.responsePath, 'utf8'), response);
  assert.equal((await invoke(request(root, 'status', { attempt: opened.attempt }))).state, 'completed-with-response');
});
