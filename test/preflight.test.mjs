import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, mkdir, open, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { bindDecisionCatalogFile } from '../src/decision-catalog.mjs';
import * as evidence from '../src/evidence.mjs';
import { toolingTreeIdentity } from '../src/util.mjs';
import { toolingTreeDigest } from './provenance-fixture.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin/mdlm-demo-runner.mjs');
const run036HarnessPin = '8156dfb33344dfd705266307daf2379dc9026a80';
const limitation = 'A PASS authenticates only supplied bytes against supplied pins; it neither proves nor authorizes invocation, Assignment, publication, lifecycle transition, Review, or qualification.';
const executableDigest = await fileDigest(process.execPath);
const scriptDigest = await fileDigest(cli);
const { inspectProvenance } = evidence;

function exec(program, args, cwd, input, env = process.env) {
  return spawnSync(program, args, { cwd, input, env, encoding: 'utf8', timeout: 20_000 });
}

function git(args, cwd) {
  const result = exec('git', args, cwd);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function fileDigest(file) {
  return digest(await readFile(file));
}

async function fixture(options = {}) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-preflight-'));
  const source = path.join(scratch, 'source');
  const harness = path.join(scratch, 'qualification-harness');
  const tooling = path.join(scratch, 'tooling');
  const repository = path.join(scratch, 'lifecycle-repository');
  for (const directory of [source, harness, tooling, repository]) await mkdir(directory);
  for (const directory of [source, harness, repository]) {
    git(['init', ...(options.objectFormat === undefined ? [] : [`--object-format=${options.objectFormat}`]), '-b', 'main'], directory);
    git(['config', 'user.name', 'Test'], directory);
    git(['config', 'user.email', 'test@example.invalid'], directory);
    await writeFile(path.join(directory, 'README.md'), `${path.basename(directory)} fixture\n`);
    git(['add', '.'], directory);
    git(['commit', '-m', 'fixture'], directory);
  }

  const mdlm = path.join(tooling, 'mdlm');
  const mdlmPi = path.join(tooling, 'mdlm-pi');
  const lock = path.join(tooling, 'package-lock.json');
  const packageArtifact = path.join(scratch, 'mdlm.tgz');
  const piPackageArtifact = path.join(scratch, 'mdlm-pi.tgz');
  const manifest = path.join(harness, 'README.md');
  const decisionCatalogPath = path.join(scratch, 'decision-catalog.json');
  const wording = 'Proceed with the exact attended Assignment.';
  const decisionCatalog = {
    contract: 'mdlm-demo-decision-catalog@1',
    decisions: [{
      assignment: '44444444-4444-4444-8444-444444444444',
      wording,
      origin: 'operator-selected',
      authorityBasis: 'test fixture authority',
      digest: digest(Buffer.from(wording)),
    }],
  };
  await writeFile(decisionCatalogPath, `${JSON.stringify(decisionCatalog)}\n`);
  await writeFile(mdlm, '#!/bin/sh\nexit 0\n');
  await writeFile(mdlmPi, '#!/bin/sh\nexit 0\n');
  await chmod(mdlm, 0o755);
  await chmod(mdlmPi, 0o755);
  await writeFile(lock, '{"lockfileVersion":3}\n');
  await writeFile(packageArtifact, 'mdlm package\n');
  await writeFile(piPackageArtifact, 'mdlm-pi package\n');

  const sourceCommit = git(['rev-parse', 'HEAD^{commit}'], source);
  const sourceTree = git(['rev-parse', 'HEAD^{tree}'], source);
  const harnessCommit = git(['rev-parse', 'HEAD^{commit}'], harness);
  const harnessTree = git(['rev-parse', 'HEAD^{tree}'], harness);
  const runRequest = {
    contract: 'mdlm-demo-run-request@1',
    repository,
    stateDirectory: path.join(scratch, 'state'),
    evidenceDirectory: path.join(scratch, 'evidence'),
    timeoutMs: 900_000,
    mdlmPiCommandTimeoutMs: 600_000,
    mdlmPiAssignmentTimeoutMs: 840_000,
    signal: 'adapter-failure-before-submission',
    assignmentId: '44444444-4444-4444-8444-444444444444',
    decisionCatalogPath,
    operator: { provider: 'openai-codex', model: 'gpt-5.6-sol', thinking: 'high' },
    commands: { mdlm, mdlmPi },
    harness: {
      directory: harness,
      commit: harnessCommit,
      tree: harnessTree,
      repositoryLocator: 'https://example.invalid/qualification-harness.git',
    },
    provenance: {
      source: { repository: source, commit: sourceCommit, tree: sourceTree },
      package: { artifact: packageArtifact, digest: await fileDigest(packageArtifact) },
      piPackage: { artifact: piPackageArtifact, digest: await fileDigest(piPackageArtifact) },
      tooling: { root: tooling, digest: await toolingTreeDigest(tooling), lock: { path: lock, digest: await fileDigest(lock) } },
      tools: { mdlm: { path: mdlm, digest: await fileDigest(mdlm) }, mdlmPi: { path: mdlmPi, digest: await fileDigest(mdlmPi) } },
      qualificationHarness: {
        repository: harness,
        commit: harnessCommit,
        tree: harnessTree,
        repositoryLocator: 'https://example.invalid/qualification-harness.git',
        manifest: { path: manifest, digest: await fileDigest(manifest) },
      },
    },
  };
  const runRequestPath = path.join(scratch, 'run-request.json');
  const writeRunRequest = async () => {
    const bytes = Buffer.from(`${JSON.stringify(runRequest)}\n`);
    await writeFile(runRequestPath, bytes);
    return bytes;
  };
  const runRequestBytes = await writeRunRequest();
  const preflightRequest = {
    contract: 'mdlm-demo-preflight-request@1',
    input: { path: runRequestPath, digest: digest(runRequestBytes) },
    invocation: {
      executable: { path: process.execPath, digest: executableDigest },
      script: { path: cli, digest: scriptDigest },
    },
    argv: [process.execPath, cli, 'run', '--input', runRequestPath],
  };
  return {
    scratch, source, harness, tooling, decisionCatalog, decisionCatalogPath,
    runRequest, runRequestPath, writeRunRequest, preflightRequest,
  };
}

function invoke(request, cwd, env = process.env) {
  return exec(process.execPath, [cli, 'preflight'], cwd, `${JSON.stringify(request)}\n`, env);
}

async function invokeFile(request, cwd) {
  const file = path.join(cwd, 'preflight-request.json');
  await writeFile(file, `${JSON.stringify(request)}\n`);
  return exec(process.execPath, [cli, 'preflight', '--input', file], cwd);
}

function resultOf(execution) {
  assert.equal(execution.stderr, '');
  const lines = execution.stdout.trim().split('\n');
  assert.equal(lines.length, 1, execution.stdout);
  const result = JSON.parse(lines[0]);
  assert.equal(result.contract, 'mdlm-demo-preflight-result@1');
  assert.equal(result.limitation, limitation);
  return result;
}

test('preflight rejects run 036 wrong harness commit even when every harness asset digest matches', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  value.runRequest.harness.commit = run036HarnessPin;
  value.runRequest.provenance.qualificationHarness.commit = run036HarnessPin;
  const bytes = await value.writeRunRequest();
  value.preflightRequest.input.digest = digest(bytes);

  const execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(execution.status, 1, execution.stderr);
  const result = resultOf(execution);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.checks.some(check => check.name === 'provenance.qualificationHarness' && check.ok === false));
  assert.notEqual(git(['rev-parse', 'HEAD^{commit}'], value.harness), run036HarnessPin);
  await assert.rejects(readFile(path.join(value.scratch, 'state')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(value.scratch, 'evidence')), { code: 'ENOENT' });
});

test('preflight rejects the run 032 helper argv shape that omits --input', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  value.preflightRequest.argv = [process.execPath, cli, 'run', value.runRequestPath];

  const execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(execution.status, 1, execution.stderr);
  const result = resultOf(execution);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.checks.some(check => check.name === 'argv' && check.ok === false));
  await assert.rejects(readFile(path.join(value.scratch, 'state')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(value.scratch, 'evidence')), { code: 'ENOENT' });
});

test('preflight PASS is identical through stdin and --input and creates no lifecycle state', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));

  const stdinExecution = invoke(value.preflightRequest, value.scratch);
  const fileExecution = await invokeFile(value.preflightRequest, value.scratch);
  assert.equal(stdinExecution.status, 0, stdinExecution.stderr);
  assert.equal(fileExecution.status, 0, fileExecution.stderr);
  assert.equal(fileExecution.stdout, stdinExecution.stdout);
  const result = resultOf(stdinExecution);
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.invocation.argv, value.preflightRequest.argv);
  assert.equal(result.invocation.executable.digest, executableDigest);
  assert.equal(result.invocation.script.digest, scriptDigest);
  assert.equal(result.input.digest, value.preflightRequest.input.digest);
  assert.deepEqual(result.catalog, {
    path: value.decisionCatalogPath,
    bytes: (await readFile(value.decisionCatalogPath)).length,
    digest: await fileDigest(value.decisionCatalogPath),
  });
  assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all'], value.source), '');
  assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all'], value.harness), '');
  await assert.rejects(readFile(path.join(value.scratch, 'state')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(value.scratch, 'evidence')), { code: 'ENOENT' });
});

test('preflight rejects extra keys, digest drift, and duplicate pin disagreements', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));

  const extraRequest = structuredClone(value.preflightRequest);
  extraRequest.authority = 'inferred';
  let execution = invoke(extraRequest, value.scratch);
  assert.equal(execution.status, 1);
  assert.equal(resultOf(execution).checks.find(check => check.name === 'request').ok, false);

  const wrongDigest = structuredClone(value.preflightRequest);
  wrongDigest.input.digest = digest('different bytes');
  execution = invoke(wrongDigest, value.scratch);
  assert.equal(execution.status, 1);
  assert.equal(resultOf(execution).checks.find(check => check.name === 'input').ok, false);

  value.runRequest.harness.tree = '0'.repeat(40);
  const bytes = await value.writeRunRequest();
  value.preflightRequest.input.digest = digest(bytes);
  execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(execution.status, 1);
  assert.equal(resultOf(execution).checks.find(check => check.name === 'configuration').ok, false);

  value.runRequest.harness.tree = value.runRequest.provenance.qualificationHarness.tree;
  value.runRequest.unexpected = true;
  const extraTargetBytes = await value.writeRunRequest();
  value.preflightRequest.input.digest = digest(extraTargetBytes);
  execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(execution.status, 1);
  assert.equal(resultOf(execution).checks.find(check => check.name === 'run-request').ok, false);
});

test('preflight emits a typed stdout-only failure for omitted and empty input', async t => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-preflight-empty-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  let execution = exec(process.execPath, [cli, 'preflight'], scratch, '');
  assert.equal(execution.status, 1);
  assert.equal(resultOf(execution).status, 'FAIL');

  const emptyInput = path.join(scratch, 'empty.json');
  await writeFile(emptyInput, '');
  const request = {
    contract: 'mdlm-demo-preflight-request@1',
    input: { path: emptyInput, digest: digest('') },
    invocation: {
      executable: { path: process.execPath, digest: executableDigest },
      script: { path: cli, digest: scriptDigest },
    },
    argv: [process.execPath, cli, 'run', '--input', emptyInput],
  };
  execution = invoke(request, scratch);
  assert.equal(execution.status, 1);
  assert.match(resultOf(execution).checks.find(check => check.name === 'input').error, /must not be empty/);
});

test('preflight rejects symlinked and oversized run-request inputs', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));

  const linkedInput = path.join(value.scratch, 'linked-run-request.json');
  await symlink(value.runRequestPath, linkedInput);
  const symlinkRequest = structuredClone(value.preflightRequest);
  symlinkRequest.input.path = linkedInput;
  symlinkRequest.argv[symlinkRequest.argv.length - 1] = linkedInput;
  let execution = invoke(symlinkRequest, value.scratch);
  assert.equal(execution.status, 1);
  assert.match(resultOf(execution).checks.find(check => check.name === 'input').error, /not a regular file/);

  const oversizedInput = path.join(value.scratch, 'oversized-run-request.json');
  const oversizedBytes = Buffer.alloc(1_048_577, 0x20);
  await writeFile(oversizedInput, oversizedBytes);
  const oversizedRequest = structuredClone(value.preflightRequest);
  oversizedRequest.input = { path: oversizedInput, digest: digest(oversizedBytes) };
  oversizedRequest.argv[oversizedRequest.argv.length - 1] = oversizedInput;
  execution = invoke(oversizedRequest, value.scratch);
  assert.equal(execution.status, 1);
  assert.match(resultOf(execution).checks.find(check => check.name === 'input').error, /exceeds 1048576-byte limit/);
});

test('preflight rejects malformed UTF-8 in its wrapper and run request', async t => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-preflight-utf8-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const malformedWrapper = path.join(scratch, 'malformed-wrapper.json');
  await writeFile(malformedWrapper, Buffer.concat([
    Buffer.from('{"contract":"mdlm-demo-preflight-request@1","bad":"'), Buffer.from([0xff]), Buffer.from('"}\n'),
  ]));
  let execution = exec(process.execPath, [cli, 'preflight', '--input', malformedWrapper], scratch);
  assert.equal(execution.status, 1);
  assert.match(resultOf(execution).checks.find(check => check.name === 'request').error, /UTF-8/);

  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  const malformedTarget = Buffer.concat([
    Buffer.from('{"contract":"mdlm-demo-run-request@1","bad":"'), Buffer.from([0xff]), Buffer.from('"}\n'),
  ]);
  await writeFile(value.runRequestPath, malformedTarget);
  value.preflightRequest.input.digest = digest(malformedTarget);
  execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(execution.status, 1);
  assert.match(resultOf(execution).checks.find(check => check.name === 'input').error, /UTF-8/);

  const catalogValue = await fixture();
  t.after(() => rm(catalogValue.scratch, { recursive: true, force: true }));
  await writeFile(catalogValue.decisionCatalogPath, Buffer.from([0xff]));
  execution = invoke(catalogValue.preflightRequest, catalogValue.scratch);
  assert.equal(execution.status, 1);
  assert.match(resultOf(execution).checks.find(check => check.name === 'decision-catalog').error, /UTF-8/);
});

test('preflight closes every nested run-request and catalog object', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  const nestedTargets = [
    value.runRequest.commands,
    value.runRequest.harness,
    value.runRequest.provenance,
    value.runRequest.provenance.source,
    value.runRequest.provenance.package,
    value.runRequest.provenance.piPackage,
    value.runRequest.provenance.tooling,
    value.runRequest.provenance.tooling.lock,
    value.runRequest.provenance.tools,
    value.runRequest.provenance.tools.mdlm,
    value.runRequest.provenance.tools.mdlmPi,
    value.runRequest.provenance.qualificationHarness,
    value.runRequest.provenance.qualificationHarness.manifest,
  ];
  for (const target of nestedTargets) {
    target.unexpected = true;
    const bytes = await value.writeRunRequest();
    value.preflightRequest.input.digest = digest(bytes);
    const execution = invoke(value.preflightRequest, value.scratch);
    assert.equal(execution.status, 1, execution.stderr);
    assert.equal(resultOf(execution).checks.find(check => check.name === 'run-request').ok, false);
    delete target.unexpected;
  }

  value.decisionCatalog.unexpected = true;
  await writeFile(value.decisionCatalogPath, `${JSON.stringify(value.decisionCatalog)}\n`);
  let execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(execution.status, 1);
  assert.equal(resultOf(execution).checks.find(check => check.name === 'decision-catalog').ok, false);
  delete value.decisionCatalog.unexpected;
  value.decisionCatalog.decisions[0].unexpected = true;
  await writeFile(value.decisionCatalogPath, `${JSON.stringify(value.decisionCatalog)}\n`);
  execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(execution.status, 1);
  assert.equal(resultOf(execution).checks.find(check => check.name === 'decision-catalog').ok, false);
});

test('preflight authenticates the complete executable and script identities', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));

  const wrongLeadingArg = structuredClone(value.preflightRequest);
  wrongLeadingArg.argv[0] = path.join(value.scratch, 'other-node');
  let execution = invoke(wrongLeadingArg, value.scratch);
  assert.equal(execution.status, 1);
  assert.equal(resultOf(execution).checks.find(check => check.name === 'invocation').ok, false);

  const wrongExecutable = path.join(value.scratch, 'wrong-node');
  await writeFile(wrongExecutable, 'not the current executable\n');
  const wrongExecutableRequest = structuredClone(value.preflightRequest);
  wrongExecutableRequest.argv[0] = wrongExecutable;
  wrongExecutableRequest.invocation.executable = { path: wrongExecutable, digest: await fileDigest(wrongExecutable) };
  execution = invoke(wrongExecutableRequest, value.scratch);
  assert.equal(execution.status, 1);
  assert.equal(resultOf(execution).checks.find(check => check.name === 'invocation').ok, false);

  const wrongScript = path.join(value.scratch, 'wrong-runner.mjs');
  await writeFile(wrongScript, `${await readFile(cli, 'utf8')}// substituted bytes\n`);
  const wrongScriptRequest = structuredClone(value.preflightRequest);
  wrongScriptRequest.argv[1] = wrongScript;
  wrongScriptRequest.invocation.script = { path: wrongScript, digest: await fileDigest(wrongScript) };
  execution = invoke(wrongScriptRequest, value.scratch);
  assert.equal(execution.status, 1);
  assert.equal(resultOf(execution).checks.find(check => check.name === 'invocation').ok, false);

  const wrongExecutablePin = structuredClone(value.preflightRequest);
  wrongExecutablePin.invocation.executable.digest = digest('wrong executable bytes');
  execution = invoke(wrongExecutablePin, value.scratch);
  assert.equal(execution.status, 1);
  assert.equal(resultOf(execution).checks.find(check => check.name === 'invocation').ok, false);

  const wrongScriptPin = structuredClone(value.preflightRequest);
  wrongScriptPin.invocation.script.digest = digest('wrong script bytes');
  execution = invoke(wrongScriptPin, value.scratch);
  assert.equal(execution.status, 1);
  assert.equal(resultOf(execution).checks.find(check => check.name === 'invocation').ok, false);
});

const provenanceFiles = [
  { name: 'package', path: value => value.runRequest.provenance.package.artifact, limit: 16_777_216, check: 'provenance.package' },
  { name: 'pi package', path: value => value.runRequest.provenance.piPackage.artifact, limit: 16_777_216, check: 'provenance.piPackage' },
  { name: 'mdlm tool', path: value => value.runRequest.provenance.tools.mdlm.path, limit: 16_777_216, check: 'provenance.tools.mdlm' },
  { name: 'mdlm-pi tool', path: value => value.runRequest.provenance.tools.mdlmPi.path, limit: 16_777_216, check: 'provenance.tools.mdlmPi' },
  { name: 'tooling lock', path: value => value.runRequest.provenance.tooling.lock.path, limit: 4_194_304, check: 'provenance.tooling' },
  { name: 'harness manifest', path: value => value.runRequest.provenance.qualificationHarness.manifest.path, limit: 4_194_304, check: 'provenance.qualificationHarness' },
  { name: 'decision catalog', path: value => value.decisionCatalogPath, limit: 1_048_576, check: 'decision-catalog' },
];

test('preflight rejects symlinked provenance, package, tool, lock, and catalog files', async t => {
  for (const entry of provenanceFiles) {
    await t.test(entry.name, async t => {
      const value = await fixture();
      t.after(() => rm(value.scratch, { recursive: true, force: true }));
      const configured = entry.path(value);
      const original = `${configured}.original`;
      await rename(configured, original);
      await symlink(original, configured);
      const execution = invoke(value.preflightRequest, value.scratch);
      assert.equal(execution.status, 1, `${entry.name}: ${execution.stderr}`);
      assert.equal(resultOf(execution).checks.find(check => check.name === entry.check).ok, false);
    });
  }
});

test('preflight rejects oversized provenance, package, tool, lock, and catalog files', async t => {
  for (const entry of provenanceFiles) {
    await t.test(entry.name, async t => {
      const value = await fixture();
      t.after(() => rm(value.scratch, { recursive: true, force: true }));
      await truncate(entry.path(value), entry.limit + 1);
      const execution = invoke(value.preflightRequest, value.scratch);
      assert.equal(execution.status, 1, `${entry.name}: ${execution.stderr}`);
      assert.equal(resultOf(execution).checks.find(check => check.name === entry.check).ok, false);
    });
  }
});

function raceOpen(target, state) {
  const expected = path.resolve(target);
  return async (openedPath, flags) => {
    const handle = await open(openedPath, flags);
    if (!state.fired && path.resolve(openedPath) === expected) {
      state.fired = true;
      await rename(expected, `${expected}.opened`);
      await writeFile(expected, 'substituted bytes\n');
    }
    return handle;
  };
}

test('provenance inspection rejects deterministic rename substitutions', async t => {
  const cases = [
    { name: 'package', path: value => value.runRequest.provenance.package.artifact, record: result => result.package },
    { name: 'tool', path: value => value.runRequest.provenance.tools.mdlm.path, record: result => result.tools.mdlm },
    { name: 'lock', path: value => value.runRequest.provenance.tooling.lock.path, record: result => result.tooling },
    { name: 'manifest', path: value => value.runRequest.provenance.qualificationHarness.manifest.path, record: result => result.qualificationHarness },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async t => {
      const value = await fixture();
      t.after(() => rm(value.scratch, { recursive: true, force: true }));
      const state = { fired: false };
      const provenance = await inspectProvenance(value.runRequest.provenance, 30_000, {
        openFile: raceOpen(entry.path(value), state),
      });
      assert.equal(state.fired, true);
      assert.equal(entry.record(provenance).matches, false);
    });
  }
});

test('decision catalog binding rejects rename substitution and records exact bytes', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  const state = { fired: false };
  await assert.rejects(
    bindDecisionCatalogFile(value.decisionCatalogPath, { openFile: raceOpen(value.decisionCatalogPath, state) }),
    /changed while it was being read/,
  );
  assert.equal(state.fired, true);

  await rename(`${value.decisionCatalogPath}.opened`, value.decisionCatalogPath);
  let execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(execution.status, 0, execution.stderr);
  const first = resultOf(execution).catalog;
  const substitutedBytes = Buffer.from(`${JSON.stringify(value.decisionCatalog, null, 2)}\n`);
  await writeFile(value.decisionCatalogPath, substitutedBytes);
  execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(execution.status, 0, execution.stderr);
  const second = resultOf(execution).catalog;
  assert.deepEqual(second, {
    path: value.decisionCatalogPath,
    bytes: substitutedBytes.length,
    digest: digest(substitutedBytes),
  });
  assert.notEqual(second.digest, first.digest);
});

test('public preflight rejects duplicate decision catalog members before JSON collapse', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  const catalog = JSON.stringify(value.decisionCatalog).replace(
    '"contract":"mdlm-demo-decision-catalog@1"',
    '"contract":"mdlm-demo-decision-catalog@1","contract":"mdlm-demo-decision-catalog@1"',
  );
  await writeFile(value.decisionCatalogPath, `${catalog}\n`);

  const execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(execution.status, 1);
  assert.match(resultOf(execution).checks.find(check => check.name === 'decision-catalog').error, /duplicate object member/);
});

test('preflight rejects duplicate JSON members before ordinary JSON collapse', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));

  const wrapper = JSON.stringify(value.preflightRequest).replace(
    '"contract":"mdlm-demo-preflight-request@1"',
    '"contract":"mdlm-demo-preflight-request@1","contract":"mdlm-demo-preflight-request@1"',
  );
  let execution = exec(process.execPath, [cli, 'preflight'], value.scratch, `${wrapper}\n`);
  assert.equal(execution.status, 1);
  assert.match(resultOf(execution).checks[0].error, /duplicate object member.*contract/i);

  const target = JSON.stringify(value.runRequest).replace(
    `"assignmentId":"${value.runRequest.assignmentId}"`,
    `"assignmentId":"${value.runRequest.assignmentId}","assignmentId":"${value.runRequest.assignmentId}"`,
  );
  const bytes = Buffer.from(`${target}\n`);
  await writeFile(value.runRequestPath, bytes);
  value.preflightRequest.input.digest = digest(bytes);
  execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(execution.status, 1);
  assert.match(resultOf(execution).checks.find(check => check.name === 'input').error, /duplicate object member.*assignmentId/i);
});

test('preflight recursively rejects unpaired UTF-16 scalars', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  value.runRequest.assignmentId = '\ud800';
  const bytes = await value.writeRunRequest();
  value.preflightRequest.input.digest = digest(bytes);
  const execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(execution.status, 1);
  assert.match(resultOf(execution).checks.find(check => check.name === 'input').error, /Unicode scalar|UTF-16/i);
});

test('one closed run-request schema validates optional paths, enums, and nested extras', async t => {
  const cases = [
    { name: 'adapterInputsPath type', mutate: request => { request.adapterInputsPath = 7; } },
    { name: 'adapterInputsPath absolute path', mutate: request => { request.adapterInputsPath = 'relative.json'; } },
    { name: 'signal enum', mutate: request => { request.signal = 'invented-stop'; } },
    { name: 'operator nested extra', mutate: request => { request.operator.unexpected = true; } },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async t => {
      const value = await fixture();
      t.after(() => rm(value.scratch, { recursive: true, force: true }));
      entry.mutate(value.runRequest);
      const bytes = await value.writeRunRequest();
      value.preflightRequest.input.digest = digest(bytes);
      const execution = invoke(value.preflightRequest, value.scratch);
      assert.equal(execution.status, 1);
      assert.equal(resultOf(execution).checks.find(check => check.name === 'run-request').ok, false);
    });
  }
});

test('preflight never resolves Git through PATH or exposes provider credentials to it', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  const fakeDirectory = path.join(value.scratch, 'fake-bin');
  const marker = path.join(value.scratch, 'fake-git-ran');
  const fakeGit = path.join(fakeDirectory, 'git');
  await mkdir(fakeDirectory);
  await writeFile(fakeGit, `#!/bin/sh\nprintf '%s' "$OPENAI_API_KEY" > '${marker}'\ncase "$PWD:$1:$2" in\n  '${value.source}:rev-parse:HEAD^{commit}') printf '%s\\n' '${value.runRequest.provenance.source.commit}' ;;\n  '${value.source}:rev-parse:HEAD^{tree}') printf '%s\\n' '${value.runRequest.provenance.source.tree}' ;;\n  '${value.harness}:rev-parse:HEAD^{commit}') printf '%s\\n' '${value.runRequest.provenance.qualificationHarness.commit}' ;;\n  '${value.harness}:rev-parse:HEAD^{tree}') printf '%s\\n' '${value.runRequest.provenance.qualificationHarness.tree}' ;;\nesac\nexit 0\n`);
  await chmod(fakeGit, 0o755);
  const execution = invoke(value.preflightRequest, value.scratch, {
    ...process.env,
    PATH: `${fakeDirectory}:${process.env.PATH}`,
    OPENAI_API_KEY: 'must-not-reach-git',
  });
  assert.equal(execution.status, 0, execution.stderr);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  const result = resultOf(execution);
  assert.match(result.provenance?.git?.path ?? '', /^\//);
  assert.match(result.provenance?.git?.digest ?? '', /^sha256:/);
});

test('preflight binds an optional expected Git executable digest', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  value.runRequest.provenance.git = { path: '/usr/bin/git', digest: await fileDigest('/usr/bin/git') };
  let bytes = await value.writeRunRequest();
  value.preflightRequest.input.digest = digest(bytes);
  let execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(resultOf(execution).provenance.git.expectedDigest, value.runRequest.provenance.git.digest);

  value.runRequest.provenance.git.digest = digest('not Git');
  bytes = await value.writeRunRequest();
  value.preflightRequest.input.digest = digest(bytes);
  execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(execution.status, 1);
  assert.match(resultOf(execution).checks.find(check => check.name === 'provenance').error, /Git executable differs/);
});

test('preflight rejects a caller-selected Git executable without running it', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  const marker = path.join(value.scratch, 'caller-git-ran');
  const fakeGit = path.join(value.scratch, 'caller-git');
  await writeFile(fakeGit, `#!/bin/sh\nprintf ran > '${marker}'\nexit 0\n`);
  await chmod(fakeGit, 0o755);
  value.runRequest.provenance.git = { path: fakeGit, digest: await fileDigest(fakeGit) };
  const bytes = await value.writeRunRequest();
  value.preflightRequest.input.digest = digest(bytes);

  const execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(execution.status, 1);
  assert.match(resultOf(execution).checks.find(check => check.name === 'run-request').error, /\/usr\/bin\/git/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('Git executable hashing is bounded when the opened file grows', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  const marker = path.join(value.scratch, 'grown-git-ran');
  const fakeGit = path.join(value.scratch, 'grown-git');
  await writeFile(fakeGit, `#!/bin/sh\nprintf ran > '${marker}'\nexit 0\n`);
  await chmod(fakeGit, 0o755);
  const maximumBytes = (await readFile(fakeGit)).length + 8;
  let grew = false;

  await assert.rejects(inspectProvenance(value.runRequest.provenance, 30_000, {
    gitPath: fakeGit,
    gitExecutableMaxBytes: maximumBytes,
    afterGitExecutableStat: async () => {
      grew = true;
      await writeFile(fakeGit, 'x'.repeat(128), { flag: 'a' });
    },
  }), new RegExp(`Git executable exceeds ${maximumBytes}-byte limit`));
  assert.equal(grew, true);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('preflight disables repository-local fsmonitor execution', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  const marker = path.join(value.scratch, 'fsmonitor-ran');
  const monitor = path.join(value.scratch, 'fsmonitor.sh');
  await writeFile(monitor, `#!/bin/sh\nprintf '%s' "$OPENAI_API_KEY" > '${marker}'\nexit 0\n`);
  await chmod(monitor, 0o755);
  git(['config', 'core.fsmonitor', monitor], value.source);
  git(['config', 'core.fsmonitorHookVersion', '2'], value.source);
  const execution = invoke(value.preflightRequest, value.scratch, {
    ...process.env,
    OPENAI_API_KEY: 'must-not-reach-fsmonitor',
  });
  assert.equal(execution.status, 0, execution.stderr);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('preflight status ignores repository attributes that select local clean filters', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  const marker = path.join(value.scratch, 'clean-filter-ran');
  const filter = path.join(value.scratch, 'clean-filter.sh');
  await writeFile(path.join(value.source, '.gitattributes'), 'README.md filter=untrusted\n');
  git(['add', '.gitattributes'], value.source);
  git(['commit', '-m', 'add attributes'], value.source);
  value.runRequest.provenance.source.commit = git(['rev-parse', 'HEAD^{commit}'], value.source);
  value.runRequest.provenance.source.tree = git(['rev-parse', 'HEAD^{tree}'], value.source);
  await writeFile(filter, `#!/bin/sh\nprintf ran > '${marker}'\ncat\n`);
  await chmod(filter, 0o755);
  git(['config', 'filter.untrusted.clean', filter], value.source);
  git(['config', 'filter.untrusted.required', 'true'], value.source);
  await writeFile(path.join(value.source, 'README.md'), 'dirty! fixture\n');
  const bytes = await value.writeRunRequest();
  value.preflightRequest.input.digest = digest(bytes);

  const execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(execution.status, 1);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('preflight rejects Git info attributes before they can select a local clean filter', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  const marker = path.join(value.scratch, 'info-clean-filter-ran');
  const filter = path.join(value.scratch, 'info-clean-filter.sh');
  await writeFile(path.join(value.source, '.git', 'info', 'attributes'), 'README.md filter=untrusted\n');
  await writeFile(filter, `#!/bin/sh\nprintf ran > '${marker}'\ncat\n`);
  await chmod(filter, 0o755);
  git(['config', 'filter.untrusted.clean', filter], value.source);
  git(['config', 'filter.untrusted.required', 'true'], value.source);
  await writeFile(path.join(value.source, 'README.md'), 'dirty! fixture\n');

  const execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(execution.status, 1);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('preflight never executes a worktree-scoped clean filter', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  const marker = path.join(value.scratch, 'worktree-clean-filter-ran');
  const filter = path.join(value.scratch, 'worktree-clean-filter.sh');
  await writeFile(path.join(value.source, '.gitattributes'), 'README.md filter=untrusted\n');
  git(['add', '.gitattributes'], value.source);
  git(['commit', '-m', 'add attributes'], value.source);
  value.runRequest.provenance.source.commit = git(['rev-parse', 'HEAD^{commit}'], value.source);
  value.runRequest.provenance.source.tree = git(['rev-parse', 'HEAD^{tree}'], value.source);
  await writeFile(filter, `#!/bin/sh\nprintf ran > '${marker}'\ncat\n`);
  await chmod(filter, 0o755);
  git(['config', 'extensions.worktreeConfig', 'true'], value.source);
  git(['config', '--worktree', 'filter.untrusted.clean', filter], value.source);
  await writeFile(path.join(value.source, 'README.md'), 'dirty! fixture\n');
  const bytes = await value.writeRunRequest();
  value.preflightRequest.input.digest = digest(bytes);

  const execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(execution.status, 1);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('raw cleanliness remains filter-free when repository controls change after identity reads', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  const marker = path.join(value.scratch, 'raced-clean-filter-ran');
  const filter = path.join(value.scratch, 'raced-clean-filter.sh');
  let raced = false;
  const provenance = await inspectProvenance(value.runRequest.provenance, 30_000, {
    afterGitPreIdentity: async ({ label }) => {
      if (label !== 'source') return;
      raced = true;
      await writeFile(filter, `#!/bin/sh\nprintf ran > '${marker}'\ncat\n`);
      await chmod(filter, 0o755);
      git(['config', 'extensions.worktreeConfig', 'true'], value.source);
      git(['config', '--worktree', 'filter.untrusted.clean', filter], value.source);
      await writeFile(path.join(value.source, '.git', 'info', 'attributes'), 'README.md filter=untrusted\n');
      await writeFile(path.join(value.source, 'README.md'), 'dirty! fixture\n');
    },
  });
  assert.equal(raced, true);
  assert.equal(provenance.source.matches, false);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('preflight authenticates SHA-256 repositories without a SHA-1 attribute source', async t => {
  const value = await fixture({ objectFormat: 'sha256' });
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  const execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(value.runRequest.provenance.source.commit.length, 64);
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(resultOf(execution).status, 'PASS');
});

test('provenance inspection rejects a repository pathname replacement between Git observations', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  const moved = `${value.source}.opened`;
  let fired = false;
  const provenance = await inspectProvenance(value.runRequest.provenance, 30_000, {
    afterGitPreIdentity: async ({ label }) => {
      if (label !== 'source') return;
      fired = true;
      await rename(value.source, moved);
      await mkdir(value.source);
    },
  });
  assert.equal(fired, true);
  assert.equal(provenance.source.matches, false);
  assert.match(provenance.source.error, /repository changed while Git inspected it/);
});

test('preflight rejects symbolic-link components in repository paths', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  const alias = path.join(value.scratch, 'source-alias');
  await symlink(value.source, alias);
  value.runRequest.provenance.source.repository = alias;
  const bytes = await value.writeRunRequest();
  value.preflightRequest.input.digest = digest(bytes);
  const execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(execution.status, 1);
  assert.equal(resultOf(execution).checks.find(check => check.name === 'provenance.source').ok, false);
});

test('descriptor-rooted tooling traversal rejects replacement, growth, and independent bounds', async t => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-tooling-bounds-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const file = path.join(scratch, 'tool');
  await writeFile(file, 'original');

  let fired = false;
  await assert.rejects(toolingTreeIdentity(scratch, {
    openFile: async (openedPath, flags) => {
      const handle = await open(openedPath, flags);
      if (!fired) {
        fired = true;
        await rename(file, `${file}.opened`);
        await writeFile(file, 'replacement');
      }
      return handle;
    },
  }), /changed while it was (?:opened|being read)/);
  assert.equal(fired, true);

  await rm(file);
  await rename(`${file}.opened`, file);
  fired = false;
  await assert.rejects(toolingTreeIdentity(scratch, {
    openFile: async (openedPath, flags) => {
      const handle = await open(openedPath, flags);
      if (!fired) {
        fired = true;
        await truncate(file, 32);
      }
      return handle;
    },
  }), /changed while it was (?:opened|being read)/);
  assert.equal(fired, true);

  for (const [name, limits, pattern] of [
    ['entries', { entries: 1 }, /entry limit/],
    ['files', { files: 0 }, /file limit/],
    ['depth', { depth: 0 }, /depth limit/],
    ['file bytes', { fileBytes: 1 }, /byte limit/],
    ['total bytes', { totalBytes: 1 }, /byte limit/],
  ]) {
    await assert.rejects(toolingTreeIdentity(scratch, { limits }), pattern, name);
  }
});

test('preflight has no filesystem output path and rejects attempts to add one', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  const output = path.join(value.scratch, 'preflight-result.json');
  const request = { ...value.preflightRequest, output };
  const execution = invoke(request, value.scratch);
  assert.equal(execution.status, 1);
  assert.equal(resultOf(execution).checks[0].ok, false);
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});

test('preflight rejects hard-linked aliases in the tooling closure', async t => {
  const value = await fixture();
  t.after(() => rm(value.scratch, { recursive: true, force: true }));
  const mdlm = value.runRequest.commands.mdlm;
  const mdlmPi = value.runRequest.commands.mdlmPi;
  await rm(mdlmPi);
  await link(mdlm, mdlmPi);
  value.runRequest.provenance.tools.mdlmPi.digest = await fileDigest(mdlmPi);
  value.runRequest.provenance.tooling.digest = await toolingTreeDigest(value.tooling);
  const bytes = await value.writeRunRequest();
  value.preflightRequest.input.digest = digest(bytes);
  const execution = invoke(value.preflightRequest, value.scratch);
  assert.equal(execution.status, 1);
  assert.equal(resultOf(execution).checks.find(check => check.name === 'provenance.tooling').ok, false);
});
