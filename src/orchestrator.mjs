import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptAssignment } from './adapter.mjs';
import { classify } from './classify.mjs';
import { snapshot } from './evidence.mjs';
import { commandRecord, parseJsonBytes, requireContract, runProcess, sha256 } from './util.mjs';

const externalScenarios = new Set(['realize-verification-environment@1', 'register-pilot-target@1', 'execute-verification-run@1']);
const mdlmShim = fileURLToPath(new URL('../bin/mdlm-demo-mdlm-shim.mjs', import.meta.url));

export async function run(request, mode) {
  requireContract(request, mode === 'resume' ? 'mdlm-demo-resume-request@1' : 'mdlm-demo-run-request@1');
  const stateDirectory = path.resolve(required(request.stateDirectory, 'stateDirectory'));
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const release = await acquireLock(stateDirectory);
  try {
    return await lockedRun(request, stateDirectory);
  } finally {
    await release();
  }
}

async function lockedRun(request, stateDirectory) {
  const repository = path.resolve(required(request.repository, 'repository'));
  const assignmentId = required(request.assignmentId, 'assignmentId');
  const transactionDirectory = path.join(stateDirectory, 'transactions');
  await mkdir(transactionDirectory, { recursive: true, mode: 0o700 });
  const journalPath = path.join(transactionDirectory, `${safeId(assignmentId)}.json`);
  const snapshotDirectory = await nextSnapshotDirectory(path.resolve(required(request.evidenceDirectory, 'evidenceDirectory')));
  const snapshotResult = await snapshot({
    contract: 'mdlm-demo-snapshot-request@1', repository, snapshotDirectory, assignmentId, journalPath,
    timeoutMs: request.timeoutMs, provenance: request.provenance,
  });
  const capturedSnapshot = JSON.parse(await readFile(path.join(snapshotDirectory, 'snapshot.json'), 'utf8'));
  if (!sameConfiguredPath(request.commands?.mdlm, request.provenance?.tools?.mdlm?.path) ||
      !sameConfiguredPath(request.commands?.mdlmPi, request.provenance?.tools?.mdlmPi?.path) ||
      (request.harness && (!sameConfiguredPath(request.harness.directory, request.provenance?.qualificationHarness?.repository) || request.harness.commit !== request.provenance?.qualificationHarness?.commit))) {
    return stopped('provenance-configuration-mismatch', 'runtime command or harness configuration differs from the hashed provenance input', snapshotResult, assignmentId);
  }
  const doctor = decodeJson(capturedSnapshot.commands.doctor.stdoutBase64, 'doctor');
  const status = decodeJson(capturedSnapshot.commands.status.stdoutBase64, 'status');
  const assignmentState = decodeJson(capturedSnapshot.commands.assignment.stdoutBase64, 'assignment');
  const assignment = {
    id: assignmentState.assignment?.id,
    disposition: assignmentState.disposition,
    package: assignmentState.package,
    repository: assignmentState.repository,
    scenarioReference: assignmentState.scenarioReference,
    selected: assignmentState.selected,
    malformedResponses: assignmentState.malformedResponses,
  };
  const existingJournal = await optionalJson(journalPath);
  if (existingJournal?.phase === 'completed') {
    return result('already-completed', snapshotResult, { assignmentId, executionId: existingJournal.executionId, commit: existingJournal.commit });
  }
  if (['submitting', 'uncertain-transaction'].includes(existingJournal?.phase)) {
    return stopped('uncertain-partial-publication', 'submission process began without durable accepted execution evidence', snapshotResult, assignmentId);
  }
  if (existingJournal?.phase === 'uncertain-publication') {
    return stopped('uncertain-partial-publication', 'Git publication state is uncertain', snapshotResult, assignmentId);
  }
  if (existingJournal?.phase === 'published-uncommitted') {
    if (doctor.ok !== true || capturedSnapshot.provenance.valid !== true) {
      return stopped('integrity-drift', 'cannot finish a known publication with failed doctor or provenance checks', snapshotResult, assignmentId);
    }
    try {
      const publication = { executionId: existingJournal.executionId, scenario: existingJournal.scenario, outputPaths: existingJournal.outputPaths, blobs: existingJournal.blobs };
      const commit = await commitPublication(repository, publication, existingJournal.baseCommit, request.timeoutMs, stateDirectory);
      await writeJournal(journalPath, { ...existingJournal, phase: 'completed', commit, completedAt: new Date().toISOString() });
      return result('completed', snapshotResult, { assignmentId, executionId: publication.executionId, commit, recoveredPublication: true });
    } catch (error) {
      await writeJournal(journalPath, { ...existingJournal, phase: 'uncertain-publication', error: error.message });
      return stopped('uncertain-partial-publication', error.message, snapshotResult, assignmentId);
    }
  }
  const identity = await reconcileIdentity(stateDirectory, request, status, assignment);
  const classification = classify({
    contract: 'mdlm-demo-classification-input@1', signal: request.signal ?? 'clean-interrupted-command',
    integrity: { doctorOk: doctor.ok === true && capturedSnapshot.commands.doctor.exitStatus === 0, snapshotOk: true },
    repository: { clean: Buffer.from(capturedSnapshot.git.status.stdoutBase64, 'base64').length === 0, fingerprintMatches: identity.repositoryMatches },
    package: { fingerprintMatches: identity.packageMatches }, artifacts: { fingerprintMatches: capturedSnapshot.provenance.package.matches },
    provenance: { valid: capturedSnapshot.provenance.valid }, assignment,
    publication: { state: 'none' }, outcome: status.currentOutcome?.outcome,
    ...(request.correction ? { correction: request.correction } : {}),
  });
  if (!classification.recoverable) return result('stopped', snapshotResult, { assignmentId, classification });
  if (assignment.disposition !== 'active' || assignment.id !== assignmentId) return stopped('assignment-not-active', 'requested Assignment is not the selected active lease', snapshotResult, assignmentId);

  const prepare = await invoke(stateDirectory, request.commands.mdlm, ['scenario', 'prepare', assignmentId, '--json'], repository, request.timeoutMs);
  if (prepare.exitStatus !== 0 || prepare.timedOut) return stopped('prepare-failed', 'MDLM could not prepare the active Assignment', snapshotResult, assignmentId);
  const packet = parseJsonBytes(prepare.stdout, 'scenario prepare');
  if (packet.contract !== 'mdlm-assignment-packet@2' || packet.assignment?.id !== assignmentId) return stopped('malformed-assignment', 'prepared packet identity is invalid', snapshotResult, assignmentId);
  if (!sameJson(packet.package, assignment.package) || !sameJson(packet.repository, assignment.repository)) {
    return stopped('assignment-fingerprint-drift', 'prepared packet differs from the reconciled Assignment', snapshotResult, assignmentId);
  }
  if (!externalScenarios.has(packet.scenario?.reference)) {
    return runPiAssignment(request, stateDirectory, repository, assignmentId, snapshotResult);
  }

  const packetPath = path.join(stateDirectory, 'prepared-packets', `${safeId(assignmentId)}.json`);
  await mkdir(path.dirname(packetPath), { recursive: true, mode: 0o700 });
  await writeOnceOrMatch(packetPath, prepare.stdout);
  const adapted = await adaptAssignment({
    packetPath, stateDirectory: path.join(stateDirectory, 'adapter'), timeoutMs: request.timeoutMs,
    harness: request.harness, adapterInputsPath: request.adapterInputsPath,
  });
  if (adapted.kind === 'stop') return result('stopped', snapshotResult, { assignmentId, recoverable: true, stop: adapted.stop });
  let journal = existingJournal;
  if (journal?.phase === 'captured') {
    if (journal.responseDigest !== adapted.digest) return stopped('captured-response-drift', 'adapter response bytes changed', snapshotResult, assignmentId);
  } else {
    journal = {
      contract: 'mdlm-demo-transaction-journal@1', phase: 'captured', assignmentId,
      scenario: packet.scenario.reference, package: packet.package, repository: packet.repository,
      packetDigest: sha256(prepare.stdout), responsePath: adapted.responsePath, responseDigest: adapted.digest,
      baseCommit: capturedSnapshot.git.head.stdoutBase64 ? Buffer.from(capturedSnapshot.git.head.stdoutBase64, 'base64').toString('utf8').trim() : null,
    };
    await writeJournal(journalPath, journal);
  }
  await writeJournal(journalPath, { ...journal, phase: 'submitting', submissionStartedAt: new Date().toISOString() });
  const submission = await invoke(stateDirectory, request.commands.mdlm, ['scenario', 'submit', '-', '--json'], repository, request.timeoutMs, adapted.bytes);
  if (submission.exitStatus !== 0 || submission.timedOut) {
    await writeJournal(journalPath, { ...journal, phase: 'uncertain-transaction', submission: commandRecord(submission) });
    return stopped('uncertain-partial-publication', 'submission process did not yield accepted execution evidence', snapshotResult, assignmentId, { transactionPhase: 'uncertain-transaction' });
  }
  let publication;
  try { publication = publicationFromSubmission(parseJsonBytes(submission.stdout, 'scenario submit'), journal); }
  catch (error) {
    await writeJournal(journalPath, { ...journal, phase: 'uncertain-transaction', submission: commandRecord(submission), error: error.message });
    return stopped('uncertain-partial-publication', error.message, snapshotResult, assignmentId);
  }
  publication.blobs = await captureBlobs(repository, publication.outputPaths, request.timeoutMs, stateDirectory);
  const publishedJournal = { ...journal, phase: 'published-uncommitted', executionId: publication.executionId, outputPaths: publication.outputPaths, blobs: publication.blobs };
  await writeJournal(journalPath, publishedJournal);
  try {
    const commit = await commitPublication(repository, publication, journal.baseCommit, request.timeoutMs, stateDirectory);
    await writeJournal(journalPath, { ...publishedJournal, phase: 'completed', commit, completedAt: new Date().toISOString() });
    return result('completed', snapshotResult, { assignmentId, executionId: publication.executionId, commit });
  } catch (error) {
    await writeJournal(journalPath, { ...publishedJournal, phase: 'uncertain-publication', error: error.message });
    return stopped('uncertain-partial-publication', error.message, snapshotResult, assignmentId);
  }
}

async function runPiAssignment(request, stateDirectory, repository, assignmentId, snapshotResult) {
  const decision = await selectedDecision(request.decisionCatalogPath, assignmentId);
  if ((request.signal?.startsWith('attended') || request.signal === 'correction-session-lost') && decision === null) return stopped('operator-decision-unavailable', 'no valid operator-selected decision matches the Assignment', snapshotResult, assignmentId);
  const shimDirectory = path.join(stateDirectory, 'shim');
  const shimConfigPath = path.join(shimDirectory, 'config.json');
  await mkdir(shimDirectory, { recursive: true, mode: 0o700 });
  await writeOnceOrMatch(shimConfigPath, Buffer.from(`${JSON.stringify({
    contract: 'mdlm-demo-shim-config@1', realMdlm: request.commands.mdlm, allowedAssignment: assignmentId,
    stopDirectory: path.join(shimDirectory, 'stops'), timeoutMs: request.timeoutMs ?? 30_000,
  }, null, 2)}\n`));
  const args = ['run', repository, '--mdlm', mdlmShim];
  const environment = { ...process.env, MDLM_DEMO_SHIM_CONFIG: shimConfigPath };
  const processResult = await invoke(stateDirectory, request.commands.mdlmPi, args, repository, request.timeoutMs, decision === null ? undefined : Buffer.from(`${decision.wording}\n`), environment);
  return result(processResult.exitStatus === 0 ? 'completed' : 'stopped', snapshotResult, {
    assignmentId, process: commandRecord(processResult),
    ...(decision === null ? {} : { decision: decision.evidence }),
    ...(processResult.exitStatus === 0 ? {} : { recoverable: processResult.timedOut === false }),
  });
}

async function selectedDecision(file, assignmentId) {
  if (typeof file !== 'string') return null;
  const catalog = JSON.parse(await readFile(file, 'utf8'));
  if (catalog.contract !== 'mdlm-demo-decision-catalog@1') throw new Error('invalid decision catalog contract');
  const selected = catalog.decisions?.find(value => value.assignment === assignmentId);
  if (!selected) return null;
  if (selected.origin !== 'operator-selected' || typeof selected.authorityBasis !== 'string' || selected.authorityBasis.length === 0 || typeof selected.wording !== 'string') throw new Error('decision must record operator-selected origin, authority basis, and wording');
  const digest = sha256(Buffer.from(selected.wording));
  if (selected.digest !== digest) throw new Error('operator decision wording digest differs');
  return {
    wording: selected.wording,
    evidence: { origin: selected.origin, authorityBasis: selected.authorityBasis, digest: selected.digest },
  };
}

async function reconcileIdentity(stateDirectory, request, status, assignment) {
  const file = path.join(stateDirectory, 'run-identity.json');
  const current = {
    contract: 'mdlm-demo-run-identity@1', package: assignment.package,
    source: request.provenance.source, artifact: request.provenance.package,
  };
  const previous = await optionalJson(file);
  if (previous === null) await writeFile(file, `${JSON.stringify(current, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return {
    packageMatches: (previous === null || sameJson(previous.package, assignment.package)) && (!status.package || sameJson(status.package, assignment.package)),
    repositoryMatches: previous === null || sameJson(previous.source, request.provenance.source),
  };
}

function publicationFromSubmission(output, journal) {
  if (output.contract !== 'mdlm-scenario-execution@4' || output.command !== 'scenario.submit') throw new Error('submission did not return an accepted Scenario execution');
  const execution = output.execution;
  if (execution?.status !== 'completed' || execution.response?.assignment !== journal.assignmentId || execution.response?.digest !== journal.responseDigest || execution.definition?.scenario !== journal.scenario) throw new Error('accepted execution does not match the journaled Assignment response');
  if (!Array.isArray(execution.outputs)) throw new Error('accepted execution has no outputs');
  const paths = execution.outputs.map(item => item?.lifecycleDatum?.path);
  if (paths.some(value => typeof value !== 'string')) throw new Error('accepted execution output paths are invalid');
  const outputPaths = [`.lifecycle/data/.transactions/${execution.id}/execution.json`, ...paths];
  if (new Set(outputPaths).size !== outputPaths.length || outputPaths.some(value => !value.startsWith('.lifecycle/data/'))) throw new Error('accepted execution output paths are not unique canonical lifecycle paths');
  return { executionId: execution.id, scenario: journal.scenario, outputPaths };
}

async function captureBlobs(repository, outputPaths, timeoutMs, stateDirectory) {
  const blobs = [];
  for (const outputPath of outputPaths) {
    const hashed = await invoke(stateDirectory, 'git', ['hash-object', '--no-filters', '--', outputPath], repository, timeoutMs);
    const oid = hashed.stdout.toString('utf8').trim();
    if (hashed.exitStatus !== 0 || !/^[0-9a-f]{40,64}$/.test(oid)) throw new Error(`cannot hash accepted output ${outputPath}`);
    blobs.push({ path: outputPath, oid });
  }
  return blobs;
}

async function commitPublication(repository, publication, baseCommit, timeoutMs, stateDirectory) {
  validatePublication(publication);
  const head = await invoke(stateDirectory, 'git', ['rev-parse', 'HEAD'], repository, timeoutMs);
  if (head.exitStatus !== 0) throw new Error('repository HEAD cannot be inspected');
  const currentHead = head.stdout.toString('utf8').trim();
  const expected = [...publication.outputPaths].sort();
  if (currentHead !== baseCommit) {
    return reconcileCommittedPublication(repository, publication, baseCommit, currentHead, timeoutMs, stateDirectory);
  }
  const status = await invoke(stateDirectory, 'git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], repository, timeoutMs);
  const changed = porcelainPaths(status.stdout);
  if (!sameJson(changed.sort(), expected)) throw new Error('working tree does not contain exactly the accepted transaction outputs');
  await verifyBlobs(repository, publication.blobs, 'worktree', timeoutMs, stateDirectory);
  const add = await invoke(stateDirectory, 'git', ['add', '--', ...expected], repository, timeoutMs);
  if (add.exitStatus !== 0) throw new Error('Git could not stage the accepted transaction');
  const commit = await invoke(stateDirectory, 'git', ['commit', '-m', `mdlm: publish ${publication.scenario} (${publication.executionId})`, '--', ...expected], repository, timeoutMs);
  if (commit.exitStatus !== 0) throw new Error('Git publication commit failed');
  const newHead = await invoke(stateDirectory, 'git', ['rev-parse', 'HEAD'], repository, timeoutMs);
  if (newHead.exitStatus !== 0) throw new Error('Git could not inspect publication commit');
  const commitId = newHead.stdout.toString('utf8').trim();
  await verifyBlobs(repository, publication.blobs, 'commit', timeoutMs, stateDirectory);
  return commitId;
}

async function reconcileCommittedPublication(repository, publication, baseCommit, currentHead, timeoutMs, stateDirectory) {
  const parent = await invoke(stateDirectory, 'git', ['rev-parse', 'HEAD^'], repository, timeoutMs);
  const subject = await invoke(stateDirectory, 'git', ['show', '-s', '--format=%s', 'HEAD'], repository, timeoutMs);
  const paths = await invoke(stateDirectory, 'git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'], repository, timeoutMs);
  const expectedSubject = `mdlm: publish ${publication.scenario} (${publication.executionId})`;
  if (parent.exitStatus !== 0 || parent.stdout.toString('utf8').trim() !== baseCommit || subject.stdout.toString('utf8').trim() !== expectedSubject || !sameJson(paths.stdout.toString('utf8').split('\0').filter(Boolean).sort(), [...publication.outputPaths].sort())) {
    throw new Error('HEAD advanced but is not the exact journaled publication');
  }
  await verifyBlobs(repository, publication.blobs, 'commit', timeoutMs, stateDirectory);
  return currentHead;
}

async function verifyBlobs(repository, blobs, source, timeoutMs, stateDirectory) {
  for (const blob of blobs) {
    const args = source === 'commit' ? ['rev-parse', `HEAD:${blob.path}`] : ['hash-object', '--no-filters', '--', blob.path];
    const observed = await invoke(stateDirectory, 'git', args, repository, timeoutMs);
    if (observed.exitStatus !== 0 || observed.stdout.toString('utf8').trim() !== blob.oid) throw new Error(`journaled publication bytes differ at ${blob.path}`);
  }
}

function validatePublication(publication) {
  if (typeof publication.executionId !== 'string' || typeof publication.scenario !== 'string' || !Array.isArray(publication.outputPaths) || !Array.isArray(publication.blobs)) throw new Error('journaled publication evidence is incomplete');
  const paths = publication.outputPaths;
  if (new Set(paths).size !== paths.length || paths.some(value => typeof value !== 'string' || !value.startsWith('.lifecycle/data/'))) throw new Error('journaled publication paths are invalid');
  if (!sameJson([...paths].sort(), publication.blobs.map(value => value.path).sort()) || publication.blobs.some(value => !/^[0-9a-f]{40,64}$/.test(value.oid ?? ''))) throw new Error('journaled publication blob evidence is invalid');
}

function porcelainPaths(bytes) {
  const records = bytes.toString('utf8').split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    paths.push(record.slice(3));
    if (record[0] === 'R' || record[0] === 'C' || record[1] === 'R' || record[1] === 'C') index++;
  }
  return paths;
}

async function invoke(stateDirectory, program, args, cwd, timeoutMs, input, env) {
  const directory = path.join(stateDirectory, 'command-evidence');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const count = (await readdir(directory)).filter(name => /^command-[0-9]{6}\.json$/.test(name)).length + 1;
  const prefix = path.join(directory, `command-${String(count).padStart(6, '0')}`);
  const output = await runProcess(program, args, { cwd, timeoutMs: timeoutMs ?? 30_000, input, env });
  await writeFile(`${prefix}.stdout`, output.stdout, { flag: 'wx', mode: 0o400 });
  await writeFile(`${prefix}.stderr`, output.stderr, { flag: 'wx', mode: 0o400 });
  await writeFile(`${prefix}.json`, `${JSON.stringify(commandRecord(output), null, 2)}\n`, { flag: 'wx', mode: 0o400 });
  return output;
}

async function nextSnapshotDirectory(evidenceDirectory) {
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const used = (await readdir(evidenceDirectory)).filter(name => /^snapshot-[0-9]{6}$/.test(name)).map(name => Number(name.slice(9)));
  const next = used.length === 0 ? 1 : Math.max(...used) + 1;
  return path.join(evidenceDirectory, `snapshot-${String(next).padStart(6, '0')}`);
}

async function acquireLock(stateDirectory) {
  const lock = path.join(stateDirectory, 'writer.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`one-writer lock is held: ${lock}`); throw error; }
  await writeFile(path.join(lock, 'owner.json'), `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, { flag: 'wx' });
  return async () => rm(lock, { recursive: true });
}

async function writeJournal(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
}
async function writeOnceOrMatch(file, bytes) { try { await writeFile(file, bytes, { flag: 'wx', mode: 0o400 }); } catch (error) { if (error.code !== 'EEXIST' || !Buffer.from(await readFile(file)).equals(bytes)) throw new Error('prepared packet drift'); } }
async function optionalJson(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function decodeJson(base64, label) { return parseJsonBytes(Buffer.from(base64, 'base64'), label); }
function result(status, snapshotResult, extra) { return { contract: 'mdlm-demo-run-result@1', status, snapshot: snapshotResult, ...extra }; }
function stopped(reason, detail, snapshotResult, assignmentId, extra = {}) { return result('stopped', snapshotResult, { assignmentId, recoverable: false, reason, detail, ...extra }); }
function required(value, label) { if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`); return value; }
function safeId(value) { return value.replace(/[^A-Za-z0-9._-]/g, '_'); }
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function sameConfiguredPath(left, right) { return typeof left === 'string' && typeof right === 'string' && path.resolve(left) === path.resolve(right); }
