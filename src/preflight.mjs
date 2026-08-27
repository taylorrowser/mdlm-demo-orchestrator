import path from 'node:path';
import { readCanonicalFile } from './canonical-file.mjs';
import { bindDecisionCatalogFile } from './decision-catalog.mjs';
import { inspectProvenance } from './evidence.mjs';
import { validateOperator, validateRunRequest } from './orchestrator.mjs';
import { sha256 } from './util.mjs';

const requestContract = 'mdlm-demo-preflight-request@1';
const resultContract = 'mdlm-demo-preflight-result@1';
const runRequestBytes = 1_048_576;
const gitTimeoutMs = 30_000;
const limitation = 'This result authenticates only the supplied bytes and pins. It does not authorize an Assignment, publication, lifecycle transition, or qualification.';

export const preflightLimits = Object.freeze({ requestBytes: 1_048_576, runRequestBytes });

export async function preflight(request) {
  const checks = [];
  let target;
  let inputEvidence;
  let command;

  try {
    exactObject(request, ['argv', 'contract', 'input'], 'preflight request');
    if (request.contract !== requestContract) throw new Error(`expected ${requestContract}`);
    exactObject(request.input, ['digest', 'path'], 'preflight request.input');
    requireAbsolutePath(request.input.path, 'preflight request.input.path');
    requireDigest(request.input.digest, 'preflight request.input.digest');
    checks.push(pass('request'));
  } catch (error) {
    checks.push(fail('request', error));
    return result(checks);
  }

  try {
    inputEvidence = await readCanonicalFile(
      request.input.path,
      'preflight input',
      undefined,
      { maxBytes: runRequestBytes },
    );
    if (inputEvidence.bytes.length === 0) throw new Error('preflight input must not be empty');
    const observedDigest = sha256(inputEvidence.bytes);
    if (observedDigest !== request.input.digest) throw new Error('preflight input digest differs from the supplied digest');
    try {
      target = JSON.parse(inputEvidence.bytes.toString('utf8'));
    } catch (error) {
      throw new Error(`preflight input is not valid JSON: ${error.message}`);
    }
    checks.push(pass('input'));
  } catch (error) {
    checks.push(fail('input', error));
    return result(checks, inputEvidence, request.argv);
  }

  try {
    command = validateArgv(request.argv, request.input.path, target?.contract);
    checks.push(pass('argv'));
  } catch (error) {
    checks.push(fail('argv', error));
  }

  try {
    const expectedContract = command === 'resume' ? 'mdlm-demo-resume-request@1' : 'mdlm-demo-run-request@1';
    if (target?.contract !== expectedContract) throw new Error(`argv command ${command ?? 'is invalid and'} does not match input contract`);
    validateRunRequest(target);
    validateOperator(target.operator);
    for (const name of ['repository', 'stateDirectory', 'evidenceDirectory']) requireAbsolutePath(target[name], name);
    requireNonempty(target.assignmentId, 'assignmentId');
    requireNonempty(target.commands?.mdlm, 'commands.mdlm');
    requireNonempty(target.commands?.mdlmPi, 'commands.mdlmPi');
    checks.push(pass('run-request'));
  } catch (error) {
    checks.push(fail('run-request', error));
  }

  try {
    requireSamePath(target.commands?.mdlm, target.provenance?.tools?.mdlm?.path, 'commands.mdlm and provenance.tools.mdlm.path');
    requireSamePath(target.commands?.mdlmPi, target.provenance?.tools?.mdlmPi?.path, 'commands.mdlmPi and provenance.tools.mdlmPi.path');
    if (target.harness !== undefined) {
      requireSamePath(target.harness?.directory, target.provenance?.qualificationHarness?.repository, 'harness.directory and provenance.qualificationHarness.repository');
      for (const name of ['commit', 'tree', 'repositoryLocator']) {
        if (target.harness?.[name] !== target.provenance?.qualificationHarness?.[name]) {
          throw new Error(`harness.${name} and provenance.qualificationHarness.${name} differ`);
        }
      }
    }
    checks.push(pass('configuration'));
  } catch (error) {
    checks.push(fail('configuration', error));
  }

  try {
    await bindDecisionCatalogFile(target.decisionCatalogPath);
    checks.push(pass('decision-catalog'));
  } catch (error) {
    checks.push(fail('decision-catalog', error));
  }

  let provenance;
  try {
    provenance = await inspectProvenance(target.provenance, Math.min(target.timeoutMs ?? gitTimeoutMs, gitTimeoutMs));
  } catch (error) {
    checks.push(fail('provenance', error));
    return result(checks, inputEvidence, request.argv);
  }
  for (const [name, value] of [
    ['provenance.source', provenance.source],
    ['provenance.package', provenance.package],
    ['provenance.piPackage', provenance.piPackage],
    ['provenance.tooling', provenance.tooling],
    ['provenance.tools.mdlm', provenance.tools.mdlm],
    ['provenance.tools.mdlmPi', provenance.tools.mdlmPi],
    ['provenance.qualificationHarness', provenance.qualificationHarness],
  ]) {
    checks.push(value.matches === true ? pass(name) : fail(name, value.error ?? `${name} differs from its supplied pin`));
  }

  return result(checks, inputEvidence, request.argv);
}

export function preflightFailure(error) {
  return result([fail('request', error)]);
}

function validateArgv(argv, inputPath, contract) {
  if (!Array.isArray(argv) || argv.length < 4 || argv.length > 32) throw new Error('argv must contain a bounded complete helper command');
  let bytes = 0;
  for (const [index, value] of argv.entries()) {
    requireNonempty(value, `argv[${index}]`);
    const length = Buffer.byteLength(value);
    if (length > 4096) throw new Error(`argv[${index}] exceeds 4096-byte limit`);
    bytes += length;
  }
  if (bytes > 65_536) throw new Error('argv exceeds 65536-byte limit');
  const command = argv.at(-3);
  if (command !== 'run' && command !== 'resume') throw new Error('argv must invoke run or resume');
  if (argv.at(-2) !== '--input') throw new Error('argv must pass the request with --input');
  if (argv.at(-1) !== inputPath) throw new Error('argv --input path differs from preflight request.input.path');
  if (argv.filter(value => value === '--input').length !== 1) throw new Error('argv must contain exactly one --input');
  const expectedContract = command === 'run' ? 'mdlm-demo-run-request@1' : 'mdlm-demo-resume-request@1';
  if (contract !== expectedContract) throw new Error(`argv ${command} command differs from the input contract`);
  return command;
}

function result(checks, inputEvidence, argv) {
  return {
    contract: resultContract,
    status: checks.length > 0 && checks.every(check => check.ok) ? 'PASS' : 'FAIL',
    ...(inputEvidence === undefined ? {} : {
      input: { path: inputEvidence.path, bytes: inputEvidence.bytes.length, digest: sha256(inputEvidence.bytes) },
    }),
    ...(argv === undefined ? {} : {
      invocation: {
        argv,
        digest: sha256(Buffer.from(`${JSON.stringify(argv)}\n`, 'utf8')),
      },
    }),
    checks,
    limitation,
  };
}

function pass(name) { return { name, ok: true }; }
function fail(name, error) {
  return { name, ok: false, error: error instanceof Error ? error.message : String(error) };
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly ${expected.join(', ')}`);
  }
}

function requireNonempty(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`);
}

function requireAbsolutePath(value, label) {
  requireNonempty(value, label);
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
}

function requireDigest(value, label) {
  if (!/^sha256:[0-9a-f]{64}$/.test(value ?? '')) throw new Error(`${label} must be sha256:<64 lowercase hex>`);
}

function requireSamePath(left, right, label) {
  requireNonempty(left, label);
  requireNonempty(right, label);
  if (path.resolve(left) !== path.resolve(right)) throw new Error(`${label} differ`);
}
