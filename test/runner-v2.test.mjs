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
    const submission = await fixture(name);
    validateSubmissionOutcome(
      submission,
      '11111111-1111-4111-8111-111111111111',
      submission.responseDigest,
    );
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
  accepted.responseDigest = sha256(Buffer.from(`${JSON.stringify(response)}\n`));
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

test('attended path supplies only the exact Assignment-bound authority', async context => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-runner-authority-'));
  const repository = path.join(scratch, 'repository');
  const stateDirectory = path.join(scratch, 'state');
  await mkdir(repository);
  await exec('/usr/bin/git', ['init', '-q'], { cwd: repository });
  const next = await fixture('attention-required.json');
  const response = await fixture('assignment-response.json');
  response.assignment = next.assignment.id;
  const accepted = await fixture('submission-accepted.json');
  accepted.assignment.id = next.assignment.id;
  accepted.settlement.assignment = next.assignment.id;
  accepted.responseDigest = sha256(Buffer.from(`${JSON.stringify(response)}\n`));
  const calls = path.join(scratch, 'calls.jsonl');
  const mdlm = path.join(scratch, 'mdlm');
  const operator = path.join(scratch, 'operator.mjs');
  await writeFile(mdlm, `#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(args[0]==='next')process.stdout.write(${JSON.stringify(`${JSON.stringify(next)}\n`)});else if(args[0]==='scenario'&&args[1]==='submit')process.stdout.write(${JSON.stringify(`${JSON.stringify(accepted)}\n`)});else process.exit(8);\n`);
  await chmod(mdlm, 0o755);
  await writeFile(operator, `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(`${JSON.stringify(response)}\n`)}));\n`);
  const authoritySupply = { assignment: next.assignment.id, authority: 'stakeholder' };
  const request = {
    contract: 'mdlm-demo-run-request@2', repository, stateDirectory, timeoutMs: 10_000,
    commands: {
      mdlm: { path: mdlm, digest: sha256(await readFile(mdlm)) },
      operator: { path: process.execPath, digest: sha256(await readFile(process.execPath)), args: [operator] },
    },
  };
  const attention = await run(request);
  assert.equal(attention.status, 'attention-required');
  assert.equal(attention.next.assignment.id, authoritySupply.assignment);
  await assert.rejects(readFile(path.join(stateDirectory, 'transaction.json')), error => error.code === 'ENOENT');
  const result = await run({ ...request, authoritySupply });
  assert.equal(result.status, 'accepted');
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse), [
    ['next', '--json'],
    ['next', '--json'],
    ['scenario', 'submit', '--authority', 'stakeholder', '--json'],
  ]);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(stateDirectory, 'transaction.json'), 'utf8')).authoritySupply,
    authoritySupply,
  );
  context.after(async () => import('node:fs/promises').then(fs => fs.rm(scratch, { recursive: true })));
});

test('rejects mismatched, extra, and ordinary Assignment authority before operator or submit', async context => {
  const attended = await fixture('attention-required.json');
  const ordinary = await fixture('assignment.json');
  const cases = [
    ['wrong Assignment', attended, { assignment: ordinary.assignment.id, authority: 'stakeholder' }, /Assignment differs/],
    ['wrong authority', attended, { assignment: attended.assignment.id, authority: 'reviewer' }, /declared authority/],
    ['extra field', attended, { assignment: attended.assignment.id, authority: 'stakeholder', source: 'proposal' }, /must contain exactly/],
    ['ordinary Assignment', ordinary, { assignment: ordinary.assignment.id, authority: 'stakeholder' }, /only valid for attention-required/],
  ];
  for (const [name, next, authoritySupply, expected] of cases) {
    await context.test(name, async subcontext => {
      const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-runner-authority-reject-'));
      const repository = path.join(scratch, 'repository');
      const stateDirectory = path.join(scratch, 'state');
      await mkdir(repository);
      await exec('/usr/bin/git', ['init', '-q'], { cwd: repository });
      const calls = path.join(scratch, 'calls.jsonl');
      const operatorCalled = path.join(scratch, 'operator-called');
      const mdlm = path.join(scratch, 'mdlm');
      const operator = path.join(scratch, 'operator.mjs');
      await writeFile(mdlm, `#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(args[0]==='next')process.stdout.write(${JSON.stringify(`${JSON.stringify(next)}\n`)});else process.exit(8);\n`);
      await chmod(mdlm, 0o755);
      await writeFile(operator, `require('node:fs').writeFileSync(${JSON.stringify(operatorCalled)},'called');\n`);
      const request = {
        contract: 'mdlm-demo-run-request@2', repository, stateDirectory, timeoutMs: 10_000,
        commands: {
          mdlm: { path: mdlm, digest: sha256(await readFile(mdlm)) },
          operator: { path: process.execPath, digest: sha256(await readFile(process.execPath)), args: [operator] },
        },
        ...(authoritySupply === undefined ? {} : { authoritySupply }),
      };
      await assert.rejects(run(request), expected);
      if (name === 'extra field') {
        await assert.rejects(readFile(calls), error => error.code === 'ENOENT');
      } else {
        assert.deepEqual(JSON.parse((await readFile(calls, 'utf8')).trim()), ['next', '--json']);
      }
      await assert.rejects(readFile(operatorCalled), error => error.code === 'ENOENT');
      subcontext.after(async () => import('node:fs/promises').then(fs => fs.rm(scratch, { recursive: true })));
    });
  }
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
  const packet = await fixture('assignment-packet.json');
  const packetPath = path.join(stateDirectory, 'packet.json');
  const responseDigest = `sha256:${'e'.repeat(64)}`;
  await writeFile(packetPath, `${JSON.stringify(packet)}\n`);
  const mdlm = path.join(scratch, 'mdlm');
  const calls = path.join(scratch, 'calls.jsonl');
  await writeFile(mdlm, `#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');process.stdout.write(${JSON.stringify(`${JSON.stringify(accepted)}\n`)});\n`);
  await chmod(mdlm, 0o755);
  const commands = {
    mdlm: { path: mdlm, digest: sha256(await readFile(mdlm)) },
    operator: { path: process.execPath, digest: sha256(await readFile(process.execPath)), args: [] },
  };
  const authoritySupply = { assignment, authority: 'stakeholder' };
  await writeFile(path.join(stateDirectory, 'transaction.json'), `${JSON.stringify({
    contract: 'mdlm-demo-transaction@3',
    phase: 'settlement-required',
    assignment,
    repository,
    commands,
    package: packet.package,
    packetRepository: packet.repository,
    packetDigest: sha256(await readFile(packetPath)),
    packetPath,
    responseDigest,
    authoritySupply,
    settlement: { assignment, execution },
  })}\n`);
  const result = await run({
    contract: 'mdlm-demo-run-request@2', repository, stateDirectory, timeoutMs: 10_000,
    commands, authoritySupply,
  });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(JSON.parse((await readFile(calls, 'utf8')).trim()), ['scenario', 'settlement', execution, '--json']);
  context.after(async () => import('node:fs/promises').then(fs => fs.rm(scratch, { recursive: true })));
});

test('recovery rejects repository identity drift before settlement inspection', async context => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-runner-recovery-drift-'));
  const repository = path.join(scratch, 'repository');
  const stateDirectory = path.join(scratch, 'state');
  await mkdir(repository);
  await mkdir(stateDirectory);
  await exec('/usr/bin/git', ['init', '-q'], { cwd: repository });
  const packet = await fixture('assignment-packet.json');
  const packetPath = path.join(stateDirectory, 'packet.json');
  await writeFile(packetPath, `${JSON.stringify(packet)}\n`);
  const calls = path.join(scratch, 'calls');
  const mdlm = path.join(scratch, 'mdlm');
  await writeFile(mdlm, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(calls)},'called');\n`);
  await chmod(mdlm, 0o755);
  const commands = {
    mdlm: { path: mdlm, digest: sha256(await readFile(mdlm)) },
    operator: { path: process.execPath, digest: sha256(await readFile(process.execPath)), args: [] },
  };
  await writeFile(path.join(stateDirectory, 'transaction.json'), `${JSON.stringify({
    contract: 'mdlm-demo-transaction@3', phase: 'settlement-required',
    assignment: packet.assignment.id, repository: `${repository}-different`, commands,
    package: packet.package, packetRepository: packet.repository,
    packetDigest: sha256(await readFile(packetPath)), packetPath,
    responseDigest: `sha256:${'e'.repeat(64)}`,
    settlement: { assignment: packet.assignment.id },
  })}\n`);
  await assert.rejects(
    run({ contract: 'mdlm-demo-run-request@2', repository, stateDirectory, timeoutMs: 10_000, commands }),
    /transaction repository differs from the canonical repository/,
  );
  await assert.rejects(readFile(calls), error => error.code === 'ENOENT');
  context.after(async () => import('node:fs/promises').then(fs => fs.rm(scratch, { recursive: true })));
});
