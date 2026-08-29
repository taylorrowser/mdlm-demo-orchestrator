import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod, lstat, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rm, stat, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const validatorPath = 'scripts/validate-runner-install.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function walk(directory, prefix = '') {
  const entries = [];
  const names = await readdir(directory);
  names.sort();
  for (const name of names) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const absolute = path.join(directory, name);
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      entries.push({ path: relative, type: 'directory', mode: info.mode & 0o777 });
      entries.push(...await walk(absolute, relative));
    } else if (info.isFile()) {
      const bytes = await readFile(absolute);
      entries.push({
        path: relative,
        type: 'file',
        mode: info.mode & 0o777,
        bytes: bytes.length,
        sha256: sha256(bytes),
      });
    } else {
      throw new Error(`unexpected installed entry: ${relative}`);
    }
  }
  return entries;
}

async function makeReadOnly(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await makeReadOnly(absolute);
      await chmod(absolute, 0o555);
    } else if (!entry.isSymbolicLink()) {
      const executable = absolute.endsWith('/bin/mdlm-demo-runner.mjs');
      await chmod(absolute, executable ? 0o555 : 0o444);
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

function fileRecord(absolute) {
  return Promise.all([stat(absolute), readFile(absolute)]).then(([info, bytes]) => ({
    path: absolute,
    mode: info.mode & 0o777,
    bytes: bytes.length,
    sha256: sha256(bytes),
  }));
}

test('packed install validates itself with its installed validator and an external manifest digest', async context => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-runner-validator-'));
  context.after(() => removeScratch(scratch));
  const artifacts = path.join(scratch, 'artifacts');
  const installRoot = path.join(scratch, 'install');
  await mkdir(artifacts);
  await mkdir(installRoot);
  await writeFile(path.join(installRoot, 'package.json'), '{"private":true}\n');

  const packed = await exec('npm', ['pack', '--json', '--pack-destination', artifacts], { cwd: repository });
  const [pack] = JSON.parse(packed.stdout);
  const archivePath = path.join(artifacts, pack.filename);
  await exec('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', archivePath,
  ], { cwd: installRoot });

  const packageRoot = path.join(installRoot, 'node_modules', 'mdlm-demo-orchestrator');
  await makeReadOnly(packageRoot);
  const installedValidator = path.join(packageRoot, validatorPath);
  const validatorBytes = await readFile(installedValidator);
  const distributionPath = path.join(packageRoot, 'distribution-manifest.json');
  const distributionBytes = await readFile(distributionPath);
  const distribution = JSON.parse(distributionBytes);
  assert.equal(
    distribution.files.find(entry => entry.path === validatorPath)?.sha256,
    sha256(validatorBytes),
  );

  const archiveBytes = await readFile(archivePath);
  const packageJson = await fileRecord(path.join(packageRoot, 'package.json'));
  const launchers = await Promise.all(distribution.launchers.map(async launcher => ({
    ...launcher,
    ...await fileRecord(path.join(packageRoot, launcher.path)),
    absolutePath: path.join(packageRoot, launcher.path),
  })));
  const publicPath = path.join(installRoot, 'node_modules', '.bin', 'mdlm-demo-runner');
  const publicTarget = await realpath(publicPath);
  const publicBytes = await readFile(publicTarget);
  const installManifest = {
    contract: 'mdlm-demo-runner-install@1',
    archive: {
      path: archivePath,
      bytes: archiveBytes.length,
      sha256: sha256(archiveBytes),
    },
    package: {
      name: distribution.package.name,
      version: distribution.package.version,
      root: packageRoot,
      packageJson,
    },
    distributionManifest: {
      path: distributionPath,
      bytes: distributionBytes.length,
      sha256: sha256(distributionBytes),
      contract: distribution.contract,
      authority: distribution.authority,
      package: distribution.package,
      launchers: distribution.launchers,
      files: distribution.files,
    },
    tree: (await walk(packageRoot)).sort((left, right) => left.path.localeCompare(right.path)),
    launchers,
    publicExecutable: {
      path: publicPath,
      linkText: await readlink(publicPath),
      resolvedTarget: publicTarget,
      effectiveMode: (await stat(publicTarget)).mode & 0o777,
      bytes: publicBytes.length,
      sha256: sha256(publicBytes),
    },
  };
  const installManifestPath = path.join(scratch, 'runner-install-manifest.json');
  const installManifestBytes = Buffer.from(`${JSON.stringify(installManifest, null, 2)}\n`);
  await writeFile(installManifestPath, installManifestBytes);

  const validated = await exec(process.execPath, [
    '--permission', `--allow-fs-read=${scratch}`, installedValidator,
    installManifestPath, sha256(installManifestBytes),
  ], { cwd: installRoot });
  assert.equal(validated.stderr, '');
  assert.deepEqual(JSON.parse(validated.stdout), {
    contract: 'mdlm-demo-runner-install-validation@1',
    status: 'PASS',
    entries: installManifest.tree.length,
  });
});
