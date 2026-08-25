import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
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
function assignmentDirectory(request) {
  const suffix = createHash('sha256').update(request.assignmentId).digest('hex').slice(-12);
  return path.join(request.stateDirectory, 'assignments', `${request.assignmentId}-${suffix}`);
}

async function fixture({
  uncertainSubmit = false,
  scenarioReference = 'register-pilot-target@1',
  piScript = '#!/bin/sh\nexit 0\n',
  executionId = '55555555-5555-4555-8555-555555555555',
  publicationPath,
} = {}) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'issue-213-run-'));
  const repository = path.join(scratch, 'repository');
  await mkdir(repository);
  git(['init', '-b', 'main'], repository); git(['config', 'user.name', 'Test'], repository); git(['config', 'user.email', 'test@example.invalid'], repository);
  await writeFile(path.join(repository, 'README.md'), 'fixture\n'); git(['add', '.'], repository); git(['commit', '-m', 'initial'], repository);
  const base = git(['rev-parse', 'HEAD'], repository);
  const trackedState = `sha256:${createHash('sha256').update(`${base}\0staged\0\0worktree\0`).digest('hex')}`;
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
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const a=process.argv.slice(2), root=process.cwd(), log=${JSON.stringify(path.join(scratch, 'calls.log'))};
fs.appendFileSync(log,JSON.stringify(a)+'\\n');
const assignment=fs.readFileSync(${JSON.stringify(assignmentStatePath)},'utf8'), scenario=fs.readFileSync(${JSON.stringify(scenarioStatePath)},'utf8'), head=${JSON.stringify(base)};
const malformedPath=${JSON.stringify(malformedDigestPath)}, malformedResponses=fs.existsSync(malformedPath)?[{digest:fs.readFileSync(malformedPath,'utf8'),diagnostics:[{code:'FIX',message:'correct it'}]}]:[];
const pkg={reference:'pkg@1',digest:'sha256:${'1'.repeat(64)}',language:'lang@1'};
const repo={head,trackedState:${JSON.stringify(trackedState)}};
function out(x){process.stdout.write(JSON.stringify(x)+'\\n')}
if(a[0]==='doctor') out({contract:'mdlm-doctor@1',ok:true,command:'doctor'});
else if(a[0]==='status') out({contract:'mdlm-status@1',ok:true,command:'status',package:pkg,currentOutcome:{outcome:'assignment',assignment:{allocation:'active',id:assignment}},recentTransaction:{available:false}});
else if(a[0]==='assignment') out({contract:'mdlm-assignment-state@1',ok:true,command:'assignment.show',assignment:{id:assignment},selected:true,package:pkg,repository:repo,scenarioReference:scenario,disposition:'active',retryAvailability:{},malformedResponses});
else if(a[0]==='scenario'&&a[1]==='prepare') out({contract:'mdlm-assignment-packet@2',ok:true,command:'scenario.prepare',assignment:{id:assignment},package:pkg,repository:repo,scenario:{reference:scenario},responseSchema:{},exactInputs:[]});
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
    stateDirectory: path.join(scratch, 'state'), evidenceDirectory: path.join(scratch, 'evidence'), timeoutMs: 10_000,
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

test('ordinary Assignments invoke mdlm-pi with the exact operator provider, model, and thinking argv', async () => {
  const argvPath = path.join(os.tmpdir(), `mdlm-demo-operator-argv-${process.pid}-${Date.now()}`);
  const piScript = `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2))); console.log('{"status":"process-dead-end"}'); process.exit(2);\n`;
  const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
  value.request.signal = 'clean-interrupted-command';

  const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));

  assert.equal(execution.status, 0, execution.stderr);
  const output = JSON.parse(execution.stdout);
  const expected = [
    'run', value.repository,
    '--mdlm', path.join(root, 'bin/mdlm-demo-mdlm-shim.mjs'),
    '--provider', 'openai-codex',
    '--model', 'gpt-5.6-sol',
    '--thinking', 'high',
  ];
  assert.deepEqual(JSON.parse(await readFile(argvPath, 'utf8')), expected);
  assert.deepEqual(output.process.argv, [value.mdlmPi, ...expected]);
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

test('mdlm-pi exit codes and typed results distinguish lifecycle outcomes from operational failures', async () => {
  const cases = [
    [0, 'lifecycle-complete', 'completed', 'lifecycle-complete', false],
    [0, 'profile-boundary-reached', 'completed', 'profile-boundary-reached', false],
    [2, 'process-dead-end', 'stopped', 'process-dead-end', false],
    [3, 'invalid', 'stopped', 'invalid', false],
    [4, 'assignment-exhausted', 'stopped', 'assignment-exhausted', false],
    [5, 'lock-conflict', 'stopped', 'lock-conflict', true],
    [1, 'operational-failure', 'stopped', 'mdlm-pi-operational-failure', false],
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

test('typed reserved stops distinguish pre-submission interception from an accepted Assignment checkpoint', async () => {
  for (const [type, expectedStatus, outcome] of [
    ['external-adapter', 'stopped', 'pre-submission-stop'],
    ['assignment-checkpoint', 'stopped', 'pre-submission-stop'],
    ['accepted-assignment-then-external', 'completed', 'accepted-publication'],
  ]) {
    const stop = {
      contract: 'mdlm-demo-reserved-stop@1', type, phase: 'before-worker', reason: 'fixture',
      assignment: type === 'accepted-assignment-then-external'
        ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        : '44444444-4444-4444-8444-444444444444',
      scenario: type === 'accepted-assignment-then-external' ? 'execute-verification-run@1' : 'ordinary@1',
      ...(type === 'accepted-assignment-then-external'
        ? { completedAssignment: '44444444-4444-4444-8444-444444444444' }
        : {}),
    };
    const piScript = `#!/usr/bin/env node\nconst fs=require('node:fs'); const path=require('node:path'); const config=JSON.parse(fs.readFileSync(process.env.MDLM_DEMO_SHIM_CONFIG,'utf8')); fs.mkdirSync(config.stopDirectory,{recursive:true}); const packetPath=path.join(config.stopDirectory,'${type}.json'); fs.writeFileSync(packetPath,JSON.stringify({contract:'mdlm-assignment-packet@2',command:'scenario.prepare',ok:true,assignment:{id:'${stop.assignment}'},scenario:{reference:'${stop.scenario}'}}),{flag:'wx'}); const stop=${JSON.stringify(stop)}; stop.packetPath=packetPath; console.error(JSON.stringify({status:'operational-failure',cause:stop})); process.exit(1);\n`;
    const value = await fixture({ scenarioReference: 'ordinary@1', piScript });
    value.request.signal = 'clean-interrupted-command';
    const execution = exec(process.execPath, [cli, 'run'], root, JSON.stringify(value.request));
    assert.equal(execution.status, 0, execution.stderr);
    const output = JSON.parse(execution.stdout);
    assert.equal(output.status, expectedStatus, type);
    assert.equal(output.outcome, outcome, type);
    assert.equal(output.reason, 'reserved-shim-stop', type);
    if (type === 'accepted-assignment-then-external') {
      assert.deepEqual(output.nextAssignment, {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        scenario: 'execute-verification-run@1',
        phase: 'pre-submission',
      });
    }
  }
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
