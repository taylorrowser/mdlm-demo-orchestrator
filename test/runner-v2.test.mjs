import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { run, validateNextOutcome, validateSubmissionOutcome } from '../src/runner.mjs';

const exec = promisify(execFile);
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/operator-contract-v2');

async function fixture(name) {
  return JSON.parse(await readFile(path.join(fixtures, name), 'utf8'));
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

test('accepts the pinned six-outcome and three-submission contract fixtures', async () => {
  for (const name of [
    'assignment.json',
    'attention-required.json',
    'profile-boundary-reached.json',
    'lifecycle-complete.json',
    'process-dead-end.json',
    'invalid.json',
  ]) validateNextOutcome(await fixture(name));
  for (const name of ['submission-accepted.json', 'submission-rejected.json', 'submission-settlement-required.json']) {
    validateSubmissionOutcome(await fixture(name), '11111111-1111-4111-8111-111111111111');
  }
});

test('ordinary path calls next once, hands over its packet, and submits one response', async context => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-runner-v2-'));
  const repository = path.join(scratch, 'repository');
  const stateDirectory = path.join(scratch, 'state');
  await mkdir(repository);
  await exec('/usr/bin/git', ['init', '-q'], { cwd: repository });
  const next = await fixture('assignment.json');
  const response = await fixture('assignment-response.json');
  const accepted = await fixture('submission-accepted.json');
  const calls = path.join(scratch, 'calls.jsonl');
  const mdlm = path.join(scratch, 'mdlm');
  const operator = path.join(scratch, 'operator.mjs');
  await writeFile(mdlm, `#!/usr/bin/env node\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');\nif(args[0]==='next') process.stdout.write(${JSON.stringify(`${JSON.stringify(next)}\n`)});\nelse if(args[0]==='scenario'&&args[1]==='submit'){let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(JSON.parse(input).contract!=='mdlm-assignment-response@2')process.exit(9);process.stdout.write(${JSON.stringify(`${JSON.stringify(accepted)}\n`)});});}\nelse process.exit(8);\n`);
  await chmod(mdlm, 0o755);
  await writeFile(operator, `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(`${JSON.stringify(response)}\n`)}));\n`);
  const request = {
    contract: 'mdlm-demo-run-request@2',
    repository,
    stateDirectory,
    timeoutMs: 10_000,
    commands: {
      mdlm: { path: mdlm, digest: sha256(await readFile(mdlm)) },
      operator: { path: process.execPath, digest: sha256(await readFile(process.execPath)), args: [operator] },
    },
  };
  const result = await run(request);
  assert.equal(result.status, 'accepted');
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse), [
    ['next', '--json'],
    ['scenario', 'submit', '--json'],
  ]);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(stateDirectory, next.assignment.id, 'packet.json'), 'utf8')),
    next.assignment.packet,
  );
  context.after(async () => import('node:fs/promises').then(fs => fs.rm(scratch, { recursive: true })));
});

test('an interrupted submission is inspected by stable identity and never replayed', async context => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-runner-settlement-'));
  const repository = path.join(scratch, 'repository');
  const stateDirectory = path.join(scratch, 'state');
  await mkdir(repository);
  await mkdir(stateDirectory);
  await exec('/usr/bin/git', ['init', '-q'], { cwd: repository });
  const assignment = '11111111-1111-4111-8111-111111111111';
  const execution = '33333333-3333-4333-8333-333333333333';
  const accepted = await fixture('submission-accepted.json');
  await writeFile(path.join(stateDirectory, 'transaction.json'), `${JSON.stringify({
    contract: 'mdlm-demo-transaction@3',
    phase: 'settlement-required',
    assignment,
    responseDigest: `sha256:${'e'.repeat(64)}`,
    settlement: { assignment, execution },
  })}\n`);
  const calls = path.join(scratch, 'calls.jsonl');
  const mdlm = path.join(scratch, 'mdlm');
  await writeFile(mdlm, `#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');process.stdout.write(${JSON.stringify(`${JSON.stringify(accepted)}\n`)});\n`);
  await chmod(mdlm, 0o755);
  const result = await run({
    contract: 'mdlm-demo-run-request@2', repository, stateDirectory, timeoutMs: 10_000,
    commands: {
      mdlm: { path: mdlm, digest: sha256(await readFile(mdlm)) },
      operator: { path: process.execPath, digest: sha256(await readFile(process.execPath)), args: [] },
    },
  });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(JSON.parse((await readFile(calls, 'utf8')).trim()), ['scenario', 'settlement', execution, '--json']);
  context.after(async () => import('node:fs/promises').then(fs => fs.rm(scratch, { recursive: true })));
});
