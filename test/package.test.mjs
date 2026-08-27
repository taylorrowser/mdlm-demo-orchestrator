import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod, copyFile, cp, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const packageFiles = [
  'README.md',
  'bin/mdlm-demo-mdlm-shim.mjs',
  'bin/mdlm-demo-runner.mjs',
  'distribution-manifest.json',
  'package.json',
  ...runtimeFiles.filter((file) => file.startsWith('src/')),
].sort();
const publicCommands = [
  'snapshot',
  'classify',
  'decision-catalog-build',
  'decision-catalog-validate',
  'run',
  'resume',
  'reconcile',
];

function digest(algorithm, bytes, encoding = 'hex') {
  return createHash(algorithm).update(bytes).digest(encoding);
}

async function run(executable, args, options = {}) {
  try {
    const result = await exec(executable, args, { encoding: 'utf8', ...options });
    return { status: 0, ...result };
  } catch (error) {
    return {
      status: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

async function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), relativePath));
    else files.push(relativePath);
  }
  return files.sort();
}

async function stagePackage(source) {
  await mkdir(path.join(source, 'bin'), { recursive: true });
  await mkdir(path.join(source, 'src'), { recursive: true });
  await mkdir(path.join(source, 'scripts'), { recursive: true });
  for (const file of ['package.json', 'README.md', 'distribution-manifest.json']) {
    await copyFile(path.join(repository, file), path.join(source, file));
  }
  await cp(path.join(repository, 'bin'), path.join(source, 'bin'), { recursive: true });
  await cp(path.join(repository, 'src'), path.join(source, 'src'), { recursive: true });
  await copyFile(
    path.join(repository, 'scripts/create-distribution-manifest.mjs'),
    path.join(source, 'scripts/create-distribution-manifest.mjs'),
  );
}

test('npm package is an exact runnable and integrity-checked dependency closure', async (context) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-demo-package-'));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const source = path.join(scratch, 'source');
  const replica = path.join(scratch, 'source-replica');
  const artifacts = path.join(scratch, 'artifacts');
  const replicaArtifacts = path.join(scratch, 'replica-artifacts');
  const installRoot = path.join(scratch, 'isolated-install');
  for (const directory of [source, replica, artifacts, replicaArtifacts, installRoot]) await mkdir(directory);
  await stagePackage(source);
  await stagePackage(replica);

  const packed = await exec('npm', ['pack', '--json', '--pack-destination', artifacts], {
    cwd: source,
    encoding: 'utf8',
  });
  const replicaPacked = await exec('npm', ['pack', '--json', '--pack-destination', replicaArtifacts], {
    cwd: replica,
    encoding: 'utf8',
  });
  const [packResult] = JSON.parse(packed.stdout);
  const [replicaPackResult] = JSON.parse(replicaPacked.stdout);
  assert.deepEqual(packResult.files.map(({ path: file }) => file).sort(), packageFiles);
  assert.equal(
    packResult.files.find(({ path: file }) => file === 'bin/mdlm-demo-runner.mjs').mode,
    0o755,
  );

  const tarball = path.join(artifacts, packResult.filename);
  const replicaTarball = path.join(replicaArtifacts, replicaPackResult.filename);
  const tarballBytes = await readFile(tarball);
  assert.deepEqual(tarballBytes, await readFile(replicaTarball));
  assert.equal(digest('sha1', tarballBytes), packResult.shasum);
  assert.equal(`sha512-${digest('sha512', tarballBytes, 'base64')}`, packResult.integrity);
  assert.match(digest('sha256', tarballBytes), /^[a-f0-9]{64}$/);

  const manifest = JSON.parse(await readFile(path.join(source, 'distribution-manifest.json'), 'utf8'));
  assert.equal(manifest.contract, 'mdlm-demo-runner-distribution@1');
  assert.deepEqual(manifest.files.map(({ path: file }) => file), runtimeFiles);
  for (const entry of manifest.files) {
    const bytes = await readFile(path.join(source, entry.path));
    assert.equal(entry.bytes, bytes.length, entry.path);
    assert.equal(entry.sha256, digest('sha256', bytes), entry.path);
  }

  await rm(source, { recursive: true });
  await rm(replica, { recursive: true });
  await writeFile(path.join(installRoot, 'package.json'), '{"private":true}\n');
  await exec('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball,
  ], { cwd: installRoot, encoding: 'utf8' });

  const packageRoot = path.join(installRoot, 'node_modules', 'mdlm-demo-orchestrator');
  assert.deepEqual(await listFiles(packageRoot), packageFiles);
  for (const file of packageFiles) {
    assert.equal(
      digest('sha256', await readFile(path.join(packageRoot, file))),
      digest('sha256', await readFile(path.join(repository, file))),
      file,
    );
  }

  const installedExecutable = path.join(packageRoot, 'bin', 'mdlm-demo-runner.mjs');
  const publicExecutable = path.join(installRoot, 'node_modules', '.bin', 'mdlm-demo-runner');
  assert.equal(await realpath(publicExecutable), installedExecutable);
  assert.equal((await stat(publicExecutable)).mode & 0o111, 0o111);
  const installedBytes = await readFile(installedExecutable);
  const sourceExecutable = await readFile(path.join(repository, 'bin', 'mdlm-demo-runner.mjs'));
  assert.deepEqual(installedBytes, sourceExecutable);
  assert.equal(digest('sha256', installedBytes), digest('sha256', sourceExecutable));
  assert.equal((await stat(installedExecutable)).mode & 0o111, 0o111);

  for (const args of [['--help'], ...publicCommands.map((command) => [command, '--help'])]) {
    const smoke = await run(publicExecutable, args, { cwd: installRoot });
    assert.equal(smoke.status, 0, `${args.join(' ')}: ${smoke.stderr}`);
    const help = JSON.parse(smoke.stdout);
    assert.equal(help.contract, 'mdlm-demo-help@1');
    assert.deepEqual(help.commands, publicCommands);
  }

  const dependency = path.join(packageRoot, 'src', 'classify.mjs');
  const missingDependency = `${dependency}.missing`;
  await rename(dependency, missingDependency);
  const missing = await run(publicExecutable, ['--help'], { cwd: installRoot });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /artifact closure invalid: missing src\/classify\.mjs/);
  await rename(missingDependency, dependency);

  await chmod(dependency, 0o644);
  await writeFile(dependency, Buffer.concat([await readFile(dependency), Buffer.from('\n// tampered\n')]));
  const tampered = await run(publicExecutable, ['--help'], { cwd: installRoot });
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /artifact closure invalid: (byte length|SHA-256) mismatch for src\/classify\.mjs/);
});
