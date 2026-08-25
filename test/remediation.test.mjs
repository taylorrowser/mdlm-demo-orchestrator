import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { toolingTreeDigest } from './provenance-fixture.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin/mdlm-demo-runner.mjs');
const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function execute(program, args, cwd, input, env) {
  return spawnSync(program, args, { cwd, input, env, encoding: 'utf8', timeout: 20_000 });
}
function git(args, cwd) {
  const result = execute('git', args, cwd);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function snapshotFixture(mdlmBody) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-demo-remediation-'));
  const repository = path.join(scratch, 'lifecycle');
  const source = path.join(scratch, 'source');
  const harness = path.join(scratch, 'harness');
  for (const directory of [repository, source, harness]) {
    await mkdir(directory);
    git(['init', '-b', 'main'], directory);
    git(['config', 'user.name', 'Test'], directory);
    git(['config', 'user.email', 'test@example.invalid'], directory);
    await writeFile(path.join(directory, 'manifest.json'), '{"fixture":true}\n');
    git(['add', '.'], directory);
    git(['commit', '-m', 'initial'], directory);
  }
  const tooling = path.join(scratch, 'tooling');
  await mkdir(tooling);
  const mdlm = path.join(tooling, 'mdlm');
  const mdlmPiTarget = path.join(tooling, 'mdlm-pi-target');
  const mdlmPi = path.join(tooling, 'mdlm-pi');
  const lock = path.join(tooling, 'package-lock.json');
  const artifact = path.join(scratch, 'mdlm.tgz');
  const piArtifact = path.join(scratch, 'mdlm-pi.tgz');
  await writeFile(mdlm, `#!/usr/bin/env node\n${mdlmBody}\n`);
  await writeFile(mdlmPiTarget, '#!/bin/sh\nexit 0\n');
  await chmod(mdlm, 0o755);
  await chmod(mdlmPiTarget, 0o755);
  await import('node:fs/promises').then(({ symlink }) => symlink(path.basename(mdlmPiTarget), mdlmPi));
  await writeFile(lock, '{"lockfileVersion":3}\n');
  await writeFile(path.join(tooling, 'dependency.js'), 'export const installed = true;\n');
  await writeFile(artifact, 'mdlm artifact\n');
  await writeFile(piArtifact, 'mdlm-pi artifact\n');
  const identity = directory => ({
    repository: directory,
    commit: git(['rev-parse', 'HEAD'], directory),
    tree: git(['rev-parse', 'HEAD^{tree}'], directory),
  });
  const sourceIdentity = identity(source);
  const harnessIdentity = identity(harness);
  const request = {
    contract: 'mdlm-demo-snapshot-request@1',
    repository,
    snapshotDirectory: path.join(scratch, 'evidence'),
    assignmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    provenance: {
      source: sourceIdentity,
      package: { artifact, digest: sha256(await readFile(artifact)) },
      piPackage: { artifact: piArtifact, digest: sha256(await readFile(piArtifact)) },
      tooling: {
        root: tooling,
        digest: await toolingTreeDigest(tooling),
        lock: { path: lock, digest: sha256(await readFile(lock)) },
      },
      tools: {
        mdlm: { path: mdlm, digest: sha256(await readFile(mdlm)) },
        mdlmPi: { path: mdlmPi, digest: sha256(await readFile(mdlmPiTarget)) },
      },
      qualificationHarness: {
        ...harnessIdentity,
        repositoryLocator: 'https://example.invalid/qualification-harness.git',
        manifest: { path: path.join(harness, 'manifest.json'), digest: sha256(await readFile(path.join(harness, 'manifest.json'))) },
      },
    },
  };
  return { scratch, repository, request, mdlm, mdlmPi, mdlmPiTarget, tooling };
}

const healthyMdlm = `
const a=process.argv.slice(2);
const assignment='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const pkg={reference:'pkg@1',digest:'sha256:${'1'.repeat(64)}',language:'lang@1'};
const cp=require('node:child_process');
const head=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const staged=cp.execFileSync('git',['diff','--binary','--no-ext-diff','--cached','HEAD','--'],{encoding:'utf8'});
const worktree=cp.execFileSync('git',['diff','--binary','--no-ext-diff','--'],{encoding:'utf8'});
const crypto=require('node:crypto');
const trackedState='sha256:'+crypto.createHash('sha256').update(head+'\\0staged\\0'+staged+'\\0worktree\\0'+worktree).digest('hex');
if(a[0]==='doctor') console.log(JSON.stringify({ok:true,command:'doctor',package:{id:'pkg',version:'1',...pkg},baselineRepositoryVerification:{verifiedBaselines:0,processDrift:0},index:{rebuilt:false,data:0,path:'.lifecycle/generated/indexes/data.json'},report:{rebuilt:false,data:0,path:'.lifecycle/generated/reports/lifecycle.json'},diagnostics:[]}));
else if(a[0]==='status') console.log(JSON.stringify({contract:'mdlm-status@1',ok:true,command:'status',package:pkg,currentOutcome:{outcome:'assignment',assignment:{allocation:'active',id:assignment}},recentTransaction:{available:false}}));
else console.log(JSON.stringify({contract:'mdlm-assignment-state@1',ok:true,command:'assignment.show',assignment:{id:assignment},selected:true,package:pkg,repository:{head,trackedState},scenarioReference:'review@1',disposition:'active',retryAvailability:{},malformedResponses:[]}));`;

test('snapshot retains complete immutable evidence and classifies malformed command output', async () => {
  const fixture = await snapshotFixture(`${healthyMdlm}\nif(process.argv[2]==='assignment') process.stdout.write('not-json\\n');`);
  // Replace the fixture body so only assignment.show is malformed.
  await writeFile(fixture.mdlm, `#!/usr/bin/env node\nif(process.argv[2]==='assignment'){process.stdout.write('not-json\\n'); process.exit(0)}\n${healthyMdlm}\n`);
  await chmod(fixture.mdlm, 0o755);
  fixture.request.provenance.tools.mdlm.digest = sha256(await readFile(fixture.mdlm));
  fixture.request.provenance.tooling.digest = await toolingTreeDigest(fixture.tooling);
  const result = execute(process.execPath, [cli, 'snapshot'], root, JSON.stringify(fixture.request));
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'command-failure');
  assert.deepEqual(output.failures.map(item => item.command), ['assignment']);
  assert.equal(output.failures[0].kind, 'malformed-json');
  const captured = JSON.parse(await readFile(path.join(fixture.request.snapshotDirectory, 'snapshot.json'), 'utf8'));
  assert.equal(captured.assignment, null);
  assert.equal(captured.commandFailure.kind, 'command-failure');
  assert.equal(captured.commands.assignment.stdoutBase64, Buffer.from('not-json\n').toString('base64'));
  assert.equal(captured.postRun, false);
});

test('snapshot records exact lifecycle and Assignment repository fingerprints separately', async () => {
  const fixture = await snapshotFixture(healthyMdlm);
  const result = execute(process.execPath, [cli, 'snapshot'], root, JSON.stringify(fixture.request));
  assert.equal(result.status, 0, result.stderr);
  const captured = JSON.parse(await readFile(path.join(fixture.request.snapshotDirectory, 'snapshot.json'), 'utf8'));
  assert.match(captured.lifecycleRepository.trackedState, /^sha256:[0-9a-f]{64}$/);
  assert.equal(captured.lifecycleRepository.head, git(['rev-parse', 'HEAD'], fixture.repository));
  assert.equal(captured.lifecycleRepository.tree, git(['rev-parse', 'HEAD^{tree}'], fixture.repository));
  assert.deepEqual(captured.assignmentRepository, captured.assignment.repository);
  assert.notEqual(captured.provenance.source.repository, captured.repository);
  assert.equal(captured.provenance.source.observedTree, fixture.request.provenance.source.tree);
  assert.equal(captured.provenance.qualificationHarness.manifest.matches, true);
  assert.equal(captured.provenance.tools.mdlmPi.realpath, fixture.mdlmPiTarget);
  assert.ok(captured.environmentPolicy.removed.includes('NODE_OPTIONS'));
  assert.equal(captured.environmentPolicy.gitConfigIsolation, true);
});

test('installed tooling closure is path-independent and rejects neighboring dependency mutation', async () => {
  const first = await snapshotFixture(healthyMdlm);
  const second = await snapshotFixture(healthyMdlm);
  assert.equal(first.request.provenance.tooling.digest, second.request.provenance.tooling.digest);

  await writeFile(path.join(first.tooling, 'dependency.js'), 'export const installed = false;\n');
  const result = execute(process.execPath, [cli, 'snapshot'], root, JSON.stringify(first.request));
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'provenance-failure');
  const captured = JSON.parse(await readFile(path.join(first.request.snapshotDirectory, 'snapshot.json'), 'utf8'));
  assert.equal(captured.provenance.tooling.matches, false);
  assert.equal(captured.provenance.package.matches, true);
  assert.equal(captured.provenance.piPackage.matches, true);
  assert.equal(captured.provenance.tooling.lock.matches, true);
});

test('snapshot contract-validates successful MDLM JSON before exposing semantic state', async () => {
  const malformed = healthyMdlm.replace(
    "currentOutcome:{outcome:'assignment',assignment:{allocation:'active',id:assignment}}",
    "currentOutcome:{outcome:'assignment',assignment:{allocation:'invented',id:assignment}}",
  );
  const fixture = await snapshotFixture(malformed);
  const result = execute(process.execPath, [cli, 'snapshot'], root, JSON.stringify(fixture.request));
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'command-failure');
  assert.deepEqual(output.failures.map(item => item.command), ['status']);
  assert.equal(output.failures[0].kind, 'semantic-contract');
  const captured = JSON.parse(await readFile(path.join(fixture.request.snapshotDirectory, 'snapshot.json'), 'utf8'));
  assert.equal(captured.status, null);
  assert.match(Buffer.from(captured.commands.status.stdoutBase64, 'base64').toString(), /invented/);
  assert.equal(captured.commands.status.exitStatus, 0);
});
