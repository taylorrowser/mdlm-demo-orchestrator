import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

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
  return controlledEnvironment(extra, { git: true });
}

export async function fileIdentity(file) {
  const configuredPath = path.resolve(file);
  const information = await lstat(configuredPath);
  const target = await realpath(configuredPath);
  const bytes = await readFile(target);
  return {
    path: configuredPath,
    realpath: target,
    pathKind: information.isSymbolicLink() ? 'symbolic-link' : 'file',
    digest: sha256(bytes),
    bytes: bytes.length,
  };
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
        argv: [program, ...args],
        cwd: options.cwd ?? process.cwd(),
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
    argv: [program, ...args], cwd: options.cwd ?? process.cwd(), startedAt,
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
