#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const expectedManifestSha256 = "4f9e42045ad99ef0211df6db834fbd93b953dbd20c0c75bdc860ce74db53c1f7";
const launcherPath = "bin/mdlm-demo-mdlm-shim.mjs";
const entrypoint = "src/shim-cli.mjs";
const entryExport = "executeShim";
const errorContract = "mdlm-demo-shim-error@1";
const errorExitStatus = 98;
const manifestLimit = 64 * 1024;
const payloadLimit = 4 * 1024 * 1024;

function closureError(message) {
  return new Error(`artifact closure invalid: ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function validateRelativePath(relativePath) {
  if (typeof relativePath !== 'string'
    || relativePath.length === 0
    || relativePath.includes('\\')
    || relativePath.startsWith('/')
    || path.posix.normalize(relativePath) !== relativePath
    || relativePath.split('/').some(part => part.length === 0 || part === '.' || part === '..')) {
    throw closureError(`unsafe distribution path ${JSON.stringify(relativePath)}`);
  }
}

async function readContainedFile(packageRoot, relativePath, limit, expected = null) {
  validateRelativePath(relativePath);
  const target = path.join(packageRoot, ...relativePath.split('/'));
  const rootPrefix = `${packageRoot}${path.sep}`;
  if (!target.startsWith(rootPrefix)) throw closureError(`${relativePath} is outside package root`);

  let current = packageRoot;
  for (const component of relativePath.split('/')) {
    current = path.join(current, component);
    let metadata;
    try {
      metadata = await lstat(current, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT') throw closureError(`missing ${relativePath}`);
      throw closureError(`cannot inspect ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (metadata.isSymbolicLink()) throw closureError(`${relativePath} is a symbolic link`);
  }

  let canonical;
  try {
    canonical = await realpath(target);
  } catch (error) {
    throw closureError(`cannot resolve ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!canonical.startsWith(rootPrefix)) throw closureError(`${relativePath} is outside package root`);

  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw closureError(`${relativePath} is not a regular file`);
    if (before.size > BigInt(limit)) throw closureError(`${relativePath} exceeds ${limit}-byte limit`);
    if (expected !== null && before.size !== BigInt(expected.bytes)) {
      throw closureError(`byte length mismatch for ${relativePath}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameFile(before, after) || BigInt(bytes.length) !== before.size) {
      throw closureError(`${relativePath} changed while being read`);
    }
    const pathMetadata = await lstat(target, { bigint: true });
    if (pathMetadata.isSymbolicLink() || !sameFile(after, pathMetadata)) {
      throw closureError(`${relativePath} changed while being read`);
    }
    if (await realpath(target) !== canonical) throw closureError(`${relativePath} changed while being read`);
    const actualSha256 = sha256(bytes);
    if (expected !== null && actualSha256 !== expected.sha256) {
      throw closureError(`SHA-256 mismatch for ${relativePath}`);
    }
    return { bytes, canonical, metadata: after, sha256: actualSha256 };
  } catch (error) {
    if (error?.code === 'ELOOP') throw closureError(`${relativePath} is a symbolic link`);
    if (error?.code === 'ENOENT') throw closureError(`missing ${relativePath}`);
    throw error;
  } finally {
    await handle?.close();
  }
}

function validateManifest(manifest) {
  if (manifest?.contract !== 'mdlm-demo-runner-distribution@2'
    || manifest.package?.name !== 'mdlm-demo-orchestrator'
    || manifest.package?.version !== '0.1.0'
    || manifest.package?.metadata !== 'package.json'
    || manifest.authority !== 'external-release-and-install-manifest'
    || !Array.isArray(manifest.launchers)
    || !Array.isArray(manifest.files)) {
    throw closureError('invalid distribution-manifest.json contract');
  }
  const ownLauncher = manifest.launchers.find(entry => entry?.path === launcherPath);
  if (ownLauncher?.mode !== 493
    || ownLauncher.entrypoint !== entrypoint
    || ownLauncher.export !== entryExport
    || ownLauncher.integrity !== 'authenticated-launcher-embeds-distribution-manifest-sha256') {
    throw closureError(`invalid launcher metadata for ${launcherPath}`);
  }
  if (manifest.files.length === 0) throw closureError('empty distribution payload');
  let previous = '';
  let total = 0;
  for (const entry of manifest.files) {
    validateRelativePath(entry?.path);
    if (entry.path <= previous
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw closureError(`invalid distribution manifest entry for ${String(entry?.path)}`);
    }
    previous = entry.path;
    total += entry.bytes;
    if (!Number.isSafeInteger(total) || total > payloadLimit) throw closureError('distribution payload exceeds bounded size');
  }
}

async function verifyUnchanged(packageRoot, snapshots) {
  for (const [relativePath, original] of snapshots) {
    let current;
    try {
      current = await readContainedFile(packageRoot, relativePath, original.bytes.length, {
        bytes: original.bytes.length,
        sha256: original.sha256,
      });
    } catch {
      throw closureError(`${relativePath} changed during module load`);
    }
    if (!sameFile(current.metadata, original.metadata) || current.canonical !== original.canonical) {
      throw closureError(`${relativePath} changed during module load`);
    }
  }
}

async function start() {
  const packageRoot = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const manifestRecord = await readContainedFile(packageRoot, 'distribution-manifest.json', manifestLimit);
  if (manifestRecord.sha256 !== expectedManifestSha256) {
    throw closureError('distribution manifest SHA-256 mismatch');
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestRecord.bytes.toString('utf8'));
  } catch (error) {
    throw closureError(`cannot parse distribution-manifest.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateManifest(manifest);

  const snapshots = new Map();
  const moduleSources = new Map();
  for (const entry of manifest.files) {
    const record = await readContainedFile(packageRoot, entry.path, entry.bytes, entry);
    snapshots.set(entry.path, record);
    if (entry.path.endsWith('.mjs')) {
      moduleSources.set(pathToFileURL(path.join(packageRoot, ...entry.path.split('/'))).href, record.bytes);
    }
  }
  const entryUrl = pathToFileURL(path.join(packageRoot, ...entrypoint.split('/'))).href;
  if (!moduleSources.has(entryUrl)) throw closureError(`entrypoint ${entrypoint} is absent from distribution payload`);

  registerHooks({
    load(url, context, nextLoad) {
      const source = moduleSources.get(url);
      if (source === undefined) return nextLoad(url, context);
      return { format: 'module', shortCircuit: true, source };
    },
  });
  const loaded = await import(entryUrl);
  await verifyUnchanged(packageRoot, snapshots);
  if (typeof loaded[entryExport] !== 'function') throw closureError(`${entrypoint} does not export ${entryExport}`);
  await loaded[entryExport](process.argv.slice(2));
}

try {
  await start();
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    contract: errorContract,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = errorExitStatus;
}
