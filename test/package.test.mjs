import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import {
  chmod, copyFile, cp, lstat, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rename, rm,
  stat, symlink, utimes, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeFiles = [
  'package.json',
  'scripts/create-distribution-manifest.mjs',
  'scripts/inspect-package.mjs',
  'scripts/launcher-template.mjs',
  'scripts/validate-runner-install.mjs',
  'src/canonical-file.mjs',
  'src/cli.mjs',
  'src/reviewer-lease.mjs',
  'src/runner.mjs',
  'src/strict-json.mjs',
  'src/util.mjs',
];
const launcherFiles = ['bin/mdlm-demo-runner.mjs'];
const packageFiles = [
  'README.md',
  ...launcherFiles,
  'distribution-manifest.json',
  ...runtimeFiles,
].sort();
const publicCommands = ['run', 'reviewer-lease'];
const expectedHelp = `${JSON.stringify({
  contract: 'mdlm-demo-help@1',
  usage: `mdlm-demo-runner ${publicCommands.join('|')} [--input file]`,
  commands: publicCommands,
})}\n`;

test('npm test selects supported top-level tests and preserves historical red evidence', async () => {
  const packageMetadata = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8'));
  assert.equal(packageMetadata.scripts.test, 'node --test --test-concurrency=1 test/*.test.mjs');
  const historicalEvidence = new Map([
    ['test/evidence/issue-24-parent-red-invalid/preflight.test.mjs', '08784062b897b86ca5c913a09f03d8643747169a57018e700621a54f4bda52a8'],
    ['test/evidence/issue-24-parent-red/preflight.test.mjs', '2e98c3e2a2de487eaff9139213b7d62544dcd5bbae3860df7837998e46131088'],
  ]);
  for (const [file, expectedDigest] of historicalEvidence) {
    assert.equal(digest('sha256', await readFile(path.join(repository, file))), expectedDigest, file);
  }
});

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

async function listTree(directory, prefix = '') {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      entries.push({ path: `${relativePath}/`, type: 'directory', mode: (await lstat(absolutePath)).mode & 0o777 });
      entries.push(...await listTree(absolutePath, relativePath));
    } else if (entry.isSymbolicLink()) {
      entries.push({ path: relativePath, type: 'symlink', target: await readlink(absolutePath) });
    } else {
      const metadata = await lstat(absolutePath);
      entries.push({
        path: relativePath,
        type: 'file',
        mode: metadata.mode & 0o777,
        bytes: metadata.size,
        sha256: digest('sha256', await readFile(absolutePath)),
        mtimeMs: metadata.mtimeMs,
      });
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function stagePackage(source) {
  for (const directory of ['bin', 'scripts', 'src']) await mkdir(path.join(source, directory), { recursive: true });
  for (const file of ['package.json', 'README.md', 'distribution-manifest.json']) {
    await copyFile(path.join(repository, file), path.join(source, file));
  }
  for (const directory of ['bin', 'scripts', 'src']) {
    await cp(path.join(repository, directory), path.join(source, directory), { recursive: true });
  }
}

async function makeReadOnly(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await makeReadOnly(file);
      await chmod(file, 0o555);
    } else if (!entry.isSymbolicLink()) {
      await chmod(file, launcherFiles.some(relative => file.endsWith(relative)) ? 0o555 : 0o444);
    }
  }
  await chmod(directory, 0o555);
}

async function removeScratch(directory) {
  try {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await removeScratch(path.join(directory, entry.name));
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await rm(directory, { recursive: true, force: true });
}

function tarHeader(name, type = '0', body = Buffer.alloc(0), mode = 0o644, linkname = '') {
  const header = Buffer.alloc(512);
  const put = (value, offset, length) => header.write(value, offset, Math.min(Buffer.byteLength(value), length), 'utf8');
  const octal = (value, length) => `${value.toString(8).padStart(length - 1, '0')}\0`;
  put(name, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(body.length, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  header.fill(0x20, 148, 156);
  put(type, 156, 1);
  put(linkname, 157, 100);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  put(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

function archive(entries) {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]), { mtime: 0 });
}

async function verificationImportSwap(executable, packageRoot, cwd) {
  const cli = path.join(packageRoot, 'src', 'cli.mjs');
  const runner = path.join(packageRoot, 'src', 'runner.mjs');
  await chmod(path.dirname(cli), 0o755);
  await chmod(cli, 0o644);
  const malicious = path.join(packageRoot, 'src', 'cli.swap.mjs');
  await writeFile(malicious, 'process.stdout.write("SWAPPED MODULE EXECUTED\\n");\n');
  const oldTime = new Date(1_000);
  await utimes(runner, oldTime, oldTime);
  const beforeAtime = (await stat(runner)).atimeMs;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, '--help'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let swapped = false;
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const interval = setInterval(async () => {
      if (swapped) return;
      try {
        const currentAtime = (await stat(runner)).atimeMs;
        if (!swapped && currentAtime !== beforeAtime) {
          swapped = true;
          await rename(malicious, cli);
        }
      } catch (error) {
        clearInterval(interval);
        reject(error);
      }
    }, 0);
    child.once('error', error => { clearInterval(interval); reject(error); });
    child.once('close', status => {
      clearInterval(interval);
      resolve({ status, stdout, stderr, swapped });
    });
  });
}

test('npm package has an externally authenticated, source-independent, read-only install closure', async (context) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-demo-package-'));
  context.after(() => removeScratch(scratch));
  const source = path.join(scratch, 'source');
  const replica = path.join(scratch, 'source-replica');
  const artifacts = path.join(scratch, 'artifacts');
  const replicaArtifacts = path.join(scratch, 'replica-artifacts');
  const repackedArtifacts = path.join(scratch, 'repacked-artifacts');
  const installRoot = path.join(scratch, 'isolated-install');
  for (const directory of [source, replica, artifacts, replicaArtifacts, repackedArtifacts]) await mkdir(directory);
  await stagePackage(source);
  await stagePackage(replica);

  const packed = await exec('npm', ['pack', '--json', '--pack-destination', artifacts], { cwd: source });
  const replicaPacked = await exec('npm', ['pack', '--json', '--pack-destination', replicaArtifacts], { cwd: replica });
  const [packResult] = JSON.parse(packed.stdout);
  const [replicaPackResult] = JSON.parse(replicaPacked.stdout);
  assert.deepEqual(packResult.files.map(({ path: file }) => file).sort(), packageFiles);
  for (const launcher of launcherFiles) {
    assert.equal(packResult.files.find(({ path: file }) => file === launcher).mode, 0o755, launcher);
  }

  const tarball = path.join(artifacts, packResult.filename);
  const replicaTarball = path.join(replicaArtifacts, replicaPackResult.filename);
  const tarballBytes = await readFile(tarball);
  assert.deepEqual(tarballBytes, await readFile(replicaTarball));
  assert.equal(digest('sha1', tarballBytes), packResult.shasum);
  assert.equal(`sha512-${digest('sha512', tarballBytes, 'base64')}`, packResult.integrity);
  const archiveSha256 = digest('sha256', tarballBytes);

  const inspected = await run(process.execPath, [path.join(source, 'scripts', 'inspect-package.mjs'), tarball]);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.deepEqual(JSON.parse(inspected.stdout).files, packageFiles);

  const manifestBytes = await readFile(path.join(source, 'distribution-manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.contract, 'mdlm-demo-runner-distribution@2');
  assert.deepEqual(manifest.package, { name: 'mdlm-demo-orchestrator', version: '0.1.0', metadata: 'package.json' });
  assert.deepEqual(manifest.launchers.map(({ path: file }) => file), launcherFiles);
  assert.deepEqual(manifest.files.map(({ path: file }) => file), runtimeFiles);
  for (const entry of manifest.files) {
    const bytes = await readFile(path.join(source, entry.path));
    assert.equal(entry.bytes, bytes.length, entry.path);
    assert.equal(entry.sha256, digest('sha256', bytes), entry.path);
  }
  const manifestSha256 = digest('sha256', manifestBytes);
  for (const launcher of launcherFiles) {
    assert.match(await readFile(path.join(source, launcher), 'utf8'), new RegExp(manifestSha256));
  }

  await rm(source, { recursive: true });
  await rm(replica, { recursive: true });
  await mkdir(installRoot);
  await writeFile(path.join(installRoot, 'package.json'), '{"private":true}\n');
  await exec('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball,
  ], { cwd: installRoot });

  const packageRoot = path.join(installRoot, 'node_modules', 'mdlm-demo-orchestrator');
  assert.deepEqual((await listTree(packageRoot)).filter(entry => entry.type === 'file').map(entry => entry.path).sort(), packageFiles);
  const installedExecutable = path.join(packageRoot, 'bin', 'mdlm-demo-runner.mjs');
  const publicExecutable = path.join(installRoot, 'node_modules', '.bin', 'mdlm-demo-runner');
  assert.equal(await realpath(publicExecutable), installedExecutable);

  const repacked = await exec('npm', ['pack', '--json', '--pack-destination', repackedArtifacts], { cwd: packageRoot });
  const [repackedResult] = JSON.parse(repacked.stdout);
  assert.deepEqual(await readFile(path.join(repackedArtifacts, repackedResult.filename)), tarballBytes);

  await makeReadOnly(packageRoot);
  const installedTree = await listTree(packageRoot);
  const installManifest = {
    contract: 'mdlm-demo-runner-install@1',
    archive: { bytes: tarballBytes.length, sha256: archiveSha256 },
    package: {
      name: manifest.package.name,
      version: manifest.package.version,
      distributionManifestSha256: manifestSha256,
      tree: installedTree,
    },
    launchers: await Promise.all(launcherFiles.map(async file => ({
      path: file,
      mode: (await stat(path.join(packageRoot, file))).mode & 0o777,
      sha256: digest('sha256', await readFile(path.join(packageRoot, file))),
    }))),
    executable: {
      path: 'node_modules/.bin/mdlm-demo-runner',
      target: path.relative(installRoot, await realpath(publicExecutable)),
      mode: (await stat(publicExecutable)).mode & 0o777,
      sha256: digest('sha256', await readFile(publicExecutable)),
    },
  };
  assert.deepEqual(installManifest.launchers.map(({ mode }) => mode), [0o555]);
  assert.equal(installManifest.executable.mode, 0o555);
  assert.equal(installManifest.executable.sha256, installManifest.launchers[0].sha256);
  const beforeHelp = installedTree;
  for (const args of [['--help'], ...publicCommands.map(command => [command, '--help'])]) {
    const smoke = await run(process.execPath, [
      '--permission', `--allow-fs-read=${installRoot}`, publicExecutable, ...args,
    ], { cwd: installRoot });
    assert.equal(smoke.status, 0, `${args.join(' ')}: ${smoke.stderr}`);
    assert.equal(smoke.stdout, expectedHelp, args.join(' '));
    assert.equal(smoke.stderr, '', args.join(' '));
  }
  const removedCommand = spawnSync(process.execPath, [
    '--permission', `--allow-fs-read=${installRoot}`, publicExecutable, 'snapshot',
  ], { cwd: installRoot, input: '', encoding: 'utf8' });
  assert.equal(removedCommand.status, 1, removedCommand.stderr);
  assert.equal(removedCommand.stdout, '');
  assert.match(removedCommand.stderr, /mdlm-demo-error@1/);
  assert.deepEqual(await listTree(packageRoot), beforeHelp);
});

test('launcher rejects source and manifest mutation, external symlinks, and verification/import swaps', async (context) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-demo-attacks-'));
  context.after(() => removeScratch(scratch));
  const pristine = path.join(scratch, 'pristine');
  await stagePackage(pristine);

  const updatedManifestRoot = path.join(scratch, 'updated-manifest');
  await cp(pristine, updatedManifestRoot, { recursive: true });
  const changed = path.join(updatedManifestRoot, 'src', 'runner.mjs');
  await writeFile(changed, Buffer.concat([await readFile(changed), Buffer.from('\n// changed with manifest\n')]));
  const manifestPath = path.join(updatedManifestRoot, 'distribution-manifest.json');
  const changedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const changedEntry = changedManifest.files.find(entry => entry.path === 'src/runner.mjs');
  const changedBytes = await readFile(changed);
  changedEntry.bytes = changedBytes.length;
  changedEntry.sha256 = digest('sha256', changedBytes);
  await writeFile(manifestPath, `${JSON.stringify(changedManifest, null, 2)}\n`);
  const updatedManifest = await run(process.execPath, [path.join(updatedManifestRoot, 'bin', 'mdlm-demo-runner.mjs'), '--help']);
  assert.equal(updatedManifest.status, 1);
  assert.equal(updatedManifest.stdout, '');
  assert.match(updatedManifest.stderr, /artifact closure invalid: distribution manifest SHA-256 mismatch/);

  const symlinkRoot = path.join(scratch, 'external-symlink');
  await cp(pristine, symlinkRoot, { recursive: true });
  const dependency = path.join(symlinkRoot, 'src', 'runner.mjs');
  const outside = path.join(scratch, 'outside.mjs');
  await copyFile(dependency, outside);
  await rm(dependency);
  await symlink(outside, dependency);
  const symlinked = await run(process.execPath, [path.join(symlinkRoot, 'bin', 'mdlm-demo-runner.mjs'), '--help']);
  assert.equal(symlinked.status, 1);
  assert.equal(symlinked.stdout, '');
  assert.match(symlinked.stderr, /artifact closure invalid: .*src\/runner\.mjs.*(symbolic link|outside package root)/);

  const swapRoot = path.join(scratch, 'swap');
  await cp(pristine, swapRoot, { recursive: true });
  const swapped = await verificationImportSwap(
    path.join(swapRoot, 'bin', 'mdlm-demo-runner.mjs'), swapRoot, swapRoot,
  );
  assert.equal(swapped.swapped, true);
  assert.doesNotMatch(swapped.stdout, /SWAPPED MODULE EXECUTED/);
  assert.equal(swapped.status, 1);
  assert.match(swapped.stderr, /artifact closure invalid: src\/cli\.mjs changed during module load/);
});

test('archive inspection rejects traversal, links, special file types, and unsafe modes', async (context) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-demo-archive-attacks-'));
  context.after(() => removeScratch(scratch));
  const inspector = path.join(repository, 'scripts', 'inspect-package.mjs');
  const attacks = [
    ['path traversal', tarHeader('package/../outside.mjs')],
    ['absolute path', tarHeader('/tmp/outside.mjs')],
    ['symlink', tarHeader('package/src/link.mjs', '2', Buffer.alloc(0), 0o777, '../../outside.mjs')],
    ['hard link', tarHeader('package/src/link.mjs', '1', Buffer.alloc(0), 0o644, 'package/src/cli.mjs')],
    ['character device', tarHeader('package/src/device', '3')],
    ['fifo', tarHeader('package/src/fifo', '6')],
    ['setuid mode', tarHeader('package/src/unsafe.mjs', '0', Buffer.from('x'), 0o4644)],
  ];
  for (const [name, entry] of attacks) {
    const file = path.join(scratch, `${name.replaceAll(' ', '-')}.tgz`);
    await writeFile(file, archive([entry]));
    const result = await run(process.execPath, [inspector, file]);
    assert.equal(result.status, 1, name);
    assert.equal(result.stdout, '', name);
    assert.match(result.stderr, /unsafe package archive:/, name);
  }
});
