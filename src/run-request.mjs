import path from 'node:path';

const outerTimeoutSafetyReserveMs = 60_000;
const operatorScalarPattern = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,255}$/;
const thinkingLevels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const signals = new Set([
  'adapter-failure-before-submission',
  'attended-answer',
  'attended-review-correction',
  'clean-interrupted-command',
  'correction-session-lost',
  'reserved-shim-stop',
]);
const topLevelKeys = new Set([
  'adapterInputsPath', 'assignmentId', 'checkpointRecovery', 'commands', 'contract', 'correctionContinuation',
  'decisionCatalogPath', 'evidenceDirectory', 'harness', 'materializedNextRecovery', 'mdlmPiAssignmentTimeoutMs',
  'mdlmPiCommandTimeoutMs', 'operationalFailureRecovery', 'operator', 'orphanedCheckpointRecovery', 'provenance',
  'repository', 'signal', 'stateDirectory', 'timeoutMs',
]);

export function validateRunRequest(value) {
  assertUnicodeScalars(value, 'run request');
  requireObject(value, 'run request');
  for (const key of Object.keys(value)) {
    if (!topLevelKeys.has(key)) throw new Error(`run request.${key} is unsupported`);
  }
  if (value.contract !== 'mdlm-demo-run-request@1' && value.contract !== 'mdlm-demo-resume-request@1') {
    throw new Error('run request.contract must be mdlm-demo-run-request@1 or mdlm-demo-resume-request@1');
  }
  for (const name of ['repository', 'stateDirectory', 'evidenceDirectory']) requireAbsolutePath(value[name], name);
  if (value.adapterInputsPath !== undefined) requireAbsolutePath(value.adapterInputsPath, 'adapterInputsPath');
  if (value.decisionCatalogPath !== undefined) requireAbsolutePath(value.decisionCatalogPath, 'decisionCatalogPath');
  requireString(value.assignmentId, 'assignmentId', 4096);
  if (!signals.has(value.signal)) throw new Error(`signal must be one of ${[...signals].join(', ')}`);

  requirePositiveSafeInteger(value.timeoutMs, 'timeoutMs');
  if (value.timeoutMs > 900_000) throw new Error('timeoutMs must not exceed 900000');
  for (const name of ['mdlmPiCommandTimeoutMs', 'mdlmPiAssignmentTimeoutMs']) {
    requirePositiveSafeInteger(value[name], name);
    if (value[name] > value.timeoutMs - outerTimeoutSafetyReserveMs) {
      throw new Error(`${name} must leave at least ${outerTimeoutSafetyReserveMs}ms safety reserve below timeoutMs`);
    }
  }

  validateOperator(value.operator);
  exactObject(value.commands, ['mdlm', 'mdlmPi'], 'commands');
  requireAbsolutePath(value.commands.mdlm, 'commands.mdlm');
  requireAbsolutePath(value.commands.mdlmPi, 'commands.mdlmPi');
  if (value.harness !== undefined) validateHarness(value.harness);
  validateProvenance(value.provenance);

  if (value.correctionContinuation !== undefined) validatePathDigest(value.correctionContinuation, 'correctionContinuation', 'responsePath');
  if (value.checkpointRecovery !== undefined) validatePathDigest(value.checkpointRecovery, 'checkpointRecovery', 'snapshotDirectory');
  if (value.materializedNextRecovery !== undefined) validateMaterializedNextRecovery(value.materializedNextRecovery);
  if (value.orphanedCheckpointRecovery !== undefined) validateOrphanedCheckpointRecovery(value.orphanedCheckpointRecovery);
  if (value.operationalFailureRecovery !== undefined) validateOperationalFailureRecovery(value.operationalFailureRecovery);
  return value;
}

export function validateOperator(value) {
  exactObject(value, ['model', 'provider', 'thinking'], 'operator');
  for (const name of ['provider', 'model']) {
    if (typeof value[name] !== 'string' || !operatorScalarPattern.test(value[name])) {
      throw new Error(`operator.${name} must be a safe nonempty scalar string`);
    }
  }
  if (typeof value.thinking !== 'string' || !thinkingLevels.has(value.thinking)) {
    throw new Error(`operator.thinking must be one of ${[...thinkingLevels].join(', ')}`);
  }
}

function validateHarness(value) {
  exactObject(value, ['commit', 'directory', 'repositoryLocator', 'tree'], 'harness');
  requireAbsolutePath(value.directory, 'harness.directory');
  requireObjectId(value.commit, 'harness.commit');
  requireObjectId(value.tree, 'harness.tree');
  requireString(value.repositoryLocator, 'harness.repositoryLocator', 4096);
}

function validateProvenance(value) {
  const keys = ['package', 'piPackage', 'qualificationHarness', 'source', 'tooling', 'tools'];
  if (value?.git !== undefined) keys.push('git');
  exactObject(value, keys, 'provenance');
  validateGitPin(value.source, 'provenance.source');
  validateArtifactPin(value.package, 'provenance.package');
  validateArtifactPin(value.piPackage, 'provenance.piPackage');
  if (value.git !== undefined) validatePathPin(value.git, 'provenance.git');

  exactObject(value.tooling, ['digest', 'lock', 'root'], 'provenance.tooling');
  requireAbsolutePath(value.tooling.root, 'provenance.tooling.root');
  requireDigest(value.tooling.digest, 'provenance.tooling.digest');
  validatePathPin(value.tooling.lock, 'provenance.tooling.lock');

  exactObject(value.tools, ['mdlm', 'mdlmPi'], 'provenance.tools');
  validatePathPin(value.tools.mdlm, 'provenance.tools.mdlm');
  validatePathPin(value.tools.mdlmPi, 'provenance.tools.mdlmPi');

  exactObject(
    value.qualificationHarness,
    ['commit', 'manifest', 'repository', 'repositoryLocator', 'tree'],
    'provenance.qualificationHarness',
  );
  validateGitPin(value.qualificationHarness, 'provenance.qualificationHarness', true);
  requireString(value.qualificationHarness.repositoryLocator, 'provenance.qualificationHarness.repositoryLocator', 4096);
  validatePathPin(value.qualificationHarness.manifest, 'provenance.qualificationHarness.manifest');
}

function validateGitPin(value, label, locator = false) {
  exactObject(value, locator ? ['commit', 'manifest', 'repository', 'repositoryLocator', 'tree'] : ['commit', 'repository', 'tree'], label);
  requireAbsolutePath(value.repository, `${label}.repository`);
  requireObjectId(value.commit, `${label}.commit`);
  requireObjectId(value.tree, `${label}.tree`);
}

function validateArtifactPin(value, label) {
  exactObject(value, ['artifact', 'digest'], label);
  requireAbsolutePath(value.artifact, `${label}.artifact`);
  requireDigest(value.digest, `${label}.digest`);
}

function validatePathPin(value, label) {
  exactObject(value, ['digest', 'path'], label);
  requireAbsolutePath(value.path, `${label}.path`);
  requireDigest(value.digest, `${label}.digest`);
}

function validatePathDigest(value, label, pathName) {
  exactObject(value, ['digest', pathName], label);
  requireAbsolutePath(value[pathName], `${label}.${pathName}`);
  requireDigest(value.digest, `${label}.digest`);
}

function validateMaterializedNextRecovery(value) {
  exactObject(value, ['acceptedResult', 'finalSnapshot', 'nextExit', 'nextStderr', 'nextStdout', 'oldSnapshot'], 'materializedNextRecovery');
  for (const name of ['acceptedResult', 'nextStdout', 'nextStderr', 'nextExit']) validatePathPin(value[name], `materializedNextRecovery.${name}`);
  for (const name of ['oldSnapshot', 'finalSnapshot']) validateDirectoryPin(value[name], `materializedNextRecovery.${name}`);
}

function validateOrphanedCheckpointRecovery(value) {
  const keys = [
    'assignmentCheckpoint', 'initialSnapshotDigest', 'initialSnapshotDirectory', 'postSnapshotDigest',
    'postSnapshotDirectory', 'prepare', 'processedAssignment', 'retryTransition', 'shimConfig', 'stopPacket',
  ];
  exactObject(value, keys, 'orphanedCheckpointRecovery');
  for (const name of ['initialSnapshotDirectory', 'postSnapshotDirectory']) requireAbsolutePath(value[name], `orphanedCheckpointRecovery.${name}`);
  for (const name of ['initialSnapshotDigest', 'postSnapshotDigest']) requireDigest(value[name], `orphanedCheckpointRecovery.${name}`);
  for (const name of ['retryTransition', 'shimConfig', 'processedAssignment', 'assignmentCheckpoint', 'stopPacket']) {
    validatePathPin(value[name], `orphanedCheckpointRecovery.${name}`);
  }
  exactObject(value.prepare, ['record', 'stderr', 'stdout'], 'orphanedCheckpointRecovery.prepare');
  for (const name of ['record', 'stdout', 'stderr']) validatePathPin(value.prepare[name], `orphanedCheckpointRecovery.prepare.${name}`);
}

function validateOperationalFailureRecovery(value) {
  const keys = [
    'initialSnapshotDigest', 'initialSnapshotDirectory', 'postSnapshotDigest',
    'postSnapshotDirectory', 'resultDigest', 'resultPath',
  ];
  exactObject(value, keys, 'operationalFailureRecovery');
  for (const name of ['resultPath', 'initialSnapshotDirectory', 'postSnapshotDirectory']) {
    requireAbsolutePath(value[name], `operationalFailureRecovery.${name}`);
  }
  for (const name of ['resultDigest', 'initialSnapshotDigest', 'postSnapshotDigest']) {
    requireDigest(value[name], `operationalFailureRecovery.${name}`);
  }
}

function validateDirectoryPin(value, label) {
  exactObject(value, ['digest', 'directory'], label);
  requireAbsolutePath(value.directory, `${label}.directory`);
  requireDigest(value.digest, `${label}.digest`);
}

function exactObject(value, keys, label) {
  requireObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly ${expected.join(', ')}`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function requireString(value, label, maxBytes) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`);
  if (!value.isWellFormed()) throw new Error(`${label} must contain only Unicode scalar values`);
  if (Buffer.byteLength(value) > maxBytes) throw new Error(`${label} exceeds ${maxBytes}-byte limit`);
}

function requireAbsolutePath(value, label) {
  requireString(value, label, 4096);
  if (value.includes('\0')) throw new Error(`${label} must not contain NUL`);
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
}

function requireDigest(value, label) {
  if (!/^sha256:[0-9a-f]{64}$/.test(value ?? '')) throw new Error(`${label} must be sha256:<64 lowercase hex>`);
}

function requireObjectId(value, label) {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value ?? '')) throw new Error(`${label} must be a 40- or 64-character lowercase hexadecimal object ID`);
}

function requirePositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
}

function assertUnicodeScalars(value, label, seen = new WeakSet()) {
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new Error(`${label} contains an unpaired UTF-16 value instead of Unicode scalar values`);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`${label} must not contain cycles`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (!key.isWellFormed()) throw new Error(`${label} contains an unpaired UTF-16 object key`);
    assertUnicodeScalars(child, `${label}.${key}`, seen);
  }
  seen.delete(value);
}
