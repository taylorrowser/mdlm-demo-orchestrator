import { isDeepStrictEqual } from 'node:util';
import { normalizeProcessPackage, sameProcessPackageIdentity } from './process-package.mjs';

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireNonemptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`);
}

function validateRepositoryFingerprint(value) {
  const repository = requireObject(value, 'scenario prepare repository');
  if (!/^[0-9a-f]{40,64}$/.test(repository.head ?? '')) throw new Error('scenario prepare repository.head is invalid');
  if (!/^sha256:[0-9a-f]{64}$/.test(repository.trackedState ?? '')) throw new Error('scenario prepare repository.trackedState is invalid');
}

function requireNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer`);
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is unsupported`);
  }
}

function validateDoctorPackage(value) {
  const packageIdentity = requireObject(value, 'doctor.package');
  rejectUnknownKeys(packageIdentity, new Set(['id', 'version', 'reference', 'language', 'digest']), 'doctor.package');
  requireNonemptyString(packageIdentity.id, 'doctor.package.id');
  requireNonemptyString(packageIdentity.version, 'doctor.package.version');
  normalizeProcessPackage(packageIdentity, 'doctor.package');
}

function validateDoctorDiagnostics(value) {
  if (!Array.isArray(value)) throw new Error('doctor.diagnostics must be an array');
  const allowed = new Set(['code', 'message', 'path', 'line', 'column', 'source']);
  for (const [index, diagnosticValue] of value.entries()) {
    const diagnostic = requireObject(diagnosticValue, `doctor.diagnostics[${index}]`);
    for (const key of Object.keys(diagnostic)) {
      if (!allowed.has(key)) throw new Error(`doctor.diagnostics[${index}].${key} is unsupported`);
    }
    requireNonemptyString(diagnostic.code, `doctor.diagnostics[${index}].code`);
    requireNonemptyString(diagnostic.message, `doctor.diagnostics[${index}].message`);
    for (const key of ['path', 'source']) {
      if (diagnostic[key] !== undefined) requireNonemptyString(diagnostic[key], `doctor.diagnostics[${index}].${key}`);
    }
    for (const key of ['line', 'column']) {
      if (diagnostic[key] !== undefined) requirePositiveInteger(diagnostic[key], `doctor.diagnostics[${index}].${key}`);
    }
  }
}

function validateProjectionSummary(value, name, expectedPath) {
  const projection = requireObject(value, `doctor.${name}`);
  rejectUnknownKeys(projection, new Set(['rebuilt', 'data', 'path']), `doctor.${name}`);
  if (typeof projection.rebuilt !== 'boolean') throw new Error(`doctor.${name}.rebuilt must be boolean`);
  requireNonnegativeInteger(projection.data, `doctor.${name}.data`);
  if (projection.path !== expectedPath) throw new Error(`doctor.${name}.path must equal '${expectedPath}'`);
}

export function validateDoctor(value) {
  const result = requireObject(value, 'doctor');
  if (result.command !== 'doctor') throw new Error("doctor.command must equal 'doctor'");
  if (typeof result.ok !== 'boolean') throw new Error('doctor.ok must be boolean');
  validateDoctorDiagnostics(result.diagnostics);
  if (!result.ok) {
    rejectUnknownKeys(result, new Set(['ok', 'command', 'selected', 'package', 'diagnostics']), 'doctor');
    if (typeof result.selected !== 'boolean') throw new Error('doctor.selected must be boolean when doctor.ok is false');
    if (result.diagnostics.length === 0) throw new Error('doctor.diagnostics must not be empty when doctor.ok is false');
    if (!result.selected && result.package !== undefined) throw new Error('doctor.package is unsupported when doctor.selected is false');
    if (result.selected && result.package === undefined) throw new Error('doctor.package is required when doctor.selected is true');
    if (result.package !== undefined) validateDoctorPackage(result.package);
    return result;
  }
  rejectUnknownKeys(result, new Set(['ok', 'command', 'package', 'baselineRepositoryVerification', 'index', 'report', 'diagnostics']), 'doctor');
  if (result.diagnostics.length !== 0) throw new Error('doctor.diagnostics must be empty when doctor.ok is true');
  validateDoctorPackage(result.package);
  const baseline = requireObject(result.baselineRepositoryVerification, 'doctor.baselineRepositoryVerification');
  rejectUnknownKeys(baseline, new Set(['verifiedBaselines', 'processDrift']), 'doctor.baselineRepositoryVerification');
  requireNonnegativeInteger(baseline.verifiedBaselines, 'doctor.baselineRepositoryVerification.verifiedBaselines');
  requireNonnegativeInteger(baseline.processDrift, 'doctor.baselineRepositoryVerification.processDrift');
  if (baseline.processDrift > baseline.verifiedBaselines) {
    throw new Error('doctor.baselineRepositoryVerification.processDrift cannot exceed verifiedBaselines');
  }
  validateProjectionSummary(result.index, 'index', '.lifecycle/generated/indexes/data.json');
  validateProjectionSummary(result.report, 'report', '.lifecycle/generated/reports/lifecycle.json');
  return result;
}

export function validateScenarioPrepare(value, expected = {}) {
  const expectedValues = typeof expected === 'string' ? { assignmentId: expected } : expected;
  const packet = requireObject(value, 'scenario prepare result');
  if (packet.contract !== 'mdlm-assignment-packet@2') throw new Error("scenario prepare contract must equal 'mdlm-assignment-packet@2'");
  if (packet.command !== 'scenario.prepare') throw new Error("scenario prepare command must equal 'scenario.prepare'");
  if (packet.ok !== true) throw new Error('scenario prepare ok must equal true');
  const assignment = requireObject(packet.assignment, 'scenario prepare assignment');
  requireNonemptyString(assignment.id, 'scenario prepare assignment.id');
  if (typeof expectedValues.assignmentId === 'string' && assignment.id !== expectedValues.assignmentId) {
    throw new Error(`scenario prepare assignment.id does not match requested Assignment '${expectedValues.assignmentId}'`);
  }
  normalizeProcessPackage(packet.package, 'scenario prepare package');
  validateRepositoryFingerprint(packet.repository);
  if (expectedValues.package !== undefined && !sameProcessPackageIdentity(packet.package, expectedValues.package)) {
    throw new Error('scenario prepare package fingerprint differs from the expected Assignment');
  }
  if (expectedValues.repository !== undefined && !isDeepStrictEqual(packet.repository, expectedValues.repository)) {
    throw new Error('scenario prepare repository fingerprint differs from the expected Assignment');
  }
  const scenario = requireObject(packet.scenario, 'scenario prepare scenario');
  requireNonemptyString(scenario.reference, 'scenario prepare scenario.reference');
  requireObject(packet.responseSchema, 'scenario prepare responseSchema');
  if (!Array.isArray(packet.exactInputs) || packet.exactInputs.some(input => !input || typeof input !== 'object' || Array.isArray(input))) {
    throw new Error('scenario prepare exactInputs must be an array of objects');
  }
  return packet;
}
