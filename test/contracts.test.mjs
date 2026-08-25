import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateDoctor } from '../src/contracts.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const installedSuccess = JSON.parse(await readFile(
  path.join(root, 'test', 'fixtures', 'mdlm-doctor-0.74.0-success.json'),
  'utf8',
));

const diagnostic = { code: 'repository-contract', message: 'Repository contract is invalid' };

test('doctor validation accepts the installed 0.74.0 success output and documented failures', () => {
  assert.equal(validateDoctor(structuredClone(installedSuccess)).ok, true);
  assert.equal(validateDoctor({
    ok: false,
    command: 'doctor',
    selected: false,
    diagnostics: [diagnostic],
  }).ok, false);
  assert.equal(validateDoctor({
    ok: false,
    command: 'doctor',
    selected: true,
    package: structuredClone(installedSuccess.package),
    diagnostics: [{
      ...diagnostic,
      path: '.lifecycle/repository.json',
      line: 1,
      column: 1,
      source: 'repository descriptor',
    }],
  }).ok, false);
});

test('doctor validation rejects malformed diagnostics and unknown success or failure shapes', () => {
  const malformed = [
    { ...structuredClone(installedSuccess), ok: 'true' },
    { ...structuredClone(installedSuccess), diagnostics: {} },
    { ...structuredClone(installedSuccess), diagnostics: [diagnostic] },
    { ...structuredClone(installedSuccess), diagnostics: [{ code: '', message: 'bad' }] },
    { ...structuredClone(installedSuccess), diagnostics: [{ ...diagnostic, detail: {} }] },
    { ...structuredClone(installedSuccess), baselineRepositoryVerification: { verifiedBaselines: 0, processDrift: -1 } },
    { ...structuredClone(installedSuccess), baselineRepositoryVerification: { verifiedBaselines: 0, processDrift: 1 } },
    { ...structuredClone(installedSuccess), report: { ...installedSuccess.report, path: '.lifecycle/generated/reports/other.json' } },
    { ...structuredClone(installedSuccess), outcome: 'healthy' },
    { ok: false, command: 'doctor', selected: false, diagnostics: [] },
    { ok: false, command: 'doctor', selected: false, package: structuredClone(installedSuccess.package), diagnostics: [diagnostic] },
    { ok: false, command: 'doctor', selected: true, diagnostics: [{ ...diagnostic, line: 0 }] },
    { ok: false, command: 'doctor', selected: true, diagnostics: [diagnostic], report: structuredClone(installedSuccess.report) },
  ];

  for (const value of malformed) {
    assert.throws(() => validateDoctor(value), undefined, JSON.stringify(value));
  }
});
