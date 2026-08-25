import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { toolingTreeDigest } from './provenance-fixture.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin/mdlm-demo-runner.mjs');
const installedDoctorSuccess = await readFile(path.join(root, 'test', 'fixtures', 'mdlm-doctor-0.74.0-success.json'), 'utf8');

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('snapshot writes raw command and Git evidence once and cannot replace it', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'issue-213-snapshot-'));
  const repository = path.join(scratch, 'lifecycle');
  const source = path.join(scratch, 'source');
  await mkdir(repository);
  await mkdir(source);
  for (const directory of [repository, source]) {
    command('git', ['init', '-b', 'main'], directory);
    command('git', ['config', 'user.email', 'test@example.invalid'], directory);
    command('git', ['config', 'user.name', 'Test'], directory);
    await writeFile(path.join(directory, 'tracked.txt'), 'tracked\n');
    command('git', ['add', '.'], directory);
    command('git', ['commit', '-m', 'initial'], directory);
  }
  const sourceCommit = command('git', ['rev-parse', 'HEAD'], source);
  const sourceTree = command('git', ['rev-parse', 'HEAD^{tree}'], source);
  const harnessCommit = sourceCommit;
  const tooling = path.join(scratch, 'tooling');
  await mkdir(tooling);
  const fakeMdlm = path.join(tooling, 'mdlm');
  const fakePi = path.join(tooling, 'mdlm-pi');
  const lock = path.join(tooling, 'package-lock.json');
  const packageArtifact = path.join(scratch, 'mdlm.tgz');
  const piPackageArtifact = path.join(scratch, 'mdlm-pi.tgz');
  await writeFile(fakeMdlm, `#!/usr/bin/env node\nconst a=process.argv.slice(2);\nif(a[0]==='doctor') process.stdout.write(${JSON.stringify(installedDoctorSuccess)});\nelse if(a[0]==='status') console.log(JSON.stringify({contract:'mdlm-status@1',ok:true,command:'status',package:{reference:'pkg@1',digest:'sha256:${'1'.repeat(64)}',language:'lang@1'},currentOutcome:{outcome:'assignment',assignment:{allocation:'active',id:'assignment-1'}},recentTransaction:{available:false}}));\nelse console.log(JSON.stringify({contract:'mdlm-assignment-state@1',ok:true,command:'assignment.show',assignment:{id:'assignment-1'},selected:true,package:{reference:'pkg@1',digest:'sha256:${'1'.repeat(64)}',language:'lang@1'},repository:{head:'${command('git', ['rev-parse', 'HEAD'], repository)}',trackedState:'sha256:${'2'.repeat(64)}'},scenarioReference:'review@1',disposition:'active',retryAvailability:{},malformedResponses:[]}));\n`);
  await writeFile(fakePi, '#!/bin/sh\nexit 0\n');
  await writeFile(lock, '{"lockfileVersion":3}\n');
  await writeFile(packageArtifact, 'mdlm package bytes\n');
  await writeFile(piPackageArtifact, 'mdlm-pi package bytes\n');
  await chmod(fakeMdlm, 0o755);
  await chmod(fakePi, 0o755);
  const sha = file => command('sha256sum', [file], scratch).split(' ')[0];
  const snapshotDirectory = path.join(scratch, 'evidence', 'snapshot-0001');
  const request = {
    contract: 'mdlm-demo-snapshot-request@1',
    repository,
    snapshotDirectory,
    assignmentId: 'assignment-1',
    journalPath: path.join(scratch, 'journal.json'),
    timeoutMs: 5_000,
    provenance: {
      source: { repository: source, commit: sourceCommit, tree: sourceTree },
      package: { artifact: packageArtifact, digest: `sha256:${sha(packageArtifact)}` },
      piPackage: { artifact: piPackageArtifact, digest: `sha256:${sha(piPackageArtifact)}` },
      tooling: { root: tooling, digest: await toolingTreeDigest(tooling), lock: { path: lock, digest: `sha256:${sha(lock)}` } },
      tools: {
        mdlm: { path: fakeMdlm, digest: `sha256:${sha(fakeMdlm)}` },
        mdlmPi: { path: fakePi, digest: `sha256:${sha(fakePi)}` },
      },
      qualificationHarness: {
        repository: source, commit: harnessCommit, tree: sourceTree,
        repositoryLocator: 'https://example.invalid/qualification-harness.git',
        manifest: { path: path.join(source, 'tracked.txt'), digest: `sha256:${sha(path.join(source, 'tracked.txt'))}` },
      },
    },
  };
  const first = spawnSync(process.execPath, [cli, 'snapshot'], { cwd: root, input: JSON.stringify(request), encoding: 'utf8', timeout: 10_000 });
  assert.equal(first.status, 0, first.stderr);
  const output = JSON.parse(first.stdout);
  assert.equal(output.snapshotDirectory, snapshotDirectory);
  assert.equal(output.status, 'complete');
  assert.match(output.digest, /^sha256:[0-9a-f]{64}$/);
  const captured = JSON.parse(await readFile(path.join(snapshotDirectory, 'snapshot.json'), 'utf8'));
  assert.equal(captured.git.head.exitStatus, 0);
  assert.equal(captured.git.status.stdoutBase64, '');
  assert.equal(captured.commands.doctor.exitStatus, 0);
  assert.deepEqual(captured.diagnosis, JSON.parse(installedDoctorSuccess));
  assert.deepEqual(await readFile(path.join(snapshotDirectory, 'commands', 'doctor.stdout'), 'utf8'), installedDoctorSuccess);
  assert.equal(captured.assignment.id, 'assignment-1');
  assert.equal(captured.provenance.valid, true);
  assert.equal((await stat(path.join(snapshotDirectory, 'commands', 'doctor.stdout'))).mode & 0o222, 0);

  const before = await readFile(path.join(snapshotDirectory, 'manifest.json'));
  const second = spawnSync(process.execPath, [cli, 'snapshot'], { cwd: root, input: JSON.stringify(request), encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(second.status, 0);
  assert.deepEqual(await readFile(path.join(snapshotDirectory, 'manifest.json')), before);
});
