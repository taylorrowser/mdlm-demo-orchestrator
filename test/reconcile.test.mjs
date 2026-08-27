import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { toolingTreeDigest } from './provenance-fixture.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin/mdlm-demo-runner.mjs');
const fixture = path.join(root, 'test/fixtures/run-046-reconciliation');
const assignmentA = '95d3eb26-17c5-4e03-b1f5-fc07bd0cafc3';
const assignmentB = '7bf4c623-f42e-4f15-9217-a78b0ad36ff9';

function exec(program, args, cwd, input, env = process.env) {
  return spawnSync(program, args, { cwd, input, env, encoding: 'utf8', timeout: 20_000 });
}

function digestBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function digest(file) {
  return digestBytes(await readFile(file));
}

function assignmentKey(value) {
  const suffix = createHash('sha256').update(value).digest('hex').slice(-12);
  return `${value.replace(/[^A-Za-z0-9._-]/g, '_')}-${suffix}`;
}

async function pin(file) {
  return { path: file, digest: await digest(file) };
}

function git(args, cwd) {
  const execution = exec('git', args, cwd);
  assert.equal(execution.status, 0, execution.stderr);
  return execution.stdout.trim();
}

function runIdentityFromSnapshot(snapshot, request) {
  const gitIdentity = value => ({ repository: value.repository, commit: value.observedCommit, tree: value.observedTree });
  const file = value => ({ realpath: value.realpath, digest: value.digest, bytes: value.bytes });
  return {
    contract: 'mdlm-demo-run-identity@5', operator: request.operator,
    mdlmPiCommandTimeoutMs: request.mdlmPiCommandTimeoutMs,
    mdlmPiAssignmentTimeoutMs: request.mdlmPiAssignmentTimeoutMs,
    processPackage: snapshot.status.package,
    source: gitIdentity(snapshot.provenance.source), packageArtifact: file(snapshot.provenance.package),
    piPackageArtifact: file(snapshot.provenance.piPackage),
    tooling: {
      contract: snapshot.provenance.tooling.contract, digest: snapshot.provenance.tooling.digest,
      entries: snapshot.provenance.tooling.entries, files: snapshot.provenance.tooling.files,
      symlinks: snapshot.provenance.tooling.symlinks, bytes: snapshot.provenance.tooling.bytes,
      lock: file(snapshot.provenance.tooling.lock),
    },
    tools: { mdlm: file(snapshot.provenance.tools.mdlm), mdlmPi: file(snapshot.provenance.tools.mdlmPi) },
    qualificationHarness: {
      ...gitIdentity(snapshot.provenance.qualificationHarness),
      repositoryLocator: snapshot.provenance.qualificationHarness.repositoryLocator,
      manifest: file(snapshot.provenance.qualificationHarness.manifest),
    },
  };
}

function commandRecord(template, { argv, cwd, timeoutMs, stdout, stderr, timedOut, exitStatus, signal, startedAt, completedAt }) {
  return {
    ...template, argv, cwd, timeoutMs, startedAt, completedAt,
    timedOut, exitStatus, signal, spawnError: null,
    stdoutBase64: stdout.toString('base64'), stderrBase64: stderr.toString('base64'),
    stdoutSha256: digestBytes(stdout), stderrSha256: digestBytes(stderr),
    observedOutputBytes: stdout.length + stderr.length, outputLimitExceeded: false,
  };
}

async function writeTriplet(directory, index, record, stdout, stderr) {
  const prefix = path.join(directory, `command-${index}`);
  await writeFile(`${prefix}.json`, `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(`${prefix}.stdout`, stdout);
  await writeFile(`${prefix}.stderr`, stderr);
}

async function run046Fixture() {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-run-046-reconcile-'));
  const repository = path.join(scratch, 'repository');
  const clone = exec('git', ['clone', '--quiet', '--branch', 'run-046-b', path.join(fixture, 'repository.bundle'), repository], root);
  assert.equal(clone.status, 0, clone.stderr);

  const identityDirectory = path.join(repository, '.git', 'mdlm-demo-orchestrator');
  await mkdir(identityDirectory, { recursive: true });
  await cp(path.join(fixture, 'repository-identity.json'), path.join(identityDirectory, 'repository-identity.json'));
  await cp(path.join(fixture, 'run-identity.json'), path.join(identityDirectory, 'run-identity.json'));

  const stateDirectory = path.join(scratch, 'private-state');
  const sourceDirectory = path.join(stateDirectory, 'assignments', assignmentKey(assignmentA));
  await mkdir(path.dirname(sourceDirectory), { recursive: true });
  await cp(path.join(fixture, 'assignment-a'), sourceDirectory, { recursive: true, preserveTimestamps: true });
  const evidenceDirectory = path.join(scratch, 'evidence');
  await cp(path.join(fixture, 'snapshots'), evidenceDirectory, { recursive: true, preserveTimestamps: true });
  const requestPath = path.join(scratch, 'request.json');
  await cp(path.join(fixture, 'request.json'), requestPath);

  const commandDirectory = path.join(sourceDirectory, 'command-evidence');
  const durableDirectory = path.join(sourceDirectory, 'durable-command');
  const shimDirectory = path.join(sourceDirectory, 'shim');
  const request = {
    contract: 'mdlm-demo-reconcile-request@1',
    repository,
    stateDirectory,
    timeoutMs: 900_000,
    evidence: {
      request: await pin(requestPath),
      initialSnapshot: {
        directory: path.join(evidenceDirectory, 'snapshot-000001'),
        digest: 'sha256:070664b7de0946eecf01e9a8ff57d225f443e6bf1343145bff4fcb86bcd14fc1',
      },
      postSnapshot: {
        directory: path.join(evidenceDirectory, 'snapshot-000002'),
        digest: 'sha256:fb2b444708607e1afbb9149e3a4c58c48bd568871c4e21bb747152e3b3c1cd34',
      },
      authorization: await pin(path.join(durableDirectory, 'authorization.json')),
      result: await pin(path.join(durableDirectory, 'result.json')),
      commands: await Promise.all(['000001', '000002'].map(async index => ({
        record: await pin(path.join(commandDirectory, `command-${index}.json`)),
        stdout: await pin(path.join(commandDirectory, `command-${index}.stdout`)),
        stderr: await pin(path.join(commandDirectory, `command-${index}.stderr`)),
      }))),
      identity: await pin(path.join(sourceDirectory, 'identity.json')),
      shimConfig: await pin(path.join(shimDirectory, 'config.json')),
      processedAssignment: await pin(path.join(shimDirectory, 'processed-assignment.json')),
      assignmentCheckpoint: await pin(path.join(shimDirectory, 'assignment-checkpoint.json')),
      stopPacket: await pin(path.join(shimDirectory, 'stops', `${assignmentB}.json`)),
    },
  };
  return { scratch, repository, identityDirectory, sourceDirectory, stateDirectory, request };
}

async function syntheticReconcileThenBFixture() {
  const value = await run046Fixture();
  const sourceRepository = path.join(value.scratch, 'source');
  await mkdir(sourceRepository);
  git(['init', '-b', 'main'], sourceRepository);
  git(['config', 'user.name', 'Test'], sourceRepository);
  git(['config', 'user.email', 'test@example.invalid'], sourceRepository);
  await writeFile(path.join(sourceRepository, 'README.md'), 'synthetic source\n');
  git(['add', '.'], sourceRepository);
  git(['commit', '-m', 'source'], sourceRepository);

  const tooling = path.join(value.scratch, 'tooling');
  const mdlm = path.join(tooling, 'mdlm');
  const mdlmPi = path.join(tooling, 'mdlm-pi');
  const lock = path.join(tooling, 'package-lock.json');
  const packageArtifact = path.join(value.scratch, 'mdlm.tgz');
  const piPackageArtifact = path.join(value.scratch, 'mdlm-pi.tgz');
  const assignmentState = path.join(value.scratch, 'assignment-state');
  const workerLog = path.join(value.scratch, 'worker.log');
  const callsLog = path.join(value.scratch, 'calls.log');
  const processPackage = { reference: 'synthetic@1', digest: `sha256:${'1'.repeat(64)}`, language: 'synthetic@1' };
  await mkdir(tooling);
  await writeFile(assignmentState, assignmentA);
  const mdlmScript = `#!/usr/bin/env node
const fs=require('node:fs'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const args=process.argv.slice(2), active=fs.readFileSync(${JSON.stringify(assignmentState)},'utf8');
fs.appendFileSync(${JSON.stringify(callsLog)},JSON.stringify(args)+'\\n');
const pkg=${JSON.stringify(processPackage)};
const head=execFileSync('git',['rev-parse','HEAD^{commit}'],{encoding:'utf8'}).trim();
const staged=execFileSync('git',['diff','--binary','--no-ext-diff','--cached','HEAD','--'],{encoding:'utf8'});
const worktree=execFileSync('git',['diff','--binary','--no-ext-diff','--'],{encoding:'utf8'});
const repository={head,trackedState:'sha256:'+crypto.createHash('sha256').update(head+'\\0staged\\0'+staged+'\\0worktree\\0'+worktree).digest('hex')};
const scenario=active===${JSON.stringify(assignmentA)}?'synthetic-a@1':'synthetic-b@1';
const out=value=>process.stdout.write(JSON.stringify(value)+'\\n');
if(args[0]==='doctor') out({ok:true,command:'doctor',package:{id:'synthetic',version:'1',...pkg},baselineRepositoryVerification:{verifiedBaselines:4,processDrift:0},index:{rebuilt:false,data:0,path:'.lifecycle/generated/indexes/data.json'},report:{rebuilt:false,data:0,path:'.lifecycle/generated/reports/lifecycle.json'},diagnostics:[]});
else if(args[0]==='status') out({contract:'mdlm-status@1',ok:true,command:'status',package:pkg,currentOutcome:{outcome:'assignment',assignment:{allocation:'active',id:active}},recentTransaction:{available:false}});
else if(args[0]==='assignment') { const requested=args[2]; out(requested===active?{contract:'mdlm-assignment-state@1',ok:true,command:'assignment.show',assignment:{id:requested},selected:true,package:pkg,repository,scenarioReference:scenario,disposition:'active',retryAvailability:{},malformedResponses:[],diagnostics:[]}:{contract:'mdlm-assignment-state@1',ok:true,command:'assignment.show',assignment:{id:requested},selected:false,diagnostics:[]}); }
else if(args[0]==='scenario'&&args[1]==='prepare') { const requested=args[2]; out({contract:'mdlm-assignment-packet@2',ok:true,command:'scenario.prepare',assignment:{id:requested},package:pkg,repository,scenario:{reference:requested===${JSON.stringify(assignmentA)}?'synthetic-a@1':'synthetic-b@1'},responseSchema:{},exactInputs:[]}); }
else { process.stderr.write('unexpected '+JSON.stringify(args)); process.exitCode=8; }
`;
  await writeFile(mdlm, mdlmScript);
  await chmod(mdlm, 0o755);
  await writeFile(mdlmPi, `#!/bin/sh\nprintf 'B-worker\\n' >> ${workerLog}\nprintf '%s\\n' '{"status":"lifecycle-complete"}'\n`);
  await chmod(mdlmPi, 0o755);
  await writeFile(lock, '{"lockfileVersion":3}\n');
  await writeFile(packageArtifact, 'synthetic mdlm package\n');
  await writeFile(piPackageArtifact, 'synthetic mdlm-pi package\n');
  const adapterInputsPath = path.join(value.scratch, 'adapter-inputs.json');
  await writeFile(adapterInputsPath, '{"contract":"mdlm-external-adapter-inputs@1","scenarios":{}}\n');
  const sourceCommit = git(['rev-parse', 'HEAD'], sourceRepository);
  const sourceTree = git(['rev-parse', 'HEAD^{tree}'], sourceRepository);
  const pinnedSnapshots = path.join(value.scratch, 'synthetic-pinned');
  const originalRequest = {
    contract: 'mdlm-demo-run-request@1', repository: value.repository, stateDirectory: value.stateDirectory,
    evidenceDirectory: pinnedSnapshots, timeoutMs: 900_000,
    mdlmPiCommandTimeoutMs: 600_000, mdlmPiAssignmentTimeoutMs: 840_000,
    signal: 'clean-interrupted-command', assignmentId: assignmentA, adapterInputsPath,
    operator: { provider: 'openai-codex', model: 'gpt-5.6-sol', thinking: 'high' },
    commands: { mdlm, mdlmPi },
    provenance: {
      source: { repository: sourceRepository, commit: sourceCommit, tree: sourceTree },
      package: { artifact: packageArtifact, digest: await digest(packageArtifact) },
      piPackage: { artifact: piPackageArtifact, digest: await digest(piPackageArtifact) },
      tooling: { root: tooling, digest: await toolingTreeDigest(tooling), lock: { path: lock, digest: await digest(lock) } },
      tools: { mdlm: { path: mdlm, digest: await digest(mdlm) }, mdlmPi: { path: mdlmPi, digest: await digest(mdlmPi) } },
      qualificationHarness: {
        repository: sourceRepository, commit: sourceCommit, tree: sourceTree,
        repositoryLocator: 'https://example.invalid/synthetic-harness.git',
        manifest: { path: path.join(sourceRepository, 'README.md'), digest: await digest(path.join(sourceRepository, 'README.md')) },
      },
    },
  };
  const originalRequestPath = path.join(value.scratch, 'synthetic-request.json');
  await writeFile(originalRequestPath, `${JSON.stringify(originalRequest, null, 2)}\n`);

  git(['checkout', '--detach', '7b7eacf7dc788ff3f2e43a4249ee7fdf3f76e367'], value.repository);
  const initialDirectory = path.join(pinnedSnapshots, 'snapshot-000001');
  const postDirectory = path.join(pinnedSnapshots, 'snapshot-000002');
  const snapshotRequest = (directory, postRun) => ({
    contract: 'mdlm-demo-snapshot-request@1', repository: value.repository, snapshotDirectory: directory,
    assignmentId: assignmentA, timeoutMs: 900_000, postRun,
    journalPath: path.join(value.sourceDirectory, 'transaction.json'),
    piJournalPath: path.join(value.repository, '.git', 'mdlm-pi', 'run.json'), provenance: originalRequest.provenance,
  });
  const initialExecution = exec(process.execPath, [cli, 'snapshot'], root, JSON.stringify(snapshotRequest(initialDirectory, false)));
  assert.equal(initialExecution.status, 0, initialExecution.stderr);
  const initialResult = JSON.parse(initialExecution.stdout);
  const initial = JSON.parse(await readFile(path.join(initialDirectory, 'snapshot.json')));
  const prepared = exec(mdlm, ['scenario', 'prepare', assignmentA, '--json'], value.repository);
  assert.equal(prepared.status, 0, prepared.stderr);

  git(['checkout', '--detach', 'ad5db41378473822d33d984e90da3e1658bdb12b'], value.repository);
  await writeFile(assignmentState, assignmentB);
  const postExecution = exec(process.execPath, [cli, 'snapshot'], root, JSON.stringify(snapshotRequest(postDirectory, true)));
  assert.equal(postExecution.status, 0, postExecution.stderr);
  const postResult = JSON.parse(postExecution.stdout);
  const post = JSON.parse(await readFile(path.join(postDirectory, 'snapshot.json')));
  const packetExecution = exec(mdlm, ['scenario', 'prepare', assignmentB, '--json'], value.repository);
  assert.equal(packetExecution.status, 0, packetExecution.stderr);
  const packet = JSON.parse(packetExecution.stdout);

  await rm(value.sourceDirectory, { recursive: true });
  const commandDirectory = path.join(value.sourceDirectory, 'command-evidence');
  const durableDirectory = path.join(value.sourceDirectory, 'durable-command');
  const shimDirectory = path.join(value.sourceDirectory, 'shim');
  const stopsDirectory = path.join(shimDirectory, 'stops');
  await mkdir(commandDirectory, { recursive: true });
  await mkdir(durableDirectory);
  await mkdir(stopsDirectory, { recursive: true });
  const template = JSON.parse(await readFile(path.join(fixture, 'assignment-a/command-evidence/command-000002.json')));
  const empty = Buffer.alloc(0);
  const firstStdout = Buffer.from(prepared.stdout);
  const typedFailure = Buffer.from(`${JSON.stringify({
    status: 'operational-failure', error: 'MDLM could not prepare the Assignment', details: {
      contract: 'mdlm-demo-reserved-stop@1', type: 'assignment-checkpoint', phase: 'before-worker',
      assignment: assignmentB, scenario: 'synthetic-b@1', packetPath: path.join(stopsDirectory, `${assignmentB}.json`),
      completedAssignment: assignmentA,
    },
  })}\n`);
  const first = commandRecord(template, {
    argv: [mdlm, 'scenario', 'prepare', assignmentA, '--json'], cwd: value.repository, timeoutMs: 900_000,
    stdout: firstStdout, stderr: empty, timedOut: false, exitStatus: 0, signal: null,
    startedAt: initial.createdAt, completedAt: initial.createdAt,
  });
  const started = new Date(Date.parse(initial.createdAt) + 1).toISOString();
  const completed = new Date(Date.parse(initial.createdAt) + 2).toISOString();
  const workerArgv = [
    mdlmPi, 'run', value.repository, '--mdlm', path.join(root, 'bin/mdlm-demo-mdlm-shim.mjs'),
    '--provider', 'openai-codex', '--model', 'gpt-5.6-sol', '--thinking', 'high',
  ];
  const second = commandRecord(template, {
    argv: workerArgv, cwd: value.repository, timeoutMs: 900_000,
    stdout: Buffer.from('synthetic retained worker output\n'), stderr: typedFailure,
    timedOut: true, exitStatus: null, signal: 'SIGKILL', startedAt: started, completedAt: completed,
  });
  await writeTriplet(commandDirectory, '000001', first, firstStdout, empty);
  await writeTriplet(commandDirectory, '000002', second, Buffer.from('synthetic retained worker output\n'), typedFailure);
  await writeFile(path.join(value.sourceDirectory, 'identity.json'), `${JSON.stringify({
    contract: 'mdlm-demo-assignment-identity@1', assignmentId: assignmentA,
    lifecycleRepository: initial.lifecycleRepository, assignmentRepository: initial.assignmentRepository,
  }, null, 2)}\n`);
  await writeFile(path.join(shimDirectory, 'config.json'), `${JSON.stringify({
    contract: 'mdlm-demo-shim-config@1', realMdlm: mdlm, allowedAssignment: assignmentA,
    package: processPackage, repository: initial.assignmentRepository, stopDirectory: stopsDirectory, timeoutMs: 900_000,
  }, null, 2)}\n`);
  await writeFile(path.join(shimDirectory, 'processed-assignment.json'), `${JSON.stringify({
    contract: 'mdlm-demo-shim-processed-assignment@1', assignment: assignmentA,
    package: processPackage, repository: initial.assignmentRepository,
  }, null, 2)}\n`);
  await writeFile(path.join(shimDirectory, 'assignment-checkpoint.json'), `${JSON.stringify({
    contract: 'mdlm-demo-shim-assignment-checkpoint@1', completedAssignment: assignmentA,
    assignment: assignmentB, scenario: 'synthetic-b@1',
  }, null, 2)}\n`);
  await writeFile(path.join(stopsDirectory, `${assignmentB}.json`), `${JSON.stringify(packet, null, 2)}\n`);

  const decisionWording = Buffer.from('synthetic decision\n');
  const authorization = {
    contract: 'mdlm-demo-command-authorization@1', purpose: 'assignment-worker', createdAt: initial.createdAt,
    command: {
      argv: workerArgv, cwd: value.repository, timeoutMs: 900_000,
      input: { present: true, bytes: decisionWording.length, digest: digestBytes(decisionWording) },
      environment: { names: ['PATH'], digest: digestBytes(Buffer.from('synthetic environment')) },
    },
    context: {
      assignment: initial.assignment,
      decisionEvidence: { authorityBasis: 'synthetic test authority', digest: digestBytes(decisionWording.subarray(0, -1)), origin: 'operator-selected' },
      decisionInputBase64: decisionWording.toString('base64'), initialSnapshot: initialResult,
      privateEvidenceBefore: { safe: true, detail: 'no transaction, private publication, mdlm-pi journal, or checkpoint evidence' },
      shimDirectory,
    },
    compatibilityEvidence: { index: 2, prefix: path.join(commandDirectory, 'command-000002') },
  };
  const authorizationPath = path.join(durableDirectory, 'authorization.json');
  await writeFile(authorizationPath, `${JSON.stringify(authorization, null, 2)}\n`);
  const resultPath = path.join(durableDirectory, 'result.json');
  await writeFile(resultPath, `${JSON.stringify({
    contract: 'mdlm-demo-command-result@1',
    authorization: { path: authorizationPath, digest: await digest(authorizationPath) },
    process: second, repository: post.lifecycleRepository,
  }, null, 2)}\n`);
  await writeFile(path.join(value.identityDirectory, 'repository-identity.json'), `${JSON.stringify({
    contract: 'mdlm-demo-repository-identity@1', lifecycleRepository: initial.lifecycleRepository, lastAssignment: null,
  }, null, 2)}\n`);
  await writeFile(path.join(value.identityDirectory, 'run-identity.json'), `${JSON.stringify(runIdentityFromSnapshot(initial, originalRequest), null, 2)}\n`);

  const reconcileRequest = {
    contract: 'mdlm-demo-reconcile-request@1', repository: value.repository,
    stateDirectory: value.stateDirectory, timeoutMs: 900_000,
    evidence: {
      request: await pin(originalRequestPath),
      initialSnapshot: { directory: initialDirectory, digest: initialResult.digest },
      postSnapshot: { directory: postDirectory, digest: postResult.digest },
      authorization: await pin(authorizationPath), result: await pin(resultPath),
      commands: await Promise.all(['000001', '000002'].map(async index => ({
        record: await pin(path.join(commandDirectory, `command-${index}.json`)),
        stdout: await pin(path.join(commandDirectory, `command-${index}.stdout`)),
        stderr: await pin(path.join(commandDirectory, `command-${index}.stderr`)),
      }))),
      identity: await pin(path.join(value.sourceDirectory, 'identity.json')),
      shimConfig: await pin(path.join(shimDirectory, 'config.json')),
      processedAssignment: await pin(path.join(shimDirectory, 'processed-assignment.json')),
      assignmentCheckpoint: await pin(path.join(shimDirectory, 'assignment-checkpoint.json')),
      stopPacket: await pin(path.join(stopsDirectory, `${assignmentB}.json`)),
    },
  };
  const bRequest = {
    ...originalRequest, assignmentId: assignmentB, signal: 'clean-interrupted-command',
    evidenceDirectory: path.join(value.scratch, 'ordinary-b-evidence'),
  };
  return { ...value, reconcileRequest, bRequest, callsLog, workerLog };
}

test('run 046 fixture preserves the authenticated ISO evidence bytes and commit graph', async () => {
  const expected = new Map([
    ['request.json', 'sha256:5374ead4802bd7d2dd6b3d4a6d6bde8f8504451ed62166b48b760102c2116405'],
    ['assignment-a/durable-command/authorization.json', 'sha256:7546838ba3b1d60942133d1cbef67c406da47bcddf6c2571884503399e3041c7'],
    ['assignment-a/durable-command/result.json', 'sha256:a0086741f99cac2d16afa7038ecbf15934517d090efcabae19f44b68cde39da2'],
    ['assignment-a/shim/config.json', 'sha256:9789425cd2dd6e3e0db9b8b0c8f158c0c391ea7ae74bb4e2d98f6e71731df13e'],
    [`assignment-a/shim/stops/${assignmentB}.json`, 'sha256:4ccc47bb2ae7b3caac5fc989d3ff72c48f10bf5de2647c300a8dd84c1ea0da06'],
  ]);
  for (const [relative, expectedDigest] of expected) {
    assert.equal(await digest(path.join(fixture, relative)), expectedDigest, relative);
  }
  assert.equal(await digest(path.join(fixture, 'snapshots/snapshot-000001/manifest.json')), 'sha256:070664b7de0946eecf01e9a8ff57d225f443e6bf1343145bff4fcb86bcd14fc1');
  assert.equal(await digest(path.join(fixture, 'snapshots/snapshot-000002/manifest.json')), 'sha256:fb2b444708607e1afbb9149e3a4c58c48bd568871c4e21bb747152e3b3c1cd34');
  const bundle = exec('git', ['bundle', 'verify', path.join(fixture, 'repository.bundle')], root);
  assert.equal(bundle.status, 0, bundle.stderr);
  assert.match(bundle.stdout + bundle.stderr, /ad5db41378473822d33d984e90da3e1658bdb12b/);
});

test('public reconcile consumes timed-out A without starting A or B', async () => {
  const value = await run046Fixture();
  const before = exec('git', ['rev-parse', 'HEAD^{commit}', 'HEAD^{tree}'], value.repository);
  assert.equal(before.status, 0, before.stderr);

  const execution = exec(process.execPath, [cli, 'reconcile'], root, JSON.stringify(value.request));

  assert.equal(execution.status, 0, execution.stderr);
  const output = JSON.parse(execution.stdout);
  assert.deepEqual(output, {
    contract: 'mdlm-demo-reconcile-result@1',
    status: 'reconciled',
    fromAssignment: assignmentA,
    toAssignment: assignmentB,
    priorRepository: {
      head: '7b7eacf7dc788ff3f2e43a4249ee7fdf3f76e367',
      tree: 'e096a60b622efa9eb0a451ce84d3b2b2a1d0846e',
      trackedState: 'sha256:e9e3f7fef3b8e0e9bff1c7361f7ca4444210a4315753a3caade84f0b265d8018',
      clean: true,
      porcelainSha256: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
    completedRepository: {
      head: 'ad5db41378473822d33d984e90da3e1658bdb12b',
      tree: '4129730f8eba501177d0cbf9d22cf4a8b0256741',
      trackedState: 'sha256:6f7cf132d1a46bd3ba781554420083e54ffcddcb9978823db0ae5a07676c161e',
      clean: true,
      porcelainSha256: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
  });
  const after = exec('git', ['rev-parse', 'HEAD^{commit}', 'HEAD^{tree}'], value.repository);
  assert.equal(after.stdout, before.stdout);
  assert.deepEqual(await readdir(path.join(value.stateDirectory, 'assignments')), [assignmentKey(assignmentA)]);
  assert.equal(await stat(path.join(value.sourceDirectory, 'transaction.json')).then(() => true, () => false), true);

  const repeated = exec(process.execPath, [cli, 'reconcile'], root, JSON.stringify(value.request));
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).status, 'already-reconciled');
});

test('successful public reconcile requires a separate ordinary public B run', async () => {
  const value = await syntheticReconcileThenBFixture();
  const beforeCalls = await readFile(value.callsLog, 'utf8');
  const reconciliation = exec(process.execPath, [cli, 'reconcile'], root, JSON.stringify(value.reconcileRequest));
  assert.equal(reconciliation.status, 0, reconciliation.stderr);
  assert.equal(JSON.parse(reconciliation.stdout).status, 'reconciled');
  assert.equal(await stat(value.workerLog).then(() => true, () => false), false);
  assert.equal(await readFile(value.callsLog, 'utf8'), beforeCalls, 'reconciliation must not invoke MDLM');

  const bRun = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.bRequest));
  assert.equal(bRun.status, 0, bRun.stderr);
  const output = JSON.parse(bRun.stdout);
  assert.equal(output.status, 'completed');
  assert.equal(output.assignmentId, assignmentB);
  assert.equal(await readFile(value.workerLog, 'utf8'), 'B-worker\n');
  const bDirectory = path.join(value.stateDirectory, 'assignments', assignmentKey(assignmentB));
  assert.equal(JSON.parse(await readFile(path.join(bDirectory, 'durable-command', 'result.json'))).contract, 'mdlm-demo-command-result@1');
});

test('reconcile resumes atomically at every durable boundary', async () => {
  const seams = [
    'authenticated:after-rename',
    'checkpoint-reconciliation-global:after-rename',
    'boundary-advanced:after-rename',
    'checkpoint-reconciliation-assignment:after-rename',
    'completed:after-rename',
  ];
  for (const seam of seams) {
    const value = await run046Fixture();
    const crashed = exec(process.execPath, [cli, 'reconcile'], root, JSON.stringify(value.request), {
      ...process.env, MDLM_DEMO_TEST_CRASH: seam,
    });
    assert.equal(crashed.status, 86, `${seam}: ${crashed.stderr}`);

    const resumed = exec(process.execPath, [cli, 'reconcile'], root, JSON.stringify(value.request));
    assert.equal(resumed.status, 0, `${seam}: ${resumed.stderr}`);
    assert.match(JSON.parse(resumed.stdout).status, /^(?:reconciled|already-reconciled)$/);
    const trusted = JSON.parse(await readFile(path.join(value.identityDirectory, 'repository-identity.json')));
    assert.equal(trusted.lifecycleRepository.head, 'ad5db41378473822d33d984e90da3e1658bdb12b', seam);
    assert.equal(JSON.parse(await readFile(path.join(value.sourceDirectory, 'transaction.json'))).phase, 'completed', seam);
    const journals = await readdir(path.join(value.identityDirectory, 'checkpoint-reconciliations'));
    assert.equal(journals.length, 1, seam);
    assert.equal(JSON.parse(await readFile(path.join(value.identityDirectory, 'checkpoint-reconciliations', journals[0]))).phase, 'completed', seam);
  }
});

test('reconcile rejects drift, tamper, missing or extra evidence, symlinks, and prior attempts', async () => {
  const cases = [
    ['request tamper', async value => {
      await writeFile(value.request.evidence.request.path, Buffer.concat([await readFile(value.request.evidence.request.path), Buffer.from('\n')]));
    }],
    ['authorization tamper', async value => {
      await writeFile(value.request.evidence.authorization.path, Buffer.concat([await readFile(value.request.evidence.authorization.path), Buffer.from('\n')]));
    }],
    ['result tamper', async value => {
      await writeFile(value.request.evidence.result.path, Buffer.concat([await readFile(value.request.evidence.result.path), Buffer.from('\n')]));
    }],
    ['missing command bytes', value => rm(value.request.evidence.commands[1].stderr.path)],
    ['extra command evidence', async value => {
      await writeFile(path.join(value.sourceDirectory, 'command-evidence', 'command-000003.stdout'), 'unrelated\n');
    }],
    ['unrelated current output', async value => {
      await writeFile(path.join(value.repository, 'unrelated.txt'), 'unrelated\n');
    }],
    ['prior B attempt evidence', async value => {
      await mkdir(path.join(value.stateDirectory, 'assignments', assignmentKey(assignmentB)));
    }],
    ['prior durable consumption', async value => {
      await writeFile(path.join(value.sourceDirectory, 'durable-command', 'consumption.json'), '{}\n');
    }],
    ['symlinked command evidence', async value => {
      const target = value.request.evidence.commands[0].stdout.path;
      const outside = path.join(value.scratch, 'outside.stdout');
      await cp(target, outside);
      await rm(target);
      await symlink(outside, target);
    }],
    ['symlinked repository boundary', async value => {
      const realRepository = path.join(value.scratch, 'real-repository');
      await rename(value.repository, realRepository);
      await symlink(realRepository, value.repository);
    }],
    ['wrong post snapshot pin', value => {
      value.request.evidence.postSnapshot.digest = `sha256:${'0'.repeat(64)}`;
    }],
    ['unrelated clean commit', async value => {
      await writeFile(path.join(value.repository, 'unrelated.txt'), 'unrelated\n');
      const add = exec('git', ['add', 'unrelated.txt'], value.repository);
      assert.equal(add.status, 0, add.stderr);
      const commit = exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'unrelated'], value.repository);
      assert.equal(commit.status, 0, commit.stderr);
    }],
  ];
  for (const [name, mutate] of cases) {
    const value = await run046Fixture();
    await mutate(value);
    const before = await readFile(path.join(value.identityDirectory, 'repository-identity.json'));
    const execution = exec(process.execPath, [cli, 'reconcile'], root, JSON.stringify(value.request));
    assert.equal(execution.status, 1, `${name}: ${execution.stdout}\n${execution.stderr}`);
    assert.match(execution.stderr, /mdlm-demo-error@1/, name);
    assert.deepEqual(await readFile(path.join(value.identityDirectory, 'repository-identity.json')), before, name);
    assert.equal(await stat(path.join(value.sourceDirectory, 'transaction.json')).then(() => true, () => false), false, name);
  }
});
