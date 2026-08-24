import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { commandRecord, parseJsonBytes, requireObject, runProcess, sha256 } from './util.mjs';

const intercepted = new Set([
  'realize-verification-environment@1',
  'register-pilot-target@1',
  'execute-verification-run@1',
]);

export async function adaptAssignment(options) {
  const packetBytes = await readFile(options.packetPath);
  let packet;
  try { packet = parsePacket(packetBytes); }
  catch (error) { return adapterStop('invalid-assignment-packet', error.message); }
  const assignmentId = packet.assignment.id;
  const scenario = packet.scenario.reference;
  if (!intercepted.has(scenario)) return adapterStop('scenario-not-intercepted', scenario, packet);
  const root = path.resolve(options.stateDirectory, 'assignments', safeId(assignmentId));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const identityPath = path.join(root, 'packet-identity.json');
  const packetDigest = sha256(packetBytes);
  const existingIdentity = await optionalJson(identityPath);
  if (existingIdentity !== null && (existingIdentity.packetDigest !== packetDigest || existingIdentity.scenario !== scenario)) {
    return adapterStop('assignment-packet-drift', 'packet bytes or Scenario changed', packet);
  }
  if (existingIdentity === null) {
    await writeFile(identityPath, `${JSON.stringify({ assignmentId, scenario, packetDigest }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(root, 'packet.json'), packetBytes, { flag: 'wx', mode: 0o600 });
  }
  const responsePath = path.join(root, 'exact-response.json');
  const existingResponse = await optionalBytes(responsePath);
  if (existingResponse !== null) return responseResult(existingResponse, responsePath, { recovered: true });

  if (scenario === 'realize-verification-environment@1') {
    return realizeEnvironment(packet, root, responsePath, options);
  }
  return exactObservedResponse(packet, root, responsePath, options);
}

async function realizeEnvironment(packet, root, responsePath, options) {
  const harness = options.harness;
  const checked = await verifyHarness(harness, options.timeoutMs);
  if (!checked.ok) return adapterStop('qualification-harness-provenance-failed', checked.reason, packet, checked.commands);
  const strategies = collectData(packet.exactInputs).filter(value => value?.type === 'VSP' && value?.payload?.environment_profile);
  if (strategies.length !== 1) return adapterStop('exact-strategy-input-required', `found ${strategies.length}`, packet);
  const attempt = await createAttempt(root);
  const strategyPath = path.join(attempt, 'strategy.json');
  const generatedPath = path.join(attempt, 'generated-response.json');
  await writeFile(strategyPath, `${JSON.stringify(strategies[0], null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const environment = controlledEnvironment();
  const generated = await runProcess(process.execPath, [
    path.join(harness.directory, 'tools/generate-preflight-inputs.mjs'),
    '--repository', harness.repositoryLocator,
    '--commit', harness.commit,
    '--assignment', packet.assignment.id,
    '--strategy', strategyPath,
    '--output', generatedPath,
  ], { cwd: harness.directory, timeoutMs: timeout(options.timeoutMs), env: environment });
  await retainCommand(attempt, 'generate', generated);
  if (generated.exitStatus !== 0 || generated.timedOut) {
    return adapterStop('harness-proposal-generation-failed', commandFailure(generated), packet, { generate: commandRecord(generated) });
  }
  const preflight = await runProcess(process.execPath, [
    path.join(harness.directory, 'bin/mdlm-phase1-qualify.mjs'), 'preflight', '--proposal', generatedPath,
  ], { cwd: harness.directory, timeoutMs: timeout(options.timeoutMs), env: environment });
  await retainCommand(attempt, 'preflight', preflight);
  if (preflight.exitStatus !== 0 || preflight.timedOut) {
    return adapterStop('harness-preflight-failed', commandFailure(preflight), packet, { preflight: commandRecord(preflight) });
  }
  const preflightOutput = parseJsonBytes(preflight.stdout, 'qualification preflight');
  if (preflightOutput.ok !== true) return adapterStop('harness-preflight-rejected', 'preflight did not return ok:true', packet);
  const bytes = await readFile(generatedPath);
  validateResponse(bytes, packet);
  await copyFile(generatedPath, responsePath, 1);
  return responseResult(bytes, responsePath, { preflight: preflightOutput, packetDigest: sha256(await readFile(path.join(root, 'packet.json'))) });
}

async function exactObservedResponse(packet, root, responsePath, options) {
  let catalog;
  try { catalog = JSON.parse(await readFile(options.adapterInputsPath, 'utf8')); }
  catch (error) { return adapterStop('adapter-inputs-unavailable', error.message, packet); }
  if (catalog.contract !== 'mdlm-external-adapter-inputs@1') return adapterStop('adapter-inputs-invalid', 'wrong contract', packet);
  const input = catalog.scenarios?.[packet.scenario.reference];
  if (input?.kind !== 'exact-response' || typeof input.responsePath !== 'string' || typeof input.observationsPath !== 'string') {
    return adapterStop('product-observations-required', 'exact response and observations paths are required', packet);
  }
  let observationsBytes;
  let responseBytes;
  try {
    observationsBytes = await readFile(input.observationsPath);
    responseBytes = await readFile(input.responsePath);
  } catch (error) { return adapterStop('adapter-inputs-unavailable', error.message, packet); }
  let observations;
  try { observations = JSON.parse(observationsBytes); }
  catch (error) { return adapterStop('product-observations-invalid', error.message, packet); }
  if (observations.contract !== 'mdlm-external-observations@1' || observations.assignment !== packet.assignment.id || observations.scenario !== packet.scenario.reference) {
    return adapterStop('product-observations-mismatch', 'assignment or Scenario identity differs', packet);
  }
  if (!observations.product || typeof observations.product !== 'object' || Array.isArray(observations.product) || Object.keys(observations.product).length === 0) {
    return adapterStop('product-observations-invalid', 'a nonempty product observation object is required', packet);
  }
  try { validateResponse(responseBytes, packet); }
  catch (error) { return adapterStop('exact-response-invalid', error.message, packet); }
  await writeFile(path.join(root, 'observations.json'), observationsBytes, { flag: 'wx', mode: 0o400 });
  await writeFile(responsePath, responseBytes, { flag: 'wx', mode: 0o400 });
  return responseResult(responseBytes, responsePath, { observationsDigest: sha256(observationsBytes) });
}

async function verifyHarness(value, timeoutMs) {
  if (!value || typeof value.directory !== 'string' || typeof value.commit !== 'string' || typeof value.tree !== 'string' || typeof value.repositoryLocator !== 'string') {
    return { ok: false, reason: 'harness directory, commit, tree, and repositoryLocator are required', commands: {} };
  }
  const commandOptions = { cwd: value.directory, timeoutMs: timeout(timeoutMs) };
  const head = await runProcess('git', ['rev-parse', 'HEAD^{commit}'], commandOptions);
  const tree = await runProcess('git', ['rev-parse', 'HEAD^{tree}'], commandOptions);
  const status = await runProcess('git', ['status', '--porcelain=v1', '--untracked-files=all'], commandOptions);
  const commands = { head: commandRecord(head), tree: commandRecord(tree), status: commandRecord(status) };
  const ok = head.exitStatus === 0 && tree.exitStatus === 0 && status.exitStatus === 0 &&
    head.stdout.toString('utf8').trim() === value.commit && tree.stdout.toString('utf8').trim() === value.tree && status.stdout.length === 0;
  return { ok, reason: ok ? null : 'harness HEAD, tree, or clean status differs', commands };
}

function parsePacket(bytes) {
  const packet = parseJsonBytes(bytes, 'Assignment packet');
  requireObject(packet, 'Assignment packet');
  if (packet.contract !== 'mdlm-assignment-packet@2') throw new Error('expected mdlm-assignment-packet@2');
  if (typeof packet.assignment?.id !== 'string' || typeof packet.scenario?.reference !== 'string') throw new Error('packet lacks Assignment or Scenario identity');
  return packet;
}

function validateResponse(bytes, packet) {
  const response = parseJsonBytes(bytes, 'Assignment response');
  if (response.contract !== 'mdlm-assignment-response@1' || response.assignment !== packet.assignment.id) throw new Error('response contract or Assignment differs');
  return response;
}

function collectData(value, output = []) {
  if (Array.isArray(value)) for (const item of value) collectData(item, output);
  else if (value && typeof value === 'object') {
    if (value.data && typeof value.data === 'object' && !Array.isArray(value.data)) output.push(value.data);
    for (const child of Object.values(value)) collectData(child, output);
  }
  return output;
}

async function createAttempt(root) {
  const names = await readdir(root);
  const number = names.filter(name => /^attempt-[0-9]{4}$/.test(name)).length + 1;
  const directory = path.join(root, `attempt-${String(number).padStart(4, '0')}`);
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

async function retainCommand(directory, name, result) {
  await writeFile(path.join(directory, `${name}.stdout`), result.stdout, { flag: 'wx', mode: 0o400 });
  await writeFile(path.join(directory, `${name}.stderr`), result.stderr, { flag: 'wx', mode: 0o400 });
  await writeFile(path.join(directory, `${name}.json`), `${JSON.stringify(commandRecord(result), null, 2)}\n`, { flag: 'wx', mode: 0o400 });
}

function responseResult(bytes, responsePath, extra = {}) {
  return { kind: 'response', contract: 'mdlm-external-adapter-response@1', bytes, responsePath, digest: sha256(bytes), ...extra };
}
function adapterStop(reason, detail, packet, evidence = {}) {
  return { kind: 'stop', stop: { contract: 'mdlm-demo-reserved-stop@1', type: 'external-adapter', phase: 'before-submission', reason, detail, ...(packet ? { assignment: packet.assignment, scenario: packet.scenario.reference, package: packet.package, repository: packet.repository } : {}), evidence } };
}
function commandFailure(result) { return result.timedOut ? 'deadline exceeded' : `exit status ${result.exitStatus}`; }
function controlledEnvironment() { return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/', LANG: 'C', LC_ALL: 'C', NODE_OPTIONS: '' }; }
function timeout(value) { return Number.isSafeInteger(value) && value >= 1 && value <= 900_000 ? value : 30_000; }
function safeId(value) { return value.replace(/[^A-Za-z0-9._-]/g, '_'); }
async function optionalBytes(file) { try { return await readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function optionalJson(file) { const bytes = await optionalBytes(file); return bytes === null ? null : JSON.parse(bytes); }
