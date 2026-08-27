import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildDecisionCatalog,
  normalizeDecisionWording,
  validateDecisionCatalog,
} from '../src/decision-catalog.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin/mdlm-demo-runner.mjs');
const authorityBasis = 'Standing authorization permits this attended decision.';

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function execute(command, request) {
  return spawnSync(process.execPath, [cli, command], {
    cwd: root,
    input: JSON.stringify(request),
    encoding: 'utf8',
  });
}

test('canonical wording normalization handles LF, CRLF, and no final newline deterministically', () => {
  const expected = 'first line\nsecond line';
  for (const source of [
    'first line\nsecond line\n',
    'first line\r\nsecond line\r\n',
    'first line\nsecond line',
  ]) {
    assert.equal(normalizeDecisionWording(source), expected);
    const catalog = buildDecisionCatalog([{ assignment: 'assignment-1', authorityBasis, wordingSource: source }]);
    assert.equal(catalog.decisions[0].wording, expected);
    assert.equal(catalog.decisions[0].digest, sha256(Buffer.from(expected, 'utf8')));
    assert.equal(validateDecisionCatalog(catalog).valid, true);
  }
  assert.equal(normalizeDecisionWording('wording\n\n'), 'wording\n');
  assert.equal(normalizeDecisionWording('wording\r'), 'wording\r');
});

test('canonical builder preserves non-ASCII Unicode and does not normalize NFC or NFD', () => {
  const nfc = 'Décision 東京';
  const nfd = nfc.normalize('NFD');
  assert.notEqual(nfc, nfd);

  const catalog = buildDecisionCatalog([
    { assignment: 'assignment-nfc', authorityBasis, wordingSource: `${nfc}\n` },
    { assignment: 'assignment-nfd', authorityBasis, wordingSource: `${nfd}\n` },
  ]);

  assert.equal(catalog.decisions[0].wording, nfc);
  assert.equal(catalog.decisions[1].wording, nfd);
  assert.equal(catalog.decisions[0].digest, sha256(Buffer.from(nfc, 'utf8')));
  assert.equal(catalog.decisions[1].digest, sha256(Buffer.from(nfd, 'utf8')));
  assert.notEqual(catalog.decisions[0].digest, catalog.decisions[1].digest);
  assert.equal(validateDecisionCatalog(catalog).decisions.length, 2);
});

test('decision catalog CLI builds from source bytes and validates without writing state', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'issue-17-decision-catalog-'));
  const wordingPath = path.join(scratch, 'wording.txt');
  const catalogPath = path.join(scratch, 'catalog.json');
  await writeFile(wordingPath, 'line one\r\nline two\r\n');
  const built = execute('decision-catalog-build', {
    contract: 'mdlm-demo-decision-catalog-build-request@1',
    decisions: [{ assignment: 'assignment-1', authorityBasis, wordingPath }],
  });
  assert.equal(built.status, 0, built.stderr);
  const catalog = JSON.parse(built.stdout);
  assert.equal(catalog.decisions[0].wording, 'line one\nline two');
  assert.equal(catalog.decisions[0].digest, sha256(Buffer.from('line one\nline two')));
  await writeFile(catalogPath, built.stdout);
  const before = await readdir(scratch);

  const validated = execute('decision-catalog-validate', {
    contract: 'mdlm-demo-decision-catalog-validate-request@1',
    catalogPath,
  });

  assert.equal(validated.status, 0, validated.stderr);
  assert.deepEqual(JSON.parse(validated.stdout), {
    contract: 'mdlm-demo-decision-catalog-validation@1',
    valid: true,
    decisions: [{
      assignment: 'assignment-1',
      digest: sha256(Buffer.from('line one\nline two')),
      wordingBytes: Buffer.byteLength('line one\nline two'),
    }],
  });
  assert.deepEqual(await readdir(scratch), before);
  assert.equal(await readFile(catalogPath, 'utf8'), built.stdout);
});

test('independent validator rejects a manually assembled source-byte digest mismatch', async () => {
  const wording = 'Exact attended decision wording.';
  const catalog = {
    contract: 'mdlm-demo-decision-catalog@1',
    decisions: [{
      assignment: 'assignment-1',
      wording,
      origin: 'operator-selected',
      authorityBasis,
      digest: sha256(Buffer.from(`${wording}\n`, 'utf8')),
    }],
  };
  assert.throws(() => validateDecisionCatalog(catalog), /operator decision wording digest differs/);

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'issue-17-manual-catalog-'));
  const catalogPath = path.join(scratch, 'catalog.json');
  await writeFile(catalogPath, JSON.stringify(catalog));
  const validated = execute('decision-catalog-validate', {
    contract: 'mdlm-demo-decision-catalog-validate-request@1',
    catalogPath,
  });
  assert.equal(validated.status, 1);
  assert.match(JSON.parse(validated.stderr).error, /operator decision wording digest differs/);
  assert.deepEqual(await readdir(scratch), ['catalog.json']);
});
