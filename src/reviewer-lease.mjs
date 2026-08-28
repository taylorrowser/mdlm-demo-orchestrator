import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { readCanonicalFile } from './canonical-file.mjs';
import { parseStrictJson } from './strict-json.mjs';
import { sha256 } from './util.mjs';

const requestContract = 'mdlm-demo-reviewer-lease-request@1';
const resultContract = 'mdlm-demo-reviewer-lease-result@1';
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const identityPattern = /^[A-Za-z0-9._:/-]{1,256}$/;
const attemptPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const terminalOutcomes = new Set(['completed-with-response', 'failed', 'cancelled', 'capacity-rejected', 'disappeared']);

export const reviewerLeaseLimits = Object.freeze({ requestBytes: 1_048_576, responseBytes: 4_194_304 });

export async function reviewerLease(request) {
  requireObject(request, 'reviewer lease request');
  if (request.contract !== requestContract) throw new Error(`reviewer lease request contract must equal '${requestContract}'`);
  if (!['open', 'bind', 'status', 'terminal'].includes(request.action)) throw new Error('reviewer lease request action is unsupported');
  const root = await requireCanonicalRoot(request.root);
  return withControlLock(root, () => dispatch(root, request));
}

async function dispatch(root, request) {
  if (request.action === 'open') return openAttempt(root, request);
  if (request.action === 'bind') return bindAttempt(root, request);
  if (request.action === 'status') return attemptStatus(root, request);
  return terminalAttempt(root, request);
}

async function openAttempt(root, request) {
  rejectUnknown(request, ['contract', 'action', 'root', 'lane', 'assignment', 'packetDigest']);
  requireIdentity(request.lane, 'reviewer lease request lane');
  requireIdentity(request.assignment, 'reviewer lease request assignment');
  requireDigest(request.packetDigest, 'reviewer lease request packetDigest');
  await reconcileActive(root);
  if (await readOptionalJson(activePath(root))) throw new Error('active reviewer lease already exists');

  const attempt = randomUUID();
  const receiverId = randomUUID();
  const directory = attemptDirectory(root, attempt);
  const receiverDirectory = path.join(directory, 'receiver');
  await durableMkdir(path.join(root, 'attempts'), root);
  await durableMkdir(directory, path.join(root, 'attempts'));
  await durableMkdir(receiverDirectory, directory);
  const record = {
    contract: 'mdlm-demo-reviewer-attempt@1',
    attempt,
    lane: request.lane,
    assignment: request.assignment,
    packetDigest: request.packetDigest,
    receiver: { id: receiverId, path: receiverDirectory },
    openedAt: new Date().toISOString(),
  };
  await writeDurableJson(path.join(directory, 'attempt.json'), record);
  return result(record, 'awaiting-session');
}

async function bindAttempt(root, request) {
  rejectUnknown(request, ['contract', 'action', 'root', 'attempt', 'session']);
  const attempt = requireAttempt(request.attempt);
  requireIdentity(request.session, 'reviewer lease request session');
  const record = await readAttempt(root, attempt);
  if (await readOptionalJson(terminalPath(root, attempt))) throw new Error('reviewer attempt is already terminal');
  await reconcileActive(root);
  if (await readOptionalJson(activePath(root))) throw new Error('active reviewer lease already exists');

  const session = {
    contract: 'mdlm-demo-reviewer-session@1',
    attempt,
    receiver: record.receiver,
    session: request.session,
    boundAt: new Date().toISOString(),
  };
  await writeDurableJson(sessionPath(root, attempt), session);
  const lease = {
    contract: 'mdlm-demo-reviewer-lease@1',
    attempt,
    lane: record.lane,
    assignment: record.assignment,
    packetDigest: record.packetDigest,
    receiver: record.receiver,
    session: request.session,
    activatedAt: new Date().toISOString(),
  };
  const leasePath = path.join(attemptDirectory(root, attempt), 'lease.json');
  await writeDurableJson(leasePath, lease);
  try {
    await link(leasePath, activePath(root));
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('active reviewer lease already exists');
    throw error;
  }
  await syncDirectory(root);
  return result(record, 'still-running', { session, lease });
}

async function terminalAttempt(root, request) {
  rejectUnknown(request, ['contract', 'action', 'root', 'attempt', 'session', 'outcome', 'response', 'detail']);
  const attempt = requireAttempt(request.attempt);
  if (!terminalOutcomes.has(request.outcome)) throw new Error('reviewer terminal outcome is unsupported');
  if (request.detail !== undefined) requireText(request.detail, 'reviewer lease request detail', 2048);
  const record = await readAttempt(root, attempt);
  if (await readOptionalJson(terminalPath(root, attempt))) throw new Error('reviewer attempt is already terminal');
  const session = await readOptionalJson(sessionPath(root, attempt));
  if (request.outcome === 'capacity-rejected') {
    if (session || request.session !== undefined) throw new Error('capacity-rejected reviewer attempt must not have a session');
  } else {
    requireIdentity(request.session, 'reviewer lease request session');
    if (!session || session.session !== request.session) throw new Error('reviewer terminal session does not match the bound session');
  }

  const active = await readOptionalJson(activePath(root));
  if (active && active.attempt !== attempt) throw new Error('a different reviewer lease is active');
  if (request.outcome === 'completed-with-response' && active?.attempt !== attempt) {
    throw new Error('completed reviewer attempt does not hold the active lease');
  }
  let response;
  if (request.outcome === 'completed-with-response') response = await preserveResponse(root, record, request.response);
  else if (request.response !== undefined) throw new Error('response is supported only for completed-with-response');

  const terminal = {
    contract: 'mdlm-demo-reviewer-terminal@1',
    attempt,
    lane: record.lane,
    assignment: record.assignment,
    receiver: record.receiver,
    session: session?.session ?? null,
    outcome: request.outcome,
    response: response ?? null,
    detail: request.detail ?? null,
    closedAt: new Date().toISOString(),
  };
  await writeDurableJson(terminalPath(root, attempt), terminal);
  if (active?.attempt === attempt) {
    await unlink(activePath(root));
    await syncDirectory(root);
  }
  return result(record, response ? 'completed-with-response' : 'closed-without-response', { terminal });
}

async function attemptStatus(root, request) {
  rejectUnknown(request, ['contract', 'action', 'root', 'attempt']);
  const attempt = requireAttempt(request.attempt);
  const record = await readAttempt(root, attempt);
  const terminal = await readOptionalJson(terminalPath(root, attempt));
  if (terminal) {
    return result(record, terminal.response ? 'completed-with-response' : 'closed-without-response', { terminal });
  }
  const active = await readOptionalJson(activePath(root));
  if (active?.attempt === attempt) return result(record, 'still-running', { lease: active });
  const session = await readOptionalJson(sessionPath(root, attempt));
  return result(record, session ? 'session-bound' : 'awaiting-session', session ? { session } : {});
}

async function preserveResponse(root, attempt, input) {
  requireObject(input, 'reviewer lease request response');
  rejectUnknown(input, ['path', 'digest']);
  if (!path.isAbsolute(input.path ?? '')) throw new Error('reviewer lease request response.path must be absolute');
  requireDigest(input.digest, 'reviewer lease request response.digest');
  const captured = await readCanonicalFile(input.path, 'reviewer response', undefined, { maxBytes: reviewerLeaseLimits.responseBytes });
  const digest = sha256(captured.bytes);
  if (digest !== input.digest) throw new Error('reviewer response digest does not match');
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(captured.bytes);
  const response = parseStrictJson(decoded, 'reviewer response');
  if (response?.contract !== 'mdlm-assignment-response@1') throw new Error("reviewer response contract must equal 'mdlm-assignment-response@1'");
  if (response.assignment !== attempt.assignment) throw new Error('reviewer response Assignment does not match the attempt');
  const target = path.join(attempt.receiver.path, 'response.json');
  await writeDurableBytes(target, captured.bytes);
  return { path: target, digest, bytes: captured.bytes.length };
}

async function reconcileActive(root) {
  const active = await readOptionalJson(activePath(root));
  if (!active) return;
  const terminal = await readOptionalJson(terminalPath(root, active.attempt));
  if (!terminal) return;
  await unlink(activePath(root));
  await syncDirectory(root);
}

async function readAttempt(root, attempt) {
  const value = await readJson(path.join(attemptDirectory(root, attempt), 'attempt.json'));
  if (value.contract !== 'mdlm-demo-reviewer-attempt@1' || value.attempt !== attempt) throw new Error('reviewer attempt record is invalid');
  return value;
}

function result(attempt, state, extra = {}) {
  return {
    contract: resultContract,
    state,
    attempt: attempt.attempt,
    lane: attempt.lane,
    assignment: attempt.assignment,
    receiver: {
      ...attempt.receiver,
      responsePath: path.join(attempt.receiver.path, 'response.json'),
    },
    ...extra,
  };
}

async function withControlLock(root, callback) {
  const file = path.join(root, '.reviewer-lease.lock');
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    await handle.sync();
    await syncDirectory(root);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('reviewer lease control is busy');
    throw error;
  } finally {
    await handle?.close();
  }
  try {
    return await callback();
  } finally {
    await unlink(file).catch(() => {});
    await syncDirectory(root);
  }
}

async function requireCanonicalRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('reviewer lease request root must be an absolute path');
  const resolved = path.resolve(value);
  const canonical = await realpath(resolved);
  const information = await lstat(resolved);
  if (canonical !== resolved || !information.isDirectory() || information.isSymbolicLink()) {
    throw new Error('reviewer lease request root must be a canonical real directory');
  }
  return resolved;
}

async function durableMkdir(directory, parent) {
  try {
    await mkdir(directory, { mode: 0o700 });
    await syncDirectory(parent);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const information = await lstat(directory);
    if (!information.isDirectory() || information.isSymbolicLink()) throw new Error(`reviewer lease path is not a real directory: ${directory}`);
  }
}

async function writeDurableJson(file, value) {
  return writeDurableBytes(file, Buffer.from(`${JSON.stringify(value)}\n`));
}

async function writeDurableBytes(file, bytes) {
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close();
  }
  await syncDirectory(path.dirname(file));
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readJson(file) {
  const bytes = await readFile(file);
  return parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), `reviewer lease record '${file}'`);
}

async function readOptionalJson(file) {
  try { return await readJson(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function activePath(root) { return path.join(root, 'active-lease.json'); }
function attemptDirectory(root, attempt) { return path.join(root, 'attempts', attempt); }
function sessionPath(root, attempt) { return path.join(attemptDirectory(root, attempt), 'session.json'); }
function terminalPath(root, attempt) { return path.join(attemptDirectory(root, attempt), 'terminal.json'); }

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function rejectUnknown(value, allowed) {
  const supported = new Set(allowed);
  for (const key of Object.keys(value)) if (!supported.has(key)) throw new Error(`reviewer lease request.${key} is unsupported`);
}

function requireIdentity(value, label) {
  if (typeof value !== 'string' || !identityPattern.test(value)) throw new Error(`${label} is invalid`);
}

function requireDigest(value, label) {
  if (typeof value !== 'string' || !digestPattern.test(value)) throw new Error(`${label} is invalid`);
}

function requireAttempt(value) {
  if (typeof value !== 'string' || !attemptPattern.test(value)) throw new Error('reviewer lease request attempt is invalid');
  return value;
}

function requireText(value, label, maximum) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maximum) throw new Error(`${label} is invalid`);
}
