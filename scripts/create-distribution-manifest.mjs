import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'distribution-manifest.json');
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

const files = [];
for (const relativePath of runtimeFiles) {
  const bytes = await readFile(path.join(root, relativePath));
  files.push({
    path: relativePath,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
const expected = `${JSON.stringify({ contract: 'mdlm-demo-runner-distribution@1', files }, null, 2)}\n`;

if (process.argv[2] === '--check') {
  let actual;
  try {
    actual = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('distribution-manifest.json is missing; run npm run manifest');
    throw error;
  }
  if (actual !== expected) throw new Error('distribution-manifest.json is stale; run npm run manifest');
} else if (process.argv.length === 2) {
  await writeFile(manifestPath, expected);
} else {
  throw new Error('usage: create-distribution-manifest.mjs [--check]');
}
