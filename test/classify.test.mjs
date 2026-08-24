import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin/mdlm-demo-runner.mjs');

function invoke(command, input) {
  const result = spawnSync(process.execPath, [cli, command], {
    cwd: root,
    input: `${JSON.stringify(input)}\n`,
    encoding: 'utf8',
    timeout: 5_000,
  });
  return { ...result, output: result.stdout ? JSON.parse(result.stdout) : null };
}

function healthy(signal) {
  return {
    contract: 'mdlm-demo-classification-input@1',
    signal,
    integrity: { doctorOk: true, snapshotOk: true },
    repository: { clean: true, fingerprintMatches: true },
    package: { fingerprintMatches: true },
    artifacts: { fingerprintMatches: true },
    provenance: { valid: true },
    assignment: { id: 'assignment-1', disposition: 'active' },
    publication: { state: 'none' },
    outcome: 'assignment',
  };
}

test('classify keeps an attended Review correction in the active Assignment', () => {
  const result = invoke('classify', healthy('attended-review-correction'));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.output, {
    contract: 'mdlm-demo-classification@1',
    recoverable: true,
    action: 'continue-same-assignment',
    reason: 'attended-review-correction',
    assignment: { id: 'assignment-1' },
  });
});

test('classify accepts only named recoverable stops at matching healthy boundaries', () => {
  for (const signal of ['attended-answer', 'clean-interrupted-command', 'adapter-failure-before-submission']) {
    const result = invoke('classify', healthy(signal));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.recoverable, true, signal);
  }
});

test('classify rejects malformed, exhausted, uncertain, drifted, terminal, and provenance-invalid states', () => {
  const cases = [
    [value => { value.assignment.disposition = 'malformed'; }, 'assignment-malformed'],
    [value => { value.assignment.disposition = 'exhausted'; }, 'assignment-exhausted'],
    [value => { value.publication.state = 'uncertain'; }, 'uncertain-partial-publication'],
    [value => { value.repository.fingerprintMatches = false; }, 'repository-drift'],
    [value => { value.package.fingerprintMatches = false; }, 'package-drift'],
    [value => { value.artifacts.fingerprintMatches = false; }, 'artifact-drift'],
    [value => { value.provenance.valid = false; }, 'provenance-violation'],
    [value => { value.outcome = 'lifecycle-complete'; }, 'outcome-lifecycle-complete'],
    [value => { value.assignment.disposition = 'abandoned'; }, 'assignment-abandoned'],
  ];
  for (const [mutate, reason] of cases) {
    const input = healthy('attended-answer');
    mutate(input);
    const result = invoke('classify', input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.recoverable, false, reason);
    assert.equal(result.output.reason, reason);
  }
  const terminal = healthy('attended-answer');
  terminal.outcome = 'lifecycle-complete';
  assert.equal(invoke('classify', terminal).output.action, 'record-terminal-outcome');
  const uncertain = healthy('attended-answer');
  uncertain.publication.state = 'uncertain';
  assert.equal(invoke('classify', uncertain).output.action, 'stop-for-evidence');
});

test('a lost correction session resumes only with durable correction context', () => {
  const missing = invoke('classify', healthy('correction-session-lost'));
  assert.equal(missing.output.recoverable, false);
  assert.equal(missing.output.reason, 'correction-context-lost');

  const input = healthy('correction-session-lost');
  input.correction = {
    authenticJournal: true,
    controllerResumeSupported: false,
    previousResponseDigest: `sha256:${'a'.repeat(64)}`,
    diagnostics: [],
  };
  const unsupported = invoke('classify', input);
  assert.equal(unsupported.output.recoverable, false);
  assert.equal(unsupported.output.reason, 'correction-session-unresumable');

  input.correction.controllerResumeSupported = true;
  const retained = invoke('classify', input);
  assert.equal(retained.output.recoverable, true);
  assert.equal(retained.output.action, 'resume-controller-journal');
});
