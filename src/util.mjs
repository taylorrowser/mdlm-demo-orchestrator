import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { readCanonicalFile } from './canonical-file.mjs';

export const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const inheritedEnvironment = [
  'HOME', 'PATH', 'TMPDIR',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION',
];
const removedEnvironment = [
  'BASH_ENV', 'CDPATH', 'ENV', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG', 'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_SYSTEM', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'IFS', 'NODE_CHANNEL_FD', 'NODE_COMPILE_CACHE',
  'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE',
  'NODE_UNIQUE_ID', 'NPM_CONFIG_PREFIX', 'SHELLOPTS',
];

export const environmentPolicy = Object.freeze({
  contract: 'mdlm-demo-environment-policy@1',
  inherited: inheritedEnvironment,
  removed: removedEnvironment,
  fixed: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0' },
  gitConfigIsolation: true,
});

export function controlledEnvironment(extra = {}, options = {}) {
  const environment = {};
  for (const name of inheritedEnvironment) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  environment.PATH ??= '/usr/bin:/bin';
  environment.HOME ??= '/';
  environment.LANG = 'C.UTF-8';
  environment.LC_ALL = 'C.UTF-8';
  environment.GIT_TERMINAL_PROMPT = '0';
  if (options.git === true) {
    environment.GIT_CONFIG_NOSYSTEM = '1';
    environment.GIT_CONFIG_GLOBAL = '/dev/null';
    environment.GIT_CONFIG_COUNT = '0';
  }
  for (const [name, value] of Object.entries(extra)) {
    if (typeof value === 'string') environment[name] = value;
  }
  return environment;
}

export function gitEnvironment(extra = {}) {
  const entries = [
    ['core.fsmonitor', 'false'],
    ['core.hooksPath', '/dev/null'],
    ['credential.helper', ''],
    ['core.askPass', '/bin/false'],
    ['core.attributesFile', '/dev/null'],
    ['core.excludesFile', '/dev/null'],
  ];
  const environment = {
    HOME: '/', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: String(entries.length),
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false',
    SSH_ASKPASS: '/bin/false', GIT_PAGER: '/bin/false',
  };
  entries.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  if (extra.GIT_OPTIONAL_LOCKS === '0') environment.GIT_OPTIONAL_LOCKS = '0';
  return environment;
}

export const toolingTreeLimits = Object.freeze({
  fileBytes: 16_777_216,
  totalBytes: 268_435_456,
  entries: 100_000,
  files: 100_000,
  depth: 64,
  symlinkBytes: 4096,
});

export async function fileIdentity(file, options = {}) {
  const configuredPath = path.resolve(file);
  const evidence = await readCanonicalFile(
    configuredPath,
    options.label ?? 'file',
    options.openFile,
    { maxBytes: options.maxBytes ?? toolingTreeLimits.fileBytes },
  );
  return {
    path: configuredPath,
    realpath: evidence.path,
    pathKind: 'file',
    digest: sha256(evidence.bytes),
    bytes: evidence.bytes.length,
  };
}

export async function toolingTreeIdentity(root, options = {}) {
  const configuredRoot = path.resolve(root);
  const entries = [];
  const limits = boundedToolingLimits(options.limits);
  const state = { aliases: new Set(), bytes: 0, files: 0 };
  let rootHandle;
  try {
    rootHandle = await openAnchoredDirectory(configuredRoot, "tooling closure directory '.'", options.openDirectory);
    const rootInformation = await rootHandle.stat({ bigint: true });
    if (!rootInformation.isDirectory()) throw new Error(`tooling closure root is not a directory: ${configuredRoot}`);
    const descriptorRoot = await realpath(`/proc/self/fd/${rootHandle.fd}`);
    if (descriptorRoot !== configuredRoot) throw new Error(`tooling closure root has a symbolic-link path component: ${configuredRoot}`);
    await visitToolingDirectory(rootHandle, configuredRoot, '.', 0, rootInformation, entries, state, options, limits);
    await verifyConfiguredRoot(rootHandle, configuredRoot, rootInformation);
  } finally {
    await rootHandle?.close();
  }
  const manifest = Buffer.from(`${JSON.stringify({ contract: 'mdlm-demo-tooling-tree@1', entries })}\n`);
  return {
    root: configuredRoot,
    contract: 'mdlm-demo-tooling-tree@1',
    digest: sha256(manifest),
    entries: entries.length,
    files: state.files,
    symlinks: entries.filter(entry => entry.type === 'symlink').length,
    bytes: state.bytes,
  };
}

function boundedToolingLimits(overrides = {}) {
  const limits = {};
  for (const [name, maximum] of Object.entries(toolingTreeLimits)) {
    const value = overrides[name] ?? maximum;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`tooling closure ${name} limit must be a nonnegative safe integer`);
    limits[name] = Math.min(value, maximum);
  }
  return limits;
}

async function visitToolingDirectory(handle, configuredRoot, relative, depth, information, entries, state, options, limits) {
  if (depth > limits.depth) throw new Error(`tooling closure exceeds ${limits.depth}-level depth limit`);
  registerEntry(information, relative, state, limits);
  const mode = fileMode(information);
  entries.push({ path: relative, type: 'directory', mode });
  const names = [];
  const directory = await (options.openDirectoryStream ?? opendir)(`/proc/self/fd/${handle.fd}`);
  try {
    for await (const entry of directory) {
      if (entries.length + names.length >= limits.entries) {
        throw new Error(`tooling closure exceeds ${limits.entries}-entry limit`);
      }
      names.push(entry.name);
    }
  } finally {
    await directory.close().catch(() => {});
  }
  names.sort();
  for (const name of names) {
    await visitToolingChild(handle, configuredRoot, relative === '.' ? name : `${relative}/${name}`, depth + 1, entries, state, options, limits);
  }
  const after = await handle.stat({ bigint: true });
  if (!sameStat(information, after)) throw new Error(`tooling closure directory '${relative}' changed while it was being read`);
}

async function visitToolingChild(parentHandle, configuredRoot, relative, depth, entries, state, options, limits) {
  if (depth > limits.depth) throw new Error(`tooling closure exceeds ${limits.depth}-level depth limit`);
  const name = relative.slice(relative.lastIndexOf('/') + 1);
  const anchoredPath = `/proc/self/fd/${parentHandle.fd}/${name}`;
  const before = await lstat(anchoredPath, { bigint: true });
  if (before.isSymbolicLink()) {
    registerEntry(before, relative, state, limits);
    if (before.size > BigInt(limits.symlinkBytes)) throw new Error(`tooling closure symlink '${relative}' exceeds ${limits.symlinkBytes}-byte limit`);
    const target = await readlink(anchoredPath);
    const targetBytes = Buffer.byteLength(target);
    if (targetBytes > limits.symlinkBytes) throw new Error(`tooling closure symlink '${relative}' exceeds ${limits.symlinkBytes}-byte limit`);
    state.bytes += targetBytes;
    if (state.bytes > limits.totalBytes) throw new Error(`tooling closure exceeds ${limits.totalBytes}-byte limit`);
    const resolved = await realpath(anchoredPath);
    if (!isWithin(configuredRoot, resolved)) throw new Error(`tooling closure symlink '${relative}' escapes its root`);
    const after = await lstat(anchoredPath, { bigint: true });
    if (!sameStat(before, after)) throw new Error(`tooling closure symlink '${relative}' changed while it was being read`);
    entries.push({ path: relative, type: 'symlink', mode: fileMode(before), targetBase64: Buffer.from(target).toString('base64') });
    return;
  }
  if (before.isDirectory()) {
    let child;
    try {
      child = await openAnchoredDirectory(anchoredPath, `tooling closure directory '${relative}'`, options.openDirectory);
      const opened = await child.stat({ bigint: true });
      if (!sameStat(before, opened)) throw new Error(`tooling closure directory '${relative}' changed while it was opened`);
      await visitToolingDirectory(child, configuredRoot, relative, depth, opened, entries, state, options, limits);
    } finally {
      await child?.close();
    }
    await verifyAnchoredChild(anchoredPath, before, relative);
    return;
  }
  if (!before.isFile()) throw new Error(`tooling closure contains unsupported entry '${relative}'`);
  registerEntry(before, relative, state, limits);
  state.files += 1;
  if (state.files > limits.files) throw new Error(`tooling closure exceeds ${limits.files}-file limit`);
  let child;
  try {
    child = await (options.openFile ?? open)(anchoredPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await child.stat({ bigint: true });
    if (!opened.isFile() || !sameStat(before, opened)) throw new Error(`tooling closure file '${relative}' changed while it was opened`);
    const bytes = await readDescriptorWithinLimit(child, opened, limits.fileBytes, `tooling closure file '${relative}'`);
    const after = await child.stat({ bigint: true });
    if (!sameStat(opened, after)) throw new Error(`tooling closure file '${relative}' changed while it was being read`);
    state.bytes += bytes.length;
    if (state.bytes > limits.totalBytes) throw new Error(`tooling closure exceeds ${limits.totalBytes}-byte limit`);
    entries.push({ path: relative, type: 'file', mode: fileMode(opened), bytes: bytes.length, digest: sha256(bytes) });
  } finally {
    await child?.close();
  }
  await verifyAnchoredChild(anchoredPath, before, relative);
}

async function openAnchoredDirectory(directory, label, openDirectoryFunction = open) {
  try {
    return await openDirectoryFunction(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ELOOP') throw new Error(`${label} is not a real directory`);
    throw error;
  }
}

async function readDescriptorWithinLimit(handle, information, maximum, label) {
  if (information.size > BigInt(maximum)) throw new Error(`${label} exceeds ${maximum}-byte limit`);
  const bytes = Buffer.allocUnsafe(Math.min(maximum + 1, Number(information.size) + 1));
  let offset = 0;
  for (;;) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
    offset += bytesRead;
    if (offset > maximum) throw new Error(`${label} exceeds ${maximum}-byte limit`);
    if (bytesRead === 0) return bytes.subarray(0, offset);
  }
}

function registerEntry(information, relative, state, limits) {
  if (state.aliases.size >= limits.entries) throw new Error(`tooling closure exceeds ${limits.entries}-entry limit`);
  const identity = `${information.dev}:${information.ino}`;
  if (state.aliases.has(identity)) throw new Error(`tooling closure entry '${relative}' aliases another entry`);
  state.aliases.add(identity);
}

async function verifyConfiguredRoot(handle, configuredRoot, expected) {
  const descriptor = await handle.stat({ bigint: true });
  let current;
  try {
    current = await lstat(configuredRoot, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`tooling closure root changed while it was being read: ${configuredRoot}`);
    throw error;
  }
  if (!current.isDirectory() || current.isSymbolicLink() || !sameStat(expected, descriptor) || !sameStat(expected, current)) {
    throw new Error(`tooling closure root changed while it was being read: ${configuredRoot}`);
  }
}

async function verifyAnchoredChild(anchoredPath, expected, relative) {
  let current;
  try {
    current = await lstat(anchoredPath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`tooling closure entry '${relative}' changed while it was being read`);
    throw error;
  }
  if (!sameStat(expected, current)) throw new Error(`tooling closure entry '${relative}' changed while it was being read`);
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function fileMode(information) {
  return (Number(information.mode) & 0o7777).toString(8).padStart(4, '0');
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function runProcess(program, args, options = {}) {
  const startedAt = new Date().toISOString();
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(program, args, {
        cwd: options.cwd,
        env: options.env ?? controlledEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolve(failedProcess(program, args, options, startedAt, timeoutMs, error));
      return;
    }
    const stdout = [];
    const stderr = [];
    let retainedBytes = 0;
    let observedBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let spawnError = null;
    let settled = false;
    const maximum = options.maxOutputBytes ?? 16 * 1024 * 1024;
    const collect = target => chunk => {
      observedBytes += chunk.length;
      const remaining = maximum - retainedBytes;
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        target.push(retained);
        retainedBytes += retained.length;
      }
      if (observedBytes > maximum && !outputLimitExceeded) {
        outputLimitExceeded = true;
        terminate(child);
      }
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', error => { spawnError = error instanceof Error ? error.message : String(error); });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, timeoutMs);
    timer.unref();
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        argv: [options.recordedProgram ?? program, ...args],
        cwd: options.recordedCwd ?? options.cwd ?? process.cwd(),
        startedAt,
        completedAt: new Date().toISOString(),
        timeoutMs,
        timedOut,
        outputLimitExceeded,
        observedOutputBytes: observedBytes,
        exitStatus: code,
        signal,
        spawnError,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    child.stdin.on('error', () => {});
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}

function failedProcess(program, args, options, startedAt, timeoutMs, error) {
  return {
    argv: [options.recordedProgram ?? program, ...args], cwd: options.recordedCwd ?? options.cwd ?? process.cwd(), startedAt,
    completedAt: new Date().toISOString(), timeoutMs, timedOut: false,
    outputLimitExceeded: false, observedOutputBytes: 0, exitStatus: null, signal: null,
    spawnError: error instanceof Error ? error.message : String(error),
    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
  };
}

function terminate(child) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {}
}

export function commandSucceeded(result) {
  return result.exitStatus === 0 && result.signal === null && result.timedOut === false &&
    result.outputLimitExceeded === false && result.spawnError === null;
}

export function commandRecord(result) {
  return {
    argv: result.argv,
    cwd: result.cwd,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    timeoutMs: result.timeoutMs,
    timedOut: result.timedOut,
    outputLimitExceeded: result.outputLimitExceeded,
    observedOutputBytes: result.observedOutputBytes,
    exitStatus: result.exitStatus,
    signal: result.signal,
    spawnError: result.spawnError,
    stdoutBase64: result.stdout.toString('base64'),
    stderrBase64: result.stderr.toString('base64'),
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
  };
}

export function parseJsonBytes(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`${label} returned invalid JSON: ${error.message}`); }
}

export function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

export function requireContract(value, expected) {
  requireObject(value, 'request');
  if (value.contract !== expected) throw new Error(`expected ${expected}`);
}
