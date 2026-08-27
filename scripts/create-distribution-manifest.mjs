import { createHash } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'distribution-manifest.json');
const templatePath = path.join(root, 'scripts', 'launcher-template.mjs');
const runtimeFiles = [
  'package.json',
  'scripts/create-distribution-manifest.mjs',
  'scripts/inspect-package.mjs',
  'scripts/launcher-template.mjs',
  'src/adapter.mjs',
  'src/canonical-file.mjs',
  'src/classify.mjs',
  'src/cli.mjs',
  'src/contracts.mjs',
  'src/decision-catalog.mjs',
  'src/evidence.mjs',
  'src/orchestrator.mjs',
  'src/process-package.mjs',
  'src/shim-cli.mjs',
  'src/util.mjs',
];
const launchers = [
  {
    path: 'bin/mdlm-demo-mdlm-shim.mjs',
    mode: 0o755,
    entrypoint: 'src/shim-cli.mjs',
    export: 'executeShim',
    errorContract: 'mdlm-demo-shim-error@1',
    errorExitStatus: 98,
    integrity: 'authenticated-launcher-embeds-distribution-manifest-sha256',
  },
  {
    path: 'bin/mdlm-demo-runner.mjs',
    mode: 0o755,
    entrypoint: 'src/cli.mjs',
    export: 'executeCli',
    errorContract: 'mdlm-demo-error@1',
    errorExitStatus: 1,
    integrity: 'authenticated-launcher-embeds-distribution-manifest-sha256',
  },
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function generatedFiles() {
  const packageMetadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const files = [];
  for (const relativePath of runtimeFiles) {
    const bytes = await readFile(path.join(root, relativePath));
    files.push({ path: relativePath, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const publicLaunchers = launchers.map(({ errorContract, errorExitStatus, ...launcher }) => launcher);
  const manifestBytes = Buffer.from(`${JSON.stringify({
    contract: 'mdlm-demo-runner-distribution@2',
    authority: 'external-release-and-install-manifest',
    package: {
      name: packageMetadata.name,
      version: packageMetadata.version,
      metadata: 'package.json',
    },
    launchers: publicLaunchers,
    files,
  }, null, 2)}\n`);
  const manifestSha256 = sha256(manifestBytes);
  const template = await readFile(templatePath, 'utf8');
  const outputs = new Map([[manifestPath, manifestBytes]]);
  for (const launcher of launchers) {
    const source = template
      .replace("'__MANIFEST_SHA256__'", JSON.stringify(manifestSha256))
      .replace("'__LAUNCHER_PATH__'", JSON.stringify(launcher.path))
      .replace("'__ENTRYPOINT__'", JSON.stringify(launcher.entrypoint))
      .replace("'__ENTRY_EXPORT__'", JSON.stringify(launcher.export))
      .replace("'__ERROR_CONTRACT__'", JSON.stringify(launcher.errorContract))
      .replace('__ERROR_EXIT_STATUS__', String(launcher.errorExitStatus));
    outputs.set(path.join(root, launcher.path), Buffer.from(source));
  }
  return outputs;
}

const outputs = await generatedFiles();
if (process.argv[2] === '--check' && process.argv.length === 3) {
  for (const [file, expected] of outputs) {
    let actual;
    try {
      actual = await readFile(file);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`${path.relative(root, file)} is missing; run npm run manifest`);
      throw error;
    }
    if (!actual.equals(expected)) throw new Error(`${path.relative(root, file)} is stale; run npm run manifest`);
  }
} else if (process.argv.length === 2) {
  for (const [file, bytes] of outputs) await writeFile(file, bytes);
  for (const launcher of launchers) await chmod(path.join(root, launcher.path), launcher.mode);
} else {
  throw new Error('usage: create-distribution-manifest.mjs [--check]');
}
