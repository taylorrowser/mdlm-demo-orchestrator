import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shim = path.join(root, 'bin/mdlm-demo-mdlm-shim.mjs');

test('shim emits a typed stop for a reserved Scenario before worker execution', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'issue-213-shim-'));
  const real = path.join(scratch, 'mdlm');
  const assignment = '66666666-6666-4666-8666-666666666666';
  await writeFile(real, `#!/usr/bin/env node\nconsole.log(JSON.stringify({contract:'mdlm-assignment-packet@2',ok:true,command:'scenario.prepare',assignment:{id:'${assignment}'},package:{reference:'pkg@1',digest:'sha256:${'1'.repeat(64)}',language:'lang@1'},repository:{head:'${'a'.repeat(40)}',trackedState:'sha256:${'2'.repeat(64)}'},scenario:{reference:'execute-verification-run@1'},responseSchema:{},exactInputs:[]}));\n`);
  await chmod(real, 0o755);
  const config = path.join(scratch, 'config.json');
  const stopDirectory = path.join(scratch, 'stops');
  await writeFile(config, JSON.stringify({
    contract: 'mdlm-demo-shim-config@1', realMdlm: real, allowedAssignment: assignment,
    package: { reference: 'pkg@1', digest: `sha256:${'1'.repeat(64)}`, language: 'lang@1' },
    repository: { head: 'a'.repeat(40), trackedState: `sha256:${'2'.repeat(64)}` },
    stopDirectory, timeoutMs: 5_000,
  }));
  const result = spawnSync(process.execPath, [shim, 'scenario', 'prepare', assignment, '--json'], { cwd: scratch, env: { ...process.env, MDLM_DEMO_SHIM_CONFIG: config }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 97);
  const stop = JSON.parse(result.stdout);
  assert.deepEqual({ contract: stop.contract, type: stop.type, phase: stop.phase, scenario: stop.scenario }, {
    contract: 'mdlm-demo-reserved-stop@1', type: 'external-adapter', phase: 'before-worker', scenario: 'execute-verification-run@1',
  });
  const retained = JSON.parse(await readFile(path.join(stopDirectory, `${assignment}.json`), 'utf8'));
  assert.equal(retained.scenario.reference, 'execute-verification-run@1');
});

test('shim reports accepted A and pre-submission external B as one typed boundary', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-demo-shim-combined-'));
  const real = path.join(scratch, 'mdlm');
  const accepted = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const external = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await writeFile(real, `#!/usr/bin/env node\nconst id=process.argv[4]; console.log(JSON.stringify({contract:'mdlm-assignment-packet@2',ok:true,command:'scenario.prepare',assignment:{id},package:{reference:'pkg@1',digest:'sha256:${'1'.repeat(64)}',language:'lang@1'},repository:{head:'${'a'.repeat(40)}',trackedState:'sha256:${'2'.repeat(64)}'},scenario:{reference:id==='${accepted}'?'ordinary-a@1':'execute-verification-run@1'},responseSchema:{},exactInputs:[]}));\n`);
  await chmod(real, 0o755);
  const config = path.join(scratch, 'config.json');
  await writeFile(config, JSON.stringify({
    contract: 'mdlm-demo-shim-config@1', realMdlm: real, allowedAssignment: accepted,
    package: { reference: 'pkg@1', digest: `sha256:${'1'.repeat(64)}`, language: 'lang@1' },
    repository: { head: 'a'.repeat(40), trackedState: `sha256:${'2'.repeat(64)}` },
    stopDirectory: path.join(scratch, 'stops'), timeoutMs: 5_000,
  }));
  const environment = { ...process.env, MDLM_DEMO_SHIM_CONFIG: config };
  const preparedA = spawnSync(process.execPath, [shim, 'scenario', 'prepare', accepted, '--json'], { cwd: scratch, env: environment, encoding: 'utf8', timeout: 10_000 });
  assert.equal(preparedA.status, 0, preparedA.stderr);
  const result = spawnSync(process.execPath, [shim, 'scenario', 'prepare', external, '--json'], { cwd: scratch, env: environment, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 97);
  const stop = JSON.parse(result.stdout);
  assert.equal(stop.type, 'accepted-assignment-then-external');
  assert.equal(stop.completedAssignment, accepted);
  assert.equal(stop.assignment, external);
  assert.equal(stop.scenario, 'execute-verification-run@1');
});

test('shim reports accepted A and pre-submission ordinary B as an authenticated Assignment checkpoint', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-demo-shim-ordinary-checkpoint-'));
  const real = path.join(scratch, 'mdlm');
  const accepted = '0110fb6b-5a0d-4228-9867-58ed3e27a4a4';
  const next = '6db7bda7-7043-446b-a38a-2daab6c6df3e';
  const initialRepository = { head: '1'.repeat(40), trackedState: `sha256:${'2'.repeat(64)}` };
  const nextRepository = { head: '856aab804ebb097598cf75cc437f933bd0e5569d', trackedState: `sha256:${'e'.repeat(64)}` };
  await writeFile(real, `#!/usr/bin/env node\nconst id=process.argv[4]; const initial=${JSON.stringify(initialRepository)}; const next=${JSON.stringify(nextRepository)}; console.log(JSON.stringify({contract:'mdlm-assignment-packet@2',ok:true,command:'scenario.prepare',assignment:{id},package:{reference:'pkg@1',digest:'sha256:${'1'.repeat(64)}',language:'lang@1'},repository:id==='${accepted}'?initial:next,scenario:{reference:id==='${accepted}'?'ordinary-a@1':'freeze-source-boundary@1'},responseSchema:{},exactInputs:[]}));\n`);
  await chmod(real, 0o755);
  const config = path.join(scratch, 'config.json');
  const stopDirectory = path.join(scratch, 'stops');
  await writeFile(config, JSON.stringify({
    contract: 'mdlm-demo-shim-config@1', realMdlm: real, allowedAssignment: accepted,
    package: { reference: 'pkg@1', digest: `sha256:${'1'.repeat(64)}`, language: 'lang@1' },
    repository: initialRepository, stopDirectory, timeoutMs: 5_000,
  }));
  const environment = { ...process.env, MDLM_DEMO_SHIM_CONFIG: config };

  const premature = spawnSync(process.execPath, [shim, 'scenario', 'prepare', next, '--json'], { cwd: scratch, env: environment, encoding: 'utf8', timeout: 10_000 });
  assert.equal(premature.status, 98);
  assert.equal(premature.stdout, '');
  const preparedA = spawnSync(process.execPath, [shim, 'scenario', 'prepare', accepted, '--json'], { cwd: scratch, env: environment, encoding: 'utf8', timeout: 10_000 });
  assert.equal(preparedA.status, 0, preparedA.stderr);
  const checkpoint = spawnSync(process.execPath, [shim, 'scenario', 'prepare', next, '--json'], { cwd: scratch, env: environment, encoding: 'utf8', timeout: 10_000 });

  assert.equal(checkpoint.status, 97, checkpoint.stderr);
  const stop = JSON.parse(checkpoint.stdout);
  assert.equal(stop.type, 'assignment-checkpoint');
  assert.equal(stop.completedAssignment, accepted);
  assert.equal(stop.assignment, next);
  assert.equal(stop.scenario, 'freeze-source-boundary@1');
  assert.deepEqual(JSON.parse(await readFile(stop.packetPath, 'utf8')).repository, nextRepository);

  const later = '77777777-7777-4777-8777-777777777777';
  const secondCheckpoint = spawnSync(process.execPath, [shim, 'scenario', 'prepare', later, '--json'], { cwd: scratch, env: environment, encoding: 'utf8', timeout: 10_000 });
  assert.equal(secondCheckpoint.status, 98);
  assert.equal(secondCheckpoint.stdout, '');
  await assert.rejects(readFile(path.join(stopDirectory, `${later}.json`)), { code: 'ENOENT' });
});

test('shim rejects malformed successful prepare packets as typed command-contract failures', async t => {
  const requested = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const valid = {
    contract: 'mdlm-assignment-packet@2', command: 'scenario.prepare', ok: true,
    assignment: { id: requested },
    package: { reference: 'pkg@1', digest: `sha256:${'1'.repeat(64)}`, language: 'lang@1' },
    repository: { head: 'a'.repeat(40), trackedState: `sha256:${'2'.repeat(64)}` },
    scenario: { reference: 'execute-verification-run@1' }, responseSchema: {}, exactInputs: [],
  };
  const cases = [
    ['missing responseSchema', packet => { delete packet.responseSchema; }],
    ['wrong Assignment', packet => { packet.assignment.id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; }],
    ['wrong package fingerprint', packet => { packet.package.reference = 'other-package@1'; }],
    ['wrong repository fingerprint', packet => { packet.repository.head = 'b'.repeat(40); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-demo-shim-contract-'));
    const real = path.join(scratch, 'mdlm');
    await writeFile(real, '#!/usr/bin/env node\nprocess.stdout.write(process.env.PACKET);\n');
    await chmod(real, 0o755);
    const config = path.join(scratch, 'config.json');
    const stopDirectory = path.join(scratch, 'stops');
    await writeFile(config, JSON.stringify({
      contract: 'mdlm-demo-shim-config@1', realMdlm: real, allowedAssignment: requested,
      package: valid.package, repository: valid.repository, stopDirectory, timeoutMs: 5_000,
    }));
    const packet = structuredClone(valid);
    mutate(packet);
    const result = spawnSync(process.execPath, [shim, 'scenario', 'prepare', requested, '--json'], {
      cwd: scratch,
      env: { ...process.env, MDLM_DEMO_SHIM_CONFIG: config, PACKET: JSON.stringify(packet) },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 98);
    assert.equal(result.stdout, '');
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.contract, 'mdlm-demo-shim-error@1');
    assert.equal(failure.type, 'command-contract-failure');
    assert.equal(failure.command, 'scenario.prepare');
  });
});
