import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { toolingTreeDigest } from './provenance-fixture.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin/mdlm-demo-runner.mjs');
function exec(program, args, cwd, input, env = process.env) { const r = spawnSync(program, args, { cwd, input, env, encoding: 'utf8', timeout: 20_000 }); return r; }
function git(args, cwd) { const r = exec('git', args, cwd); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
function digest(file, cwd) { return `sha256:${exec('sha256sum', [file], cwd).stdout.split(' ')[0]}`; }
function assignmentKeyForTest(assignmentId) {
  const suffix = createHash('sha256').update(assignmentId).digest('hex').slice(-12);
  return `${assignmentId.replace(/[^A-Za-z0-9._-]/g, '_')}-${suffix}`;
}
function assignmentDirectory(request) {
  return path.join(request.stateDirectory, 'assignments', assignmentKeyForTest(request.assignmentId));
}

async function fixture({
  uncertainSubmit = false,
  scenarioReference = 'register-pilot-target@1',
  piScript = '#!/bin/sh\nexit 0\n',
  executionId = '55555555-5555-4555-8555-555555555555',
  publicationPath,
  statusPackage = { reference: 'pkg@1', digest: `sha256:${'1'.repeat(64)}`, language: 'lang@1' },
  assignmentPackage = statusPackage,
  doctorPackage = { id: 'pkg', version: '1', ...statusPackage },
  packetPackage = assignmentPackage,
} = {}) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'issue-213-run-'));
  const repository = path.join(scratch, 'repository');
  await mkdir(repository);
  git(['init', '-b', 'main'], repository); git(['config', 'user.name', 'Test'], repository); git(['config', 'user.email', 'test@example.invalid'], repository);
  await writeFile(path.join(repository, 'README.md'), 'fixture\n'); git(['add', '.'], repository); git(['commit', '-m', 'initial'], repository);
  const base = git(['rev-parse', 'HEAD'], repository);
  const sourceRepository = path.join(scratch, 'source');
  await mkdir(sourceRepository);
  git(['init', '-b', 'main'], sourceRepository); git(['config', 'user.name', 'Test'], sourceRepository); git(['config', 'user.email', 'test@example.invalid'], sourceRepository);
  await writeFile(path.join(sourceRepository, 'README.md'), 'source fixture\n'); git(['add', '.'], sourceRepository); git(['commit', '-m', 'source'], sourceRepository);
  const sourceCommit = git(['rev-parse', 'HEAD'], sourceRepository);
  const sourceTree = git(['rev-parse', 'HEAD^{tree}'], sourceRepository);
  const tooling = path.join(scratch, 'tooling');
  await mkdir(tooling);
  const mdlm = path.join(tooling, 'mdlm');
  const mdlmPi = path.join(tooling, 'mdlm-pi');
  const lock = path.join(tooling, 'package-lock.json');
  const packageArtifact = path.join(scratch, 'mdlm.tgz');
  const piPackageArtifact = path.join(scratch, 'mdlm-pi.tgz');
  const responsePath = path.join(scratch, 'response.json');
  const observationsPath = path.join(scratch, 'observations.json');
  const adapterInputsPath = path.join(scratch, 'adapter-inputs.json');
  const assignment = '44444444-4444-4444-8444-444444444444';
  const assignmentStatePath = path.join(scratch, 'assignment-id');
  const scenarioStatePath = path.join(scratch, 'scenario-reference');
  const malformedDigestPath = path.join(scratch, 'malformed-digest');
  await writeFile(assignmentStatePath, assignment);
  await writeFile(scenarioStatePath, scenarioReference);
  const scenario = scenarioReference;
  const response = `{"contract":"mdlm-assignment-response@1","assignment":"${assignment}","kind":"proposal","proposal":{}}\n`;
  await writeFile(responsePath, response);
  await writeFile(observationsPath, JSON.stringify({ contract: 'mdlm-external-observations@1', assignment, scenario, product: { repository: 'https://example.invalid/product.git', commit: 'b'.repeat(40), tree: 'c'.repeat(40) } }));
  await writeFile(adapterInputsPath, JSON.stringify({ contract: 'mdlm-external-adapter-inputs@1', scenarios: { [scenario]: { kind: 'exact-response', responsePath, observationsPath } } }));
  const script = `#!/usr/bin/env node
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path'),{execFileSync}=require('node:child_process');
const a=process.argv.slice(2), root=process.cwd(), log=${JSON.stringify(path.join(scratch, 'calls.log'))};
fs.appendFileSync(log,JSON.stringify(a)+'\\n');
const assignment=fs.readFileSync(${JSON.stringify(assignmentStatePath)},'utf8'), scenario=fs.readFileSync(${JSON.stringify(scenarioStatePath)},'utf8');
const malformedPath=${JSON.stringify(malformedDigestPath)}, malformedResponses=fs.existsSync(malformedPath)?[{digest:fs.readFileSync(malformedPath,'utf8'),diagnostics:[{code:'FIX',message:'correct it'}]}]:[];
const statusPackage=${JSON.stringify(statusPackage)}, assignmentPackage=${JSON.stringify(assignmentPackage)}, doctorPackage=${JSON.stringify(doctorPackage)}, packetPackage=${JSON.stringify(packetPackage)};
function repository(){const head=execFileSync('git',['rev-parse','HEAD^{commit}'],{encoding:'utf8'}).trim(); const staged=execFileSync('git',['diff','--binary','--no-ext-diff','--cached','HEAD','--'],{encoding:'utf8'}); const worktree=execFileSync('git',['diff','--binary','--no-ext-diff','--'],{encoding:'utf8'}); return {head,trackedState:'sha256:'+crypto.createHash('sha256').update(head+'\\0staged\\0'+staged+'\\0worktree\\0'+worktree).digest('hex')}}
const repo=repository();
function out(x){process.stdout.write(JSON.stringify(x)+'\\n')}
if(a[0]==='doctor') out({ok:true,command:'doctor',package:doctorPackage,baselineRepositoryVerification:{verifiedBaselines:0,processDrift:0},index:{rebuilt:false,data:0,path:'.lifecycle/generated/indexes/data.json'},report:{rebuilt:false,data:0,path:'.lifecycle/generated/reports/lifecycle.json'},diagnostics:[]});
else if(a[0]==='status') out({contract:'mdlm-status@1',ok:true,command:'status',package:statusPackage,currentOutcome:{outcome:'assignment',assignment:{allocation:'active',id:assignment}},recentTransaction:{available:false}});
else if(a[0]==='assignment') { const requested=a[2]; if(requested!==assignment) out({contract:'mdlm-assignment-state@1',ok:true,command:'assignment.show',assignment:{id:requested},selected:false,diagnostics:[]}); else out({contract:'mdlm-assignment-state@1',ok:true,command:'assignment.show',assignment:{id:assignment},selected:true,package:assignmentPackage,repository:repo,scenarioReference:scenario,disposition:'active',retryAvailability:{},malformedResponses}); }
else if(a[0]==='scenario'&&a[1]==='prepare') out({contract:'mdlm-assignment-packet@2',ok:true,command:'scenario.prepare',assignment:{id:assignment},package:packetPackage,repository:repo,scenario:{reference:scenario},responseSchema:{},exactInputs:[]});
else if(a[0]==='scenario'&&a[1]==='submit') { let chunks=[]; process.stdin.on('data',x=>chunks.push(x)); process.stdin.on('end',()=>{const bytes=Buffer.concat(chunks); fs.appendFileSync(${JSON.stringify(path.join(scratch, 'submit-count'))},'1\\n'); const id=${JSON.stringify(executionId)}; const dir=path.join(root,'.lifecycle/data/.transactions',id); fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,'execution.json'),'execution\\n'); fs.writeFileSync(path.join(dir,'target.json'),'target\\n'); if(${uncertainSubmit}) process.exit(9); else out({contract:'mdlm-scenario-execution@4',ok:true,command:'scenario.submit',execution:{contract:'mdlm-scenario-execution@4',id,status:'completed',response:{assignment,digest:'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex')},definition:{scenario},outputs:[{lifecycleDatum:{path:${publicationPath ? JSON.stringify(publicationPath) : "'.lifecycle/data/.transactions/'+id+'/target.json'"}}}]}}); }); }
else {process.stderr.write('unexpected '+JSON.stringify(a));process.exit(8)}
`;
  await writeFile(mdlm, script); await chmod(mdlm, 0o755);
  await writeFile(mdlmPi, piScript); await chmod(mdlmPi, 0o755);
  await writeFile(lock, '{"lockfileVersion":3}\n');
  await writeFile(packageArtifact, 'mdlm package\n');
  await writeFile(piPackageArtifact, 'mdlm-pi package\n');
  const request = {
    contract: 'mdlm-demo-run-request@1', repository,
    stateDirectory: path.join(scratch, 'state'), evidenceDirectory: path.join(scratch, 'evidence'), timeoutMs: 900_000,
    mdlmPiCommandTimeoutMs: 600_000, mdlmPiAssignmentTimeoutMs: 840_000,
    signal: 'adapter-failure-before-submission', assignmentId: assignment, adapterInputsPath,
    operator: { provider: 'openai-codex', model: 'gpt-5.6-sol', thinking: 'high' },
    commands: { mdlm, mdlmPi },
    provenance: {
      source: { repository: sourceRepository, commit: sourceCommit, tree: sourceTree }, package: { artifact: packageArtifact, digest: digest(packageArtifact, scratch) },
      piPackage: { artifact: piPackageArtifact, digest: digest(piPackageArtifact, scratch) },
      tooling: { root: tooling, digest: await toolingTreeDigest(tooling), lock: { path: lock, digest: digest(lock, scratch) } },
      tools: { mdlm: { path: mdlm, digest: digest(mdlm, scratch) }, mdlmPi: { path: mdlmPi, digest: digest(mdlmPi, scratch) } },
      qualificationHarness: {
        repository: sourceRepository, commit: sourceCommit, tree: sourceTree,
        repositoryLocator: 'https://example.invalid/qualification-harness.git',
        manifest: { path: path.join(sourceRepository, 'README.md'), digest: digest(path.join(sourceRepository, 'README.md'), scratch) },
      },
    },
  };
  return { scratch, repository, request, mdlm, mdlmPi, tooling, assignment, assignmentStatePath, scenarioStatePath, malformedDigestPath, executionId };
}

const run003CheckpointFixture = path.join(root, 'test', 'fixtures', 'calculator-run-003-checkpoint');
const run008OperationalFailureDirectory = path.join(root, 'test', 'fixtures', 'calculator-run-008-operational-failure');
const run008OperationalFailureFixture = path.join(run008OperationalFailureDirectory, 'result.json');
const run003AssignmentA = '0110fb6b-5a0d-4228-9867-58ed3e27a4a4';
const run003AssignmentB = '6db7bda7-7043-446b-a38a-2daab6c6df3e';

function operationalRecoveryDirectoryForTest(value) {
  return path.join(
    value.repository,
    '.git',
    'mdlm-demo-orchestrator',
    'operational-failure-recoveries',
    assignmentKeyForTest(value.assignment),
  );
}

async function operationalFailureFixture() {
  const run008 = JSON.parse(await readFile(run008OperationalFailureFixture));
  const attemptsPath = path.join(os.tmpdir(), `mdlm-demo-operational-attempts-${process.pid}-${Date.now()}-${Math.random()}`);
  const piScript = `#!/usr/bin/env node
const fs=require('node:fs'); const attempts=fs.existsSync(${JSON.stringify(attemptsPath)})?Number(fs.readFileSync(${JSON.stringify(attemptsPath)},'utf8')):0; fs.writeFileSync(${JSON.stringify(attemptsPath)},String(attempts+1)); if(attempts===0){process.stderr.write(Buffer.from(${JSON.stringify(run008.process.stderrBase64)},'base64')); process.exit(1);} console.log('{"status":"lifecycle-complete"}');
`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  value.request.signal = 'clean-interrupted-command';
  return { ...value, attemptsPath, run008 };
}

function cleanLifecycle(repository) {
  const head = git(['rev-parse', 'HEAD^{commit}'], repository);
  return {
    head,
    tree: git(['rev-parse', 'HEAD^{tree}'], repository),
    trackedState: `sha256:${createHash('sha256').update(`${head}\0staged\0\0worktree\0`).digest('hex')}`,
    clean: true,
    porcelainSha256: `sha256:${createHash('sha256').update('').digest('hex')}`,
  };
}

function commandRecord(template, { argv, cwd, timeoutMs, stdout, stderr, exitStatus }) {
  return {
    ...template,
    argv,
    cwd,
    timeoutMs,
    timedOut: false,
    outputLimitExceeded: false,
    observedOutputBytes: stdout.length + stderr.length,
    exitStatus,
    signal: null,
    spawnError: null,
    stdoutBase64: stdout.toString('base64'),
    stderrBase64: stderr.toString('base64'),
    stdoutSha256: `sha256:${createHash('sha256').update(stdout).digest('hex')}`,
    stderrSha256: `sha256:${createHash('sha256').update(stderr).digest('hex')}`,
  };
}

async function writeEvidenceTriplet(directory, index, record, stdout, stderr) {
  await writeFile(path.join(directory, `command-${index}.json`), `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(path.join(directory, `command-${index}.stdout`), stdout);
  await writeFile(path.join(directory, `command-${index}.stderr`), stderr);
}

async function afterFactCheckpointFixture({ mutate } = {}) {
  const packetTemplate = JSON.parse(await readFile(path.join(run003CheckpointFixture, 'shim', 'stops', `${run003AssignmentB}.json`)));
  const workerLog = path.join(os.tmpdir(), `mdlm-demo-after-fact-worker-${process.pid}-${Date.now()}-${Math.random()}`);
  const piScript = `#!/usr/bin/env node\nconst fs=require('node:fs'); const config=JSON.parse(fs.readFileSync(process.env.MDLM_DEMO_SHIM_CONFIG,'utf8')); fs.appendFileSync(${JSON.stringify(workerLog)},config.allowedAssignment+'\\n'); console.log('{"status":"lock-conflict"}'); process.exit(5);\n`;
  const value = await fixture({
    scenarioReference: 'freeze-source-boundary@1',
    piScript,
    statusPackage: packetTemplate.package,
    assignmentPackage: packetTemplate.package,
    doctorPackage: { id: 'mdlm-bootstrap', version: '0.74.0', ...packetTemplate.package },
    packetPackage: packetTemplate.package,
  });
  value.request.signal = 'clean-interrupted-command';
  value.request.assignmentId = run003AssignmentB;
  await writeFile(value.assignmentStatePath, run003AssignmentB);
  await writeFile(value.scenarioStatePath, 'freeze-source-boundary@1');

  const oldLifecycle = cleanLifecycle(value.repository);
  await writeFile(path.join(value.repository, 'accepted-a.txt'), 'accepted A publication\n');
  git(['add', 'accepted-a.txt'], value.repository);
  git(['commit', '-m', 'accepted A publication'], value.repository);
  const currentLifecycle = cleanLifecycle(value.repository);

  const identityDirectory = path.join(value.repository, '.git', 'mdlm-demo-orchestrator');
  await mkdir(identityDirectory, { recursive: true });
  await writeFile(path.join(identityDirectory, 'repository-identity.json'), JSON.stringify({
    contract: 'mdlm-demo-repository-identity@1', lifecycleRepository: oldLifecycle, lastAssignment: null,
  }));

  const aRequest = { ...value.request, assignmentId: run003AssignmentA };
  const aDirectory = assignmentDirectory(aRequest);
  const evidenceDirectory = path.join(aDirectory, 'command-evidence');
  const stopDirectory = path.join(aDirectory, 'shim', 'stops');
  await mkdir(evidenceDirectory, { recursive: true });
  await mkdir(stopDirectory, { recursive: true });
  const aRepository = { head: oldLifecycle.head, trackedState: oldLifecycle.trackedState };
  const identity = {
    contract: 'mdlm-demo-assignment-identity@1', assignmentId: run003AssignmentA,
    lifecycleRepository: oldLifecycle, assignmentRepository: aRepository,
  };
  await writeFile(path.join(aDirectory, 'identity.json'), `${JSON.stringify(identity, null, 2)}\n`);
  const config = {
    contract: 'mdlm-demo-shim-config@1', realMdlm: value.mdlm, allowedAssignment: run003AssignmentA,
    package: packetTemplate.package, repository: aRepository, stopDirectory, timeoutMs: value.request.timeoutMs,
  };
  await writeFile(path.join(aDirectory, 'shim', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

  const packet = { ...packetTemplate, repository: { head: currentLifecycle.head, trackedState: currentLifecycle.trackedState } };
  const packetPath = path.join(stopDirectory, `${run003AssignmentB}.json`);
  await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`);

  const command1Template = JSON.parse(await readFile(path.join(run003CheckpointFixture, 'command-evidence', 'command-000001.json')));
  const preparedA = { ...packetTemplate, assignment: { ...packetTemplate.assignment, id: run003AssignmentA }, repository: aRepository, scenario: { reference: 'ordinary-a@1' } };
  const stdout1 = Buffer.from(`${JSON.stringify(preparedA)}\n`);
  const stderr1 = Buffer.alloc(0);
  const command1 = commandRecord(command1Template, {
    argv: [value.mdlm, 'scenario', 'prepare', run003AssignmentA, '--json'], cwd: value.repository,
    timeoutMs: value.request.timeoutMs, stdout: stdout1, stderr: stderr1, exitStatus: 0,
  });
  await writeEvidenceTriplet(evidenceDirectory, '000001', command1, stdout1, stderr1);

  const stdout2 = await readFile(path.join(run003CheckpointFixture, 'command-evidence', 'command-000002.stdout'));
  const typedFailure = {
    status: 'operational-failure', error: 'MDLM could not prepare the Assignment',
    details: {
      contract: 'mdlm-demo-reserved-stop@1', type: 'assignment-checkpoint', phase: 'before-worker',
      assignment: run003AssignmentB, scenario: 'freeze-source-boundary@1', packetPath,
    },
  };
  const stderr2 = Buffer.from(`${JSON.stringify(typedFailure, null, 2)}\n`);
  const command2Template = JSON.parse(await readFile(path.join(run003CheckpointFixture, 'command-evidence', 'command-000002.json')));
  const command2 = commandRecord(command2Template, {
    argv: [
      value.mdlmPi, 'run', value.repository, '--mdlm', path.join(root, 'bin', 'mdlm-demo-mdlm-shim.mjs'),
      '--provider', value.request.operator.provider, '--model', value.request.operator.model,
      '--thinking', value.request.operator.thinking,
    ],
    cwd: value.repository, timeoutMs: value.request.timeoutMs, stdout: stdout2, stderr: stderr2, exitStatus: 1,
  });
  await writeEvidenceTriplet(evidenceDirectory, '000002', command2, stdout2, stderr2);

  const preservedSnapshotDirectory = path.join(value.scratch, 'preserved-post-snapshot');
  const snapshotExecution = exec(process.execPath, [cli, 'snapshot'], root, JSON.stringify({
    contract: 'mdlm-demo-snapshot-request@1', repository: value.repository,
    snapshotDirectory: preservedSnapshotDirectory, assignmentId: run003AssignmentA,
    timeoutMs: value.request.timeoutMs, postRun: true, provenance: value.request.provenance,
  }));
  assert.equal(snapshotExecution.status, 0, snapshotExecution.stderr);
  const preservedSnapshot = JSON.parse(snapshotExecution.stdout);
  assert.equal(preservedSnapshot.status, 'complete', snapshotExecution.stdout);
  value.request.checkpointRecovery = {
    snapshotDirectory: preservedSnapshot.snapshotDirectory,
    digest: preservedSnapshot.digest,
  };

  const context = {
    ...value, workerLog, oldLifecycle, currentLifecycle, identityDirectory, aDirectory,
    evidenceDirectory, stopDirectory, packetPath, packet, config, command1, command2,
    preservedSnapshotDirectory, preservedSnapshot,
  };
  if (mutate) await mutate(context);
  return context;
}

async function rewritePinnedSnapshot(value, update) {
  const snapshotPath = path.join(value.preservedSnapshotDirectory, 'snapshot.json');
  const manifestPath = path.join(value.preservedSnapshotDirectory, 'manifest.json');
  await chmod(snapshotPath, 0o600);
  await chmod(manifestPath, 0o600);
  const snapshot = JSON.parse(await readFile(snapshotPath));
  update(snapshot);
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  await writeFile(snapshotPath, snapshotBytes);
  const manifest = JSON.parse(await readFile(manifestPath));
  const record = manifest.files.find(item => item.path === 'snapshot.json');
  record.bytes = snapshotBytes.length;
  record.sha256 = `sha256:${createHash('sha256').update(snapshotBytes).digest('hex')}`;
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, manifestBytes);
  value.request.checkpointRecovery.digest = `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`;
}

test('run accepts the exact calculator run-002 Process Package shapes across command boundaries', async () => {
  const statusBytes = await readFile(path.join(root, 'test', 'fixtures', 'calculator-run-002-mdlm-status.stdout'));
  const assignmentBytes = await readFile(path.join(root, 'test', 'fixtures', 'calculator-run-002-assignment.stdout'));
  assert.equal(createHash('sha256').update(statusBytes).digest('hex'), '77c654d5299c452fee6a64257edd05d7a2c2cae0d8bcea8800cd19c578489d5e');
  assert.equal(createHash('sha256').update(assignmentBytes).digest('hex'), '9d81614a922c39f706885cd292d5436638cf71a68abb82924d00832f0d76be87');
  const statusPackage = JSON.parse(statusBytes).package;
  const assignmentPackage = JSON.parse(assignmentBytes).package;
  const value = await fixture({
    statusPackage,
    assignmentPackage,
    doctorPackage: statusPackage,
    packetPackage: assignmentPackage,
  });

  const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));

  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(JSON.parse(execution.stdout).status, 'completed', execution.stdout);
  const pinned = JSON.parse(await readFile(path.join(value.repository, '.git', 'mdlm-demo-orchestrator', 'run-identity.json'), 'utf8'));
  assert.deepEqual(pinned.processPackage, assignmentPackage);
});

test('run and resume submit and commit an external Assignment exactly once', async () => {
  const { scratch, repository, request } = await fixture();
  const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(request));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, 'completed', first.stdout);
  const resumedRequest = { ...request, contract: 'mdlm-demo-resume-request@1' };
  const second = exec(process.execPath, [cli, 'resume'], root, JSON.stringify(resumedRequest));
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).status, 'already-completed');
  assert.equal((await readFile(path.join(scratch, 'submit-count'), 'utf8')).trim().split('\n').length, 1);
  assert.equal(Number(git(['rev-list', '--count', 'HEAD'], repository)), 2);
  const calls = (await readFile(path.join(scratch, 'calls.log'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(a => a[0] === 'scenario' && a[1] === 'submit').length, 1);
});

test('ordinary Assignments invoke mdlm-pi with exact argv and request-bound timeout environment', async () => {
  const argvPath = path.join(os.tmpdir(), `mdlm-demo-operator-argv-${process.pid}-${Date.now()}`);
  const piScript = `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify({argv:process.argv.slice(2),commandTimeout:process.env.MDLM_PI_COMMAND_TIMEOUT_MS,assignmentTimeout:process.env.MDLM_PI_ASSIGNMENT_TIMEOUT_MS})); console.log('{"status":"process-dead-end"}'); process.exit(2);\n`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  value.request.signal = 'clean-interrupted-command';

  const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request), {
    ...process.env,
    MDLM_PI_COMMAND_TIMEOUT_MS: '1',
    MDLM_PI_ASSIGNMENT_TIMEOUT_MS: '2',
  });

  assert.equal(execution.status, 0, execution.stderr);
  const output = JSON.parse(execution.stdout);
  const expected = [
    'run', value.repository,
    '--mdlm', path.join(root, 'bin/mdlm-demo-mdlm-shim.mjs'),
    '--provider', 'openai-codex',
    '--model', 'gpt-5.6-sol',
    '--thinking', 'high',
  ];
  assert.deepEqual(JSON.parse(await readFile(argvPath, 'utf8')), {
    argv: expected,
    commandTimeout: '600000',
    assignmentTimeout: '840000',
  });
  assert.deepEqual(output.process.argv, [value.mdlmPi, ...expected]);
  const identity = JSON.parse(await readFile(path.join(value.repository, '.git', 'mdlm-demo-orchestrator', 'run-identity.json'), 'utf8'));
  assert.equal(identity.mdlmPiCommandTimeoutMs, 600_000);
  assert.equal(identity.mdlmPiAssignmentTimeoutMs, 840_000);
});

test('run and resume reject missing or unsafe operator configuration before snapshots or lifecycle commands', async () => {
  const invalidOperators = [
    undefined,
    { provider: '', model: 'gpt-5.6-sol', thinking: 'high' },
    { provider: 'openai-codex', model: 'gpt 5.6-sol', thinking: 'high' },
    { provider: 'openai-codex', model: 'gpt-5.6-sol', thinking: 'turbo' },
  ];
  for (const mode of ['run', 'resume']) {
    for (const operator of invalidOperators) {
      const value = await fixture();
      if (operator === undefined) delete value.request.operator;
      else value.request.operator = operator;
      value.request.contract = mode === 'run' ? 'mdlm-demo-run-request@1' : 'mdlm-demo-resume-request@1';

      const execution = exec(process.execPath, [cli, mode], root, JSON.stringify(value.request));

      assert.equal(execution.status, 1, `${mode}/${JSON.stringify(operator)}: ${execution.stderr}`);
      assert.equal(await stat(value.request.evidenceDirectory).then(() => true, () => false), false);
      assert.equal(await stat(path.join(value.scratch, 'calls.log')).then(() => true, () => false), false);
      assert.equal(await stat(path.join(value.scratch, 'submit-count')).then(() => true, () => false), false);
    }
  }
});

test('run and resume require safe explicit mdlm-pi timeout policy before snapshotting', async () => {
  const updates = [
    request => { delete request.mdlmPiCommandTimeoutMs; },
    request => { delete request.mdlmPiAssignmentTimeoutMs; },
    request => { request.mdlmPiCommandTimeoutMs = 0; },
    request => { request.mdlmPiAssignmentTimeoutMs = 1.5; },
    request => { request.mdlmPiCommandTimeoutMs = request.timeoutMs - 59_999; },
    request => { request.mdlmPiAssignmentTimeoutMs = request.timeoutMs; },
  ];
  for (const mode of ['run', 'resume']) {
    for (const update of updates) {
      const value = await fixture();
      value.request.contract = mode === 'run' ? 'mdlm-demo-run-request@1' : 'mdlm-demo-resume-request@1';
      update(value.request);

      const execution = exec(process.execPath, [cli, mode], root, JSON.stringify(value.request));

      assert.equal(execution.status, 1, `${mode}: ${execution.stderr}`);
      assert.match(JSON.parse(execution.stderr).error, /timeout|positive safe integer|safety reserve/);
      assert.equal(await stat(value.request.evidenceDirectory).then(() => true, () => false), false);
    }
  }
});

test('run and resume requests reject unknown top-level and checkpoint recovery keys before snapshotting', async () => {
  for (const mode of ['run', 'resume']) {
    for (const update of [
      request => { request.unreviewed = true; },
      request => {
        request.checkpointRecovery = {
          snapshotDirectory: '/tmp/preserved-post-snapshot',
          digest: `sha256:${'0'.repeat(64)}`,
          unreviewed: true,
        };
      },
    ]) {
      const value = await fixture();
      value.request.contract = mode === 'run' ? 'mdlm-demo-run-request@1' : 'mdlm-demo-resume-request@1';
      update(value.request);

      const execution = exec(process.execPath, [cli, mode], root, JSON.stringify(value.request));

      assert.equal(execution.status, 1, `${mode}: ${execution.stderr}`);
      assert.match(JSON.parse(execution.stderr).error, /unsupported|exactly/);
      assert.equal(await stat(value.request.evidenceDirectory).then(() => true, () => false), false);
    }
  }
});

test('resume rejects provider, model, or thinking drift without invoking mdlm-pi', async () => {
  const argvLog = path.join(os.tmpdir(), `mdlm-demo-operator-resume-${process.pid}-${Date.now()}`);
  const piScript = `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2))+'\\n'); console.log('{"status":"process-dead-end"}'); process.exit(2);\n`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  value.request.signal = 'clean-interrupted-command';
  const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).reason, 'process-dead-end');
  const pinned = JSON.parse(await readFile(path.join(value.repository, '.git', 'mdlm-demo-orchestrator', 'run-identity.json'), 'utf8'));
  assert.deepEqual(pinned.operator, value.request.operator);

  for (const operator of [
    { ...value.request.operator, provider: 'different-provider' },
    { ...value.request.operator, model: 'different-model' },
    { ...value.request.operator, thinking: 'medium' },
  ]) {
    const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
      ...value.request,
      contract: 'mdlm-demo-resume-request@1',
      operator,
    }));
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).reason, 'run-identity-drift');
  }
  assert.equal((await readFile(argvLog, 'utf8')).trim().split('\n').length, 1);
});

test('resume rejects mdlm-pi timeout drift without invoking mdlm-pi', async () => {
  const argvLog = path.join(os.tmpdir(), `mdlm-demo-timeout-resume-${process.pid}-${Date.now()}`);
  const piScript = `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(argvLog)}, 'called\\n'); console.log('{"status":"process-dead-end"}'); process.exit(2);\n`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  value.request.signal = 'clean-interrupted-command';
  const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(first.status, 0, first.stderr);

  for (const timeoutDrift of [
    { mdlmPiCommandTimeoutMs: 599_999 },
    { mdlmPiAssignmentTimeoutMs: 839_999 },
  ]) {
    const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
      ...value.request,
      contract: 'mdlm-demo-resume-request@1',
      ...timeoutDrift,
    }));
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).reason, 'run-identity-drift');
  }
  assert.equal((await readFile(argvLog, 'utf8')).trim().split('\n').length, 1);
});

test('a new run binds explicit timeouts when upgrading a legacy run identity, while resume refuses to invent them', async () => {
  const piScript = '#!/bin/sh\nprintf \'{"status":"process-dead-end"}\\n\'\nexit 2\n';
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  value.request.signal = 'clean-interrupted-command';
  const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(first.status, 0, first.stderr);
  const identityPath = path.join(value.repository, '.git', 'mdlm-demo-orchestrator', 'run-identity.json');
  const legacy = JSON.parse(await readFile(identityPath, 'utf8'));
  legacy.contract = 'mdlm-demo-run-identity@4';
  delete legacy.mdlmPiCommandTimeoutMs;
  delete legacy.mdlmPiAssignmentTimeoutMs;
  await writeFile(identityPath, `${JSON.stringify(legacy, null, 2)}\n`);

  const refusedResume = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
    ...value.request,
    contract: 'mdlm-demo-resume-request@1',
  }));
  assert.equal(refusedResume.status, 0, refusedResume.stderr);
  assert.equal(JSON.parse(refusedResume.stdout).reason, 'run-identity-drift');

  const upgradedRun = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(upgradedRun.status, 0, upgradedRun.stderr);
  assert.notEqual(JSON.parse(upgradedRun.stdout).reason, 'run-identity-drift');
  const upgraded = JSON.parse(await readFile(identityPath, 'utf8'));
  assert.equal(upgraded.contract, 'mdlm-demo-run-identity@5');
  assert.equal(upgraded.mdlmPiCommandTimeoutMs, 600_000);
  assert.equal(upgraded.mdlmPiAssignmentTimeoutMs, 840_000);
});

test('an uncertain submission is never repeated on resume', async () => {
  const { scratch, repository, request } = await fixture({ uncertainSubmit: true });
  const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(request));
  assert.equal(first.status, 0, first.stderr);
  const stopped = JSON.parse(first.stdout);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.reason, 'uncertain-partial-publication');
  assert.equal(stopped.transactionPhase, 'uncertain-transaction');

  const second = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({ ...request, contract: 'mdlm-demo-resume-request@1' }));
  assert.equal(second.status, 0, second.stderr);
  const refused = JSON.parse(second.stdout);
  assert.equal(refused.reason, 'uncertain-partial-publication');
  assert.equal((await readFile(path.join(scratch, 'submit-count'), 'utf8')).trim().split('\n').length, 1);
  assert.equal(Number(git(['rev-list', '--count', 'HEAD'], repository)), 1);
});

test('resume commits a durably accepted publication without resubmitting', async () => {
  const { scratch, repository, request } = await fixture();
  const executionId = '77777777-7777-4777-8777-777777777777';
  const transactionPath = `.lifecycle/data/.transactions/${executionId}/execution.json`;
  const outputPath = `.lifecycle/data/.transactions/${executionId}/recovered.json`;
  await mkdir(path.join(repository, path.dirname(transactionPath)), { recursive: true });
  await writeFile(path.join(repository, transactionPath), 'accepted execution\n');
  await writeFile(path.join(repository, outputPath), 'accepted output\n');
  const blobs = [transactionPath, outputPath].map(item => ({ path: item, oid: git(['hash-object', '--no-filters', '--', item], repository) }));
  const transactionState = assignmentDirectory(request);
  await mkdir(transactionState, { recursive: true });
  await writeFile(path.join(transactionState, 'transaction.json'), JSON.stringify({
    contract: 'mdlm-demo-transaction-journal@2', phase: 'published-uncommitted', assignmentId: request.assignmentId,
    scenario: 'register-pilot-target@1', executionId, outputPaths: [transactionPath, outputPath], blobs,
    baseCommit: git(['rev-parse', 'HEAD'], repository), responseDigest: `sha256:${'d'.repeat(64)}`,
  }));
  const resumedRequest = { ...request, contract: 'mdlm-demo-resume-request@1' };
  const first = exec(process.execPath, [cli, 'resume'], root, JSON.stringify(resumedRequest));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, 'completed');
  const second = exec(process.execPath, [cli, 'resume'], root, JSON.stringify(resumedRequest));
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).status, 'already-completed');
  assert.equal(Number(git(['rev-list', '--count', 'HEAD'], repository)), 2);
  const calls = (await readFile(path.join(scratch, 'calls.log'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.some(a => a[0] === 'scenario' && a[1] === 'submit'), false);
});

test('run refuses command provenance drift before preparing or submitting', async () => {
  const { scratch, request } = await fixture();
  request.commands.mdlmPi = '/bin/false';
  const runResult = exec(process.execPath, [cli, 'run'], root, JSON.stringify(request));
  assert.equal(runResult.status, 0, runResult.stderr);
  const output = JSON.parse(runResult.stdout);
  assert.equal(output.status, 'stopped');
  assert.equal(output.reason, 'provenance-configuration-mismatch');
  const calls = (await readFile(path.join(scratch, 'calls.log'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.some(a => a[0] === 'scenario' && a[1] === 'prepare'), false);
});

test('dirty tracked or untracked lifecycle state stops before prepare or submit', async () => {
  for (const tracked of [false, true]) {
    const { scratch, repository, request } = await fixture();
    await writeFile(
      path.join(repository, tracked ? 'tracked.txt' : 'untracked.txt'),
      tracked ? 'changed before submission\n' : 'must not be consumed\n',
    );
    const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(request));
    assert.equal(execution.status, 0, execution.stderr);
    const output = JSON.parse(execution.stdout);
    assert.equal(output.status, 'stopped');
    assert.equal(output.reason, 'repository-dirty');
    assert.equal(output.recoverable, false);
    const calls = (await readFile(path.join(scratch, 'calls.log'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.some(a => a[0] === 'scenario' && a[1] === 'prepare'), false);
    assert.equal(calls.some(a => a[0] === 'scenario' && a[1] === 'submit'), false);
  }
});

test('harness repository locator is pinned in durable run identity', async () => {
  const piScript = '#!/bin/sh\nprintf \'{"status":"process-dead-end"}\\n\'\nexit 2\n';
  const { request } = await fixture({ scenarioReference: 'ordinary@1', piScript });
  const qualified = request.provenance.qualificationHarness;
  request.harness = {
    directory: qualified.repository,
    commit: qualified.commit,
    tree: qualified.tree,
    repositoryLocator: qualified.repositoryLocator,
  };
  request.signal = 'clean-interrupted-command';
  const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(request));
  assert.equal(first.status, 0, first.stderr);
  const changed = 'https://mirror.invalid/qualification-harness.git';
  request.harness.repositoryLocator = changed;
  request.provenance.qualificationHarness.repositoryLocator = changed;
  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({ ...request, contract: 'mdlm-demo-resume-request@1' }));
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).reason, 'run-identity-drift');
});

test('a clean extra commit is nonrecoverable on resume', async () => {
  const piScript = '#!/bin/sh\nprintf \'{"status":"lifecycle-complete"}\\n\'\nexit 0\n';
  const { repository, request } = await fixture({ scenarioReference: 'ordinary@1', piScript });
  request.signal = 'clean-interrupted-command';
  const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(request));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, 'completed');
  await writeFile(path.join(repository, 'extra.txt'), 'unrelated clean commit\n');
  git(['add', '.'], repository);
  git(['commit', '-m', 'unrelated'], repository);
  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({ ...request, contract: 'mdlm-demo-resume-request@1' }));
  assert.equal(resumed.status, 0, resumed.stderr);
  const stopped = JSON.parse(resumed.stdout);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.reason, 'repository-drift');
  assert.equal(stopped.recoverable, false);
  assert.equal(stopped.postRunSnapshot.status, 'complete');
});

test('changed executable bytes cannot be blessed by changing configured provenance', async () => {
  const piScript = '#!/bin/sh\nprintf \'{"status":"process-dead-end"}\\n\'\nexit 2\n';
  const { scratch, request, mdlmPi, tooling } = await fixture({ scenarioReference: 'ordinary@1', piScript });
  request.signal = 'clean-interrupted-command';
  const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(request));
  assert.equal(first.status, 0, first.stderr);
  await writeFile(mdlmPi, `${piScript}# changed\n`);
  await chmod(mdlmPi, 0o755);
  request.provenance.tools.mdlmPi.digest = digest(mdlmPi, scratch);
  request.provenance.tooling.digest = await toolingTreeDigest(tooling);
  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({ ...request, contract: 'mdlm-demo-resume-request@1' }));
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).reason, 'run-identity-drift');
});

test('lost correction session is not fed shell stdin or restarted without controller resume support', async () => {
  const inputPath = path.join(os.tmpdir(), `mdlm-demo-correction-input-${process.pid}-${Date.now()}`);
  const responseDigest = `sha256:${createHash('sha256').update('{}\n').digest('hex')}`;
  const piScript = `#!/bin/sh\ncat > ${inputPath}\nmkdir -p .git/mdlm-pi\nprintf '%s\\n' '{"contract":"mdlm-pi-run-journal@1","phase":"submitting","assignment":{"id":"44444444-4444-4444-8444-444444444444","scenario":"ordinary@1","package":{"reference":"pkg@1","digest":"sha256:${'1'.repeat(64)}","language":"lang@1"},"repository":{"head":"PLACEHOLDER","trackedState":"TRACKED"}},"submission":{"source":"{}\\n","digest":"${responseDigest}","previousTransactionId":null,"baseCommit":"PLACEHOLDER","previousMalformedResponseDigests":[],"completedProcesses":[]}}' > .git/mdlm-pi/run.json\nprintf '%s\\n' '{"status":"assignment-correction-session-lost","assignment":{"id":"44444444-4444-4444-8444-444444444444"},"responseDigest":"${responseDigest}","diagnostics":[]}'\nexit 4\n`;
  const fixtureValue = await fixture({ scenarioReference: 'ordinary@1', piScript });
  await writeFile(fixtureValue.malformedDigestPath, responseDigest);
  const correctionHead = git(['rev-parse', 'HEAD'], fixtureValue.repository);
  const correctionTracked = `sha256:${createHash('sha256').update(`${correctionHead}\0staged\0\0worktree\0`).digest('hex')}`;
  const resolvedScript = (await readFile(fixtureValue.mdlmPi, 'utf8'))
    .replaceAll('PLACEHOLDER', correctionHead)
    .replaceAll('TRACKED', correctionTracked);
  await writeFile(fixtureValue.mdlmPi, resolvedScript);
  await chmod(fixtureValue.mdlmPi, 0o755);
  fixtureValue.request.provenance.tools.mdlmPi.digest = digest(fixtureValue.mdlmPi, fixtureValue.scratch);
  fixtureValue.request.provenance.tooling.digest = await toolingTreeDigest(fixtureValue.tooling);
  fixtureValue.request.signal = 'clean-interrupted-command';
  const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(fixtureValue.request));
  assert.equal(first.status, 0, first.stderr);
  const lost = JSON.parse(first.stdout);
  assert.equal(lost.reason, 'correction-session-lost');
  assert.equal(await readFile(inputPath, 'utf8'), '');
  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({ ...fixtureValue.request, contract: 'mdlm-demo-resume-request@1', signal: 'clean-interrupted-command' }));
  assert.equal(resumed.status, 0, resumed.stderr);
  const stopped = JSON.parse(resumed.stdout);
  assert.equal(stopped.reason, 'correction-session-unresumable');
  assert.equal(stopped.recoverable, false);
  assert.equal(await readFile(inputPath, 'utf8'), '');
});

test('ordinary mdlm-pi submitting journal resumes through its controller without stdin replay', async () => {
  const inputPath = path.join(os.tmpdir(), `mdlm-demo-ordinary-recovery-${process.pid}-${Date.now()}`);
  const piScript = `#!/bin/sh\ncat > ${inputPath}\nprintf '{"status":"lifecycle-complete"}\\n'\nexit 0\n`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  const source = '{}\n';
  const responseDigest = `sha256:${createHash('sha256').update(source).digest('hex')}`;
  const head = git(['rev-parse', 'HEAD'], value.repository);
  const trackedState = `sha256:${createHash('sha256').update(`${head}\0staged\0\0worktree\0`).digest('hex')}`;
  const piState = path.join(value.repository, '.git', 'mdlm-pi');
  await mkdir(piState, { recursive: true });
  await writeFile(path.join(piState, 'run.json'), JSON.stringify({
    contract: 'mdlm-pi-run-journal@1', phase: 'submitting',
    assignment: { id: value.assignment, scenario: 'ordinary@1', package: { reference: 'pkg@1', digest: `sha256:${'1'.repeat(64)}`, language: 'lang@1' }, repository: { head, trackedState } },
    submission: { source, digest: responseDigest, previousTransactionId: null, baseCommit: head, previousMalformedResponseDigests: [], completedProcesses: [] },
  }));
  value.request.signal = 'clean-interrupted-command';
  const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(JSON.parse(execution.stdout).status, 'completed');
  assert.equal(await readFile(inputPath, 'utf8'), '');
});

test('exact run-008 typed operational failure becomes recoverable only after a clean unchanged post-run boundary', async () => {
  const fixtureBytes = await readFile(run008OperationalFailureFixture);
  assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), '940cd1d5ee4d332907ff4d92af5b0d1789e66cb8687c60bb909324d71ad76523');
  const run008 = JSON.parse(fixtureBytes);
  const exactInitialManifest = await readFile(path.join(run008OperationalFailureDirectory, 'initial-snapshot', 'manifest.json'));
  const exactPostManifest = await readFile(path.join(run008OperationalFailureDirectory, 'post-snapshot', 'manifest.json'));
  assert.equal(`sha256:${createHash('sha256').update(exactInitialManifest).digest('hex')}`, run008.snapshot.digest);
  assert.equal(`sha256:${createHash('sha256').update(exactPostManifest).digest('hex')}`, run008.postRunSnapshot.digest);
  const exactInitial = JSON.parse(await readFile(path.join(run008OperationalFailureDirectory, 'initial-snapshot', 'snapshot.json')));
  const exactPost = JSON.parse(await readFile(path.join(run008OperationalFailureDirectory, 'post-snapshot', 'snapshot.json')));
  assert.deepEqual(exactPost.lifecycleRepository, exactInitial.lifecycleRepository);
  assert.deepEqual(exactPost.assignment, exactInitial.assignment);
  assert.equal(exactInitial.assignment.id, 'bdb9ffc9-3491-443b-88b0-80d5dc800781');
  assert.equal(exactInitial.lifecycleRepository.clean, true);
  assert.equal(exactInitial.journal.present, false);
  assert.equal(exactPost.journal.present, false);
  assert.equal(exactInitial.piJournal.present, false);
  assert.equal(exactPost.piJournal.present, false);
  const failureBytes = Buffer.from(run008.process.stderrBase64, 'base64');
  const attemptsPath = path.join(os.tmpdir(), `mdlm-demo-run008-attempts-${process.pid}-${Date.now()}`);
  const inputPath = path.join(os.tmpdir(), `mdlm-demo-run008-input-${process.pid}-${Date.now()}`);
  const piScript = `#!/usr/bin/env node
const fs=require('node:fs'); let input=''; process.stdin.on('data',chunk=>input+=chunk); process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(inputPath)},input); const attempts=fs.existsSync(${JSON.stringify(attemptsPath)})?Number(fs.readFileSync(${JSON.stringify(attemptsPath)},'utf8')):0; fs.writeFileSync(${JSON.stringify(attemptsPath)},String(attempts+1)); if(attempts===0){process.stderr.write(Buffer.from(${JSON.stringify(failureBytes.toString('base64'))},'base64')); process.exit(1);} console.log('{"status":"lifecycle-complete"}');});
`;
  const value = await fixture({ scenarioReference: 'revise-question-decision-after-review@1', piScript });
  const wording = 'Print zero as `0`; otherwise print ordinary decimal notation without trailing fractional zeros.';
  const decisionCatalogPath = path.join(value.scratch, 'decisions.json');
  const wordingDigest = `sha256:${createHash('sha256').update(wording).digest('hex')}`;
  await writeFile(decisionCatalogPath, JSON.stringify({ contract: 'mdlm-demo-decision-catalog@1', decisions: [{
    assignment: value.assignment,
    wording,
    origin: 'operator-selected',
    authorityBasis: 'Standing authorization permits this bounded correction.',
    digest: wordingDigest,
  }] }));
  value.request.signal = 'attended-review-correction';
  value.request.decisionCatalogPath = decisionCatalogPath;

  const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));

  assert.equal(first.status, 0, first.stderr);
  const recovered = JSON.parse(first.stdout);
  assert.equal(recovered.status, 'stopped');
  assert.equal(recovered.reason, 'pre-submission-operational-failure');
  assert.equal(recovered.outcome, 'pre-submission-operational-failure');
  assert.equal(recovered.recoverable, true);
  assert.equal(recovered.detail, run008.detail);
  assert.deepEqual(recovered.mdlmPi.document, run008.mdlmPi.document);
  assert.equal(recovered.operationalFailureRecovery.verified, true);
  assert.match(recovered.operationalFailureRecovery.marker.path, /operational-failure-recoveries/);
  const durableMarkerBytes = await readFile(recovered.operationalFailureRecovery.marker.path);
  const durableMarker = JSON.parse(durableMarkerBytes);
  assert.equal(durableMarker.contract, 'mdlm-demo-operational-failure-marker@1');
  assert.equal(durableMarker.assignmentId, value.assignment);
  assert.equal(durableMarker.requiredNextMode, 'run');
  assert.equal(durableMarker.timeoutIdentity.timeoutMs, 900_000);
  assert.equal(durableMarker.timeoutIdentity.mdlmPiCommandTimeoutMs, 600_000);
  assert.equal(durableMarker.timeoutIdentity.mdlmPiAssignmentTimeoutMs, 840_000);
  assert.equal(durableMarker.failure.document.digest, recovered.process.stderrSha256);
  const initial = JSON.parse(await readFile(path.join(recovered.snapshot.snapshotDirectory, 'snapshot.json'), 'utf8'));
  const post = JSON.parse(await readFile(path.join(recovered.postRunSnapshot.snapshotDirectory, 'snapshot.json'), 'utf8'));
  assert.deepEqual(post.lifecycleRepository, initial.lifecycleRepository);
  assert.equal(initial.journal.present, false);
  assert.equal(post.journal.present, false);
  assert.equal(initial.piJournal.present, false);
  assert.equal(post.piJournal.present, false);

  const refusedResume = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
    ...value.request,
    contract: 'mdlm-demo-resume-request@1',
  }));
  assert.equal(refusedResume.status, 0, refusedResume.stderr);
  const wrongMode = JSON.parse(refusedResume.stdout);
  assert.equal(wrongMode.status, 'stopped');
  assert.equal(wrongMode.reason, 'wrong-recovery-mode');
  assert.equal(wrongMode.requiredNextMode, 'run');
  assert.equal(await readFile(attemptsPath, 'utf8'), '1');
  let calls = (await readFile(path.join(value.scratch, 'calls.log'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(args => args[0] === 'scenario' && args[1] === 'prepare' && args[2] === value.assignment).length, 1);

  const second = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).status, 'completed');
  assert.equal(await readFile(attemptsPath, 'utf8'), '2');
  assert.equal(await readFile(inputPath, 'utf8'), `${wording}\n${wording}\n`);
  assert.deepEqual(await readFile(recovered.operationalFailureRecovery.marker.path), durableMarkerBytes);
  const recoveryHistory = await readdir(path.dirname(recovered.operationalFailureRecovery.marker.path));
  assert.deepEqual(recoveryHistory.sort(), ['failure-000002.json', 'retry-000002.json']);
  const transition = JSON.parse(await readFile(path.join(path.dirname(recovered.operationalFailureRecovery.marker.path), 'retry-000002.json')));
  assert.equal(transition.mode, 'run');
  assert.equal(transition.marker.digest, recovered.operationalFailureRecovery.marker.digest);
  calls = (await readFile(path.join(value.scratch, 'calls.log'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(args => args[0] === 'scenario' && args[1] === 'prepare' && args[2] === value.assignment).length, 2);
  assert.equal(calls.some(args => args[0] === 'scenario' && args[1] === 'submit'), false);
});

test('legacy run-008 command evidence migrates to a run-only marker before retry', async () => {
  const value = await operationalFailureFixture();
  const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).reason, 'pre-submission-operational-failure');
  await rm(operationalRecoveryDirectoryForTest(value), { recursive: true });

  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
    ...value.request,
    contract: 'mdlm-demo-resume-request@1',
  }));

  assert.equal(resumed.status, 0, resumed.stderr);
  const refused = JSON.parse(resumed.stdout);
  assert.equal(refused.reason, 'wrong-recovery-mode');
  assert.equal(refused.requiredNextMode, 'run');
  assert.equal(refused.operationalFailureRecovery.source, 'legacy-command-evidence-migration');
  assert.equal(await readFile(value.attemptsPath, 'utf8'), '1');
  const migrated = JSON.parse(await readFile(refused.operationalFailureRecovery.marker.path, 'utf8'));
  assert.equal(migrated.source, 'legacy-command-evidence-migration');
  assert.equal(migrated.initialBoundary.snapshotDirectory, null);

  const retried = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(JSON.parse(retried.stdout).status, 'completed');
  assert.equal(await readFile(value.attemptsPath, 'utf8'), '2');
});

test('operational failure marker publication recovers after a synced pending-write crash', async () => {
  const value = await operationalFailureFixture();
  const crashed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request), {
    ...process.env,
    MDLM_DEMO_TEST_CRASH: 'operational-recovery-marker:after-temp-sync',
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  assert.equal(await readFile(value.attemptsPath, 'utf8'), '1');
  assert.equal((await readdir(operationalRecoveryDirectoryForTest(value))).some(name => name.endsWith('.pending')), true);

  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
    ...value.request,
    contract: 'mdlm-demo-resume-request@1',
  }));

  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).reason, 'wrong-recovery-mode');
  assert.equal(await readFile(value.attemptsPath, 'utf8'), '1');
  assert.equal((await readdir(operationalRecoveryDirectoryForTest(value))).some(name => name.endsWith('.pending')), false);
});

test('a synced retry transition survives a crash without deleting failure history', async () => {
  const value = await operationalFailureFixture();
  const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(first.status, 0, first.stderr);
  const markerPath = JSON.parse(first.stdout).operationalFailureRecovery.marker.path;
  const markerBytes = await readFile(markerPath);

  const crashed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request), {
    ...process.env,
    MDLM_DEMO_TEST_CRASH: 'operational-recovery-retry:after-temp-sync',
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  assert.equal(await readFile(value.attemptsPath, 'utf8'), '1');

  const retried = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(JSON.parse(retried.stdout).status, 'completed');
  assert.equal(await readFile(value.attemptsPath, 'utf8'), '2');
  assert.deepEqual(await readFile(markerPath), markerBytes);
  assert.deepEqual((await readdir(path.dirname(markerPath))).sort(), ['failure-000002.json', 'retry-000002.json']);
});

test('tampered or ambiguous operational failure markers fail closed without worker or prepare side effects', async () => {
  for (const mutation of ['tampered', 'ambiguous']) {
    const value = await operationalFailureFixture();
    const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
    assert.equal(first.status, 0, first.stderr);
    const markerPath = JSON.parse(first.stdout).operationalFailureRecovery.marker.path;
    if (mutation === 'tampered') {
      await chmod(markerPath, 0o600);
      const marker = JSON.parse(await readFile(markerPath, 'utf8'));
      marker.requiredNextMode = 'resume';
      await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    } else {
      await writeFile(
        path.join(path.dirname(markerPath), 'failure-999999.json'),
        await readFile(markerPath),
        { mode: 0o400 },
      );
    }
    const callsBefore = (await readFile(path.join(value.scratch, 'calls.log'), 'utf8')).trim().split('\n').length;

    const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
      ...value.request,
      contract: 'mdlm-demo-resume-request@1',
    }));

    assert.equal(resumed.status, 0, `${mutation}: ${resumed.stderr}`);
    const stopped = JSON.parse(resumed.stdout);
    assert.equal(stopped.reason, 'operational-recovery-marker-invalid', mutation);
    assert.equal(stopped.recoverable, false, mutation);
    assert.equal(await readFile(value.attemptsPath, 'utf8'), '1', mutation);
    const callsAfter = (await readFile(path.join(value.scratch, 'calls.log'), 'utf8')).trim().split('\n').length;
    assert.equal(callsAfter - callsBefore, 6, mutation); // Initial and post snapshots only: doctor, status, Assignment.
  }
});

test('typed operational failure stays nonrecoverable when post-run evidence changed or became ambiguous', async () => {
  const run008 = JSON.parse(await readFile(run008OperationalFailureFixture));
  const failureBase64 = run008.process.stderrBase64;
  const mutations = {
    'repository change': "fs.writeFileSync(path.join(process.cwd(),'untracked-publication.json'),'uncertain\\n');",
    'runner transaction journal': "fs.writeFileSync(path.join(path.dirname(configPath),'..','transaction.json'),'{}\\n');",
    'mdlm-pi journal': "fs.mkdirSync(path.join(process.cwd(),'.git','mdlm-pi'),{recursive:true}); fs.writeFileSync(path.join(process.cwd(),'.git','mdlm-pi','run.json'),'{}\\n');",
    'private checkpoint evidence': "fs.mkdirSync(config.stopDirectory,{recursive:true}); fs.writeFileSync(path.join(config.stopDirectory,'ambiguous.json'),'{}\\n');",
  };
  for (const [name, mutation] of Object.entries(mutations)) {
    const piScript = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'); const configPath=process.env.MDLM_DEMO_SHIM_CONFIG; const config=JSON.parse(fs.readFileSync(configPath,'utf8')); ${mutation} process.stderr.write(Buffer.from('${failureBase64}','base64')); process.exit(1);
`;
    const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
    value.request.signal = 'clean-interrupted-command';

    const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));

    assert.equal(execution.status, 0, `${name}: ${execution.stderr}`);
    const output = JSON.parse(execution.stdout);
    assert.equal(output.status, 'stopped', name);
    assert.equal(output.reason, 'mdlm-pi-operational-failure', name);
    assert.equal(output.recoverable, false, name);
    assert.deepEqual(output.mdlmPi.document, run008.mdlmPi.document, name);
    assert.equal(output.operationalFailureRecovery?.verified ?? false, false, name);
  }

  const piScript = `#!/usr/bin/env node\nprocess.stderr.write(Buffer.from('${failureBase64}','base64')); process.exit(1);\n`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  value.request.signal = 'clean-interrupted-command';
  const preexistingStops = path.join(assignmentDirectory(value.request), 'shim', 'stops');
  await mkdir(preexistingStops, { recursive: true });
  await writeFile(path.join(preexistingStops, 'preexisting.json'), '{}\n');
  const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(execution.status, 0, execution.stderr);
  const output = JSON.parse(execution.stdout);
  assert.equal(output.reason, 'mdlm-pi-operational-failure');
  assert.equal(output.recoverable, false);
  assert.match(output.operationalFailureRecovery.uncertainty, /pre-run evidence/);
});

test('mdlm-pi exit codes and typed results distinguish lifecycle outcomes from operational failures', async () => {
  const cases = [
    [0, 'lifecycle-complete', 'completed', 'lifecycle-complete', false],
    [0, 'profile-boundary-reached', 'completed', 'profile-boundary-reached', false],
    [2, 'process-dead-end', 'stopped', 'process-dead-end', false],
    [3, 'invalid', 'stopped', 'invalid', false],
    [4, 'assignment-exhausted', 'stopped', 'assignment-exhausted', false],
    [5, 'lock-conflict', 'stopped', 'lock-conflict', true],
    [1, 'operational-failure', 'stopped', 'mdlm-pi-contract-failure', false],
  ];
  for (const [exitCode, piStatus, expectedStatus, expectedReason, recoverable] of cases) {
    const piScript = `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ status: piStatus })}'\nexit ${exitCode}\n`;
    const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
    value.request.signal = 'clean-interrupted-command';
    const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
    assert.equal(execution.status, 0, execution.stderr);
    const output = JSON.parse(execution.stdout);
    assert.equal(output.status, expectedStatus, `${exitCode}/${piStatus}`);
    assert.equal(output.reason, expectedReason, `${exitCode}/${piStatus}`);
    assert.equal(output.recoverable ?? false, recoverable, `${exitCode}/${piStatus}`);
    assert.equal(output.postRunSnapshot.status, 'complete');
  }
});

test('typed reserved stops trust only a different active Assignment checkpoint', async () => {
  const accepted = '44444444-4444-4444-8444-444444444444';
  const next = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  for (const [type, expectedStatus, outcome] of [
    ['external-adapter', 'stopped', 'pre-submission-stop'],
    ['assignment-checkpoint', 'stopped', 'pre-submission-stop'],
    ['accepted-assignment-then-external', 'completed', 'accepted-publication'],
  ]) {
    const different = type === 'accepted-assignment-then-external';
    const stop = {
      contract: 'mdlm-demo-reserved-stop@1', type, phase: 'before-worker', reason: 'fixture',
      assignment: different ? next : accepted,
      scenario: type === 'external-adapter' || different ? 'execute-verification-run@1' : 'ordinary@1',
      ...(type === 'external-adapter' ? {} : { completedAssignment: accepted }),
    };
    const piScript = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'); const config=JSON.parse(fs.readFileSync(process.env.MDLM_DEMO_SHIM_CONFIG,'utf8'));
const scratch=path.dirname(path.dirname(config.realMdlm));
if(${different}){fs.writeFileSync(path.join(scratch,'assignment-id'),'${next}'); fs.writeFileSync(path.join(scratch,'scenario-reference'),'execute-verification-run@1');}
fs.mkdirSync(config.stopDirectory,{recursive:true}); const packetPath=path.join(config.stopDirectory,'${type}.json');
fs.writeFileSync(packetPath,JSON.stringify({contract:'mdlm-assignment-packet@2',command:'scenario.prepare',ok:true,assignment:{id:'${stop.assignment}'},package:config.package,repository:config.repository,scenario:{reference:'${stop.scenario}'},responseSchema:{},exactInputs:[]}),{flag:'wx'});
const stop=${JSON.stringify(stop)}; stop.packetPath=packetPath; console.error(JSON.stringify({status:'operational-failure',cause:stop})); process.exit(1);
`;
    const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
    value.request.signal = 'clean-interrupted-command';
    const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
    assert.equal(execution.status, 0, execution.stderr);
    const output = JSON.parse(execution.stdout);
    assert.equal(output.status, expectedStatus, type);
    assert.equal(output.outcome, outcome, type);
    assert.equal(output.reason, 'reserved-shim-stop', type);
    assert.equal(output.trustedRepositoryAdvance, different, type);
    if (different) {
      assert.deepEqual(output.nextAssignment, {
        id: next,
        scenario: 'execute-verification-run@1',
        phase: 'pre-submission',
      });
    } else {
      assert.equal(output.nextAssignment, undefined);
    }
  }
});

test('a retained checkpoint cannot bless a different post-run repository boundary', async () => {
  const accepted = '44444444-4444-4444-8444-444444444444';
  const next = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const piScript = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'); const config=JSON.parse(fs.readFileSync(process.env.MDLM_DEMO_SHIM_CONFIG,'utf8'));
const scratch=path.dirname(path.dirname(config.realMdlm)); fs.writeFileSync(path.join(process.cwd(),'untrusted.txt'),'untrusted advance\\n'); execFileSync('git',['add','untrusted.txt']); execFileSync('git',['commit','-m','untrusted advance']);
fs.writeFileSync(path.join(scratch,'assignment-id'),'${next}'); fs.writeFileSync(path.join(scratch,'scenario-reference'),'ordinary-b@1');
fs.mkdirSync(config.stopDirectory,{recursive:true}); const packetPath=path.join(config.stopDirectory,'${next}.json'); fs.writeFileSync(packetPath,JSON.stringify({contract:'mdlm-assignment-packet@2',command:'scenario.prepare',ok:true,assignment:{id:'${next}'},package:config.package,repository:config.repository,scenario:{reference:'ordinary-b@1'},responseSchema:{},exactInputs:[]}));
const stop={contract:'mdlm-demo-reserved-stop@1',type:'assignment-checkpoint',phase:'before-worker',completedAssignment:'${accepted}',assignment:'${next}',scenario:'ordinary-b@1',packetPath}; console.error(JSON.stringify({status:'operational-failure',details:stop})); process.exit(1);
`;
  const value = await fixture({ scenarioReference: 'ordinary-a@1', piScript });
  value.request.signal = 'clean-interrupted-command';

  const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));

  assert.equal(execution.status, 0, execution.stderr);
  const output = JSON.parse(execution.stdout);
  assert.equal(output.status, 'stopped');
  assert.equal(output.reason, 'assignment-checkpoint-authentication-failure');
  assert.match(output.detail, /repository identity differs/);
  assert.equal(output.trustedRepositoryAdvance, false);
  assert.equal(output.nextAssignment, undefined);
  const identity = JSON.parse(await readFile(path.join(value.repository, '.git', 'mdlm-demo-orchestrator', 'repository-identity.json'), 'utf8'));
  assert.equal(identity.lastAssignment, null);
  assert.notEqual(identity.lifecycleRepository.head, git(['rev-parse', 'HEAD'], value.repository));
});

test('typed stop text without an exact retained packet is never a trusted checkpoint', async () => {
  const stop = {
    contract: 'mdlm-demo-reserved-stop@1', type: 'assignment-checkpoint', phase: 'before-worker',
    completedAssignment: '44444444-4444-4444-8444-444444444444',
    assignment: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', scenario: 'ordinary-b@1',
    packetPath: '/tmp/arbitrary-packet.json',
  };
  const piScript = `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(stop))}); console.error(JSON.stringify({status:'operational-failure',details:${JSON.stringify(stop)}})); process.exit(1);\n`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  value.request.signal = 'clean-interrupted-command';

  const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));

  assert.equal(execution.status, 0, execution.stderr);
  const output = JSON.parse(execution.stdout);
  assert.equal(output.status, 'stopped');
  assert.equal(output.reason, 'mdlm-pi-contract-failure');
  assert.equal(output.trustedRepositoryAdvance, undefined);
  assert.equal(output.nextAssignment, undefined);
});

test('calculator run-003 ordinary A to B checkpoint advances the trusted repository boundary once', async () => {
  const resultFixturePath = path.join(root, 'test', 'fixtures', 'calculator-run-003-result.json');
  const packetFixturePath = path.join(root, 'test', 'fixtures', 'calculator-run-003-stop-packet.json');
  const resultBytes = await readFile(resultFixturePath);
  const packetBytes = await readFile(packetFixturePath);
  assert.equal(createHash('sha256').update(resultBytes).digest('hex'), 'e160ce681ad4e3703bcd448e26bd26420dcfb13f643651c6fdf93ed167535cc3');
  assert.equal(createHash('sha256').update(packetBytes).digest('hex'), '9489f196547f0e70a4d0432f419c35157be67d03aa4f13ffd93a627bd65e86f8');
  const run003 = JSON.parse(resultBytes);
  const exactPacket = JSON.parse(packetBytes);
  const accepted = run003.assignmentId;
  const checkpoint = run003.stop;
  const next = checkpoint.assignment;
  assert.equal(checkpoint.type, 'assignment-checkpoint');
  assert.equal(checkpoint.completedAssignment, undefined);
  assert.equal(next, exactPacket.assignment.id);
  assert.equal(exactPacket.repository.head, '856aab804ebb097598cf75cc437f933bd0e5569d');
  assert.equal(exactPacket.scenario.reference, 'freeze-source-boundary@1');

  const piScript = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const config=JSON.parse(fs.readFileSync(process.env.MDLM_DEMO_SHIM_CONFIG,'utf8'));
const scratch=path.dirname(path.dirname(config.realMdlm)), assignmentState=path.join(scratch,'assignment-id'), scenarioState=path.join(scratch,'scenario-reference'), workerLog=path.join(scratch,'worker.log');
if(config.allowedAssignment==='${accepted}'){
  fs.writeFileSync(path.join(process.cwd(),'accepted-a.txt'),'accepted A publication 1\\n'); execFileSync('git',['add','accepted-a.txt']); execFileSync('git',['commit','-m','accepted A publication 1']);
  fs.writeFileSync(path.join(process.cwd(),'accepted-a-2.txt'),'accepted A publication 2\\n'); execFileSync('git',['add','accepted-a-2.txt']); execFileSync('git',['commit','-m','accepted A publication 2']);
  fs.writeFileSync(assignmentState,'${next}'); fs.writeFileSync(scenarioState,'freeze-source-boundary@1');
  const head=execFileSync('git',['rev-parse','HEAD^{commit}'],{encoding:'utf8'}).trim(), trackedState='sha256:'+crypto.createHash('sha256').update(head+'\\0staged\\0\\0worktree\\0').digest('hex');
  const packet=JSON.parse(fs.readFileSync(${JSON.stringify(packetFixturePath)},'utf8')); packet.repository={head,trackedState};
  fs.mkdirSync(config.stopDirectory,{recursive:true}); const packetPath=path.join(config.stopDirectory,'${next}.json'); fs.writeFileSync(packetPath,JSON.stringify(packet));
  const stop=${JSON.stringify(checkpoint)}; stop.packetPath=packetPath; stop.completedAssignment='${accepted}';
  console.error(JSON.stringify({status:'operational-failure',error:'MDLM could not prepare the Assignment',details:stop},null,2)); process.exit(1);
}
fs.appendFileSync(workerLog,config.allowedAssignment+'\\n'); console.log(JSON.stringify({status:'lifecycle-complete'}));
`;
  const value = await fixture({
    scenarioReference: 'ordinary-a@1',
    piScript,
    statusPackage: exactPacket.package,
    assignmentPackage: exactPacket.package,
    doctorPackage: { id: 'mdlm-bootstrap', version: '0.74.0', ...exactPacket.package },
    packetPackage: exactPacket.package,
  });
  value.request.signal = 'clean-interrupted-command';
  value.request.assignmentId = accepted;
  await writeFile(value.assignmentStatePath, accepted);

  const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));

  assert.equal(first.status, 0, first.stderr);
  const completedA = JSON.parse(first.stdout);
  assert.equal(completedA.status, 'completed');
  assert.equal(completedA.assignmentId, accepted);
  assert.equal(completedA.outcome, 'accepted-publication');
  assert.equal(completedA.trustedRepositoryAdvance, true);
  assert.deepEqual(completedA.nextAssignment, { id: next, scenario: 'freeze-source-boundary@1', phase: 'pre-submission' });
  const postSnapshot = JSON.parse(await readFile(path.join(completedA.postRunSnapshot.snapshotDirectory, 'snapshot.json'), 'utf8'));
  assert.equal(postSnapshot.lifecycleRepository.clean, true);
  assert.equal(postSnapshot.assignment.id, next);
  assert.equal(postSnapshot.assignment.selected, true);
  assert.equal(postSnapshot.assignment.disposition, 'active');
  assert.deepEqual(postSnapshot.assignment.repository, postSnapshot.lifecycleRepository && {
    head: postSnapshot.lifecycleRepository.head,
    trackedState: postSnapshot.lifecycleRepository.trackedState,
  });
  const repositoryIdentityPath = path.join(value.repository, '.git', 'mdlm-demo-orchestrator', 'repository-identity.json');
  const trustedBoundary = JSON.parse(await readFile(repositoryIdentityPath, 'utf8'));
  assert.deepEqual(trustedBoundary.lifecycleRepository, postSnapshot.lifecycleRepository);
  assert.deepEqual(trustedBoundary.lastAssignment, { id: accepted, outcome: 'accepted-publication', completed: true });

  const nextRequest = { ...value.request, assignmentId: next };
  const second = exec(process.execPath, [cli, 'run'], root, JSON.stringify(nextRequest));
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).status, 'completed', second.stdout);
  assert.equal((await readFile(path.join(value.scratch, 'worker.log'), 'utf8')).trim(), next);
  const prepares = (await readFile(path.join(value.scratch, 'calls.log'), 'utf8')).trim().split('\n').map(JSON.parse)
    .filter(args => args[0] === 'scenario' && args[1] === 'prepare');
  assert.equal(prepares.filter(args => args[2] === accepted).length, 1);

  await writeFile(path.join(value.repository, 'unrelated.txt'), 'unrelated advancement\n');
  git(['add', 'unrelated.txt'], value.repository);
  git(['commit', '-m', 'unrelated advancement'], value.repository);
  const drifted = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({ ...nextRequest, contract: 'mdlm-demo-resume-request@1' }));
  assert.equal(drifted.status, 0, drifted.stderr);
  assert.equal(JSON.parse(drifted.stdout).reason, 'repository-drift');
  assert.equal((await readFile(path.join(value.scratch, 'worker.log'), 'utf8')).trim(), next);
});

test('a later B resume reconciles exact old-runner A-to-B checkpoint evidence once without rerunning A', async () => {
  const realSnapshotFixture = path.join(root, 'test', 'fixtures', 'calculator-run-003-post-snapshot');
  assert.equal(
    `sha256:${createHash('sha256').update(await readFile(path.join(realSnapshotFixture, 'manifest.json'))).digest('hex')}`,
    'sha256:8bf25285f59b0deddfbbaaabbea617da6682d2f66ef239c0ff9665203da2838e',
  );
  const exactHashes = {
    'identity.json': '528e4c6d51f871efedc6afdbbbd021c91b5856a3e5557a751cfe2d555587de20',
    'command-evidence/command-000001.json': 'f5b074b82de42fe29e58042ae941ad4c7d316edc126c747bc296a896cf518787',
    'command-evidence/command-000001.stdout': 'be70f0210a33d6c918aa47d308d17c814db02cdb6fb971523096a30d121994cd',
    'command-evidence/command-000001.stderr': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'command-evidence/command-000002.json': '00ffaac956bd9043b71ce6815c8a1f7123fab40320c6e626d5e6706edef4773d',
    'command-evidence/command-000002.stdout': '48fbf6f383722ccc2d33b56ea654c53e7f42cb05d873a4a50df9cba55eb26363',
    'command-evidence/command-000002.stderr': 'f995a2a55c3a507e0f6b29a84321b8de49a4fe8c62342a4923663eea102cd0be',
    'shim/config.json': 'a0f46110f50fdba39a32e4bb2aba2b4c769906dc98a894538b0c59221e413306',
    [`shim/stops/${run003AssignmentB}.json`]: '9489f196547f0e70a4d0432f419c35157be67d03aa4f13ffd93a627bd65e86f8',
  };
  for (const [file, expected] of Object.entries(exactHashes)) {
    assert.equal(createHash('sha256').update(await readFile(path.join(run003CheckpointFixture, file))).digest('hex'), expected, file);
  }
  const value = await afterFactCheckpointFixture();
  const request = { ...value.request, contract: 'mdlm-demo-resume-request@1' };
  const realFixtureAttempt = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
    ...request,
    checkpointRecovery: {
      snapshotDirectory: realSnapshotFixture,
      digest: 'sha256:8bf25285f59b0deddfbbaaabbea617da6682d2f66ef239c0ff9665203da2838e',
    },
  }));
  assert.equal(realFixtureAttempt.status, 0, realFixtureAttempt.stderr);
  const realFixtureStop = JSON.parse(realFixtureAttempt.stdout);
  assert.equal(realFixtureStop.reason, 'checkpoint-reconciliation-failure');
  assert.match(realFixtureStop.detail, /different lifecycle repository/);
  assert.equal(await stat(value.workerLog).then(() => true, () => false), false);

  const first = exec(process.execPath, [cli, 'resume'], root, JSON.stringify(request));

  assert.equal(first.status, 0, first.stderr);
  const recovered = JSON.parse(first.stdout);
  assert.equal(recovered.status, 'stopped', first.stdout);
  assert.equal(recovered.reason, 'lock-conflict');
  assert.deepEqual(recovered.checkpointReconciliation, {
    status: 'reconciled', fromAssignment: run003AssignmentA, toAssignment: run003AssignmentB,
  });
  const reconciliationDirectory = path.join(value.identityDirectory, 'checkpoint-reconciliations');
  const reconciliationFiles = await readdir(reconciliationDirectory);
  assert.deepEqual(reconciliationFiles, [`${assignmentKeyForTest(run003AssignmentA)}-to-${assignmentKeyForTest(run003AssignmentB)}.json`]);
  const reconciliationPath = path.join(reconciliationDirectory, reconciliationFiles[0]);
  const reconciliationBytes = await readFile(reconciliationPath);
  const reconciliation = JSON.parse(reconciliationBytes);
  assert.equal(reconciliation.checkpointRecovery.snapshotDirectory, value.preservedSnapshotDirectory);
  assert.equal(reconciliation.checkpointRecovery.digest, value.preservedSnapshot.digest);
  assert.equal(reconciliation.checkpointRecovery.manifest.digest, value.preservedSnapshot.digest);
  const completedAPath = path.join(value.aDirectory, 'transaction.json');
  const completedABytes = await readFile(completedAPath);
  const completedA = JSON.parse(completedABytes);
  assert.equal(completedA.phase, 'completed');
  assert.equal(completedA.assignmentId, run003AssignmentA);
  assert.equal(completedA.outcome, 'accepted-publication');
  assert.deepEqual(completedA.completedRepository, value.currentLifecycle);
  assert.deepEqual(completedA.checkpointRecovery, reconciliation.checkpointRecovery);
  const trusted = JSON.parse(await readFile(path.join(value.identityDirectory, 'repository-identity.json')));
  assert.deepEqual(trusted.lifecycleRepository, value.currentLifecycle);
  assert.deepEqual(trusted.lastAssignment, { id: run003AssignmentA, outcome: 'accepted-publication', completed: true });
  const callsAfterFirst = (await readFile(path.join(value.scratch, 'calls.log'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(callsAfterFirst.some(args => args[0] === 'scenario' && args[1] === 'prepare' && args[2] === run003AssignmentA), false);
  assert.deepEqual((await readFile(value.workerLog, 'utf8')).trim().split('\n'), [run003AssignmentB]);
  assert.deepEqual(cleanLifecycle(value.repository), value.currentLifecycle);

  const second = exec(process.execPath, [cli, 'resume'], root, JSON.stringify(request));

  assert.equal(second.status, 0, second.stderr);
  const repeated = JSON.parse(second.stdout);
  assert.equal(repeated.reason, 'lock-conflict');
  assert.deepEqual(repeated.checkpointReconciliation, {
    status: 'already-reconciled', fromAssignment: run003AssignmentA, toAssignment: run003AssignmentB,
  });
  assert.deepEqual(await readFile(reconciliationPath), reconciliationBytes);
  assert.deepEqual(await readFile(completedAPath), completedABytes);
  assert.deepEqual((await readFile(value.workerLog, 'utf8')).trim().split('\n'), [run003AssignmentB, run003AssignmentB]);
  assert.deepEqual(cleanLifecycle(value.repository), value.currentLifecycle);
  const allCalls = (await readFile(path.join(value.scratch, 'calls.log'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(allCalls.some(args => args[0] === 'scenario' && args[1] === 'prepare' && args[2] === run003AssignmentA), false);
});

test('checkpoint reconciliation resumes after durable global-boundary and A-completion crash seams', async () => {
  for (const seam of ['checkpoint-reconciliation-global:after-rename', 'checkpoint-reconciliation-assignment:after-rename']) {
    const value = await afterFactCheckpointFixture();
    const request = { ...value.request, contract: 'mdlm-demo-resume-request@1' };

    const crashed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify(request), {
      ...process.env, MDLM_DEMO_TEST_CRASH: seam,
    });
    assert.equal(crashed.status, 86, `${seam}: ${crashed.stderr}`);
    assert.equal(await stat(value.workerLog).then(() => true, () => false), false, seam);

    const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify(request));
    assert.equal(resumed.status, 0, `${seam}: ${resumed.stderr}`);
    const output = JSON.parse(resumed.stdout);
    assert.equal(output.reason, 'lock-conflict', `${seam}: ${resumed.stdout}`);
    assert.deepEqual(output.checkpointReconciliation, {
      status: 'reconciled', fromAssignment: run003AssignmentA, toAssignment: run003AssignmentB,
    });
    assert.deepEqual((await readFile(value.workerLog, 'utf8')).trim().split('\n'), [run003AssignmentB]);
    const completedA = JSON.parse(await readFile(path.join(value.aDirectory, 'transaction.json')));
    assert.equal(completedA.phase, 'completed');
    const reconciliationFiles = await readdir(path.join(value.identityDirectory, 'checkpoint-reconciliations'));
    assert.equal(reconciliationFiles.length, 1, seam);
    const reconciliation = JSON.parse(await readFile(path.join(value.identityDirectory, 'checkpoint-reconciliations', reconciliationFiles[0])));
    assert.equal(reconciliation.phase, 'completed');
  }
});

test('after-the-fact checkpoint reconciliation rejects tamper, stale boundaries, symlinks, and ambiguous evidence', async () => {
  const rewrite = async (file, update) => {
    const value = JSON.parse(await readFile(file));
    update(value);
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  const cases = [
    ['missing operator-pinned snapshot', value => { delete value.request.checkpointRecovery; }],
    ['wrong operator-pinned digest', value => { value.request.checkpointRecovery.digest = `sha256:${'0'.repeat(64)}`; }],
    ['tampered pinned manifest', async value => {
      const manifest = path.join(value.preservedSnapshotDirectory, 'manifest.json');
      await chmod(manifest, 0o600);
      await writeFile(manifest, Buffer.concat([await readFile(manifest), Buffer.from('\n')]));
    }],
    ['tampered manifest-bound snapshot file', async value => {
      const snapshotFile = path.join(value.preservedSnapshotDirectory, 'snapshot.json');
      await chmod(snapshotFile, 0o600);
      await writeFile(snapshotFile, Buffer.concat([await readFile(snapshotFile), Buffer.from('\n')]));
    }],
    ['symlinked pinned snapshot directory', async value => {
      const link = path.join(value.scratch, 'preserved-post-snapshot-link');
      await symlink(value.preservedSnapshotDirectory, link);
      value.request.checkpointRecovery.snapshotDirectory = link;
    }],
    ['internally consistent pre-run snapshot', value => rewritePinnedSnapshot(value, snapshot => { snapshot.postRun = false; })],
    ['pinned snapshot names wrong Assignment A', value => rewritePinnedSnapshot(value, snapshot => {
      snapshot.assignment.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    })],
    ['pinned snapshot names wrong active Assignment B', value => rewritePinnedSnapshot(value, snapshot => {
      snapshot.status.currentOutcome.assignment.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    })],
    ['pinned snapshot has wrong Process Package', value => rewritePinnedSnapshot(value, snapshot => {
      snapshot.status.package.digest = `sha256:${'0'.repeat(64)}`;
    })],
    ['pinned snapshot names wrong lifecycle repository', value => rewritePinnedSnapshot(value, snapshot => {
      snapshot.repository = '/tmp/unrelated-lifecycle-repository';
    })],
    ['changed raw command bytes', async value => {
      await writeFile(path.join(value.evidenceDirectory, 'command-000002.stdout'), Buffer.concat([
        await readFile(path.join(value.evidenceDirectory, 'command-000002.stdout')), Buffer.from('forged\n'),
      ]));
    }],
    ['missing raw command bytes', value => rm(path.join(value.evidenceDirectory, 'command-000002.stderr'))],
    ['missing retained packet', value => rm(value.packetPath)],
    ['forged process termination', value => rewrite(path.join(value.evidenceDirectory, 'command-000002.json'), record => { record.exitStatus = 0; })],
    ['wrong mdlm-pi executable', value => rewrite(path.join(value.evidenceDirectory, 'command-000002.json'), record => { record.argv[0] = '/bin/false'; })],
    ['wrong command repository', value => rewrite(path.join(value.evidenceDirectory, 'command-000002.json'), record => { record.argv[2] = '/tmp/different-repository'; })],
    ['wrong operator', value => rewrite(path.join(value.evidenceDirectory, 'command-000002.json'), record => { record.argv[6] = 'different-provider'; })],
    ['wrong shim', value => rewrite(path.join(value.evidenceDirectory, 'command-000002.json'), record => { record.argv[4] = '/tmp/different-shim'; })],
    ['wrong configured mdlm executable', value => rewrite(path.join(value.aDirectory, 'shim', 'config.json'), config => { config.realMdlm = '/bin/false'; })],
    ['wrong package', value => rewrite(value.packetPath, packet => { packet.package.digest = `sha256:${'0'.repeat(64)}`; })],
    ['stale packet HEAD', value => rewrite(value.packetPath, packet => { packet.repository = { head: value.oldLifecycle.head, trackedState: value.oldLifecycle.trackedState }; })],
    ['same-A stop', async value => {
      await rewrite(value.packetPath, packet => { packet.assignment.id = run003AssignmentA; });
      await rewrite(path.join(value.evidenceDirectory, 'command-000002.stderr'), failure => { failure.details.assignment = run003AssignmentA; });
      const stderr = await readFile(path.join(value.evidenceDirectory, 'command-000002.stderr'));
      await rewrite(path.join(value.evidenceDirectory, 'command-000002.json'), record => {
        record.stderrBase64 = stderr.toString('base64');
        record.stderrSha256 = `sha256:${createHash('sha256').update(stderr).digest('hex')}`;
        record.observedOutputBytes = Buffer.from(record.stdoutBase64, 'base64').length + stderr.length;
      });
    }],
    ['symlinked raw evidence', async value => {
      const file = path.join(value.evidenceDirectory, 'command-000002.stdout');
      const outside = path.join(value.scratch, 'outside.stdout');
      await writeFile(outside, await readFile(file));
      await rm(file);
      await symlink(outside, file);
    }],
    ['ambiguous later command', async value => {
      const stdout = await readFile(path.join(value.evidenceDirectory, 'command-000002.stdout'));
      const stderr = await readFile(path.join(value.evidenceDirectory, 'command-000002.stderr'));
      await writeEvidenceTriplet(value.evidenceDirectory, '000003', value.command2, stdout, stderr);
    }],
    ['ambiguous later stop', value => writeFile(path.join(value.stopDirectory, 'later.json'), JSON.stringify(value.packet))],
    ['unrelated clean advancement', async value => {
      await writeFile(path.join(value.repository, 'unrelated.txt'), 'unrelated advancement\n');
      git(['add', 'unrelated.txt'], value.repository);
      git(['commit', '-m', 'unrelated advancement'], value.repository);
    }],
    ['packet repository changed to the unrelated current clean boundary', async value => {
      await writeFile(path.join(value.repository, 'unrelated.txt'), 'unrelated advancement\n');
      git(['add', 'unrelated.txt'], value.repository);
      git(['commit', '-m', 'unrelated advancement'], value.repository);
      const unrelated = cleanLifecycle(value.repository);
      await rewrite(value.packetPath, packet => {
        packet.repository = { head: unrelated.head, trackedState: unrelated.trackedState };
      });
    }],
  ];

  for (const [name, mutate] of cases) {
    const value = await afterFactCheckpointFixture({ mutate });
    const execution = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
      ...value.request, contract: 'mdlm-demo-resume-request@1',
    }));
    assert.equal(execution.status, 0, `${name}: ${execution.stderr}`);
    const output = JSON.parse(execution.stdout);
    assert.equal(output.status, 'stopped', `${name}: ${execution.stdout}`);
    assert.equal(output.reason, 'checkpoint-reconciliation-failure', `${name}: ${execution.stdout}`);
    assert.equal(await stat(value.workerLog).then(() => true, () => false), false, name);
    const trusted = JSON.parse(await readFile(path.join(value.identityDirectory, 'repository-identity.json')));
    assert.deepEqual(trusted.lifecycleRepository, value.oldLifecycle, name);
    assert.equal(await stat(path.join(value.aDirectory, 'transaction.json')).then(() => true, () => false), false, name);
  }
});

test('after-the-fact checkpoint reconciliation never blesses a dirty current repository', async () => {
  const value = await afterFactCheckpointFixture();
  await writeFile(path.join(value.repository, 'dirty.txt'), 'dirty\n');

  const execution = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
    ...value.request, contract: 'mdlm-demo-resume-request@1',
  }));

  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(JSON.parse(execution.stdout).reason, 'repository-dirty');
  assert.equal(await stat(value.workerLog).then(() => true, () => false), false);
  const trusted = JSON.parse(await readFile(path.join(value.identityDirectory, 'repository-identity.json')));
  assert.deepEqual(trusted.lifecycleRepository, value.oldLifecycle);
});

test('controlled worker environment strips Git, Node, and shell startup injection variables', async () => {
  const observedPath = path.join(os.tmpdir(), `mdlm-demo-environment-${process.pid}-${Date.now()}`);
  const piScript = `#!/bin/sh\nenv | sort > ${observedPath}\nprintf '%s\\n' '{"status":"lifecycle-complete"}'\n`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  value.request.signal = 'clean-interrupted-command';
  const hostile = {
    ...process.env,
    GIT_DIR: '/tmp/hostile-git-dir',
    GIT_CONFIG_GLOBAL: '/tmp/hostile-git-config',
    NODE_OPTIONS: '--no-warnings',
    NODE_PATH: '/tmp/hostile-node-path',
    BASH_ENV: '/tmp/hostile-bash-env',
    ENV: '/tmp/hostile-env',
  };
  const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request), hostile);
  assert.equal(execution.status, 0, execution.stderr);
  const observed = await readFile(observedPath, 'utf8');
  for (const name of ['GIT_DIR', 'GIT_CONFIG_GLOBAL', 'NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV']) {
    assert.equal(observed.includes(`${name}=`), false, name);
  }
  const snapshotRecord = JSON.parse(await readFile(path.join(JSON.parse(execution.stdout).snapshot.snapshotDirectory, 'snapshot.json'), 'utf8'));
  assert.equal(snapshotRecord.environmentPolicy.gitConfigIsolation, true);
  assert.ok(snapshotRecord.environmentPolicy.removed.includes('NODE_OPTIONS'));
});

test('successive ordinary Assignments use immutable Assignment-keyed state', async () => {
  const piScript = '#!/bin/sh\nprintf \'{"status":"lifecycle-complete"}\\n\'\n';
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  value.request.signal = 'clean-interrupted-command';
  const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(JSON.parse(first.stdout).status, 'completed', first.stderr);
  const secondAssignment = '66666666-6666-4666-8666-666666666666';
  await writeFile(value.assignmentStatePath, secondAssignment);
  const secondRequest = { ...value.request, assignmentId: secondAssignment };
  const second = exec(process.execPath, [cli, 'run'], root, JSON.stringify(secondRequest));
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).status, 'completed');
  const directories = await readFile(path.join(assignmentDirectory(value.request), 'identity.json'), 'utf8');
  assert.equal(JSON.parse(directories).assignmentId, value.assignment);
  assert.equal(JSON.parse(await readFile(path.join(assignmentDirectory(secondRequest), 'identity.json'), 'utf8')).assignmentId, secondAssignment);
});

test('publication rejects traversal, malformed execution identities, and symlink parents before Git staging', async () => {
  const traversal = await fixture({ publicationPath: '.lifecycle/data/.transactions/55555555-5555-4555-8555-555555555555/../outside.json' });
  const traversed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(traversal.request));
  assert.equal(JSON.parse(traversed.stdout).reason, 'uncertain-partial-publication');
  assert.equal(Number(git(['rev-list', '--count', 'HEAD'], traversal.repository)), 1);

  const malformed = await fixture({ executionId: 'not-an-execution-id' });
  const malformedResult = exec(process.execPath, [cli, 'run'], root, JSON.stringify(malformed.request));
  assert.equal(JSON.parse(malformedResult.stdout).reason, 'uncertain-partial-publication');
  assert.equal(Number(git(['rev-list', '--count', 'HEAD'], malformed.repository)), 1);

  const executionId = '99999999-9999-4999-8999-999999999999';
  const linkedPath = `.lifecycle/data/.transactions/${executionId}/linked/target.json`;
  const linked = await fixture({ executionId, publicationPath: linkedPath });
  const outside = path.join(linked.scratch, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'target.json'), 'outside\n');
  const transaction = path.join(linked.repository, '.lifecycle/data/.transactions', executionId);
  await mkdir(transaction, { recursive: true });
  await symlink(outside, path.join(transaction, 'linked'));
  const linkedResult = exec(process.execPath, [cli, 'run'], root, JSON.stringify(linked.request));
  assert.equal(JSON.parse(linkedResult.stdout).reason, 'repository-dirty');
  assert.equal(Number(git(['rev-list', '--count', 'HEAD'], linked.repository)), 1);
});

test('durable submitting transition prevents duplicate submit across injected crash seams', async () => {
  for (const seam of ['submitting:after-temp-sync', 'submitting:after-rename']) {
    const value = await fixture();
    const crashed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request), { ...process.env, MDLM_DEMO_TEST_CRASH: seam });
    assert.equal(crashed.status, 86, seam);
    const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({ ...value.request, contract: 'mdlm-demo-resume-request@1' }));
    assert.equal(resumed.status, 0, resumed.stderr);
    const submitCount = await readFile(path.join(value.scratch, 'submit-count'), 'utf8').catch(() => '');
    assert.ok(submitCount.trim().split('\n').filter(Boolean).length <= 1, seam);
    if (seam.endsWith('after-rename')) assert.equal(JSON.parse(resumed.stdout).reason, 'uncertain-partial-publication');
  }
});

test('resume recognizes a commit completed immediately before the publication journal update', async () => {
  const value = await fixture();
  const crashed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request), {
    ...process.env, MDLM_DEMO_TEST_CRASH: 'publication:after-git-commit',
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  assert.equal(Number(git(['rev-list', '--count', 'HEAD'], value.repository)), 2);
  assert.equal(JSON.parse(await readFile(path.join(assignmentDirectory(value.request), 'transaction.json'), 'utf8')).phase, 'published-uncommitted');

  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({ ...value.request, contract: 'mdlm-demo-resume-request@1' }));
  assert.equal(resumed.status, 0, resumed.stderr);
  const recovered = JSON.parse(resumed.stdout);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.recoveredPublication, true);
  assert.equal(Number(git(['rev-list', '--count', 'HEAD'], value.repository)), 2);
  assert.equal((await readFile(path.join(value.scratch, 'submit-count'), 'utf8')).trim().split('\n').length, 1);
  const calls = (await readFile(path.join(value.scratch, 'calls.log'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(args => args[0] === 'scenario' && args[1] === 'submit').length, 1);

  const second = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({ ...value.request, contract: 'mdlm-demo-resume-request@1' }));
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).status, 'already-completed');
  assert.equal(Number(git(['rev-list', '--count', 'HEAD'], value.repository)), 2);
});

test('an unrelated HEAD after a journaled publication remains repository drift', async () => {
  const value = await fixture();
  const crashed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request), {
    ...process.env, MDLM_DEMO_TEST_CRASH: 'publication:after-git-commit',
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  await writeFile(path.join(value.repository, 'unrelated.txt'), 'unrelated advance\n');
  git(['add', 'unrelated.txt'], value.repository);
  git(['commit', '-m', 'unrelated advance'], value.repository);

  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({ ...value.request, contract: 'mdlm-demo-resume-request@1' }));
  assert.equal(resumed.status, 0, resumed.stderr);
  const stopped = JSON.parse(resumed.stdout);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.reason, 'repository-drift');
  assert.equal(Number(git(['rev-list', '--count', 'HEAD'], value.repository)), 3);
  assert.equal((await readFile(path.join(value.scratch, 'submit-count'), 'utf8')).trim().split('\n').length, 1);
});

test('simultaneous starts publish only one fully initialized canonical repository lock', async () => {
  const writerLog = path.join(os.tmpdir(), `mdlm-demo-lock-writers-${process.pid}-${Date.now()}`);
  const piScript = `#!/usr/bin/env node\nconst fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(writerLog)},'writer\\n'); setTimeout(()=>{console.log(JSON.stringify({status:'lifecycle-complete'}));},1500);\n`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  value.request.signal = 'clean-interrupted-command';
  const barrier = path.join(value.scratch, 'lock-barrier');
  await mkdir(barrier);
  const secondRequest = {
    ...value.request,
    stateDirectory: path.join(value.scratch, 'independent-state'),
    evidenceDirectory: path.join(value.scratch, 'independent-evidence'),
  };
  const launch = request => {
    const child = spawn(process.execPath, [cli, 'run'], {
      cwd: root,
      env: { ...process.env, MDLM_DEMO_TEST_LOCK_BARRIER: barrier },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end(JSON.stringify(request));
    return new Promise(resolve => child.once('close', status => resolve({ status, stdout, stderr })));
  };
  const first = launch(value.request);
  const second = launch(secondRequest);
  let ready = [];
  for (let attempt = 0; attempt < 200; attempt++) {
    ready = (await readdir(barrier)).filter(name => name.startsWith('ready-'));
    if (ready.length === 2) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(ready.length, 2, 'both contenders reached the staged-owner acquisition barrier');
  const canonicalLock = path.join(value.repository, '.git', 'mdlm-demo-orchestrator', 'writer.lock');
  await assert.rejects(stat(canonicalLock), error => error.code === 'ENOENT');
  await writeFile(path.join(barrier, 'release'), 'release\n');
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.status).sort(), [0, 1]);
  const winner = results.find(result => result.status === 0);
  const excluded = results.find(result => result.status === 1);
  assert.equal(JSON.parse(winner.stdout).status, 'completed');
  assert.match(excluded.stderr, /lifecycle repository writer lock is held/);
  assert.deepEqual((await readFile(writerLog, 'utf8')).trim().split('\n'), ['writer']);
});

test('a fresh ownerless canonical lock is treated as initializing, not stale', async () => {
  const value = await fixture();
  const identityDirectory = path.join(value.repository, '.git', 'mdlm-demo-orchestrator');
  await mkdir(path.join(identityDirectory, 'writer.lock'), { recursive: true });
  const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /lifecycle repository writer lock is initializing/);
  await assert.rejects(stat(value.request.evidenceDirectory), error => error.code === 'ENOENT');
});

test('canonical lifecycle repository lock excludes an independent state directory before snapshot', async () => {
  const marker = path.join(os.tmpdir(), `mdlm-demo-lock-marker-${process.pid}-${Date.now()}`);
  const piScript = `#!/bin/sh\n: > ${marker}\nsleep 2\nprintf '%s\\n' '{"status":"lifecycle-complete"}'\n`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  value.request.signal = 'clean-interrupted-command';
  const child = spawn(process.execPath, [cli, 'run'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify(value.request));
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await stat(marker); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  await stat(marker);
  const repositoryAlias = path.join(value.scratch, 'repository-alias');
  await symlink(value.repository, repositoryAlias);
  const secondRequest = {
    ...value.request,
    repository: repositoryAlias,
    stateDirectory: path.join(value.scratch, 'independent-state'),
    evidenceDirectory: path.join(value.scratch, 'independent-evidence'),
  };
  const excluded = exec(process.execPath, [cli, 'run'], root, JSON.stringify(secondRequest));
  assert.equal(excluded.status, 1);
  assert.match(excluded.stderr, /lifecycle repository writer lock is held/);
  await assert.rejects(stat(secondRequest.evidenceDirectory), error => error.code === 'ENOENT');
  const status = await new Promise(resolve => child.once('close', resolve));
  assert.equal(status, 0, stderr);
  assert.equal(JSON.parse(stdout).status, 'completed');
});

test('attended correction re-entry passes an operator-selected catalog decision to mdlm-pi', async () => {
  const inputPath = path.join(os.tmpdir(), `issue-213-pi-input-${process.pid}-${Date.now()}`);
  const piScript = `#!/bin/sh\ncat > ${inputPath}\nprintf '%s\\n' '{"status":"lifecycle-complete"}'\nexit 0\n`;
  const { scratch, request } = await fixture({ scenarioReference: 'review-correction@1', piScript });
  const wording = 'Use the smallest correction that preserves the accepted evidence boundary.';
  const decisionCatalogPath = path.join(scratch, 'decisions.json');
  const digestValue = `sha256:${createHash('sha256').update(wording).digest('hex')}`;
  await writeFile(decisionCatalogPath, JSON.stringify({ contract: 'mdlm-demo-decision-catalog@1', decisions: [{
    assignment: request.assignmentId, wording, origin: 'operator-selected',
    authorityBasis: 'Standing authorization permits operator selection without pausing for user input.', digest: digestValue,
  }] }));
  const attended = { ...request, signal: 'attended-review-correction', decisionCatalogPath };
  const runResult = exec(process.execPath, [cli, 'run'], root, JSON.stringify(attended));
  assert.equal(runResult.status, 0, runResult.stderr);
  const output = JSON.parse(runResult.stdout);
  assert.equal(output.status, 'completed');
  assert.deepEqual(output.decision, { origin: 'operator-selected', authorityBasis: 'Standing authorization permits operator selection without pausing for user input.', digest: digestValue });
  assert.equal(await readFile(inputPath, 'utf8'), `${wording}\n`);
});
