import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin/mdlm-demo-runner.mjs');

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
  const harnessCommit = sourceCommit;
  const fakeMdlm = path.join(scratch, 'mdlm');
  const fakePi = path.join(scratch, 'mdlm-pi');
  const packageArtifact = path.join(scratch, 'package.tgz');
  await writeFile(fakeMdlm, `#!/usr/bin/env node\nconst a=process.argv.slice(2);\nif(a[0]==='doctor') console.log(JSON.stringify({contract:'mdlm-doctor@1',ok:true,command:'doctor'}));\nelse if(a[0]==='status') console.log(JSON.stringify({contract:'mdlm-status@1',ok:true,command:'status',package:{reference:'pkg@1',digest:'sha256:${'1'.repeat(64)}',language:'lang@1'},currentOutcome:{outcome:'assignment',assignment:{id:'assignment-1'}},recentTransaction:{available:false}}));\nelse console.log(JSON.stringify({contract:'mdlm-assignment-state@1',ok:true,command:'assignment.show',assignment:{id:'assignment-1'},selected:true,package:{reference:'pkg@1',digest:'sha256:${'1'.repeat(64)}',language:'lang@1'},repository:{head:'${command('git', ['rev-parse', 'HEAD'], repository)}',trackedState:'sha256:${'2'.repeat(64)}'},scenarioReference:'review@1',disposition:'active',retryAvailability:{},malformedResponses:[]}));\n`);
  await writeFile(fakePi, '#!/bin/sh\nexit 0\n');
  await writeFile(packageArtifact, 'package bytes\n');
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
      source: { repository: source, commit: sourceCommit },
      package: { artifact: packageArtifact, digest: `sha256:${sha(packageArtifact)}` },
      tools: {
        mdlm: { path: fakeMdlm, digest: `sha256:${sha(fakeMdlm)}` },
        mdlmPi: { path: fakePi, digest: `sha256:${sha(fakePi)}` },
      },
      qualificationHarness: { repository: source, commit: harnessCommit },
    },
  };
  const first = spawnSync(process.execPath, [cli, 'snapshot'], { cwd: root, input: JSON.stringify(request), encoding: 'utf8', timeout: 10_000 });
  assert.equal(first.status, 0, first.stderr);
  const output = JSON.parse(first.stdout);
  assert.equal(output.snapshotDirectory, snapshotDirectory);
  assert.match(output.digest, /^sha256:[0-9a-f]{64}$/);
  const captured = JSON.parse(await readFile(path.join(snapshotDirectory, 'snapshot.json'), 'utf8'));
  assert.equal(captured.git.head.exitStatus, 0);
  assert.equal(captured.git.status.stdoutBase64, '');
  assert.equal(captured.commands.doctor.exitStatus, 0);
  assert.equal(captured.assignment.id, 'assignment-1');
  assert.equal(captured.provenance.valid, true);
  assert.equal((await stat(path.join(snapshotDirectory, 'commands', 'doctor.stdout'))).mode & 0o222, 0);

  const before = await readFile(path.join(snapshotDirectory, 'manifest.json'));
  const second = spawnSync(process.execPath, [cli, 'snapshot'], { cwd: root, input: JSON.stringify(request), encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(second.status, 0);
  assert.deepEqual(await readFile(path.join(snapshotDirectory, 'manifest.json')), before);
});
