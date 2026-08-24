import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { commandRecord, fileIdentity, parseJsonBytes, requireContract, runProcess, sha256 } from './util.mjs';

export async function snapshot(request) {
  requireContract(request, 'mdlm-demo-snapshot-request@1');
  const directory = path.resolve(requiredString(request.snapshotDirectory, 'snapshotDirectory'));
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const commandsDirectory = path.join(directory, 'commands');
  await mkdir(commandsDirectory, { mode: 0o700 });
  const timeoutMs = boundedTimeout(request.timeoutMs);
  const repository = path.resolve(requiredString(request.repository, 'repository'));
  const mdlm = requiredString(request.provenance?.tools?.mdlm?.path, 'provenance.tools.mdlm.path');
  const assignmentId = requiredString(request.assignmentId, 'assignmentId');
  const invocations = {
    head: await runProcess('git', ['rev-parse', 'HEAD'], { cwd: repository, timeoutMs }),
    tree: await runProcess('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repository, timeoutMs }),
    status: await runProcess('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repository, timeoutMs }),
    doctor: await runProcess(mdlm, ['doctor', '--json'], { cwd: repository, timeoutMs }),
    mdlmStatus: await runProcess(mdlm, ['status', '--json'], { cwd: repository, timeoutMs }),
    assignment: await runProcess(mdlm, ['assignment', 'show', assignmentId, '--json'], { cwd: repository, timeoutMs }),
  };
  for (const [name, result] of Object.entries(invocations)) {
    await writeExclusive(path.join(commandsDirectory, `${name}.stdout`), result.stdout);
    await writeExclusive(path.join(commandsDirectory, `${name}.stderr`), result.stderr);
    await writeExclusive(path.join(commandsDirectory, `${name}.json`), json(commandRecord(result)));
  }
  const journal = await captureOptional(request.journalPath);
  const provenance = await inspectProvenance(request.provenance, timeoutMs);
  const assignment = parseJsonBytes(invocations.assignment.stdout, 'assignment show').assignment ?? { id: assignmentId };
  const record = {
    contract: 'mdlm-demo-snapshot@1',
    createdAt: new Date().toISOString(),
    repository,
    git: {
      head: commandRecord(invocations.head),
      tree: commandRecord(invocations.tree),
      status: commandRecord(invocations.status),
    },
    commands: {
      doctor: commandRecord(invocations.doctor),
      status: commandRecord(invocations.mdlmStatus),
      assignment: commandRecord(invocations.assignment),
    },
    assignment,
    journal,
    provenance,
  };
  await writeExclusive(path.join(directory, 'snapshot.json'), json(record));
  const files = await manifestFiles(directory);
  const manifestBytes = json({ contract: 'mdlm-demo-evidence-manifest@1', files });
  await writeExclusive(path.join(directory, 'manifest.json'), manifestBytes);
  await makeReadOnly(directory, [path.join(directory, 'manifest.json'), ...files.map(item => path.join(directory, item.path))]);
  return { contract: 'mdlm-demo-snapshot-created@1', snapshotDirectory: directory, digest: sha256(manifestBytes) };
}

async function inspectProvenance(provenance, timeoutMs) {
  const source = await gitIdentity(provenance?.source, timeoutMs, 'source');
  const qualificationHarness = await gitIdentity(provenance?.qualificationHarness, timeoutMs, 'qualificationHarness');
  const packageIdentity = await expectedFile(provenance?.package?.artifact, provenance?.package?.digest, 'package artifact');
  const mdlm = await expectedFile(provenance?.tools?.mdlm?.path, provenance?.tools?.mdlm?.digest, 'mdlm');
  const mdlmPi = await expectedFile(provenance?.tools?.mdlmPi?.path, provenance?.tools?.mdlmPi?.digest, 'mdlm-pi');
  return {
    source,
    package: packageIdentity,
    tools: { mdlm, mdlmPi },
    qualificationHarness,
    valid: [source, packageIdentity, mdlm, mdlmPi, qualificationHarness].every(item => item.matches),
  };
}

async function gitIdentity(value, timeoutMs, label) {
  const repository = path.resolve(requiredString(value?.repository, `provenance.${label}.repository`));
  const expectedCommit = requiredString(value?.commit, `provenance.${label}.commit`);
  const commit = await runProcess('git', ['rev-parse', `${expectedCommit}^{commit}`], { cwd: repository, timeoutMs });
  const tree = await runProcess('git', ['rev-parse', `${expectedCommit}^{tree}`], { cwd: repository, timeoutMs });
  const observedCommit = commit.exitStatus === 0 ? commit.stdout.toString('utf8').trim() : null;
  return {
    repository,
    expectedCommit,
    observedCommit,
    observedTree: tree.exitStatus === 0 ? tree.stdout.toString('utf8').trim() : null,
    matches: observedCommit === expectedCommit && tree.exitStatus === 0,
    commands: { commit: commandRecord(commit), tree: commandRecord(tree) },
  };
}

async function expectedFile(file, expectedDigest, label) {
  const identity = await fileIdentity(path.resolve(requiredString(file, label)));
  return { ...identity, expectedDigest: requiredDigest(expectedDigest, `${label} digest`), matches: identity.digest === expectedDigest };
}

async function captureOptional(file) {
  if (typeof file !== 'string') return { present: false };
  try {
    const bytes = await readFile(file);
    return { present: true, path: path.resolve(file), bytesBase64: bytes.toString('base64'), digest: sha256(bytes) };
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false, path: path.resolve(file) };
    throw error;
  }
}

async function manifestFiles(root) {
  const names = ['snapshot.json'];
  const commandNames = ['head', 'tree', 'status', 'doctor', 'mdlmStatus', 'assignment'];
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

async function writeExclusive(file, bytes) {
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
}

const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function requiredString(value, label) { if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`); return value; }
function requiredDigest(value, label) { if (!/^sha256:[0-9a-f]{64}$/.test(value ?? '')) throw new Error(`${label} must be sha256:<64 lowercase hex>`); return value; }
function boundedTimeout(value) { const timeout = value ?? 30_000; if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 900_000) throw new Error('timeoutMs must be between 1 and 900000'); return timeout; }
