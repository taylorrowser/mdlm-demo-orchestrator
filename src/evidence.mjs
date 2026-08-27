import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readCanonicalFile } from './canonical-file.mjs';
import { validateDoctor } from './contracts.mjs';
import { normalizeProcessPackage } from './process-package.mjs';
import {
  commandRecord, commandSucceeded, environmentPolicy, fileIdentity, gitEnvironment,
  parseJsonBytes, requireContract, runProcess, sha256, toolingTreeIdentity,
} from './util.mjs';

const commandNames = ['head', 'tree', 'status', 'stagedDiff', 'worktreeDiff', 'doctor', 'mdlmStatus', 'assignment'];
const snapshotManifestPaths = [
  'snapshot.json',
  ...commandNames.flatMap(name => ['json', 'stderr', 'stdout'].map(extension => `commands/${name}.${extension}`)),
].sort();

export async function verifySnapshot(snapshotDirectory, expectedDigest, expectedPostRun = true) {
  if (typeof snapshotDirectory !== 'string' || !path.isAbsolute(snapshotDirectory)) {
    throw new Error('checkpointRecovery.snapshotDirectory must be an absolute path');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedDigest ?? '')) {
    throw new Error('checkpointRecovery.digest must be sha256:<64 lowercase hex>');
  }
  const directory = path.resolve(snapshotDirectory);
  await requireCanonicalSnapshotDirectory(directory);
  const rootEntries = await readdir(directory, { withFileTypes: true });
  if (!sameJson(rootEntries.map(entry => entry.name).sort(), ['commands', 'manifest.json', 'snapshot.json'])) {
    throw new Error('pinned snapshot root contains missing or extra entries');
  }
  const commandsEntry = rootEntries.find(entry => entry.name === 'commands');
  if (!commandsEntry?.isDirectory() || commandsEntry.isSymbolicLink()) {
    throw new Error('pinned snapshot commands entry is not a canonical directory');
  }
  const commandsDirectory = path.join(directory, 'commands');
  await requireCanonicalSnapshotDirectory(commandsDirectory);
  const commandEntries = await readdir(commandsDirectory, { withFileTypes: true });
  const expectedCommandFiles = snapshotManifestPaths.filter(name => name.startsWith('commands/')).map(name => path.basename(name));
  if (!sameJson(commandEntries.map(entry => entry.name).sort(), expectedCommandFiles) ||
      commandEntries.some(entry => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('pinned snapshot commands contain missing, extra, or non-regular files');
  }

  const manifestEvidence = await readCanonicalSnapshotFile(path.join(directory, 'manifest.json'));
  if (sha256(manifestEvidence.bytes) !== expectedDigest) throw new Error('pinned snapshot manifest digest differs from the operator pin');
  let manifest;
  try { manifest = JSON.parse(manifestEvidence.bytes.toString('utf8')); }
  catch { throw new Error('pinned snapshot manifest is not valid JSON'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      !sameJson(Object.keys(manifest).sort(), ['contract', 'files']) ||
      manifest.contract !== 'mdlm-demo-evidence-manifest@1' || !Array.isArray(manifest.files)) {
    throw new Error('pinned snapshot manifest has an unsupported shape');
  }
  if (!sameJson(manifest.files.map(item => item?.path), snapshotManifestPaths)) {
    throw new Error('pinned snapshot manifest is incomplete, unordered, or ambiguous');
  }
  const evidenceByPath = new Map();
  for (const item of manifest.files) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        !sameJson(Object.keys(item).sort(), ['bytes', 'path', 'sha256']) ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^sha256:[0-9a-f]{64}$/.test(item.sha256 ?? '')) {
      throw new Error('pinned snapshot manifest file record has an unsupported shape');
    }
    const evidence = await readCanonicalSnapshotFile(path.join(directory, item.path));
    if (evidence.bytes.length !== item.bytes || sha256(evidence.bytes) !== item.sha256) {
      throw new Error(`pinned snapshot file bytes differ from the manifest: ${item.path}`);
    }
    evidenceByPath.set(item.path, evidence);
  }

  let record;
  try { record = JSON.parse(evidenceByPath.get('snapshot.json').bytes.toString('utf8')); }
  catch { throw new Error('pinned snapshot record is not valid JSON'); }
  if (record?.contract !== 'mdlm-demo-snapshot@2' || record.postRun !== expectedPostRun ||
      record.commandFailure !== null || record.provenance?.valid !== true) {
    throw new Error('pinned snapshot is not a complete post-run snapshot');
  }
  const records = {
    head: record.git?.head,
    tree: record.git?.tree,
    status: record.git?.status,
    stagedDiff: record.git?.stagedDiff,
    worktreeDiff: record.git?.worktreeDiff,
    doctor: record.commands?.doctor,
    mdlmStatus: record.commands?.status,
    assignment: record.commands?.assignment,
  };
  for (const name of commandNames) {
    const recordBytes = evidenceByPath.get(`commands/${name}.json`).bytes;
    let command;
    try { command = JSON.parse(recordBytes.toString('utf8')); }
    catch { throw new Error(`pinned snapshot command record is not valid JSON: ${name}`); }
    const stdout = evidenceByPath.get(`commands/${name}.stdout`).bytes;
    const stderr = evidenceByPath.get(`commands/${name}.stderr`).bytes;
    if (!sameJson(command, records[name]) || command.stdoutBase64 !== stdout.toString('base64') ||
        command.stderrBase64 !== stderr.toString('base64') || command.stdoutSha256 !== sha256(stdout) ||
        command.stderrSha256 !== sha256(stderr) || command.observedOutputBytes !== stdout.length + stderr.length ||
        command.exitStatus !== 0 || command.signal !== null || command.spawnError !== null ||
        command.timedOut !== false || command.outputLimitExceeded !== false) {
      throw new Error(`pinned snapshot command evidence is inconsistent or incomplete: ${name}`);
    }
  }
  return {
    snapshotDirectory: directory,
    digest: expectedDigest,
    manifest: { path: manifestEvidence.path, bytes: manifestEvidence.bytes.length, digest: sha256(manifestEvidence.bytes) },
    snapshot: record,
  };
}

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
    try {
      const value = parseJsonBytes(invocations[name].stdout, label);
      if (name === 'doctor') validateDoctor(value);
      else if (name === 'mdlmStatus') validateStatus(value);
      else validateAssignmentState(value, assignmentId);
      parsed[name] = value;
    } catch (error) {
      failures.push({
        command: name === 'mdlmStatus' ? 'status' : name,
        kind: error.message.includes('returned invalid JSON') ? 'malformed-json' : 'semantic-contract',
        detail: error.message,
      });
    }
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
        retryAvailability: parsed.assignment.retryAvailability,
        malformedResponses: parsed.assignment.malformedResponses,
        terminalDiagnostics: parsed.assignment.terminalDiagnostics,
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
    status: uniqueFailures.length > 0 ? 'command-failure' : provenance.valid ? 'complete' : 'provenance-failure',
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

export const provenanceLimits = Object.freeze({
  packageBytes: 16_777_216,
  toolBytes: 16_777_216,
  lockBytes: 4_194_304,
  manifestBytes: 4_194_304,
});

export async function inspectProvenance(provenance, timeoutMs, options = {}) {
  const gitBinding = await openGitExecutable(provenance?.git, options);
  let source;
  let qualificationHarness;
  try {
    source = await gitIdentity(provenance?.source, timeoutMs, 'source', gitBinding, options);
    qualificationHarness = await gitIdentity(provenance?.qualificationHarness, timeoutMs, 'qualificationHarness', gitBinding, options);
    await verifyGitExecutable(gitBinding);
  } finally {
    await gitBinding.handle.close();
  }
  qualificationHarness.manifest = await expectedFileRecord(
    provenance?.qualificationHarness?.manifest?.path,
    provenance?.qualificationHarness?.manifest?.digest,
    'qualification harness manifest',
    provenanceLimits.manifestBytes,
    options,
  );
  qualificationHarness.matches &&= qualificationHarness.manifest.matches;
  qualificationHarness.repositoryLocator = typeof provenance?.qualificationHarness?.repositoryLocator === 'string'
    ? provenance.qualificationHarness.repositoryLocator
    : null;
  qualificationHarness.matches &&= qualificationHarness.repositoryLocator !== null && qualificationHarness.repositoryLocator.length > 0;
  const packageIdentity = await expectedFileRecord(
    provenance?.package?.artifact, provenance?.package?.digest, 'mdlm package artifact', provenanceLimits.packageBytes, options,
  );
  const piPackageIdentity = await expectedFileRecord(
    provenance?.piPackage?.artifact, provenance?.piPackage?.digest, 'mdlm-pi package artifact', provenanceLimits.packageBytes, options,
  );
  const mdlm = await expectedFileRecord(
    provenance?.tools?.mdlm?.path, provenance?.tools?.mdlm?.digest, 'mdlm', provenanceLimits.toolBytes, options,
  );
  const mdlmPi = await expectedFileRecord(
    provenance?.tools?.mdlmPi?.path, provenance?.tools?.mdlmPi?.digest, 'mdlm-pi', provenanceLimits.toolBytes, options,
  );
  const tooling = await expectedToolingRecord(provenance?.tooling, { mdlm, mdlmPi }, options);
  return {
    git: gitBinding.identity,
    source,
    package: packageIdentity,
    piPackage: piPackageIdentity,
    tooling,
    tools: { mdlm, mdlmPi },
    qualificationHarness,
    valid: [source, packageIdentity, piPackageIdentity, tooling, mdlm, mdlmPi, qualificationHarness].every(item => item.matches),
  };
}

async function gitIdentity(value, timeoutMs, label, gitBinding, options = {}) {
  let repository;
  let expectedCommit;
  let expectedTree;
  let repositoryHandle;
  try {
    repository = path.resolve(requiredString(value?.repository, `provenance.${label}.repository`));
    expectedCommit = requiredObjectId(value?.commit, `provenance.${label}.commit`);
    expectedTree = requiredObjectId(value?.tree, `provenance.${label}.tree`);
    repositoryHandle = await (options.openRepository ?? open)(
      repository,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = await repositoryHandle.stat({ bigint: true });
    if (!opened.isDirectory()) throw new Error(`provenance.${label}.repository is not a real directory`);
    const descriptorPath = `/proc/self/fd/${repositoryHandle.fd}`;
    const descriptorTarget = await realpath(descriptorPath);
    if (descriptorTarget !== repository) throw new Error(`provenance.${label}.repository has a symbolic-link path component`);
    const current = await lstat(repository, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(opened, current)) {
      throw new Error(`provenance.${label}.repository changed while it was opened`);
    }
    const processOptions = {
      cwd: descriptorPath,
      recordedCwd: repository,
      recordedProgram: gitBinding.identity.path,
      timeoutMs,
      env: gitEnvironment(),
    };
    const args = name => ['--no-optional-locks', ...name];
    const preCommit = await runProcess(gitBinding.program, args(['rev-parse', 'HEAD^{commit}']), processOptions);
    const preTree = await runProcess(gitBinding.program, args(['rev-parse', 'HEAD^{tree}']), processOptions);
    await options.afterGitPreIdentity?.({ label, repository, repositoryHandle });
    await rejectRepositoryFilters(gitBinding, args, processOptions, label);
    const status = await runProcess(
      gitBinding.program,
      args(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      processOptions,
    );
    const postCommit = await runProcess(gitBinding.program, args(['rev-parse', 'HEAD^{commit}']), processOptions);
    const postTree = await runProcess(gitBinding.program, args(['rev-parse', 'HEAD^{tree}']), processOptions);
    const observedCommit = commandSucceeded(preCommit) ? preCommit.stdout.toString('utf8').trim() : null;
    const observedTree = commandSucceeded(preTree) ? preTree.stdout.toString('utf8').trim() : null;
    const postObservedCommit = commandSucceeded(postCommit) ? postCommit.stdout.toString('utf8').trim() : null;
    const postObservedTree = commandSucceeded(postTree) ? postTree.stdout.toString('utf8').trim() : null;
    const clean = commandSucceeded(status) ? status.stdout.length === 0 : null;
    const descriptorAfter = await repositoryHandle.stat({ bigint: true });
    let pathAfter;
    try {
      pathAfter = await lstat(repository, { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`provenance.${label}.repository changed while Git inspected it`);
      throw error;
    }
    if (!sameIdentity(opened, descriptorAfter) || !sameIdentity(opened, pathAfter)) {
      throw new Error(`provenance.${label}.repository changed while Git inspected it`);
    }
    const stable = observedCommit === postObservedCommit && observedTree === postObservedTree;
    return {
      repository,
      repositoryIdentity: statIdentity(opened),
      git: gitBinding.identity,
      expectedCommit,
      expectedTree,
      observedCommit,
      observedTree,
      postObservedCommit,
      postObservedTree,
      clean,
      stable,
      matches: observedCommit === expectedCommit && observedTree === expectedTree && clean === true && stable,
      commands: {
        preCommit: commandRecord(preCommit), preTree: commandRecord(preTree), status: commandRecord(status),
        postCommit: commandRecord(postCommit), postTree: commandRecord(postTree),
      },
    };
  } catch (error) {
    return {
      repository: value?.repository ?? null,
      repositoryIdentity: null,
      git: gitBinding.identity,
      expectedCommit: value?.commit ?? null,
      expectedTree: value?.tree ?? null,
      observedCommit: null,
      observedTree: null,
      postObservedCommit: null,
      postObservedTree: null,
      clean: null,
      stable: false,
      matches: false,
      error: error.message,
      commands: {},
    };
  } finally {
    await repositoryHandle?.close();
  }
}

async function rejectRepositoryFilters(gitBinding, args, processOptions, label) {
  const filters = await runProcess(
    gitBinding.program,
    args(['config', '--local', '--includes', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$']),
    processOptions,
  );
  const noConfiguredFilter = filters.exitStatus === 1 && filters.signal === null && filters.spawnError === null &&
    filters.timedOut === false && filters.outputLimitExceeded === false &&
    filters.stdout.length === 0 && filters.stderr.length === 0;
  if (commandSucceeded(filters) && filters.stdout.length > 0) {
    throw new Error(`provenance.${label}.repository configures a clean or process filter`);
  }
  if (!noConfiguredFilter) throw new Error(`provenance.${label}.repository filter configuration could not be authenticated`);

  const attributes = await runProcess(
    gitBinding.program,
    args(['rev-parse', '--path-format=absolute', '--git-path', 'info/attributes']),
    processOptions,
  );
  if (!commandSucceeded(attributes)) throw new Error(`provenance.${label}.repository info attributes path could not be authenticated`);
  const attributesPath = attributes.stdout.toString('utf8').trim();
  if (!path.isAbsolute(attributesPath) || attributesPath.includes('\0')) {
    throw new Error(`provenance.${label}.repository info attributes path is invalid`);
  }
  try {
    await lstat(attributesPath);
    throw new Error(`provenance.${label}.repository has info/attributes`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function openGitExecutable(expected, options = {}) {
  const requestedPath = options.gitPath ?? '/usr/bin/git';
  if (!path.isAbsolute(requestedPath)) throw new Error('Git executable path must be absolute');
  const configuredPath = path.resolve(requestedPath);
  if (expected?.path !== undefined && expected.path !== configuredPath) {
    throw new Error(`Git executable path must be ${configuredPath}`);
  }
  const maximumBytes = options.gitExecutableMaxBytes ?? 67_108_864;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new Error('Git executable byte limit is invalid');
  let handle;
  try {
    handle = await (options.openGit ?? open)(configuredPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new Error(`Git executable is not a regular file: ${configuredPath}`);
    if ((Number(opened.mode) & 0o111) === 0) throw new Error(`Git executable is not executable: ${configuredPath}`);
    if (opened.size > BigInt(maximumBytes)) throw new Error(`Git executable exceeds ${maximumBytes}-byte limit`);
    const descriptorTarget = await realpath(`/proc/self/fd/${handle.fd}`);
    if (descriptorTarget !== configuredPath) throw new Error(`Git executable has a symbolic-link path component: ${configuredPath}`);
    const current = await lstat(configuredPath, { bigint: true });
    if (!sameIdentity(opened, current)) throw new Error(`Git executable changed while it was opened: ${configuredPath}`);
    await options.afterGitExecutableStat?.({ handle, path: configuredPath, information: opened });
    const bytes = await readGitExecutableWithinLimit(handle, maximumBytes);
    const digest = sha256(bytes);
    if (expected?.digest !== undefined && digest !== expected.digest) throw new Error('Git executable differs from provenance.git.digest');
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(opened, after)) throw new Error(`Git executable changed while it was read: ${configuredPath}`);
    return {
      handle,
      information: opened,
      program: `/proc/self/fd/${handle.fd}`,
      identity: {
        path: configuredPath,
        realpath: descriptorTarget,
        mode: fileMode(opened),
        size: Number(opened.size),
        digest,
        ...(expected?.digest === undefined ? {} : { expectedDigest: expected.digest }),
      },
    };
  } catch (error) {
    await handle?.close();
    throw error;
  }
}

async function readGitExecutableWithinLimit(handle, maximumBytes) {
  const chunks = [];
  let total = 0;
  for (;;) {
    const remaining = maximumBytes + 1 - total;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    total += bytesRead;
    if (total > maximumBytes) throw new Error(`Git executable exceeds ${maximumBytes}-byte limit`);
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
}

async function verifyGitExecutable(binding) {
  const descriptor = await binding.handle.stat({ bigint: true });
  let current;
  try {
    current = await lstat(binding.identity.path, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Git executable changed while it was used: ${binding.identity.path}`);
    throw error;
  }
  if (!sameIdentity(binding.information, descriptor) || !sameIdentity(binding.information, current)) {
    throw new Error(`Git executable changed while it was used: ${binding.identity.path}`);
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function statIdentity(value) {
  return {
    device: value.dev.toString(), inode: value.ino.toString(), mode: fileMode(value), size: Number(value.size),
    modifiedNanoseconds: value.mtimeNs.toString(), changedNanoseconds: value.ctimeNs.toString(),
  };
}

function fileMode(value) {
  return (Number(value.mode) & 0o7777).toString(8).padStart(4, '0');
}

async function expectedFileRecord(file, expectedDigest, label, maxBytes, options) {
  try {
    const identity = await fileIdentity(requiredString(file, label), {
      label,
      maxBytes,
      openFile: options?.openFile,
    });
    const digest = requiredDigest(expectedDigest, `${label} digest`);
    return { ...identity, expectedDigest: digest, matches: identity.digest === digest };
  } catch (error) {
    return { path: typeof file === 'string' ? path.resolve(file) : null, realpath: null, digest: null, bytes: null, expectedDigest: expectedDigest ?? null, matches: false, error: error.message };
  }
}

async function expectedToolingRecord(value, tools, options) {
  try {
    const expectedDigest = requiredDigest(value?.digest, 'tooling closure digest');
    const identity = await toolingTreeIdentity(requiredString(value?.root, 'tooling closure root'), options);
    const canonicalRoot = await realpath(identity.root);
    const lock = await expectedFileRecord(
      value?.lock?.path, value?.lock?.digest, 'tooling lock', provenanceLimits.lockBytes, options,
    );
    const containedTools = [tools.mdlm, tools.mdlmPi].every(tool =>
      typeof tool.realpath === 'string' && isPathWithin(canonicalRoot, tool.realpath)
    );
    const lockContained = typeof lock.realpath === 'string' && isPathWithin(canonicalRoot, lock.realpath);
    return {
      ...identity,
      expectedDigest,
      lock,
      containedTools,
      matches: identity.digest === expectedDigest && lock.matches && containedTools && lockContained,
    };
  } catch (error) {
    return {
      root: typeof value?.root === 'string' ? path.resolve(value.root) : null,
      contract: 'mdlm-demo-tooling-tree@1', digest: null, expectedDigest: value?.digest ?? null,
      entries: null, files: null, symlinks: null, bytes: null, lock: { matches: false },
      containedTools: false, matches: false, error: error.message,
    };
  }
}

function isPathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validateStatus(value) {
  requireJsonObject(value, 'status');
  requireLiteral(value, 'contract', 'mdlm-status@1', 'status');
  requireLiteral(value, 'command', 'status', 'status');
  requireBoolean(value, 'ok', 'status');
  validateProcessPackage(value.package, 'status.package');
  const outcome = requireJsonObject(value.currentOutcome, 'status.currentOutcome');
  const supported = ['assignment', 'attention-required', 'profile-boundary-reached', 'lifecycle-complete', 'process-dead-end', 'invalid'];
  if (!supported.includes(outcome.outcome)) throw new Error(`status.currentOutcome.outcome '${outcome.outcome}' is unsupported`);
  if (outcome.outcome === 'assignment' || outcome.outcome === 'attention-required') {
    const assignment = requireJsonObject(outcome.assignment, 'status.currentOutcome.assignment');
    if (!['active', 'not-allocated'].includes(assignment.allocation)) throw new Error(`status Assignment allocation '${assignment.allocation}' is unsupported`);
    if (assignment.allocation === 'active' || assignment.id !== undefined) requiredNonempty(assignment.id, 'status.currentOutcome.assignment.id');
  }
  const recent = requireJsonObject(value.recentTransaction, 'status.recentTransaction');
  requireBoolean(recent, 'available', 'status.recentTransaction');
  if (recent.available) requiredNonempty(recent.id, 'status.recentTransaction.id');
}

function validateAssignmentState(value, expectedId) {
  requireJsonObject(value, 'assignment');
  requireLiteral(value, 'contract', 'mdlm-assignment-state@1', 'assignment');
  requireLiteral(value, 'command', 'assignment.show', 'assignment');
  requireBoolean(value, 'ok', 'assignment');
  const assignment = requireJsonObject(value.assignment, 'assignment.assignment');
  requiredNonempty(assignment.id, 'assignment.assignment.id');
  if (assignment.id !== expectedId) throw new Error(`assignment.assignment.id does not match requested Assignment '${expectedId}'`);
  requireBoolean(value, 'selected', 'assignment');
  if (!value.selected) return;
  validateProcessPackage(value.package, 'assignment.package');
  validateRepositoryFingerprint(value.repository, 'assignment.repository');
  requiredNonempty(value.scenarioReference, 'assignment.scenarioReference');
  if (!['active', 'abandoned', 'exhausted', 'stale'].includes(value.disposition)) throw new Error(`assignment disposition '${value.disposition}' is unsupported`);
  requireJsonObject(value.retryAvailability, 'assignment.retryAvailability');
  if (!Array.isArray(value.malformedResponses)) throw new Error('assignment.malformedResponses must be an array');
  for (const [index, response] of value.malformedResponses.entries()) {
    requireJsonObject(response, `assignment.malformedResponses[${index}]`);
    if (!/^sha256:[0-9a-f]{64}$/.test(response.digest ?? '')) throw new Error(`assignment.malformedResponses[${index}].digest is invalid`);
  }
}

function validateProcessPackage(value, label) {
  normalizeProcessPackage(value, label);
}

function validateRepositoryFingerprint(value, label) {
  const repository = requireJsonObject(value, label);
  if (!/^[0-9a-f]{40,64}$/.test(repository.head ?? '')) throw new Error(`${label}.head is invalid`);
  if (!/^sha256:[0-9a-f]{64}$/.test(repository.trackedState ?? '')) throw new Error(`${label}.trackedState is invalid`);
}

function requireJsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function requireLiteral(value, key, expected, label) { if (value[key] !== expected) throw new Error(`${label}.${key} must equal '${expected}'`); }
function requireBoolean(value, key, label) { if (typeof value[key] !== 'boolean') throw new Error(`${label}.${key} must be boolean`); return value[key]; }
function requiredNonempty(value, label) { if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`); return value; }

async function captureOptional(file) {
  if (typeof file !== 'string') return { present: false };
  const requested = path.resolve(file);
  try {
    const evidence = await readCanonicalFile(requested, 'optional evidence');
    return { present: true, path: evidence.path, bytesBase64: evidence.bytes.toString('base64'), digest: sha256(evidence.bytes) };
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false, path: requested };
    return { present: false, path: requested, error: error.message };
  }
}

async function manifestFiles(root) {
  const output = [];
  for (const name of snapshotManifestPaths) {
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

async function requireCanonicalSnapshotDirectory(directory) {
  const information = await lstat(directory);
  if (!information.isDirectory() || information.isSymbolicLink() || await realpath(directory) !== directory) {
    throw new Error(`pinned snapshot directory is not canonical: ${directory}`);
  }
}

async function readCanonicalSnapshotFile(file) {
  return readCanonicalFile(file, 'pinned snapshot evidence');
}

async function writeExclusive(file, bytes) { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
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
