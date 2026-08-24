const recoverableSignals = new Set([
  'attended-answer',
  'attended-review-correction',
  'clean-interrupted-command',
  'adapter-failure-before-submission',
  'correction-session-lost',
]);

export function classify(input) {
  requireContract(input, 'mdlm-demo-classification-input@1');
  const assignment = object(input.assignment, 'assignment');
  const reason = nonrecoverableReason(input);
  if (reason !== null) return decision(false, nonrecoverableAction(reason), reason, assignment);
  if (!recoverableSignals.has(input.signal)) {
    return decision(false, 'stop-for-operator-classification', 'unrecognized-stop-signal', assignment);
  }
  if (input.signal === 'correction-session-lost' && !validCorrectionContext(input.correction)) {
    return decision(false, 'stop-without-restart', 'correction-context-lost', assignment);
  }
  return decision(true, 'continue-same-assignment', input.signal, assignment);
}

function nonrecoverableAction(reason) {
  if (reason.startsWith('outcome-')) return 'record-terminal-outcome';
  if (reason === 'uncertain-partial-publication') return 'stop-for-evidence';
  return 'quarantine-and-stop';
}

function validCorrectionContext(value) {
  return value && typeof value === 'object' &&
    /^sha256:[0-9a-f]{64}$/.test(value.previousResponseDigest ?? '') &&
    /^sha256:[0-9a-f]{64}$/.test(value.diagnosticsDigest ?? '');
}

function nonrecoverableReason(input) {
  if (input.integrity?.doctorOk !== true || input.integrity?.snapshotOk !== true) return 'integrity-drift';
  if (input.repository?.clean !== true) return 'repository-dirty-or-uncertain';
  if (input.repository?.fingerprintMatches !== true) return 'repository-drift';
  if (input.package?.fingerprintMatches !== true) return 'package-drift';
  if (input.artifacts?.fingerprintMatches !== true) return 'artifact-drift';
  if (input.provenance?.valid !== true) return 'provenance-violation';
  if (input.publication?.state === 'uncertain') return 'uncertain-partial-publication';
  if (['abandoned', 'exhausted', 'stale', 'malformed'].includes(input.assignment?.disposition)) {
    return `assignment-${input.assignment.disposition}`;
  }
  if (['lifecycle-complete', 'profile-boundary-reached', 'process-dead-end', 'invalid', 'terminal', 'abandoned'].includes(input.outcome)) {
    return `outcome-${input.outcome}`;
  }
  if (input.assignment?.disposition !== 'active') return 'assignment-not-active';
  return null;
}

function decision(recoverable, action, reason, assignment) {
  return {
    contract: 'mdlm-demo-classification@1',
    recoverable,
    action,
    reason,
    ...(typeof assignment.id === 'string' ? { assignment: { id: assignment.id } } : {}),
  };
}

function requireContract(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.contract !== expected) {
    throw new Error(`expected ${expected}`);
  }
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}
