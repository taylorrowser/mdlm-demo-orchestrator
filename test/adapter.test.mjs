import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { adaptAssignment } from '../src/adapter.mjs';

const harness = '/home/ubuntu/git/mdlm-phase1-qualification-harness';
const harnessCommit = '79c87627aaf48ca3261a3476aa82c52524f3c938';

test('adapter generates and preflights the #215 environment proposal from packet exact inputs', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'issue-213-adapter-'));
  const packetPath = path.join(scratch, 'packet.json');
  const packet = {
    contract: 'mdlm-assignment-packet@2', ok: true, command: 'scenario.prepare',
    assignment: { id: '11111111-1111-4111-8111-111111111111' },
    package: { reference: 'pkg@1', digest: `sha256:${'1'.repeat(64)}`, language: 'lang@1' },
    repository: { head: 'a'.repeat(40), trackedState: `sha256:${'2'.repeat(64)}` },
    scenario: { reference: 'realize-verification-environment@1' },
    exactInputs: [{ inputs: [{ name: 'strategy', values: [{ data: {
      id: 'VSP-0123456789', revision: 1, revision_id: 'VSP-0123456789-r00001', type: 'VSP',
      payload: { environment_profile: { id: 'node24-cli', capabilities: { controllability: ['Run exact vectors.'], observability: ['Capture raw streams and status.'], external_services: [], timing: 'Finite deadlines.' } } },
    } }] }] }],
  };
  await writeFile(packetPath, `${JSON.stringify(packet)}\n`);
  const result = await adaptAssignment({
    packetPath,
    stateDirectory: path.join(scratch, 'state'),
    timeoutMs: 60_000,
    harness: {
      directory: harness,
      commit: harnessCommit,
      tree: 'e7311ce6e36df8df6fa840ea2df70ff00fe316c1',
      repositoryLocator: `file://${harness}`,
    },
  });
  assert.equal(result.kind, 'response', JSON.stringify(result));
  assert.match(result.digest, /^sha256:[0-9a-f]{64}$/);
  const response = JSON.parse(result.bytes.toString('utf8'));
  assert.equal(response.contract, 'mdlm-assignment-response@1');
  assert.equal(response.assignment, packet.assignment.id);
  assert.equal(response.proposal.outputs[0].lifecycleDatum.payload.strategy_revision, 'VSP-0123456789-r00001');
  assert.equal(result.preflight.ok, true);

  const repeated = await adaptAssignment({
    packetPath,
    stateDirectory: path.join(scratch, 'state'),
    timeoutMs: 60_000,
    harness: { directory: harness, commit: harnessCommit, tree: 'e7311ce6e36df8df6fa840ea2df70ff00fe316c1', repositoryLocator: `file://${harness}` },
  });
  assert.equal(repeated.kind, 'response');
  assert.deepEqual(repeated.bytes, await readFile(result.responsePath));
});

function externalPacket(assignment, scenario) {
  return {
    contract: 'mdlm-assignment-packet@2', ok: true, command: 'scenario.prepare',
    assignment: { id: assignment },
    package: { reference: 'pkg@1', digest: `sha256:${'1'.repeat(64)}`, language: 'lang@1' },
    repository: { head: 'a'.repeat(40), trackedState: `sha256:${'2'.repeat(64)}` },
    scenario: { reference: scenario }, exactInputs: [],
  };
}

test('product-specific adapters return exact supplied bytes and require matching observations', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'issue-213-observations-'));
  const assignment = '22222222-2222-4222-8222-222222222222';
  const scenario = 'register-pilot-target@1';
  const packetPath = path.join(scratch, 'packet.json');
  const responsePath = path.join(scratch, 'response.json');
  const observationsPath = path.join(scratch, 'observations.json');
  const inputsPath = path.join(scratch, 'inputs.json');
  await writeFile(packetPath, JSON.stringify(externalPacket(assignment, scenario)));
  const exactBytes = Buffer.from(`{\n  "contract":"mdlm-assignment-response@1",\n  "assignment":"${assignment}",\n  "kind":"proposal",\n  "proposal":{}\n}\n`);
  await writeFile(responsePath, exactBytes);
  await writeFile(observationsPath, JSON.stringify({ contract: 'mdlm-external-observations@1', assignment, scenario, product: { repository: 'https://example.invalid/product.git', commit: 'b'.repeat(40), tree: 'c'.repeat(40) } }));
  await writeFile(inputsPath, JSON.stringify({ contract: 'mdlm-external-adapter-inputs@1', scenarios: { [scenario]: { kind: 'exact-response', responsePath, observationsPath } } }));
  const result = await adaptAssignment({ packetPath, stateDirectory: path.join(scratch, 'state'), adapterInputsPath: inputsPath });
  assert.equal(result.kind, 'response');
  assert.deepEqual(result.bytes, exactBytes);

  const incompleteObservations = path.join(scratch, 'incomplete-observations.json');
  const otherState = path.join(scratch, 'other-state');
  await writeFile(incompleteObservations, JSON.stringify({ contract: 'mdlm-external-observations@1', assignment, scenario }));
  await writeFile(inputsPath, JSON.stringify({ contract: 'mdlm-external-adapter-inputs@1', scenarios: { [scenario]: { kind: 'exact-response', responsePath, observationsPath: incompleteObservations } } }));
  const rejected = await adaptAssignment({ packetPath, stateDirectory: otherState, adapterInputsPath: inputsPath });
  assert.equal(rejected.kind, 'stop');
  assert.equal(rejected.stop.reason, 'product-observations-invalid');
});

test('a pre-submission adapter failure can resume without changing the Assignment packet', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'issue-213-adapter-resume-'));
  const packetPath = path.join(scratch, 'packet.json');
  const packet = externalPacket('33333333-3333-4333-8333-333333333333', 'realize-verification-environment@1');
  packet.exactInputs = [{ values: [{ data: { type: 'VSP', revision_id: 'VSP-0123456789-r00001', payload: { environment_profile: { id: 'node24-cli', capabilities: { controllability: ['exact'], observability: ['raw'], external_services: [], timing: 'finite' } } } } }] }];
  await writeFile(packetPath, JSON.stringify(packet));
  const stateDirectory = path.join(scratch, 'state');
  const stopped = await adaptAssignment({ packetPath, stateDirectory, harness: { directory: scratch, commit: '0'.repeat(40), tree: '0'.repeat(40), repositoryLocator: `file://${scratch}` }, timeoutMs: 5_000 });
  assert.equal(stopped.kind, 'stop');
  assert.equal(stopped.stop.phase, 'before-submission');
  assert.equal(stopped.stop.reason, 'qualification-harness-provenance-failed');

  const resumed = await adaptAssignment({ packetPath, stateDirectory, harness: { directory: harness, commit: harnessCommit, tree: 'e7311ce6e36df8df6fa840ea2df70ff00fe316c1', repositoryLocator: `file://${harness}` }, timeoutMs: 60_000 });
  assert.equal(resumed.kind, 'response', JSON.stringify(resumed));
});
