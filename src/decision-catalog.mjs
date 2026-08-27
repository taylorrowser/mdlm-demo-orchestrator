import { open } from 'node:fs/promises';
import { sha256 } from './util.mjs';

const catalogContract = 'mdlm-demo-decision-catalog@1';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const decisionCatalogLimits = Object.freeze({
  buildRequestBytes: 1_048_576,
  catalogBytes: 1_048_576,
  decisions: 64,
  wordingSourceBytes: 65_536,
});

/**
 * Canonical source-file normalization converts every CRLF pair to LF, then
 * removes exactly one terminal LF. Lone CR code points and every other code
 * point are preserved; Unicode normalization is deliberately not applied.
 */
export function normalizeDecisionWording(source) {
  if (typeof source !== 'string') throw new Error('decision wording source must be a string');
  requireWellFormed(source, 'decision wording source');
  const lineNormalized = source.replaceAll('\r\n', '\n');
  return lineNormalized.endsWith('\n') ? lineNormalized.slice(0, -1) : lineNormalized;
}

export function buildDecisionCatalog(decisions) {
  requireDecisionCount(decisions);
  const catalog = {
    contract: catalogContract,
    decisions: decisions.map((decision, index) => {
      validateBuilderDecision(decision, index);
      const wording = normalizeDecisionWording(decision.wordingSource);
      return {
        assignment: decision.assignment,
        wording,
        origin: 'operator-selected',
        authorityBasis: decision.authorityBasis,
        digest: sha256(Buffer.from(wording, 'utf8')),
      };
    }),
  };
  validateDecisionCatalog(catalog);
  const serializedBytes = Buffer.byteLength(JSON.stringify(catalog), 'utf8') + 1;
  if (serializedBytes > decisionCatalogLimits.catalogBytes) {
    throw new Error(`decision catalog exceeds ${decisionCatalogLimits.catalogBytes}-byte limit`);
  }
  return catalog;
}

export function validateDecisionCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog) || catalog.contract !== catalogContract) {
    throw new Error('invalid decision catalog contract');
  }
  if (!Array.isArray(catalog.decisions)) throw new Error('decision catalog decisions must be an array');
  if (catalog.decisions.length > decisionCatalogLimits.decisions) {
    throw new Error(`decisions must not contain more than ${decisionCatalogLimits.decisions} entries`);
  }
  const assignments = new Set();
  const decisions = catalog.decisions.map((decision, index) => {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new Error(`decision ${index} must be an object`);
    requireNonempty(decision.assignment, `decision ${index} assignment`);
    if (assignments.has(decision.assignment)) throw new Error(`decision catalog contains duplicate assignment ${decision.assignment}`);
    assignments.add(decision.assignment);
    if (decision.origin !== 'operator-selected' || typeof decision.authorityBasis !== 'string' || decision.authorityBasis.length === 0 || typeof decision.wording !== 'string') {
      throw new Error('decision must record operator-selected origin, authority basis, and wording');
    }
    requireWellFormed(decision.wording, `decision ${index} wording`);
    const wordingBytes = Buffer.byteLength(decision.wording, 'utf8');
    if (wordingBytes > decisionCatalogLimits.wordingSourceBytes) {
      throw new Error(`decision ${index} wording exceeds ${decisionCatalogLimits.wordingSourceBytes}-byte limit`);
    }
    const digest = sha256(Buffer.from(decision.wording, 'utf8'));
    if (decision.digest !== digest) throw new Error('operator decision wording digest differs');
    return { assignment: decision.assignment, digest, wordingBytes };
  });
  return { contract: 'mdlm-demo-decision-catalog-validation@1', valid: true, decisions };
}

export async function buildDecisionCatalogRequest(request) {
  exactRequest(request, 'mdlm-demo-decision-catalog-build-request@1', ['contract', 'decisions']);
  requireDecisionCount(request.decisions);
  const decisions = [];
  for (const [index, decision] of request.decisions.entries()) {
    exactRequest(decision, undefined, ['assignment', 'authorityBasis', 'wordingPath'], `decision ${index}`);
    requireNonempty(decision.assignment, `decision ${index} assignment`);
    requireNonempty(decision.authorityBasis, `decision ${index} authorityBasis`);
    requireNonempty(decision.wordingPath, `decision ${index} wordingPath`);
    const sourceBytes = await readFileWithinLimit(
      decision.wordingPath,
      decisionCatalogLimits.wordingSourceBytes,
      `decision ${index} wording source`,
    );
    decisions.push({
      assignment: decision.assignment,
      authorityBasis: decision.authorityBasis,
      wordingSource: decodeUtf8(sourceBytes, `decision ${index} wording source`),
    });
  }
  return buildDecisionCatalog(decisions);
}

export async function validateDecisionCatalogRequest(request) {
  exactRequest(request, 'mdlm-demo-decision-catalog-validate-request@1', ['catalogPath', 'contract']);
  requireNonempty(request.catalogPath, 'catalogPath');
  const { catalog } = await readCatalog(request.catalogPath);
  return validateDecisionCatalog(catalog);
}

export async function bindDecisionCatalogFile(file) {
  if (file === undefined) return null;
  requireNonempty(file, 'decisionCatalogPath');
  const { bytes, catalog } = await readCatalog(file);
  validateDecisionCatalog(catalog);
  return Object.freeze({
    contract: 'mdlm-demo-bound-decision-catalog@1',
    bytes: bytes.length,
    bytesBase64: bytes.toString('base64'),
    digest: sha256(bytes),
  });
}

export async function readFileWithinLimit(file, maxBytes, label) {
  const handle = await open(file, 'r');
  try {
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    for (;;) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      offset += result.bytesRead;
      if (offset > maxBytes) throw new Error(`${label} exceeds ${maxBytes}-byte limit`);
      if (result.bytesRead === 0) return bytes.subarray(0, offset);
    }
  } finally {
    await handle.close();
  }
}

async function readCatalog(file) {
  const bytes = await readFileWithinLimit(file, decisionCatalogLimits.catalogBytes, 'decision catalog');
  return { bytes, catalog: JSON.parse(decodeUtf8(bytes, 'decision catalog')) };
}

function decodeUtf8(bytes, label) {
  try {
    return utf8.decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`${label} is not valid UTF-8`);
    throw error;
  }
}

function validateBuilderDecision(decision, index) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new Error(`decision ${index} must be an object`);
  requireNonempty(decision.assignment, `decision ${index} assignment`);
  requireNonempty(decision.authorityBasis, `decision ${index} authorityBasis`);
  if (typeof decision.wordingSource !== 'string') throw new Error(`decision ${index} wordingSource must be a string`);
  requireWellFormed(decision.wordingSource, `decision ${index} wording source`);
  if (Buffer.byteLength(decision.wordingSource, 'utf8') > decisionCatalogLimits.wordingSourceBytes) {
    throw new Error(`decision ${index} wording source exceeds ${decisionCatalogLimits.wordingSourceBytes}-byte limit`);
  }
}

function requireDecisionCount(decisions) {
  if (!Array.isArray(decisions) || decisions.length === 0) throw new Error('decisions must be a nonempty array');
  if (decisions.length > decisionCatalogLimits.decisions) {
    throw new Error(`decisions must not contain more than ${decisionCatalogLimits.decisions} entries`);
  }
}

function requireWellFormed(value, label) {
  if (!value.isWellFormed()) throw new Error(`${label} contains an unpaired UTF-16 surrogate`);
}

function exactRequest(value, contract, keys, label = 'request') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (contract !== undefined && value.contract !== contract) throw new Error(`expected ${contract}`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly ${expected.join(', ')}`);
  }
}

function requireNonempty(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`);
}
