import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';

export const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export async function fileIdentity(file) {
  const bytes = await readFile(file);
  return { path: file, realpath: await realpath(file), digest: sha256(bytes), bytes: bytes.length };
}

export async function runProcess(program, args, options = {}) {
  const startedAt = new Date().toISOString();
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let timedOut = false;
    const maximum = options.maxOutputBytes ?? 16 * 1024 * 1024;
    const collect = target => chunk => {
      bytes += chunk.length;
      if (bytes > maximum) {
        terminate(child);
        reject(new Error(`command output exceeded ${maximum} bytes`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, timeoutMs);
    timer.unref();
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        argv: [program, ...args],
        cwd: options.cwd ?? process.cwd(),
        startedAt,
        completedAt: new Date().toISOString(),
        timeoutMs,
        timedOut,
        exitStatus: code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}

function terminate(child) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {}
}

export function commandRecord(result) {
  return {
    argv: result.argv,
    cwd: result.cwd,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    timeoutMs: result.timeoutMs,
    timedOut: result.timedOut,
    exitStatus: result.exitStatus,
    signal: result.signal,
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
