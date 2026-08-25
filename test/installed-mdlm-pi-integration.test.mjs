import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const installed = '/home/ubuntu/git/mdlm-successor-demos/.tooling-issue-214/node_modules/mdlm-pi/dist';
const { RunController } = await import(`${installed}/run-controller.js`);
const { RunJournal } = await import(`${installed}/run-journal.js`);
const { PiAssignmentRunner } = await import(`${installed}/pi-assignment-runner.js`);

const assignmentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const executionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const scenario = 'review-correction@1';
const packageIdentity = { reference: 'pkg@1', digest: `sha256:${'1'.repeat(64)}`, language: 'lang@1' };
const repositoryIdentity = { head: 'base-commit', trackedState: `sha256:${'2'.repeat(64)}` };

function prepared(response) {
  const source = `${JSON.stringify(response)}\n`;
  return { response, source, digest: `sha256:${createHash('sha256').update(source).digest('hex')}` };
}

test('installed mdlm-pi consumes attended Review-correction wording in the same Assignment without replaying accepted Scenarios', async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'mdlm-demo-installed-controller-'));
  const wording = 'Preserve the accepted Scenario evidence and revise only the Review finding.';
  const authorityRequirement = { mode: 'attended', authority: 'stakeholder', delegationAllowed: false };
  const attendedOutcome = {
    outcome: 'attention-required',
    assignment: { allocation: 'active', id: assignmentId },
    authorityRequirement,
    attentionContext: { question: 'What exact Review correction is authorized?' },
  };
  const statuses = [
    { contract: 'mdlm-status@1', command: 'status', ok: true, package: packageIdentity, currentOutcome: attendedOutcome, recentTransaction: { available: false } },
    { contract: 'mdlm-status@1', command: 'status', ok: true, package: packageIdentity, currentOutcome: attendedOutcome, recentTransaction: { available: false } },
    { contract: 'mdlm-status@1', command: 'status', ok: true, package: packageIdentity, currentOutcome: { outcome: 'lifecycle-complete' }, recentTransaction: { available: true, id: executionId } },
  ];
  const packet = {
    contract: 'mdlm-assignment-packet@2', command: 'scenario.prepare', ok: true,
    assignment: { id: assignmentId }, package: packageIdentity, repository: repositoryIdentity,
    scenario: { reference: scenario }, responseSchema: {}, exactInputs: [],
  };
  const prompts = [];
  const modelResponses = [];
  const assignments = new PiAssignmentRunner({
    repository,
    assignmentTimeoutMs: 1_000,
    sessionFactory: async (_packet, capture) => ({
      get isIdle() { return true; },
      async prompt(prompt) {
        prompts.push(prompt);
        assert.match(prompt, new RegExp(wording.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        const response = {
          contract: 'mdlm-assignment-response@1', assignment: assignmentId, kind: 'proposal',
          proposal: { outputs: [], completionEvidence: { authorizedCorrection: wording }, loadedSkillRefs: [], authoritySupplies: [], standingDelegations: [] },
        };
        modelResponses.push(response);
        capture(response);
      },
      async abort() {}, dispose() {}, subscribe() { return () => {}; },
    }),
  });
  const submitted = [];
  const mdlm = {
    async status() { return statuses.shift(); },
    async next() { throw new Error('accepted Scenarios must not be replayed'); },
    async assignment(id) {
      assert.equal(id, assignmentId);
      return { contract: 'mdlm-assignment-state@1', command: 'assignment.show', ok: true, assignment: { id }, selected: true, package: packageIdentity, repository: repositoryIdentity, scenarioReference: scenario, disposition: 'active', retryAvailability: { malformedResponseCorrection: 1 }, malformedResponses: [] };
    },
    async prepare(id) { assert.equal(id, assignmentId); return packet; },
    prepareSubmission: prepared,
    async submit(value) {
      submitted.push(value.response);
      return {
        contract: 'mdlm-scenario-execution@4', command: 'scenario.submit', ok: true,
        execution: { contract: 'mdlm-scenario-execution@4', id: executionId, status: 'completed', definition: { scenario }, response: { assignment: assignmentId, digest: value.digest }, outputs: [] },
      };
    },
    async execution() { throw new Error('no recovery execution lookup expected'); },
    async doctor() { return { command: 'doctor', ok: true }; },
  };
  let attentionCalls = 0;
  const io = {
    progress() {}, stopped() {},
    async attention(outcome) {
      attentionCalls += 1;
      assert.deepEqual(outcome, { ...attendedOutcome, package: packageIdentity });
      return { conclusion: { statement: wording } };
    },
  };
  let prepareCalls = 0;
  const originalPrepare = mdlm.prepare;
  mdlm.prepare = async id => { prepareCalls += 1; return originalPrepare(id); };
  let nextCalls = 0;
  const originalNext = mdlm.next;
  mdlm.next = async () => { nextCalls += 1; return originalNext(); };
  const git = {
    async assertClean() {}, async head() { return repositoryIdentity.head; },
    async repositoryFingerprint() { return repositoryIdentity; },
    async capturePublication(publication) { return { ...publication, blobs: [] }; },
    async commit() { return 'publication-commit'; },
    async publicationCommitState() { throw new Error('not expected'); },
    async pendingTransactionIds() { return []; },
  };

  const result = await new RunController({
    mdlm, assignments, io, git, journal: new RunJournal(path.join(repository, 'state')),
  }).run();

  assert.equal(result.status, 'lifecycle-complete');
  assert.equal(attentionCalls, 1);
  assert.equal(prepareCalls, 1);
  assert.equal(nextCalls, 0);
  assert.equal(prompts.length, 1);
  assert.equal(modelResponses.length, 1);
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0].proposal.authoritySupplies, ['stakeholder']);
  assert.equal(submitted[0].proposal.completionEvidence.authorizedCorrection, wording);
});

test('installed controller serializes accepted A publication before it prepares external B', async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'mdlm-demo-installed-boundary-'));
  const externalId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const trace = [];
  const outcome = id => ({ outcome: 'assignment', assignment: { allocation: 'active', id } });
  const status = id => ({
    contract: 'mdlm-status@1', command: 'status', ok: true, package: packageIdentity,
    currentOutcome: outcome(id), recentTransaction: { available: false },
  });
  const statuses = [status(assignmentId), status(assignmentId), status(externalId)];
  const packet = (id, reference) => ({
    contract: 'mdlm-assignment-packet@2', command: 'scenario.prepare', ok: true,
    assignment: { id }, package: packageIdentity, repository: repositoryIdentity,
    scenario: { reference }, responseSchema: {}, exactInputs: [],
  });
  const response = {
    contract: 'mdlm-assignment-response@1', assignment: assignmentId, kind: 'proposal',
    proposal: { outputs: [], completionEvidence: {}, loadedSkillRefs: [], authoritySupplies: [], standingDelegations: [] },
  };
  const mdlm = {
    async status() { return statuses.shift(); }, async next() { throw new Error('not expected'); },
    async assignment(id) {
      return { assignment: { id }, selected: true, disposition: 'active', package: packageIdentity, repository: repositoryIdentity, scenarioReference: 'ordinary-a@1', malformedResponses: [] };
    },
    async prepare(id) {
      trace.push(`prepare:${id}`);
      return packet(id, id === assignmentId ? 'ordinary-a@1' : 'execute-verification-run@1');
    },
    prepareSubmission: prepared,
    async submit(value) {
      trace.push(`submit:${value.response.assignment}`);
      return {
        contract: 'mdlm-scenario-execution@4', command: 'scenario.submit', ok: true,
        execution: { contract: 'mdlm-scenario-execution@4', id: executionId, status: 'completed', definition: { scenario: 'ordinary-a@1' }, response: { assignment: assignmentId, digest: value.digest }, outputs: [] },
      };
    },
    async doctor() { return { ok: true }; },
  };
  const assignments = {
    async run(value) {
      trace.push(`worker:${value.assignment.id}`);
      if (value.assignment.id === externalId) throw new Error('external B intercepted before worker');
      return response;
    },
    async close() {},
  };
  const git = {
    async assertClean() {}, async head() { return repositoryIdentity.head; },
    async repositoryFingerprint() { return repositoryIdentity; },
    async capturePublication(publication) { trace.push(`capture:${publication.executionId}`); return { ...publication, blobs: [] }; },
    async commit() { trace.push(`commit:${assignmentId}`); return 'publication-commit'; },
    async pendingTransactionIds() { return []; },
  };
  const io = { progress() {}, stopped() {}, async attention() { throw new Error('not expected'); } };

  await assert.rejects(
    new RunController({ mdlm, assignments, io, git, journal: new RunJournal(path.join(repository, 'state')) }).run(),
    /external B intercepted before worker/,
  );
  assert.deepEqual(trace, [
    `prepare:${assignmentId}`, `worker:${assignmentId}`, `submit:${assignmentId}`,
    `capture:${executionId}`, `commit:${assignmentId}`, `prepare:${externalId}`, `worker:${externalId}`,
  ]);
});
