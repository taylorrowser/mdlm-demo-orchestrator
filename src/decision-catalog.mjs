import { readFile } from 'node:fs/promises';
import { sha256 } from './util.mjs';

const catalogContract = 'mdlm-demo-decision-catalog@1';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Canonical source-file normalization converts every CRLF pair to LF, then
 * removes exactly one terminal LF. Lone CR code points and every other code
 * point are preserved; Unicode normalization is deliberately not applied.
 */
export function normalizeDecisionWording(source) {
  if (typeof source !== 'string') throw new Error('decision wording source must be a string');
  const lineNormalized = source.replaceAll('\r\n', '\n');
  return lineNormalized.endsWith('\n') ? lineNormalized.slice(0, -1) : lineNormalized;
}

export function buildDecisionCatalog(decisions) {
  if (!Array.isArray(decisions) || decisions.length === 0) throw new Error('decisions must be a nonempty array');
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
  return catalog;
}

export function validateDecisionCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog) || catalog.contract !== catalogContract) {
    throw new Error('invalid decision catalog contract');
  }
  if (!Array.isArray(catalog.decisions)) throw new Error('decision catalog decisions must be an array');
  const assignments = new Set();
  const decisions = catalog.decisions.map((decision, index) => {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new Error(`decision ${index} must be an object`);
    requireNonempty(decision.assignment, `decision ${index} assignment`);
    if (assignments.has(decision.assignment)) throw new Error(`decision catalog contains duplicate assignment ${decision.assignment}`);
    assignments.add(decision.assignment);
    if (decision.origin !== 'operator-selected' || typeof decision.authorityBasis !== 'string' || decision.authorityBasis.length === 0 || typeof decision.wording !== 'string') {
      throw new Error('decision must record operator-selected origin, authority basis, and wording');
    }
    const digest = sha256(Buffer.from(decision.wording, 'utf8'));
    if (decision.digest !== digest) throw new Error('operator decision wording digest differs');
    return { assignment: decision.assignment, digest, wordingBytes: Buffer.byteLength(decision.wording, 'utf8') };
  });
  return { contract: 'mdlm-demo-decision-catalog-validation@1', valid: true, decisions };
}

export async function buildDecisionCatalogRequest(request) {
  exactRequest(request, 'mdlm-demo-decision-catalog-build-request@1', ['contract', 'decisions']);
  if (!Array.isArray(request.decisions) || request.decisions.length === 0) throw new Error('decisions must be a nonempty array');
  const decisions = await Promise.all(request.decisions.map(async (decision, index) => {
    exactRequest(decision, undefined, ['assignment', 'authorityBasis', 'wordingPath'], `decision ${index}`);
    requireNonempty(decision.assignment, `decision ${index} assignment`);
    requireNonempty(decision.authorityBasis, `decision ${index} authorityBasis`);
    requireNonempty(decision.wordingPath, `decision ${index} wordingPath`);
    let wordingSource;
    try {
      wordingSource = utf8.decode(await readFile(decision.wordingPath));
    } catch (error) {
      if (error instanceof TypeError) throw new Error(`decision ${index} wordingPath is not valid UTF-8`);
      throw error;
    }
    return { assignment: decision.assignment, authorityBasis: decision.authorityBasis, wordingSource };
  }));
  return buildDecisionCatalog(decisions);
}

export async function validateDecisionCatalogRequest(request) {
  exactRequest(request, 'mdlm-demo-decision-catalog-validate-request@1', ['catalogPath', 'contract']);
  requireNonempty(request.catalogPath, 'catalogPath');
  return validateDecisionCatalog(await readCatalog(request.catalogPath));
}

export async function validateDecisionCatalogFile(file) {
  if (file === undefined) return null;
  requireNonempty(file, 'decisionCatalogPath');
  return validateDecisionCatalog(await readCatalog(file));
}

async function readCatalog(file) {
  try {
    return JSON.parse(utf8.decode(await readFile(file)));
  } catch (error) {
    if (error instanceof TypeError) throw new Error('decision catalog is not valid UTF-8');
    throw error;
  }
}

function validateBuilderDecision(decision, index) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new Error(`decision ${index} must be an object`);
  requireNonempty(decision.assignment, `decision ${index} assignment`);
  requireNonempty(decision.authorityBasis, `decision ${index} authorityBasis`);
  if (typeof decision.wordingSource !== 'string') throw new Error(`decision ${index} wordingSource must be a string`);
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
