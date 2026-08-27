#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const runtimeFiles = [
  'bin/mdlm-demo-mdlm-shim.mjs',
  'src/adapter.mjs',
  'src/canonical-file.mjs',
  'src/classify.mjs',
  'src/cli.mjs',
  'src/contracts.mjs',
  'src/decision-catalog.mjs',
  'src/evidence.mjs',
  'src/orchestrator.mjs',
  'src/process-package.mjs',
  'src/util.mjs',
];

function closureError(message) {
  return new Error(`artifact closure invalid: ${message}`);
}

async function verifyArtifactClosure() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(new URL('../distribution-manifest.json', import.meta.url), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw closureError('missing distribution-manifest.json');
    throw closureError(`cannot read distribution-manifest.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest?.contract !== 'mdlm-demo-runner-distribution@1' || !Array.isArray(manifest.files)) {
    throw closureError('invalid distribution-manifest.json contract');
  }
  if (manifest.files.length !== runtimeFiles.length) throw closureError('distribution manifest file set mismatch');
  for (const [index, expectedPath] of runtimeFiles.entries()) {
    const entry = manifest.files[index];
    if (entry?.path !== expectedPath
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw closureError(`invalid distribution manifest entry for ${expectedPath}`);
    }
    let bytes;
    try {
      bytes = await readFile(new URL(`../${expectedPath}`, import.meta.url));
    } catch (error) {
      if (error?.code === 'ENOENT') throw closureError(`missing ${expectedPath}`);
      throw closureError(`cannot read ${expectedPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (bytes.length !== entry.bytes) throw closureError(`byte length mismatch for ${expectedPath}`);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== entry.sha256) throw closureError(`SHA-256 mismatch for ${expectedPath}`);
  }
}

try {
  await verifyArtifactClosure();
  await import('../src/cli.mjs');
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    contract: 'mdlm-demo-error@1',
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
}
