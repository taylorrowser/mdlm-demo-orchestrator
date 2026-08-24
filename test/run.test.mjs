import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin/mdlm-demo-runner.mjs');
function exec(program, args, cwd, input) { const r = spawnSync(program, args, { cwd, input, encoding: 'utf8', timeout: 20_000 }); return r; }
function git(args, cwd) { const r = exec('git', args, cwd); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
function digest(file, cwd) { return `sha256:${exec('sha256sum', [file], cwd).stdout.split(' ')[0]}`; }

async function fixture({ uncertainSubmit = false, scenarioReference = 'register-pilot-target@1', piScript = '#!/bin/sh\nexit 0\n' } = {}) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'issue-213-run-'));
  const repository = path.join(scratch, 'repository');
  await mkdir(repository);
  git(['init', '-b', 'main'], repository); git(['config', 'user.name', 'Test'], repository); git(['config', 'user.email', 'test@example.invalid'], repository);
  await writeFile(path.join(repository, 'README.md'), 'fixture\n'); git(['add', '.'], repository); git(['commit', '-m', 'initial'], repository);
  const base = git(['rev-parse', 'HEAD'], repository);
  const mdlm = path.join(scratch, 'mdlm');
  const mdlmPi = path.join(scratch, 'mdlm-pi');
  const packageArtifact = path.join(scratch, 'package.tgz');
  const responsePath = path.join(scratch, 'response.json');
  const observationsPath = path.join(scratch, 'observations.json');
  const adapterInputsPath = path.join(scratch, 'adapter-inputs.json');
  const assignment = '44444444-4444-4444-8444-444444444444';
  const scenario = scenarioReference;
  const response = `{"contract":"mdlm-assignment-response@1","assignment":"${assignment}","kind":"proposal","proposal":{}}\n`;
  await writeFile(responsePath, response);
  await writeFile(observationsPath, JSON.stringify({ contract: 'mdlm-external-observations@1', assignment, scenario, product: { repository: 'https://example.invalid/product.git', commit: 'b'.repeat(40), tree: 'c'.repeat(40) } }));
  await writeFile(adapterInputsPath, JSON.stringify({ contract: 'mdlm-external-adapter-inputs@1', scenarios: { [scenario]: { kind: 'exact-response', responsePath, observationsPath } } }));
  const script = `#!/usr/bin/env node
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const a=process.argv.slice(2), root=process.cwd(), log=${JSON.stringify(path.join(scratch, 'calls.log'))};
fs.appendFileSync(log,JSON.stringify(a)+'\\n');
const assignment=${JSON.stringify(assignment)}, scenario=${JSON.stringify(scenario)}, head=${JSON.stringify(base)};
const pkg={reference:'pkg@1',digest:'sha256:${'1'.repeat(64)}',language:'lang@1'};
const repo={head,trackedState:'sha256:${'2'.repeat(64)}'};
function out(x){process.stdout.write(JSON.stringify(x)+'\\n')}
if(a[0]==='doctor') out({contract:'mdlm-doctor@1',ok:true,command:'doctor'});
else if(a[0]==='status') out({contract:'mdlm-status@1',ok:true,command:'status',package:pkg,currentOutcome:{outcome:'assignment',assignment:{id:assignment}},recentTransaction:{available:false}});
else if(a[0]==='assignment') out({contract:'mdlm-assignment-state@1',ok:true,command:'assignment.show',assignment:{id:assignment},selected:true,package:pkg,repository:repo,scenarioReference:scenario,disposition:'active',retryAvailability:{},malformedResponses:[]});
else if(a[0]==='scenario'&&a[1]==='prepare') out({contract:'mdlm-assignment-packet@2',ok:true,command:'scenario.prepare',assignment:{id:assignment},package:pkg,repository:repo,scenario:{reference:scenario},responseSchema:{},exactInputs:[]});
else if(a[0]==='scenario'&&a[1]==='submit') { let chunks=[]; process.stdin.on('data',x=>chunks.push(x)); process.stdin.on('end',()=>{const bytes=Buffer.concat(chunks); fs.appendFileSync(${JSON.stringify(path.join(scratch, 'submit-count'))},'1\\n'); const id='55555555-5555-4555-8555-555555555555'; const dir=path.join(root,'.lifecycle/data/.transactions',id); fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,'execution.json'),'execution\\n'); fs.mkdirSync(path.join(root,'.lifecycle/data'),{recursive:true}); fs.writeFileSync(path.join(root,'.lifecycle/data','target.json'),'target\\n'); if(${uncertainSubmit}) process.exit(9); else out({contract:'mdlm-scenario-execution@4',ok:true,command:'scenario.submit',execution:{contract:'mdlm-scenario-execution@4',id,status:'completed',response:{assignment,digest:'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex')},definition:{scenario},outputs:[{lifecycleDatum:{path:'.lifecycle/data/target.json'}}]}}); }); }
else {process.stderr.write('unexpected '+JSON.stringify(a));process.exit(8)}
`;
  await writeFile(mdlm, script); await chmod(mdlm, 0o755);
  await writeFile(mdlmPi, piScript); await chmod(mdlmPi, 0o755);
  await writeFile(packageArtifact, 'package\n');
  const request = {
    contract: 'mdlm-demo-run-request@1', repository,
    stateDirectory: path.join(scratch, 'state'), evidenceDirectory: path.join(scratch, 'evidence'), timeoutMs: 10_000,
    signal: 'adapter-failure-before-submission', assignmentId: assignment, adapterInputsPath,
    commands: { mdlm, mdlmPi },
    provenance: {
      source: { repository, commit: base }, package: { artifact: packageArtifact, digest: digest(packageArtifact, scratch) },
      tools: { mdlm: { path: mdlm, digest: digest(mdlm, scratch) }, mdlmPi: { path: mdlmPi, digest: digest(mdlmPi, scratch) } },
      qualificationHarness: { repository, commit: base },
    },
  };
  return { scratch, repository, request };
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
  const outputPath = '.lifecycle/data/recovered.json';
  await mkdir(path.join(repository, path.dirname(transactionPath)), { recursive: true });
  await writeFile(path.join(repository, transactionPath), 'accepted execution\n');
  await writeFile(path.join(repository, outputPath), 'accepted output\n');
  const blobs = [transactionPath, outputPath].map(item => ({ path: item, oid: git(['hash-object', '--no-filters', '--', item], repository) }));
  const transactions = path.join(request.stateDirectory, 'transactions');
  await mkdir(transactions, { recursive: true });
  await writeFile(path.join(transactions, `${request.assignmentId}.json`), JSON.stringify({
    contract: 'mdlm-demo-transaction-journal@1', phase: 'published-uncommitted', assignmentId: request.assignmentId,
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

test('attended correction re-entry passes an operator-selected catalog decision to mdlm-pi', async () => {
  const inputPath = path.join(os.tmpdir(), `issue-213-pi-input-${process.pid}-${Date.now()}`);
  const piScript = `#!/bin/sh\ncat > ${inputPath}\nexit 4\n`;
  const { scratch, request } = await fixture({ scenarioReference: 'review-correction@1', piScript });
  const wording = 'Use the smallest correction that preserves the accepted evidence boundary.';
  const decisionCatalogPath = path.join(scratch, 'decisions.json');
  const digestValue = `sha256:${createHash('sha256').update(wording).digest('hex')}`;
  await writeFile(decisionCatalogPath, JSON.stringify({ contract: 'mdlm-demo-decision-catalog@1', decisions: [{
    assignment: request.assignmentId, wording, origin: 'operator-selected',
    authorityBasis: 'Standing authorization permits operator selection without pausing for user input.', digest: digestValue,
  }] }));
  const attended = { ...request, signal: 'correction-session-lost', correction: { previousResponseDigest: `sha256:${'a'.repeat(64)}`, diagnosticsDigest: `sha256:${'b'.repeat(64)}` }, decisionCatalogPath };
  const runResult = exec(process.execPath, [cli, 'run'], root, JSON.stringify(attended));
  assert.equal(runResult.status, 0, runResult.stderr);
  const output = JSON.parse(runResult.stdout);
  assert.equal(output.status, 'stopped');
  assert.equal(output.recoverable, true);
  assert.deepEqual(output.decision, { origin: 'operator-selected', authorityBasis: 'Standing authorization permits operator selection without pausing for user input.', digest: digestValue });
  assert.equal(await readFile(inputPath, 'utf8'), `${wording}\n`);
});
