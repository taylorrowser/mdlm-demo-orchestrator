import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProcessPackage, sameProcessPackageIdentity } from '../src/process-package.mjs';

const identity = {
  reference: 'mdlm-bootstrap@0.74.0',
  digest: 'sha256:ee99e698d36e406a836a796a36fc1db2d2451072ad662c0e06805ab5c20fe5ac',
  language: 'mdlm-expression@1',
};
const richIdentity = { id: 'mdlm-bootstrap', version: '0.74.0', ...identity };

test('Process Package identity normalization retains only normative identity fields', () => {
  assert.deepEqual(normalizeProcessPackage(richIdentity), identity);
  assert.equal(sameProcessPackageIdentity(richIdentity, identity), true);
});

test('Process Package identity rejects normative drift', () => {
  for (const [field, value] of [
    ['reference', 'other-package@0.74.0'],
    ['digest', `sha256:${'0'.repeat(64)}`],
    ['language', 'other-language@1'],
  ]) {
    assert.equal(sameProcessPackageIdentity(identity, { ...identity, [field]: value }), false, field);
  }
});

test('Process Package identity rejects inconsistent optional id and version fields', () => {
  for (const inconsistent of [
    { ...richIdentity, id: 'other-package' },
    { ...richIdentity, version: '0.75.0' },
    { ...identity, id: 'mdlm-bootstrap' },
    { ...identity, version: '0.74.0' },
  ]) {
    assert.throws(() => normalizeProcessPackage(inconsistent));
    assert.equal(sameProcessPackageIdentity(inconsistent, identity), false);
  }
});
