import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCanonicalFile } from './canonical-file.mjs';
import { bindDecisionCatalogFile } from './decision-catalog.mjs';
import { inspectProvenance } from './evidence.mjs';
import { validateRunRequest } from './run-request.mjs';
import { parseStrictJson } from './strict-json.mjs';
import { sha256 } from './util.mjs';

const requestContract = 'mdlm-demo-preflight-request@1';
const resultContract = 'mdlm-demo-preflight-result@1';
const runRequestBytes = 1_048_576;
const executableBytes = 268_435_456;
const scriptBytes = 1_048_576;
const gitTimeoutMs = 30_000;
const runnerScript = fileURLToPath(new URL('../bin/mdlm-demo-runner.mjs', import.meta.url));
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const limitation = 'A PASS authenticates only supplied bytes against supplied pins; it neither proves nor authorizes invocation, Assignment, publication, lifecycle transition, Review, or qualification.';

export const preflightLimits = Object.freeze({
  requestBytes: 1_048_576,
  runRequestBytes,
  executableBytes,
  scriptBytes,
});

export async function preflight(request) {
  const checks = [];
  let target;
  let inputEvidence;
  let command;
  let invocationEvidence;
  let catalogBinding;

  try {
    exactObject(request, ['argv', 'contract', 'input', 'invocation'], 'preflight request');
    if (request.contract !== requestContract) throw new Error(`expected ${requestContract}`);
    exactObject(request.input, ['digest', 'path'], 'preflight request.input');
    requireAbsolutePath(request.input.path, 'preflight request.input.path');
    requireDigest(request.input.digest, 'preflight request.input.digest');
    validateInvocationPins(request.invocation);
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
      target = parseStrictJson(decodeUtf8(inputEvidence.bytes, 'preflight input'), 'preflight input');
    } catch (error) {
      throw new Error(`preflight input is not valid JSON or UTF-8: ${error.message}`);
    }
    checks.push(pass('input'));
  } catch (error) {
    checks.push(fail('input', error));
    return result(checks, { inputEvidence, argv: request.argv });
  }

  try {
    invocationEvidence = await authenticateInvocation(request.invocation, request.argv);
    checks.push(pass('invocation'));
  } catch (error) {
    checks.push(fail('invocation', error));
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
    catalogBinding = await bindDecisionCatalogFile(target.decisionCatalogPath);
    checks.push(pass('decision-catalog'));
  } catch (error) {
    checks.push(fail('decision-catalog', error));
  }

  let provenance;
  try {
    provenance = await inspectProvenance(target.provenance, Math.min(target.timeoutMs ?? gitTimeoutMs, gitTimeoutMs));
  } catch (error) {
    checks.push(fail('provenance', error));
    return result(checks, { inputEvidence, argv: request.argv, invocationEvidence, catalogBinding });
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

  return result(checks, { inputEvidence, argv: request.argv, invocationEvidence, catalogBinding, provenance });
}

export function preflightFailure(error) {
  return result([fail('request', error)]);
}

async function authenticateInvocation(invocation, argv) {
  if (!Array.isArray(argv) || argv.length !== 5) throw new Error('argv must contain exactly executable, script, command, --input, and request path');
  if (argv[0] !== invocation.executable.path) throw new Error('argv executable differs from its out-of-band pin');
  if (argv[1] !== invocation.script.path) throw new Error('argv script differs from its out-of-band pin');
  if (path.resolve(invocation.executable.path) !== path.resolve(process.execPath)) {
    throw new Error('invocation executable path differs from the current executable');
  }
  if (path.resolve(invocation.script.path) !== path.resolve(runnerScript)) {
    throw new Error('invocation script path differs from the current runner script');
  }
  const executable = await identity(invocation.executable, 'invocation executable', executableBytes);
  const script = await identity(invocation.script, 'invocation script', scriptBytes);
  return { executable, script };
}

async function identity(pin, label, maxBytes) {
  const evidence = await readCanonicalFile(pin.path, label, undefined, { maxBytes });
  const digest = sha256(evidence.bytes);
  if (digest !== pin.digest) throw new Error(`${label} bytes differ from the supplied digest`);
  return { path: evidence.path, bytes: evidence.bytes.length, digest };
}

function validateInvocationPins(invocation) {
  exactObject(invocation, ['executable', 'script'], 'preflight request.invocation');
  for (const name of ['executable', 'script']) {
    exactObject(invocation[name], ['digest', 'path'], `preflight request.invocation.${name}`);
    requireAbsolutePath(invocation[name].path, `preflight request.invocation.${name}.path`);
    requireDigest(invocation[name].digest, `preflight request.invocation.${name}.digest`);
  }
}

function validateArgv(argv, inputPath, contract) {
  if (!Array.isArray(argv) || argv.length !== 5) throw new Error('argv must contain exactly executable, script, command, --input, and request path');
  let bytes = 0;
  for (const [index, value] of argv.entries()) {
    requireNonempty(value, `argv[${index}]`);
    const length = Buffer.byteLength(value);
    if (length > 4096) throw new Error(`argv[${index}] exceeds 4096-byte limit`);
    bytes += length;
  }
  if (bytes > 65_536) throw new Error('argv exceeds 65536-byte limit');
  const command = argv[2];
  if (command !== 'run' && command !== 'resume') throw new Error('argv must invoke run or resume');
  if (argv[3] !== '--input') throw new Error('argv must pass the request with --input');
  if (argv[4] !== inputPath) throw new Error('argv --input path differs from preflight request.input.path');
  const expectedContract = command === 'run' ? 'mdlm-demo-run-request@1' : 'mdlm-demo-resume-request@1';
  if (contract !== expectedContract) throw new Error(`argv ${command} command differs from the input contract`);
  return command;
}

function result(checks, evidence = {}) {
  const { inputEvidence, argv, invocationEvidence, catalogBinding, provenance } = evidence;
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
        ...(invocationEvidence ?? {}),
      },
    }),
    ...(catalogBinding === undefined || catalogBinding === null ? {} : {
      catalog: { path: catalogBinding.path, bytes: catalogBinding.bytes, digest: catalogBinding.digest },
    }),
    ...(provenance === undefined ? {} : {
      provenance: {
        git: provenance.git,
        source: { repositoryIdentity: provenance.source.repositoryIdentity },
        qualificationHarness: { repositoryIdentity: provenance.qualificationHarness.repositoryIdentity },
      },
    }),
    checks,
    limitation,
  };
}

function decodeUtf8(bytes, label) {
  try {
    return utf8.decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`${label} is not valid UTF-8`);
    throw error;
  }
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
