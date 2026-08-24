import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptAssignment } from './adapter.mjs';
import { snapshot } from './evidence.mjs';
import {
  commandRecord, commandSucceeded, controlledEnvironment, gitEnvironment, parseJsonBytes,
  requireContract, runProcess, sha256,
} from './util.mjs';

const externalScenarios = new Set(['realize-verification-environment@1', 'register-pilot-target@1', 'execute-verification-run@1']);
const mdlmShim = fileURLToPath(new URL('../bin/mdlm-demo-mdlm-shim.mjs', import.meta.url));
const executionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function run(request, mode) {
  requireContract(request, mode === 'resume' ? 'mdlm-demo-resume-request@1' : 'mdlm-demo-run-request@1');
  const assignmentId = required(request.assignmentId, 'assignmentId');
  const context = await repositoryContext(required(request.repository, 'repository'), request.timeoutMs);
  const release = await acquireRepositoryLock(context, assignmentId);
  try {
    const stateDirectory = path.resolve(required(request.stateDirectory, 'stateDirectory'));
    const assignmentDirectory = path.join(stateDirectory, 'assignments', assignmentKey(assignmentId));
    await mkdir(assignmentDirectory, { recursive: true, mode: 0o700 });
    const journalPath = path.join(assignmentDirectory, 'transaction.json');
    const piJournalPath = path.join(context.gitDirectory, 'mdlm-pi', 'run.json');
    const evidenceDirectory = path.resolve(required(request.evidenceDirectory, 'evidenceDirectory'));
    const initialDirectory = await nextSnapshotDirectory(evidenceDirectory);
    const initial = await snapshotRequest(request, context.repository, initialDirectory, assignmentId, journalPath, piJournalPath, false);
    let output;
    try {
      output = initial.status === 'complete'
        ? await executeRun(request, context, assignmentDirectory, journalPath, initial)
        : stopped('command-failure', 'initial snapshot contains a failed or malformed command', initial, assignmentId, { failures: initial.failures });
    } catch (error) {
      output = stopped('orchestration-failure', error instanceof Error ? error.message : String(error), initial, assignmentId);
    }
    const postDirectory = await nextSnapshotDirectory(evidenceDirectory);
    const postRunSnapshot = await snapshotRequest(request, context.repository, postDirectory, assignmentId, journalPath, piJournalPath, true);
    output.postRunSnapshot = postRunSnapshot;
    await finishTrustedRun(context, assignmentDirectory, journalPath, assignmentId, output, postRunSnapshot);
    return output;
  } finally {
    await release();
  }
}

async function snapshotRequest(request, repository, snapshotDirectory, assignmentId, journalPath, piJournalPath, postRun) {
  return snapshot({
    contract: 'mdlm-demo-snapshot-request@1', repository, snapshotDirectory, assignmentId,
    journalPath, piJournalPath, postRun, timeoutMs: request.timeoutMs, provenance: request.provenance,
  });
}

async function executeRun(request, context, assignmentDirectory, journalPath, snapshotResult) {
  const assignmentId = request.assignmentId;
  const captured = JSON.parse(await readFile(path.join(snapshotResult.snapshotDirectory, 'snapshot.json'), 'utf8'));
  if (!sameConfiguredPath(request.commands?.mdlm, request.provenance?.tools?.mdlm?.path) ||
      !sameConfiguredPath(request.commands?.mdlmPi, request.provenance?.tools?.mdlmPi?.path) ||
      (request.harness && (!sameConfiguredPath(request.harness.directory, request.provenance?.qualificationHarness?.repository) ||
        request.harness.commit !== request.provenance?.qualificationHarness?.commit ||
        request.harness.tree !== request.provenance?.qualificationHarness?.tree))) {
    return stopped('provenance-configuration-mismatch', 'runtime command or harness configuration differs from the measured provenance input', snapshotResult, assignmentId);
  }
  if (!captured.lifecycleRepository || !captured.assignment || !captured.status || !captured.diagnosis) {
    return stopped('command-failure', 'snapshot lacks a decoded repository, status, doctor, or Assignment record', snapshotResult, assignmentId);
  }
  if (captured.provenance.valid !== true) {
    return stopped('provenance-violation', 'a source, artifact, executable, or harness identity differs', snapshotResult, assignmentId);
  }
  const assignment = captured.assignment;
  const status = captured.status;
  const processPackage = reconcileProcessPackage(status.package, assignment.package);
  if (processPackage === null) return stopped('package-drift', 'status and Assignment Process Package identities differ', snapshotResult, assignmentId);
  const runIdentity = observedRunIdentity(captured.provenance, processPackage);
  const identityMatch = await pinRunIdentity(context.identityDirectory, runIdentity);
  if (!identityMatch) return stopped('run-identity-drift', 'artifact, installed Process Package, executable target, source, or harness identity changed', snapshotResult, assignmentId);

  const journal = await optionalJson(journalPath);
  if (journal?.phase === 'completed') {
    const expected = journal.completedRepository;
    const exactCommitRecovery = expected === undefined && journal.commit === captured.lifecycleRepository.head && captured.lifecycleRepository.clean;
    if (!exactCommitRecovery && !sameJson(expected, captured.lifecycleRepository)) {
      return stopped('repository-drift', 'repository differs from the completed transaction boundary', snapshotResult, assignmentId);
    }
    return result('already-completed', snapshotResult, { assignmentId, executionId: journal.executionId, commit: journal.commit, outcome: journal.outcome });
  }
  if (journal?.phase === 'submitting' || journal?.phase === 'uncertain-transaction') {
    return stopped('uncertain-partial-publication', 'submission began without durable accepted execution evidence', snapshotResult, assignmentId, { transactionPhase: journal.phase });
  }
  if (journal?.phase === 'uncertain-publication') {
    return stopped('uncertain-partial-publication', 'Git publication state is uncertain', snapshotResult, assignmentId);
  }

  const repositoryMatch = await reconcileRepositoryIdentity(context.identityDirectory, assignmentDirectory, assignmentId, captured.lifecycleRepository, assignment.repository);
  if (!repositoryMatch.ok) return stopped(repositoryMatch.reason, repositoryMatch.detail, snapshotResult, assignmentId);
  if (captured.diagnosis.ok !== true) return stopped('integrity-drift', 'mdlm doctor did not return ok:true', snapshotResult, assignmentId);

  if (journal?.phase === 'published-uncommitted') {
    try {
      const publication = { executionId: journal.executionId, scenario: journal.scenario, outputPaths: journal.outputPaths, blobs: journal.blobs };
      const commit = await commitPublication(context.repository, publication, journal.baseCommit, request.timeoutMs, assignmentDirectory);
      await writeJournal(journalPath, { ...journal, phase: 'completed', commit, completedAt: new Date().toISOString(), trustedRepositoryAdvance: true });
      return result('completed', snapshotResult, { assignmentId, executionId: publication.executionId, commit, recoveredPublication: true, outcome: 'accepted-publication', trustedRepositoryAdvance: true });
    } catch (error) {
      await writeJournal(journalPath, { ...journal, phase: 'uncertain-publication', error: error.message });
      return stopped('uncertain-partial-publication', error.message, snapshotResult, assignmentId);
    }
  }

  const durableCorrection = await inspectCorrectionContext(context, assignment);
  if (durableCorrection.authentic || request.signal === 'correction-session-lost') {
    return stopped(
      durableCorrection.authentic ? 'correction-session-unresumable' : 'correction-context-lost',
      durableCorrection.authentic
        ? 'the installed mdlm-pi controller retains the submission journal but has no correction-session resume command; it was not restarted'
        : durableCorrection.detail,
      snapshotResult, assignmentId,
      { correction: durableCorrection, infrastructureStop: true },
    );
  }
  if (assignment.disposition !== 'active' || assignment.id !== assignmentId || assignment.selected !== true) {
    return stopped('assignment-not-active', 'requested Assignment is not the selected active durable lease', snapshotResult, assignmentId);
  }
  if (!sameRepositoryFingerprint(assignment.repository, captured.lifecycleRepository)) {
    return stopped('repository-drift', 'Assignment repository fingerprint differs from the lifecycle repository snapshot', snapshotResult, assignmentId);
  }

  const prepare = await invoke(assignmentDirectory, request.commands.mdlm, ['scenario', 'prepare', assignmentId, '--json'], context.repository, request.timeoutMs);
  if (!commandSucceeded(prepare)) return stopped('prepare-command-failure', 'MDLM could not prepare the active Assignment', snapshotResult, assignmentId, { process: commandRecord(prepare) });
  let packet;
  try { packet = parseJsonBytes(prepare.stdout, 'scenario prepare'); }
  catch (error) { return stopped('malformed-assignment', error.message, snapshotResult, assignmentId); }
  if (packet.contract !== 'mdlm-assignment-packet@2' || packet.assignment?.id !== assignmentId || packet.command !== 'scenario.prepare') {
    return stopped('malformed-assignment', 'prepared packet identity or contract is invalid', snapshotResult, assignmentId);
  }
  if (!sameJson(packet.package, assignment.package) || !sameJson(packet.repository, assignment.repository)) {
    return stopped('assignment-fingerprint-drift', 'prepared packet differs from the snapshotted Assignment', snapshotResult, assignmentId);
  }
  if (!externalScenarios.has(packet.scenario?.reference)) {
    return runPiAssignment(request, context, assignmentDirectory, assignment, snapshotResult);
  }
  return runExternalAssignment(request, context, assignmentDirectory, journalPath, assignment, packet, prepare.stdout, snapshotResult, journal);
}

async function runExternalAssignment(request, context, assignmentDirectory, journalPath, assignment, packet, packetBytes, snapshotResult, existingJournal) {
  const assignmentId = assignment.id;
  const packetPath = path.join(assignmentDirectory, 'prepared-packet.json');
  await writeOnceOrMatch(packetPath, packetBytes);
  const adapted = await adaptAssignment({
    packetPath, assignmentDirectory: path.join(assignmentDirectory, 'adapter'), timeoutMs: request.timeoutMs,
    harness: request.harness, adapterInputsPath: request.adapterInputsPath,
  });
  if (adapted.kind === 'stop') return result('stopped', snapshotResult, { assignmentId, recoverable: true, reason: 'reserved-adapter-stop', stop: adapted.stop, outcome: 'pre-submission-stop' });
  let journal = existingJournal;
  if (journal?.phase === 'captured') {
    if (journal.responseDigest !== adapted.digest) return stopped('captured-response-drift', 'adapter response bytes changed', snapshotResult, assignmentId);
  } else {
    journal = {
      contract: 'mdlm-demo-transaction-journal@2', phase: 'captured', assignmentId,
      scenario: packet.scenario.reference, package: packet.package, repository: packet.repository,
      packetDigest: sha256(packetBytes), responsePath: adapted.responsePath, responseDigest: adapted.digest,
      baseCommit: packet.repository.head,
    };
    await writeJournal(journalPath, journal);
  }
  await writeJournal(journalPath, { ...journal, phase: 'submitting', submissionStartedAt: new Date().toISOString() });
  const submission = await invoke(assignmentDirectory, request.commands.mdlm, ['scenario', 'submit', '-', '--json'], context.repository, request.timeoutMs, adapted.bytes);
  if (!commandSucceeded(submission)) {
    await writeJournal(journalPath, { ...journal, phase: 'uncertain-transaction', submission: commandRecord(submission) });
    return stopped('uncertain-partial-publication', 'submission process did not yield accepted execution evidence', snapshotResult, assignmentId, { transactionPhase: 'uncertain-transaction' });
  }
  let publication;
  try {
    publication = await publicationFromSubmission(parseJsonBytes(submission.stdout, 'scenario submit'), journal, context.repository);
    publication.blobs = await captureBlobs(context.repository, publication.outputPaths, request.timeoutMs, assignmentDirectory);
  } catch (error) {
    await writeJournal(journalPath, { ...journal, phase: 'uncertain-transaction', submission: commandRecord(submission), error: error.message });
    return stopped('uncertain-partial-publication', error.message, snapshotResult, assignmentId, { transactionPhase: 'uncertain-transaction' });
  }
  const published = { ...journal, phase: 'published-uncommitted', executionId: publication.executionId, outputPaths: publication.outputPaths, blobs: publication.blobs };
  await writeJournal(journalPath, published);
  try {
    const commit = await commitPublication(context.repository, publication, journal.baseCommit, request.timeoutMs, assignmentDirectory);
    await writeJournal(journalPath, { ...published, phase: 'completed', commit, completedAt: new Date().toISOString(), trustedRepositoryAdvance: true });
    return result('completed', snapshotResult, { assignmentId, executionId: publication.executionId, commit, outcome: 'accepted-publication', trustedRepositoryAdvance: true });
  } catch (error) {
    await writeJournal(journalPath, { ...published, phase: 'uncertain-publication', error: error.message });
    return stopped('uncertain-partial-publication', error.message, snapshotResult, assignmentId);
  }
}

async function runPiAssignment(request, context, assignmentDirectory, assignment, snapshotResult) {
  const assignmentId = assignment.id;
  const attended = request.signal === 'attended-answer' || request.signal === 'attended-review-correction';
  const decision = attended ? await selectedDecision(request.decisionCatalogPath, assignmentId) : null;
  if (attended && decision === null) return stopped('operator-decision-unavailable', 'no valid operator-selected decision matches the attended Assignment', snapshotResult, assignmentId);
  const shimDirectory = path.join(assignmentDirectory, 'shim');
  const shimConfigPath = path.join(shimDirectory, 'config.json');
  await mkdir(shimDirectory, { recursive: true, mode: 0o700 });
  await writeOnceOrMatch(shimConfigPath, Buffer.from(`${JSON.stringify({
    contract: 'mdlm-demo-shim-config@1', realMdlm: request.commands.mdlm, allowedAssignment: assignmentId,
    stopDirectory: path.join(shimDirectory, 'stops'), timeoutMs: request.timeoutMs ?? 30_000,
  }, null, 2)}\n`));
  const args = ['run', context.repository, '--mdlm', mdlmShim];
  const environment = controlledEnvironment({ MDLM_DEMO_SHIM_CONFIG: shimConfigPath });
  const processResult = await invoke(
    assignmentDirectory, request.commands.mdlmPi, args, context.repository, request.timeoutMs,
    decision === null ? undefined : Buffer.from(`${decision.wording}\n`), environment,
  );
  const decoded = decodeMdlmPiResult(processResult);
  const common = {
    assignmentId,
    process: commandRecord(processResult),
    mdlmPi: decoded,
    ...(decision === null ? {} : { decision: decision.evidence }),
  };
  if (decoded.kind === 'reserved-stop') {
    const accepted = decoded.stop.type === 'assignment-checkpoint';
    return result(accepted ? 'completed' : 'stopped', snapshotResult, {
      ...common, recoverable: true, reason: 'reserved-shim-stop', stop: decoded.stop,
      outcome: accepted ? 'accepted-publication' : 'pre-submission-stop', trustedRepositoryAdvance: accepted,
    });
  }
  if (decoded.kind === 'terminal') {
    return result(decoded.successful ? 'completed' : 'stopped', snapshotResult, {
      ...common, recoverable: false, reason: decoded.status, outcome: decoded.status,
      trustedRepositoryAdvance: true,
    });
  }
  if (decoded.kind === 'correction-session-lost') {
    const correction = await inspectCorrectionContext(context, assignment, decoded.document);
    return stopped('correction-session-lost', 'mdlm-pi lost the worker correction session; stdin replay is unsupported', snapshotResult, assignmentId, { ...common, correction, infrastructureStop: true });
  }
  if (decoded.kind === 'interruption') {
    return result('stopped', snapshotResult, { ...common, recoverable: true, reason: decoded.status, outcome: 'operational-interruption' });
  }
  return stopped(decoded.status, decoded.detail, snapshotResult, assignmentId, common);
}

function decodeMdlmPiResult(processResult) {
  const stdout = trailingJson(processResult.stdout);
  const stderr = trailingJson(processResult.stderr);
  const reserved = processResult.exitStatus === 1 ? findReservedStop(stderr) : null;
  if (reserved !== null) return { kind: 'reserved-stop', status: 'reserved-shim-stop', stop: reserved };
  if (processResult.timedOut || processResult.signal !== null || [129, 130, 143].includes(processResult.exitStatus)) {
    return { kind: 'interruption', status: processResult.timedOut ? 'mdlm-pi-timeout' : 'mdlm-pi-interrupted', document: stdout ?? stderr };
  }
  const document = stdout ?? stderr;
  const status = typeof document?.status === 'string' ? document.status : null;
  if (processResult.exitStatus === 0 && ['lifecycle-complete', 'profile-boundary-reached'].includes(status)) {
    return { kind: 'terminal', status, successful: true, document };
  }
  if (processResult.exitStatus === 2 && status === 'process-dead-end') return { kind: 'terminal', status, successful: false, document };
  if (processResult.exitStatus === 3 && status === 'invalid') return { kind: 'terminal', status, successful: false, document };
  if (processResult.exitStatus === 4 && status === 'assignment-correction-session-lost') return { kind: 'correction-session-lost', status, document };
  if (processResult.exitStatus === 4 && /^assignment-(?:abandoned|exhausted|stale|malformed)$/.test(status ?? '')) {
    return { kind: 'terminal', status, successful: false, document };
  }
  if (processResult.exitStatus === 5 && status === 'lock-conflict') return { kind: 'interruption', status, document };
  return {
    kind: 'failure', status: status === 'operational-failure' ? 'mdlm-pi-operational-failure' : 'mdlm-pi-contract-failure',
    detail: document === null ? `mdlm-pi exit ${processResult.exitStatus} did not end with a typed JSON result` : `mdlm-pi exit ${processResult.exitStatus} and result status '${status}' disagree`,
    document,
  };
}

function trailingJson(bytes) {
  const source = bytes.toString('utf8').trim();
  let document = null;
  for (let index = source.lastIndexOf('{'); index >= 0;) {
    try {
      const value = JSON.parse(source.slice(index));
      if (value && typeof value === 'object' && !Array.isArray(value)) document = value;
    } catch {}
    if (index === 0) break;
    index = source.lastIndexOf('{', index - 1);
  }
  return document;
}
function findReservedStop(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.contract === 'mdlm-demo-reserved-stop@1' && value.phase === 'before-worker') return value;
  for (const child of Object.values(value)) {
    const found = findReservedStop(child);
    if (found !== null) return found;
  }
  return null;
}

async function inspectCorrectionContext(context, assignment, resultDocument) {
  const journalPath = path.join(context.gitDirectory, 'mdlm-pi', 'run.json');
  let journal;
  try { journal = JSON.parse(await readFile(journalPath, 'utf8')); }
  catch (error) { return { authentic: false, controllerResumeSupported: false, journalPath, detail: `durable mdlm-pi journal unavailable: ${error.message}` }; }
  const responseDigest = resultDocument?.responseDigest ?? journal.submission?.digest;
  const authentic = journal.contract === 'mdlm-pi-run-journal@1' && journal.phase === 'submitting' &&
    journal.assignment?.id === assignment.id && sameJson(journal.assignment?.package, assignment.package) &&
    sameJson(journal.assignment?.repository, assignment.repository) &&
    /^sha256:[0-9a-f]{64}$/.test(responseDigest ?? '') && journal.submission?.digest === responseDigest;
  return {
    authentic,
    controllerResumeSupported: false,
    journalPath,
    phase: journal.phase,
    previousResponseDigest: responseDigest ?? null,
    diagnostics: Array.isArray(resultDocument?.diagnostics) ? resultDocument.diagnostics : [],
    detail: authentic ? 'journal is authentic, but this installed controller reports correction-session-lost instead of resuming it' : 'mdlm-pi journal does not match the active Assignment correction boundary',
  };
}

async function selectedDecision(file, assignmentId) {
  if (typeof file !== 'string') return null;
  const catalog = JSON.parse(await readFile(file, 'utf8'));
  if (catalog.contract !== 'mdlm-demo-decision-catalog@1') throw new Error('invalid decision catalog contract');
  const selected = catalog.decisions?.find(value => value.assignment === assignmentId);
  if (!selected) return null;
  if (selected.origin !== 'operator-selected' || typeof selected.authorityBasis !== 'string' || selected.authorityBasis.length === 0 || typeof selected.wording !== 'string') {
    throw new Error('decision must record operator-selected origin, authority basis, and wording');
  }
  const digest = sha256(Buffer.from(selected.wording));
  if (selected.digest !== digest) throw new Error('operator decision wording digest differs');
  return { wording: selected.wording, evidence: { origin: selected.origin, authorityBasis: selected.authorityBasis, digest: selected.digest } };
}

function observedRunIdentity(provenance, processPackage) {
  const gitIdentity = value => ({ repository: value.repository, commit: value.observedCommit, tree: value.observedTree });
  const file = value => ({ realpath: value.realpath, digest: value.digest, bytes: value.bytes });
  return {
    contract: 'mdlm-demo-run-identity@2',
    processPackage,
    source: gitIdentity(provenance.source),
    packageArtifact: file(provenance.package),
    tools: { mdlm: file(provenance.tools.mdlm), mdlmPi: file(provenance.tools.mdlmPi) },
    qualificationHarness: { ...gitIdentity(provenance.qualificationHarness), manifest: file(provenance.qualificationHarness.manifest) },
  };
}
async function pinRunIdentity(identityDirectory, current) {
  const file = path.join(identityDirectory, 'run-identity.json');
  const previous = await optionalJson(file);
  if (previous === null) { await durableWriteJson(file, current); return true; }
  return sameJson(previous, current);
}
function reconcileProcessPackage(statusPackage, assignmentPackage) {
  if (!validProcessPackage(statusPackage) || !sameJson(statusPackage, assignmentPackage)) return null;
  return statusPackage;
}
function validProcessPackage(value) {
  return value && typeof value.reference === 'string' && value.reference.length > 0 &&
    /^sha256:[0-9a-f]{64}$/.test(value.digest ?? '') && typeof value.language === 'string' && value.language.length > 0;
}

async function reconcileRepositoryIdentity(identityDirectory, assignmentDirectory, assignmentId, lifecycle, assignmentRepository) {
  if (!sameRepositoryFingerprint(assignmentRepository, lifecycle)) return { ok: false, reason: 'repository-drift', detail: 'Assignment and lifecycle repository fingerprints differ' };
  const globalPath = path.join(identityDirectory, 'repository-identity.json');
  const assignmentPath = path.join(assignmentDirectory, 'identity.json');
  const global = await optionalJson(globalPath);
  if (global !== null && !sameJson(global.lifecycleRepository, lifecycle)) {
    return { ok: false, reason: 'repository-drift', detail: 'lifecycle repository differs from its last trusted boundary' };
  }
  const current = { contract: 'mdlm-demo-assignment-identity@1', assignmentId, lifecycleRepository: lifecycle, assignmentRepository };
  const prior = await optionalJson(assignmentPath);
  if (prior !== null && !sameJson(prior, current)) return { ok: false, reason: 'repository-drift', detail: 'Assignment repository boundary changed on resume' };
  if (prior === null) await durableWriteJson(assignmentPath, current);
  if (global === null) await durableWriteJson(globalPath, { contract: 'mdlm-demo-repository-identity@1', lifecycleRepository: lifecycle, lastAssignment: null });
  return { ok: true };
}
function sameRepositoryFingerprint(assignmentRepository, lifecycle) {
  return assignmentRepository && assignmentRepository.head === lifecycle.head && assignmentRepository.trackedState === lifecycle.trackedState;
}

async function finishTrustedRun(context, assignmentDirectory, journalPath, assignmentId, output, postSnapshot) {
  if (postSnapshot.status !== 'complete') return;
  const captured = JSON.parse(await readFile(path.join(postSnapshot.snapshotDirectory, 'snapshot.json'), 'utf8'));
  if (!captured.lifecycleRepository) return;
  const trusted = output.trustedRepositoryAdvance === true && ['completed', 'stopped'].includes(output.status);
  if (!trusted) return;
  const globalPath = path.join(context.identityDirectory, 'repository-identity.json');
  await durableWriteJson(globalPath, {
    contract: 'mdlm-demo-repository-identity@1', lifecycleRepository: captured.lifecycleRepository,
    lastAssignment: { id: assignmentId, outcome: output.outcome ?? null, completed: true },
  });
  const journal = await optionalJson(journalPath);
  if (journal?.phase === 'completed') await writeJournal(journalPath, { ...journal, completedRepository: captured.lifecycleRepository });
  else {
    await writeJournal(journalPath, {
      contract: 'mdlm-demo-transaction-journal@2', phase: 'completed', assignmentId,
      outcome: output.outcome ?? null, completedRepository: captured.lifecycleRepository,
      completedAt: new Date().toISOString(), trustedRepositoryAdvance: true,
    });
  }
}

async function publicationFromSubmission(output, journal, repository) {
  if (output.contract !== 'mdlm-scenario-execution@4' || output.command !== 'scenario.submit') throw new Error('submission did not return an accepted Scenario execution');
  const execution = output.execution;
  if (execution?.status !== 'completed' || execution.response?.assignment !== journal.assignmentId || execution.response?.digest !== journal.responseDigest || execution.definition?.scenario !== journal.scenario) {
    throw new Error('accepted execution does not match the journaled Assignment response');
  }
  if (!Array.isArray(execution.outputs)) throw new Error('accepted execution has no outputs');
  const paths = execution.outputs.map(item => item?.lifecycleDatum?.path);
  if (paths.some(value => typeof value !== 'string')) throw new Error('accepted execution output paths are invalid');
  const outputPaths = [`.lifecycle/data/.transactions/${execution.id}/execution.json`, ...paths];
  return { executionId: execution.id, scenario: journal.scenario, outputPaths: await canonicalPublicationPaths(repository, execution.id, outputPaths) };
}

async function canonicalPublicationPaths(repository, executionId, outputPaths) {
  if (!executionIdPattern.test(executionId)) throw new Error(`invalid Scenario execution identity '${executionId}'`);
  if (!Array.isArray(outputPaths) || outputPaths.length === 0) throw new Error('accepted execution has no publication paths');
  const transaction = `.lifecycle/data/.transactions/${executionId}`;
  const canonicalRepository = await realpath(repository);
  const canonical = [];
  for (const candidate of outputPaths) {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\\') || candidate.includes('\0') || path.posix.isAbsolute(candidate) || path.posix.normalize(candidate) !== candidate) {
      throw new Error(`publication path is not canonical: ${String(candidate)}`);
    }
    const parts = candidate.split('/');
    if (parts.includes('..') || parts.includes('.') || !candidate.startsWith(`${transaction}/`)) throw new Error(`publication path escapes transaction '${executionId}': ${candidate}`);
    let current = canonicalRepository;
    let information;
    for (const part of parts) {
      current = path.join(current, part);
      information = await lstat(current);
      if (information.isSymbolicLink()) throw new Error(`publication path has a symbolic-link component: ${candidate}`);
    }
    if (!information?.isFile()) throw new Error(`publication path is not a regular file: ${candidate}`);
    const resolved = await realpath(current);
    const transactionRoot = path.join(canonicalRepository, ...transaction.split('/'));
    if (resolved !== current || !resolved.startsWith(`${transactionRoot}${path.sep}`)) throw new Error(`publication path resolves outside its transaction: ${candidate}`);
    canonical.push(candidate);
  }
  const sorted = [...new Set(canonical)].sort();
  if (sorted.length !== canonical.length) throw new Error('accepted execution output paths are not unique');
  return sorted;
}

async function captureBlobs(repository, outputPaths, timeoutMs, assignmentDirectory) {
  const blobs = [];
  for (const outputPath of outputPaths) {
    const hashed = await invoke(assignmentDirectory, 'git', ['hash-object', '--no-filters', '--', outputPath], repository, timeoutMs);
    const oid = hashed.stdout.toString('utf8').trim();
    if (!commandSucceeded(hashed) || !/^[0-9a-f]{40,64}$/.test(oid)) throw new Error(`cannot hash accepted output ${outputPath}`);
    blobs.push({ path: outputPath, oid });
  }
  return blobs;
}

async function commitPublication(repository, publication, baseCommit, timeoutMs, assignmentDirectory) {
  await validatePublication(repository, publication);
  const head = await invoke(assignmentDirectory, 'git', ['rev-parse', 'HEAD^{commit}'], repository, timeoutMs);
  if (!commandSucceeded(head)) throw new Error('repository HEAD cannot be inspected');
  const currentHead = head.stdout.toString('utf8').trim();
  const expected = [...publication.outputPaths].sort();
  if (currentHead !== baseCommit) return reconcileCommittedPublication(repository, publication, baseCommit, currentHead, timeoutMs, assignmentDirectory);
  const status = await invoke(assignmentDirectory, 'git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], repository, timeoutMs);
  if (!commandSucceeded(status)) throw new Error('repository status cannot be inspected');
  const changed = porcelainPaths(status.stdout).sort();
  if (!sameJson(changed, expected)) throw new Error('working tree does not contain exactly the accepted transaction outputs');
  await verifyBlobs(repository, publication.blobs, 'worktree', timeoutMs, assignmentDirectory);
  const add = await invoke(assignmentDirectory, 'git', ['add', '--', ...expected], repository, timeoutMs);
  if (!commandSucceeded(add)) throw new Error('Git could not stage the accepted transaction');
  const staged = await invoke(assignmentDirectory, 'git', ['diff', '--cached', '--name-only', '-z'], repository, timeoutMs);
  if (!commandSucceeded(staged) || !sameJson(staged.stdout.toString('utf8').split('\0').filter(Boolean).sort(), expected)) throw new Error('Git staged paths differ from the canonical publication');
  const commit = await invoke(assignmentDirectory, 'git', ['commit', '-m', `mdlm: publish ${publication.scenario} (${publication.executionId})`, '--', ...expected], repository, timeoutMs);
  if (!commandSucceeded(commit)) throw new Error('Git publication commit failed');
  const newHead = await invoke(assignmentDirectory, 'git', ['rev-parse', 'HEAD^{commit}'], repository, timeoutMs);
  if (!commandSucceeded(newHead)) throw new Error('Git could not inspect publication commit');
  const commitId = newHead.stdout.toString('utf8').trim();
  await verifyBlobs(repository, publication.blobs, 'commit', timeoutMs, assignmentDirectory);
  return commitId;
}

async function reconcileCommittedPublication(repository, publication, baseCommit, currentHead, timeoutMs, assignmentDirectory) {
  const parent = await invoke(assignmentDirectory, 'git', ['rev-parse', 'HEAD^'], repository, timeoutMs);
  const subject = await invoke(assignmentDirectory, 'git', ['show', '-s', '--format=%s', 'HEAD'], repository, timeoutMs);
  const paths = await invoke(assignmentDirectory, 'git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'], repository, timeoutMs);
  const expectedSubject = `mdlm: publish ${publication.scenario} (${publication.executionId})`;
  if (!commandSucceeded(parent) || !commandSucceeded(subject) || !commandSucceeded(paths) || parent.stdout.toString('utf8').trim() !== baseCommit ||
      subject.stdout.toString('utf8').trim() !== expectedSubject || !sameJson(paths.stdout.toString('utf8').split('\0').filter(Boolean).sort(), [...publication.outputPaths].sort())) {
    throw new Error('HEAD advanced but is not the exact journaled publication');
  }
  await verifyBlobs(repository, publication.blobs, 'commit', timeoutMs, assignmentDirectory);
  return currentHead;
}

async function verifyBlobs(repository, blobs, source, timeoutMs, assignmentDirectory) {
  for (const blob of blobs) {
    const args = source === 'commit' ? ['rev-parse', `HEAD:${blob.path}`] : ['hash-object', '--no-filters', '--', blob.path];
    const observed = await invoke(assignmentDirectory, 'git', args, repository, timeoutMs);
    if (!commandSucceeded(observed) || observed.stdout.toString('utf8').trim() !== blob.oid) throw new Error(`journaled publication bytes differ at ${blob.path}`);
  }
}

async function validatePublication(repository, publication) {
  if (typeof publication.executionId !== 'string' || typeof publication.scenario !== 'string' || !Array.isArray(publication.outputPaths) || !Array.isArray(publication.blobs)) throw new Error('journaled publication evidence is incomplete');
  const paths = await canonicalPublicationPaths(repository, publication.executionId, publication.outputPaths);
  if (!sameJson(paths, [...publication.outputPaths].sort()) || !sameJson(paths, publication.blobs.map(value => value.path).sort()) || publication.blobs.some(value => !/^[0-9a-f]{40,64}$/.test(value.oid ?? ''))) {
    throw new Error('journaled publication blob evidence is invalid');
  }
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

async function invoke(assignmentDirectory, program, args, cwd, timeoutMs, input, env) {
  const directory = path.join(assignmentDirectory, 'command-evidence');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const count = (await readdir(directory)).filter(name => /^command-[0-9]{6}\.json$/.test(name)).length + 1;
  const prefix = path.join(directory, `command-${String(count).padStart(6, '0')}`);
  const environment = env ?? (program === 'git' ? gitEnvironment() : controlledEnvironment());
  const output = await runProcess(program, args, { cwd, timeoutMs: timeoutMs ?? 30_000, input, env: environment });
  await writeFile(`${prefix}.stdout`, output.stdout, { flag: 'wx', mode: 0o400 });
  await writeFile(`${prefix}.stderr`, output.stderr, { flag: 'wx', mode: 0o400 });
  await writeFile(`${prefix}.json`, `${JSON.stringify(commandRecord(output), null, 2)}\n`, { flag: 'wx', mode: 0o400 });
  return output;
}

async function repositoryContext(repository, timeoutMs) {
  const canonicalRepository = await realpath(path.resolve(repository));
  const options = { cwd: canonicalRepository, timeoutMs: timeoutMs ?? 30_000, env: gitEnvironment() };
  const gitDirectoryResult = await runProcess('git', ['rev-parse', '--path-format=absolute', '--absolute-git-dir'], options);
  const commonResult = await runProcess('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], options);
  if (!commandSucceeded(gitDirectoryResult) || !commandSucceeded(commonResult)) throw new Error('lifecycle repository Git directories cannot be resolved');
  const gitDirectory = await realpath(gitDirectoryResult.stdout.toString('utf8').trim());
  const commonGitDirectory = await realpath(commonResult.stdout.toString('utf8').trim());
  const identityDirectory = path.join(commonGitDirectory, 'mdlm-demo-orchestrator');
  return { repository: canonicalRepository, gitDirectory, commonGitDirectory, identityDirectory };
}

async function acquireRepositoryLock(context, assignmentId) {
  await mkdir(context.identityDirectory, { recursive: true, mode: 0o700 });
  const lock = path.join(context.identityDirectory, 'writer.lock');
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await optionalJson(path.join(lock, 'owner.json')).catch(() => null);
      if (owner !== null && await processOwnerIsAlive(owner)) throw new Error(`lifecycle repository writer lock is held: ${lock}`);
      const stale = path.join(context.identityDirectory, `writer.lock.stale-${randomUUID()}`);
      try { await rename(lock, stale); await rm(stale, { recursive: true }); }
      catch (takeoverError) { if (takeoverError.code !== 'ENOENT') throw takeoverError; }
      if (attempt === 2) throw new Error(`lifecycle repository writer lock cannot be recovered: ${lock}`);
    }
  }
  await durableWriteJson(path.join(lock, 'owner.json'), {
    token, pid: process.pid, processStart: await linuxProcessStart(process.pid), assignmentId,
    repository: context.repository, acquiredAt: new Date().toISOString(),
  });
  return async () => {
    const owner = await optionalJson(path.join(lock, 'owner.json')).catch(() => null);
    if (owner?.token === token) { await rm(lock, { recursive: true }); await syncDirectory(context.identityDirectory); }
  };
}
async function processOwnerIsAlive(owner) {
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
  try { process.kill(owner.pid, 0); }
  catch (error) { return error.code === 'EPERM'; }
  if (process.platform !== 'linux' || typeof owner.processStart !== 'string') return true;
  return await linuxProcessStart(owner.pid) === owner.processStart;
}
async function linuxProcessStart(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    return stat.slice(close + 2).trim().split(/\s+/)[19] ?? null;
  } catch { return null; }
}

async function nextSnapshotDirectory(evidenceDirectory) {
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const used = (await readdir(evidenceDirectory)).filter(name => /^snapshot-[0-9]{6}$/.test(name)).map(name => Number(name.slice(9)));
  const next = used.length === 0 ? 1 : Math.max(...used) + 1;
  return path.join(evidenceDirectory, `snapshot-${String(next).padStart(6, '0')}`);
}

async function writeJournal(file, value) { await durableWriteJson(file, value, value.phase); }
async function durableWriteJson(file, value, phase) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    maybeInjectedCrash(phase, 'after-temp-sync');
  } finally { await handle.close(); }
  try {
    await syncDirectory(path.dirname(file));
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
    maybeInjectedCrash(phase, 'after-rename');
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
function maybeInjectedCrash(phase, seam) {
  if (phase && process.env.MDLM_DEMO_TEST_CRASH === `${phase}:${seam}`) process.exit(86);
}
async function syncDirectory(directory) { const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function writeOnceOrMatch(file, bytes) {
  try { await writeFile(file, bytes, { flag: 'wx', mode: 0o400 }); }
  catch (error) { if (error.code !== 'EEXIST' || !Buffer.from(await readFile(file)).equals(bytes)) throw new Error('assignment-specific immutable file drift'); }
}
async function optionalJson(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function result(status, snapshotResult, extra) { return { contract: 'mdlm-demo-run-result@2', status, snapshot: snapshotResult, ...extra }; }
function stopped(reason, detail, snapshotResult, assignmentId, extra = {}) { return result('stopped', snapshotResult, { assignmentId, recoverable: false, reason, detail, ...extra }); }
function required(value, label) { if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`); return value; }
function assignmentKey(value) { return `${value.replace(/[^A-Za-z0-9._-]/g, '_')}-${sha256(Buffer.from(value)).slice(-12)}`; }
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function sameConfiguredPath(left, right) { return typeof left === 'string' && typeof right === 'string' && path.resolve(left) === path.resolve(right); }
