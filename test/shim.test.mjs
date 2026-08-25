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
  await writeFile(real, `#!/usr/bin/env node\nconsole.log(JSON.stringify({contract:'mdlm-assignment-packet@2',ok:true,command:'scenario.prepare',assignment:{id:'${assignment}'},package:{},repository:{},scenario:{reference:'execute-verification-run@1'},exactInputs:[]}));\n`);
  await chmod(real, 0o755);
  const config = path.join(scratch, 'config.json');
  const stopDirectory = path.join(scratch, 'stops');
  await writeFile(config, JSON.stringify({ contract: 'mdlm-demo-shim-config@1', realMdlm: real, allowedAssignment: assignment, stopDirectory, timeoutMs: 5_000 }));
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
  await writeFile(real, `#!/usr/bin/env node\nconst id=process.argv[4]; console.log(JSON.stringify({contract:'mdlm-assignment-packet@2',ok:true,command:'scenario.prepare',assignment:{id},package:{},repository:{},scenario:{reference:'execute-verification-run@1'},responseSchema:{},exactInputs:[]}));\n`);
  await chmod(real, 0o755);
  const config = path.join(scratch, 'config.json');
  await writeFile(config, JSON.stringify({ contract: 'mdlm-demo-shim-config@1', realMdlm: real, allowedAssignment: accepted, stopDirectory: path.join(scratch, 'stops'), timeoutMs: 5_000 }));
  const result = spawnSync(process.execPath, [shim, 'scenario', 'prepare', external, '--json'], { cwd: scratch, env: { ...process.env, MDLM_DEMO_SHIM_CONFIG: config }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 97);
  const stop = JSON.parse(result.stdout);
  assert.equal(stop.type, 'accepted-assignment-then-external');
  assert.equal(stop.completedAssignment, accepted);
  assert.equal(stop.assignment, external);
  assert.equal(stop.scenario, 'execute-verification-run@1');
});
