import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  commandRecord, commandSucceeded, environmentPolicy, fileIdentity, gitEnvironment,
  parseJsonBytes, requireContract, runProcess, sha256,
} from './util.mjs';

const commandNames = ['head', 'tree', 'status', 'stagedDiff', 'worktreeDiff', 'doctor', 'mdlmStatus', 'assignment'];

export async function snapshot(request) {
  requireContract(request, 'mdlm-demo-snapshot-request@1');
  const directory = path.resolve(requiredString(request.snapshotDirectory, 'snapshotDirectory'));
  const repository = path.resolve(requiredString(request.repository, 'repository'));
  const mdlm = requiredString(request.provenance?.tools?.mdlm?.path, 'provenance.tools.mdlm.path');
  const assignmentId = requiredString(request.assignmentId, 'assignmentId');
  const timeoutMs = boundedTimeout(request.timeoutMs);
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const commandsDirectory = path.join(directory, 'commands');
  await mkdir(commandsDirectory, { mode: 0o700 });

  const gitOptions = { cwd: repository, timeoutMs, env: gitEnvironment() };
  const processOptions = { cwd: repository, timeoutMs };
  const invocations = {
    head: await runProcess('git', ['rev-parse', 'HEAD^{commit}'], gitOptions),
    tree: await runProcess('git', ['rev-parse', 'HEAD^{tree}'], gitOptions),
    status: await runProcess('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], gitOptions),
    stagedDiff: await runProcess('git', ['diff', '--binary', '--no-ext-diff', '--cached', 'HEAD', '--'], gitOptions),
    worktreeDiff: await runProcess('git', ['diff', '--binary', '--no-ext-diff', '--'], gitOptions),
    doctor: await runProcess(mdlm, ['doctor', '--json'], processOptions),
    mdlmStatus: await runProcess(mdlm, ['status', '--json'], processOptions),
    assignment: await runProcess(mdlm, ['assignment', 'show', assignmentId, '--json'], processOptions),
  };
  for (const [name, result] of Object.entries(invocations)) {
    await writeExclusive(path.join(commandsDirectory, `${name}.stdout`), result.stdout);
    await writeExclusive(path.join(commandsDirectory, `${name}.stderr`), result.stderr);
    await writeExclusive(path.join(commandsDirectory, `${name}.json`), json(commandRecord(result)));
  }

  const failures = commandFailures(invocations);
  const parsed = {};
  for (const [name, label] of [['doctor', 'doctor'], ['mdlmStatus', 'status'], ['assignment', 'assignment']]) {
    if (!commandSucceeded(invocations[name])) continue;
    try { parsed[name] = parseJsonBytes(invocations[name].stdout, label); }
    catch (error) { failures.push({ command: name === 'mdlmStatus' ? 'status' : name, kind: 'malformed-json', detail: error.message }); }
  }
  const lifecycleRepository = lifecycleFingerprint(invocations, failures);
  const assignment = parsed.assignment?.assignment && typeof parsed.assignment.assignment === 'object'
    ? {
        ...parsed.assignment.assignment,
        disposition: parsed.assignment.disposition,
        selected: parsed.assignment.selected,
        package: parsed.assignment.package,
        repository: parsed.assignment.repository,
        scenarioReference: parsed.assignment.scenarioReference,
        malformedResponses: parsed.assignment.malformedResponses,
      }
    : null;
  const journal = await captureOptional(request.journalPath);
  const piJournal = await captureOptional(request.piJournalPath);
  const provenance = await inspectProvenance(request.provenance, timeoutMs);
  for (const [identity, value] of [['source', provenance.source], ['qualificationHarness', provenance.qualificationHarness]]) {
    for (const [name, record] of Object.entries(value.commands ?? {})) {
      if (!recordSucceeded(record)) failures.push({ command: `${identity}.${name}`, kind: commandRecordFailureKind(record), exitStatus: record.exitStatus, signal: record.signal });
    }
  }
  const uniqueFailures = deduplicateFailures(failures);
  const record = {
    contract: 'mdlm-demo-snapshot@2',
    createdAt: new Date().toISOString(),
    postRun: request.postRun === true,
    repository,
    lifecycleRepository,
    assignmentRepository: assignment?.repository ?? null,
    git: {
      head: commandRecord(invocations.head),
      tree: commandRecord(invocations.tree),
      status: commandRecord(invocations.status),
      stagedDiff: commandRecord(invocations.stagedDiff),
      worktreeDiff: commandRecord(invocations.worktreeDiff),
    },
    commands: {
      doctor: commandRecord(invocations.doctor),
      status: commandRecord(invocations.mdlmStatus),
      assignment: commandRecord(invocations.assignment),
    },
    assignment,
    status: parsed.mdlmStatus ?? null,
    diagnosis: parsed.doctor ?? null,
    journal,
    piJournal,
    provenance,
    environmentPolicy,
    commandFailure: uniqueFailures.length === 0 ? null : { kind: 'command-failure', failures: uniqueFailures },
  };
  await writeExclusive(path.join(directory, 'snapshot.json'), json(record));
  const files = await manifestFiles(directory);
  const manifestBytes = json({ contract: 'mdlm-demo-evidence-manifest@1', files });
  await writeExclusive(path.join(directory, 'manifest.json'), manifestBytes);
  await makeReadOnly(directory, [path.join(directory, 'manifest.json'), ...files.map(item => path.join(directory, item.path))]);
  return {
    contract: 'mdlm-demo-snapshot-created@1',
    status: uniqueFailures.length === 0 ? 'complete' : 'command-failure',
    snapshotDirectory: directory,
    digest: sha256(manifestBytes),
    ...(uniqueFailures.length === 0 ? {} : { failures: uniqueFailures }),
  };
}

function lifecycleFingerprint(invocations, failures) {
  for (const name of ['head', 'tree', 'status', 'stagedDiff', 'worktreeDiff']) {
    if (!commandSucceeded(invocations[name])) return null;
  }
  const head = invocations.head.stdout.toString('utf8').trim();
  const tree = invocations.tree.stdout.toString('utf8').trim();
  if (!/^[0-9a-f]{40,64}$/.test(head) || !/^[0-9a-f]{40,64}$/.test(tree)) {
    failures.push({ command: 'git-fingerprint', kind: 'malformed-output', detail: 'Git HEAD or tree is not an object identity' });
    return null;
  }
  const staged = invocations.stagedDiff.stdout.toString('utf8');
  const worktree = invocations.worktreeDiff.stdout.toString('utf8');
  const trackedState = sha256(Buffer.from(`${head}\0staged\0${staged}\0worktree\0${worktree}`));
  return {
    head,
    tree,
    trackedState,
    clean: invocations.status.stdout.length === 0,
    porcelainSha256: sha256(invocations.status.stdout),
  };
}

function commandFailures(invocations) {
  const failures = [];
  for (const [name, result] of Object.entries(invocations)) {
    if (commandSucceeded(result)) continue;
    let kind = 'nonzero-exit';
    if (result.spawnError !== null) kind = 'spawn-error';
    else if (result.timedOut) kind = 'timeout';
    else if (result.outputLimitExceeded) kind = 'output-limit';
    else if (result.signal !== null) kind = 'signal';
    failures.push({ command: name === 'mdlmStatus' ? 'status' : name, kind, exitStatus: result.exitStatus, signal: result.signal });
  }
  return failures;
}

async function inspectProvenance(provenance, timeoutMs) {
  const source = await gitIdentity(provenance?.source, timeoutMs, 'source');
  const qualificationHarness = await gitIdentity(provenance?.qualificationHarness, timeoutMs, 'qualificationHarness');
  qualificationHarness.manifest = await expectedFileRecord(
    provenance?.qualificationHarness?.manifest?.path,
    provenance?.qualificationHarness?.manifest?.digest,
    'qualification harness manifest',
  );
  qualificationHarness.matches &&= qualificationHarness.manifest.matches;
  const packageIdentity = await expectedFileRecord(provenance?.package?.artifact, provenance?.package?.digest, 'package artifact');
  const mdlm = await expectedFileRecord(provenance?.tools?.mdlm?.path, provenance?.tools?.mdlm?.digest, 'mdlm');
  const mdlmPi = await expectedFileRecord(provenance?.tools?.mdlmPi?.path, provenance?.tools?.mdlmPi?.digest, 'mdlm-pi');
  return {
    source,
    package: packageIdentity,
    tools: { mdlm, mdlmPi },
    qualificationHarness,
    valid: [source, packageIdentity, mdlm, mdlmPi, qualificationHarness].every(item => item.matches),
  };
}

async function gitIdentity(value, timeoutMs, label) {
  let repository;
  let expectedCommit;
  let expectedTree;
  try {
    repository = path.resolve(requiredString(value?.repository, `provenance.${label}.repository`));
    expectedCommit = requiredObjectId(value?.commit, `provenance.${label}.commit`);
    expectedTree = requiredObjectId(value?.tree, `provenance.${label}.tree`);
  } catch (error) {
    return { repository: value?.repository ?? null, expectedCommit: value?.commit ?? null, expectedTree: value?.tree ?? null, observedCommit: null, observedTree: null, clean: null, matches: false, error: error.message, commands: {} };
  }
  const options = { cwd: repository, timeoutMs, env: gitEnvironment() };
  const commit = await runProcess('git', ['rev-parse', 'HEAD^{commit}'], options);
  const tree = await runProcess('git', ['rev-parse', 'HEAD^{tree}'], options);
  const status = await runProcess('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], options);
  const observedCommit = commandSucceeded(commit) ? commit.stdout.toString('utf8').trim() : null;
  const observedTree = commandSucceeded(tree) ? tree.stdout.toString('utf8').trim() : null;
  const clean = commandSucceeded(status) ? status.stdout.length === 0 : null;
  return {
    repository,
    expectedCommit,
    expectedTree,
    observedCommit,
    observedTree,
    clean,
    matches: observedCommit === expectedCommit && observedTree === expectedTree && clean === true,
    commands: { commit: commandRecord(commit), tree: commandRecord(tree), status: commandRecord(status) },
  };
}

async function expectedFileRecord(file, expectedDigest, label) {
  try {
    const identity = await fileIdentity(requiredString(file, label));
    const digest = requiredDigest(expectedDigest, `${label} digest`);
    return { ...identity, expectedDigest: digest, matches: identity.digest === digest };
  } catch (error) {
    return { path: typeof file === 'string' ? path.resolve(file) : null, realpath: null, digest: null, bytes: null, expectedDigest: expectedDigest ?? null, matches: false, error: error.message };
  }
}

async function captureOptional(file) {
  if (typeof file !== 'string') return { present: false };
  try {
    const bytes = await readFile(file);
    return { present: true, path: path.resolve(file), bytesBase64: bytes.toString('base64'), digest: sha256(bytes) };
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false, path: path.resolve(file) };
    return { present: false, path: path.resolve(file), error: error.message };
  }
}

async function manifestFiles(root) {
  const names = ['snapshot.json'];
  for (const name of commandNames) for (const suffix of ['stdout', 'stderr', 'json']) names.push(`commands/${name}.${suffix}`);
  const output = [];
  for (const name of names.sort()) {
    const bytes = await readFile(path.join(root, name));
    output.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return output;
}

async function makeReadOnly(root, files) {
  for (const file of files) await chmod(file, 0o400);
  await chmod(path.join(root, 'commands'), 0o500);
  await chmod(root, 0o500);
}

async function writeExclusive(file, bytes) { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
function deduplicateFailures(failures) { return failures.filter((item, index) => failures.findIndex(other => other.command === item.command && other.kind === item.kind) === index); }
function recordSucceeded(record) { return record.exitStatus === 0 && record.signal === null && record.timedOut === false && record.outputLimitExceeded === false && record.spawnError === null; }
function commandRecordFailureKind(record) {
  if (record.spawnError !== null) return 'spawn-error';
  if (record.timedOut) return 'timeout';
  if (record.outputLimitExceeded) return 'output-limit';
  if (record.signal !== null) return 'signal';
  return 'nonzero-exit';
}
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function requiredString(value, label) { if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`); return value; }
function requiredObjectId(value, label) { if (!/^[0-9a-f]{40,64}$/.test(value ?? '')) throw new Error(`${label} must be a lowercase Git object identity`); return value; }
function requiredDigest(value, label) { if (!/^sha256:[0-9a-f]{64}$/.test(value ?? '')) throw new Error(`${label} must be sha256:<64 lowercase hex>`); return value; }
function boundedTimeout(value) { const timeout = value ?? 30_000; if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 900_000) throw new Error('timeoutMs must be between 1 and 900000'); return timeout; }
