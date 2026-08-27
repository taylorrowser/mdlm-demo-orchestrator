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
  decisionCatalogLimits,
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

test('decision wording rejects unpaired surrogates without conflating them with U+FFFD', () => {
  const unpaired = ['\uD800', '\uDC00', 'nested \uD800 wording'];
  for (const wordingSource of unpaired) {
    assert.throws(
      () => buildDecisionCatalog([{ assignment: 'assignment-invalid', authorityBasis, wordingSource }]),
      /unpaired UTF-16 surrogate/,
    );
    const replacementDigest = sha256(Buffer.from(wordingSource, 'utf8'));
    assert.equal(replacementDigest, sha256(Buffer.from(wordingSource.replace(/[\uD800-\uDFFF]/gu, '\uFFFD'), 'utf8')));
    assert.throws(() => validateDecisionCatalog({
      contract: 'mdlm-demo-decision-catalog@1',
      decisions: [{
        assignment: 'assignment-invalid', wording: wordingSource, origin: 'operator-selected', authorityBasis, digest: replacementDigest,
      }],
    }), /unpaired UTF-16 surrogate/);
  }

  const validWording = 'Replacement \uFFFD and astral \u{1F680}';
  const catalog = buildDecisionCatalog([{ assignment: 'assignment-valid', authorityBasis, wordingSource: validWording }]);
  assert.equal(catalog.decisions[0].wording, validWording);
  assert.equal(catalog.decisions[0].digest, sha256(Buffer.from(validWording, 'utf8')));
  assert.equal(validateDecisionCatalog(catalog).valid, true);
});

test('decision catalog tooling enforces bounded requests, catalogs, wording, and decision counts', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'issue-17-decision-limits-'));
  const wordingPath = path.join(scratch, 'wording.txt');
  await writeFile(wordingPath, Buffer.alloc(decisionCatalogLimits.wordingSourceBytes + 1, 0x61));

  const oversizedWording = execute('decision-catalog-build', {
    contract: 'mdlm-demo-decision-catalog-build-request@1',
    decisions: [{ assignment: 'assignment-1', authorityBasis, wordingPath }],
  });
  assert.equal(oversizedWording.status, 1);
  assert.match(JSON.parse(oversizedWording.stderr).error, /wording source exceeds 65536-byte limit/);

  const tooMany = Array.from({ length: decisionCatalogLimits.decisions + 1 }, (_, index) => ({
    assignment: `assignment-${index}`, authorityBasis, wordingPath,
  }));
  const tooManyDecisions = execute('decision-catalog-build', {
    contract: 'mdlm-demo-decision-catalog-build-request@1', decisions: tooMany,
  });
  assert.equal(tooManyDecisions.status, 1);
  assert.match(JSON.parse(tooManyDecisions.stderr).error, /decisions must not contain more than 64 entries/);
  assert.throws(() => validateDecisionCatalog({
    contract: 'mdlm-demo-decision-catalog@1',
    decisions: tooMany.map(({ assignment }) => ({
      assignment, wording: 'valid', origin: 'operator-selected', authorityBasis, digest: sha256(Buffer.from('valid')),
    })),
  }), /decisions must not contain more than 64 entries/);

  await writeFile(wordingPath, Buffer.alloc(decisionCatalogLimits.wordingSourceBytes, 0x61));
  const oversizedBuiltCatalog = execute('decision-catalog-build', {
    contract: 'mdlm-demo-decision-catalog-build-request@1',
    decisions: Array.from({ length: 17 }, (_, index) => ({ assignment: `large-${index}`, authorityBasis, wordingPath })),
  });
  assert.equal(oversizedBuiltCatalog.status, 1);
  assert.match(JSON.parse(oversizedBuiltCatalog.stderr).error, /decision catalog exceeds 1048576-byte limit/);

  const oversizedRequest = spawnSync(process.execPath, [cli, 'decision-catalog-build'], {
    cwd: root,
    input: Buffer.alloc(decisionCatalogLimits.buildRequestBytes + 1, 0x20),
  });
  assert.equal(oversizedRequest.status, 1);
  assert.match(JSON.parse(oversizedRequest.stderr.toString('utf8')).error, /decision catalog request exceeds 1048576-byte limit/);

  const catalogPath = path.join(scratch, 'oversized-catalog.json');
  await writeFile(catalogPath, Buffer.alloc(decisionCatalogLimits.catalogBytes + 1, 0x20));
  const oversizedCatalog = execute('decision-catalog-validate', {
    contract: 'mdlm-demo-decision-catalog-validate-request@1', catalogPath,
  });
  assert.equal(oversizedCatalog.status, 1);
  assert.match(JSON.parse(oversizedCatalog.stderr).error, /decision catalog exceeds 1048576-byte limit/);
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
