import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { toolingTreeDigest } from './provenance-fixture.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin/mdlm-demo-runner.mjs');
const run036HarnessPin = '8156dfb33344dfd705266307daf2379dc9026a80';

function exec(program, args, cwd, input) {
  return spawnSync(program, args, { cwd, input, encoding: 'utf8', timeout: 20_000 });
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

async function fixture() {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-preflight-'));
  const source = path.join(scratch, 'source');
  const harness = path.join(scratch, 'qualification-harness');
  const tooling = path.join(scratch, 'tooling');
  const repository = path.join(scratch, 'lifecycle-repository');
  for (const directory of [source, harness, tooling, repository]) await mkdir(directory);
  for (const directory of [source, harness, repository]) {
    git(['init', '-b', 'main'], directory);
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
    argv: [process.execPath, cli, 'run', '--input', runRequestPath],
  };
  return { scratch, source, harness, runRequest, runRequestPath, writeRunRequest, preflightRequest };
}

function invoke(request, cwd) {
  return exec(process.execPath, [cli, 'preflight'], cwd, `${JSON.stringify(request)}\n`);
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
  assert.match(result.limitation, /does not authorize.*Assignment.*publication.*lifecycle transition.*qualification/i);
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
  assert.equal(result.input.digest, value.preflightRequest.input.digest);
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
