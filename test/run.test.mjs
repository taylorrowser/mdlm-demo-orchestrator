import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
  correctionRequiredSubmit = false,
  correctionsRemaining = 1,
  scenarioReference = 'register-pilot-target@1',
  piScript = '#!/bin/sh\nexit 0\n',
  executionId = '55555555-5555-4555-8555-555555555555',
  publicationPath,
  statusPackage = { reference: 'pkg@1', digest: `sha256:${'1'.repeat(64)}`, language: 'lang@1' },
  assignmentPackage = statusPackage,
  doctorPackage = { id: 'pkg', version: '1', ...statusPackage },
  packetPackage = assignmentPackage,
  materializedNext = false,
  attentionRequired = false,
  assignmentSelected = true,
} = {}) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'issue-213-run-'));
  const repository = path.join(scratch, 'repository');
  await mkdir(repository);
  git(['init', '-b', 'main'], repository); git(['config', 'user.name', 'Test'], repository); git(['config', 'user.email', 'test@example.invalid'], repository);
  await writeFile(path.join(repository, 'README.md'), 'fixture\n'); git(['add', '.'], repository); git(['commit', '-m', 'initial'], repository);
  if (materializedNext) await writeFile(path.join(repository, '.git', 'info', 'exclude'), '.lifecycle/work/\n');
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
  const nextCountPath = path.join(scratch, 'next-count');
  const staleAssignment = '77777777-7777-4777-8777-777777777777';
  const finalAssignment = '88888888-8888-4888-8888-888888888888';
  const materializedExecution = '66666666-6666-4666-8666-666666666666';
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
const correctionDiagnostics=[{code:'scenario-output-required-link-missing',path:'outputs.target.links.derived-from',message:'required link missing'}];
const malformedPath=${JSON.stringify(malformedDigestPath)}, malformedResponses=fs.existsSync(malformedPath)?[{digest:fs.readFileSync(malformedPath,'utf8'),diagnostics:correctionDiagnostics}]:[];
const statusPackage=${JSON.stringify(statusPackage)}, assignmentPackage=${JSON.stringify(assignmentPackage)}, doctorPackage=${JSON.stringify(doctorPackage)}, packetPackage=${JSON.stringify(packetPackage)};
function repository(){const head=execFileSync('git',['rev-parse','HEAD^{commit}'],{encoding:'utf8'}).trim(); const staged=execFileSync('git',['diff','--binary','--no-ext-diff','--cached','HEAD','--'],{encoding:'utf8'}); const worktree=execFileSync('git',['diff','--binary','--no-ext-diff','--'],{encoding:'utf8'}); return {head,trackedState:'sha256:'+crypto.createHash('sha256').update(head+'\\0staged\\0'+staged+'\\0worktree\\0'+worktree).digest('hex')}}
const repo=repository();
function out(x){process.stdout.write(JSON.stringify(x)+'\\n')}
if(a[0]==='doctor') out({ok:true,command:'doctor',package:doctorPackage,baselineRepositoryVerification:{verifiedBaselines:0,processDrift:0},index:{rebuilt:false,data:0,path:'.lifecycle/generated/indexes/data.json'},report:{rebuilt:false,data:0,path:'.lifecycle/generated/reports/lifecycle.json'},diagnostics:[]});
else if(a[0]==='status') out({contract:'mdlm-status@1',ok:true,command:'status',package:statusPackage,currentOutcome:${assignmentSelected ? (attentionRequired ? "{outcome:'attention-required',assignment:{allocation:'active',id:assignment},authorityRequirement:{mode:'attended',authority:'stakeholder',delegationAllowed:false}}" : "{outcome:'assignment',assignment:{allocation:'active',id:assignment}}") : "{outcome:'assignment',assignment:{allocation:'not-allocated'}}"},recentTransaction:${assignmentSelected ? "{available:false}" : "{available:true,id:'99999999-9999-4999-8999-999999999999',status:'completed',scenario:'ordinary@1'}"}});
else if(a[0]==='assignment') { const requested=a[2]; if(requested!==assignment||!${assignmentSelected}) out({contract:'mdlm-assignment-state@1',ok:true,command:'assignment.show',assignment:{id:requested},selected:false,diagnostics:[]}); else out({contract:'mdlm-assignment-state@1',ok:true,command:'assignment.show',assignment:{id:assignment},selected:true,package:assignmentPackage,repository:repo,scenarioReference:scenario,disposition:'active',retryAvailability:{},malformedResponses}); }
else if(a[0]==='scenario'&&a[1]==='prepare') out({contract:'mdlm-assignment-packet@2',ok:true,command:'scenario.prepare',assignment:{id:assignment},package:packetPackage,repository:repo,scenario:{reference:scenario},responseSchema:{},exactInputs:[]});
else if(a[0]==='scenario'&&a[1]==='submit') { let chunks=[]; process.stdin.on('data',x=>chunks.push(x)); process.stdin.on('end',()=>{const bytes=Buffer.concat(chunks); fs.appendFileSync(${JSON.stringify(path.join(scratch, 'submit-count'))},'1\\n'); const digest='sha256:'+crypto.createHash('sha256').update(bytes).digest('hex'); if(${correctionRequiredSubmit}&&!fs.existsSync(malformedPath)) { fs.writeFileSync(malformedPath,digest); out({ok:false,command:'scenario.submit',contract:'mdlm-assignment-disposition@1',assignment:{id:assignment},disposition:'correction-required',orchestration:{action:'correct-response',automaticReplacement:false},malformedResponse:{attempt:1,correctionsRemaining:${correctionsRemaining},diagnostics:correctionDiagnostics},diagnostics:correctionDiagnostics}); process.exitCode=1; } else { const id=${JSON.stringify(executionId)}; const dir=path.join(root,'.lifecycle/data/.transactions',id); fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,'execution.json'),'execution\\n'); fs.writeFileSync(path.join(dir,'target.json'),'target\\n'); if(${uncertainSubmit}) process.exit(9); else out({contract:'mdlm-scenario-execution@4',ok:true,command:'scenario.submit',execution:{contract:'mdlm-scenario-execution@4',id,status:'completed',response:{assignment,digest},definition:{scenario},outputs:[{lifecycleDatum:{path:${publicationPath ? JSON.stringify(publicationPath) : "'.lifecycle/data/.transactions/'+id+'/target.json'"}}}]}}); } }); }
else if(a[0]==='next') {
  const countPath=${JSON.stringify(nextCountPath)}, count=fs.existsSync(countPath)?Number(fs.readFileSync(countPath,'utf8')):0; fs.writeFileSync(countPath,String(count+1));
  if(${materializedNext}&&count===0){
    const id=${JSON.stringify(materializedExecution)}, stale=${JSON.stringify(staleAssignment)}, tx='.lifecycle/data/.transactions/'+id, output=tx+'/REV/REV-AUTO/r00001.md';
    fs.mkdirSync(path.join(root,tx,'REV/REV-AUTO'),{recursive:true}); fs.writeFileSync(path.join(root,output),'automatic review context\\n');
    fs.writeFileSync(path.join(root,tx,'execution.json'),JSON.stringify({contract:'mdlm-scenario-execution@4',id,status:'completed',response:{contract:'mdlm-assignment-response@1',assignment:'package-authored'},definition:{scenario:'create-review-context@1'},outputs:[{lifecycleDatum:{path:output}}]},null,2)+'\\n');
    fs.writeFileSync(${JSON.stringify(assignmentStatePath)},stale); fs.writeFileSync(${JSON.stringify(scenarioStatePath)},'environment-review@1');
    fs.mkdirSync(path.join(root,'.lifecycle/work'),{recursive:true}); fs.writeFileSync(path.join(root,'.lifecycle/work/active-assignment.json'),JSON.stringify({contract:'mdlm-assignment-lease@1',id:stale,disposition:'active',package:statusPackage,repository:repo,phase:'phase@1',scenario:'environment-review@1'},null,2)+'\\n');
    out({ok:true,command:'next',package:statusPackage,contract:'mdlm-next@1',phase:'phase@1',assignment:{id:stale},materializedExecutions:[{id,scenario:'create-review-context@1',status:'completed'}],outcome:'assignment',diagnostics:[]});
  } else if(${materializedNext}) {
    const final=${JSON.stringify(finalAssignment)}, current=repository(); fs.writeFileSync(${JSON.stringify(assignmentStatePath)},final); fs.writeFileSync(${JSON.stringify(scenarioStatePath)},'realize-verification-environment@1');
    fs.mkdirSync(path.join(root,'.lifecycle/work'),{recursive:true}); fs.writeFileSync(path.join(root,'.lifecycle/work/active-assignment.json'),JSON.stringify({contract:'mdlm-assignment-lease@1',id:final,disposition:'active',package:statusPackage,repository:current,phase:'phase@1',scenario:'realize-verification-environment@1'},null,2)+'\\n');
    out({ok:true,command:'next',package:statusPackage,contract:'mdlm-next@1',phase:'phase@1',assignment:{id:final},materializedExecutions:[],outcome:'assignment',diagnostics:[]});
  } else out({ok:true,command:'next',package:statusPackage,contract:'mdlm-next@1',phase:'phase@1',assignment:{id:assignment},materializedExecutions:[],outcome:'assignment',diagnostics:[]});
}
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
  return {
    scratch, repository, request, mdlm, mdlmPi, tooling, assignment, assignmentStatePath, scenarioStatePath,
    malformedDigestPath, responsePath, executionId, nextCountPath, staleAssignment, finalAssignment, materializedExecution,
  };
}

const run003CheckpointFixture = path.join(root, 'test', 'fixtures', 'calculator-run-003-checkpoint');
const run008OperationalFailureDirectory = path.join(root, 'test', 'fixtures', 'calculator-run-008-operational-failure');
const run008OperationalFailureFixture = path.join(run008OperationalFailureDirectory, 'result.json');
const run009OrphanedCheckpointDirectory = path.join(root, 'test', 'fixtures', 'calculator-run-009-orphaned-checkpoint');
const run008ResultDigest = '940cd1d5ee4d332907ff4d92af5b0d1789e66cb8687c60bb909324d71ad76523';
const run009InitialManifestDigest = '5ee054a6c1b49a340e45e100f47378cbbb9b88c71072270a79a1f22ba536ed0b';
const run009PostManifestDigest = '62e54259deb615c39530282ef66df299fa03ecfd569e4032814f08831350f348';
const run009AssignmentA = 'bdb9ffc9-3491-443b-88b0-80d5dc800781';
const run009AssignmentB = '1b7355d0-b445-4c70-b76d-2242299e3170';
const run008InitialManifestDigest = 'fe25aabb438387d7a6828e1bf4c168b75bb0b8d517c627c7ceb57334e6865b7f';
const run008PostManifestDigest = 'e44d04e03e803736581ba95ecb4f95cae92d390de24921d76ce8c07a1225a817';
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

async function readAnchoredRun008Fixture() {
  const resultBytes = await readFile(run008OperationalFailureFixture);
  const initialManifestBytes = await readFile(path.join(run008OperationalFailureDirectory, 'initial-snapshot', 'manifest.json'));
  const postManifestBytes = await readFile(path.join(run008OperationalFailureDirectory, 'post-snapshot', 'manifest.json'));
  assert.equal(createHash('sha256').update(resultBytes).digest('hex'), run008ResultDigest, 'real run-008 result anchor');
  assert.equal(createHash('sha256').update(initialManifestBytes).digest('hex'), run008InitialManifestDigest, 'real run-008 initial snapshot anchor');
  assert.equal(createHash('sha256').update(postManifestBytes).digest('hex'), run008PostManifestDigest, 'real run-008 post-run snapshot anchor');
  return { resultBytes, run008: JSON.parse(resultBytes), initialManifestBytes, postManifestBytes };
}

async function operationalFailureFixture() {
  const { run008 } = await readAnchoredRun008Fixture();
  const attemptsPath = path.join(os.tmpdir(), `mdlm-demo-operational-attempts-${process.pid}-${Date.now()}-${Math.random()}`);
  const piScript = `#!/usr/bin/env node
const fs=require('node:fs'); const attempts=fs.existsSync(${JSON.stringify(attemptsPath)})?Number(fs.readFileSync(${JSON.stringify(attemptsPath)},'utf8')):0; fs.writeFileSync(${JSON.stringify(attemptsPath)},String(attempts+1)); if(attempts===0){process.stderr.write(Buffer.from(${JSON.stringify(run008.process.stderrBase64)},'base64')); process.exit(1);} console.log('{"status":"lifecycle-complete"}');
`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  value.request.signal = 'clean-interrupted-command';
  return { ...value, attemptsPath, run008 };
}

function runIdentityFromSnapshot(snapshot, request) {
  const gitIdentity = value => ({ repository: value.repository, commit: value.observedCommit, tree: value.observedTree });
  const file = value => ({ realpath: value.realpath, digest: value.digest, bytes: value.bytes });
  const processPackage = {
    reference: snapshot.status.package.reference,
    digest: snapshot.status.package.digest,
    language: snapshot.status.package.language,
  };
  return {
    contract: 'mdlm-demo-run-identity@5',
    operator: request.operator,
    mdlmPiCommandTimeoutMs: request.mdlmPiCommandTimeoutMs,
    mdlmPiAssignmentTimeoutMs: request.mdlmPiAssignmentTimeoutMs,
    processPackage,
    source: gitIdentity(snapshot.provenance.source),
    packageArtifact: file(snapshot.provenance.package),
    piPackageArtifact: file(snapshot.provenance.piPackage),
    tooling: {
      contract: snapshot.provenance.tooling.contract,
      digest: snapshot.provenance.tooling.digest,
      entries: snapshot.provenance.tooling.entries,
      files: snapshot.provenance.tooling.files,
      symlinks: snapshot.provenance.tooling.symlinks,
      bytes: snapshot.provenance.tooling.bytes,
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

async function legacyRun009Fixture() {
  const { run008 } = await readAnchoredRun008Fixture();
  const workerLog = path.join(os.tmpdir(), `mdlm-demo-run009-worker-${process.pid}-${Date.now()}-${Math.random()}`);
  const piScript = `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(workerLog)},'invoke\\n'); console.log('{"status":"lifecycle-complete"}');\n`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  const assignment = 'bdb9ffc9-3491-443b-88b0-80d5dc800781';
  value.assignment = assignment;
  value.request.assignmentId = assignment;
  value.request.signal = 'clean-interrupted-command';
  await writeFile(value.assignmentStatePath, assignment);

  const pinnedRoot = path.join(value.scratch, 'preserved-run-008');
  const initialDirectory = path.join(pinnedRoot, 'snapshot-000001');
  const postDirectory = path.join(pinnedRoot, 'snapshot-000002');
  const assignmentStateDirectory = assignmentDirectory(value.request);
  const snapshotInput = postRun => ({
    contract: 'mdlm-demo-snapshot-request@1', repository: value.repository,
    snapshotDirectory: postRun ? postDirectory : initialDirectory,
    assignmentId: assignment, timeoutMs: value.request.timeoutMs, postRun,
    journalPath: path.join(assignmentStateDirectory, 'transaction.json'),
    piJournalPath: path.join(value.repository, '.git', 'mdlm-pi', 'run.json'),
    provenance: value.request.provenance,
  });
  const initialExecution = exec(process.execPath, [cli, 'snapshot'], root, JSON.stringify(snapshotInput(false)));
  assert.equal(initialExecution.status, 0, initialExecution.stderr);
  const postExecution = exec(process.execPath, [cli, 'snapshot'], root, JSON.stringify(snapshotInput(true)));
  assert.equal(postExecution.status, 0, postExecution.stderr);
  const initialResult = JSON.parse(initialExecution.stdout);
  const postResult = JSON.parse(postExecution.stdout);
  const initialSnapshot = JSON.parse(await readFile(path.join(initialDirectory, 'snapshot.json')));

  const evidenceDirectory = path.join(assignmentStateDirectory, 'command-evidence');
  await mkdir(evidenceDirectory, { recursive: true });
  const preparedExecution = exec(value.mdlm, ['scenario', 'prepare', assignment, '--json'], value.repository);
  assert.equal(preparedExecution.status, 0, preparedExecution.stderr);
  const preparedBytes = Buffer.from(preparedExecution.stdout);
  const empty = Buffer.alloc(0);
  const commandTemplate = JSON.parse(await readFile(path.join(
    run008OperationalFailureDirectory, 'private-assignment-state', 'command-evidence', 'command-000001.json',
  )));
  const preparedRecord = commandRecord(commandTemplate, {
    argv: [value.mdlm, 'scenario', 'prepare', assignment, '--json'], cwd: value.repository,
    timeoutMs: 900_000, stdout: preparedBytes, stderr: empty, exitStatus: 0,
  });
  await writeEvidenceTriplet(evidenceDirectory, '000001', preparedRecord, preparedBytes, empty);
  const failureBytes = Buffer.from(run008.process.stderrBase64, 'base64');
  const failedRecord = commandRecord(commandTemplate, {
    argv: [value.mdlmPi, 'run', value.repository, '--mdlm', path.join(root, 'bin', 'mdlm-demo-mdlm-shim.mjs'),
      '--provider', 'openai-codex', '--model', 'gpt-5.6-sol', '--thinking', 'high'],
    cwd: value.repository, timeoutMs: 900_000, stdout: empty, stderr: failureBytes, exitStatus: 1,
  });
  await writeEvidenceTriplet(evidenceDirectory, '000002', failedRecord, empty, failureBytes);
  await writeFile(path.join(assignmentStateDirectory, 'identity.json'), `${JSON.stringify({
    contract: 'mdlm-demo-assignment-identity@1', assignmentId: assignment,
    lifecycleRepository: initialSnapshot.lifecycleRepository,
    assignmentRepository: initialSnapshot.assignmentRepository,
  }, null, 2)}\n`);
  const stopDirectory = path.join(assignmentStateDirectory, 'shim', 'stops');
  await mkdir(path.dirname(stopDirectory), { recursive: true });
  await writeFile(path.join(assignmentStateDirectory, 'shim', 'config.json'), `${JSON.stringify({
    contract: 'mdlm-demo-shim-config@1', realMdlm: value.mdlm, allowedAssignment: assignment,
    package: initialSnapshot.assignment.package, repository: initialSnapshot.assignmentRepository,
    stopDirectory, timeoutMs: 900_000,
  }, null, 2)}\n`);

  const resultPath = path.join(pinnedRoot, 'run-008.runner.stdout');
  const result = {
    ...run008,
    snapshot: initialResult,
    assignmentId: assignment,
    process: failedRecord,
    postRunSnapshot: postResult,
  };
  await writeFile(resultPath, JSON.stringify(result));
  const identityDirectory = path.join(value.repository, '.git', 'mdlm-demo-orchestrator');
  await mkdir(identityDirectory, { recursive: true });
  const legacyIdentity = runIdentityFromSnapshot(initialSnapshot, value.request);
  legacyIdentity.contract = 'mdlm-demo-run-identity@4';
  delete legacyIdentity.mdlmPiCommandTimeoutMs;
  delete legacyIdentity.mdlmPiAssignmentTimeoutMs;
  const identityPath = path.join(identityDirectory, 'run-identity.json');
  await writeFile(identityPath, `${JSON.stringify(legacyIdentity, null, 2)}\n`);
  value.request.operationalFailureRecovery = {
    resultPath,
    resultDigest: `sha256:${createHash('sha256').update(await readFile(resultPath)).digest('hex')}`,
    initialSnapshotDirectory: initialDirectory,
    initialSnapshotDigest: initialResult.digest,
    postSnapshotDirectory: postDirectory,
    postSnapshotDigest: postResult.digest,
  };
  value.request.evidenceDirectory = path.join(value.scratch, 'run-009-snapshot');
  return { ...value, workerLog, identityPath, legacyIdentity };
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

async function orphanedCheckpointFixture({ mutate, publishedAssignment = run009AssignmentA } = {}) {
  const workerLog = path.join(os.tmpdir(), `mdlm-demo-orphan-worker-${process.pid}-${Date.now()}-${Math.random()}`);
  const piScript = `#!/usr/bin/env node\nconst fs=require('node:fs'); const config=JSON.parse(fs.readFileSync(process.env.MDLM_DEMO_SHIM_CONFIG,'utf8')); fs.appendFileSync(${JSON.stringify(workerLog)},config.allowedAssignment+'\\n'); console.log('{"status":"lock-conflict"}'); process.exit(5);\n`;
  const processPackage = { reference: 'pkg@1', digest: `sha256:${'1'.repeat(64)}`, language: 'lang@1' };
  const value = await fixture({
    scenarioReference: 'review-datum-in-context@2', piScript,
    statusPackage: processPackage, assignmentPackage: processPackage,
    doctorPackage: { id: 'pkg', version: '1', ...processPackage }, packetPackage: processPackage,
  });
  value.request.signal = 'clean-interrupted-command';
  value.request.assignmentId = run009AssignmentB;
  await writeFile(value.assignmentStatePath, run009AssignmentA);
  await writeFile(value.scenarioStatePath, 'revise-question-decision-after-review@1');

  const aRequest = { ...value.request, assignmentId: run009AssignmentA };
  const aDirectory = assignmentDirectory(aRequest);
  const commandDirectory = path.join(aDirectory, 'command-evidence');
  const shimDirectory = path.join(aDirectory, 'shim');
  const stopDirectory = path.join(shimDirectory, 'stops');
  await mkdir(commandDirectory, { recursive: true });
  await mkdir(stopDirectory, { recursive: true });
  const initialSnapshotDirectory = path.join(value.scratch, 'preserved-run-009-initial');
  const initialExecution = exec(process.execPath, [cli, 'snapshot'], root, JSON.stringify({
    contract: 'mdlm-demo-snapshot-request@1', repository: value.repository,
    snapshotDirectory: initialSnapshotDirectory, assignmentId: run009AssignmentA,
    timeoutMs: value.request.timeoutMs, postRun: false,
    journalPath: path.join(aDirectory, 'transaction.json'),
    piJournalPath: path.join(value.repository, '.git', 'mdlm-pi', 'run.json'),
    provenance: value.request.provenance,
  }));
  assert.equal(initialExecution.status, 0, initialExecution.stderr);
  const initialResult = JSON.parse(initialExecution.stdout);
  const initial = JSON.parse(await readFile(path.join(initialSnapshotDirectory, 'snapshot.json')));
  const oldPostSnapshotDirectory = path.join(value.scratch, 'preserved-run-008-post');
  const oldPostExecution = exec(process.execPath, [cli, 'snapshot'], root, JSON.stringify({
    contract: 'mdlm-demo-snapshot-request@1', repository: value.repository,
    snapshotDirectory: oldPostSnapshotDirectory, assignmentId: run009AssignmentA,
    timeoutMs: value.request.timeoutMs, postRun: true,
    journalPath: path.join(aDirectory, 'transaction.json'),
    piJournalPath: path.join(value.repository, '.git', 'mdlm-pi', 'run.json'),
    provenance: value.request.provenance,
  }));
  assert.equal(oldPostExecution.status, 0, oldPostExecution.stderr);
  const oldPostResult = JSON.parse(oldPostExecution.stdout);
  const oldLifecycle = initial.lifecycleRepository;
  const aRepository = initial.assignmentRepository;

  const identityDirectory = path.join(value.repository, '.git', 'mdlm-demo-orchestrator');
  const recoveryDirectory = path.join(identityDirectory, 'operational-failure-recoveries', assignmentKeyForTest(run009AssignmentA));
  await mkdir(recoveryDirectory, { recursive: true });
  await writeFile(path.join(identityDirectory, 'repository-identity.json'), `${JSON.stringify({
    contract: 'mdlm-demo-repository-identity@1', lifecycleRepository: oldLifecycle,
    lastAssignment: { id: 'prior-assignment', outcome: 'accepted-publication', completed: true },
  }, null, 2)}\n`);
  await writeFile(path.join(aDirectory, 'identity.json'), `${JSON.stringify({
    contract: 'mdlm-demo-assignment-identity@1', assignmentId: run009AssignmentA,
    lifecycleRepository: oldLifecycle, assignmentRepository: aRepository,
  }, null, 2)}\n`);
  const runIdentity = runIdentityFromSnapshot(initial, value.request);
  const runIdentityPath = path.join(identityDirectory, 'run-identity.json');
  await writeFile(runIdentityPath, `${JSON.stringify(runIdentity, null, 2)}\n`);

  const preparedExecution = exec(value.mdlm, ['scenario', 'prepare', run009AssignmentA, '--json'], value.repository);
  assert.equal(preparedExecution.status, 0, preparedExecution.stderr);
  const preparedBytes = Buffer.from(preparedExecution.stdout);
  const empty = Buffer.alloc(0);
  const template = JSON.parse(await readFile(path.join(run003CheckpointFixture, 'command-evidence', 'command-000001.json')));
  const prepareRecord = commandRecord(template, {
    argv: [value.mdlm, 'scenario', 'prepare', run009AssignmentA, '--json'], cwd: value.repository,
    timeoutMs: 900_000, stdout: preparedBytes, stderr: empty, exitStatus: 0,
  });
  await writeEvidenceTriplet(commandDirectory, '000001', prepareRecord, preparedBytes, empty);
  const failureBytes = Buffer.from(`${JSON.stringify({
    status: 'operational-failure', error: 'MDLM command exceeded 30000ms', details: { arguments: ['status', '--json'] },
  }, null, 2)}\n`);
  const failureRecord = commandRecord(template, {
    argv: [value.mdlmPi, 'run', value.repository, '--mdlm', path.join(root, 'bin', 'mdlm-demo-mdlm-shim.mjs'),
      '--provider', value.request.operator.provider, '--model', value.request.operator.model, '--thinking', value.request.operator.thinking],
    cwd: value.repository, timeoutMs: 900_000, stdout: empty, stderr: failureBytes, exitStatus: 1,
  });
  await writeEvidenceTriplet(commandDirectory, '000002', failureRecord, empty, failureBytes);
  await writeEvidenceTriplet(commandDirectory, '000003', prepareRecord, preparedBytes, empty);

  const runIdentityBytes = await readFile(runIdentityPath);
  const evidenceFor = async (name, extension) => {
    const file = path.join(commandDirectory, `command-${name}.${extension}`);
    const bytes = await readFile(file);
    return { path: file, bytes: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  };
  const markerRunIdentity = { path: runIdentityPath, bytes: runIdentityBytes.length, digest: `sha256:${createHash('sha256').update(runIdentityBytes).digest('hex')}` };
  const markerPath = path.join(recoveryDirectory, 'failure-000002.json');
  await writeFile(markerPath, `${JSON.stringify({
    contract: 'mdlm-demo-operational-failure-marker@1', assignmentId: run009AssignmentA,
    requiredNextMode: 'run', source: 'verified-finalization', assignmentDirectory: aDirectory,
    initialBoundary: {
      snapshotDirectory: initialSnapshotDirectory, digest: initialResult.digest,
      lifecycleRepository: oldLifecycle, assignmentRepository: aRepository,
    },
    postBoundary: {
      snapshotDirectory: oldPostSnapshotDirectory, digest: oldPostResult.digest,
      lifecycleRepository: oldLifecycle, assignmentRepository: aRepository,
    },
    processPackage, runIdentity: markerRunIdentity,
    timeoutIdentity: { timeoutMs: 900_000, mdlmPiCommandTimeoutMs: 600_000, mdlmPiAssignmentTimeoutMs: 840_000 },
    failure: {
      commandIndex: 2,
      evidence: {
        record: await evidenceFor('000002', 'json'), stdout: await evidenceFor('000002', 'stdout'), stderr: await evidenceFor('000002', 'stderr'),
      },
      document: {
        digest: `sha256:${createHash('sha256').update(failureBytes).digest('hex')}`,
        errorDigest: `sha256:${createHash('sha256').update('MDLM command exceeded 30000ms').digest('hex')}`,
        detailsDigest: `sha256:${createHash('sha256').update(JSON.stringify({ arguments: ['status', '--json'] })).digest('hex')}`,
      },
    },
  }, null, 2)}\n`);
  const retryTransitionPath = path.join(recoveryDirectory, 'retry-000002.json');
  await writeFile(retryTransitionPath, `${JSON.stringify({
    contract: 'mdlm-demo-operational-failure-retry@1', assignmentId: run009AssignmentA, mode: 'run',
    marker: { path: markerPath, digest: `sha256:${createHash('sha256').update(await readFile(markerPath)).digest('hex')}` },
    lifecycleRepository: oldLifecycle, processPackage, runIdentity: markerRunIdentity,
    timeoutIdentity: { timeoutMs: 900_000, mdlmPiCommandTimeoutMs: 600_000, mdlmPiAssignmentTimeoutMs: 840_000 },
  }, null, 2)}\n`);
  const shimConfigPath = path.join(shimDirectory, 'config.json');
  await writeFile(shimConfigPath, `${JSON.stringify({
    contract: 'mdlm-demo-shim-config@1', realMdlm: value.mdlm, allowedAssignment: run009AssignmentA,
    package: processPackage, repository: aRepository, stopDirectory, timeoutMs: 900_000,
  }, null, 2)}\n`);
  const processedAssignmentPath = path.join(shimDirectory, 'processed-assignment.json');
  await writeFile(processedAssignmentPath, `${JSON.stringify({
    contract: 'mdlm-demo-shim-processed-assignment@1', assignment: run009AssignmentA,
    package: processPackage, repository: aRepository,
  })}\n`);

  const transactions = [
    ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'revise-question-decision-after-review@1', publishedAssignment, 'DEC/DEC-TEST/r00001.md'],
    ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'create-review-context@1', 'internal-assignment', 'BSL/BSL-TEST/r00001.md'],
  ];
  for (const [id, scenario, assignment, output] of transactions) {
    const relative = `.lifecycle/data/.transactions/${id}`;
    const transactionDirectory = path.join(value.repository, relative);
    await mkdir(path.join(transactionDirectory, path.dirname(output)), { recursive: true });
    const outputPath = `${relative}/${output}`;
    await writeFile(path.join(value.repository, outputPath), `${scenario}\n`);
    await writeFile(path.join(transactionDirectory, 'execution.json'), `${JSON.stringify({
      contract: 'mdlm-scenario-execution@4', id, status: 'completed',
      response: { contract: 'mdlm-assignment-response@1', assignment, digest: `sha256:${'2'.repeat(64)}` },
      definition: { scenario }, outputs: [{ lifecycleDatum: { path: outputPath } }],
    }, null, 2)}\n`);
    git(['add', relative], value.repository);
    git(['commit', '-m', `mdlm: publish ${scenario} (${id})`], value.repository);
  }
  const currentLifecycle = cleanLifecycle(value.repository);
  await writeFile(value.assignmentStatePath, run009AssignmentB);
  await writeFile(value.scenarioStatePath, 'review-datum-in-context@2');
  const packetExecution = exec(value.mdlm, ['scenario', 'prepare', run009AssignmentB, '--json'], value.repository);
  assert.equal(packetExecution.status, 0, packetExecution.stderr);
  const stopPacketPath = path.join(stopDirectory, `${run009AssignmentB}.json`);
  await writeFile(stopPacketPath, packetExecution.stdout);
  const assignmentCheckpointPath = path.join(shimDirectory, 'assignment-checkpoint.json');
  await writeFile(assignmentCheckpointPath, `${JSON.stringify({
    contract: 'mdlm-demo-shim-assignment-checkpoint@1', completedAssignment: run009AssignmentA,
    assignment: run009AssignmentB, scenario: 'review-datum-in-context@2',
  })}\n`);

  const postSnapshotDirectory = path.join(value.scratch, 'preserved-run-012-post');
  const postExecution = exec(process.execPath, [cli, 'snapshot'], root, JSON.stringify({
    contract: 'mdlm-demo-snapshot-request@1', repository: value.repository,
    snapshotDirectory: postSnapshotDirectory, assignmentId: run009AssignmentB,
    timeoutMs: value.request.timeoutMs, postRun: true,
    journalPath: path.join(assignmentDirectory(value.request), 'transaction.json'),
    piJournalPath: path.join(value.repository, '.git', 'mdlm-pi', 'run.json'),
    provenance: value.request.provenance,
  }));
  assert.equal(postExecution.status, 0, postExecution.stderr);
  const postResult = JSON.parse(postExecution.stdout);
  const pinned = async file => ({ path: file, digest: `sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}` });
  value.request.orphanedCheckpointRecovery = {
    initialSnapshotDirectory, initialSnapshotDigest: initialResult.digest,
    retryTransition: await pinned(retryTransitionPath),
    prepare: {
      record: await pinned(path.join(commandDirectory, 'command-000003.json')),
      stdout: await pinned(path.join(commandDirectory, 'command-000003.stdout')),
      stderr: await pinned(path.join(commandDirectory, 'command-000003.stderr')),
    },
    shimConfig: await pinned(shimConfigPath), processedAssignment: await pinned(processedAssignmentPath),
    assignmentCheckpoint: await pinned(assignmentCheckpointPath), stopPacket: await pinned(stopPacketPath),
    postSnapshotDirectory, postSnapshotDigest: postResult.digest,
  };
  value.request.evidenceDirectory = path.join(value.scratch, 'recovery-run-snapshot');
  const context = {
    ...value, workerLog, aDirectory, commandDirectory, identityDirectory, oldLifecycle, currentLifecycle,
    retryTransitionPath, shimConfigPath, processedAssignmentPath, assignmentCheckpointPath, stopPacketPath,
  };
  if (mutate) await mutate(context);
  return context;
}

async function materializedNextFixture() {
  const workerLog = path.join(os.tmpdir(), `mdlm-demo-materialized-next-worker-${process.pid}-${Date.now()}-${Math.random()}`);
  const piScript = `#!/usr/bin/env node\nconst fs=require('node:fs'); const config=JSON.parse(fs.readFileSync(process.env.MDLM_DEMO_SHIM_CONFIG,'utf8')); fs.appendFileSync(${JSON.stringify(workerLog)},config.allowedAssignment+'\\n'); console.log('{"status":"lock-conflict"}'); process.exit(5);\n`;
  const value = await fixture({ piScript });
  const acceptedExecution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(acceptedExecution.status, 0, acceptedExecution.stderr);
  const acceptedResult = JSON.parse(acceptedExecution.stdout);
  assert.equal(acceptedResult.status, 'completed', acceptedExecution.stdout);
  const oldSnapshotDirectory = acceptedResult.postRunSnapshot.snapshotDirectory;
  const oldSnapshot = JSON.parse(await readFile(path.join(oldSnapshotDirectory, 'snapshot.json')));
  const oldLifecycle = oldSnapshot.lifecycleRepository;
  const acceptedResultPath = path.join(value.scratch, 'accepted-result.json');
  await writeFile(acceptedResultPath, acceptedExecution.stdout);

  const executions = [
    ['11111111-1111-4111-8111-111111111111', 'f7'],
    ['22222222-2222-4222-8222-222222222222', '05'],
    ['33333333-3333-4333-8333-333333333333', '73'],
  ].map(([id, content]) => ({ id, scenario: 'create-review-context@1', status: 'completed', content }));
  for (const execution of executions) {
    const transactionRoot = `.lifecycle/data/.transactions/${execution.id}`;
    const outputPath = `${transactionRoot}/REV/REV-${execution.content}/r00001.md`;
    await mkdir(path.join(value.repository, transactionRoot, 'REV', `REV-${execution.content}`), { recursive: true });
    await writeFile(path.join(value.repository, outputPath), `${execution.content}\n`);
    await writeFile(path.join(value.repository, transactionRoot, 'execution.json'), `${JSON.stringify({
      contract: 'mdlm-scenario-execution@4', id: execution.id, status: 'completed',
      response: { contract: 'mdlm-assignment-response@1', assignment: `internal-${execution.content}` },
      definition: { scenario: execution.scenario }, outputs: [{ lifecycleDatum: { path: outputPath } }],
    }, null, 2)}\n`);
    git(['add', transactionRoot], value.repository);
    git(['commit', '-m', `mdlm: publish ${execution.scenario} (${execution.id})`], value.repository);
  }
  const finalLifecycle = cleanLifecycle(value.repository);
  const finalAssignment = '75868589-7e32-4618-ad4d-8cb954b7954d';
  await writeFile(value.assignmentStatePath, finalAssignment);
  await writeFile(value.scenarioStatePath, 'ordinary@1');

  const nextStdoutPath = path.join(value.scratch, 'post-run-next.stdout');
  const nextStderrPath = path.join(value.scratch, 'post-run-next.stderr');
  const nextExitPath = path.join(value.scratch, 'post-run-next.exit');
  const next = {
    ok: true, command: 'next', package: { reference: 'pkg@1', digest: `sha256:${'1'.repeat(64)}`, language: 'lang@1' },
    contract: 'mdlm-next@1', phase: 'phase@1', assignment: { id: 'a934f171-ff3d-41ad-b3cd-8b72067199d1' },
    materializedExecutions: executions.map(({ id, scenario, status }) => ({ id, scenario, status })),
    outcome: 'assignment', diagnostics: [],
  };
  await writeFile(nextStdoutPath, `${JSON.stringify(next, null, 2)}\n`);
  await writeFile(nextStderrPath, '');
  await writeFile(nextExitPath, '0\n');

  const finalSnapshotDirectory = path.join(value.scratch, 'preserved-final-snapshot');
  const finalSnapshotExecution = exec(process.execPath, [cli, 'snapshot'], root, JSON.stringify({
    contract: 'mdlm-demo-snapshot-request@1', repository: value.repository,
    snapshotDirectory: finalSnapshotDirectory, assignmentId: finalAssignment,
    timeoutMs: value.request.timeoutMs, postRun: false,
    journalPath: path.join(assignmentDirectory({ ...value.request, assignmentId: finalAssignment }), 'transaction.json'),
    piJournalPath: path.join(value.repository, '.git', 'mdlm-pi', 'run.json'),
    provenance: value.request.provenance,
  }));
  assert.equal(finalSnapshotExecution.status, 0, finalSnapshotExecution.stderr);
  const finalSnapshot = JSON.parse(finalSnapshotExecution.stdout);
  assert.equal(finalSnapshot.status, 'complete', finalSnapshotExecution.stdout);

  const pin = async file => ({ path: file, digest: `sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}` });
  value.request.assignmentId = finalAssignment;
  value.request.signal = 'clean-interrupted-command';
  value.request.evidenceDirectory = path.join(value.scratch, 'materialized-next-recovery-evidence');
  value.request.materializedNextRecovery = {
    acceptedResult: await pin(acceptedResultPath),
    oldSnapshot: { directory: oldSnapshotDirectory, digest: acceptedResult.postRunSnapshot.digest },
    nextStdout: await pin(nextStdoutPath),
    nextStderr: await pin(nextStderrPath),
    nextExit: await pin(nextExitPath),
    finalSnapshot: { directory: finalSnapshotDirectory, digest: finalSnapshot.digest },
  };
  return {
    ...value, workerLog, acceptedResult, acceptedResultPath, oldLifecycle, finalLifecycle, finalAssignment,
    executions, next, nextStdoutPath, nextStderrPath, nextExitPath, finalSnapshotDirectory,
  };
}

async function rewriteMaterializedNext(value, update) {
  update(value.next);
  await writeFile(value.nextStdoutPath, `${JSON.stringify(value.next, null, 2)}\n`);
  value.request.materializedNextRecovery.nextStdout.digest =
    `sha256:${createHash('sha256').update(await readFile(value.nextStdoutPath)).digest('hex')}`;
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

test('accepted external publication automatically closes one package-authored execution and checkpoints the final Assignment', async () => {
  const value = await fixture({ materializedNext: true });
  const initialCommitCount = Number(git(['rev-list', '--count', 'HEAD'], value.repository));

  const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));

  assert.equal(execution.status, 0, execution.stderr);
  const output = JSON.parse(execution.stdout);
  assert.equal(output.status, 'completed', execution.stdout);
  assert.equal(output.outcome, 'accepted-publication');
  assert.deepEqual(output.nextAssignment, {
    id: value.finalAssignment,
    scenario: 'realize-verification-environment@1',
    phase: 'pre-submission',
  });
  assert.equal(output.publicationClosure.status, 'completed');
  assert.deepEqual(output.publicationClosure.executions.map(item => item.id), [value.materializedExecution]);
  assert.equal(Number(git(['rev-list', '--count', 'HEAD'], value.repository)), initialCommitCount + 2);
  assert.deepEqual(
    git(['log', '-2', '--format=%s'], value.repository).split('\n'),
    [
      `mdlm: publish create-review-context@1 (${value.materializedExecution})`,
      `mdlm: publish register-pilot-target@1 (${value.executionId})`,
    ],
  );
  assert.equal(git(['status', '--porcelain=v1'], value.repository), '');
  assert.equal(await readFile(value.nextCountPath, 'utf8'), '2');
  const lease = JSON.parse(await readFile(path.join(value.repository, '.lifecycle/work/active-assignment.json')));
  assert.equal(lease.id, value.finalAssignment);
  const post = JSON.parse(await readFile(path.join(output.postRunSnapshot.snapshotDirectory, 'snapshot.json')));
  assert.equal(post.assignment.id, value.finalAssignment);
  assert.deepEqual(post.assignment.repository, {
    head: git(['rev-parse', 'HEAD'], value.repository),
    trackedState: post.lifecycleRepository.trackedState,
  });
  const trusted = JSON.parse(await readFile(path.join(value.repository, '.git', 'mdlm-demo-orchestrator', 'repository-identity.json')));
  assert.deepEqual(trusted.lifecycleRepository, post.lifecycleRepository);
});

test('publication closure resumes after transaction completion without replaying the accepted external Assignment', async () => {
  const value = await fixture({ materializedNext: true });
  const initialCommitCount = Number(git(['rev-list', '--count', 'HEAD'], value.repository));
  const crashed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request), {
    ...process.env,
    MDLM_DEMO_TEST_CRASH: 'publication-closure:after-transaction-completed',
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  assert.equal(await stat(path.join(assignmentDirectory(value.request), 'publication-closure.json')).then(() => true, () => false), false);
  assert.equal(JSON.parse(await readFile(path.join(assignmentDirectory(value.request), 'transaction.json'))).phase, 'completed');

  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
    ...value.request,
    contract: 'mdlm-demo-resume-request@1',
    evidenceDirectory: path.join(value.scratch, 'resume-evidence'),
  }));

  assert.equal(resumed.status, 0, resumed.stderr);
  const output = JSON.parse(resumed.stdout);
  assert.equal(output.recoveredPublication, true, resumed.stdout);
  assert.equal(output.publicationClosure.status, 'completed', resumed.stdout);
  assert.deepEqual(output.publicationClosure.executions.map(item => item.id), [value.materializedExecution]);
  assert.deepEqual(output.nextAssignment, {
    id: value.finalAssignment,
    scenario: 'realize-verification-environment@1',
    phase: 'pre-submission',
  });
  assert.equal((await readFile(path.join(value.scratch, 'submit-count'), 'utf8')).trim().split('\n').length, 1);
  assert.equal(await readFile(value.nextCountPath, 'utf8'), '2');
  assert.equal(Number(git(['rev-list', '--count', 'HEAD'], value.repository)), initialCommitCount + 2);
  assert.equal(git(['log', '--format=%s'], value.repository).split('\n')
    .filter(subject => subject === `mdlm: publish create-review-context@1 (${value.materializedExecution})`).length, 1);
  const post = JSON.parse(await readFile(path.join(output.postRunSnapshot.snapshotDirectory, 'snapshot.json')));
  assert.equal(post.assignment.id, value.finalAssignment);
  const trusted = JSON.parse(await readFile(path.join(value.repository, '.git', 'mdlm-demo-orchestrator', 'repository-identity.json')));
  assert.deepEqual(trusted.lifecycleRepository, post.lifecycleRepository);
});

test('automatic publication closure resumes its owned commit without replaying next or the external response', async () => {
  const value = await fixture({ materializedNext: true });
  const crashed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request), {
    ...process.env,
    MDLM_DEMO_TEST_CRASH: 'materialized-publication:after-git-commit',
  });
  assert.equal(crashed.status, 86, crashed.stderr);

  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
    ...value.request,
    contract: 'mdlm-demo-resume-request@1',
    evidenceDirectory: path.join(value.scratch, 'resume-evidence'),
  }));

  assert.equal(resumed.status, 0, resumed.stderr);
  const output = JSON.parse(resumed.stdout);
  assert.equal(output.publicationClosure.status, 'completed', resumed.stdout);
  assert.equal(await readFile(value.nextCountPath, 'utf8'), '2');
  assert.equal((await readFile(path.join(value.scratch, 'submit-count'), 'utf8')).trim().split('\n').length, 1);
  assert.equal(git(['log', '--format=%s', '--all'], value.repository).split('\n')
    .filter(subject => subject === `mdlm: publish create-review-context@1 (${value.materializedExecution})`).length, 1);
});

test('completed transaction journal does not mask an unconsumed durable child result', async () => {
  const attemptsPath = path.join(os.tmpdir(), `mdlm-demo-completed-journal-attempts-${process.pid}-${Date.now()}-${Math.random()}`);
  const piScript = `#!/usr/bin/env node\nconst fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(attemptsPath)},'1\\n'); console.log('{"status":"lifecycle-complete"}');\n`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  value.request.signal = 'clean-interrupted-command';
  const crashed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request), { ...process.env, MDLM_DEMO_TEST_CRASH: 'completed:after-rename' });
  assert.equal(crashed.status, 86, crashed.stderr);
  assert.equal(await readFile(attemptsPath, 'utf8'), '1\n');
  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({ ...value.request, contract: 'mdlm-demo-resume-request@1' }));
  assert.equal(resumed.status, 0, resumed.stderr);
  const output = JSON.parse(resumed.stdout);
  assert.equal(output.status, 'completed');
  assert.equal(output.process.exitStatus, 0);
  assert.equal(await readFile(attemptsPath, 'utf8'), '1\n');
  await stat(path.join(assignmentDirectory(value.request), 'durable-command', 'consumption.json'));
});

test('durable result authentication rejects an incoherent all-null process outcome', async () => {
  const attemptsPath = path.join(os.tmpdir(), `mdlm-demo-null-outcome-attempts-${process.pid}-${Date.now()}-${Math.random()}`);
  const piScript = `#!/usr/bin/env node\nconst fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(attemptsPath)},'1\\n'); console.log('{"status":"lifecycle-complete"}');\n`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  value.request.signal = 'clean-interrupted-command';
  const crashed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request), { ...process.env, MDLM_DEMO_TEST_CRASH: 'durable-command:after-result' });
  assert.equal(crashed.status, 86, crashed.stderr);
  const resultPath = path.join(assignmentDirectory(value.request), 'durable-command', 'result.json');
  await chmod(resultPath, 0o600);
  const result = JSON.parse(await readFile(resultPath));
  Object.assign(result.process, { exitStatus: null, signal: null, spawnError: null, timedOut: false, outputLimitExceeded: false });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  await chmod(resultPath, 0o400);
  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({ ...value.request, contract: 'mdlm-demo-resume-request@1' }));
  assert.equal(resumed.status, 0, resumed.stderr);
  const output = JSON.parse(resumed.stdout);
  assert.equal(output.reason, 'durable-command-uncertain');
  assert.equal(output.recoverable, false);
  assert.equal(await readFile(attemptsPath, 'utf8'), '1\n');
});

test('legacy command migration rejects evidence without a coherent process outcome', async () => {
  const attemptsPath = path.join(os.tmpdir(), `mdlm-demo-legacy-null-attempts-${process.pid}-${Date.now()}-${Math.random()}`);
  const piScript = `#!/usr/bin/env node\nconst fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(attemptsPath)},'1\\n'); console.log('{"status":"lifecycle-complete"}');\n`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  value.request.signal = 'clean-interrupted-command';
  const commandDirectory = path.join(assignmentDirectory(value.request), 'command-evidence');
  await mkdir(commandDirectory, { recursive: true });
  const stdout = Buffer.from('{"status":"lifecycle-complete"}\n');
  const stderr = Buffer.alloc(0);
  const record = commandRecord({ startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z' }, {
    argv: ['/unknown-worker'], cwd: value.repository, timeoutMs: value.request.timeoutMs, stdout, stderr, exitStatus: null,
  });
  await writeEvidenceTriplet(commandDirectory, '000001', record, stdout, stderr);
  const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(execution.status, 0, execution.stderr);
  const output = JSON.parse(execution.stdout);
  assert.equal(output.status, 'stopped');
  assert.equal(output.reason, 'orchestration-failure');
  await assert.rejects(readFile(attemptsPath), error => error.code === 'ENOENT');
});

test('durable consumption cross-binds the authenticated process and complete post-run snapshot', async () => {
  for (const mutation of ['process', 'disposition', 'snapshot digest', 'pre-command snapshot', 'foreign snapshot']) {
    const attemptsPath = path.join(os.tmpdir(), `mdlm-demo-consumption-${mutation.replaceAll(' ', '-')}-${process.pid}-${Date.now()}-${Math.random()}`);
    const piScript = `#!/usr/bin/env node\nconst fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(attemptsPath)},'1\\n'); console.log('{"status":"lifecycle-complete"}');\n`;
    const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
    value.request.signal = 'clean-interrupted-command';
    const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
    assert.equal(first.status, 0, `${mutation}: ${first.stderr}`);
    const consumptionPath = path.join(assignmentDirectory(value.request), 'durable-command', 'consumption.json');
    await chmod(consumptionPath, 0o600);
    const consumption = JSON.parse(await readFile(consumptionPath));
    if (mutation === 'process') consumption.orchestration.output.process.exitStatus = 9;
    else if (mutation === 'disposition') consumption.orchestration.output.trustedRepositoryAdvance = false;
    else if (mutation === 'snapshot digest') consumption.orchestration.output.postRunSnapshot.digest = `sha256:${'0'.repeat(64)}`;
    else {
      let substitutedSnapshot;
      if (mutation === 'pre-command snapshot') {
        substitutedSnapshot = consumption.orchestration.output.snapshot;
      } else {
        const foreign = await fixture({ scenarioReference: 'ordinary@1', piScript: '#!/bin/sh\nprintf \'%s\\n\' \'{"status":"lifecycle-complete"}\'\n' });
        foreign.request.signal = 'clean-interrupted-command';
        const foreignExecution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(foreign.request));
        assert.equal(foreignExecution.status, 0, foreignExecution.stderr);
        substitutedSnapshot = JSON.parse(foreignExecution.stdout).postRunSnapshot;
      }
      consumption.orchestration.output.postRunSnapshot = substitutedSnapshot;
      consumption.orchestration.postRunManifest = {
        path: path.join(substitutedSnapshot.snapshotDirectory, 'manifest.json'),
        digest: substitutedSnapshot.digest,
      };
    }
    consumption.orchestration.outputDigest = `sha256:${createHash('sha256').update(Buffer.from(JSON.stringify(consumption.orchestration.output))).digest('hex')}`;
    await writeFile(consumptionPath, `${JSON.stringify(consumption, null, 2)}\n`);
    await chmod(consumptionPath, 0o400);
    const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({ ...value.request, contract: 'mdlm-demo-resume-request@1' }));
    assert.equal(resumed.status, 0, `${mutation}: ${resumed.stderr}`);
    const output = JSON.parse(resumed.stdout);
    assert.equal(output.reason, 'durable-command-uncertain', mutation);
    assert.equal(output.recoverable, false, mutation);
    assert.equal(await readFile(attemptsPath, 'utf8'), '1\n', mutation);
  }
});

test('unconsumed typed operational failure recovery reuses its authenticated marker', async () => {
  const value = await operationalFailureFixture();
  const crashed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request), { ...process.env, MDLM_DEMO_TEST_CRASH: 'operational-recovery-marker:after-rename' });
  assert.equal(crashed.status, 86, crashed.stderr);
  assert.equal(await readFile(value.attemptsPath, 'utf8'), '1');
  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({ ...value.request, contract: 'mdlm-demo-resume-request@1' }));
  assert.equal(resumed.status, 0, resumed.stderr);
  const output = JSON.parse(resumed.stdout);
  assert.equal(output.reason, 'pre-submission-operational-failure');
  assert.equal(output.recoverable, true);
  assert.equal(await readFile(value.attemptsPath, 'utf8'), '1');
  assert.deepEqual(await readdir(operationalRecoveryDirectoryForTest(value)), [path.basename(output.operationalFailureRecovery.marker.path)]);
  await stat(path.join(assignmentDirectory(value.request), 'durable-command', 'consumption.json'));
});

test('a completed child result survives a parent crash and is consumed without spawning again', async () => {
  const invocationPath = path.join(os.tmpdir(), `mdlm-demo-durable-result-${process.pid}-${Date.now()}`);
  const piScript = `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(invocationPath)}, 'invoked\\n'); console.log('{"status":"lifecycle-complete"}');\n`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  value.request.signal = 'clean-interrupted-command';

  const crashed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request), {
    ...process.env, MDLM_DEMO_TEST_CRASH: 'durable-command:after-result',
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  const durableDirectory = path.join(assignmentDirectory(value.request), 'durable-command');
  const authorization = JSON.parse(await readFile(path.join(durableDirectory, 'authorization.json'), 'utf8'));
  assert.deepEqual(authorization.command.argv.slice(0, 3), [value.mdlmPi, 'run', value.repository]);
  assert.equal(authorization.command.cwd, value.repository);
  assert.equal(authorization.command.timeoutMs, value.request.timeoutMs);
  assert.deepEqual(authorization.command.input, { present: false, bytes: 0, digest: `sha256:${createHash('sha256').digest('hex')}` });
  assert.match(authorization.command.environment.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.parse(await readFile(path.join(durableDirectory, 'result.json'), 'utf8')).contract, 'mdlm-demo-command-result@1');
  assert.equal(await stat(path.join(durableDirectory, 'consumption.json')).then(() => true, () => false), false);

  const recovered = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(recovered.status, 0, recovered.stderr);
  const output = JSON.parse(recovered.stdout);
  assert.equal(output.status, 'completed', recovered.stdout);
  assert.equal(output.reason, 'lifecycle-complete', recovered.stdout);
  assert.equal(await readFile(invocationPath, 'utf8'), 'invoked\n');
  assert.equal(JSON.parse(await readFile(path.join(durableDirectory, 'consumption.json'), 'utf8')).contract, 'mdlm-demo-command-consumption@1');
  assert.equal((await readdir(durableDirectory)).some(name => name.startsWith('attempt-')), false);
});

test('synced pending durable command records recover without an uncertain replay', async () => {
  for (const phase of ['authorization', 'result', 'consumption']) {
    const invocationPath = path.join(os.tmpdir(), `mdlm-demo-pending-${phase}-${process.pid}-${Date.now()}`);
    const piScript = `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(invocationPath)}, 'invoked\\n'); console.log('{"status":"lifecycle-complete"}');\n`;
    const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
    value.request.signal = 'clean-interrupted-command';
    const crashed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request), {
      ...process.env, MDLM_DEMO_TEST_CRASH: `durable-command-${phase}:after-temp-sync`,
    });
    assert.equal(crashed.status, 86, `${phase}: ${crashed.stderr}`);

    const resumed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
    assert.equal(resumed.status, 0, `${phase}: ${resumed.stderr}`);
    const output = JSON.parse(resumed.stdout);
    if (phase === 'authorization') {
      assert.equal(output.reason, 'durable-command-uncertain', phase);
      assert.equal(await stat(invocationPath).then(() => true, () => false), false, phase);
    } else {
      assert.equal(output.status, phase === 'result' ? 'completed' : 'already-completed', phase);
      assert.equal(await readFile(invocationPath, 'utf8'), 'invoked\n', phase);
    }
    const durableDirectory = path.join(assignmentDirectory(value.request), 'durable-command');
    assert.equal((await readdir(durableDirectory)).some(name => name.endsWith('.pending')), false, phase);
  }
});

test('a repository change after durable result capture is uncertain and never consumed', async () => {
  const invocationPath = path.join(os.tmpdir(), `mdlm-demo-post-result-drift-${process.pid}-${Date.now()}`);
  const piScript = `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(invocationPath)}, 'invoked\\n'); console.log('{"status":"lifecycle-complete"}');\n`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  value.request.signal = 'clean-interrupted-command';
  const crashed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request), {
    ...process.env, MDLM_DEMO_TEST_CRASH: 'durable-command:after-result',
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  await writeFile(path.join(value.repository, 'unrelated.txt'), 'unrelated\n');
  git(['add', 'unrelated.txt'], value.repository);
  git(['commit', '-m', 'unrelated post-result change'], value.repository);

  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
    ...value.request, contract: 'mdlm-demo-resume-request@1',
  }));
  assert.equal(resumed.status, 0, resumed.stderr);
  const output = JSON.parse(resumed.stdout);
  assert.equal(output.reason, 'durable-command-uncertain');
  assert.equal(output.recoverable, false);
  assert.match(output.detail, /repository changed after the durable child result/);
  assert.equal(await readFile(invocationPath, 'utf8'), 'invoked\n');
  const durableDirectory = path.join(assignmentDirectory(value.request), 'durable-command');
  assert.equal(await stat(path.join(durableDirectory, 'consumption.json')).then(() => true, () => false), false);
  assert.equal(await stat(path.join(assignmentDirectory(value.request), 'transaction.json')).then(() => true, () => false), false);
});

test('retry history authenticates every retained durable attempt before recovery', async () => {
  const value = await operationalFailureFixture();
  const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(first.status, 0, first.stderr);
  const second = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).status, 'completed');
  assert.equal(await readFile(value.attemptsPath, 'utf8'), '2');

  const durableDirectory = path.join(assignmentDirectory(value.request), 'durable-command');
  await rm(path.join(durableDirectory, 'result.json'));
  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
    ...value.request, contract: 'mdlm-demo-resume-request@1',
  }));
  assert.equal(resumed.status, 0, resumed.stderr);
  const output = JSON.parse(resumed.stdout);
  assert.equal(output.reason, 'durable-command-uncertain');
  assert.match(output.detail, /no complete durable result/);
  assert.equal(await readFile(value.attemptsPath, 'utf8'), '2');
});

test('durable authorization input identity must match its decision context', async () => {
  const invocationPath = path.join(os.tmpdir(), `mdlm-demo-input-binding-${process.pid}-${Date.now()}`);
  const piScript = `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(invocationPath)}, 'invoked\\n'); console.log('{"status":"lifecycle-complete"}');\n`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  value.request.signal = 'clean-interrupted-command';
  const crashed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request), {
    ...process.env, MDLM_DEMO_TEST_CRASH: 'durable-command:after-result',
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  const durableDirectory = path.join(assignmentDirectory(value.request), 'durable-command');
  const authorizationPath = path.join(durableDirectory, 'authorization.json');
  const resultPath = path.join(durableDirectory, 'result.json');
  await chmod(authorizationPath, 0o600);
  const authorization = JSON.parse(await readFile(authorizationPath, 'utf8'));
  authorization.command.input.bytes = 1;
  await writeFile(authorizationPath, `${JSON.stringify(authorization, null, 2)}\n`);
  await chmod(authorizationPath, 0o400);
  await chmod(resultPath, 0o600);
  const durableResult = JSON.parse(await readFile(resultPath, 'utf8'));
  durableResult.authorization.digest = `sha256:${createHash('sha256').update(await readFile(authorizationPath)).digest('hex')}`;
  await writeFile(resultPath, `${JSON.stringify(durableResult, null, 2)}\n`);
  await chmod(resultPath, 0o400);

  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
    ...value.request, contract: 'mdlm-demo-resume-request@1',
  }));
  assert.equal(resumed.status, 0, resumed.stderr);
  const output = JSON.parse(resumed.stdout);
  assert.equal(output.reason, 'durable-command-uncertain');
  assert.match(output.detail, /absent input contradicts its decision context/);
  assert.equal(await readFile(invocationPath, 'utf8'), 'invoked\n');
});

test('output-limited durable results fail closed instead of authenticating truncated streams', async () => {
  const invocationPath = path.join(os.tmpdir(), `mdlm-demo-output-limit-${process.pid}-${Date.now()}`);
  const piScript = `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(invocationPath)}, 'invoked\\n'); console.log('{"status":"lifecycle-complete"}');\n`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  value.request.signal = 'clean-interrupted-command';
  const crashed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request), {
    ...process.env, MDLM_DEMO_TEST_CRASH: 'durable-command:after-result',
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  const resultPath = path.join(assignmentDirectory(value.request), 'durable-command', 'result.json');
  await chmod(resultPath, 0o600);
  const durableResult = JSON.parse(await readFile(resultPath, 'utf8'));
  durableResult.process.outputLimitExceeded = true;
  durableResult.process.observedOutputBytes += 1;
  await writeFile(resultPath, `${JSON.stringify(durableResult, null, 2)}\n`);
  await chmod(resultPath, 0o400);

  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
    ...value.request, contract: 'mdlm-demo-resume-request@1',
  }));
  assert.equal(resumed.status, 0, resumed.stderr);
  const output = JSON.parse(resumed.stdout);
  assert.equal(output.reason, 'durable-command-uncertain');
  assert.equal(output.recoverable, false);
  assert.match(output.detail, /incomplete or incoherent/);
  assert.equal(await readFile(invocationPath, 'utf8'), 'invoked\n');
  assert.equal(await stat(path.join(assignmentDirectory(value.request), 'durable-command', 'consumption.json')).then(() => true, () => false), false);
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

test('run and resume requests reject unknown top-level and recovery trust keys before snapshotting', async () => {
  const pinnedFile = () => ({ path: '/tmp/evidence', digest: `sha256:${'0'.repeat(64)}` });
  const orphanedCheckpointRecovery = () => ({
    initialSnapshotDirectory: '/tmp/initial-snapshot',
    initialSnapshotDigest: `sha256:${'0'.repeat(64)}`,
    retryTransition: pinnedFile(),
    prepare: { record: pinnedFile(), stdout: pinnedFile(), stderr: pinnedFile() },
    shimConfig: pinnedFile(),
    processedAssignment: pinnedFile(),
    assignmentCheckpoint: pinnedFile(),
    stopPacket: pinnedFile(),
    postSnapshotDirectory: '/tmp/post-snapshot',
    postSnapshotDigest: `sha256:${'0'.repeat(64)}`,
  });
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
      request => {
        request.orphanedCheckpointRecovery = orphanedCheckpointRecovery();
        request.orphanedCheckpointRecovery.unreviewed = true;
      },
      request => {
        request.orphanedCheckpointRecovery = orphanedCheckpointRecovery();
        request.orphanedCheckpointRecovery.prepare.record.unreviewed = true;
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

test('run accepts the strict orphaned checkpoint recovery trust shape at the operator boundary', async () => {
  const value = await fixture();
  const pinnedFile = () => ({ path: '/tmp/evidence', digest: `sha256:${'0'.repeat(64)}` });
  value.request.orphanedCheckpointRecovery = {
    initialSnapshotDirectory: '/tmp/initial-snapshot',
    initialSnapshotDigest: `sha256:${'0'.repeat(64)}`,
    retryTransition: pinnedFile(),
    prepare: { record: pinnedFile(), stdout: pinnedFile(), stderr: pinnedFile() },
    shimConfig: pinnedFile(),
    processedAssignment: pinnedFile(),
    assignmentCheckpoint: pinnedFile(),
    stopPacket: pinnedFile(),
    postSnapshotDirectory: '/tmp/post-snapshot',
    postSnapshotDigest: `sha256:${'0'.repeat(64)}`,
  };

  const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));

  assert.equal(execution.status, 0, execution.stderr);
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

test('a structured correction-required submission remains recoverable without an uncertain journal', async () => {
  const value = await fixture({ correctionRequiredSubmit: true });
  const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(execution.status, 0, execution.stderr);
  const stopped = JSON.parse(execution.stdout);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.recoverable, true);
  assert.equal(stopped.reason, 'malformed-response-correction-required');
  assert.equal(stopped.correction.malformedResponse.correctionsRemaining, 1);
  assert.equal(stopped.correction.diagnostics[0].code, 'scenario-output-required-link-missing');
  assert.equal(JSON.parse(await readFile(path.join(assignmentDirectory(value.request), 'transaction.json'), 'utf8')).phase, 'correction-required');

  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({ ...value.request, contract: 'mdlm-demo-resume-request@1' }));
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).reason, 'malformed-response-correction-required');
  assert.equal((await readFile(path.join(value.scratch, 'submit-count'), 'utf8')).trim().split('\n').length, 1);

  const journalPath = path.join(assignmentDirectory(value.request), 'transaction.json');
  const tampered = JSON.parse(await readFile(journalPath, 'utf8'));
  tampered.submission.stdoutSha256 = `sha256:${'0'.repeat(64)}`;
  await writeFile(journalPath, `${JSON.stringify(tampered, null, 2)}\n`);
  const refused = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({ ...value.request, contract: 'mdlm-demo-resume-request@1' }));
  assert.equal(refused.status, 0, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).reason, 'correction-boundary-drift');
  assert.equal((await readFile(path.join(value.scratch, 'submit-count'), 'utf8')).trim().split('\n').length, 1);
  assert.equal(Number(git(['rev-list', '--count', 'HEAD'], value.repository)), 1);
});

test('a bound correction resumes after a post-bind parent crash without replaying the malformed response', async () => {
  const value = await fixture({ correctionRequiredSubmit: true });
  const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).reason, 'malformed-response-correction-required');

  const correctedBytes = Buffer.from(`{"contract":"mdlm-assignment-response@1","assignment":"${value.assignment}","kind":"proposal","proposal":{"outputs":[]}}\n`);
  await writeFile(value.responsePath, correctedBytes);
  const correctedDigest = `sha256:${createHash('sha256').update(correctedBytes).digest('hex')}`;
  const request = {
    ...value.request,
    contract: 'mdlm-demo-resume-request@1',
    correctionContinuation: { responsePath: value.responsePath, digest: correctedDigest },
  };
  const crashed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify(request), {
    ...process.env, MDLM_DEMO_TEST_CRASH: 'correction-continuation:after-bind',
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  const bound = JSON.parse(await readFile(path.join(assignmentDirectory(value.request), 'transaction.json'), 'utf8'));
  assert.equal(bound.phase, 'correction-bound');
  assert.equal(bound.originalResponse.digest, await readFile(value.malformedDigestPath, 'utf8'));
  assert.deepEqual(bound.correctionInput, {
    contract: 'mdlm-demo-correction-input@1',
    assignmentId: value.assignment,
    scenario: 'register-pilot-target@1',
    package: bound.package,
    repository: bound.repository,
    lifecycleRepository: value.repository,
    packetDigest: bound.packetDigest,
    path: value.responsePath,
    digest: correctedDigest,
    bytes: correctedBytes.length,
    bytesBase64: correctedBytes.toString('base64'),
  });
  assert.equal((await readFile(path.join(value.scratch, 'submit-count'), 'utf8')).trim().split('\n').length, 1);

  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify(request));
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).status, 'completed');
  assert.equal((await readFile(path.join(value.scratch, 'submit-count'), 'utf8')).trim().split('\n').length, 2);
  assert.equal(Number(git(['rev-list', '--count', 'HEAD'], value.repository)), 2);
  const completed = JSON.parse(await readFile(path.join(assignmentDirectory(value.request), 'transaction.json'), 'utf8'));
  assert.equal(completed.responseDigest, correctedDigest);
  assert.equal(completed.originalResponse.digest, await readFile(value.malformedDigestPath, 'utf8'));
});

test('a bound correction fails closed when its public input path drifts', async () => {
  const value = await fixture({ correctionRequiredSubmit: true });
  const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).reason, 'malformed-response-correction-required');

  const correctedBytes = Buffer.from(`{"contract":"mdlm-assignment-response@1","assignment":"${value.assignment}","kind":"proposal","proposal":{"outputs":[]}}\n`);
  await writeFile(value.responsePath, correctedBytes);
  const request = {
    ...value.request,
    contract: 'mdlm-demo-resume-request@1',
    correctionContinuation: {
      responsePath: value.responsePath,
      digest: `sha256:${createHash('sha256').update(correctedBytes).digest('hex')}`,
    },
  };
  const crashed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify(request), {
    ...process.env, MDLM_DEMO_TEST_CRASH: 'correction-continuation:after-bind',
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  await writeFile(value.responsePath, `${correctedBytes.toString('utf8').trim()} `);

  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify(request));
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).reason, 'correction-input-invalid');
  assert.equal((await readFile(path.join(value.scratch, 'submit-count'), 'utf8')).trim().split('\n').length, 1);
  assert.equal(Number(git(['rev-list', '--count', 'HEAD'], value.repository)), 1);
});

test('a correction-required disposition claiming two remaining attempts is uncertain', async () => {
  const value = await fixture({ correctionRequiredSubmit: true, correctionsRemaining: 2 });
  const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(execution.status, 0, execution.stderr);
  const stopped = JSON.parse(execution.stdout);
  assert.equal(stopped.reason, 'uncertain-partial-publication');
  assert.equal(stopped.transactionPhase, 'uncertain-transaction');
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

async function advancingJournalFixture(executionAssignment) {
  const invocationPath = path.join(os.tmpdir(), `mdlm-demo-advancing-${process.pid}-${Date.now()}-${executionAssignment ?? 'matching'}`);
  const piScript = `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(invocationPath)}, 'invoked\\n'); require('node:fs').unlinkSync('.git/mdlm-pi/run.json'); console.log('{"status":"lifecycle-complete"}');\n`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript, assignmentSelected: false });
  const oldHead = git(['rev-parse', 'HEAD'], value.repository);
  const oldRepository = {
    head: oldHead,
    tree: git(['rev-parse', 'HEAD^{tree}'], value.repository),
    trackedState: `sha256:${createHash('sha256').update(`${oldHead}\0staged\0\0worktree\0`).digest('hex')}`,
    clean: true,
    porcelainSha256: `sha256:${createHash('sha256').update('').digest('hex')}`,
  };
  const transactionId = '99999999-9999-4999-8999-999999999999';
  const transactionRoot = path.join(value.repository, '.lifecycle', 'data', '.transactions', transactionId);
  const outputPath = `.lifecycle/data/.transactions/${transactionId}/result.txt`;
  await mkdir(transactionRoot, { recursive: true });
  await writeFile(path.join(transactionRoot, 'result.txt'), 'published\n');
  await writeFile(path.join(transactionRoot, 'execution.json'), `${JSON.stringify({
    contract: 'mdlm-scenario-execution@4', id: transactionId, status: 'completed',
    definition: { scenario: 'ordinary@1' },
    response: { contract: 'mdlm-assignment-response@1', assignment: executionAssignment ?? value.request.assignmentId },
    outputs: [{ lifecycleDatum: { path: outputPath } }],
  })}\n`);
  git(['add', '.lifecycle'], value.repository);
  git(['commit', '-m', `mdlm: publish ordinary@1 (${transactionId})`], value.repository);
  const head = git(['rev-parse', 'HEAD'], value.repository);
  const trackedState = `sha256:${createHash('sha256').update(`${head}\0staged\0\0worktree\0`).digest('hex')}`;
  const identity = {
    contract: 'mdlm-demo-assignment-identity@1', assignmentId: value.request.assignmentId,
    lifecycleRepository: oldRepository,
    assignmentRepository: { head: oldHead, trackedState: oldRepository.trackedState },
  };
  await mkdir(assignmentDirectory(value.request), { recursive: true });
  await writeFile(path.join(assignmentDirectory(value.request), 'identity.json'), `${JSON.stringify(identity, null, 2)}\n`);
  const identityDirectory = path.join(value.repository, '.git', 'mdlm-demo-orchestrator');
  await mkdir(identityDirectory, { recursive: true });
  await writeFile(path.join(identityDirectory, 'repository-identity.json'), `${JSON.stringify({
    contract: 'mdlm-demo-repository-identity@1', lifecycleRepository: oldRepository, lastAssignment: null,
  }, null, 2)}\n`);
  await mkdir(path.join(value.repository, '.git', 'mdlm-pi'), { recursive: true });
  await writeFile(path.join(value.repository, '.git', 'mdlm-pi', 'run.json'), `${JSON.stringify({
    contract: 'mdlm-pi-run-journal@1',
    phase: 'advancing',
    advancement: {
      package: { id: 'pkg', version: '1', reference: 'pkg@1', digest: `sha256:${'1'.repeat(64)}`, language: 'lang@1' },
      repository: { head, trackedState },
      previousTransactionId: transactionId,
      baseCommit: head,
      purpose: 'ordinary-allocation',
      pending: [],
    },
  }, null, 2)}\n`);
  value.request.contract = 'mdlm-demo-resume-request@1';
  value.request.signal = 'clean-interrupted-command';
  return { invocationPath, value };
}

test('resume continues an authentic advancing journal after its completed Assignment is deselected', async () => {
  const { invocationPath, value } = await advancingJournalFixture();

  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify(value.request));

  assert.equal(resumed.status, 0, resumed.stderr);
  const output = JSON.parse(resumed.stdout);
  assert.equal(output.status, 'completed', resumed.stdout);
  assert.equal(output.reason, 'lifecycle-complete', resumed.stdout);
  assert.equal(await readFile(invocationPath, 'utf8'), 'invoked\n');
});

test('advancing recovery rejects a completed transaction for another Assignment', async () => {
  const { invocationPath, value } = await advancingJournalFixture('33333333-3333-4333-8333-333333333333');

  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify(value.request));

  assert.equal(resumed.status, 0, resumed.stderr);
  const output = JSON.parse(resumed.stdout);
  assert.equal(output.status, 'stopped', resumed.stdout);
  assert.equal(output.reason, 'advancing-journal-invalid', resumed.stdout);
  assert.match(output.detail, /does not belong to the recovering Assignment/);
  await assert.rejects(readFile(invocationPath), error => error.code === 'ENOENT');
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
  const { run008, initialManifestBytes, postManifestBytes } = await readAnchoredRun008Fixture();
  assert.equal(run008.snapshot.digest, `sha256:${run008InitialManifestDigest}`);
  assert.equal(run008.postRunSnapshot.digest, `sha256:${run008PostManifestDigest}`);
  assert.equal(`sha256:${createHash('sha256').update(initialManifestBytes).digest('hex')}`, run008.snapshot.digest);
  assert.equal(`sha256:${createHash('sha256').update(postManifestBytes).digest('hex')}`, run008.postRunSnapshot.digest);
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
  const value = await fixture({ scenarioReference: 'revise-question-decision-after-review@1', piScript, attentionRequired: true });
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

test('legacy operational-failure recovery pins use one exact request schema', async () => {
  const value = await fixture({ scenarioReference: 'ordinary@1' });
  value.request.signal = 'clean-interrupted-command';
  value.request.operationalFailureRecovery = {
    resultPath: path.join(value.scratch, 'run-008.runner.stdout'),
    resultDigest: `sha256:${'1'.repeat(64)}`,
    initialSnapshotDirectory: path.join(value.scratch, 'snapshot-000001'),
    initialSnapshotDigest: `sha256:${'2'.repeat(64)}`,
    postSnapshotDirectory: path.join(value.scratch, 'snapshot-000002'),
    postSnapshotDigest: `sha256:${'3'.repeat(64)}`,
  };

  const accepted = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
    ...value.request,
    contract: 'mdlm-demo-resume-request@1',
  }));
  assert.equal(accepted.status, 0, accepted.stderr);

  value.request.operationalFailureRecovery.extra = true;
  const rejected = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /operationalFailureRecovery must contain exactly/);
});

test('the real run-008 evidence and run-009 request recover only through an operator-pinned run', async () => {
  await readAnchoredRun008Fixture();
  const privateFixture = path.join(run008OperationalFailureDirectory, 'private-assignment-state');
  const exactPrivateDigests = {
    'identity.json': '9ac65f5a170648db741d31c609f7ffbdc15e22b16bc4952b74fdeddb98994b5f',
    'command-evidence/command-000001.json': 'a4ddefbbcd817a6473d29794857ac40c3f2637be951e20ce557ff8e265f6783a',
    'command-evidence/command-000001.stdout': '33a70ec41e03544a59d40d9cec3a6365df055f836b95b7b8c48575dfe40b2ad2',
    'command-evidence/command-000002.json': 'c6eae9e12cdd8a2ea633e1234b9964680dd9b890b86b76d1863878a214baf399',
    'command-evidence/command-000002.stderr': '25d375f49181145713f6c9bf248c6200f630584bb675236d2ecc7d9622df22e1',
    'shim/config.json': 'e40adb042520fcfb6ebf15e8a2b6790b930fcc319b70c972d52e8488d6db9865',
  };
  for (const [relative, expected] of Object.entries(exactPrivateDigests)) {
    assert.equal(createHash('sha256').update(await readFile(path.join(privateFixture, relative))).digest('hex'), expected, relative);
  }

  const value = await legacyRun009Fixture();
  const legacyBytes = await readFile(value.identityPath);
  const callsBefore = (await readFile(path.join(value.scratch, 'calls.log'), 'utf8')).trim().split('\n').length;
  const resumed = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
    ...value.request,
    contract: 'mdlm-demo-resume-request@1',
  }));

  assert.equal(resumed.status, 0, resumed.stderr);
  const refused = JSON.parse(resumed.stdout);
  assert.equal(refused.reason, 'wrong-recovery-mode', JSON.stringify(refused));
  assert.equal(refused.requiredNextMode, 'run');
  assert.equal(refused.operationalFailureRecovery.source, 'legacy-command-evidence-migration');
  assert.deepEqual(await readFile(value.identityPath), legacyBytes);
  await assert.rejects(readFile(value.workerLog), error => error.code === 'ENOENT');
  const callsAfterResume = (await readFile(path.join(value.scratch, 'calls.log'), 'utf8')).trim().split('\n').length;
  assert.equal(callsAfterResume - callsBefore, 6); // Initial and post snapshots only.

  const resumedAgain = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
    ...value.request,
    contract: 'mdlm-demo-resume-request@1',
  }));
  assert.equal(resumedAgain.status, 0, resumedAgain.stderr);
  assert.equal(JSON.parse(resumedAgain.stdout).reason, 'wrong-recovery-mode');
  assert.deepEqual(await readFile(value.identityPath), legacyBytes);
  await assert.rejects(readFile(value.workerLog), error => error.code === 'ENOENT');

  const executed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(JSON.parse(executed.stdout).status, 'completed');
  assert.equal(await readFile(value.workerLog, 'utf8'), 'invoke\n');
  const migratedIdentity = JSON.parse(await readFile(value.identityPath));
  assert.equal(migratedIdentity.contract, 'mdlm-demo-run-identity@5');
  assert.equal(migratedIdentity.mdlmPiCommandTimeoutMs, 600_000);
  assert.equal(migratedIdentity.mdlmPiAssignmentTimeoutMs, 840_000);
});

test('a durable legacy marker rejects a missing, changed, extra, or symlinked @4 identity before prepare or worker invocation', async () => {
  const cases = {
    missing: async value => {
      await rm(value.identityPath);
      return async () => assert.equal(await stat(value.identityPath).then(() => true, () => false), false);
    },
    changed: async value => {
      const identity = JSON.parse(await readFile(value.identityPath));
      identity.operator.model = 'tampered-model';
      const changed = Buffer.from(`${JSON.stringify(identity, null, 2)}\n`);
      await writeFile(value.identityPath, changed);
      return async () => assert.deepEqual(await readFile(value.identityPath), changed);
    },
    extra: async value => {
      const identity = JSON.parse(await readFile(value.identityPath));
      identity.extra = true;
      const changed = Buffer.from(`${JSON.stringify(identity, null, 2)}\n`);
      await writeFile(value.identityPath, changed);
      return async () => assert.deepEqual(await readFile(value.identityPath), changed);
    },
    symlinked: async value => {
      const target = path.join(value.scratch, 'saved-run-identity.json');
      await writeFile(target, await readFile(value.identityPath));
      await rm(value.identityPath);
      await symlink(target, value.identityPath);
      return async () => assert.equal((await lstat(value.identityPath)).isSymbolicLink(), true);
    },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const value = await legacyRun009Fixture();
    const firstResume = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
      ...value.request, contract: 'mdlm-demo-resume-request@1',
    }));
    assert.equal(firstResume.status, 0, `${name}: ${firstResume.stderr}`);
    assert.equal(JSON.parse(firstResume.stdout).reason, 'wrong-recovery-mode', name);
    const assertIdentityUnchanged = await mutate(value);
    const callsBefore = (await readFile(path.join(value.scratch, 'calls.log'), 'utf8')).trim().split('\n').length;

    const secondResume = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
      ...value.request, contract: 'mdlm-demo-resume-request@1',
    }));

    assert.equal(secondResume.status, 0, `${name}: ${secondResume.stderr}`);
    assert.equal(JSON.parse(secondResume.stdout).reason, 'operational-recovery-marker-invalid', name);
    await assertIdentityUnchanged();
    await assert.rejects(readFile(value.workerLog), error => error.code === 'ENOENT', name);
    const callsAfter = (await readFile(path.join(value.scratch, 'calls.log'), 'utf8')).trim().split('\n').length;
    assert.equal(callsAfter - callsBefore, 6, name);
  }
});

test('legacy @4 identity upgrade and retry transition recover across atomic write crash seams', async () => {
  for (const seam of ['after-temp-sync', 'after-rename']) {
    const value = await legacyRun009Fixture();
    const resume = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
      ...value.request, contract: 'mdlm-demo-resume-request@1',
    }));
    assert.equal(resume.status, 0, `${seam}: ${resume.stderr}`);
    assert.equal(JSON.parse(resume.stdout).reason, 'wrong-recovery-mode', seam);

    const crashed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request), {
      ...process.env, MDLM_DEMO_TEST_CRASH: `legacy-run-identity-upgrade:${seam}`,
    });

    assert.equal(crashed.status, 86, `${seam}: ${crashed.stderr}`);
    await assert.rejects(readFile(value.workerLog), error => error.code === 'ENOENT', seam);
    const history = await readdir(operationalRecoveryDirectoryForTest(value));
    assert.deepEqual(history.sort(), ['failure-000002.json', 'retry-000002.json'], seam);
    const identityAfterCrash = JSON.parse(await readFile(value.identityPath));
    assert.equal(identityAfterCrash.contract, seam === 'after-temp-sync' ? 'mdlm-demo-run-identity@4' : 'mdlm-demo-run-identity@5', seam);

    const retried = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
    assert.equal(retried.status, 0, `${seam}: ${retried.stderr}`);
    assert.equal(JSON.parse(retried.stdout).status, 'completed', seam);
    assert.equal(await readFile(value.workerLog, 'utf8'), 'invoke\n', seam);
    const migratedIdentity = JSON.parse(await readFile(value.identityPath));
    assert.equal(migratedIdentity.contract, 'mdlm-demo-run-identity@5', seam);
    assert.equal(migratedIdentity.mdlmPiCommandTimeoutMs, 600_000, seam);
    assert.equal(migratedIdentity.mdlmPiAssignmentTimeoutMs, 840_000, seam);
  }
});

test('legacy migration rejects every unpinned or altered run-008 boundary before worker invocation', async () => {
  const cases = {
    'missing operator pin': async value => { delete value.request.operationalFailureRecovery; },
    'wrong result digest': async value => { value.request.operationalFailureRecovery.resultDigest = `sha256:${'0'.repeat(64)}`; },
    'wrong snapshot digest': async value => { value.request.operationalFailureRecovery.initialSnapshotDigest = `sha256:${'0'.repeat(64)}`; },
    'swapped snapshots': async value => {
      const recovery = value.request.operationalFailureRecovery;
      [recovery.initialSnapshotDirectory, recovery.postSnapshotDirectory] = [recovery.postSnapshotDirectory, recovery.initialSnapshotDirectory];
      [recovery.initialSnapshotDigest, recovery.postSnapshotDigest] = [recovery.postSnapshotDigest, recovery.initialSnapshotDigest];
    },
    'changed evidence with unchanged authorized pins': async value => {
      await writeFile(value.request.operationalFailureRecovery.resultPath, `${await readFile(value.request.operationalFailureRecovery.resultPath, 'utf8')}\n`);
    },
    'tampered snapshot bytes': async value => {
      const file = path.join(value.request.operationalFailureRecovery.postSnapshotDirectory, 'commands', 'status.stdout');
      await chmod(file, 0o600);
      await writeFile(file, 'tampered\n');
    },
    'non-v4 identity': async value => {
      const identity = JSON.parse(await readFile(value.identityPath));
      identity.contract = 'mdlm-demo-run-identity@3';
      await writeFile(value.identityPath, `${JSON.stringify(identity, null, 2)}\n`);
    },
    'wrong result Assignment': async value => {
      const recovery = value.request.operationalFailureRecovery;
      const result = JSON.parse(await readFile(recovery.resultPath));
      result.assignmentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      await writeFile(recovery.resultPath, JSON.stringify(result));
      recovery.resultDigest = `sha256:${createHash('sha256').update(await readFile(recovery.resultPath)).digest('hex')}`;
    },
    'arbitrary extra legacy command': async value => {
      const directory = path.join(assignmentDirectory(value.request), 'command-evidence');
      for (const extension of ['json', 'stderr', 'stdout']) {
        await writeFile(path.join(directory, `command-000003.${extension}`), await readFile(path.join(directory, `command-000002.${extension}`)));
      }
    },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const value = await legacyRun009Fixture();
    await mutate(value);
    const execution = exec(process.execPath, [cli, 'resume'], root, JSON.stringify({
      ...value.request, contract: 'mdlm-demo-resume-request@1',
    }));
    assert.equal(execution.status, 0, `${name}: ${execution.stderr}`);
    assert.notEqual(JSON.parse(execution.stdout).reason, 'wrong-recovery-mode', name);
    await assert.rejects(readFile(value.workerLog), error => error.code === 'ENOENT', name);
    await assert.rejects(stat(operationalRecoveryDirectoryForTest(value)), error => error.code === 'ENOENT', name);
  }
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
  const output = JSON.parse(resumed.stdout);
  assert.equal(output.reason, 'pre-submission-operational-failure');
  assert.equal(output.recoverable, true);
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
  const { run008 } = await readAnchoredRun008Fixture();
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

test('operator-pinned materialized next recovery advances three exact publications once in evaluation order', async () => {
  const value = await materializedNextFixture();
  const commitCount = Number(git(['rev-list', '--count', 'HEAD'], value.repository));

  const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));

  assert.equal(first.status, 0, first.stderr);
  const recovered = JSON.parse(first.stdout);
  assert.equal(recovered.reason, 'lock-conflict', first.stdout);
  assert.deepEqual(recovered.materializedNextReconciliation, {
    status: 'reconciled',
    fromCommit: value.oldLifecycle.head,
    toCommit: value.finalLifecycle.head,
    executions: value.executions.map(execution => execution.id),
  });
  assert.deepEqual((await readFile(value.workerLog, 'utf8')).trim().split('\n'), [value.finalAssignment]);
  assert.equal(Number(git(['rev-list', '--count', 'HEAD'], value.repository)), commitCount);
  const trusted = JSON.parse(await readFile(path.join(value.repository, '.git', 'mdlm-demo-orchestrator', 'repository-identity.json')));
  assert.deepEqual(trusted.lifecycleRepository, value.finalLifecycle);

  const replay = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(replay.status, 0, replay.stderr);
  const repeated = JSON.parse(replay.stdout);
  assert.equal(repeated.materializedNextReconciliation?.status, 'already-reconciled', replay.stdout);
  assert.equal(Number(git(['rev-list', '--count', 'HEAD'], value.repository)), commitCount);
});

test('materialized next recovery rejects changed pins, execution lists, package, and live boundary', async () => {
  const cases = [
    ['changed pinned bytes', async value => { await writeFile(value.nextStdoutPath, `${JSON.stringify(value.next)}\n`); }],
    ['reordered execution', value => rewriteMaterializedNext(value, next => { next.materializedExecutions.reverse(); })],
    ['missing execution', value => rewriteMaterializedNext(value, next => { next.materializedExecutions.pop(); })],
    ['wrong package', value => rewriteMaterializedNext(value, next => { next.package.digest = `sha256:${'9'.repeat(64)}`; })],
    ['wrong final Assignment', value => writeFile(value.assignmentStatePath, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')],
    ['unrelated live commit', async value => { await writeFile(path.join(value.repository, 'unrelated.txt'), 'unrelated\n'); git(['add', 'unrelated.txt'], value.repository); git(['commit', '-m', 'unrelated'], value.repository); }],
  ];
  for (const [name, mutate] of cases) {
    const value = await materializedNextFixture();
    await mutate(value);
    const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
    assert.equal(execution.status, 0, `${name}: ${execution.stderr}`);
    const output = JSON.parse(execution.stdout);
    assert.ok(['materialized-next-reconciliation-failure', 'package-drift'].includes(output.reason), `${name}: ${execution.stdout}`);
    assert.equal(await stat(value.workerLog).then(() => true, () => false), false, name);
    const trusted = JSON.parse(await readFile(path.join(value.repository, '.git', 'mdlm-demo-orchestrator', 'repository-identity.json')));
    assert.deepEqual(trusted.lifecycleRepository, value.oldLifecycle, name);
  }
});

test('materialized next reconciliation resumes after durable boundary crash seams without replay', async () => {
  for (const seam of ['materialized-next-reconciliation-global:after-rename', 'boundary-advanced:after-rename']) {
    const value = await materializedNextFixture();
    const commitCount = Number(git(['rev-list', '--count', 'HEAD'], value.repository));
    const crashed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request), {
      ...process.env, MDLM_DEMO_TEST_CRASH: seam,
    });
    assert.equal(crashed.status, 86, `${seam}: ${crashed.stderr}`);
    assert.equal(await stat(value.workerLog).then(() => true, () => false), false, seam);

    const resumed = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
    assert.equal(resumed.status, 0, `${seam}: ${resumed.stderr}`);
    assert.equal(JSON.parse(resumed.stdout).materializedNextReconciliation.status, 'reconciled', resumed.stdout);
    assert.equal(Number(git(['rev-list', '--count', 'HEAD'], value.repository)), commitCount, seam);
    assert.deepEqual((await readFile(value.workerLog, 'utf8')).trim().split('\n'), [value.finalAssignment], seam);
  }
});

test('operator-pinned orphaned child checkpoint completes A once and runs B without replaying A', async () => {
  const value = await orphanedCheckpointFixture();

  const first = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));

  assert.equal(first.status, 0, first.stderr);
  const recovered = JSON.parse(first.stdout);
  assert.equal(recovered.reason, 'lock-conflict', first.stdout);
  assert.deepEqual(recovered.checkpointReconciliation, {
    status: 'reconciled', fromAssignment: run009AssignmentA, toAssignment: run009AssignmentB,
  });
  assert.deepEqual((await readFile(value.workerLog, 'utf8')).trim().split('\n'), [run009AssignmentB]);
  const completedAPath = path.join(value.aDirectory, 'transaction.json');
  const completedABytes = await readFile(completedAPath);
  const completedA = JSON.parse(completedABytes);
  assert.equal(completedA.phase, 'completed');
  assert.equal(completedA.assignmentId, run009AssignmentA);
  assert.deepEqual(completedA.completedRepository, value.currentLifecycle);
  const trusted = JSON.parse(await readFile(path.join(value.identityDirectory, 'repository-identity.json')));
  assert.deepEqual(trusted.lifecycleRepository, value.currentLifecycle);

  const second = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout).checkpointReconciliation, {
    status: 'already-reconciled', fromAssignment: run009AssignmentA, toAssignment: run009AssignmentB,
  });
  assert.deepEqual(await readFile(completedAPath), completedABytes);
  assert.deepEqual((await readFile(value.workerLog, 'utf8')).trim().split('\n'), [run009AssignmentB, run009AssignmentB]);
  const calls = (await readFile(path.join(value.scratch, 'calls.log'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.some(args => args[0] === 'scenario' && args[1] === 'prepare' && args[2] === run009AssignmentA &&
    args.at(-1) === 'recovery-replay'), false);
});

test('orphaned checkpoint recovery authenticates the completed Assignment publication', async () => {
  const value = await orphanedCheckpointFixture({
    publishedAssignment: '33333333-3333-4333-8333-333333333333',
  });

  const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));

  assert.equal(execution.status, 0, execution.stderr);
  const output = JSON.parse(execution.stdout);
  assert.equal(output.status, 'stopped', execution.stdout);
  assert.equal(output.reason, 'checkpoint-reconciliation-failure', execution.stdout);
  assert.match(output.detail, /does not belong to the completed Assignment/);
  await assert.rejects(readFile(value.workerLog), error => error.code === 'ENOENT');
});

test('orphaned checkpoint recovery rejects wrong markers and unrelated advancement before B invocation', async () => {
  const cases = [
    ['untrusted original prepare command', async value => {
      const recordPath = path.join(value.commandDirectory, 'command-000001.json');
      const record = JSON.parse(await readFile(recordPath));
      record.argv = [value.mdlm, 'status', '--json'];
      await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    }],
    ['wrong processed marker', async value => {
      const marker = JSON.parse(await readFile(value.processedAssignmentPath));
      marker.assignment = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      await writeFile(value.processedAssignmentPath, `${JSON.stringify(marker)}\n`);
      value.request.orphanedCheckpointRecovery.processedAssignment.digest =
        `sha256:${createHash('sha256').update(await readFile(value.processedAssignmentPath)).digest('hex')}`;
    }],
    ['unrelated clean advancement', async value => {
      await writeFile(path.join(value.repository, 'unrelated.txt'), 'unrelated\n');
      git(['add', 'unrelated.txt'], value.repository);
      git(['commit', '-m', 'unrelated advancement'], value.repository);
    }],
  ];
  for (const [name, mutate] of cases) {
    const value = await orphanedCheckpointFixture({ mutate });

    const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));

    assert.equal(execution.status, 0, `${name}: ${execution.stderr}`);
    const stopped = JSON.parse(execution.stdout);
    assert.equal(stopped.reason, 'checkpoint-reconciliation-failure', `${name}: ${execution.stdout}`);
    assert.equal(await stat(value.workerLog).then(() => true, () => false), false, name);
    const trusted = JSON.parse(await readFile(path.join(value.identityDirectory, 'repository-identity.json')));
    assert.deepEqual(trusted.lifecycleRepository, value.oldLifecycle, name);
    assert.equal(await stat(path.join(value.aDirectory, 'transaction.json')).then(() => true, () => false), false, name);
  }
});

test('the preserved run-009 orphaned checkpoint fixture stays byte exact', async () => {
  assert.equal(
    createHash('sha256').update(await readFile(path.join(run009OrphanedCheckpointDirectory, 'initial-snapshot', 'manifest.json'))).digest('hex'),
    run009InitialManifestDigest,
  );
  assert.equal(
    createHash('sha256').update(await readFile(path.join(run009OrphanedCheckpointDirectory, 'post-snapshot', 'manifest.json'))).digest('hex'),
    run009PostManifestDigest,
  );
  const exactHashes = {
    'recovery-history/failure-000002.json': '1f68be882d1dd4b23582d54aabb739ccd1bea962789459ce66945c6b481b9c9b',
    'recovery-history/retry-000002.json': 'fb5472e57ac0d1b2760c26f06045f8f7c64ee2723d21077e07d08559f3e7173f',
    'run-identity.json': '71b81e185a2291eeec935c63d1f548a0a4afc5d489775ad99bc5f44cb4f98fb0',
    'private-assignment-state/identity.json': '9ac65f5a170648db741d31c609f7ffbdc15e22b16bc4952b74fdeddb98994b5f',
    'private-assignment-state/command-evidence/command-000001.json': 'a4ddefbbcd817a6473d29794857ac40c3f2637be951e20ce557ff8e265f6783a',
    'private-assignment-state/command-evidence/command-000001.stdout': '33a70ec41e03544a59d40d9cec3a6365df055f836b95b7b8c48575dfe40b2ad2',
    'private-assignment-state/command-evidence/command-000001.stderr': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'private-assignment-state/command-evidence/command-000002.json': 'c6eae9e12cdd8a2ea633e1234b9964680dd9b890b86b76d1863878a214baf399',
    'private-assignment-state/command-evidence/command-000002.stdout': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'private-assignment-state/command-evidence/command-000002.stderr': '25d375f49181145713f6c9bf248c6200f630584bb675236d2ecc7d9622df22e1',
    'private-assignment-state/command-evidence/command-000003.json': '3a604548fbf8817c5c68ef31d005598b4644e1ceddce0267f8c620315c8b0995',
    'private-assignment-state/command-evidence/command-000003.stdout': '33a70ec41e03544a59d40d9cec3a6365df055f836b95b7b8c48575dfe40b2ad2',
    'private-assignment-state/command-evidence/command-000003.stderr': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'private-assignment-state/shim/config.json': 'e40adb042520fcfb6ebf15e8a2b6790b930fcc319b70c972d52e8488d6db9865',
    'private-assignment-state/shim/processed-assignment.json': 'f67ee9ac146adb5498ff8c091b6a3f2725dbcfc57c863e4f56553798f5003008',
    'private-assignment-state/shim/assignment-checkpoint.json': '5c61bd67b05cba4aabbfa373bcf771b3d6ffd59815d86972f5241b37241a31d9',
    [`private-assignment-state/shim/stops/${run009AssignmentB}.json`]: 'b49c5ce2503bc145e40805ec242466d0b08976b24c5afa56b85d04077a334e2b',
  };
  for (const [file, expected] of Object.entries(exactHashes)) {
    assert.equal(createHash('sha256').update(await readFile(path.join(run009OrphanedCheckpointDirectory, file))).digest('hex'), expected, file);
  }
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

test('runner rejects transaction journals that are symlinks or have a symlinked path component', async () => {
  for (const pathType of ['transaction symlink', 'path-component symlink']) {
    const workerLog = path.join(os.tmpdir(), `mdlm-demo-transaction-symlink-${process.pid}-${Date.now()}-${Math.random()}`);
    const piScript = `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(workerLog)},'invoked\\n'); console.log('{"status":"lifecycle-complete"}');\n`;
    const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
    value.request.signal = 'clean-interrupted-command';
    const stateDirectory = value.request.stateDirectory;
    const assignmentKey = assignmentKeyForTest(value.request.assignmentId);
    await mkdir(stateDirectory, { recursive: true });

    if (pathType === 'transaction symlink') {
      const directory = path.join(stateDirectory, 'assignments', assignmentKey);
      const outside = path.join(value.scratch, 'outside-transaction.json');
      await mkdir(directory, { recursive: true });
      await writeFile(outside, '{}\n');
      await symlink(outside, path.join(directory, 'transaction.json'));
    } else {
      const actualAssignments = path.join(value.scratch, 'actual-assignments');
      const directory = path.join(actualAssignments, assignmentKey);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'transaction.json'), '{}\n');
      await symlink(actualAssignments, path.join(stateDirectory, 'assignments'));
    }

    const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));

    assert.equal(execution.status, 0, `${pathType}: ${execution.stderr}`);
    const stopped = JSON.parse(execution.stdout);
    assert.equal(stopped.reason, 'orchestration-failure', `${pathType}: ${execution.stdout}`);
    assert.match(stopped.detail, pathType === 'transaction symlink'
      ? /checkpoint evidence is not a regular file/
      : /checkpoint evidence has a symbolic-link path component/);
    const snapshotRecord = JSON.parse(await readFile(path.join(stopped.snapshot.snapshotDirectory, 'snapshot.json')));
    assert.equal(snapshotRecord.journal.present, false, pathType);
    assert.equal(Object.hasOwn(snapshotRecord.journal, 'bytesBase64'), false, pathType);
    assert.equal(Object.hasOwn(snapshotRecord.journal, 'digest'), false, pathType);
    assert.match(snapshotRecord.journal.error, pathType === 'transaction symlink'
      ? /optional evidence is not a regular file/
      : /optional evidence has a symbolic-link path component/);
    assert.equal(await stat(workerLog).then(() => true, () => false), false, pathType);
  }
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
  const { scratch, request } = await fixture({ scenarioReference: 'review-correction@1', piScript, attentionRequired: true });
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

test('authoritative attended Assignment overrides a clean-interrupted-command signal', async () => {
  const inputPath = path.join(os.tmpdir(), `issue-4-pi-input-${process.pid}-${Date.now()}`);
  const piScript = `#!/bin/sh\ncat > ${inputPath}\nprintf '%s\\n' '{"status":"lifecycle-complete"}'\nexit 0\n`;
  const { scratch, request } = await fixture({ scenarioReference: 'resolve-question@2', piScript, attentionRequired: true });
  const wording = 'Build the smallest useful CLI temperature converter with exact invocation `<value> <from-unit> <to-unit>`.';
  const authorityBasis = 'Standing authorization permits the sole lifecycle operator to answer the intended-product question without pausing for user input.';
  const digestValue = `sha256:${createHash('sha256').update(wording).digest('hex')}`;
  const decisionCatalogPath = path.join(scratch, 'decisions.json');
  await writeFile(decisionCatalogPath, JSON.stringify({ contract: 'mdlm-demo-decision-catalog@1', decisions: [{
    assignment: request.assignmentId, wording, origin: 'operator-selected', authorityBasis, digest: digestValue,
  }] }));
  request.signal = 'clean-interrupted-command';
  request.decisionCatalogPath = decisionCatalogPath;

  const runResult = exec(process.execPath, [cli, 'run'], root, JSON.stringify(request));

  assert.equal(runResult.status, 0, runResult.stderr);
  const output = JSON.parse(runResult.stdout);
  assert.equal(output.status, 'completed');
  assert.deepEqual(output.decision, { origin: 'operator-selected', authorityBasis, digest: digestValue });
  assert.equal(await readFile(inputPath, 'utf8'), `${wording}\n`);
});
