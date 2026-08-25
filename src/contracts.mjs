import { isDeepStrictEqual } from 'node:util';

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireNonemptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`);
}

function validateProcessPackage(value) {
  const packageIdentity = requireObject(value, 'scenario prepare package');
  requireNonemptyString(packageIdentity.reference, 'scenario prepare package.reference');
  if (!/^sha256:[0-9a-f]{64}$/.test(packageIdentity.digest ?? '')) throw new Error('scenario prepare package.digest is invalid');
  requireNonemptyString(packageIdentity.language, 'scenario prepare package.language');
}

function validateRepositoryFingerprint(value) {
  const repository = requireObject(value, 'scenario prepare repository');
  if (!/^[0-9a-f]{40,64}$/.test(repository.head ?? '')) throw new Error('scenario prepare repository.head is invalid');
  if (!/^sha256:[0-9a-f]{64}$/.test(repository.trackedState ?? '')) throw new Error('scenario prepare repository.trackedState is invalid');
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
  validateProcessPackage(packet.package);
  validateRepositoryFingerprint(packet.repository);
  if (expectedValues.package !== undefined && !isDeepStrictEqual(packet.package, expectedValues.package)) {
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
