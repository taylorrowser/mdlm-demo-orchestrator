import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptAssignment } from './adapter.mjs';
import { readCanonicalFile } from './canonical-file.mjs';
import { validateScenarioPrepare } from './contracts.mjs';
import { snapshot, verifySnapshot } from './evidence.mjs';
import { normalizeProcessPackage, sameProcessPackageIdentity } from './process-package.mjs';
import {
  commandRecord, commandSucceeded, controlledEnvironment, gitEnvironment, parseJsonBytes,
  requireContract, runProcess, sha256,
} from './util.mjs';

const externalScenarios = new Set(['realize-verification-environment@1', 'register-pilot-target@1', 'execute-verification-run@1']);
const mdlmShim = fileURLToPath(new URL('../bin/mdlm-demo-mdlm-shim.mjs', import.meta.url));
const executionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const operatorScalarPattern = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,255}$/;
const thinkingLevels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const assignmentCheckpointEvidence = Symbol('assignmentCheckpointEvidence');
const operationalFailureEvidence = Symbol('operationalFailureEvidence');
const outerTimeoutSafetyReserveMs = 60_000;

export async function run(request, mode) {
  requireContract(request, mode === 'resume' ? 'mdlm-demo-resume-request@1' : 'mdlm-demo-run-request@1');
  validateRunRequest(request);
  validateOperator(request.operator);
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
        ? await executeRun(request, context, assignmentDirectory, journalPath, initial, mode)
        : initial.status === 'provenance-failure'
          ? stopped('provenance-violation', 'initial snapshot contains provenance drift', initial, assignmentId)
          : stopped('command-failure', 'initial snapshot contains a failed or malformed command', initial, assignmentId, { failures: initial.failures });
    } catch (error) {
      output = stopped('orchestration-failure', error instanceof Error ? error.message : String(error), initial, assignmentId);
    }
    const postDirectory = await nextSnapshotDirectory(evidenceDirectory);
    const postAssignmentId = output[assignmentCheckpointEvidence]?.packet.assignment.id ?? assignmentId;
    const postRunSnapshot = await snapshotRequest(request, context.repository, postDirectory, postAssignmentId, journalPath, piJournalPath, true);
    output = await finalizeAssignmentCheckpoint(output, postRunSnapshot, assignmentId);
    output = await finalizeOperationalFailure(output, initial, postRunSnapshot, context, assignmentDirectory, request);
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

async function executeRun(request, context, assignmentDirectory, journalPath, snapshotResult, mode) {
  const assignmentId = request.assignmentId;
  const captured = JSON.parse(await readFile(path.join(snapshotResult.snapshotDirectory, 'snapshot.json'), 'utf8'));
  if (!sameConfiguredPath(request.commands?.mdlm, request.provenance?.tools?.mdlm?.path) ||
      !sameConfiguredPath(request.commands?.mdlmPi, request.provenance?.tools?.mdlmPi?.path) ||
      (request.harness && (!sameConfiguredPath(request.harness.directory, request.provenance?.qualificationHarness?.repository) ||
        request.harness.commit !== request.provenance?.qualificationHarness?.commit ||
        request.harness.tree !== request.provenance?.qualificationHarness?.tree ||
        request.harness.repositoryLocator !== request.provenance?.qualificationHarness?.repositoryLocator))) {
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
  const processPackage = reconcileProcessPackage(status.package, assignment.package, captured.diagnosis.package);
  if (processPackage === null) return stopped('package-drift', 'doctor, status, and Assignment Process Package identities differ', snapshotResult, assignmentId);
  const runIdentity = observedRunIdentity(captured.provenance, processPackage, request.operator, request);
  try {
    const hasRecoveryHistory = await operationalRecoveryHistoryExists(context, assignmentId);
    if (!hasRecoveryHistory) {
      await migrateLegacyOperationalFailure({
        request, context, assignmentDirectory, captured, snapshotResult, processPackage, runIdentity,
      });
    }
  } catch (error) {
    return stopped('operational-recovery-marker-invalid', error instanceof Error ? error.message : String(error), snapshotResult, assignmentId);
  }

  const recoveryGate = await inspectOperationalRecovery({
    request, mode, context, assignmentDirectory, captured, snapshotResult, processPackage, runIdentity,
  });
  if (!recoveryGate.ok) {
    return stopped('operational-recovery-marker-invalid', recoveryGate.detail, snapshotResult, assignmentId);
  }
  if (recoveryGate.requiredNextMode !== null) {
    return stopped(
      'wrong-recovery-mode',
      `the verified pre-submission operational failure requires '${recoveryGate.requiredNextMode}', not '${mode}'`,
      snapshotResult,
      assignmentId,
      { recoverable: true, requiredNextMode: recoveryGate.requiredNextMode, operationalFailureRecovery: recoveryGate.recovery },
    );
  }

  const identityMatch = await pinRunIdentity(context.identityDirectory, runIdentity, mode === 'run');
  if (!identityMatch) return stopped('run-identity-drift', 'operator, mdlm-pi timeout policy, artifact, installed Process Package, executable target, source, or harness identity changed', snapshotResult, assignmentId);

  const journal = await optionalCanonicalJson(journalPath);
  const materializedNextRecovery = captured.lifecycleRepository.clean === true
    ? await reconcileMaterializedNext({ request, context, assignmentDirectory, captured, processPackage, runIdentity })
    : { ok: true, result: null };
  if (!materializedNextRecovery.ok) {
    return stopped('materialized-next-reconciliation-failure', materializedNextRecovery.detail, snapshotResult, assignmentId);
  }
  const checkpointRecovery = captured.lifecycleRepository.clean === true
    ? await reconcilePriorAssignmentCheckpoint({ request, context, assignmentDirectory, captured, processPackage, runIdentity })
    : { ok: true, result: null };
  if (!checkpointRecovery.ok) {
    return stopped('checkpoint-reconciliation-failure', checkpointRecovery.detail, snapshotResult, assignmentId);
  }
  const withCheckpointRecovery = output => {
    if (materializedNextRecovery.result !== null) output.materializedNextReconciliation = materializedNextRecovery.result;
    if (checkpointRecovery.result !== null) output.checkpointReconciliation = checkpointRecovery.result;
    return output;
  };
  if (journal?.phase === 'completed') {
    const expected = journal.completedRepository;
    const exactCommitRecovery = expected === undefined && journal.commit === captured.lifecycleRepository.head && captured.lifecycleRepository.clean;
    if (!exactCommitRecovery && !sameJson(expected, captured.lifecycleRepository)) {
      return withCheckpointRecovery(stopped('repository-drift', 'repository differs from the completed transaction boundary', snapshotResult, assignmentId));
    }
    return withCheckpointRecovery(result('already-completed', snapshotResult, { assignmentId, executionId: journal.executionId, commit: journal.commit, outcome: journal.outcome }));
  }
  if (journal?.phase === 'submitting' || journal?.phase === 'uncertain-transaction') {
    return withCheckpointRecovery(stopped('uncertain-partial-publication', 'submission began without durable accepted execution evidence', snapshotResult, assignmentId, { transactionPhase: journal.phase }));
  }
  if (journal?.phase === 'uncertain-publication') {
    return withCheckpointRecovery(stopped('uncertain-partial-publication', 'Git publication state is uncertain', snapshotResult, assignmentId));
  }
  if (journal?.phase === 'published-uncommitted' && captured.lifecycleRepository.head !== journal.baseCommit) {
    if (captured.lifecycleRepository.clean !== true) {
      return withCheckpointRecovery(stopped('repository-drift', 'repository is dirty after HEAD advanced beyond the journaled publication parent', snapshotResult, assignmentId));
    }
    const publication = { executionId: journal.executionId, scenario: journal.scenario, outputPaths: journal.outputPaths, blobs: journal.blobs };
    try {
      const commit = await commitPublication(context.repository, publication, journal.baseCommit, request.timeoutMs, assignmentDirectory);
      if (commit !== captured.lifecycleRepository.head) throw new Error('snapshot HEAD differs from the exact journaled publication commit');
      await writeJournal(journalPath, { ...journal, phase: 'completed', commit, completedAt: new Date().toISOString(), trustedRepositoryAdvance: true });
      return withCheckpointRecovery(result('completed', snapshotResult, { assignmentId, executionId: publication.executionId, commit, recoveredPublication: true, outcome: 'accepted-publication', trustedRepositoryAdvance: true }));
    } catch (error) {
      return withCheckpointRecovery(stopped('repository-drift', error.message, snapshotResult, assignmentId));
    }
  }
  if (journal?.phase !== 'published-uncommitted' && captured.lifecycleRepository.clean !== true) {
    return withCheckpointRecovery(stopped('repository-dirty', 'lifecycle repository has tracked or untracked changes before submission', snapshotResult, assignmentId));
  }

  const repositoryMatch = await reconcileRepositoryIdentity(context.identityDirectory, assignmentDirectory, assignmentId, captured.lifecycleRepository, assignment.repository);
  if (!repositoryMatch.ok) return withCheckpointRecovery(stopped(repositoryMatch.reason, repositoryMatch.detail, snapshotResult, assignmentId));
  if (captured.diagnosis.ok !== true) return withCheckpointRecovery(stopped('integrity-drift', 'mdlm doctor did not return ok:true', snapshotResult, assignmentId));

  if (journal?.phase === 'published-uncommitted') {
    try {
      const publication = { executionId: journal.executionId, scenario: journal.scenario, outputPaths: journal.outputPaths, blobs: journal.blobs };
      const commit = await commitPublication(context.repository, publication, journal.baseCommit, request.timeoutMs, assignmentDirectory);
      await writeJournal(journalPath, { ...journal, phase: 'completed', commit, completedAt: new Date().toISOString(), trustedRepositoryAdvance: true });
      return withCheckpointRecovery(result('completed', snapshotResult, { assignmentId, executionId: publication.executionId, commit, recoveredPublication: true, outcome: 'accepted-publication', trustedRepositoryAdvance: true }));
    } catch (error) {
      await writeJournal(journalPath, { ...journal, phase: 'uncertain-publication', error: error.message });
      return withCheckpointRecovery(stopped('uncertain-partial-publication', error.message, snapshotResult, assignmentId));
    }
  }

  const durableCorrection = await inspectCorrectionContext(context, assignment);
  if (durableCorrection.authentic || request.signal === 'correction-session-lost') {
    return withCheckpointRecovery(stopped(
      durableCorrection.authentic ? 'correction-session-unresumable' : 'correction-context-lost',
      durableCorrection.authentic
        ? 'the installed mdlm-pi controller retains the submission journal but has no correction-session resume command; it was not restarted'
        : durableCorrection.detail,
      snapshotResult, assignmentId,
      { correction: durableCorrection, infrastructureStop: true },
    ));
  }
  if (assignment.disposition !== 'active' || assignment.id !== assignmentId || assignment.selected !== true || !statusHasActiveAssignment(status, assignmentId)) {
    return withCheckpointRecovery(stopped('assignment-not-active', 'requested Assignment is not the selected active durable lease in status and Assignment state', snapshotResult, assignmentId));
  }
  if (!sameRepositoryFingerprint(assignment.repository, captured.lifecycleRepository)) {
    return withCheckpointRecovery(stopped('repository-drift', 'Assignment repository fingerprint differs from the lifecycle repository snapshot', snapshotResult, assignmentId));
  }

  const prepare = await invoke(assignmentDirectory, request.commands.mdlm, ['scenario', 'prepare', assignmentId, '--json'], context.repository, request.timeoutMs);
  if (!commandSucceeded(prepare)) return withCheckpointRecovery(stopped('prepare-command-failure', 'MDLM could not prepare the active Assignment', snapshotResult, assignmentId, { process: commandRecord(prepare) }));
  let packet;
  try { packet = validateScenarioPrepare(parseJsonBytes(prepare.stdout, 'scenario prepare'), assignmentId); }
  catch (error) { return withCheckpointRecovery(stopped('malformed-assignment', error.message, snapshotResult, assignmentId, { process: commandRecord(prepare) })); }
  if (!sameProcessPackageIdentity(packet.package, assignment.package) || !sameJson(packet.repository, assignment.repository)) {
    return withCheckpointRecovery(stopped('assignment-fingerprint-drift', 'prepared packet differs from the snapshotted Assignment', snapshotResult, assignmentId));
  }
  if (!externalScenarios.has(packet.scenario?.reference)) {
    return withCheckpointRecovery(await runPiAssignment(request, context, assignmentDirectory, assignment, snapshotResult));
  }
  return withCheckpointRecovery(await runExternalAssignment(request, context, assignmentDirectory, journalPath, assignment, packet, prepare.stdout, snapshotResult, journal));
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
  const privateEvidenceBefore = await inspectOperationalPrivateEvidence(
    assignmentDirectory,
    path.join(context.gitDirectory, 'mdlm-pi', 'run.json'),
    path.join(shimDirectory, 'stops'),
  );
  await mkdir(shimDirectory, { recursive: true, mode: 0o700 });
  await writeOnceOrMatch(shimConfigPath, Buffer.from(`${JSON.stringify({
    contract: 'mdlm-demo-shim-config@1', realMdlm: request.commands.mdlm, allowedAssignment: assignmentId,
    package: assignment.package, repository: assignment.repository,
    stopDirectory: path.join(shimDirectory, 'stops'), timeoutMs: request.timeoutMs ?? 30_000,
  }, null, 2)}\n`));
  const args = [
    'run', context.repository,
    '--mdlm', mdlmShim,
    '--provider', request.operator.provider,
    '--model', request.operator.model,
    '--thinking', request.operator.thinking,
  ];
  const environment = controlledEnvironment({
    MDLM_DEMO_SHIM_CONFIG: shimConfigPath,
    MDLM_PI_COMMAND_TIMEOUT_MS: String(request.mdlmPiCommandTimeoutMs),
    MDLM_PI_ASSIGNMENT_TIMEOUT_MS: String(request.mdlmPiAssignmentTimeoutMs),
  });
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
    const trustedStop = await authenticateReservedStop(decoded.stop, shimDirectory, assignment.package);
    if (!trustedStop.ok) {
      return stopped('mdlm-pi-contract-failure', trustedStop.detail, snapshotResult, assignmentId, common);
    }
    const differentAssignment = decoded.stop.completedAssignment === assignmentId &&
      trustedStop.packet.assignment.id !== assignmentId;
    const externalCheckpoint = decoded.stop.type === 'accepted-assignment-then-external' &&
      externalScenarios.has(trustedStop.packet.scenario.reference);
    const ordinaryCheckpoint = decoded.stop.type === 'assignment-checkpoint' &&
      !externalScenarios.has(trustedStop.packet.scenario.reference);
    const output = result('stopped', snapshotResult, {
      ...common, recoverable: true, reason: 'reserved-shim-stop', stop: decoded.stop,
      outcome: 'pre-submission-stop', trustedRepositoryAdvance: false,
    });
    if (differentAssignment && (externalCheckpoint || ordinaryCheckpoint)) {
      output[assignmentCheckpointEvidence] = { packet: trustedStop.packet };
    }
    return output;
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
  const output = stopped(decoded.status, decoded.detail, snapshotResult, assignmentId, common);
  if (decoded.kind === 'operational-failure') {
    output[operationalFailureEvidence] = {
      privateEvidenceBefore,
      shimDirectory,
      commandEvidence: processResult.commandEvidence,
    };
  }
  return output;
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
  if (isTypedOperationalFailure(processResult, stdout, stderr)) {
    return {
      kind: 'operational-failure', status: 'mdlm-pi-operational-failure',
      detail: `mdlm-pi exit ${processResult.exitStatus} and result status '${status}' disagree`,
      document,
    };
  }
  return {
    kind: 'failure', status: 'mdlm-pi-contract-failure',
    detail: document === null ? `mdlm-pi exit ${processResult.exitStatus} did not end with a typed JSON result` : `mdlm-pi exit ${processResult.exitStatus} and result status '${status}' disagree`,
    document,
  };
}

function isTypedOperationalFailure(processResult, stdout, stderr) {
  if (processResult.exitStatus !== 1 || processResult.timedOut || processResult.signal !== null ||
      processResult.outputLimitExceeded || processResult.spawnError !== null || processResult.stdout.length !== 0 ||
      stdout !== null || stderr?.status !== 'operational-failure') return false;
  if (!sameJson(Object.keys(stderr).sort(), ['details', 'error', 'status'])) return false;
  if (typeof stderr.error !== 'string' || stderr.error.length === 0 || !stderr.details ||
      typeof stderr.details !== 'object' || Array.isArray(stderr.details)) return false;
  try { return sameJson(JSON.parse(processResult.stderr.toString('utf8')), stderr); }
  catch { return false; }
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
  if (value.contract === 'mdlm-demo-reserved-stop@1' && value.phase === 'before-worker' &&
      typeof value.type === 'string' && typeof value.assignment === 'string' && typeof value.scenario === 'string') return value;
  for (const child of Object.values(value)) {
    const found = findReservedStop(child);
    if (found !== null) return found;
  }
  return null;
}

async function authenticateReservedStop(stop, shimDirectory, processPackage) {
  try {
    if (typeof stop.packetPath !== 'string') throw new Error('reserved stop has no packet path');
    const stopsDirectory = await realpath(path.join(shimDirectory, 'stops'));
    const packetPath = await realpath(stop.packetPath);
    if (path.dirname(packetPath) !== stopsDirectory) throw new Error('reserved stop packet is outside the private stop directory');
    const information = await lstat(packetPath);
    if (!information.isFile() || information.isSymbolicLink()) throw new Error('reserved stop packet is not a regular file');
    const packet = validateScenarioPrepare(JSON.parse(await readFile(packetPath, 'utf8')), {
      assignmentId: stop.assignment,
      package: processPackage,
    });
    if (packet.scenario.reference !== stop.scenario) {
      throw new Error('reserved stop does not match its exact prepared Assignment packet');
    }
    return { ok: true, packet };
  } catch (error) {
    return { ok: false, detail: `reserved stop evidence is not authentic: ${error.message}` };
  }
}

async function finalizeAssignmentCheckpoint(output, postSnapshot, completedAssignment) {
  const evidence = output[assignmentCheckpointEvidence];
  if (evidence === undefined) return output;
  delete output[assignmentCheckpointEvidence];
  const packet = evidence.packet;
  const nextAssignment = packet.assignment.id;
  try {
    if (postSnapshot.status !== 'complete') throw new Error('post-run snapshot is not complete');
    const captured = JSON.parse(await readFile(path.join(postSnapshot.snapshotDirectory, 'snapshot.json'), 'utf8'));
    if (nextAssignment === completedAssignment) throw new Error('checkpoint did not advance to a different Assignment');
    if (captured.lifecycleRepository?.clean !== true) throw new Error('post-run lifecycle repository is not clean');
    if (!statusHasActiveAssignment(captured.status, nextAssignment)) throw new Error('post-run status does not select active Assignment B');
    if (captured.assignment?.id !== nextAssignment || captured.assignment.selected !== true || captured.assignment.disposition !== 'active') {
      throw new Error('post-run Assignment B is not the selected active durable lease');
    }
    if (captured.assignment.scenarioReference !== packet.scenario.reference) {
      throw new Error('post-run Assignment B Scenario differs from the retained packet');
    }
    if (!sameProcessPackageIdentity(packet.package, captured.status?.package) ||
        !sameProcessPackageIdentity(packet.package, captured.assignment.package) ||
        !sameProcessPackageIdentity(packet.package, captured.diagnosis?.package)) {
      throw new Error('post-run Process Package identity differs from the retained packet');
    }
    if (!sameJson(captured.assignment.repository, packet.repository) ||
        !sameRepositoryFingerprint(packet.repository, captured.lifecycleRepository)) {
      throw new Error('post-run repository identity differs from the retained packet');
    }
    output.status = 'completed';
    output.outcome = 'accepted-publication';
    output.trustedRepositoryAdvance = true;
    output.nextAssignment = { id: nextAssignment, scenario: packet.scenario.reference, phase: 'pre-submission' };
    return output;
  } catch (error) {
    output.status = 'stopped';
    output.recoverable = false;
    output.reason = 'assignment-checkpoint-authentication-failure';
    output.detail = error instanceof Error ? error.message : String(error);
    output.outcome = 'pre-submission-stop';
    output.trustedRepositoryAdvance = false;
    delete output.nextAssignment;
    return output;
  }
}

async function finalizeOperationalFailure(output, initialSnapshot, postSnapshot, context, assignmentDirectory, request) {
  const evidence = output[operationalFailureEvidence];
  if (evidence === undefined) return output;
  delete output[operationalFailureEvidence];
  try {
    if (initialSnapshot.status !== 'complete' || postSnapshot.status !== 'complete') {
      throw new Error('initial or post-run snapshot is incomplete');
    }
    const initial = JSON.parse(await readFile(path.join(initialSnapshot.snapshotDirectory, 'snapshot.json'), 'utf8'));
    const post = JSON.parse(await readFile(path.join(postSnapshot.snapshotDirectory, 'snapshot.json'), 'utf8'));
    if (initial.postRun !== false || post.postRun !== true || initial.repository !== post.repository ||
        initial.repository !== context.repository) {
      throw new Error('snapshot repository or phase is ambiguous');
    }
    if (initial.lifecycleRepository?.clean !== true || post.lifecycleRepository?.clean !== true ||
        !sameJson(initial.lifecycleRepository, post.lifecycleRepository)) {
      throw new Error('lifecycle repository bytes or identity changed');
    }
    for (const name of ['head', 'tree', 'status', 'stagedDiff', 'worktreeDiff']) {
      requireExactCommandBoundary(initial.git?.[name], post.git?.[name], `git ${name}`);
    }
    for (const name of ['doctor', 'status', 'assignment']) {
      requireExactCommandBoundary(initial.commands?.[name], post.commands?.[name], `mdlm ${name}`);
    }
    if (!sameJson(initial.assignment, post.assignment) || initial.assignment?.id !== output.assignmentId ||
        initial.assignment?.selected !== true || initial.assignment?.disposition !== 'active' ||
        !statusHasActiveAssignment(initial.status, output.assignmentId) ||
        !statusHasActiveAssignment(post.status, output.assignmentId)) {
      throw new Error('selected active Assignment changed or is ambiguous');
    }
    for (const snapshot of [initial, post]) {
      if (!sameProcessPackageIdentity(snapshot.status?.package, snapshot.assignment?.package) ||
          !sameProcessPackageIdentity(snapshot.status?.package, snapshot.diagnosis?.package)) {
        throw new Error('Process Package identity changed or is ambiguous');
      }
      requireCertainJournalAbsence(snapshot.journal, 'runner transaction journal');
      requireCertainJournalAbsence(snapshot.piJournal, 'mdlm-pi journal');
    }
    if (!evidence.privateEvidenceBefore.safe) {
      throw new Error(`private pre-run evidence is uncertain: ${evidence.privateEvidenceBefore.detail}`);
    }
    const privateEvidenceAfter = await inspectOperationalPrivateEvidence(
      assignmentDirectory,
      path.join(context.gitDirectory, 'mdlm-pi', 'run.json'),
      path.join(evidence.shimDirectory, 'stops'),
    );
    if (!privateEvidenceAfter.safe) {
      throw new Error(`private post-run evidence is uncertain: ${privateEvidenceAfter.detail}`);
    }
    const marker = await writeOperationalFailureMarker({
      source: 'verified-finalization',
      request,
      context,
      assignmentDirectory,
      assignmentId: output.assignmentId,
      initialSnapshot,
      initial,
      postSnapshot,
      post,
      processPackage: initial.status.package,
      commandEvidence: evidence.commandEvidence,
    });
    output.reason = 'pre-submission-operational-failure';
    output.outcome = 'pre-submission-operational-failure';
    output.recoverable = true;
    output.trustedRepositoryAdvance = false;
    output.operationalFailureRecovery = {
      verified: true,
      assignmentId: output.assignmentId,
      retryCommand: 'run',
      resumeAllowed: false,
      marker,
    };
  } catch (error) {
    output.recoverable = false;
    output.operationalFailureRecovery = {
      verified: false,
      uncertainty: error instanceof Error ? error.message : String(error),
    };
  }
  return output;
}

function requireExactCommandBoundary(initial, post, label) {
  const fields = [
    'argv', 'cwd', 'timeoutMs', 'timedOut', 'outputLimitExceeded', 'observedOutputBytes', 'exitStatus',
    'signal', 'spawnError', 'stdoutBase64', 'stderrBase64', 'stdoutSha256', 'stderrSha256',
  ];
  if (!initial || !post || !sameJson(
    Object.fromEntries(fields.map(field => [field, initial[field]])),
    Object.fromEntries(fields.map(field => [field, post[field]])),
  )) throw new Error(`${label} bytes or command identity changed`);
  for (const record of [initial, post]) {
    if (record.exitStatus !== 0 || record.timedOut !== false || record.outputLimitExceeded !== false ||
        record.signal !== null || record.spawnError !== null) throw new Error(`${label} did not complete exactly`);
    for (const stream of ['stdout', 'stderr']) {
      const base64 = record[`${stream}Base64`];
      if (typeof base64 !== 'string') throw new Error(`${label} has uncertain ${stream} bytes`);
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.toString('base64') !== base64 || sha256(bytes) !== record[`${stream}Sha256`]) {
        throw new Error(`${label} has inconsistent ${stream} bytes`);
      }
    }
    const observed = Buffer.from(record.stdoutBase64, 'base64').length + Buffer.from(record.stderrBase64, 'base64').length;
    if (record.observedOutputBytes !== observed) throw new Error(`${label} has uncertain retained bytes`);
  }
}

function requireCertainJournalAbsence(value, label) {
  if (!value || value.present !== false || typeof value.path !== 'string' || value.error !== undefined) {
    throw new Error(`${label} is present or uncertain`);
  }
}

async function inspectOperationalPrivateEvidence(assignmentDirectory, piJournalPath, stopsDirectory) {
  try {
    const present = [];
    for (const [label, file] of [
      ['runner transaction journal', path.join(assignmentDirectory, 'transaction.json')],
      ['mdlm-pi journal', piJournalPath],
    ]) {
      try { await lstat(file); present.push(label); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try {
      const information = await lstat(stopsDirectory);
      if (!information.isDirectory() || information.isSymbolicLink()) {
        throw new Error('private checkpoint path is not a canonical directory');
      }
      const entries = await readdir(stopsDirectory);
      if (entries.length > 0) present.push(`private checkpoint evidence (${entries.sort().join(', ')})`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return present.length === 0
      ? { safe: true, detail: 'no transaction, private publication, mdlm-pi journal, or checkpoint evidence' }
      : { safe: false, detail: present.join('; ') };
  } catch (error) {
    return { safe: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function operationalRecoveryDirectory(context, assignmentId) {
  return path.join(
    context.gitDirectory,
    'mdlm-demo-orchestrator',
    'operational-failure-recoveries',
    assignmentKey(assignmentId),
  );
}

async function operationalRecoveryHistoryExists(context, assignmentId) {
  const directory = operationalRecoveryDirectory(context, assignmentId);
  try { return (await readdir(directory)).length !== 0; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function inspectOperationalRecovery({ request, mode, context, assignmentDirectory, captured, snapshotResult, processPackage, runIdentity }) {
  try {
    const directory = operationalRecoveryDirectory(context, request.assignmentId);
    await recoverPendingOperationalRecoveryWrites(directory);
    const history = await readOperationalRecoveryHistory({
      directory, request, context, assignmentDirectory, processPackage, runIdentity,
    });
    const active = history.markers.filter(marker => !history.transitions.has(marker.index));
    if (active.length > 1) throw new Error('more than one operational failure marker requires recovery');
    let pendingLegacyUpgrade = null;
    for (const marker of history.markers) {
      if (marker.document.source === 'legacy-command-evidence-migration' && history.transitions.has(marker.index) &&
          await legacyMarkerIdentityVersion(context, marker.document, runIdentity) === 4) {
        if (pendingLegacyUpgrade !== null) throw new Error('more than one legacy run identity upgrade is pending');
        pendingLegacyUpgrade = marker;
      }
    }
    if (active.length === 0) {
      if (pendingLegacyUpgrade === null) return { ok: true, requiredNextMode: null };
      requireActiveOperationalBoundary(pendingLegacyUpgrade.document, captured, request.assignmentId);
      if (mode !== 'run') {
        return {
          ok: true,
          requiredNextMode: 'run',
          recovery: {
            marker: { path: pendingLegacyUpgrade.path, digest: pendingLegacyUpgrade.digest },
            source: pendingLegacyUpgrade.document.source,
          },
        };
      }
      await upgradeLegacyRunIdentity(context, pendingLegacyUpgrade.document, runIdentity);
      return { ok: true, requiredNextMode: null };
    }
    const marker = active[0];
    requireActiveOperationalBoundary(marker.document, captured, request.assignmentId);
    if (mode !== marker.document.requiredNextMode) {
      return {
        ok: true,
        requiredNextMode: marker.document.requiredNextMode,
        recovery: { marker: { path: marker.path, digest: marker.digest }, source: marker.document.source },
      };
    }
    const transition = {
      contract: 'mdlm-demo-operational-failure-retry@1',
      assignmentId: request.assignmentId,
      mode,
      marker: { path: marker.path, digest: marker.digest },
      lifecycleRepository: captured.lifecycleRepository,
      processPackage,
      runIdentity: marker.document.runIdentity,
      timeoutIdentity: marker.document.timeoutIdentity,
    };
    const transitionPath = path.join(directory, `retry-${String(marker.index).padStart(6, '0')}.json`);
    await durableCreateJson(transitionPath, transition, 'operational-recovery-retry');
    if (marker.document.source === 'legacy-command-evidence-migration') {
      await upgradeLegacyRunIdentity(context, marker.document, runIdentity);
    }
    return { ok: true, requiredNextMode: null };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function writeOperationalFailureMarker({
  source, request, context, assignmentDirectory, assignmentId, initialSnapshot, initial,
  postSnapshot, post, processPackage, commandEvidence,
}) {
  if (!commandEvidence || !Number.isSafeInteger(commandEvidence.index) || typeof commandEvidence.prefix !== 'string') {
    throw new Error('typed operational failure has no exact command evidence location');
  }
  const runIdentityPath = path.join(context.identityDirectory, 'run-identity.json');
  const runIdentityEvidence = await immutableFileEvidence(runIdentityPath);
  const command = await commandEvidenceManifest(commandEvidence.prefix, commandEvidence.index);
  const stored = await authenticateStoredCommand(path.dirname(commandEvidence.prefix), String(commandEvidence.index).padStart(6, '0'));
  const document = requireTypedOperationalFailure(stored.record, stored.stdout, stored.stderr);
  const marker = {
    contract: 'mdlm-demo-operational-failure-marker@1',
    assignmentId,
    requiredNextMode: 'run',
    source,
    assignmentDirectory: path.resolve(assignmentDirectory),
    initialBoundary: await operationalBoundary(initialSnapshot, initial),
    postBoundary: await operationalBoundary(postSnapshot, post),
    processPackage,
    runIdentity: {
      path: runIdentityEvidence.path,
      bytes: runIdentityEvidence.bytes.length,
      digest: runIdentityEvidence.digest,
    },
    timeoutIdentity: {
      timeoutMs: request.timeoutMs,
      mdlmPiCommandTimeoutMs: request.mdlmPiCommandTimeoutMs,
      mdlmPiAssignmentTimeoutMs: request.mdlmPiAssignmentTimeoutMs,
    },
    failure: {
      commandIndex: commandEvidence.index,
      evidence: command,
      document: {
        digest: sha256(stored.stderr),
        errorDigest: sha256(Buffer.from(document.error)),
        detailsDigest: sha256(Buffer.from(JSON.stringify(document.details))),
      },
    },
  };
  const directory = operationalRecoveryDirectory(context, assignmentId);
  const markerPath = path.join(directory, `failure-${String(commandEvidence.index).padStart(6, '0')}.json`);
  await durableCreateJson(markerPath, marker, 'operational-recovery-marker');
  const evidence = await immutableFileEvidence(markerPath);
  return { path: evidence.path, digest: evidence.digest };
}

async function operationalBoundary(snapshotResult, captured) {
  const manifestPath = path.join(snapshotResult.snapshotDirectory, 'manifest.json');
  await syncFile(manifestPath);
  await syncFile(path.join(snapshotResult.snapshotDirectory, 'snapshot.json'));
  await syncDirectory(snapshotResult.snapshotDirectory);
  const manifest = await immutableFileEvidence(manifestPath);
  if (manifest.digest !== snapshotResult.digest) throw new Error('operational failure snapshot manifest digest changed before marker publication');
  return {
    snapshotDirectory: path.resolve(snapshotResult.snapshotDirectory),
    digest: snapshotResult.digest,
    lifecycleRepository: captured.lifecycleRepository,
    assignmentRepository: captured.assignmentRepository,
  };
}

async function readOperationalRecoveryHistory({ directory, request, context, assignmentDirectory, processPackage, runIdentity }) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return { markers: [], transitions: new Map() };
    throw error;
  }
  await requireCanonicalDirectory(directory);
  const markerEntries = [];
  const retryEntries = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('operational recovery history contains a non-regular entry');
    let match = /^failure-([0-9]{6})\.json$/.exec(entry.name);
    if (match) {
      markerEntries.push({ entry, index: Number(match[1]) });
      continue;
    }
    match = /^retry-([0-9]{6})\.json$/.exec(entry.name);
    if (match) {
      const index = Number(match[1]);
      if (retryEntries.has(index)) throw new Error('operational recovery history has duplicate retry transitions');
      retryEntries.set(index, entry);
      continue;
    }
    throw new Error(`operational recovery history contains unsupported entry '${entry.name}'`);
  }
  markerEntries.sort((left, right) => left.index - right.index);
  const markers = [];
  for (const item of markerEntries) {
    const file = path.join(directory, item.entry.name);
    const evidence = await immutableFileEvidence(file);
    const document = JSON.parse(evidence.bytes.toString('utf8'));
    await validateOperationalFailureMarker({
      document, index: item.index, transitioned: retryEntries.has(item.index),
      request, context, assignmentDirectory, processPackage, runIdentity,
    });
    markers.push({ index: item.index, path: evidence.path, digest: evidence.digest, document });
  }
  for (const [index, entry] of retryEntries) {
    const marker = markers.find(item => item.index === index);
    if (!marker) throw new Error('operational recovery retry has no matching failure marker');
    const evidence = await immutableFileEvidence(path.join(directory, entry.name));
    const document = JSON.parse(evidence.bytes.toString('utf8'));
    const expected = {
      contract: 'mdlm-demo-operational-failure-retry@1',
      assignmentId: request.assignmentId,
      mode: 'run',
      marker: { path: marker.path, digest: marker.digest },
      lifecycleRepository: marker.document.postBoundary.lifecycleRepository,
      processPackage: marker.document.processPackage,
      runIdentity: marker.document.runIdentity,
      timeoutIdentity: marker.document.timeoutIdentity,
    };
    if (!sameJson(document, expected)) throw new Error('operational recovery retry transition is malformed or tampered');
  }
  return { markers, transitions: retryEntries };
}

async function validateOperationalFailureMarker({ document, index, transitioned, request, context, assignmentDirectory, processPackage, runIdentity }) {
  const keys = [
    'assignmentDirectory', 'assignmentId', 'contract', 'failure', 'initialBoundary', 'postBoundary',
    'processPackage', 'requiredNextMode', 'runIdentity', 'source', 'timeoutIdentity',
  ].sort();
  if (!document || typeof document !== 'object' || Array.isArray(document) ||
      !sameJson(Object.keys(document).sort(), keys) ||
      document.contract !== 'mdlm-demo-operational-failure-marker@1' ||
      document.assignmentId !== request.assignmentId || document.requiredNextMode !== 'run' ||
      !['verified-finalization', 'legacy-command-evidence-migration'].includes(document.source) ||
      path.resolve(document.assignmentDirectory ?? '') !== path.resolve(assignmentDirectory) ||
      !sameProcessPackageIdentity(document.processPackage, processPackage)) {
    throw new Error('operational failure marker identity is malformed or tampered');
  }
  const timeoutIdentity = {
    timeoutMs: request.timeoutMs,
    mdlmPiCommandTimeoutMs: request.mdlmPiCommandTimeoutMs,
    mdlmPiAssignmentTimeoutMs: request.mdlmPiAssignmentTimeoutMs,
  };
  if (!sameJson(document.timeoutIdentity, timeoutIdentity)) throw new Error('operational failure marker timeout identity differs');
  const runIdentityPath = path.join(context.identityDirectory, 'run-identity.json');
  if (document.source === 'legacy-command-evidence-migration') {
    const legacyBytes = serializedLegacyRunIdentity(runIdentity);
    if (!sameJson(document.runIdentity, {
      path: path.resolve(runIdentityPath), bytes: legacyBytes.length, digest: sha256(legacyBytes),
    })) {
      throw new Error('legacy operational failure marker run identity differs');
    }
    const observed = await immutableFileEvidence(runIdentityPath);
    const currentBytes = serializedRunIdentity(runIdentity);
    if (!observed.bytes.equals(legacyBytes) && !(transitioned && observed.bytes.equals(currentBytes))) {
      throw new Error('legacy operational failure marker requires its byte-exact @4 run identity');
    }
  } else {
    const observedRunIdentity = await immutableFileEvidence(runIdentityPath);
    if (!sameJson(document.runIdentity, {
      path: observedRunIdentity.path, bytes: observedRunIdentity.bytes.length, digest: observedRunIdentity.digest,
    }) || !observedRunIdentity.bytes.equals(serializedRunIdentity(runIdentity))) {
      throw new Error('operational failure marker run identity differs');
    }
  }
  await validateOperationalBoundary(document.initialBoundary, false);
  await validateOperationalBoundary(document.postBoundary, true);
  const failure = document.failure;
  if (!failure || !sameJson(Object.keys(failure).sort(), ['commandIndex', 'document', 'evidence']) || failure.commandIndex !== index) {
    throw new Error('operational failure marker command identity is malformed');
  }
  const commandDirectory = path.join(assignmentDirectory, 'command-evidence');
  const expectedPrefix = path.join(commandDirectory, `command-${String(index).padStart(6, '0')}`);
  for (const [name, suffix] of [['record', 'json'], ['stdout', 'stdout'], ['stderr', 'stderr']]) {
    const expectedPath = `${expectedPrefix}.${suffix}`;
    const expected = await immutableFileEvidence(expectedPath);
    if (!sameJson(failure.evidence?.[name], {
      path: expected.path, bytes: expected.bytes.length, digest: expected.digest,
    })) throw new Error('operational failure marker command evidence hash differs');
  }
  const stored = await authenticateStoredCommand(commandDirectory, String(index).padStart(6, '0'));
  requireStoredProcess(stored.record, [
    request.commands.mdlmPi, 'run', context.repository, '--mdlm', mdlmShim,
    '--provider', request.operator.provider, '--model', request.operator.model,
    '--thinking', request.operator.thinking,
  ], context.repository, request.timeoutMs, 1);
  const typed = requireTypedOperationalFailure(stored.record, stored.stdout, stored.stderr);
  const expectedDocument = {
    digest: sha256(stored.stderr),
    errorDigest: sha256(Buffer.from(typed.error)),
    detailsDigest: sha256(Buffer.from(JSON.stringify(typed.details))),
  };
  if (!sameJson(failure.document, expectedDocument)) throw new Error('operational failure marker typed command document differs');
}

function serializedRunIdentity(runIdentity) {
  return Buffer.from(`${JSON.stringify(runIdentity, null, 2)}\n`);
}

function serializedLegacyRunIdentity(runIdentity) {
  const legacy = { ...runIdentity, contract: 'mdlm-demo-run-identity@4' };
  delete legacy.mdlmPiCommandTimeoutMs;
  delete legacy.mdlmPiAssignmentTimeoutMs;
  return serializedRunIdentity(legacy);
}

async function legacyMarkerIdentityVersion(context, marker, runIdentity) {
  const identityPath = path.join(context.identityDirectory, 'run-identity.json');
  const observed = await immutableFileEvidence(identityPath);
  if (observed.path !== marker.runIdentity.path) {
    throw new Error('legacy operational failure marker run identity path differs');
  }
  if (observed.bytes.equals(serializedLegacyRunIdentity(runIdentity))) return 4;
  if (observed.bytes.equals(serializedRunIdentity(runIdentity))) return 5;
  throw new Error('legacy operational failure marker requires its byte-exact @4 run identity or recorded @5 upgrade');
}

async function upgradeLegacyRunIdentity(context, marker, runIdentity) {
  if (await legacyMarkerIdentityVersion(context, marker, runIdentity) === 5) return;
  const identityPath = path.join(context.identityDirectory, 'run-identity.json');
  await durableWriteJson(identityPath, runIdentity, 'legacy-run-identity-upgrade');
  const upgraded = await immutableFileEvidence(identityPath);
  if (!upgraded.bytes.equals(serializedRunIdentity(runIdentity))) {
    throw new Error('legacy run identity upgrade did not publish the exact @5 identity');
  }
}

async function validateOperationalBoundary(boundary, expectedPostRun) {
  if (!boundary || !sameJson(Object.keys(boundary).sort(), [
    'assignmentRepository', 'digest', 'lifecycleRepository', 'snapshotDirectory',
  ])) throw new Error('operational failure marker boundary is malformed');
  if (typeof boundary.snapshotDirectory !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(boundary.digest ?? '')) {
    throw new Error('operational failure marker snapshot identity is malformed');
  }
  const verified = await verifySnapshot(boundary.snapshotDirectory, boundary.digest, expectedPostRun);
  const snapshot = verified.snapshot;
  if (!sameJson(snapshot.lifecycleRepository, boundary.lifecycleRepository) ||
      !sameJson(snapshot.assignmentRepository, boundary.assignmentRepository)) {
    throw new Error('operational failure marker snapshot boundary differs');
  }
}

function requireActiveOperationalBoundary(marker, captured, assignmentId) {
  if (!sameJson(marker.postBoundary.lifecycleRepository, captured.lifecycleRepository) ||
      !sameJson(marker.postBoundary.assignmentRepository, captured.assignmentRepository) ||
      captured.lifecycleRepository?.clean !== true || captured.assignment?.id !== assignmentId ||
      captured.assignment.selected !== true || captured.assignment.disposition !== 'active' ||
      !statusHasActiveAssignment(captured.status, assignmentId)) {
    throw new Error('active operational failure marker differs from the current Assignment boundary');
  }
  requireCertainJournalAbsence(captured.journal, 'runner transaction journal');
  requireCertainJournalAbsence(captured.piJournal, 'mdlm-pi journal');
}

async function migrateLegacyOperationalFailure({ request, context, assignmentDirectory, captured, snapshotResult, processPackage, runIdentity }) {
  const identityPath = path.join(context.identityDirectory, 'run-identity.json');
  let identityEvidence;
  try { identityEvidence = await immutableFileEvidence(identityPath); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let legacyIdentity;
  try { legacyIdentity = JSON.parse(identityEvidence.bytes.toString('utf8')); }
  catch { throw new Error('legacy run identity is not valid JSON'); }
  if (legacyIdentity?.contract !== 'mdlm-demo-run-identity@4') return null;
  const commandDirectory = path.join(assignmentDirectory, 'command-evidence');
  let names;
  try { names = (await readdir(commandDirectory)).sort(); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!names.includes('command-000002.json')) return null;
  const expectedPi = [
    request.commands.mdlmPi, 'run', context.repository, '--mdlm', mdlmShim,
    '--provider', request.operator.provider, '--model', request.operator.model, '--thinking', request.operator.thinking,
  ];
  let failed;
  try { failed = await authenticateStoredCommand(commandDirectory, '000002'); }
  catch (error) { throw new Error(`legacy operational failure command evidence is ambiguous: ${error.message}`); }
  let possibleFailure = null;
  try { possibleFailure = JSON.parse(failed.stderr.toString('utf8')); } catch {}
  if (!sameJson(failed.record.argv, expectedPi) ||
      (failed.record.exitStatus !== 1 && possibleFailure?.status !== 'operational-failure')) return null;
  if (request.operationalFailureRecovery === undefined) {
    throw new Error('operationalFailureRecovery with the operator-pinned run-008 result and both snapshots is required');
  }
  if (request.timeoutMs !== 900_000 || request.mdlmPiCommandTimeoutMs !== 600_000 ||
      request.mdlmPiAssignmentTimeoutMs !== 840_000) {
    throw new Error('legacy operational failure recovery requires the exact run-009 timeout policy');
  }
  const recovery = request.operationalFailureRecovery;
  const resultEvidence = await immutableFileEvidence(recovery.resultPath);
  if (resultEvidence.digest !== recovery.resultDigest) throw new Error('pinned run-008 result digest differs from the operator pin');
  let priorResult;
  try { priorResult = JSON.parse(resultEvidence.bytes.toString('utf8')); }
  catch { throw new Error('pinned run-008 result is not valid JSON'); }
  const resultKeys = [
    'assignmentId', 'contract', 'decision', 'detail', 'mdlmPi', 'postRunSnapshot',
    'process', 'reason', 'recoverable', 'snapshot', 'status',
  ].sort();
  if (!priorResult || typeof priorResult !== 'object' || Array.isArray(priorResult) ||
      !sameJson(Object.keys(priorResult).sort(), resultKeys) || priorResult.contract !== 'mdlm-demo-run-result@2' ||
      priorResult.status !== 'stopped' || priorResult.assignmentId !== 'bdb9ffc9-3491-443b-88b0-80d5dc800781' ||
      priorResult.assignmentId !== request.assignmentId || priorResult.recoverable !== false ||
      priorResult.reason !== 'mdlm-pi-operational-failure' ||
      priorResult.detail !== "mdlm-pi exit 1 and result status 'operational-failure' disagree" ||
      !priorResult.decision || !sameJson(Object.keys(priorResult.decision).sort(), ['authorityBasis', 'digest', 'origin']) ||
      priorResult.decision.origin !== 'operator-selected' ||
      typeof priorResult.decision.authorityBasis !== 'string' || priorResult.decision.authorityBasis.length === 0 ||
      !/^sha256:[0-9a-f]{64}$/.test(priorResult.decision.digest ?? '')) {
    throw new Error('pinned run-008 result does not have the exact legacy operational-failure contract');
  }
  const exactSnapshotReference = (actual, directory, digest, label) => {
    const expected = { contract: 'mdlm-demo-snapshot-created@1', status: 'complete', snapshotDirectory: directory, digest };
    if (!sameJson(actual, expected)) throw new Error(`pinned run-008 result ${label} reference differs from the operator pin`);
  };
  exactSnapshotReference(priorResult.snapshot, recovery.initialSnapshotDirectory, recovery.initialSnapshotDigest, 'initial snapshot');
  exactSnapshotReference(priorResult.postRunSnapshot, recovery.postSnapshotDirectory, recovery.postSnapshotDigest, 'post-run snapshot');
  const initialSnapshot = await verifySnapshot(recovery.initialSnapshotDirectory, recovery.initialSnapshotDigest, false);
  const postSnapshot = await verifySnapshot(recovery.postSnapshotDirectory, recovery.postSnapshotDigest, true);
  const initial = initialSnapshot.snapshot;
  const post = postSnapshot.snapshot;
  const unchanged = sameJson(initial.lifecycleRepository, post.lifecycleRepository) &&
    sameJson(initial.assignmentRepository, post.assignmentRepository) && sameJson(initial.assignment, post.assignment) &&
    sameJson(initial.status, post.status) && sameJson(initial.diagnosis, post.diagnosis) &&
    sameJson(
      observedRunIdentity(initial.provenance, processPackage, request.operator, request),
      observedRunIdentity(post.provenance, processPackage, request.operator, request),
    );
  if (!unchanged || initial.lifecycleRepository?.clean !== true || post.lifecycleRepository?.clean !== true ||
      initial.assignment?.id !== request.assignmentId || initial.assignment.selected !== true ||
      initial.assignment.disposition !== 'active' || !statusHasActiveAssignment(initial.status, request.assignmentId) ||
      !sameProcessPackageIdentity(initial.status?.package, processPackage) ||
      !sameRepositoryFingerprint(initial.assignmentRepository, initial.lifecycleRepository)) {
    throw new Error('pinned run-008 snapshots do not prove one exact unchanged clean active Assignment boundary');
  }
  for (const [snapshot, label] of [[initial, 'initial'], [post, 'post-run'], [captured, 'current']]) {
    requireCertainJournalAbsence(snapshot.journal, `${label} runner transaction journal`);
    requireCertainJournalAbsence(snapshot.piJournal, `${label} mdlm-pi journal`);
  }
  if (!sameJson(captured.lifecycleRepository, post.lifecycleRepository) ||
      !sameJson(captured.assignmentRepository, post.assignmentRepository) ||
      !sameJson(captured.assignment, post.assignment) || !sameProcessPackageIdentity(captured.status?.package, post.status?.package)) {
    throw new Error('current boundary differs from the operator-pinned run-008 post-run snapshot');
  }
  const expectedLegacyIdentity = observedRunIdentity(initial.provenance, processPackage, request.operator, request);
  expectedLegacyIdentity.contract = 'mdlm-demo-run-identity@4';
  delete expectedLegacyIdentity.mdlmPiCommandTimeoutMs;
  delete expectedLegacyIdentity.mdlmPiAssignmentTimeoutMs;
  const currentAsLegacy = { ...runIdentity, contract: 'mdlm-demo-run-identity@4' };
  delete currentAsLegacy.mdlmPiCommandTimeoutMs;
  delete currentAsLegacy.mdlmPiAssignmentTimeoutMs;
  if (!sameJson(legacyIdentity, expectedLegacyIdentity) || !sameJson(legacyIdentity, currentAsLegacy) ||
      !identityEvidence.bytes.equals(serializedRunIdentity(expectedLegacyIdentity))) {
    throw new Error('legacy run identity is not the byte-exact operator, artifact, package, tool, source, and harness identity');
  }

  const expectedNames = ['command-000001.json', 'command-000001.stderr', 'command-000001.stdout',
    'command-000002.json', 'command-000002.stderr', 'command-000002.stdout'];
  if (!sameJson(names, expectedNames)) throw new Error('legacy operational failure command evidence is not the exact two-command sequence');
  const prepared = await authenticateStoredCommand(commandDirectory, '000001');
  requireStoredProcess(prepared.record, [request.commands.mdlm, 'scenario', 'prepare', request.assignmentId, '--json'], context.repository, 900_000, 0);
  if (prepared.stderr.length !== 0) throw new Error('legacy operational failure prepare command has stderr bytes');
  validateScenarioPrepare(JSON.parse(prepared.stdout.toString('utf8')), {
    assignmentId: request.assignmentId, package: processPackage, repository: initial.assignmentRepository,
  });
  requireStoredProcess(failed.record, expectedPi, context.repository, 900_000, 1);
  const failure = requireTypedOperationalFailure(failed.record, failed.stdout, failed.stderr);
  const exactFailure = { status: 'operational-failure', error: 'MDLM command exceeded 30000ms', details: { arguments: ['status', '--json'] } };
  if (!sameJson(failure, exactFailure) || !sameJson(priorResult.process, failed.record) ||
      !sameJson(priorResult.mdlmPi, {
        kind: 'failure', status: 'mdlm-pi-operational-failure',
        detail: "mdlm-pi exit 1 and result status 'operational-failure' disagree", document: exactFailure,
      })) {
    throw new Error('private run-008 command evidence differs from the operator-pinned result');
  }
  const identity = await optionalJson(path.join(assignmentDirectory, 'identity.json'));
  const expectedIdentity = {
    contract: 'mdlm-demo-assignment-identity@1', assignmentId: request.assignmentId,
    lifecycleRepository: initial.lifecycleRepository, assignmentRepository: initial.assignmentRepository,
  };
  if (!sameJson(identity, expectedIdentity)) throw new Error('legacy Assignment identity differs from the pinned run-008 boundary');
  const stopDirectory = path.join(assignmentDirectory, 'shim', 'stops');
  const shimConfig = await optionalJson(path.join(assignmentDirectory, 'shim', 'config.json'));
  const expectedShimConfig = {
    contract: 'mdlm-demo-shim-config@1', realMdlm: request.commands.mdlm,
    allowedAssignment: request.assignmentId, package: processPackage,
    repository: initial.assignmentRepository, stopDirectory, timeoutMs: 900_000,
  };
  if (!sameJson(shimConfig, expectedShimConfig)) throw new Error('legacy shim configuration differs from the pinned run-008 boundary');
  const privateEvidence = await inspectOperationalPrivateEvidence(
    assignmentDirectory, path.join(context.gitDirectory, 'mdlm-pi', 'run.json'), stopDirectory,
  );
  if (!privateEvidence.safe) throw new Error(`legacy operational failure has ambiguous private evidence: ${privateEvidence.detail}`);
  return writeOperationalFailureMarker({
    source: 'legacy-command-evidence-migration', request, context, assignmentDirectory,
    assignmentId: request.assignmentId, initialSnapshot, initial, postSnapshot, post, processPackage,
    commandEvidence: { index: 2, prefix: path.join(commandDirectory, 'command-000002') },
  });
}

function requireTypedOperationalFailure(record, stdout, stderr) {
  if (stdout.length !== 0 || record.exitStatus !== 1 || record.timedOut !== false || record.signal !== null ||
      record.outputLimitExceeded !== false || record.spawnError !== null || record.stdoutSha256 !== sha256(stdout) ||
      record.stderrSha256 !== sha256(stderr) || record.observedOutputBytes !== stderr.length) {
    throw new Error('operational failure command termination evidence is not exact');
  }
  let document;
  try { document = JSON.parse(stderr.toString('utf8')); }
  catch { throw new Error('operational failure stderr is not one exact JSON document'); }
  if (!document || typeof document !== 'object' || Array.isArray(document) ||
      !sameJson(Object.keys(document).sort(), ['details', 'error', 'status']) ||
      document.status !== 'operational-failure' || typeof document.error !== 'string' || document.error.length === 0 ||
      !document.details || typeof document.details !== 'object' || Array.isArray(document.details) ||
      !sameJson(JSON.parse(stderr.toString('utf8')), document)) {
    throw new Error('operational failure stderr is not a strictly typed operational failure');
  }
  return document;
}

async function commandEvidenceManifest(prefix) {
  const output = {};
  for (const [name, suffix] of [['record', 'json'], ['stdout', 'stdout'], ['stderr', 'stderr']]) {
    await syncFile(`${prefix}.${suffix}`);
    const evidence = await immutableFileEvidence(`${prefix}.${suffix}`);
    output[name] = { path: evidence.path, bytes: evidence.bytes.length, digest: evidence.digest };
  }
  await syncDirectory(path.dirname(prefix));
  return output;
}

async function syncFile(file) {
  const handle = await open(file, 'r');
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function immutableFileEvidence(file) {
  const evidence = await readCanonicalEvidenceFile(path.resolve(file));
  return { ...evidence, digest: sha256(evidence.bytes) };
}

async function recoverPendingOperationalRecoveryWrites(directory) {
  let names;
  try { names = await readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of names) {
    if (!name.endsWith('.pending')) continue;
    const pending = path.join(directory, name);
    const target = pending.slice(0, -'.pending'.length);
    const targetInformation = await optionalLstat(target);
    if (targetInformation !== null) throw new Error('operational recovery history contains an ambiguous completed and pending write');
    JSON.parse((await immutableFileEvidence(pending)).bytes.toString('utf8'));
    await rename(pending, target);
    await syncDirectory(directory);
  }
}

async function durableCreateJson(file, value, phase) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let directory = path.dirname(file);
  for (let depth = 0; depth < 3; depth++) {
    await syncDirectory(directory);
    directory = path.dirname(directory);
  }
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const existing = await optionalLstat(file);
  if (existing !== null) {
    if (!existing.isFile() || !(await readFile(file)).equals(bytes)) throw new Error('immutable operational recovery history differs');
    return;
  }
  const pending = `${file}.pending`;
  const pendingInformation = await optionalLstat(pending);
  if (pendingInformation === null) {
    const handle = await open(pending, 'wx', 0o400);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
  } else if (!pendingInformation.isFile() || !(await readFile(pending)).equals(bytes)) {
    throw new Error('pending operational recovery history differs');
  }
  await syncDirectory(path.dirname(file));
  maybeInjectedCrash(phase, 'after-temp-sync');
  await rename(pending, file);
  await syncDirectory(path.dirname(file));
  maybeInjectedCrash(phase, 'after-rename');
}

async function inspectCorrectionContext(context, assignment, resultDocument) {
  const journalPath = path.join(context.gitDirectory, 'mdlm-pi', 'run.json');
  let journal;
  try { journal = JSON.parse(await readFile(journalPath, 'utf8')); }
  catch (error) { return { authentic: false, controllerResumeSupported: false, journalPath, detail: `durable mdlm-pi journal unavailable: ${error.message}` }; }
  const responseDigest = resultDocument?.responseDigest ?? journal.submission?.digest;
  const submission = journal.submission;
  const previous = submission?.previousMalformedResponseDigests;
  const current = Array.isArray(assignment.malformedResponses) ? assignment.malformedResponses.map(item => item?.digest) : null;
  const processValid = value => value && typeof value === 'object' && typeof value.id === 'string' && value.id.length > 0 &&
    Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.stdoutPath === 'string' && value.stdoutPath.length > 0 &&
    typeof value.stderrPath === 'string' && value.stderrPath.length > 0;
  const journalShapeValid = journal.contract === 'mdlm-pi-run-journal@1' && journal.phase === 'submitting' &&
    journal.assignment?.id === assignment.id && journal.assignment?.scenario === assignment.scenarioReference &&
    sameProcessPackageIdentity(journal.assignment?.package, assignment.package) && sameJson(journal.assignment?.repository, assignment.repository) &&
    typeof submission?.source === 'string' && /^sha256:[0-9a-f]{64}$/.test(submission?.digest ?? '') &&
    sha256(Buffer.from(submission.source)) === submission.digest &&
    (submission.previousTransactionId === null || typeof submission.previousTransactionId === 'string') &&
    typeof submission.baseCommit === 'string' && submission.baseCommit.length > 0 &&
    Array.isArray(previous) && previous.every(digest => /^sha256:[0-9a-f]{64}$/.test(digest)) &&
    Array.isArray(submission.completedProcesses) && submission.completedProcesses.every(processValid) &&
    (submission.process === undefined || processValid(submission.process));
  const exactCorrectionHistory = journalShapeValid && Array.isArray(current) && current.every(digest => /^sha256:[0-9a-f]{64}$/.test(digest)) &&
    current.length === previous.length + 1 && previous.every((digest, index) => current[index] === digest) &&
    current.at(-1) === submission.digest;
  const authentic = exactCorrectionHistory && /^sha256:[0-9a-f]{64}$/.test(responseDigest ?? '') && submission.digest === responseDigest;
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

function observedRunIdentity(provenance, processPackage, operator, request) {
  const gitIdentity = value => ({ repository: value.repository, commit: value.observedCommit, tree: value.observedTree });
  const file = value => ({ realpath: value.realpath, digest: value.digest, bytes: value.bytes });
  return {
    contract: 'mdlm-demo-run-identity@5',
    operator: { provider: operator.provider, model: operator.model, thinking: operator.thinking },
    mdlmPiCommandTimeoutMs: request.mdlmPiCommandTimeoutMs,
    mdlmPiAssignmentTimeoutMs: request.mdlmPiAssignmentTimeoutMs,
    processPackage,
    source: gitIdentity(provenance.source),
    packageArtifact: file(provenance.package),
    piPackageArtifact: file(provenance.piPackage),
    tooling: {
      contract: provenance.tooling.contract, digest: provenance.tooling.digest, entries: provenance.tooling.entries,
      files: provenance.tooling.files, symlinks: provenance.tooling.symlinks, bytes: provenance.tooling.bytes,
      lock: file(provenance.tooling.lock),
    },
    tools: { mdlm: file(provenance.tools.mdlm), mdlmPi: file(provenance.tools.mdlmPi) },
    qualificationHarness: {
      ...gitIdentity(provenance.qualificationHarness),
      repositoryLocator: provenance.qualificationHarness.repositoryLocator,
      manifest: file(provenance.qualificationHarness.manifest),
    },
  };
}
async function pinRunIdentity(identityDirectory, current, allowTimeoutMigration) {
  const file = path.join(identityDirectory, 'run-identity.json');
  const previous = await optionalJson(file);
  if (previous === null) { await durableWriteJson(file, current); return true; }
  if (sameJson(previous, current)) return true;
  if (allowTimeoutMigration && previous.contract === 'mdlm-demo-run-identity@4') {
    const legacyCurrent = { ...current, contract: 'mdlm-demo-run-identity@4' };
    delete legacyCurrent.mdlmPiCommandTimeoutMs;
    delete legacyCurrent.mdlmPiAssignmentTimeoutMs;
    if (sameJson(previous, legacyCurrent)) {
      await durableWriteJson(file, current);
      return true;
    }
  }
  return false;
}
function reconcileProcessPackage(statusPackage, assignmentPackage, doctorPackage) {
  try {
    const normalized = normalizeProcessPackage(statusPackage, 'status.package');
    if (!sameProcessPackageIdentity(statusPackage, assignmentPackage)) return null;
    if (doctorPackage !== undefined && !sameProcessPackageIdentity(statusPackage, doctorPackage)) return null;
    return normalized;
  } catch {
    return null;
  }
}

async function reconcileMaterializedNext({ request, context, assignmentDirectory, captured, processPackage, runIdentity }) {
  const recovery = request.materializedNextRecovery;
  const reconciliationDirectory = path.join(context.identityDirectory, 'materialized-next-reconciliations');
  const journalPath = path.join(reconciliationDirectory, `${assignmentKey(request.assignmentId)}.json`);
  const existing = await optionalCanonicalJson(journalPath);
  if (recovery === undefined && existing === null) return { ok: true, result: null };
  try {
    if (recovery === undefined) throw new Error('materializedNextRecovery operator pins are required to resume reconciliation');
    const globalPath = path.join(context.identityDirectory, 'repository-identity.json');
    const global = await optionalCanonicalJson(globalPath);
    if (global?.contract !== 'mdlm-demo-repository-identity@1' || !global.lifecycleRepository) {
      throw new Error('prior durable repository identity is missing or malformed');
    }
    const authenticated = await authenticateMaterializedNext({
      request, context, assignmentDirectory, captured, processPackage, runIdentity, global,
    });
    if (existing !== null) {
      if (!['authenticated', 'boundary-advanced', 'completed'].includes(existing.phase)) {
        throw new Error(`unsupported materialized next reconciliation phase '${existing.phase}'`);
      }
      if (!sameJson(materializedNextEvidence(existing), materializedNextEvidence(authenticated))) {
        throw new Error('materialized next reconciliation journal differs from the pinned evidence');
      }
    } else {
      await mkdir(reconciliationDirectory, { recursive: true, mode: 0o700 });
      await syncDirectory(context.identityDirectory);
      await writeJournal(journalPath, authenticated);
    }
    const priorPhase = existing?.phase ?? null;
    const final = await completeMaterializedNextReconciliation({
      journalPath, journal: { ...authenticated, phase: priorPhase ?? 'authenticated' }, globalPath, global,
    });
    return {
      ok: true,
      result: {
        status: priorPhase === 'completed' ? 'already-reconciled' : 'reconciled',
        fromCommit: final.priorRepository.head,
        toCommit: final.completedRepository.head,
        executions: final.executions.map(execution => execution.id),
      },
    };
  } catch (error) {
    return { ok: false, detail: `pinned materialized next evidence is not authentic: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function authenticateMaterializedNext({ request, context, assignmentDirectory, captured, processPackage, runIdentity, global }) {
  const recovery = request.materializedNextRecovery;
  const acceptedEvidence = await requirePinnedEvidence(recovery.acceptedResult, 'accepted run result');
  let accepted;
  try { accepted = JSON.parse(acceptedEvidence.bytes.toString('utf8')); }
  catch { throw new Error('accepted run result is not valid JSON'); }
  const acceptedKeys = [
    'assignmentId', 'commit', 'contract', 'executionId', 'outcome', 'postRunSnapshot', 'snapshot', 'status',
    'trustedRepositoryAdvance',
  ].sort();
  if (!accepted || !sameJson(Object.keys(accepted).sort(), acceptedKeys) ||
      accepted.contract !== 'mdlm-demo-run-result@2' || accepted.status !== 'completed' ||
      accepted.outcome !== 'accepted-publication' || accepted.trustedRepositoryAdvance !== true ||
      typeof accepted.assignmentId !== 'string' || !executionIdPattern.test(accepted.executionId ?? '') ||
      !/^[0-9a-f]{40,64}$/.test(accepted.commit ?? '')) {
    throw new Error('accepted run result is not one exact trusted accepted publication');
  }
  requireSnapshotResult(accepted.snapshot, 'accepted run initial snapshot');
  requireSnapshotResult(accepted.postRunSnapshot, 'accepted run post snapshot');
  if (accepted.postRunSnapshot.snapshotDirectory !== path.resolve(recovery.oldSnapshot.directory) ||
      accepted.postRunSnapshot.digest !== recovery.oldSnapshot.digest) {
    throw new Error('accepted run result does not name the operator-pinned old snapshot');
  }

  const oldSnapshot = await verifySnapshot(recovery.oldSnapshot.directory, recovery.oldSnapshot.digest, true);
  const finalSnapshot = await verifySnapshot(recovery.finalSnapshot.directory, recovery.finalSnapshot.digest, false);
  const old = oldSnapshot.snapshot;
  const final = finalSnapshot.snapshot;
  if (old.repository !== context.repository || final.repository !== context.repository) {
    throw new Error('pinned snapshots name a different lifecycle repository');
  }
  if (old.lifecycleRepository?.clean !== true || accepted.commit !== old.lifecycleRepository.head ||
      (!sameJson(global.lifecycleRepository, old.lifecycleRepository) &&
       !sameJson(global.lifecycleRepository, final.lifecycleRepository))) {
    throw new Error('accepted result, old snapshot, and trusted repository identity do not agree on an authorized boundary');
  }
  if (global.lastAssignment?.id !== accepted.assignmentId || global.lastAssignment.completed !== true ||
      global.lastAssignment.outcome !== 'accepted-publication') {
    throw new Error('trusted repository identity does not name the accepted Assignment');
  }
  requireSnapshotPackage(old, processPackage, 'old');
  if (old.diagnosis?.ok !== true || old.diagnosis.baselineRepositoryVerification?.processDrift !== 0) {
    throw new Error('old snapshot doctor did not prove zero process drift');
  }
  if (!old.journal?.present || typeof old.journal.path !== 'string' || typeof old.journal.bytesBase64 !== 'string' ||
      old.journal.digest !== sha256(Buffer.from(old.journal.bytesBase64, 'base64'))) {
    throw new Error('old snapshot lacks exact accepted transaction journal bytes');
  }
  const sourceDirectory = path.join(path.dirname(assignmentDirectory), assignmentKey(accepted.assignmentId));
  await requireCanonicalDirectory(sourceDirectory);
  const transactionPath = path.join(sourceDirectory, 'transaction.json');
  if (path.resolve(old.journal.path) !== transactionPath) throw new Error('old snapshot journal path differs from the accepted Assignment state');
  const transactionEvidence = await readCanonicalEvidenceFile(transactionPath);
  const snapshotTransactionBytes = Buffer.from(old.journal.bytesBase64, 'base64');
  let transaction;
  let snapshotTransaction;
  try {
    transaction = JSON.parse(transactionEvidence.bytes.toString('utf8'));
    snapshotTransaction = JSON.parse(snapshotTransactionBytes.toString('utf8'));
  } catch { throw new Error('accepted Assignment transaction is not valid JSON'); }
  if (!sameJson(transaction, { ...snapshotTransaction, completedRepository: old.lifecycleRepository })) {
    throw new Error('accepted Assignment transaction is not the exact finalized old snapshot transaction');
  }
  if (transaction.contract !== 'mdlm-demo-transaction-journal@2' || transaction.phase !== 'completed' ||
      transaction.assignmentId !== accepted.assignmentId || transaction.executionId !== accepted.executionId ||
      transaction.commit !== accepted.commit || transaction.outcome !== undefined ||
      transaction.trustedRepositoryAdvance !== true ||
      !sameProcessPackageIdentity(transaction.package, processPackage)) {
    throw new Error('accepted Assignment transaction does not prove the accepted result');
  }

  const nextStdout = await requirePinnedEvidence(recovery.nextStdout, 'mdlm next stdout');
  const nextStderr = await requirePinnedEvidence(recovery.nextStderr, 'mdlm next stderr');
  const nextExit = await requirePinnedEvidence(recovery.nextExit, 'mdlm next exit');
  if (nextStderr.bytes.length !== 0) throw new Error('mdlm next stderr is not empty');
  if (!nextExit.bytes.equals(Buffer.from('0\n'))) throw new Error('mdlm next exit is not exactly zero');
  let next;
  try { next = JSON.parse(nextStdout.bytes.toString('utf8')); }
  catch { throw new Error('mdlm next stdout is not valid JSON'); }
  const nextKeys = ['assignment', 'command', 'contract', 'diagnostics', 'materializedExecutions', 'ok', 'outcome', 'package', 'phase'];
  if (!next || !sameJson(Object.keys(next).sort(), nextKeys) || next.contract !== 'mdlm-next@1' ||
      next.command !== 'next' || next.ok !== true || next.outcome !== 'assignment' ||
      typeof next.phase !== 'string' || next.phase.length === 0 ||
      !next.assignment || !sameJson(Object.keys(next.assignment).sort(), ['id']) ||
      typeof next.assignment.id !== 'string' || next.assignment.id.length === 0 ||
      !Array.isArray(next.diagnostics) || next.diagnostics.length !== 0 ||
      !sameProcessPackageIdentity(next.package, processPackage) ||
      !Array.isArray(next.materializedExecutions) || next.materializedExecutions.length === 0) {
    throw new Error('mdlm next stdout is not one exact successful materialization result');
  }
  const executionIds = new Set();
  const executions = next.materializedExecutions.map((execution, index) => {
    if (!execution || !sameJson(Object.keys(execution).sort(), ['id', 'scenario', 'status']) ||
        !executionIdPattern.test(execution.id ?? '') || !/^.+@[1-9][0-9]*$/.test(execution.scenario ?? '') ||
        execution.status !== 'completed' || executionIds.has(execution.id)) {
      throw new Error(`mdlm next materialized execution ${index} is malformed, duplicate, or incomplete`);
    }
    executionIds.add(execution.id);
    return execution;
  });

  requireMaterializedFinalBoundary(final, context, request.assignmentId, captured, processPackage, 'pinned final');
  requireMaterializedFinalBoundary(captured, context, request.assignmentId, captured, processPackage, 'live');
  if (!sameJson(final.lifecycleRepository, captured.lifecycleRepository) ||
      !sameJson(final.assignmentRepository, captured.assignmentRepository)) {
    throw new Error('pinned final snapshot differs from the exact live clean boundary');
  }
  for (const [snapshotRecord, label] of [[final, 'pinned final'], [captured, 'live']]) {
    requireCertainJournalAbsence(snapshotRecord.journal, `${label} runner transaction journal`);
    requireCertainJournalAbsence(snapshotRecord.piJournal, `${label} mdlm-pi journal`);
  }
  const oldRunIdentity = observedRunIdentity(old.provenance, processPackage, request.operator, request);
  const finalRunIdentity = observedRunIdentity(final.provenance, processPackage, request.operator, request);
  if (!sameJson(oldRunIdentity, runIdentity) || !sameJson(finalRunIdentity, runIdentity)) {
    throw new Error('operator, package, tool, source, or harness identity differs across materialized next boundaries');
  }
  const commits = await authenticateMaterializedExecutionCommits(
    context.repository, old.lifecycleRepository.head, captured.lifecycleRepository.head, executions,
  );

  return {
    contract: 'mdlm-demo-materialized-next-reconciliation@1',
    phase: 'authenticated',
    assignmentId: request.assignmentId,
    acceptedAssignment: accepted.assignmentId,
    priorRepository: old.lifecycleRepository,
    completedRepository: captured.lifecycleRepository,
    package: processPackage,
    executions: executions.map((execution, index) => ({ ...execution, commit: commits[index] })),
    materializedNextRecovery: {
      acceptedResult: evidenceManifest(acceptedEvidence),
      oldSnapshot: { directory: oldSnapshot.snapshotDirectory, digest: oldSnapshot.digest, manifest: oldSnapshot.manifest },
      nextStdout: evidenceManifest(nextStdout), nextStderr: evidenceManifest(nextStderr), nextExit: evidenceManifest(nextExit),
      finalSnapshot: { directory: finalSnapshot.snapshotDirectory, digest: finalSnapshot.digest, manifest: finalSnapshot.manifest },
      transaction: evidenceManifest(transactionEvidence),
    },
  };
}

function requireSnapshotResult(value, label) {
  if (!value || !sameJson(Object.keys(value).sort(), ['contract', 'digest', 'snapshotDirectory', 'status']) ||
      value.contract !== 'mdlm-demo-snapshot-created@1' || value.status !== 'complete' ||
      typeof value.snapshotDirectory !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.digest ?? '')) {
    throw new Error(`${label} is malformed`);
  }
}

function requireSnapshotPackage(snapshotRecord, processPackage, label) {
  if (!sameProcessPackageIdentity(snapshotRecord.status?.package, processPackage) ||
      !sameProcessPackageIdentity(snapshotRecord.diagnosis?.package, processPackage)) {
    throw new Error(`${label} snapshot Process Package differs`);
  }
}

function requireMaterializedFinalBoundary(snapshotRecord, context, assignmentId, captured, processPackage, label) {
  requireSnapshotPackage(snapshotRecord, processPackage, label);
  if (snapshotRecord.repository !== context.repository || snapshotRecord.lifecycleRepository?.clean !== true ||
      snapshotRecord.diagnosis?.ok !== true ||
      snapshotRecord.diagnosis.baselineRepositoryVerification?.processDrift !== 0 ||
      snapshotRecord.assignment?.id !== assignmentId || snapshotRecord.assignment.selected !== true ||
      snapshotRecord.assignment.disposition !== 'active' || !statusHasActiveAssignment(snapshotRecord.status, assignmentId) ||
      !sameProcessPackageIdentity(snapshotRecord.assignment.package, processPackage) ||
      !sameJson(snapshotRecord.assignment.repository, snapshotRecord.assignmentRepository) ||
      !sameRepositoryFingerprint(snapshotRecord.assignmentRepository, snapshotRecord.lifecycleRepository) ||
      snapshotRecord.lifecycleRepository.head !== captured.lifecycleRepository.head ||
      snapshotRecord.lifecycleRepository.tree !== captured.lifecycleRepository.tree ||
      snapshotRecord.lifecycleRepository.trackedState !== captured.lifecycleRepository.trackedState) {
    throw new Error(`${label} snapshot does not prove the final clean active Assignment boundary`);
  }
}

async function authenticateMaterializedExecutionCommits(repository, oldHead, newHead, executions) {
  const runGit = async args => {
    const command = await runProcess('git', args, { cwd: repository, timeoutMs: 900_000, env: gitEnvironment() });
    if (!commandSucceeded(command)) throw new Error(`Git materialization evidence failed for ${args.join(' ')}`);
    return command.stdout;
  };
  await runGit(['merge-base', '--is-ancestor', oldHead, newHead]);
  const commits = (await runGit(['rev-list', '--reverse', `${oldHead}..${newHead}`])).toString('utf8').trim().split('\n').filter(Boolean);
  if (commits.length !== executions.length) {
    throw new Error('materialized commit count differs from the exact mdlm next execution list');
  }
  let parent = oldHead;
  for (const [index, execution] of executions.entries()) {
    const commit = commits[index];
    const parents = (await runGit(['rev-list', '--parents', '-n', '1', commit])).toString('utf8').trim().split(' ');
    if (!sameJson(parents, [commit, parent])) throw new Error('materialized ancestry contains a merge, reorder, or unexplained parent');
    const subject = (await runGit(['show', '-s', '--format=%s', commit])).toString('utf8').trim();
    if (subject !== `mdlm: publish ${execution.scenario} (${execution.id})`) {
      throw new Error('materialized commit subject differs from its execution and evaluation order');
    }
    const transactionRoot = `.lifecycle/data/.transactions/${execution.id}`;
    const paths = (await runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', commit])).toString('utf8').trim().split('\n').filter(Boolean).sort();
    const executionPath = `${transactionRoot}/execution.json`;
    if (!paths.includes(executionPath) || paths.some(file => !file.startsWith(`${transactionRoot}/`))) {
      throw new Error('materialized commit contains a missing execution record or unrelated path');
    }
    const treeEntries = (await runGit(['ls-tree', '-r', commit, '--', transactionRoot])).toString('utf8').trim().split('\n').filter(Boolean);
    if (treeEntries.length !== paths.length || treeEntries.some(entry => !entry.startsWith('100644 blob '))) {
      throw new Error('materialized transaction contains a symlink, substitution, or unexpected tree entry');
    }
    let record;
    try { record = JSON.parse((await runGit(['show', `${commit}:${executionPath}`])).toString('utf8')); }
    catch { throw new Error('materialized execution record is not valid JSON'); }
    const outputPaths = record?.outputs?.map(output => output?.lifecycleDatum?.path);
    if (record?.contract !== 'mdlm-scenario-execution@4' || record.id !== execution.id ||
        record.status !== 'completed' || record.definition?.scenario !== execution.scenario ||
        record.response?.contract !== 'mdlm-assignment-response@1' || typeof record.response.assignment !== 'string' ||
        !Array.isArray(outputPaths) || outputPaths.length === 0 || new Set(outputPaths).size !== outputPaths.length ||
        outputPaths.some(output => typeof output !== 'string' || !output.startsWith(`${transactionRoot}/`)) ||
        !sameJson(paths, [executionPath, ...outputPaths].sort())) {
      throw new Error('materialized commit does not contain the matching completed execution record and outputs');
    }
    parent = commit;
  }
  if (parent !== newHead) throw new Error('materialized commit sequence does not end at the final boundary');
  return commits;
}

function materializedNextEvidence(value) {
  return {
    contract: value.contract, assignmentId: value.assignmentId, acceptedAssignment: value.acceptedAssignment,
    priorRepository: value.priorRepository, completedRepository: value.completedRepository, package: value.package,
    executions: value.executions, materializedNextRecovery: value.materializedNextRecovery,
  };
}

async function completeMaterializedNextReconciliation({ journalPath, journal, globalPath, global }) {
  const advancedIdentity = {
    contract: 'mdlm-demo-repository-identity@1', lifecycleRepository: journal.completedRepository,
    lastAssignment: { id: journal.acceptedAssignment, outcome: 'accepted-publication', completed: true },
  };
  if (journal.phase === 'completed') {
    if (!sameJson(global, advancedIdentity)) throw new Error('completed materialized next repository identity differs');
    return journal;
  }
  if (journal.phase === 'authenticated') {
    if (sameJson(global.lifecycleRepository, journal.priorRepository)) {
      await durableWriteJson(globalPath, advancedIdentity, 'materialized-next-reconciliation-global');
    } else if (!sameJson(global, advancedIdentity)) {
      throw new Error('repository identity advanced to an unrelated materialized next boundary');
    }
    journal = { ...journal, phase: 'boundary-advanced' };
    await writeJournal(journalPath, journal);
  } else if (!sameJson(global, advancedIdentity)) {
    throw new Error('repository identity differs from the journaled materialized next boundary');
  }
  if (journal.phase !== 'completed') {
    journal = { ...journal, phase: 'completed' };
    await writeJournal(journalPath, journal);
  }
  return journal;
}

async function reconcilePriorAssignmentCheckpoint({ request, context, assignmentDirectory, captured, processPackage, runIdentity }) {
  const assignmentId = request.assignmentId;
  const globalPath = path.join(context.identityDirectory, 'repository-identity.json');
  const global = await optionalJson(globalPath);
  if (global === null) return { ok: true, result: null };
  try {
    if (global.contract !== 'mdlm-demo-repository-identity@1' || !global.lifecycleRepository) {
      throw new Error('prior durable repository identity is malformed');
    }
    const reconciliationDirectory = path.join(context.identityDirectory, 'checkpoint-reconciliations');
    const existing = await existingCheckpointReconciliation(reconciliationDirectory, assignmentId);
    if (existing === null && sameJson(global.lifecycleRepository, captured.lifecycleRepository)) {
      return { ok: true, result: null };
    }
    let sourceDirectory;
    let priorStatus = null;
    if (existing !== null) {
      priorStatus = existing.document.phase;
      sourceDirectory = existing.document.sourceAssignmentDirectory;
      if (typeof sourceDirectory !== 'string') throw new Error('checkpoint reconciliation has no source Assignment directory');
    } else {
      const candidates = await priorBoundaryAssignments(path.dirname(assignmentDirectory), assignmentDirectory, global.lifecycleRepository);
      if (candidates.length === 0) return { ok: true, result: null };
      if (candidates.length !== 1) throw new Error('prior repository boundary has ambiguous Assignment checkpoint sources');
      sourceDirectory = candidates[0];
    }

    const authenticationInput = {
      request, context, sourceDirectory, captured, processPackage, runIdentity,
      priorRepository: existing?.document.priorRepository ?? global.lifecycleRepository,
    };
    const orphaned = request.orphanedCheckpointRecovery !== undefined ||
      existing?.document.orphanedCheckpointRecovery !== undefined;
    const authenticated = orphaned
      ? await authenticateOrphanedAssignmentCheckpoint(authenticationInput)
      : await authenticatePriorAssignmentCheckpoint(authenticationInput);
    const journalName = `${assignmentKey(authenticated.fromAssignment)}-to-${assignmentKey(assignmentId)}.json`;
    const journalPath = path.join(reconciliationDirectory, journalName);
    if (existing !== null) {
      if (existing.path !== journalPath) throw new Error('checkpoint reconciliation filename differs from its authenticated Assignments');
      if (!sameJson(reconciliationEvidence(existing.document), reconciliationEvidence(authenticated.record))) {
        throw new Error('checkpoint reconciliation journal differs from the retained command evidence');
      }
      if (!['authenticated', 'boundary-advanced', 'completed'].includes(existing.document.phase)) {
        throw new Error(`unsupported checkpoint reconciliation phase '${existing.document.phase}'`);
      }
    } else {
      await mkdir(reconciliationDirectory, { recursive: true, mode: 0o700 });
      await syncDirectory(context.identityDirectory);
      await writeJournal(journalPath, { ...authenticated.record, phase: 'authenticated' });
    }

    await validateExistingCheckpointTransaction(sourceDirectory, authenticated.record, journalPath);
    const final = await completeCheckpointReconciliation({
      journalPath,
      journal: { ...authenticated.record, phase: priorStatus ?? 'authenticated' },
      globalPath,
      global,
      sourceDirectory,
    });
    return {
      ok: true,
      result: {
        status: priorStatus === 'completed' ? 'already-reconciled' : 'reconciled',
        fromAssignment: final.fromAssignment,
        toAssignment: final.toAssignment,
      },
    };
  } catch (error) {
    return { ok: false, detail: `retained Assignment checkpoint is not authentic: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function existingCheckpointReconciliation(directory, toAssignment) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  await requireCanonicalDirectory(directory);
  const matches = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    if (!entry.isFile()) throw new Error('checkpoint reconciliation journal is not a regular file');
    const file = path.join(directory, entry.name);
    const document = JSON.parse((await readCanonicalEvidenceFile(file)).bytes.toString('utf8'));
    if (document.contract === 'mdlm-demo-checkpoint-reconciliation@1' && document.toAssignment === toAssignment) {
      matches.push({ path: file, document });
    }
  }
  if (matches.length > 1) throw new Error('more than one checkpoint reconciliation targets the current Assignment');
  return matches[0] ?? null;
}

async function priorBoundaryAssignments(assignmentsDirectory, currentAssignmentDirectory, priorRepository) {
  await requireCanonicalDirectory(assignmentsDirectory);
  const entries = await readdir(assignmentsDirectory, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(assignmentsDirectory, entry.name);
    if (directory === currentAssignmentDirectory) continue;
    const identityPath = path.join(directory, 'identity.json');
    let identity;
    try { identity = JSON.parse((await readCanonicalEvidenceFile(identityPath)).bytes.toString('utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (sameJson(identity.lifecycleRepository, priorRepository)) candidates.push(directory);
  }
  return candidates;
}

async function authenticateOrphanedAssignmentCheckpoint({ request, context, sourceDirectory, captured, processPackage, priorRepository, runIdentity }) {
  const recovery = request.orphanedCheckpointRecovery;
  if (recovery === undefined) throw new Error('orphanedCheckpointRecovery with all operator-pinned child checkpoint evidence is required');
  const toAssignment = request.assignmentId;
  await requireCanonicalDirectory(sourceDirectory);
  const sourceEntries = (await readdir(sourceDirectory)).sort();
  const permittedSourceEntries = sourceEntries.includes('transaction.json')
    ? ['command-evidence', 'identity.json', 'shim', 'transaction.json']
    : ['command-evidence', 'identity.json', 'shim'];
  if (!sameJson(sourceEntries, permittedSourceEntries)) {
    throw new Error('source Assignment private evidence is missing, extra, or ambiguous');
  }
  const identityEvidence = await readCanonicalEvidenceFile(path.join(sourceDirectory, 'identity.json'));
  const identity = JSON.parse(identityEvidence.bytes.toString('utf8'));
  if (!identity || !sameJson(Object.keys(identity).sort(), ['assignmentId', 'assignmentRepository', 'contract', 'lifecycleRepository']) ||
      identity.contract !== 'mdlm-demo-assignment-identity@1' || typeof identity.assignmentId !== 'string') {
    throw new Error('source Assignment identity is malformed');
  }
  const fromAssignment = identity.assignmentId;
  if (fromAssignment === toAssignment || path.basename(sourceDirectory) !== assignmentKey(fromAssignment)) {
    throw new Error('orphaned checkpoint source and target Assignments are invalid');
  }
  if (!sameJson(identity.lifecycleRepository, priorRepository) || !sameRepositoryFingerprint(identity.assignmentRepository, priorRepository) ||
      priorRepository.clean !== true) {
    throw new Error('source Assignment identity differs from the prior clean repository boundary');
  }

  const initialSnapshot = await verifySnapshot(recovery.initialSnapshotDirectory, recovery.initialSnapshotDigest, false);
  const postSnapshot = await verifySnapshot(recovery.postSnapshotDirectory, recovery.postSnapshotDigest, true);
  const initial = initialSnapshot.snapshot;
  const post = postSnapshot.snapshot;
  requireOrphanSnapshotIdentity(initial, context, fromAssignment, identity.assignmentRepository, processPackage, 'initial');
  requireCurrentOrphanBoundary(post, context, toAssignment, captured, processPackage, 'pinned post-run');
  requireCurrentOrphanBoundary(captured, context, toAssignment, captured, processPackage, 'current');
  if (!sameJson(initial.lifecycleRepository, priorRepository)) {
    throw new Error('operator-pinned initial snapshot differs from the prior trusted repository boundary');
  }
  const initialRunIdentity = observedRunIdentity(initial.provenance, processPackage, request.operator, request);
  const postRunIdentity = observedRunIdentity(post.provenance, processPackage, request.operator, request);
  if (!sameJson(initialRunIdentity, runIdentity) || !sameJson(postRunIdentity, runIdentity)) {
    throw new Error('operator, package, tool, source, or harness identity differs across orphaned checkpoint boundaries');
  }
  for (const [snapshot, label] of [[initial, 'initial'], [post, 'pinned post-run'], [captured, 'current']]) {
    requireCertainJournalAbsence(snapshot.journal, `${label} runner transaction journal`);
    requireCertainJournalAbsence(snapshot.piJournal, `${label} mdlm-pi journal`);
    if (snapshot.diagnosis?.baselineRepositoryVerification?.processDrift !== 0 ||
        !Number.isSafeInteger(snapshot.diagnosis?.baselineRepositoryVerification?.verifiedBaselines)) {
      throw new Error(`${label} doctor did not verify its baseline repository without process drift`);
    }
  }

  const commandDirectory = path.join(sourceDirectory, 'command-evidence');
  const shimDirectory = path.join(sourceDirectory, 'shim');
  const stopsDirectory = path.join(shimDirectory, 'stops');
  await requireCanonicalDirectory(commandDirectory);
  await requireCanonicalDirectory(shimDirectory);
  await requireCanonicalDirectory(stopsDirectory);
  const transitionEvidence = await requirePinnedEvidence(recovery.retryTransition, 'retry transition');
  const transitionDirectory = path.dirname(transitionEvidence.path);
  const history = await readOperationalRecoveryHistory({
    directory: transitionDirectory,
    request: { ...request, assignmentId: fromAssignment }, context,
    assignmentDirectory: sourceDirectory, processPackage, runIdentity,
  });
  if (history.markers.length !== 1 || history.transitions.size !== 1) {
    throw new Error('operational recovery history is missing, extra, or ambiguous');
  }
  const [failureIndex, transitionEntry] = [...history.transitions.entries()][0];
  if (failureIndex !== 2 || path.join(transitionDirectory, transitionEntry.name) !== transitionEvidence.path) {
    throw new Error('operator-pinned retry transition is not the exact second-command durable transition');
  }
  const transition = JSON.parse(transitionEvidence.bytes.toString('utf8'));
  if (transition.contract !== 'mdlm-demo-operational-failure-retry@1' || transition.mode !== 'run' ||
      transition.assignmentId !== fromAssignment || !sameJson(transition.lifecycleRepository, priorRepository) ||
      !sameProcessPackageIdentity(transition.processPackage, processPackage) ||
      !sameJson(transition.timeoutIdentity, {
        timeoutMs: 900_000, mdlmPiCommandTimeoutMs: 600_000, mdlmPiAssignmentTimeoutMs: 840_000,
      }) || request.timeoutMs !== 900_000 || request.mdlmPiCommandTimeoutMs !== 600_000 ||
      request.mdlmPiAssignmentTimeoutMs !== 840_000) {
    throw new Error('retry transition does not prove the exact authorized run and timeout identity');
  }
  const observedIdentity = await immutableFileEvidence(path.join(context.identityDirectory, 'run-identity.json'));
  if (!observedIdentity.bytes.equals(serializedRunIdentity(runIdentity)) || runIdentity.contract !== 'mdlm-demo-run-identity@5') {
    throw new Error('orphaned checkpoint recovery requires the exact upgraded @5 run identity');
  }

  const prepareIndex = failureIndex + 1;
  const index = String(prepareIndex).padStart(6, '0');
  const expectedCommandNames = [];
  for (let commandIndex = 1; commandIndex <= prepareIndex; commandIndex++) {
    const number = String(commandIndex).padStart(6, '0');
    expectedCommandNames.push(`command-${number}.json`, `command-${number}.stderr`, `command-${number}.stdout`);
  }
  expectedCommandNames.sort();
  if (!sameJson((await readdir(commandDirectory)).sort(), expectedCommandNames)) {
    throw new Error('command evidence is missing, extra, or later than the exact operational history and prepare command');
  }
  const originalPrepare = await authenticateStoredCommand(commandDirectory, '000001');
  const prepared = await authenticateStoredCommand(commandDirectory, index);
  const expectedPrepare = [request.commands.mdlm, 'scenario', 'prepare', fromAssignment, '--json'];
  let preparedPacket;
  for (const [stored, label] of [[originalPrepare, 'original'], [prepared, 'retry']]) {
    requireStoredProcess(stored.record, expectedPrepare, context.repository, 900_000, 0);
    if (stored.stderr.length !== 0) throw new Error(`orphaned ${label} Scenario prepare command has stderr bytes`);
    const packet = validateScenarioPrepare(JSON.parse(stored.stdout.toString('utf8')), {
      assignmentId: fromAssignment, package: processPackage, repository: identity.assignmentRepository,
    });
    if (preparedPacket === undefined) preparedPacket = packet;
    else if (!sameJson(packet, preparedPacket)) throw new Error('orphaned original and retry Scenario prepare packets differ');
  }
  const preparePins = [recovery.prepare.record, recovery.prepare.stdout, recovery.prepare.stderr];
  for (let evidenceIndex = 0; evidenceIndex < prepared.evidence.length; evidenceIndex++) {
    const pinned = await requirePinnedEvidence(preparePins[evidenceIndex], `prepare ${['record', 'stdout', 'stderr'][evidenceIndex]}`);
    if (pinned.path !== prepared.evidence[evidenceIndex].path || !pinned.bytes.equals(prepared.evidence[evidenceIndex].bytes)) {
      throw new Error('operator-pinned prepare triplet differs from the exact stored command');
    }
  }

  const configEvidence = await requirePinnedEvidence(recovery.shimConfig, 'shim configuration');
  const processedEvidence = await requirePinnedEvidence(recovery.processedAssignment, 'processed Assignment marker');
  const checkpointEvidence = await requirePinnedEvidence(recovery.assignmentCheckpoint, 'Assignment checkpoint marker');
  const packetEvidence = await requirePinnedEvidence(recovery.stopPacket, 'retained stop packet');
  const expectedPaths = {
    config: path.join(shimDirectory, 'config.json'),
    processed: path.join(shimDirectory, 'processed-assignment.json'),
    checkpoint: path.join(shimDirectory, 'assignment-checkpoint.json'),
    packet: path.join(stopsDirectory, `${toAssignment}.json`),
  };
  if (configEvidence.path !== expectedPaths.config || processedEvidence.path !== expectedPaths.processed ||
      checkpointEvidence.path !== expectedPaths.checkpoint || packetEvidence.path !== expectedPaths.packet) {
    throw new Error('operator-pinned private evidence does not use the exact source Assignment paths');
  }
  if (!sameJson((await readdir(shimDirectory)).sort(), ['assignment-checkpoint.json', 'config.json', 'processed-assignment.json', 'stops']) ||
      !sameJson((await readdir(stopsDirectory)).sort(), [`${toAssignment}.json`])) {
    throw new Error('shim checkpoint evidence is missing, extra, or ambiguous');
  }
  const config = JSON.parse(configEvidence.bytes.toString('utf8'));
  if (!sameJson(config, {
    contract: 'mdlm-demo-shim-config@1', realMdlm: request.commands.mdlm, allowedAssignment: fromAssignment,
    package: processPackage, repository: identity.assignmentRepository, stopDirectory: stopsDirectory, timeoutMs: 900_000,
  })) throw new Error('shim configuration differs from Assignment A, package, repository, or operator run identity');
  const processed = JSON.parse(processedEvidence.bytes.toString('utf8'));
  if (!sameJson(processed, {
    contract: 'mdlm-demo-shim-processed-assignment@1', assignment: fromAssignment,
    package: processPackage, repository: identity.assignmentRepository,
  })) throw new Error('processed Assignment marker does not prove A at the old boundary');
  const checkpoint = JSON.parse(checkpointEvidence.bytes.toString('utf8'));
  if (!checkpoint || !sameJson(Object.keys(checkpoint).sort(), ['assignment', 'completedAssignment', 'contract', 'scenario']) ||
      checkpoint.contract !== 'mdlm-demo-shim-assignment-checkpoint@1' || checkpoint.completedAssignment !== fromAssignment ||
      checkpoint.assignment !== toAssignment || typeof checkpoint.scenario !== 'string') {
    throw new Error('Assignment checkpoint marker does not prove exact A-to-B advancement');
  }
  const packet = validateScenarioPrepare(JSON.parse(packetEvidence.bytes.toString('utf8')), {
    assignmentId: toAssignment, package: processPackage,
    repository: { head: captured.lifecycleRepository.head, trackedState: captured.lifecycleRepository.trackedState },
  });
  if (packet.scenario.reference !== checkpoint.scenario || captured.assignment.scenarioReference !== checkpoint.scenario) {
    throw new Error('retained B stop packet Scenario differs from the checkpoint or active Assignment');
  }
  await authenticateLifecycleTransactionAncestry(context.repository, priorRepository.head, captured.lifecycleRepository.head);

  const evidence = {
    identity: evidenceManifest(identityEvidence),
    transition: evidenceManifest(transitionEvidence),
    prepare: prepared.evidence.map(evidenceManifest),
    config: evidenceManifest(configEvidence),
    processedAssignment: evidenceManifest(processedEvidence),
    assignmentCheckpoint: evidenceManifest(checkpointEvidence),
    packet: evidenceManifest(packetEvidence),
  };
  return {
    fromAssignment,
    record: {
      contract: 'mdlm-demo-checkpoint-reconciliation@1', phase: 'authenticated', fromAssignment, toAssignment,
      sourceAssignmentDirectory: sourceDirectory, priorRepository, completedRepository: captured.lifecycleRepository,
      scenario: packet.scenario.reference, sourceScenario: preparedPacket.scenario.reference, package: processPackage,
      orphanedCheckpointRecovery: {
        initialSnapshotDirectory: initialSnapshot.snapshotDirectory, initialSnapshotDigest: initialSnapshot.digest,
        postSnapshotDirectory: postSnapshot.snapshotDirectory, postSnapshotDigest: postSnapshot.digest,
        evidence,
      },
      evidence,
    },
  };
}

function requireOrphanSnapshotIdentity(snapshot, context, assignmentId, repository, processPackage, label) {
  if (snapshot.repository !== context.repository || snapshot.lifecycleRepository?.clean !== true ||
      snapshot.assignment?.id !== assignmentId || snapshot.assignment.selected !== true || snapshot.assignment.disposition !== 'active' ||
      !statusHasActiveAssignment(snapshot.status, assignmentId) || snapshot.diagnosis?.ok !== true ||
      !sameJson(snapshot.assignmentRepository, repository) || !sameRepositoryFingerprint(repository, snapshot.lifecycleRepository) ||
      !sameProcessPackageIdentity(snapshot.status?.package, processPackage) ||
      !sameProcessPackageIdentity(snapshot.assignment?.package, processPackage) ||
      !sameProcessPackageIdentity(snapshot.diagnosis?.package, processPackage)) {
    throw new Error(`${label} snapshot does not prove one clean selected active Assignment boundary`);
  }
}

function requireCurrentOrphanBoundary(snapshot, context, assignmentId, captured, processPackage, label) {
  requireOrphanSnapshotIdentity(snapshot, context, assignmentId, captured.assignmentRepository, processPackage, label);
  if (!sameJson(snapshot.lifecycleRepository, captured.lifecycleRepository) ||
      !sameJson(snapshot.assignmentRepository, captured.assignmentRepository) ||
      snapshot.lifecycleRepository.head !== captured.lifecycleRepository.head ||
      snapshot.lifecycleRepository.tree !== captured.lifecycleRepository.tree ||
      snapshot.lifecycleRepository.trackedState !== captured.lifecycleRepository.trackedState) {
    throw new Error(`${label} snapshot differs from the exact current clean B boundary`);
  }
}

async function requirePinnedEvidence(pin, label) {
  const evidence = await immutableFileEvidence(pin.path);
  if (evidence.digest !== pin.digest) throw new Error(`${label} digest differs from the operator pin`);
  return evidence;
}

async function authenticateLifecycleTransactionAncestry(repository, oldHead, newHead) {
  const runGit = async args => {
    const result = await runProcess('git', args, { cwd: repository, timeoutMs: 900_000, env: gitEnvironment() });
    if (!commandSucceeded(result)) throw new Error(`Git ancestry evidence failed for ${args.join(' ')}`);
    return result.stdout;
  };
  await runGit(['merge-base', '--is-ancestor', oldHead, newHead]);
  const commits = (await runGit(['rev-list', '--reverse', `${oldHead}..${newHead}`])).toString('utf8').trim().split('\n').filter(Boolean);
  if (commits.length === 0) throw new Error('orphaned checkpoint did not advance through any lifecycle transaction commits');
  let parent = oldHead;
  for (const commit of commits) {
    const identity = (await runGit(['rev-list', '--parents', '-n', '1', commit])).toString('utf8').trim().split(' ');
    if (!sameJson(identity, [commit, parent])) throw new Error('lifecycle transaction ancestry contains a merge or unexplained parent');
    const subject = (await runGit(['show', '-s', '--format=%s', commit])).toString('utf8').trim();
    const match = /^mdlm: publish (.+@[1-9][0-9]*) \(([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\)$/.exec(subject);
    if (!match) throw new Error('intermediate commit is not an exact MDLM lifecycle transaction publication');
    const [, scenario, executionId] = match;
    const transactionRoot = `.lifecycle/data/.transactions/${executionId}`;
    const paths = (await runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', commit])).toString('utf8').trim().split('\n').filter(Boolean).sort();
    const executionPath = `${transactionRoot}/execution.json`;
    if (!paths.includes(executionPath) || paths.some(file => !file.startsWith(`${transactionRoot}/`))) {
      throw new Error('intermediate commit contains missing or unrelated lifecycle transaction paths');
    }
    let execution;
    try { execution = JSON.parse((await runGit(['show', `${commit}:${executionPath}`])).toString('utf8')); }
    catch { throw new Error('intermediate lifecycle transaction execution is not valid JSON'); }
    const outputPaths = execution?.outputs?.map(output => output?.lifecycleDatum?.path).sort();
    if (execution?.contract !== 'mdlm-scenario-execution@4' || execution.id !== executionId ||
        execution.status !== 'completed' || execution.definition?.scenario !== scenario ||
        execution.response?.contract !== 'mdlm-assignment-response@1' || typeof execution.response.assignment !== 'string' ||
        !Array.isArray(outputPaths) || outputPaths.length === 0 ||
        !sameJson(paths, [executionPath, ...outputPaths].sort())) {
      throw new Error('intermediate commit does not correspond to one completed lifecycle transaction');
    }
    parent = commit;
  }
  if (parent !== newHead) throw new Error('lifecycle transaction ancestry did not end at the pinned B boundary');
}

async function authenticatePriorAssignmentCheckpoint({ request, context, sourceDirectory, captured, processPackage, priorRepository }) {
  const toAssignment = request.assignmentId;
  await requireCanonicalDirectory(sourceDirectory);
  const identityEvidence = await readCanonicalEvidenceFile(path.join(sourceDirectory, 'identity.json'));
  const identity = JSON.parse(identityEvidence.bytes.toString('utf8'));
  if (identity.contract !== 'mdlm-demo-assignment-identity@1' || typeof identity.assignmentId !== 'string' ||
      !sameJson(Object.keys(identity).sort(), ['assignmentId', 'assignmentRepository', 'contract', 'lifecycleRepository'])) {
    throw new Error('source Assignment identity is malformed');
  }
  const fromAssignment = identity.assignmentId;
  if (fromAssignment === toAssignment) throw new Error('checkpoint source and target are the same Assignment');
  if (request.checkpointRecovery === undefined) {
    throw new Error('checkpointRecovery with an operator-pinned prior post-run snapshot is required');
  }
  const pinnedSnapshot = await verifySnapshot(
    request.checkpointRecovery.snapshotDirectory,
    request.checkpointRecovery.digest,
  );
  if (path.basename(sourceDirectory) !== assignmentKey(fromAssignment)) throw new Error('source Assignment directory does not match its identity');
  if (!sameJson(identity.lifecycleRepository, priorRepository) || !sameRepositoryFingerprint(identity.assignmentRepository, priorRepository)) {
    throw new Error('source Assignment identity does not equal the prior durable repository boundary');
  }
  if (priorRepository.clean !== true || captured.lifecycleRepository?.clean !== true) {
    throw new Error('checkpoint boundaries must both be clean');
  }
  if (sameJson(priorRepository, captured.lifecycleRepository)) throw new Error('checkpoint does not advance the repository boundary');

  const shimDirectory = path.join(sourceDirectory, 'shim');
  const stopsDirectory = path.join(shimDirectory, 'stops');
  const commandDirectory = path.join(sourceDirectory, 'command-evidence');
  await requireCanonicalDirectory(shimDirectory);
  await requireCanonicalDirectory(stopsDirectory);
  await requireCanonicalDirectory(commandDirectory);
  const commandNames = (await readdir(commandDirectory)).sort();
  const expectedCommandNames = [
    'command-000001.json', 'command-000001.stderr', 'command-000001.stdout',
    'command-000002.json', 'command-000002.stderr', 'command-000002.stdout',
  ];
  if (!sameJson(commandNames, expectedCommandNames)) throw new Error('command evidence is missing, ambiguous, or has a later command');
  const stopNames = (await readdir(stopsDirectory)).sort();
  if (!sameJson(stopNames, [`${toAssignment}.json`])) throw new Error('private stop evidence is missing or ambiguous');

  const configEvidence = await readCanonicalEvidenceFile(path.join(shimDirectory, 'config.json'));
  const config = JSON.parse(configEvidence.bytes.toString('utf8'));
  if (config.contract !== 'mdlm-demo-shim-config@1' ||
      !sameJson(Object.keys(config).sort(), ['allowedAssignment', 'contract', 'package', 'realMdlm', 'repository', 'stopDirectory', 'timeoutMs']) ||
      config.allowedAssignment !== fromAssignment || !sameConfiguredPath(config.realMdlm, request.commands.mdlm) ||
      !sameProcessPackageIdentity(config.package, processPackage) || !sameJson(config.repository, identity.assignmentRepository) ||
      path.resolve(config.stopDirectory) !== stopsDirectory || config.timeoutMs !== (request.timeoutMs ?? 30_000)) {
    throw new Error('source shim configuration differs from the current provenance, package, repository, or Assignment');
  }

  const first = await authenticateStoredCommand(commandDirectory, '000001');
  const expectedPrepare = [request.commands.mdlm, 'scenario', 'prepare', fromAssignment, '--json'];
  requireStoredProcess(first.record, expectedPrepare, context.repository, request.timeoutMs ?? 30_000, 0);
  if (first.stderr.length !== 0) throw new Error('source Scenario prepare command has stderr bytes');
  const preparedSource = validateScenarioPrepare(JSON.parse(first.stdout.toString('utf8')), {
    assignmentId: fromAssignment, package: processPackage, repository: identity.assignmentRepository,
  });

  const second = await authenticateStoredCommand(commandDirectory, '000002');
  const expectedPi = [
    request.commands.mdlmPi, 'run', context.repository, '--mdlm', mdlmShim,
    '--provider', request.operator.provider, '--model', request.operator.model,
    '--thinking', request.operator.thinking,
  ];
  requireStoredProcess(second.record, expectedPi, context.repository, request.timeoutMs ?? 30_000, 1);
  const failure = JSON.parse(second.stderr.toString('utf8'));
  if (!sameJson(Object.keys(failure).sort(), ['details', 'error', 'status']) || failure.status !== 'operational-failure' ||
      failure.error !== 'MDLM could not prepare the Assignment') {
    throw new Error('mdlm-pi stderr is not the exact typed prepare failure');
  }
  const stop = failure.details;
  if (!stop || !sameJson(Object.keys(stop).sort(), ['assignment', 'contract', 'packetPath', 'phase', 'scenario', 'type']) ||
      stop.contract !== 'mdlm-demo-reserved-stop@1' || stop.type !== 'assignment-checkpoint' || stop.phase !== 'before-worker' ||
      stop.assignment !== toAssignment || typeof stop.scenario !== 'string') {
    throw new Error('mdlm-pi stderr is not an exact A-to-B Assignment checkpoint stop');
  }
  const packetFile = path.join(stopsDirectory, `${toAssignment}.json`);
  if (path.resolve(stop.packetPath) !== packetFile) throw new Error('checkpoint packet path is not canonical inside the source Assignment stop directory');
  const packetEvidence = await readCanonicalEvidenceFile(packetFile);
  const packet = validateScenarioPrepare(JSON.parse(packetEvidence.bytes.toString('utf8')), {
    assignmentId: toAssignment, package: processPackage, repository: captured.lifecycleRepository && {
      head: captured.lifecycleRepository.head, trackedState: captured.lifecycleRepository.trackedState,
    },
  });
  if (packet.scenario.reference !== stop.scenario) throw new Error('checkpoint Scenario differs from the retained packet');
  if (captured.diagnosis?.ok !== true || !statusHasActiveAssignment(captured.status, toAssignment) ||
      captured.assignment?.id !== toAssignment || captured.assignment.selected !== true || captured.assignment.disposition !== 'active') {
    throw new Error('current status, doctor, and Assignment do not select active Assignment B');
  }
  if (captured.assignment.scenarioReference !== packet.scenario.reference ||
      !sameProcessPackageIdentity(packet.package, captured.status?.package) ||
      !sameProcessPackageIdentity(packet.package, captured.assignment.package) ||
      !sameProcessPackageIdentity(packet.package, captured.diagnosis?.package)) {
    throw new Error('current Scenario or Process Package differs from the retained packet');
  }
  if (!sameJson(captured.assignment.repository, packet.repository) ||
      !sameRepositoryFingerprint(packet.repository, captured.lifecycleRepository)) {
    throw new Error('current Assignment or repository boundary differs from the retained packet');
  }
  authenticatePinnedCheckpointSnapshot({
    pinned: pinnedSnapshot.snapshot,
    context,
    fromAssignment,
    toAssignment,
    packet,
    captured,
    processPackage,
  });

  const evidence = {
    identity: evidenceManifest(identityEvidence),
    config: evidenceManifest(configEvidence),
    commands: [
      ...first.evidence.map(evidenceManifest),
      ...second.evidence.map(evidenceManifest),
    ],
    packet: evidenceManifest(packetEvidence),
  };
  return {
    fromAssignment,
    record: {
      contract: 'mdlm-demo-checkpoint-reconciliation@1',
      phase: 'authenticated',
      fromAssignment,
      toAssignment,
      sourceAssignmentDirectory: sourceDirectory,
      priorRepository,
      completedRepository: captured.lifecycleRepository,
      scenario: packet.scenario.reference,
      sourceScenario: preparedSource.scenario.reference,
      package: processPackage,
      checkpointRecovery: {
        snapshotDirectory: pinnedSnapshot.snapshotDirectory,
        digest: pinnedSnapshot.digest,
        manifest: pinnedSnapshot.manifest,
      },
      evidence,
    },
  };
}

function authenticatePinnedCheckpointSnapshot({ pinned, context, fromAssignment, toAssignment, packet, captured, processPackage }) {
  if (pinned.repository !== context.repository) {
    throw new Error('pinned post-run snapshot names a different lifecycle repository');
  }
  if (!sameJson(pinned.lifecycleRepository, captured.lifecycleRepository) || pinned.lifecycleRepository?.clean !== true) {
    throw new Error('current lifecycle boundary differs from the pinned post-run snapshot');
  }
  if (!sameRepositoryFingerprint(packet.repository, pinned.lifecycleRepository)) {
    throw new Error('retained packet repository differs from the pinned post-run snapshot');
  }
  if (pinned.status?.contract !== 'mdlm-status@1' || pinned.status.command !== 'status' || pinned.status.ok !== true ||
      !statusHasActiveAssignment(pinned.status, toAssignment)) {
    throw new Error('pinned post-run status does not select active Assignment B');
  }
  if (pinned.diagnosis?.command !== 'doctor' || pinned.diagnosis.ok !== true ||
      !sameProcessPackageIdentity(processPackage, pinned.status.package) ||
      !sameProcessPackageIdentity(processPackage, pinned.diagnosis.package)) {
    throw new Error('pinned post-run status or doctor Process Package differs');
  }
  const historicalAssignment = pinned.assignment;
  const exactSourceAssignment = historicalAssignment?.id === fromAssignment && historicalAssignment.selected === false &&
    sameJson(Object.keys(historicalAssignment).sort(), ['id', 'selected']) && pinned.assignmentRepository === null;
  if (!exactSourceAssignment) {
    throw new Error('pinned post-run Assignment record does not identify deselected Assignment A');
  }
  if (captured.assignment?.id !== toAssignment || captured.assignment.selected !== true ||
      captured.assignment.disposition !== 'active' || captured.assignment.scenarioReference !== packet.scenario.reference ||
      !sameProcessPackageIdentity(processPackage, captured.assignment.package) ||
      !sameJson(captured.assignment.repository, packet.repository) ||
      !sameJson(captured.assignmentRepository, packet.repository)) {
    throw new Error('current Assignment B differs from the pinned post-run boundary');
  }
}

async function authenticateStoredCommand(directory, index) {
  const files = await Promise.all(['json', 'stdout', 'stderr'].map(extension =>
    readCanonicalEvidenceFile(path.join(directory, `command-${index}.${extension}`))));
  const [recordEvidence, stdoutEvidence, stderrEvidence] = files;
  const record = JSON.parse(recordEvidence.bytes.toString('utf8'));
  const expectedKeys = [
    'argv', 'completedAt', 'cwd', 'exitStatus', 'observedOutputBytes', 'outputLimitExceeded', 'signal',
    'spawnError', 'startedAt', 'stderrBase64', 'stderrSha256', 'stdoutBase64', 'stdoutSha256', 'timedOut', 'timeoutMs',
  ].sort();
  if (!sameJson(Object.keys(record).sort(), expectedKeys)) throw new Error(`command-${index} record has an unsupported shape`);
  const stdout = stdoutEvidence.bytes;
  const stderr = stderrEvidence.bytes;
  if (record.stdoutSha256 !== sha256(stdout) || record.stderrSha256 !== sha256(stderr) ||
      record.stdoutBase64 !== stdout.toString('base64') || record.stderrBase64 !== stderr.toString('base64') ||
      record.observedOutputBytes !== stdout.length + stderr.length) {
    throw new Error(`command-${index} raw bytes differ from the authenticated command record`);
  }
  return { record, stdout, stderr, evidence: files };
}

function requireStoredProcess(record, argv, cwd, timeoutMs, exitStatus) {
  if (!sameJson(record.argv, argv) || path.resolve(record.cwd) !== path.resolve(cwd) || record.timeoutMs !== timeoutMs ||
      record.timedOut !== false || record.outputLimitExceeded !== false || record.exitStatus !== exitStatus ||
      record.signal !== null || record.spawnError !== null || typeof record.startedAt !== 'string' || typeof record.completedAt !== 'string' ||
      !Number.isFinite(Date.parse(record.startedAt)) || !Number.isFinite(Date.parse(record.completedAt)) ||
      Date.parse(record.completedAt) < Date.parse(record.startedAt)) {
    throw new Error('stored command executable, argv, repository, timeout, or process termination fields differ');
  }
}

async function readCanonicalEvidenceFile(file) {
  return readCanonicalFile(file, 'checkpoint evidence');
}

async function requireCanonicalDirectory(directory) {
  const information = await lstat(directory);
  if (!information.isDirectory() || information.isSymbolicLink() || await realpath(directory) !== path.resolve(directory)) {
    throw new Error(`checkpoint evidence directory is not canonical: ${directory}`);
  }
}

function evidenceManifest(evidence) {
  return { path: evidence.path, bytes: evidence.bytes.length, digest: sha256(evidence.bytes) };
}

function reconciliationEvidence(value) {
  return {
    contract: value.contract,
    fromAssignment: value.fromAssignment,
    toAssignment: value.toAssignment,
    sourceAssignmentDirectory: value.sourceAssignmentDirectory,
    priorRepository: value.priorRepository,
    completedRepository: value.completedRepository,
    scenario: value.scenario,
    sourceScenario: value.sourceScenario,
    package: value.package,
    ...(value.checkpointRecovery === undefined ? {} : { checkpointRecovery: value.checkpointRecovery }),
    ...(value.orphanedCheckpointRecovery === undefined ? {} : { orphanedCheckpointRecovery: value.orphanedCheckpointRecovery }),
    evidence: value.evidence,
  };
}

async function validateExistingCheckpointTransaction(sourceDirectory, journal, journalPath) {
  const existing = await optionalCanonicalJson(path.join(sourceDirectory, 'transaction.json'));
  if (existing !== null && !sameJson(existing, completedCheckpointTransaction(journal, journalPath))) {
    throw new Error('source Assignment transaction differs from the checkpoint reconciliation');
  }
}

function completedCheckpointTransaction(journal, journalPath) {
  return {
    contract: 'mdlm-demo-transaction-journal@2',
    phase: 'completed',
    assignmentId: journal.fromAssignment,
    scenario: journal.sourceScenario,
    outcome: 'accepted-publication',
    completedRepository: journal.completedRepository,
    trustedRepositoryAdvance: true,
    checkpointReconciliation: journalPath,
    ...(journal.checkpointRecovery === undefined ? {} : { checkpointRecovery: journal.checkpointRecovery }),
    ...(journal.orphanedCheckpointRecovery === undefined ? {} : { orphanedCheckpointRecovery: journal.orphanedCheckpointRecovery }),
  };
}

async function completeCheckpointReconciliation({ journalPath, journal, globalPath, global, sourceDirectory }) {
  const advancedIdentity = {
    contract: 'mdlm-demo-repository-identity@1',
    lifecycleRepository: journal.completedRepository,
    lastAssignment: { id: journal.fromAssignment, outcome: 'accepted-publication', completed: true },
  };
  if (journal.phase === 'completed') {
    const completedTarget = sameJson(global.lifecycleRepository, journal.completedRepository) &&
      global.lastAssignment?.id === journal.toAssignment && global.lastAssignment.completed === true;
    if (!sameJson(global, advancedIdentity) && !completedTarget) {
      throw new Error('completed checkpoint reconciliation global boundary differs');
    }
  } else if (journal.phase === 'authenticated') {
    if (sameJson(global.lifecycleRepository, journal.priorRepository)) {
      await durableWriteJson(globalPath, advancedIdentity, 'checkpoint-reconciliation-global');
    } else if (!sameJson(global, advancedIdentity)) {
      throw new Error('global repository identity advanced to an unrelated boundary');
    }
  } else if (!sameJson(global, advancedIdentity)) {
    throw new Error('global repository identity does not match the journaled checkpoint advance');
  }
  if (journal.phase === 'authenticated') {
    journal = { ...journal, phase: 'boundary-advanced' };
    await writeJournal(journalPath, journal);
  }

  const transactionPath = path.join(sourceDirectory, 'transaction.json');
  const completedSource = completedCheckpointTransaction(journal, journalPath);
  const existingTransaction = await optionalCanonicalJson(transactionPath);
  if (existingTransaction === null) await durableWriteJson(transactionPath, completedSource, 'checkpoint-reconciliation-assignment');
  else if (!sameJson(existingTransaction, completedSource)) throw new Error('source Assignment transaction differs from the checkpoint reconciliation');
  if (journal.phase !== 'completed') {
    journal = { ...journal, phase: 'completed' };
    await writeJournal(journalPath, journal);
  }
  return journal;
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
function statusHasActiveAssignment(status, assignmentId) {
  const outcome = status?.currentOutcome;
  return (outcome?.outcome === 'assignment' || outcome?.outcome === 'attention-required') &&
    outcome.assignment?.allocation === 'active' && outcome.assignment.id === assignmentId;
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
  const journal = await optionalCanonicalJson(journalPath);
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
  if (output.contract !== 'mdlm-scenario-execution@4' || output.command !== 'scenario.submit' || output.ok !== true) throw new Error('submission did not return an accepted Scenario execution');
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
  maybeInjectedCrash('publication', 'after-git-commit');
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
  output.commandEvidence = { index: count, prefix };
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
  const staging = path.join(context.identityDirectory, `.writer.lock.${token}.pending`);
  const owner = {
    contract: 'mdlm-demo-writer-lock@1', token, pid: process.pid,
    processStart: await linuxProcessStart(process.pid), assignmentId,
    repository: context.repository, acquiredAt: new Date().toISOString(),
  };
  await durableWriteJson(staging, owner);
  await waitAtLockAcquisitionBarrier(token);
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await link(staging, lock);
        await syncDirectory(context.identityDirectory);
        acquired = true;
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const observed = await readRepositoryLock(lock);
        if (!validLockOwner(observed)) throw new Error(`lifecycle repository writer lock is initializing: ${lock}`);
        if (await processOwnerIsAlive(observed)) throw new Error(`lifecycle repository writer lock is held: ${lock}`);
        await reclaimStaleRepositoryLock(lock, staging, context.identityDirectory);
      }
    }
    if (!acquired) throw new Error(`lifecycle repository writer lock cannot be recovered: ${lock}`);
  } finally {
    await rm(staging, { force: true });
  }
  return async () => {
    const observed = await readRepositoryLock(lock).catch(() => null);
    if (observed?.token === token) {
      await rm(lock, { force: true, recursive: true });
      await syncDirectory(context.identityDirectory);
    }
  };
}
async function readRepositoryLock(lock) {
  const information = await lstat(lock);
  const ownerPath = information.isDirectory() ? path.join(lock, 'owner.json') : lock;
  try { return JSON.parse(await readFile(ownerPath, 'utf8')); }
  catch { return null; }
}
async function reclaimStaleRepositoryLock(lock, staging, identityDirectory) {
  const information = await lstat(lock);
  if (information.isDirectory()) {
    const claim = path.join(lock, '.reclaim');
    try { await link(staging, claim); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error(`lifecycle repository writer lock reclamation is initializing: ${lock}`);
      throw error;
    }
    const owner = await readRepositoryLock(lock);
    if (!validLockOwner(owner) || await processOwnerIsAlive(owner)) throw new Error(`lifecycle repository writer lock cannot be safely reclaimed: ${lock}`);
    const stale = path.join(identityDirectory, `writer.lock.stale-${randomUUID()}`);
    await rename(lock, stale);
    await syncDirectory(identityDirectory);
    await rm(stale, { recursive: true });
    return;
  }
  if (!information.isFile()) throw new Error(`lifecycle repository writer lock has an unsupported type: ${lock}`);
  const claim = path.join(identityDirectory, 'writer.lock.reclaim');
  try { await link(lock, claim); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const [current, claimed] = await Promise.all([optionalLstat(lock), lstat(claim)]);
    if (current === null || current.dev !== claimed.dev || current.ino !== claimed.ino) {
      await rm(claim, { force: true });
      return;
    }
    throw new Error(`lifecycle repository writer lock reclamation is initializing: ${lock}`);
  }
  const owner = await readRepositoryLock(claim);
  if (!validLockOwner(owner) || await processOwnerIsAlive(owner)) throw new Error(`lifecycle repository writer lock cannot be safely reclaimed: ${lock}`);
  await rm(lock);
  await syncDirectory(identityDirectory);
  await rm(claim);
  await syncDirectory(identityDirectory);
}
function validLockOwner(owner) {
  return owner !== null && typeof owner === 'object' && !Array.isArray(owner) &&
    (owner.contract === undefined || owner.contract === 'mdlm-demo-writer-lock@1') && typeof owner.token === 'string' && owner.token.length > 0 &&
    Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.assignmentId === 'string' && owner.assignmentId.length > 0 &&
    typeof owner.repository === 'string' && owner.repository.length > 0 && typeof owner.acquiredAt === 'string' &&
    (process.platform !== 'linux' || typeof owner.processStart === 'string');
}
async function waitAtLockAcquisitionBarrier(token) {
  const barrier = process.env.MDLM_DEMO_TEST_LOCK_BARRIER;
  if (typeof barrier !== 'string' || barrier.length === 0) return;
  await writeFile(path.join(barrier, `ready-${process.pid}-${token}`), 'ready\n', { flag: 'wx', mode: 0o600 });
  for (;;) {
    try { await lstat(path.join(barrier, 'release')); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function optionalLstat(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
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
async function optionalCanonicalJson(file) {
  try { return JSON.parse((await readCanonicalEvidenceFile(file)).bytes.toString('utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function result(status, snapshotResult, extra) { return { contract: 'mdlm-demo-run-result@2', status, snapshot: snapshotResult, ...extra }; }
function stopped(reason, detail, snapshotResult, assignmentId, extra = {}) { return result('stopped', snapshotResult, { assignmentId, recoverable: false, reason, detail, ...extra }); }
function required(value, label) { if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`); return value; }
function validateRunRequest(value) {
  const allowed = new Set([
    'adapterInputsPath', 'assignmentId', 'checkpointRecovery', 'commands', 'contract', 'decisionCatalogPath',
    'evidenceDirectory', 'harness', 'materializedNextRecovery', 'mdlmPiAssignmentTimeoutMs', 'mdlmPiCommandTimeoutMs',
    'operationalFailureRecovery', 'operator', 'orphanedCheckpointRecovery', 'provenance', 'repository', 'signal',
    'stateDirectory', 'timeoutMs',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`run request.${key} is unsupported`);
  }
  requirePositiveSafeInteger(value.timeoutMs, 'timeoutMs');
  if (value.timeoutMs > 900_000) throw new Error('timeoutMs must not exceed 900000');
  for (const name of ['mdlmPiCommandTimeoutMs', 'mdlmPiAssignmentTimeoutMs']) {
    requirePositiveSafeInteger(value[name], name);
    if (value[name] > value.timeoutMs - outerTimeoutSafetyReserveMs) {
      throw new Error(`${name} must leave at least ${outerTimeoutSafetyReserveMs}ms safety reserve below timeoutMs`);
    }
  }
  if (value.checkpointRecovery !== undefined) {
    const recovery = value.checkpointRecovery;
    if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery) ||
        !sameJson(Object.keys(recovery).sort(), ['digest', 'snapshotDirectory'])) {
      throw new Error('checkpointRecovery must contain exactly snapshotDirectory and digest');
    }
    required(recovery.snapshotDirectory, 'checkpointRecovery.snapshotDirectory');
    if (!path.isAbsolute(recovery.snapshotDirectory)) throw new Error('checkpointRecovery.snapshotDirectory must be an absolute path');
    if (!/^sha256:[0-9a-f]{64}$/.test(recovery.digest ?? '')) {
      throw new Error('checkpointRecovery.digest must be sha256:<64 lowercase hex>');
    }
  }
  if (value.materializedNextRecovery !== undefined) {
    validateMaterializedNextRecovery(value.materializedNextRecovery);
  }
  if (value.orphanedCheckpointRecovery !== undefined) {
    validateOrphanedCheckpointRecovery(value.orphanedCheckpointRecovery);
  }
  if (value.operationalFailureRecovery !== undefined) {
    const recovery = value.operationalFailureRecovery;
    const keys = [
      'initialSnapshotDigest', 'initialSnapshotDirectory', 'postSnapshotDigest',
      'postSnapshotDirectory', 'resultDigest', 'resultPath',
    ];
    if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery) ||
        !sameJson(Object.keys(recovery).sort(), keys)) {
      throw new Error(`operationalFailureRecovery must contain exactly ${keys.join(', ')}`);
    }
    for (const name of ['resultPath', 'initialSnapshotDirectory', 'postSnapshotDirectory']) {
      required(recovery[name], `operationalFailureRecovery.${name}`);
      if (!path.isAbsolute(recovery[name])) throw new Error(`operationalFailureRecovery.${name} must be an absolute path`);
    }
    for (const name of ['resultDigest', 'initialSnapshotDigest', 'postSnapshotDigest']) {
      if (!/^sha256:[0-9a-f]{64}$/.test(recovery[name] ?? '')) {
        throw new Error(`operationalFailureRecovery.${name} must be sha256:<64 lowercase hex>`);
      }
    }
  }
}
function validateMaterializedNextRecovery(recovery) {
  const keys = ['acceptedResult', 'finalSnapshot', 'nextExit', 'nextStderr', 'nextStdout', 'oldSnapshot'];
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery) ||
      !sameJson(Object.keys(recovery).sort(), keys)) {
    throw new Error(`materializedNextRecovery must contain exactly ${keys.join(', ')}`);
  }
  for (const name of ['acceptedResult', 'nextStdout', 'nextStderr', 'nextExit']) {
    validatePinnedFile(recovery[name], `materializedNextRecovery.${name}`);
  }
  for (const name of ['oldSnapshot', 'finalSnapshot']) {
    const pin = recovery[name];
    if (!pin || typeof pin !== 'object' || Array.isArray(pin) ||
        !sameJson(Object.keys(pin).sort(), ['digest', 'directory'])) {
      throw new Error(`materializedNextRecovery.${name} must contain exactly directory and digest`);
    }
    required(pin.directory, `materializedNextRecovery.${name}.directory`);
    if (!path.isAbsolute(pin.directory)) throw new Error(`materializedNextRecovery.${name}.directory must be an absolute path`);
    requireSha256(pin.digest, `materializedNextRecovery.${name}.digest`);
  }
}

function validateOrphanedCheckpointRecovery(recovery) {
  const keys = [
    'assignmentCheckpoint', 'initialSnapshotDigest', 'initialSnapshotDirectory', 'postSnapshotDigest',
    'postSnapshotDirectory', 'prepare', 'processedAssignment', 'retryTransition', 'shimConfig', 'stopPacket',
  ].sort();
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery) ||
      !sameJson(Object.keys(recovery).sort(), keys)) {
    throw new Error(`orphanedCheckpointRecovery must contain exactly ${keys.join(', ')}`);
  }
  for (const name of ['initialSnapshotDirectory', 'postSnapshotDirectory']) {
    required(recovery[name], `orphanedCheckpointRecovery.${name}`);
    if (!path.isAbsolute(recovery[name])) throw new Error(`orphanedCheckpointRecovery.${name} must be an absolute path`);
  }
  for (const name of ['initialSnapshotDigest', 'postSnapshotDigest']) {
    requireSha256(recovery[name], `orphanedCheckpointRecovery.${name}`);
  }
  const pinnedFileNames = ['retryTransition', 'shimConfig', 'processedAssignment', 'assignmentCheckpoint', 'stopPacket'];
  for (const name of pinnedFileNames) validatePinnedFile(recovery[name], `orphanedCheckpointRecovery.${name}`);
  if (!recovery.prepare || typeof recovery.prepare !== 'object' || Array.isArray(recovery.prepare) ||
      !sameJson(Object.keys(recovery.prepare).sort(), ['record', 'stderr', 'stdout'])) {
    throw new Error('orphanedCheckpointRecovery.prepare must contain exactly record, stderr, stdout');
  }
  for (const name of ['record', 'stdout', 'stderr']) {
    validatePinnedFile(recovery.prepare[name], `orphanedCheckpointRecovery.prepare.${name}`);
  }
}
function validatePinnedFile(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !sameJson(Object.keys(value).sort(), ['digest', 'path'])) {
    throw new Error(`${label} must contain exactly path and digest`);
  }
  required(value.path, `${label}.path`);
  if (!path.isAbsolute(value.path)) throw new Error(`${label}.path must be an absolute path`);
  requireSha256(value.digest, `${label}.digest`);
}
function requireSha256(value, label) {
  if (!/^sha256:[0-9a-f]{64}$/.test(value ?? '')) throw new Error(`${label} must be sha256:<64 lowercase hex>`);
}
function requirePositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
}
function validateOperator(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('operator must be an object');
  if (!sameJson(Object.keys(value).sort(), ['model', 'provider', 'thinking'])) throw new Error('operator must contain exactly provider, model, and thinking');
  for (const name of ['provider', 'model']) {
    if (typeof value[name] !== 'string' || !operatorScalarPattern.test(value[name])) throw new Error(`operator.${name} must be a safe nonempty scalar string`);
  }
  if (typeof value.thinking !== 'string' || !thinkingLevels.has(value.thinking)) {
    throw new Error(`operator.thinking must be one of ${[...thinkingLevels].join(', ')}`);
  }
}
function assignmentKey(value) { return `${value.replace(/[^A-Za-z0-9._-]/g, '_')}-${sha256(Buffer.from(value)).slice(-12)}`; }
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function sameConfiguredPath(left, right) { return typeof left === 'string' && typeof right === 'string' && path.resolve(left) === path.resolve(right); }
