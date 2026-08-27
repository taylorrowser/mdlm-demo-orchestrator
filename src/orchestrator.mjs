import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptAssignment } from './adapter.mjs';
import { readCanonicalFile } from './canonical-file.mjs';
import { validateScenarioPrepare } from './contracts.mjs';
import { bindDecisionCatalogFile } from './decision-catalog.mjs';
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
const publicationClosureEvidence = Symbol('publicationClosureEvidence');
const operationalFailureEvidence = Symbol('operationalFailureEvidence');
const exhaustedBoundaryEvidence = Symbol('exhaustedBoundaryEvidence');
const durableResultRepository = Symbol('durableResultRepository');
const authenticatedCompletedDurableCommand = Symbol('authenticatedCompletedDurableCommand');
const boundDecisionCatalog = Symbol('boundDecisionCatalog');
const authoritativeDecisionUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const outerTimeoutSafetyReserveMs = 60_000;

export async function run(request, mode) {
  requireContract(request, mode === 'resume' ? 'mdlm-demo-resume-request@1' : 'mdlm-demo-run-request@1');
  validateRunRequest(request);
  validateOperator(request.operator);
  const assignmentId = required(request.assignmentId, 'assignmentId');
  request = { ...request, [boundDecisionCatalog]: await bindDecisionCatalogFile(request.decisionCatalogPath) };
  await waitAtDecisionCatalogPreflightBarrier(request[boundDecisionCatalog]);
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
    const postAssignmentId = output[publicationClosureEvidence]?.assignmentId ??
      output[assignmentCheckpointEvidence]?.packet.assignment.id ?? assignmentId;
    const postRunSnapshot = await snapshotRequest(request, context.repository, postDirectory, postAssignmentId, journalPath, piJournalPath, true);
    if (output[durableResultRepository] !== undefined && postRunSnapshot.status === 'complete') {
      const postRunRecord = JSON.parse(await readFile(path.join(postRunSnapshot.snapshotDirectory, 'snapshot.json'), 'utf8'));
      if (!sameJson(output[durableResultRepository], postRunRecord.lifecycleRepository)) {
        output = stopped(
          'durable-command-uncertain',
          'repository changed after the durable child result was captured',
          initial,
          assignmentId,
        );
      }
    }
    output = await finalizeExhaustedBoundary(output, postRunSnapshot);
    output = await finalizeAssignmentCheckpoint(output, postRunSnapshot, assignmentId);
    output = await finalizePublicationClosure(output, postRunSnapshot);
    output = await finalizeOperationalFailure(output, output.snapshot, postRunSnapshot, context, assignmentDirectory, request);
    output.postRunSnapshot = postRunSnapshot;
    await finishTrustedRun(context, assignmentDirectory, journalPath, assignmentId, output, postRunSnapshot);
    await recordDurableCommandConsumption(assignmentDirectory, output, postRunSnapshot);
    return output;
  } finally {
    await release();
  }
}

export async function reconcile(request) {
  requireContract(request, 'mdlm-demo-reconcile-request@1');
  validateReconcileRequest(request);
  await requireCanonicalDirectory(path.resolve(request.repository));
  const context = await repositoryContext(request.repository, request.timeoutMs);
  await requireCanonicalDirectory(context.repository);
  const release = await acquireRepositoryLock(context, 'checkpoint-reconciliation');
  try {
    const authenticated = await authenticateStandaloneCheckpointReconciliation(request, context);
    const { journalPath, journalDirectory, journalDirectoryIdentity, existingJournal } = authenticated;
    const priorPhase = existingJournal?.phase ?? null;
    if (existingJournal === null) {
      await writeTrustedReconciliationJournal(journalPath, authenticated.record, journalDirectoryIdentity);
    }
    const globalPath = path.join(context.identityDirectory, 'repository-identity.json');
    const global = await optionalCanonicalJson(globalPath);
    if (global === null) throw new Error('trusted repository identity is absent');
    await completeCheckpointReconciliation({
      journalPath,
      journal: { ...authenticated.record, phase: priorPhase ?? 'authenticated' },
      globalPath,
      global,
      sourceDirectory: authenticated.sourceDirectory,
      trustedJournalDirectory: journalDirectory,
      trustedJournalDirectoryIdentity: journalDirectoryIdentity,
    });
    return {
      contract: 'mdlm-demo-reconcile-result@1',
      status: priorPhase === 'completed' ? 'already-reconciled' : 'reconciled',
      fromAssignment: authenticated.fromAssignment,
      toAssignment: authenticated.toAssignment,
      priorRepository: authenticated.record.priorRepository,
      completedRepository: authenticated.record.completedRepository,
    };
  } finally {
    await release();
  }
}

async function authenticateStandaloneCheckpointReconciliation(request, context) {
  const evidence = request.evidence;
  const requestEvidence = await requirePinnedEvidence(evidence.request, 'original run request');
  let originalRequest;
  try { originalRequest = JSON.parse(requestEvidence.bytes.toString('utf8')); }
  catch { throw new Error('original run request is not valid JSON'); }
  requireContract(originalRequest, 'mdlm-demo-run-request@1');
  validateRunRequest(originalRequest);
  validateOperator(originalRequest.operator);
  if (originalRequest.timeoutMs !== request.timeoutMs) throw new Error('reconciliation timeout differs from the original run request');
  const targetBinding = reconcileTargetBinding(request, originalRequest);
  const recoveryShape = standaloneCheckpointRecoveryShape(originalRequest, targetBinding.relocated);
  if (targetBinding.relocated && path.resolve(evidence.request.path) !== targetBinding.translate(recoveryShape.requestPath)) {
    throw new Error('original request pin does not match the authenticated relocation');
  }
  const fromAssignment = originalRequest.assignmentId;
  const sourceDirectory = path.join(path.resolve(request.stateDirectory), 'assignments', assignmentKey(fromAssignment));
  await requireCanonicalDirectory(path.resolve(request.stateDirectory));
  await requireCanonicalDirectory(path.join(path.resolve(request.stateDirectory), 'assignments'));
  await requireCanonicalDirectory(sourceDirectory);
  const sourceTransactionPath = path.join(sourceDirectory, 'transaction.json');
  const sourceReplacementPaths = durableJsonReplacementPaths(sourceTransactionPath);
  const sourceEntries = (await readdir(sourceDirectory)).sort();
  const requiredSourceEntries = ['command-evidence', 'durable-command', 'identity.json', 'shim'];
  const permittedSourceEntries = new Set([
    ...requiredSourceEntries,
    'transaction.json',
    path.basename(sourceReplacementPaths.intent),
    path.basename(sourceReplacementPaths.temporary),
  ]);
  if (!requiredSourceEntries.every(name => sourceEntries.includes(name)) ||
      sourceEntries.some(name => !permittedSourceEntries.has(name))) {
    throw new Error('source Assignment evidence is missing, extra, or ambiguous');
  }
  const sourceTransactionPresent = sourceEntries.includes('transaction.json');
  const sourceReplacementPresent = sourceEntries.includes(path.basename(sourceReplacementPaths.intent)) ||
    sourceEntries.includes(path.basename(sourceReplacementPaths.temporary));
  const commandDirectory = path.join(sourceDirectory, 'command-evidence');
  const durableDirectory = path.join(sourceDirectory, 'durable-command');
  const shimDirectory = path.join(sourceDirectory, 'shim');
  const stopsDirectory = path.join(shimDirectory, 'stops');
  for (const directory of [commandDirectory, durableDirectory, shimDirectory, stopsDirectory]) await requireCanonicalDirectory(directory);
  await requireCanonicalPathAbsent(path.join(context.gitDirectory, 'mdlm-pi', 'run.json'), context.gitDirectory, 'current mdlm-pi journal');
  if (!sameJson((await readdir(commandDirectory)).sort(), [
    'command-000001.json', 'command-000001.stderr', 'command-000001.stdout',
    'command-000002.json', 'command-000002.stderr', 'command-000002.stdout',
  ]) || !sameJson((await readdir(durableDirectory)).sort(), ['authorization.json', 'result.json']) ||
      !sameJson((await readdir(shimDirectory)).sort(), ['assignment-checkpoint.json', 'config.json', 'processed-assignment.json', 'stops'])) {
    throw new Error('retained command or shim evidence is missing, extra, or already consumed');
  }
  if (!Array.isArray(evidence.commands) || evidence.commands.length !== 2) throw new Error('exactly two command evidence triplets are required');
  const expectedPrivatePins = {
    identity: path.join(sourceDirectory, 'identity.json'),
    authorization: path.join(durableDirectory, 'authorization.json'),
    result: path.join(durableDirectory, 'result.json'),
    shimConfig: path.join(shimDirectory, 'config.json'),
    processedAssignment: path.join(shimDirectory, 'processed-assignment.json'),
    assignmentCheckpoint: path.join(shimDirectory, 'assignment-checkpoint.json'),
  };
  for (const [name, expectedPath] of Object.entries(expectedPrivatePins)) {
    if (path.resolve(evidence[name].path) !== expectedPath) throw new Error(`${name} pin does not name the source Assignment evidence`);
  }
  for (let offset = 0; offset < evidence.commands.length; offset++) {
    const index = String(offset + 1).padStart(6, '0');
    for (const name of ['record', 'stdout', 'stderr']) {
      const extension = name === 'record' ? 'json' : name;
      if (path.resolve(evidence.commands[offset][name].path) !== path.join(commandDirectory, `command-${index}.${extension}`)) {
        throw new Error(`command-${index} ${name} pin does not name the exact source evidence`);
      }
    }
  }

  const expectedInitialSnapshot = targetBinding.translate(path.join(originalRequest.evidenceDirectory, 'snapshot-000001'));
  const expectedPostSnapshot = targetBinding.translate(path.join(originalRequest.evidenceDirectory, 'snapshot-000002'));
  const expectedRepositoryIdentity = targetBinding.translate(path.join(originalRequest.evidenceDirectory, 'repository-identity.json'));
  if (path.resolve(evidence.initialSnapshot.directory) !== expectedInitialSnapshot ||
      path.resolve(evidence.postSnapshot.directory) !== expectedPostSnapshot) {
    throw new Error('snapshot targets do not match the original run request and authenticated relocation');
  }
  if (path.resolve(evidence.repositoryIdentity.path) !== expectedRepositoryIdentity) {
    throw new Error('initial repository identity pin does not match the original evidence directory and authenticated relocation');
  }
  const repositoryIdentityEvidence = await requirePinnedEvidence(evidence.repositoryIdentity, 'initial repository identity');
  let initialRepositoryIdentity;
  try { initialRepositoryIdentity = JSON.parse(repositoryIdentityEvidence.bytes.toString('utf8')); }
  catch { throw new Error('initial repository identity is not valid JSON'); }
  const outerCommandEvidence = await authenticateOuterControllerEvidence(
    evidence.outerCommand, targetBinding, recoveryShape, originalRequest, request.timeoutMs,
  );
  const initialVerified = await verifySnapshot(evidence.initialSnapshot.directory, evidence.initialSnapshot.digest, false);
  const postVerified = await verifySnapshot(evidence.postSnapshot.directory, evidence.postSnapshot.digest, true);
  const initial = initialVerified.snapshot;
  const post = postVerified.snapshot;
  const initialLastAssignment = initialRepositoryIdentity?.lastAssignment;
  const validInitialLastAssignment = initialLastAssignment === null ||
    (initialLastAssignment && !Array.isArray(initialLastAssignment) &&
     sameJson(Object.keys(initialLastAssignment).sort(), ['completed', 'id', 'outcome']) &&
     typeof initialLastAssignment.id === 'string' && initialLastAssignment.id.length > 0 &&
     initialLastAssignment.completed === true &&
     (initialLastAssignment.outcome === null ||
      (typeof initialLastAssignment.outcome === 'string' && initialLastAssignment.outcome.length > 0)));
  if (!initialRepositoryIdentity || Array.isArray(initialRepositoryIdentity) ||
      !sameJson(Object.keys(initialRepositoryIdentity).sort(), ['contract', 'lastAssignment', 'lifecycleRepository']) ||
      initialRepositoryIdentity.contract !== 'mdlm-demo-repository-identity@1' ||
      !sameJson(initialRepositoryIdentity.lifecycleRepository, initial.lifecycleRepository) ||
      !validInitialLastAssignment) {
    throw new Error('initial repository identity does not prove the complete trusted Assignment A boundary');
  }
  if (initialLastAssignment?.id === fromAssignment) {
    throw new Error('initial repository identity says Assignment A was already completed');
  }
  const identityEvidence = await requirePinnedEvidence(evidence.identity, 'source Assignment identity');
  const identity = JSON.parse(identityEvidence.bytes.toString('utf8'));
  if (!identity || !sameJson(Object.keys(identity).sort(), ['assignmentId', 'assignmentRepository', 'contract', 'lifecycleRepository']) ||
      identity.contract !== 'mdlm-demo-assignment-identity@1' || identity.assignmentId !== fromAssignment ||
      !sameJson(identity.lifecycleRepository, initial.lifecycleRepository) ||
      !sameJson(identity.assignmentRepository, initial.assignmentRepository)) {
    throw new Error('source Assignment identity differs from the initial snapshot');
  }
  const processPackage = normalizeProcessPackage(initial.status?.package, 'initial snapshot Process Package');
  if (initial.repository !== originalRequest.repository || post.repository !== originalRequest.repository ||
      initial.lifecycleRepository?.clean !== true || post.lifecycleRepository?.clean !== true ||
      initial.assignment?.id !== fromAssignment || initial.assignment.selected !== true || initial.assignment.disposition !== 'active' ||
      !statusHasActiveAssignment(initial.status, fromAssignment) || initial.diagnosis?.ok !== true ||
      !sameRepositoryFingerprint(initial.assignmentRepository, initial.lifecycleRepository) ||
      !sameProcessPackageIdentity(processPackage, initial.assignment.package) ||
      !sameProcessPackageIdentity(processPackage, initial.diagnosis.package)) {
    throw new Error('initial snapshot does not prove the exact active Assignment A boundary');
  }
  for (const [snapshot, label] of [[initial, 'initial'], [post, 'post-run']]) {
    requireCertainJournalAbsence(snapshot.journal, `${label} runner transaction journal`);
    requireCertainJournalAbsence(snapshot.piJournal, `${label} mdlm-pi journal`);
    if (snapshot.diagnosis?.baselineRepositoryVerification?.processDrift !== 0 ||
        !Number.isSafeInteger(snapshot.diagnosis?.baselineRepositoryVerification?.verifiedBaselines)) {
      throw new Error(`${label} doctor did not verify its baseline repository without process drift`);
    }
  }
  if (post.assignment?.id !== fromAssignment || post.assignment.selected !== false ||
      !sameJson(Object.keys(post.assignment).sort(), ['id', 'selected']) || post.assignmentRepository !== null ||
      post.diagnosis?.ok !== true || !sameProcessPackageIdentity(processPackage, post.status?.package) ||
      !sameProcessPackageIdentity(processPackage, post.diagnosis?.package)) {
    throw new Error('post-run snapshot does not prove deselected Assignment A at the advanced boundary');
  }

  const checkpointEvidence = await requirePinnedEvidence(evidence.assignmentCheckpoint, 'Assignment checkpoint marker');
  const checkpoint = JSON.parse(checkpointEvidence.bytes.toString('utf8'));
  if (!checkpoint || !sameJson(Object.keys(checkpoint).sort(), ['assignment', 'completedAssignment', 'contract', 'scenario']) ||
      checkpoint.contract !== 'mdlm-demo-shim-assignment-checkpoint@1' || checkpoint.completedAssignment !== fromAssignment ||
      typeof checkpoint.assignment !== 'string' || checkpoint.assignment === fromAssignment || typeof checkpoint.scenario !== 'string') {
    throw new Error('Assignment checkpoint marker does not prove exact A-to-B advancement');
  }
  const toAssignment = checkpoint.assignment;
  if (initialLastAssignment?.id === toAssignment) {
    throw new Error('initial repository identity says Assignment B was already invoked or completed');
  }
  if (path.resolve(evidence.stopPacket.path) !== path.join(stopsDirectory, `${toAssignment}.json`) ||
      !sameJson((await readdir(stopsDirectory)).sort(), [`${toAssignment}.json`])) {
    throw new Error('retained B packet is missing, extra, or not the exact operator pin');
  }
  const packetEvidence = await requirePinnedEvidence(evidence.stopPacket, 'retained B packet');
  const packet = validateScenarioPrepare(JSON.parse(packetEvidence.bytes.toString('utf8')), {
    assignmentId: toAssignment, package: processPackage,
    repository: { head: post.lifecycleRepository.head, trackedState: post.lifecycleRepository.trackedState },
  });
  if (packet.scenario.reference !== checkpoint.scenario || !statusHasActiveAssignment(post.status, toAssignment)) {
    throw new Error('post-run status, checkpoint, and retained packet differ on Assignment B');
  }

  const processedEvidence = await requirePinnedEvidence(evidence.processedAssignment, 'processed Assignment marker');
  const processed = JSON.parse(processedEvidence.bytes.toString('utf8'));
  if (!sameJson(processed, {
    contract: 'mdlm-demo-shim-processed-assignment@1', assignment: fromAssignment,
    package: processPackage, repository: identity.assignmentRepository,
  })) throw new Error('processed Assignment marker differs from Assignment A');
  const configEvidence = await requirePinnedEvidence(evidence.shimConfig, 'shim configuration');
  const config = JSON.parse(configEvidence.bytes.toString('utf8'));
  const originalSourceDirectory = path.join(originalRequest.stateDirectory, 'assignments', assignmentKey(fromAssignment));
  if (!sameJson(config, {
    contract: 'mdlm-demo-shim-config@1', realMdlm: originalRequest.commands.mdlm, allowedAssignment: fromAssignment,
    package: processPackage, repository: identity.assignmentRepository,
    stopDirectory: path.join(originalSourceDirectory, 'shim', 'stops'), timeoutMs: originalRequest.timeoutMs,
  })) throw new Error('shim configuration differs from the original authorized run');

  const first = await authenticateStoredCommand(commandDirectory, '000001');
  const second = await authenticateStoredCommand(commandDirectory, '000002');
  for (const [offset, stored] of [first, second].entries()) {
    for (let part = 0; part < stored.evidence.length; part++) {
      const names = ['record', 'stdout', 'stderr'];
      const pinned = await requirePinnedEvidence(evidence.commands[offset][names[part]], `command-${String(offset + 1).padStart(6, '0')} ${names[part]}`);
      if (!pinned.bytes.equals(stored.evidence[part].bytes)) throw new Error('operator-pinned command triplet differs from retained command evidence');
    }
  }
  requireStoredProcess(first.record, [originalRequest.commands.mdlm, 'scenario', 'prepare', fromAssignment, '--json'], originalRequest.repository, originalRequest.timeoutMs, 0);
  if (first.stderr.length !== 0) throw new Error('Scenario prepare command has stderr bytes');
  validateScenarioPrepare(JSON.parse(first.stdout.toString('utf8')), {
    assignmentId: fromAssignment, package: processPackage, repository: identity.assignmentRepository,
  });
  const authorizedShim = second.record.argv?.[4];
  const expectedWorker = [
    originalRequest.commands.mdlmPi, 'run', originalRequest.repository, '--mdlm', authorizedShim,
    '--provider', originalRequest.operator.provider, '--model', originalRequest.operator.model,
    '--thinking', originalRequest.operator.thinking,
  ];
  if (typeof authorizedShim !== 'string' || !path.isAbsolute(authorizedShim) || path.basename(authorizedShim) !== path.basename(mdlmShim) ||
      !sameJson(second.record.argv, expectedWorker) || path.resolve(second.record.cwd) !== path.resolve(originalRequest.repository) ||
      second.record.timeoutMs !== originalRequest.timeoutMs || second.record.spawnError !== null ||
      second.record.outputLimitExceeded !== false) {
    throw new Error('durable worker command differs from the authorized checkpoint attempt');
  }
  let nonTimeoutSourceCommit = null;
  if (recoveryShape.kind === 'timed-out') {
    if (second.record.timedOut !== true || second.record.exitStatus !== null || second.record.signal !== 'SIGKILL') {
      throw new Error('durable worker command is not the exact timed-out SIGKILL attempt');
    }
    const typedFailure = JSON.parse(second.stderr.toString('utf8'));
    if (!typedFailure || !sameJson(Object.keys(typedFailure).sort(), ['details', 'error', 'status']) ||
        typedFailure.status !== 'operational-failure' || typedFailure.error !== 'MDLM could not prepare the Assignment' ||
        !sameJson(typedFailure.details, {
          contract: 'mdlm-demo-reserved-stop@1', type: 'assignment-checkpoint', phase: 'before-worker',
          assignment: toAssignment, scenario: checkpoint.scenario,
          packetPath: path.join(originalSourceDirectory, 'shim', 'stops', `${toAssignment}.json`),
          completedAssignment: fromAssignment,
        })) throw new Error('durable worker stderr is not the exact typed A-to-B checkpoint stop');
  } else {
    if (second.record.timedOut !== false || second.record.exitStatus !== 1 || second.record.signal !== null) {
      throw new Error('durable worker command is not the exact non-timeout exit-1 checkpoint attempt');
    }
    const operationalFailure = JSON.parse(second.stderr.toString('utf8'));
    if (!sameJson(operationalFailure, {
      contract: 'mdlm-pi-operational-failure@1', status: 'operational-failure',
      error: { code: 'MDLM_CLIENT_ERROR', message: 'MDLM could not prepare the Assignment' },
      telemetry: {
        stopReason: null, providerError: null, retriesConsumed: null, provider: null,
        model: null, completeAssignmentObserved: null,
      },
    })) throw new Error('durable worker stderr is not the exact non-timeout MDLM prepare failure');
    const stdoutLines = second.stdout.toString('utf8').trimEnd().split('\n');
    const sourceCommit = /^Committed ([0-9a-f]{40}): (.+)$/.exec(stdoutLines[1] ?? '');
    nonTimeoutSourceCommit = sourceCommit?.[1] ?? null;
    if (!sameJson(stdoutLines, [
      `Assignment ${fromAssignment}: ${initial.assignment.scenarioReference}`,
      `Committed ${nonTimeoutSourceCommit}: ${initial.assignment.scenarioReference}`,
      `Committed ${post.lifecycleRepository.head}: create-review-context@1`,
    ]) || nonTimeoutSourceCommit === post.lifecycleRepository.head) {
      throw new Error('durable worker stdout does not prove the exact source and materialization publications');
    }
  }

  const authorizationEvidence = await requirePinnedEvidence(evidence.authorization, 'durable authorization');
  const authorization = JSON.parse(authorizationEvidence.bytes.toString('utf8'));
  requireStoredDurableAuthorization(authorization, originalSourceDirectory);
  const validAuthorizationInput = recoveryShape.kind === 'timed-out'
    ? authorization.command.input?.present === true &&
      authorization.command.input.digest === sha256(Buffer.from(authorization.context.decisionInputBase64 ?? '', 'base64'))
    : authorization.context.decisionInputBase64 === null && authorization.context.decisionEvidence === null &&
      sameJson(authorization.command.input, { present: false, bytes: 0, digest: sha256(Buffer.alloc(0)) });
  if (authorization?.contract !== 'mdlm-demo-command-authorization@1' || authorization.purpose !== 'assignment-worker' ||
      !sameJson(authorization.command.argv, expectedWorker) || authorization.command.cwd !== originalRequest.repository ||
      authorization.command.timeoutMs !== originalRequest.timeoutMs || authorization.context?.assignment?.id !== fromAssignment ||
      !sameProcessPackageIdentity(authorization.context.assignment.package, processPackage) ||
      !sameJson(authorization.context.assignment.repository, identity.assignmentRepository) ||
      authorization.context.assignment.selected !== true || authorization.context.assignment.disposition !== 'active' ||
      authorization.context.assignment.scenarioReference !== initial.assignment.scenarioReference ||
      authorization.context.initialSnapshot?.digest !== evidence.initialSnapshot.digest ||
      authorization.context.initialSnapshot?.snapshotDirectory !== path.join(originalRequest.evidenceDirectory, 'snapshot-000001') ||
      authorization.context.privateEvidenceBefore?.safe !== true ||
      authorization.context.shimDirectory !== path.join(originalSourceDirectory, 'shim') ||
      authorization.compatibilityEvidence?.index !== 2 ||
      authorization.compatibilityEvidence?.prefix !== path.join(originalSourceDirectory, 'command-evidence', 'command-000002') ||
      !validAuthorizationInput) {
    throw new Error('durable authorization differs from the original request, snapshot, or Assignment A');
  }
  const resultEvidence = await requirePinnedEvidence(evidence.result, 'durable result');
  const durableResult = JSON.parse(resultEvidence.bytes.toString('utf8'));
  if (durableResult?.contract !== 'mdlm-demo-command-result@1' ||
      !sameJson(Object.keys(durableResult).sort(), ['authorization', 'contract', 'process', 'repository']) ||
      !sameJson(Object.keys(durableResult.authorization ?? {}).sort(), ['digest', 'path']) ||
      Date.parse(authorization.createdAt) > Date.parse(second.record.startedAt) ||
      Date.parse(second.record.completedAt) > Date.parse(post.createdAt) ||
      !sameJson(durableResult.authorization, {
        path: path.join(originalSourceDirectory, 'durable-command', 'authorization.json'), digest: authorizationEvidence.digest,
      }) || !sameJson(durableResult.process, second.record) || !sameJson(durableResult.repository, post.lifecycleRepository)) {
    throw new Error('durable result differs from its authorization, exact command triplet, or post-run repository');
  }

  requireOriginalProvenanceBinding(initial.provenance, originalRequest, 'initial');
  requireOriginalProvenanceBinding(post.provenance, originalRequest, 'post-run');
  const initialRunIdentity = observedRunIdentity(initial.provenance, processPackage, originalRequest.operator, originalRequest);
  const postRunIdentity = observedRunIdentity(post.provenance, processPackage, originalRequest.operator, originalRequest);
  const retainedRunIdentity = await optionalCanonicalJson(path.join(context.identityDirectory, 'run-identity.json'));
  if (!sameJson(initialRunIdentity, postRunIdentity) || !sameJson(initialRunIdentity, retainedRunIdentity)) {
    throw new Error('operator, package, tool, source, or harness identity changed across reconciliation boundaries');
  }
  const current = await currentLifecycleRepository(context, request.timeoutMs);
  if (!sameJson(current, post.lifecycleRepository) || !sameJson(current, durableResult.repository)) {
    throw new Error('current repository differs from the exact pinned Assignment B boundary');
  }
  const bDirectory = path.join(path.resolve(request.stateDirectory), 'assignments', assignmentKey(toAssignment));
  if (await optionalLstat(bDirectory) !== null) throw new Error('Assignment B already has private attempt evidence');
  await authenticateLifecycleTransactionAncestry(context.repository, initial.lifecycleRepository.head, post.lifecycleRepository.head,
    recoveryShape.kind === 'timed-out'
      ? { firstAssignmentId: fromAssignment, commitCount: 4 }
      : {
          firstAssignmentId: fromAssignment, commitCount: 2, finalScenario: 'create-review-context@1',
          finalAssignmentExcludes: [fromAssignment, toAssignment],
          commits: [nonTimeoutSourceCommit, post.lifecycleRepository.head],
        });

  const manifests = {
    request: evidenceManifest(requestEvidence),
    initialSnapshot: { directory: initialVerified.snapshotDirectory, digest: initialVerified.digest, manifest: initialVerified.manifest },
    postSnapshot: { directory: postVerified.snapshotDirectory, digest: postVerified.digest, manifest: postVerified.manifest },
    outerCommand: Object.fromEntries(Object.entries(outerCommandEvidence).map(([name, value]) => [name, evidenceManifest(value)])),
    authorization: evidenceManifest(authorizationEvidence), result: evidenceManifest(resultEvidence),
    commands: [first, second].map(stored => stored.evidence.map(evidenceManifest)),
    repositoryIdentity: evidenceManifest(repositoryIdentityEvidence),
    identity: evidenceManifest(identityEvidence), config: evidenceManifest(configEvidence),
    processedAssignment: evidenceManifest(processedEvidence), assignmentCheckpoint: evidenceManifest(checkpointEvidence),
    packet: evidenceManifest(packetEvidence),
  };
  const record = {
    contract: 'mdlm-demo-checkpoint-reconciliation@1', phase: 'authenticated', fromAssignment, toAssignment,
    sourceAssignmentDirectory: sourceDirectory, priorRepository: initial.lifecycleRepository,
    priorRepositoryIdentity: initialRepositoryIdentity,
    completedRepository: post.lifecycleRepository, scenario: packet.scenario.reference,
    sourceScenario: initial.assignment.scenarioReference, package: processPackage,
    targetBinding: targetBinding.manifest,
    outerControllerCompletion: { completed: true, exitStatus: 1, internalRunnerResult: 'absent' },
    ...(recoveryShape.kind === 'timed-out'
      ? { timedOutCheckpointRecovery: manifests }
      : { nonTimeoutMaterializedCheckpointRecovery: manifests }),
    evidence: manifests,
  };
  const journalName = `${assignmentKey(fromAssignment)}-to-${assignmentKey(toAssignment)}.json`;
  const journalInspection = await inspectStandaloneReconciliationDirectory(context.identityDirectory, journalName, record);
  const existingJournal = journalInspection.existing;
  if (existingJournal !== null &&
      (!['authenticated', 'boundary-advanced', 'completed'].includes(existingJournal.phase) ||
       !sameJson({ ...existingJournal, phase: 'authenticated' }, record))) {
    throw new Error('checkpoint reconciliation journal differs from the authenticated command evidence');
  }
  const completedSource = completedCheckpointTransaction(record, journalInspection.journalPath);
  const completedSourceBytes = canonicalJsonBytes(completedSource);
  if (sourceTransactionPresent || sourceReplacementPresent) {
    if (existingJournal === null) {
      throw new Error('source Assignment transaction has no prior authenticated reconciliation journal');
    }
    if (existingJournal.phase === 'authenticated') {
      throw new Error('source Assignment transaction is ahead of its authenticated reconciliation journal');
    }
    await recoverDurableJsonReplacement(sourceTransactionPath, completedSourceBytes);
    await validateExistingCheckpointTransaction(sourceDirectory, record, journalInspection.journalPath);
  } else if (existingJournal?.phase === 'completed') {
    throw new Error('completed reconciliation journal has no matching source Assignment transaction');
  }

  const globalPath = path.join(context.identityDirectory, 'repository-identity.json');
  const globalEvidence = await immutableFileEvidence(globalPath);
  let global;
  try { global = JSON.parse(globalEvidence.bytes.toString('utf8')); }
  catch { throw new Error('trusted repository identity is not valid JSON'); }
  const trustedInitial = globalEvidence.bytes.equals(repositoryIdentityEvidence.bytes) &&
    sameJson(global, initialRepositoryIdentity);
  const trustedAdvance = existingJournal !== null && global?.contract === 'mdlm-demo-repository-identity@1' &&
    sameJson(global.lifecycleRepository, post.lifecycleRepository) &&
    sameJson(global.lastAssignment, { id: fromAssignment, outcome: 'accepted-publication', completed: true });
  if (!trustedInitial && !trustedAdvance) {
    throw new Error('trusted repository identity differs from Assignment A initial or exactly journaled advanced boundary');
  }
  return {
    fromAssignment, toAssignment, sourceDirectory, record,
    journalPath: journalInspection.journalPath,
    journalDirectory: journalInspection.directory,
    journalDirectoryIdentity: journalInspection.identity,
    existingJournal,
  };
}

async function currentLifecycleRepository(context, timeoutMs) {
  const runGit = async args => {
    const output = await runProcess('git', args, { cwd: context.repository, timeoutMs, env: gitEnvironment() });
    if (!commandSucceeded(output)) throw new Error(`Git repository evidence failed for ${args.join(' ')}`);
    return output.stdout;
  };
  const head = (await runGit(['rev-parse', 'HEAD^{commit}'])).toString('utf8').trim();
  const tree = (await runGit(['rev-parse', 'HEAD^{tree}'])).toString('utf8').trim();
  const porcelain = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const staged = await runGit(['diff', '--binary', '--no-ext-diff', '--cached', 'HEAD', '--']);
  const worktree = await runGit(['diff', '--binary', '--no-ext-diff', '--']);
  return {
    head, tree, trackedState: sha256(Buffer.from(`${head}\0staged\0${staged.toString('utf8')}\0worktree\0${worktree.toString('utf8')}`)),
    clean: porcelain.length === 0, porcelainSha256: sha256(porcelain),
  };
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
  const closurePath = path.join(assignmentDirectory, 'publication-closure.json');
  const existingClosure = await optionalCanonicalJson(closurePath);
  if (existingClosure !== null) {
    try {
      const processPackage = normalizeProcessPackage(existingClosure.package, 'publication closure Process Package');
      if (!sameProcessPackageIdentity(processPackage, captured.status.package) ||
          !sameProcessPackageIdentity(processPackage, captured.diagnosis.package)) {
        throw new Error('status or doctor Process Package differs from the publication closure');
      }
      const runIdentity = observedRunIdentity(captured.provenance, processPackage, request.operator, request);
      if (!sameJson(runIdentity, existingClosure.runIdentity) ||
          !await pinRunIdentity(context.identityDirectory, runIdentity, mode === 'run')) {
        throw new Error('run identity differs from the publication closure');
      }
      return await continuePublicationClosure({
        request, context, assignmentDirectory, journalPath, closurePath, closure: existingClosure,
        snapshotResult, processPackage, runIdentity, resumed: true,
      });
    } catch (error) {
      return stopped('publication-closure-failure', error instanceof Error ? error.message : String(error), snapshotResult, assignmentId);
    }
  }

  const assignment = captured.assignment;
  const status = captured.status;
  const existingTransaction = await optionalCanonicalJson(journalPath);
  let trustedCompletedTransaction = false;
  try {
    const recovered = await recoverDurableAssignmentCommand({
      request, context, assignmentDirectory, snapshotResult, status, diagnosis: captured.diagnosis, mode,
    });
    if (recovered === authenticatedCompletedDurableCommand) trustedCompletedTransaction = true;
    else if (recovered !== null) return recovered;
  } catch (error) {
    return stopped(
      'durable-command-uncertain',
      error instanceof Error ? error.message : String(error),
      snapshotResult,
      assignmentId,
    );
  }
  const advancing = advancingControllerJournal(captured, assignmentId);
  if (advancing.present) {
    if (!advancing.ok) return stopped('advancing-journal-invalid', advancing.detail, snapshotResult, assignmentId);
    try {
      const controllerAssignment = await authenticateAdvancingControllerRecovery({
        context, assignmentDirectory, captured, assignmentId,
        advancement: advancing.advancement, processPackage: advancing.processPackage,
      });
      const runIdentity = observedRunIdentity(captured.provenance, advancing.processPackage, request.operator, request);
      if (mode !== 'resume') {
        return stopped('wrong-recovery-mode', "an advancing controller journal requires 'resume'", snapshotResult, assignmentId, { recoverable: true, requiredNextMode: 'resume' });
      }
      if (!await pinRunIdentity(context.identityDirectory, runIdentity, false)) {
        return stopped('run-identity-drift', 'operator, mdlm-pi timeout policy, artifact, installed Process Package, executable target, source, or harness identity changed', snapshotResult, assignmentId);
      }
      return await runPiAssignment(request, context, assignmentDirectory, controllerAssignment, status, snapshotResult);
    } catch (error) {
      return stopped('advancing-journal-invalid', error instanceof Error ? error.message : String(error), snapshotResult, assignmentId);
    }
  }
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
    trustedCompletedTransaction,
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
    if (exactCommitRecovery && journal.package !== undefined) {
      try {
        return withCheckpointRecovery(await beginPublicationClosure({
          request, context, assignmentDirectory, journalPath, snapshotResult, processPackage, runIdentity,
          completedJournal: journal, recoveredPublication: true,
        }));
      } catch (error) {
        return withCheckpointRecovery(stopped('publication-closure-failure', error instanceof Error ? error.message : String(error), snapshotResult, assignmentId));
      }
    }
    return withCheckpointRecovery(result('already-completed', snapshotResult, { assignmentId, executionId: journal.executionId, commit: journal.commit, outcome: journal.outcome }));
  }
  if (journal?.phase === 'correction-required' || journal?.phase === 'correction-bound') {
    let correction;
    try {
      correction = await authenticateCorrectionBoundary({
        journal, assignment, status, assignmentDirectory, captured, processPackage, request, context,
      });
    } catch (error) {
      return withCheckpointRecovery(stopped('correction-boundary-drift', error instanceof Error ? error.message : String(error), snapshotResult, assignmentId));
    }
    if (journal.phase === 'correction-required' && request.correctionContinuation === undefined) {
      return withCheckpointRecovery(correctionRequiredStop(snapshotResult, assignmentId, correction));
    }
    if (mode !== 'resume') {
      return withCheckpointRecovery(stopped(
        'wrong-recovery-mode', "correction continuation requires 'resume'", snapshotResult, assignmentId,
        { recoverable: true, requiredNextMode: 'resume' },
      ));
    }
    if (request.correctionContinuation === undefined) {
      return withCheckpointRecovery(stopped('correction-input-invalid', 'bound correction continuation requires its exact public input pin', snapshotResult, assignmentId));
    }
    let boundJournal;
    let responseBytes;
    try {
      if (journal.phase === 'correction-required') {
        ({ journal: boundJournal, bytes: responseBytes } = await bindCorrectionInput(journal, request.correctionContinuation, context.repository));
        await writeJournal(journalPath, boundJournal);
        maybeInjectedCrash('correction-continuation', 'after-bind');
      } else {
        boundJournal = journal;
        responseBytes = await authenticateBoundCorrectionInput(journal, request.correctionContinuation, context.repository);
      }
    } catch (error) {
      return withCheckpointRecovery(stopped('correction-input-invalid', error instanceof Error ? error.message : String(error), snapshotResult, assignmentId));
    }
    return withCheckpointRecovery(await submitExternalResponse({
      request, context, assignmentDirectory, journalPath, journal: boundJournal, responseBytes,
      snapshotResult, processPackage, runIdentity, isCorrection: true,
    }));
  }
  if (journal?.phase === 'assignment-exhausted') {
    let disposition;
    try {
      disposition = await authenticateExhaustedBoundary({
        journal, assignment, status, assignmentDirectory, captured, processPackage, request, context,
      });
    } catch (error) {
      return withCheckpointRecovery(stopped('exhausted-boundary-drift', error instanceof Error ? error.message : String(error), snapshotResult, assignmentId));
    }
    return withCheckpointRecovery(assignmentExhaustedStop(snapshotResult, assignmentId, disposition));
  }
  if (journal?.phase === 'submitting' || journal?.phase === 'correction-submitting' || journal?.phase === 'uncertain-transaction') {
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
      const completedJournal = { ...journal, phase: 'completed', commit, completedAt: new Date().toISOString(), trustedRepositoryAdvance: true };
      await writeJournal(journalPath, completedJournal);
      if (journal.package === undefined) {
        return withCheckpointRecovery(result('completed', snapshotResult, {
          assignmentId, executionId: publication.executionId, commit, recoveredPublication: true,
          outcome: 'accepted-publication', trustedRepositoryAdvance: true,
        }));
      }
      return withCheckpointRecovery(await beginPublicationClosure({
        request, context, assignmentDirectory, journalPath, snapshotResult, processPackage, runIdentity,
        completedJournal, recoveredPublication: true,
      }));
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
    const publication = { executionId: journal.executionId, scenario: journal.scenario, outputPaths: journal.outputPaths, blobs: journal.blobs };
    let completedJournal;
    try {
      const commit = await commitPublication(context.repository, publication, journal.baseCommit, request.timeoutMs, assignmentDirectory);
      completedJournal = { ...journal, phase: 'completed', commit, completedAt: new Date().toISOString(), trustedRepositoryAdvance: true };
      await writeJournal(journalPath, completedJournal);
    } catch (error) {
      await writeJournal(journalPath, { ...journal, phase: 'uncertain-publication', error: error.message });
      return withCheckpointRecovery(stopped('uncertain-partial-publication', error.message, snapshotResult, assignmentId));
    }
    if (journal.package === undefined) {
      return withCheckpointRecovery(result('completed', snapshotResult, {
        assignmentId, executionId: publication.executionId, commit: completedJournal.commit, recoveredPublication: true,
        outcome: 'accepted-publication', trustedRepositoryAdvance: true,
      }));
    }
    try {
      return withCheckpointRecovery(await beginPublicationClosure({
        request, context, assignmentDirectory, journalPath, snapshotResult, processPackage, runIdentity,
        completedJournal, recoveredPublication: true,
      }));
    } catch (error) {
      return withCheckpointRecovery(stopped('publication-closure-failure', error instanceof Error ? error.message : String(error), snapshotResult, assignmentId));
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
    return withCheckpointRecovery(await runPiAssignment(
      request, context, assignmentDirectory, assignment, status, snapshotResult, recoveryGate.transition,
    ));
  }
  return withCheckpointRecovery(await runExternalAssignment(
    request, context, assignmentDirectory, journalPath, assignment, packet, prepare.stdout, snapshotResult, journal, runIdentity,
  ));
}

async function runExternalAssignment(request, context, assignmentDirectory, journalPath, assignment, packet, packetBytes, snapshotResult, existingJournal, runIdentity) {
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
  return submitExternalResponse({
    request, context, assignmentDirectory, journalPath, journal, responseBytes: adapted.bytes,
    snapshotResult, processPackage: packet.package, runIdentity, isCorrection: false,
  });
}

async function submitExternalResponse({
  request, context, assignmentDirectory, journalPath, journal, responseBytes,
  snapshotResult, processPackage, runIdentity, isCorrection,
}) {
  const assignmentId = journal.assignmentId;
  const submittingPhase = isCorrection ? 'correction-submitting' : 'submitting';
  await writeJournal(journalPath, { ...journal, phase: submittingPhase, submissionStartedAt: new Date().toISOString() });
  const submission = await invoke(assignmentDirectory, request.commands.mdlm, ['scenario', 'submit', '-', '--json'], context.repository, request.timeoutMs, responseBytes);
  const correction = isCorrection ? null : correctionRequiredSubmission(submission, assignmentId);
  if (correction !== null) {
    await writeJournal(journalPath, {
      ...journal, phase: 'correction-required', submission: commandRecord(submission), correction,
    });
    return correctionRequiredStop(snapshotResult, assignmentId, correction);
  }
  const exhausted = exhaustedAssignmentSubmission(submission, assignmentId);
  if (exhausted !== null) {
    const exhaustedJournal = {
      ...journal, phase: 'assignment-exhausted', submission: commandRecord(submission), assignmentDisposition: exhausted,
    };
    await writeJournal(journalPath, exhaustedJournal);
    const output = assignmentExhaustedStop(snapshotResult, assignmentId, exhausted);
    output[exhaustedBoundaryEvidence] = {
      journal: exhaustedJournal, assignmentDirectory, processPackage, request, context,
    };
    return output;
  }
  const submissionEvidence = isCorrection ? { correctionSubmission: commandRecord(submission) } : { submission: commandRecord(submission) };
  if (!commandSucceeded(submission)) {
    await writeJournal(journalPath, { ...journal, ...submissionEvidence, phase: 'uncertain-transaction' });
    return stopped('uncertain-partial-publication', 'submission process did not yield accepted execution evidence', snapshotResult, assignmentId, { transactionPhase: 'uncertain-transaction' });
  }
  let publication;
  try {
    publication = await publicationFromSubmission(parseJsonBytes(submission.stdout, 'scenario submit'), journal, context.repository);
    publication.blobs = await captureBlobs(context.repository, publication.outputPaths, request.timeoutMs, assignmentDirectory);
  } catch (error) {
    await writeJournal(journalPath, { ...journal, ...submissionEvidence, phase: 'uncertain-transaction', error: error.message });
    return stopped('uncertain-partial-publication', error.message, snapshotResult, assignmentId, { transactionPhase: 'uncertain-transaction' });
  }
  const published = {
    ...journal, ...submissionEvidence, phase: 'published-uncommitted',
    executionId: publication.executionId, outputPaths: publication.outputPaths, blobs: publication.blobs,
  };
  await writeJournal(journalPath, published);
  let completedJournal;
  try {
    const commit = await commitPublication(context.repository, publication, journal.baseCommit, request.timeoutMs, assignmentDirectory);
    completedJournal = { ...published, phase: 'completed', commit, completedAt: new Date().toISOString(), trustedRepositoryAdvance: true };
    await writeJournal(journalPath, completedJournal);
    maybeInjectedCrash('publication-closure', 'after-transaction-completed');
  } catch (error) {
    await writeJournal(journalPath, { ...published, phase: 'uncertain-publication', error: error.message });
    return stopped('uncertain-partial-publication', error.message, snapshotResult, assignmentId);
  }
  try {
    return await beginPublicationClosure({
      request, context, assignmentDirectory, journalPath, snapshotResult, processPackage, runIdentity,
      completedJournal, recoveredPublication: false,
    });
  } catch (error) {
    return stopped('publication-closure-failure', error instanceof Error ? error.message : String(error), snapshotResult, assignmentId);
  }
}

function correctionRequiredSubmission(submission, assignmentId) {
  if (submission.timedOut || submission.outputLimitExceeded || submission.signal !== null || submission.spawnError !== null || submission.exitStatus !== 1) return null;
  let output;
  try { output = parseJsonBytes(submission.stdout, 'scenario submit correction'); }
  catch { return null; }
  return isCorrectionRequiredDocument(output, assignmentId) ? output : null;
}

function isCorrectionRequiredDocument(output, assignmentId) {
  const malformed = output?.malformedResponse;
  return output?.contract === 'mdlm-assignment-disposition@1' && output.command === 'scenario.submit' && output.ok === false &&
    output.assignment?.id === assignmentId && output.disposition === 'correction-required' &&
    output.orchestration?.action === 'correct-response' && output.orchestration?.automaticReplacement === false &&
    Number.isSafeInteger(malformed?.attempt) && malformed.attempt >= 1 &&
    malformed?.correctionsRemaining === 1 &&
    Array.isArray(malformed.diagnostics) && Array.isArray(output.diagnostics) &&
    sameJson(malformed.diagnostics, output.diagnostics);
}

function exhaustedAssignmentSubmission(submission, assignmentId) {
  if (submission.timedOut || submission.outputLimitExceeded || submission.signal !== null || submission.spawnError !== null ||
      submission.exitStatus !== 1 || submission.stderr.length !== 0 ||
      submission.observedOutputBytes !== submission.stdout.length) return null;
  let output;
  try { output = parseJsonBytes(submission.stdout, 'scenario submit exhausted disposition'); }
  catch { return null; }
  return isExhaustedAssignmentDisposition(output, assignmentId) ? output : null;
}

function isExhaustedAssignmentDisposition(output, assignmentId) {
  const malformed = output?.malformedResponse;
  const diagnostics = malformed?.diagnostics;
  return output && typeof output === 'object' && !Array.isArray(output) &&
    sameJson(Object.keys(output).sort(), [
      'assignment', 'command', 'contract', 'diagnostics', 'disposition', 'malformedResponse', 'ok', 'orchestration',
    ]) && output.contract === 'mdlm-assignment-disposition@1' && output.command === 'scenario.submit' && output.ok === false &&
    sameJson(output.assignment, { id: assignmentId }) && output.disposition === 'exhausted' &&
    sameJson(output.orchestration, { action: 'stop', automaticReplacement: false }) &&
    malformed && sameJson(Object.keys(malformed).sort(), ['attempt', 'correctionsRemaining', 'diagnostics']) &&
    malformed.attempt === 2 && malformed.correctionsRemaining === 0 &&
    Array.isArray(diagnostics) && diagnostics.length > 0 && diagnostics.every(validAssignmentDispositionDiagnostic) &&
    Array.isArray(output.diagnostics) && sameJson(diagnostics, output.diagnostics);
}

function validAssignmentDispositionDiagnostic(diagnostic) {
  return diagnostic && typeof diagnostic === 'object' && !Array.isArray(diagnostic) &&
    sameJson(Object.keys(diagnostic).sort(), ['code', 'message', 'path']) &&
    ['code', 'message', 'path'].every(key => typeof diagnostic[key] === 'string' && diagnostic[key].length > 0);
}

function correctionFromCommandRecord(record, assignmentId, mdlmCommand, repository, timeoutMs) {
  if (!record || !sameJson(record.argv, [mdlmCommand, 'scenario', 'submit', '-', '--json']) ||
      record.cwd !== repository || record.timeoutMs !== timeoutMs || record.timedOut !== false ||
      record.outputLimitExceeded !== false || record.exitStatus !== 1 || record.signal !== null || record.spawnError !== null ||
      typeof record.stdoutBase64 !== 'string' || typeof record.stderrBase64 !== 'string') return null;
  const stdout = Buffer.from(record.stdoutBase64, 'base64');
  const stderr = Buffer.from(record.stderrBase64, 'base64');
  if (stdout.toString('base64') !== record.stdoutBase64 || stderr.toString('base64') !== record.stderrBase64 ||
      sha256(stdout) !== record.stdoutSha256 || sha256(stderr) !== record.stderrSha256 || stderr.length !== 0 ||
      record.observedOutputBytes !== stdout.length + stderr.length) return null;
  let correction;
  try { correction = parseJsonBytes(stdout, 'journaled scenario submit correction'); }
  catch { return null; }
  return isCorrectionRequiredDocument(correction, assignmentId) ? correction : null;
}

function correctionRequiredStop(snapshotResult, assignmentId, correction) {
  return result('stopped', snapshotResult, {
    assignmentId, recoverable: true, reason: 'malformed-response-correction-required',
    detail: 'MDLM rejected the response without publication and retained a correction attempt',
    outcome: 'correction-required', transactionPhase: 'correction-required', correction,
  });
}

function assignmentExhaustedStop(snapshotResult, assignmentId, assignmentDisposition) {
  return result('stopped', snapshotResult, {
    assignmentId, recoverable: false, reason: 'assignment-exhausted',
    detail: 'MDLM rejected the response without publication and exhausted malformed-response corrections',
    outcome: 'assignment-exhausted', transactionPhase: 'assignment-exhausted', trustedRepositoryAdvance: false,
    assignmentDisposition,
  });
}

async function authenticateCorrectionBoundary({
  journal, assignment, status, assignmentDirectory, captured, processPackage, request, context,
}) {
  const assignmentId = assignment.id;
  if (journal.contract !== 'mdlm-demo-transaction-journal@2' || journal.assignmentId !== assignmentId ||
      assignment.disposition !== 'active' || assignment.selected !== true || !statusHasActiveAssignment(status, assignmentId) ||
      journal.scenario !== assignment.scenarioReference || !sameProcessPackageIdentity(journal.package, processPackage) ||
      !sameProcessPackageIdentity(journal.package, assignment.package) || !sameJson(journal.repository, assignment.repository) ||
      journal.baseCommit !== journal.repository?.head || captured.lifecycleRepository.clean !== true ||
      !sameRepositoryFingerprint(journal.repository, captured.lifecycleRepository)) {
    throw new Error('journaled correction does not match the active Assignment, Scenario, package, and clean repository boundary');
  }
  const originalResponse = journal.phase === 'correction-required'
    ? { path: journal.responsePath, digest: journal.responseDigest }
    : journal.originalResponse;
  if (!originalResponse || !sameJson(Object.keys(originalResponse).sort(), ['digest', 'path']) ||
      typeof originalResponse.path !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(originalResponse.digest ?? '')) {
    throw new Error('journaled malformed response identity is incomplete');
  }
  const retained = Array.isArray(assignment.malformedResponses)
    ? assignment.malformedResponses.find(response => response?.digest === originalResponse.digest)
    : undefined;
  const recordedCorrection = correctionFromCommandRecord(
    journal.submission, assignmentId, request.commands.mdlm, context.repository, request.timeoutMs ?? 30_000,
  );
  if (recordedCorrection === null || !sameJson(recordedCorrection, journal.correction) ||
      !sameJson(retained?.diagnostics, journal.correction?.malformedResponse?.diagnostics)) {
    throw new Error('journaled correction does not match its authenticated malformed submission and Assignment diagnostics');
  }
  const [packetEvidence, malformedEvidence] = await Promise.all([
    readCanonicalFile(path.join(assignmentDirectory, 'prepared-packet.json'), 'prepared correction packet'),
    readCanonicalFile(originalResponse.path, 'malformed Assignment response'),
  ]);
  const packet = validateScenarioPrepare(parseJsonBytes(packetEvidence.bytes, 'prepared correction packet'), {
    assignmentId, package: processPackage, repository: assignment.repository,
  });
  if (packet.scenario.reference !== journal.scenario || sha256(packetEvidence.bytes) !== journal.packetDigest ||
      sha256(malformedEvidence.bytes) !== originalResponse.digest) {
    throw new Error('journaled correction packet or malformed response bytes differ');
  }
  const malformedResponse = parseJsonBytes(malformedEvidence.bytes, 'malformed Assignment response');
  if (malformedResponse.contract !== 'mdlm-assignment-response@1' || malformedResponse.assignment !== assignmentId) {
    throw new Error('journaled malformed response differs from the active Assignment');
  }
  return recordedCorrection;
}

async function authenticateExhaustedBoundary({
  journal, assignment, status, assignmentDirectory, captured, processPackage, request, context,
}) {
  const assignmentId = assignment.id;
  if (journal.contract !== 'mdlm-demo-transaction-journal@2' || journal.phase !== 'assignment-exhausted' ||
      journal.assignmentId !== assignmentId || assignment.disposition !== 'exhausted' || assignment.selected !== true ||
      statusHasActiveAssignment(status, assignmentId) || status.currentOutcome?.outcome !== 'assignment' ||
      !sameJson(status.currentOutcome?.assignment, { allocation: 'not-allocated' }) ||
      journal.scenario !== assignment.scenarioReference || !sameProcessPackageIdentity(journal.package, processPackage) ||
      !sameProcessPackageIdentity(journal.package, status.package) || !sameProcessPackageIdentity(journal.package, assignment.package) ||
      captured.diagnosis?.ok !== true || captured.diagnosis?.baselineRepositoryVerification?.processDrift !== 0 ||
      !sameProcessPackageIdentity(journal.package, captured.diagnosis?.package) ||
      !sameJson(journal.repository, assignment.repository) || journal.baseCommit !== journal.repository?.head ||
      captured.lifecycleRepository.clean !== true || !sameRepositoryFingerprint(journal.repository, captured.lifecycleRepository)) {
    throw new Error('journaled exhaustion does not match the terminal Assignment, package, and clean unpublished repository boundary');
  }
  const disposition = exhaustedFromCommandRecord(
    journal.submission, assignmentId, request.commands.mdlm, context.repository, request.timeoutMs ?? 30_000,
  );
  const malformedResponses = assignment.malformedResponses;
  const retainedHistoryIsExact = Array.isArray(malformedResponses) && malformedResponses.length === 2 &&
    malformedResponses.every(response => response && typeof response === 'object' && !Array.isArray(response) &&
      sameJson(Object.keys(response).sort(), ['diagnostics', 'digest']) && /^sha256:[0-9a-f]{64}$/.test(response.digest) &&
      Array.isArray(response.diagnostics) && response.diagnostics.length > 0 &&
      response.diagnostics.every(validAssignmentDispositionDiagnostic)) &&
    malformedResponses[0].digest !== malformedResponses[1].digest &&
    malformedResponses[1].digest === journal.responseDigest;
  const retained = retainedHistoryIsExact ? malformedResponses[1] : undefined;
  if (disposition === null || !sameJson(disposition, journal.assignmentDisposition)) {
    throw new Error('journaled exhaustion does not match its authenticated malformed submission');
  }
  if (!retainedHistoryIsExact || !sameJson(assignment.retryAvailability, { malformedResponseCorrection: 0 }) ||
      disposition.malformedResponse.attempt !== malformedResponses.length) {
    throw new Error('journaled exhaustion does not match its exact retry history and latest malformed response');
  }
  if (!sameJson(retained.diagnostics, disposition.malformedResponse.diagnostics) ||
      !sameJson(assignment.terminalDiagnostics, disposition.malformedResponse.diagnostics)) {
    throw new Error('journaled exhaustion does not match the latest and terminal Assignment diagnostics');
  }
  const [packetEvidence, malformedEvidence] = await Promise.all([
    readCanonicalFile(path.join(assignmentDirectory, 'prepared-packet.json'), 'prepared exhausted packet'),
    readCanonicalFile(journal.responsePath, 'exhausted Assignment response'),
  ]);
  const packet = validateScenarioPrepare(parseJsonBytes(packetEvidence.bytes, 'prepared exhausted packet'), {
    assignmentId, package: processPackage, repository: assignment.repository,
  });
  if (packet.scenario.reference !== journal.scenario || sha256(packetEvidence.bytes) !== journal.packetDigest ||
      sha256(malformedEvidence.bytes) !== journal.responseDigest) {
    throw new Error('journaled exhausted packet or malformed response bytes differ');
  }
  const malformedResponse = parseJsonBytes(malformedEvidence.bytes, 'exhausted Assignment response');
  if (malformedResponse.contract !== 'mdlm-assignment-response@1' || malformedResponse.assignment !== assignmentId) {
    throw new Error('journaled exhausted response differs from the terminal Assignment');
  }
  return disposition;
}

function exhaustedFromCommandRecord(record, assignmentId, mdlmCommand, repository, timeoutMs) {
  if (!record || !sameJson(record.argv, [mdlmCommand, 'scenario', 'submit', '-', '--json']) ||
      record.cwd !== repository || record.timeoutMs !== timeoutMs || record.timedOut !== false ||
      record.outputLimitExceeded !== false || record.exitStatus !== 1 || record.signal !== null || record.spawnError !== null ||
      typeof record.stdoutBase64 !== 'string' || typeof record.stderrBase64 !== 'string') return null;
  const stdout = Buffer.from(record.stdoutBase64, 'base64');
  const stderr = Buffer.from(record.stderrBase64, 'base64');
  if (stdout.toString('base64') !== record.stdoutBase64 || stderr.toString('base64') !== record.stderrBase64 ||
      sha256(stdout) !== record.stdoutSha256 || sha256(stderr) !== record.stderrSha256 || stderr.length !== 0 ||
      record.observedOutputBytes !== stdout.length) return null;
  let disposition;
  try { disposition = parseJsonBytes(stdout, 'journaled scenario submit exhausted disposition'); }
  catch { return null; }
  return isExhaustedAssignmentDisposition(disposition, assignmentId) ? disposition : null;
}

async function bindCorrectionInput(journal, requested, lifecycleRepository) {
  const evidence = await readCanonicalFile(requested.responsePath, 'corrected Assignment response');
  const digest = sha256(evidence.bytes);
  if (evidence.path !== requested.responsePath || digest !== requested.digest || digest === journal.responseDigest) {
    throw new Error('corrected Assignment response path or digest differs from its public pin or replays the malformed response');
  }
  const response = parseJsonBytes(evidence.bytes, 'corrected Assignment response');
  if (response.contract !== 'mdlm-assignment-response@1' || response.assignment !== journal.assignmentId) {
    throw new Error('corrected Assignment response contract or Assignment differs');
  }
  const correctionInput = {
    contract: 'mdlm-demo-correction-input@1', assignmentId: journal.assignmentId, scenario: journal.scenario,
    package: journal.package, repository: journal.repository, lifecycleRepository, packetDigest: journal.packetDigest,
    path: evidence.path, digest,
    bytes: evidence.bytes.length, bytesBase64: evidence.bytes.toString('base64'),
  };
  return {
    bytes: evidence.bytes,
    journal: {
      ...journal, phase: 'correction-bound', originalResponse: { path: journal.responsePath, digest: journal.responseDigest },
      responsePath: evidence.path, responseDigest: digest, correctionInput, correctionBoundAt: new Date().toISOString(),
    },
  };
}

async function authenticateBoundCorrectionInput(journal, requested, lifecycleRepository) {
  const input = journal.correctionInput;
  const inputKeys = [
    'assignmentId', 'bytes', 'bytesBase64', 'contract', 'digest', 'lifecycleRepository', 'package',
    'packetDigest', 'path', 'repository', 'scenario',
  ];
  if (!input || !sameJson(Object.keys(input).sort(), inputKeys) || input.contract !== 'mdlm-demo-correction-input@1' ||
      input.assignmentId !== journal.assignmentId || input.scenario !== journal.scenario ||
      !sameProcessPackageIdentity(input.package, journal.package) || !sameJson(input.repository, journal.repository) ||
      input.lifecycleRepository !== lifecycleRepository || input.packetDigest !== journal.packetDigest ||
      input.path !== journal.responsePath || input.digest !== journal.responseDigest ||
      input.path !== requested.responsePath || input.digest !== requested.digest || !Number.isSafeInteger(input.bytes) || input.bytes < 1 ||
      typeof input.bytesBase64 !== 'string' || input.digest === journal.originalResponse?.digest) {
    throw new Error('bound correction input differs from its Assignment, Scenario, package, repository, or public pin');
  }
  const boundBytes = Buffer.from(input.bytesBase64, 'base64');
  if (boundBytes.toString('base64') !== input.bytesBase64 || boundBytes.length !== input.bytes || sha256(boundBytes) !== input.digest) {
    throw new Error('bound correction input bytes differ from their durable digest');
  }
  const evidence = await readCanonicalFile(input.path, 'bound corrected Assignment response');
  if (!evidence.bytes.equals(boundBytes)) throw new Error('bound corrected Assignment response path has drifted');
  const response = parseJsonBytes(boundBytes, 'bound corrected Assignment response');
  if (response.contract !== 'mdlm-assignment-response@1' || response.assignment !== journal.assignmentId) {
    throw new Error('bound corrected Assignment response contract or Assignment differs');
  }
  return boundBytes;
}

async function beginPublicationClosure({
  request, context, assignmentDirectory, journalPath, snapshotResult, processPackage, runIdentity,
  completedJournal, recoveredPublication,
}) {
  const closurePath = path.join(assignmentDirectory, 'publication-closure.json');
  const acceptedTrackedState = sha256(Buffer.from(`${completedJournal.commit}\0staged\0\0worktree\0`));
  const closure = {
    contract: 'mdlm-demo-publication-closure@1', phase: 'accepted', assignmentId: completedJournal.assignmentId,
    scenario: completedJournal.scenario, executionId: completedJournal.executionId, acceptedCommit: completedJournal.commit,
    acceptedRepository: { head: completedJournal.commit, trackedState: acceptedTrackedState },
    package: normalizeProcessPackage(processPackage), runIdentity, recoveredPublication,
    materializedExecutions: [], publications: [], publishedCount: 0,
  };
  await durableCreateJson(closurePath, closure, 'publication-closure-accepted');
  return continuePublicationClosure({
    request, context, assignmentDirectory, journalPath, closurePath, closure,
    snapshotResult, processPackage: closure.package, runIdentity, resumed: false,
  });
}

async function continuePublicationClosure({
  request, context, assignmentDirectory, journalPath, closurePath, closure, snapshotResult, processPackage, runIdentity, resumed,
}) {
  requirePublicationClosure(closure, request.assignmentId, processPackage, runIdentity);
  const acceptedTransaction = await optionalCanonicalJson(journalPath);
  if (acceptedTransaction?.contract !== 'mdlm-demo-transaction-journal@2' ||
      acceptedTransaction.phase !== 'completed' || acceptedTransaction.assignmentId !== closure.assignmentId ||
      acceptedTransaction.executionId !== closure.executionId || acceptedTransaction.commit !== closure.acceptedCommit ||
      acceptedTransaction.trustedRepositoryAdvance !== true ||
      !sameProcessPackageIdentity(acceptedTransaction.package, closure.package)) {
    throw new Error('accepted external transaction differs from the publication closure');
  }

  if (closure.phase === 'accepted') {
    closure = await startClosureCommand(closurePath, closure, 'materialized-next-started', 1, assignmentDirectory);
    await invokeClosureCommand(closure.commandEvidencePrefix, request.commands.mdlm, ['next', '--json'], context.repository, request.timeoutMs);
  }
  if (closure.phase === 'materialized-next-started') {
    const next = await authenticatedClosureNext(closure, request, context, 1);
    if (next.materializedExecutions.length === 0) {
      closure = { ...closure, phase: 'no-materializations', firstNextAssignment: next.assignment.id };
      await writeJournal(closurePath, closure);
    } else {
      const publications = [];
      for (const execution of next.materializedExecutions) {
        const publication = await publicationFromMaterializedExecution(context.repository, execution);
        publication.blobs = await captureBlobs(context.repository, publication.outputPaths, request.timeoutMs, assignmentDirectory);
        publications.push(publication);
      }
      const changed = await repositoryChangedPaths(context.repository, request.timeoutMs, assignmentDirectory);
      const staleLeaseRelativePath = '.lifecycle/work/active-assignment.json';
      const expected = publications.flatMap(item => item.outputPaths).sort();
      if (!sameJson(changed, expected)) throw new Error('working tree does not contain exactly the ordered materialized transactions');
      const staleLeasePath = path.join(context.repository, ...staleLeaseRelativePath.split('/'));
      const staleLeaseEvidence = await readCanonicalFile(staleLeasePath, 'stale Assignment lease');
      let staleLease;
      try { staleLease = JSON.parse(staleLeaseEvidence.bytes.toString('utf8')); }
      catch { throw new Error('stale Assignment lease is not valid JSON'); }
      if (staleLease.contract !== 'mdlm-assignment-lease@1' || staleLease.id !== next.assignment.id ||
          staleLease.disposition !== 'active' || !sameProcessPackageIdentity(staleLease.package, closure.package) ||
          !sameJson(staleLease.repository, closure.acceptedRepository)) {
        throw new Error('materializing next did not allocate the exact stale pre-publication lease');
      }
      closure = {
        ...closure, phase: 'publishing', firstNextAssignment: next.assignment.id,
        materializedExecutions: next.materializedExecutions,
        publications, staleLease: { path: staleLeasePath, digest: sha256(staleLeaseEvidence.bytes), bytesBase64: staleLeaseEvidence.bytes.toString('base64') },
      };
      await writeJournal(closurePath, closure);
    }
  }
  if (closure.phase === 'no-materializations') {
    return publicationClosureResult(snapshotResult, closure, null, resumed);
  }

  while (closure.phase === 'publishing' && closure.publishedCount < closure.publications.length) {
    const publication = closure.publications[closure.publishedCount];
    const baseCommit = closure.publishedCount === 0
      ? closure.acceptedCommit
      : closure.publications[closure.publishedCount - 1].commit;
    const remainingPaths = closure.publications.slice(closure.publishedCount).flatMap(item => item.outputPaths).sort();
    const commit = await commitPublication(
      context.repository, publication, baseCommit, request.timeoutMs, assignmentDirectory,
      { expectedWorktreePaths: remainingPaths, crashPhase: 'materialized-publication' },
    );
    const publications = closure.publications.map((item, index) => index === closure.publishedCount ? { ...item, commit } : item);
    closure = { ...closure, publications, publishedCount: closure.publishedCount + 1 };
    await writeJournal(closurePath, closure);
  }
  if (closure.phase === 'publishing' && closure.publishedCount === closure.publications.length) {
    closure = { ...closure, phase: 'retiring-stale-lease', finalCommit: closure.publications.at(-1).commit };
    await writeJournal(closurePath, closure);
  }
  if (closure.phase === 'retiring-stale-lease') {
    await retireExactStaleLease(closure.staleLease);
    closure = { ...closure, phase: 'stale-lease-retired' };
    await writeJournal(closurePath, closure);
  }
  if (closure.phase === 'stale-lease-retired') {
    closure = await startClosureCommand(closurePath, closure, 'final-next-started', 2, assignmentDirectory);
    await invokeClosureCommand(closure.commandEvidencePrefix, request.commands.mdlm, ['next', '--json'], context.repository, request.timeoutMs);
  }
  if (closure.phase === 'final-next-started') {
    const next = await authenticatedClosureNext(closure, request, context, 2);
    if (next.materializedExecutions.length !== 0) throw new Error('final next unexpectedly materialized more package-authored executions');
    closure = { ...closure, phase: 'completed', finalAssignment: next.assignment.id };
    await writeJournal(closurePath, closure);
  }
  if (closure.phase !== 'completed') throw new Error(`unsupported publication closure phase '${closure.phase}'`);
  return publicationClosureResult(snapshotResult, closure, closure.finalAssignment, resumed);
}

function requirePublicationClosure(closure, assignmentId, processPackage, runIdentity) {
  if (!closure || closure.contract !== 'mdlm-demo-publication-closure@1' || closure.assignmentId !== assignmentId ||
      !executionIdPattern.test(closure.executionId ?? '') || !/^[0-9a-f]{40,64}$/.test(closure.acceptedCommit ?? '') ||
      !externalScenarios.has(closure.scenario) || !sameProcessPackageIdentity(closure.package, processPackage) ||
      !sameJson(closure.runIdentity, runIdentity) || !Array.isArray(closure.publications) ||
      !Array.isArray(closure.materializedExecutions) || !Number.isSafeInteger(closure.publishedCount)) {
    throw new Error('publication closure journal is malformed or belongs to another accepted response');
  }
}

async function startClosureCommand(closurePath, closure, phase, index, assignmentDirectory) {
  const commandDirectory = path.join(assignmentDirectory, 'publication-closure-command-evidence');
  const prefix = path.join(commandDirectory, `command-${String(index).padStart(6, '0')}`);
  const updated = { ...closure, phase, commandEvidencePrefix: prefix };
  await writeJournal(closurePath, updated);
  return updated;
}

async function invokeClosureCommand(prefix, program, args, cwd, timeoutMs) {
  const existing = await Promise.all(['json', 'stdout', 'stderr'].map(extension => optionalLstat(`${prefix}.${extension}`)));
  if (existing.some(value => value !== null)) throw new Error('publication closure command evidence already exists or is incomplete');
  await mkdir(path.dirname(prefix), { recursive: true, mode: 0o700 });
  await syncDirectory(path.dirname(prefix));
  const output = await runProcess(program, args, { cwd, timeoutMs, env: controlledEnvironment() });
  await writeExclusiveSynced(`${prefix}.stdout`, output.stdout);
  await writeExclusiveSynced(`${prefix}.stderr`, output.stderr);
  await writeExclusiveSynced(`${prefix}.json`, Buffer.from(`${JSON.stringify(commandRecord(output), null, 2)}\n`));
  await syncDirectory(path.dirname(prefix));
}

async function writeExclusiveSynced(file, bytes) {
  const handle = await open(file, 'wx', 0o400);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

async function authenticatedClosureNext(closure, request, context, index) {
  let stored;
  try { stored = await authenticateStoredCommand(path.dirname(closure.commandEvidencePrefix), String(index).padStart(6, '0')); }
  catch (error) { throw new Error(`publication closure next is uncertain and will not be replayed: ${error instanceof Error ? error.message : String(error)}`); }
  requireStoredProcess(stored.record, [request.commands.mdlm, 'next', '--json'], context.repository, request.timeoutMs, 0);
  if (stored.stderr.length !== 0) throw new Error('publication closure next wrote stderr');
  let next;
  try { next = JSON.parse(stored.stdout.toString('utf8')); }
  catch { throw new Error('publication closure next stdout is not valid JSON'); }
  const keys = ['assignment', 'command', 'contract', 'diagnostics', 'materializedExecutions', 'ok', 'outcome', 'package', 'phase'];
  if (!next || !sameJson(Object.keys(next).sort(), keys) || next.contract !== 'mdlm-next@1' || next.command !== 'next' ||
      next.ok !== true || next.outcome !== 'assignment' || !sameProcessPackageIdentity(next.package, closure.package) ||
      typeof next.phase !== 'string' || next.phase.length === 0 || !next.assignment ||
      !sameJson(Object.keys(next.assignment).sort(), ['id']) || !executionIdPattern.test(next.assignment.id ?? '') ||
      !Array.isArray(next.diagnostics) || next.diagnostics.length !== 0 || !Array.isArray(next.materializedExecutions)) {
    throw new Error('publication closure next did not return one exact Assignment outcome');
  }
  const ids = new Set();
  for (const execution of next.materializedExecutions) {
    if (!execution || !sameJson(Object.keys(execution).sort(), ['id', 'scenario', 'status']) ||
        !executionIdPattern.test(execution.id ?? '') || !/^.+@[1-9][0-9]*$/.test(execution.scenario ?? '') ||
        execution.status !== 'completed' || ids.has(execution.id)) {
      throw new Error('publication closure next returned a malformed or duplicate materialized execution');
    }
    ids.add(execution.id);
  }
  return next;
}

async function publicationFromMaterializedExecution(repository, expected) {
  const executionPath = `.lifecycle/data/.transactions/${expected.id}/execution.json`;
  const evidence = await readCanonicalFile(path.join(repository, ...executionPath.split('/')), 'materialized execution');
  let execution;
  try { execution = JSON.parse(evidence.bytes.toString('utf8')); }
  catch { throw new Error('materialized execution record is not valid JSON'); }
  const paths = execution?.outputs?.map(item => item?.lifecycleDatum?.path);
  if (execution.contract !== 'mdlm-scenario-execution@4' || execution.id !== expected.id || execution.status !== 'completed' ||
      execution.definition?.scenario !== expected.scenario || execution.response?.contract !== 'mdlm-assignment-response@1' ||
      typeof execution.response.assignment !== 'string' || !Array.isArray(paths) || paths.length === 0 ||
      paths.some(value => typeof value !== 'string')) {
    throw new Error('materialized execution does not match the exact completed next result');
  }
  return {
    executionId: expected.id, scenario: expected.scenario,
    outputPaths: await canonicalPublicationPaths(repository, expected.id, [executionPath, ...paths]),
  };
}

async function repositoryChangedPaths(repository, timeoutMs, assignmentDirectory) {
  const status = await invoke(assignmentDirectory, 'git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], repository, timeoutMs);
  if (!commandSucceeded(status)) throw new Error('repository status cannot authenticate materialized publications');
  return porcelainPaths(status.stdout).sort();
}

async function retireExactStaleLease(evidence) {
  const observed = await optionalLstat(evidence.path);
  if (observed === null) return;
  const current = await readCanonicalFile(evidence.path, 'stale Assignment lease');
  if (sha256(current.bytes) !== evidence.digest || current.bytes.toString('base64') !== evidence.bytesBase64) {
    throw new Error('stale Assignment lease changed before retirement');
  }
  await rm(evidence.path);
  await syncDirectory(path.dirname(evidence.path));
}

function publicationClosureResult(snapshotResult, closure, finalAssignment, resumed) {
  const output = result(resumed ? 'already-completed' : 'completed', snapshotResult, {
    assignmentId: closure.assignmentId, executionId: closure.executionId, commit: closure.acceptedCommit,
    ...(closure.recoveredPublication ? { recoveredPublication: true } : {}),
    outcome: 'accepted-publication', trustedRepositoryAdvance: true,
    ...(closure.phase === 'no-materializations' ? {} : {
      publicationClosure: {
        status: 'completed',
        executions: closure.publications.map(item => ({ id: item.executionId, scenario: item.scenario, commit: item.commit })),
      },
    }),
  });
  if (finalAssignment !== null) output[publicationClosureEvidence] = { assignmentId: finalAssignment, closure };
  return output;
}

async function finalizePublicationClosure(output, postSnapshot) {
  const evidence = output[publicationClosureEvidence];
  if (evidence === undefined) return output;
  delete output[publicationClosureEvidence];
  try {
    if (postSnapshot.status !== 'complete') throw new Error('publication closure post-run snapshot is incomplete');
    const captured = JSON.parse(await readFile(path.join(postSnapshot.snapshotDirectory, 'snapshot.json'), 'utf8'));
    const closure = evidence.closure;
    if (captured.lifecycleRepository?.clean !== true || captured.lifecycleRepository.head !== closure.finalCommit ||
        captured.diagnosis?.ok !== true || !sameProcessPackageIdentity(captured.status?.package, closure.package) ||
        !sameProcessPackageIdentity(captured.diagnosis?.package, closure.package) ||
        !statusHasActiveAssignment(captured.status, evidence.assignmentId) || captured.assignment?.id !== evidence.assignmentId ||
        captured.assignment.selected !== true || captured.assignment.disposition !== 'active' ||
        !sameProcessPackageIdentity(captured.assignment.package, closure.package) ||
        !sameJson(captured.assignment.repository, captured.assignmentRepository) ||
        !sameRepositoryFingerprint(captured.assignmentRepository, captured.lifecycleRepository)) {
      throw new Error('final next Assignment is not bound to the final clean publication commit');
    }
    output.nextAssignment = { id: evidence.assignmentId, scenario: captured.assignment.scenarioReference, phase: 'pre-submission' };
    return output;
  } catch (error) {
    output.status = 'stopped';
    output.recoverable = false;
    output.reason = 'publication-closure-checkpoint-failure';
    output.detail = error instanceof Error ? error.message : String(error);
    output.trustedRepositoryAdvance = false;
    delete output.nextAssignment;
    return output;
  }
}

async function runPiAssignment(request, context, assignmentDirectory, assignment, status, snapshotResult, operationalRecoveryTransition = null) {
  const assignmentId = assignment.id;
  const outcome = status.currentOutcome;
  const attended = outcome.outcome === 'attention-required' &&
    outcome.assignment?.allocation === 'active' && outcome.assignment.id === assignmentId &&
    outcome.authorityRequirement?.mode === 'attended';
  const decision = attended ? selectedDecision(request[boundDecisionCatalog], assignmentId) : null;
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
  const decisionInput = decision === null ? undefined : Buffer.from(`${decision.wording}\n`);
  const processResult = await invokeDurableAssignmentCommand({
    assignmentDirectory,
    program: request.commands.mdlmPi,
    args,
    cwd: context.repository,
    timeoutMs: request.timeoutMs,
    input: decisionInput,
    env: environment,
    context: {
      assignment,
      decisionEvidence: decision?.evidence ?? null,
      decisionInputBase64: decisionInput?.toString('base64') ?? null,
      initialSnapshot: snapshotResult,
      privateEvidenceBefore,
      shimDirectory,
      ...(operationalRecoveryTransition === null ? {} : { operationalRecoveryTransition }),
    },
  });
  return interpretPiAssignmentResult({
    request, context, assignment, status, snapshotResult, processResult,
    decisionEvidence: decision?.evidence ?? null, privateEvidenceBefore, shimDirectory,
  });
}

async function interpretPiAssignmentResult({ request, context, assignment, status, snapshotResult, processResult, decisionEvidence, privateEvidenceBefore, shimDirectory }) {
  const assignmentId = assignment.id;
  const decoded = decodeMdlmPiResult(processResult, expectedOperationalStdout(assignment, status));
  const common = {
    assignmentId,
    process: commandRecord(processResult),
    mdlmPi: decoded,
    durableResultRepository: processResult[durableResultRepository],
    [durableResultRepository]: processResult[durableResultRepository],
    ...(decisionEvidence === null ? {} : { decision: decisionEvidence }),
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

function durableCommandAttempt(protocolDirectory, index) {
  const directory = index === 1 ? protocolDirectory : path.join(protocolDirectory, `attempt-${String(index).padStart(6, '0')}`);
  return {
    index, directory,
    authorizationPath: path.join(directory, 'authorization.json'),
    resultPath: path.join(directory, 'result.json'),
    consumptionPath: path.join(directory, 'consumption.json'),
  };
}

async function latestDurableCommandAttempt(protocolDirectory) {
  let entries;
  try {
    await requireCanonicalDirectory(protocolDirectory);
    await recoverPendingDurableCommandWrites(protocolDirectory);
    entries = await readdir(protocolDirectory);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const supportedRootEntry = /^(?:authorization|result|consumption)\.json$|^attempt-[0-9]{6}$/;
  if (entries.some(name => !supportedRootEntry.test(name))) throw new Error('durable command directory contains an unsupported entry');
  const rootAuthorization = await optionalCanonicalJson(path.join(protocolDirectory, 'authorization.json'));
  const retryIndexes = entries.map(name => /^attempt-([0-9]{6})$/.exec(name)).filter(Boolean).map(match => Number(match[1])).sort((a, b) => a - b);
  if (rootAuthorization === null) {
    if (retryIndexes.length !== 0) throw new Error('durable command retry exists without its first authorization');
    return null;
  }
  for (let offset = 0; offset < retryIndexes.length; offset++) {
    if (retryIndexes[offset] !== offset + 2) throw new Error('durable command attempts are missing or ambiguous');
    const retryDirectory = durableCommandAttempt(protocolDirectory, retryIndexes[offset]).directory;
    await requireCanonicalDirectory(retryDirectory);
    await recoverPendingDurableCommandWrites(retryDirectory);
    const retryEntries = await readdir(retryDirectory);
    if (retryEntries.some(name => !/^(?:authorization|result|consumption)\.json$/.test(name))) {
      throw new Error('durable command attempt contains an unsupported entry');
    }
  }
  const latestIndex = retryIndexes.at(-1) ?? 1;
  for (let index = 1; index < latestIndex; index++) {
    if (!await durableCommandConsumed(durableCommandAttempt(protocolDirectory, index), path.dirname(protocolDirectory))) {
      throw new Error('an earlier durable command attempt is incomplete or unconsumed');
    }
  }
  return durableCommandAttempt(protocolDirectory, latestIndex);
}

async function recordDurableCommandConsumption(assignmentDirectory, output, postRunSnapshot) {
  if (postRunSnapshot.status !== 'complete' || !output.process) return;
  const protocolDirectory = path.join(assignmentDirectory, 'durable-command');
  const attempt = await latestDurableCommandAttempt(protocolDirectory);
  if (attempt === null) return;
  if (await durableCommandConsumed(attempt, assignmentDirectory)) return;
  const authenticated = await authenticateDurableCommandAttempt(attempt, assignmentDirectory);
  if (!sameJson(commandRecord(authenticated.processResult), output.process)) {
    throw new Error('durable command output process differs from its authenticated result');
  }
  if (!sameJson(output.postRunSnapshot, postRunSnapshot)) {
    throw new Error('durable command output names a different post-run snapshot');
  }
  const verifiedSnapshot = await verifySnapshot(postRunSnapshot.snapshotDirectory, postRunSnapshot.digest, true);
  await requireDurableConsumptionBoundary(
    authenticated.authorization, authenticated.processResult, output, verifiedSnapshot.snapshot, assignmentDirectory,
  );
  const manifestEvidence = await immutableFileEvidence(path.join(postRunSnapshot.snapshotDirectory, 'manifest.json'));
  if (manifestEvidence.digest !== postRunSnapshot.digest) {
    throw new Error('durable command post-run snapshot digest differs from its manifest');
  }
  const retainedOutput = JSON.parse(JSON.stringify(output));
  await durableCreateJson(attempt.consumptionPath, {
    contract: 'mdlm-demo-command-consumption@1',
    result: { path: authenticated.resultEvidence.path, digest: authenticated.resultEvidence.digest },
    orchestration: {
      output: retainedOutput,
      outputDigest: sha256(Buffer.from(JSON.stringify(retainedOutput))),
      postRunManifest: { path: manifestEvidence.path, digest: manifestEvidence.digest },
    },
  }, 'durable-command-consumption');
}

async function durableCommandConsumed(attempt, assignmentDirectory) {
  const consumption = await optionalCanonicalJson(attempt.consumptionPath);
  if (consumption === null) return false;
  if (consumption.contract !== 'mdlm-demo-command-consumption@1' ||
      !sameJson(Object.keys(consumption).sort(), ['contract', 'orchestration', 'result']) ||
      !sameJson(Object.keys(consumption.orchestration ?? {}).sort(), ['output', 'outputDigest', 'postRunManifest'])) {
    throw new Error('durable command consumption is malformed');
  }
  const authenticated = await authenticateDurableCommandAttempt(attempt, assignmentDirectory);
  if (!sameJson(consumption.result, { path: authenticated.resultEvidence.path, digest: authenticated.resultEvidence.digest }) ||
      consumption.orchestration.outputDigest !== sha256(Buffer.from(JSON.stringify(consumption.orchestration.output)))) {
    throw new Error('durable command consumption differs from its result or output');
  }
  const output = consumption.orchestration.output;
  if (!sameJson(output?.process, commandRecord(authenticated.processResult)) ||
      output?.postRunSnapshot?.status !== 'complete' ||
      !/^sha256:[0-9a-f]{64}$/.test(output.postRunSnapshot.digest ?? '')) {
    throw new Error('durable command consumption does not bind the authenticated process and complete snapshot');
  }
  const verifiedSnapshot = await verifySnapshot(
    output.postRunSnapshot.snapshotDirectory, output.postRunSnapshot.digest, true,
  );
  await requireDurableConsumptionBoundary(
    authenticated.authorization, authenticated.processResult, output, verifiedSnapshot.snapshot, assignmentDirectory,
  );
  const manifestPath = path.join(output.postRunSnapshot.snapshotDirectory, 'manifest.json');
  const manifestEvidence = await immutableFileEvidence(manifestPath);
  if (manifestEvidence.digest !== output.postRunSnapshot.digest ||
      !sameJson(consumption.orchestration.postRunManifest, { path: manifestEvidence.path, digest: manifestEvidence.digest })) {
    throw new Error('durable command consumption differs from its post-run snapshot');
  }
  return output;
}

async function requireDurableConsumptionBoundary(authorization, processResult, output, snapshot, assignmentDirectory) {
  const assignment = authorization.context.assignment;
  const processPackage = normalizeProcessPackage(assignment.package, 'durable command Process Package');
  const authorizedInitial = await authenticateDurableInitialSnapshot(authorization);
  const decoded = decodeMdlmPiResult(
    processResult,
    expectedOperationalStdout(assignment, authorizedInitial.snapshot.status),
  );
  requireResultDerivedDisposition(decoded, output);
  const failedCheckpoint = output.reason === 'assignment-checkpoint-authentication-failure' &&
    output.trustedRepositoryAdvance === false && output.nextAssignment === undefined &&
    decoded.kind === 'reserved-stop' && decoded.stop.assignment === snapshot.assignment?.id;
  if (!sameJson(output.mdlmPi, decoded) || snapshot.postRun !== true ||
      !Number.isFinite(Date.parse(snapshot.createdAt)) || Date.parse(snapshot.createdAt) < Date.parse(processResult.completedAt) ||
      !sameJson(output.durableResultRepository, processResult[durableResultRepository]) ||
      !sameJson(processResult[durableResultRepository], snapshot.lifecycleRepository) ||
      snapshot.repository !== authorization.command.cwd || output.assignmentId !== assignment.id ||
      !sameProcessPackageIdentity(processPackage, snapshot.status?.package) ||
      !sameProcessPackageIdentity(processPackage, snapshot.diagnosis?.package) ||
      (snapshot.assignment?.selected === true && !sameProcessPackageIdentity(processPackage, snapshot.assignment.package))) {
    throw new Error('durable command consumption snapshot repository, Assignment, or Process Package differs from its authorization');
  }
  if (output.nextAssignment !== undefined) {
    if (snapshot.assignment?.selected !== true || snapshot.assignment.id !== output.nextAssignment.id ||
        !statusHasActiveAssignment(snapshot.status, output.nextAssignment.id)) {
      throw new Error('durable command consumption snapshot differs from its authenticated next Assignment');
    }
  } else if (snapshot.assignment?.id !== assignment.id && !failedCheckpoint) {
    throw new Error('durable command consumption snapshot names an unrelated Assignment');
  }
  if (output.trustedRepositoryAdvance === true) {
    const transaction = await optionalCanonicalJson(path.join(assignmentDirectory, 'transaction.json'));
    if (transaction?.phase !== 'completed' || transaction.assignmentId !== assignment.id ||
        transaction.trustedRepositoryAdvance !== true || transaction.outcome !== (output.outcome ?? null) ||
        !sameJson(transaction.completedRepository, snapshot.lifecycleRepository)) {
      throw new Error('durable command consumption snapshot differs from its completed transaction boundary');
    }
  } else if (!failedCheckpoint && !sameRepositoryFingerprint(assignment.repository, snapshot.lifecycleRepository)) {
    throw new Error('untrusted durable command consumption snapshot differs from its authorized repository boundary');
  }
}

function requireResultDerivedDisposition(decoded, output) {
  if (decoded.kind === 'terminal') {
    if (output.status !== (decoded.successful ? 'completed' : 'stopped') ||
        output.reason !== decoded.status || output.outcome !== decoded.status ||
        output.recoverable !== false || output.trustedRepositoryAdvance !== true) {
      throw new Error('durable command consumption disposition differs from its terminal result');
    }
    return;
  }
  if (decoded.kind === 'interruption') {
    if (output.status !== 'stopped' || output.reason !== decoded.status ||
        output.outcome !== 'operational-interruption' || output.recoverable !== true ||
        output.trustedRepositoryAdvance === true) {
      throw new Error('durable command consumption disposition differs from its interrupted result');
    }
    return;
  }
  if (decoded.kind === 'reserved-stop') {
    const authenticatedAdvance = output.reason === 'reserved-shim-stop' && output.nextAssignment !== undefined;
    const failedCheckpoint = output.reason === 'assignment-checkpoint-authentication-failure';
    const contractFailure = output.reason === 'mdlm-pi-contract-failure';
    if (contractFailure) {
      if (output.status !== 'stopped' || output.recoverable !== false || output.outcome !== undefined ||
          output.nextAssignment !== undefined || output.trustedRepositoryAdvance === true) {
        throw new Error('durable command consumption disposition differs from its rejected reserved-stop result');
      }
      return;
    }
    if ((!authenticatedAdvance && !failedCheckpoint && output.reason !== 'reserved-shim-stop') ||
        output.status !== (authenticatedAdvance ? 'completed' : 'stopped') ||
        output.outcome !== (authenticatedAdvance ? 'accepted-publication' : 'pre-submission-stop') ||
        output.recoverable !== !failedCheckpoint || output.trustedRepositoryAdvance !== authenticatedAdvance) {
      throw new Error('durable command consumption disposition differs from its reserved-stop result');
    }
    return;
  }
  if (decoded.kind === 'correction-session-lost') {
    if (output.status !== 'stopped' || output.reason !== 'correction-session-lost' ||
        output.outcome !== undefined || output.recoverable !== false || output.trustedRepositoryAdvance === true) {
      throw new Error('durable command consumption disposition differs from its lost correction session result');
    }
    return;
  }
  if (decoded.kind === 'operational-failure') {
    const recovery = output.operationalFailureRecovery;
    const verified = recovery?.verified === true;
    if (output.status !== 'stopped' || output.reason !== (verified ? 'pre-submission-operational-failure' : 'mdlm-pi-operational-failure') ||
        output.outcome !== (verified ? 'pre-submission-operational-failure' : undefined) ||
        output.recoverable !== verified || output.trustedRepositoryAdvance === true ||
        !recovery || (verified
          ? recovery.assignmentId !== output.assignmentId || !['run', 'resume'].includes(recovery.retryCommand) ||
            recovery.resumeAllowed !== (recovery.retryCommand === 'resume') || !recovery.marker
          : recovery.verified !== false || typeof recovery.uncertainty !== 'string' || recovery.uncertainty.length === 0)) {
      throw new Error('durable command consumption disposition differs from its operational failure result');
    }
    return;
  }
  if (decoded.kind === 'failure') {
    if (output.status !== 'stopped' || output.reason !== 'mdlm-pi-contract-failure' ||
        output.outcome !== undefined || output.recoverable !== false || output.trustedRepositoryAdvance === true) {
      throw new Error('durable command consumption disposition differs from its command contract failure');
    }
    return;
  }
  throw new Error('durable command consumption has an unsupported result disposition');
}

async function authenticateDurableCommandAttempt(attempt, assignmentDirectory) {
  const authorization = await optionalCanonicalJson(attempt.authorizationPath);
  if (authorization === null) throw new Error('durable command attempt has no authorization');
  requireStoredDurableAuthorization(authorization, assignmentDirectory);
  await authenticateDurableInitialSnapshot(authorization);
  const authorizationEvidence = await immutableFileEvidence(attempt.authorizationPath);
  const resultDocument = await optionalCanonicalJson(attempt.resultPath);
  if (resultDocument === null) throw new Error('authorized child has no complete durable result');
  const processResult = await authenticateDurableCommandResult(
    authorization, authorizationEvidence, resultDocument, assignmentDirectory,
  );
  const resultEvidence = await immutableFileEvidence(attempt.resultPath);
  return { authorization, authorizationEvidence, resultDocument, resultEvidence, processResult };
}

async function recoverDurableAssignmentCommand({ request, context, assignmentDirectory, snapshotResult, status, diagnosis, mode }) {
  const protocolDirectory = path.join(assignmentDirectory, 'durable-command');
  const attempt = await latestDurableCommandAttempt(protocolDirectory);
  if (attempt === null) return null;
  const consumedOutput = await durableCommandConsumed(attempt, assignmentDirectory);
  if (consumedOutput !== false) {
    if (consumedOutput.recoverable === false && consumedOutput.trustedRepositoryAdvance !== true) {
      if (consumedOutput.reason === 'correction-session-lost') {
        return stopped(
          'correction-session-unresumable',
          'the consumed durable result records a lost correction session that cannot be restarted',
          snapshotResult,
          request.assignmentId,
        );
      }
      return consumedOutput;
    }
    if (consumedOutput.trustedRepositoryAdvance === true) return authenticatedCompletedDurableCommand;
    return null;
  }
  const authorizationPath = attempt.authorizationPath;
  const authorization = await optionalCanonicalJson(authorizationPath);
  if (authorization?.contract !== 'mdlm-demo-command-authorization@1' || authorization.purpose !== 'assignment-worker' ||
      !sameJson(Object.keys(authorization).sort(), ['command', 'compatibilityEvidence', 'context', 'contract', 'createdAt', 'purpose'])) {
    throw new Error('durable command authorization is malformed');
  }
  const assignment = authorization.context?.assignment;
  if (assignment?.id !== request.assignmentId) throw new Error('durable command belongs to another Assignment');
  const processPackage = normalizeProcessPackage(assignment.package, 'durable command Process Package');
  if (!sameProcessPackageIdentity(processPackage, status.package) ||
      !sameProcessPackageIdentity(processPackage, diagnosis.package)) {
    throw new Error('status or doctor Process Package differs from the durable command');
  }
  const identity = await optionalCanonicalJson(path.join(assignmentDirectory, 'identity.json'));
  if (identity?.assignmentId !== assignment.id || !sameJson(identity.assignmentRepository, assignment.repository)) {
    throw new Error('Assignment identity differs from the durable command context');
  }
  const expectedShimDirectory = path.join(assignmentDirectory, 'shim');
  if (authorization.context.shimDirectory !== expectedShimDirectory ||
      !sameJson(Object.keys(authorization.context).sort(), durableAuthorizationContextKeys(authorization.context)) ||
      !validOperationalRecoveryTransition(authorization.context.operationalRecoveryTransition)) {
    throw new Error('durable command orchestration context is malformed');
  }
  const args = [
    'run', context.repository, '--mdlm', mdlmShim,
    '--provider', request.operator.provider, '--model', request.operator.model, '--thinking', request.operator.thinking,
  ];
  const environment = controlledEnvironment({
    MDLM_DEMO_SHIM_CONFIG: path.join(assignmentDirectory, 'shim', 'config.json'),
    MDLM_PI_COMMAND_TIMEOUT_MS: String(request.mdlmPiCommandTimeoutMs),
    MDLM_PI_ASSIGNMENT_TIMEOUT_MS: String(request.mdlmPiAssignmentTimeoutMs),
  });
  const expectedWithoutInput = durableCommandIdentity(
    request.commands.mdlmPi, args, context.repository, request.timeoutMs, undefined, environment,
  );
  if (!sameJson(authorization.command.argv, expectedWithoutInput.argv) ||
      authorization.command.cwd !== expectedWithoutInput.cwd ||
      authorization.command.timeoutMs !== expectedWithoutInput.timeoutMs ||
      !sameJson(authorization.command.environment, expectedWithoutInput.environment)) {
    throw new Error('authorized argv, cwd, timeout, input identity, or environment differs');
  }
  const authorizedInitial = await authenticateDurableInitialSnapshot(authorization);
  const initial = authorizedInitial.snapshot;
  if (initial.repository !== context.repository || initial.assignment?.id !== assignment.id ||
      !sameProcessPackageIdentity(initial.assignment?.package, processPackage)) {
    throw new Error('authorized initial snapshot differs from the current recovery context');
  }
  const captured = JSON.parse(await readFile(path.join(snapshotResult.snapshotDirectory, 'snapshot.json'), 'utf8'));
  const observedIdentity = observedRunIdentity(
    captured.provenance, processPackage, request.operator, request,
  );
  if (!await pinRunIdentity(context.identityDirectory, observedIdentity, mode === 'run')) {
    throw new Error('run identity differs from the durable command recovery boundary');
  }
  const resultDocument = await optionalCanonicalJson(attempt.resultPath);
  if (resultDocument === null) throw new Error('authorized child has no complete durable result; its outcome is uncertain and it will not be spawned again');
  const authorizationEvidence = await immutableFileEvidence(authorizationPath);
  const processResult = await authenticateDurableCommandResult(
    authorization, authorizationEvidence, resultDocument, assignmentDirectory,
  );
  const transitionMode = await authenticatedAuthorizationTransitionMode(
    authorization.context.operationalRecoveryTransition, request.assignmentId,
  );
  if (transitionMode !== null && mode !== transitionMode) {
    return stopped(
      'wrong-recovery-mode',
      `the authorized operational recovery attempt requires '${transitionMode}', not '${mode}'`,
      snapshotResult,
      request.assignmentId,
      { recoverable: true, requiredNextMode: transitionMode },
    );
  }
  return interpretPiAssignmentResult({
    request, context, assignment, status: initial.status,
    snapshotResult: authorization.context.initialSnapshot, processResult,
    decisionEvidence: authorization.context.decisionEvidence,
    privateEvidenceBefore: authorization.context.privateEvidenceBefore,
    shimDirectory: authorization.context.shimDirectory,
  });
}

async function invokeDurableAssignmentCommand({ assignmentDirectory, program, args, cwd, timeoutMs, input, env, context }) {
  const protocolDirectory = path.join(assignmentDirectory, 'durable-command');
  const latestAttempt = await latestDurableCommandAttempt(protocolDirectory);
  const latestConsumed = latestAttempt !== null && await durableCommandConsumed(latestAttempt, assignmentDirectory);
  const attempt = latestAttempt === null ? durableCommandAttempt(protocolDirectory, 1)
    : latestConsumed ? durableCommandAttempt(protocolDirectory, latestAttempt.index + 1) : latestAttempt;
  const { authorizationPath, resultPath } = attempt;
  const command = durableCommandIdentity(program, args, cwd, timeoutMs, input, env);
  let authorization = await optionalCanonicalJson(authorizationPath);
  const newlyAuthorized = authorization === null;
  if (newlyAuthorized) {
    const compatibilityEvidence = await reserveCompatibilityEvidence(assignmentDirectory);
    authorization = {
      contract: 'mdlm-demo-command-authorization@1', purpose: 'assignment-worker', createdAt: new Date().toISOString(),
      command, context, compatibilityEvidence,
    };
    await durableCreateJson(authorizationPath, authorization, 'durable-command-authorization');
  } else {
    requireDurableAuthorization(authorization, command, context, assignmentDirectory);
  }
  const authorizationEvidence = await immutableFileEvidence(authorizationPath);
  let resultDocument = await optionalCanonicalJson(resultPath);
  if (resultDocument === null) {
    if (!newlyAuthorized) throw new Error('authorized child has no complete durable result; its outcome is uncertain and it will not be spawned again');
    const existingAuthorization = await optionalCanonicalJson(authorizationPath);
    if (!sameJson(existingAuthorization, authorization)) throw new Error('durable command authorization changed before spawn');
    const output = await runProcess(program, args, { cwd, timeoutMs, input, env });
    const repository = await captureLifecycleRepository(cwd, timeoutMs);
    resultDocument = {
      contract: 'mdlm-demo-command-result@1',
      authorization: { path: authorizationEvidence.path, digest: authorizationEvidence.digest },
      process: commandRecord(output),
      repository,
    };
    await durableCreateJson(resultPath, resultDocument, 'durable-command-result');
    maybeInjectedCrash('durable-command', 'after-result');
  }
  return authenticateDurableCommandResult(authorization, authorizationEvidence, resultDocument, assignmentDirectory);
}

function durableCommandIdentity(program, args, cwd, timeoutMs, input, env) {
  const inputBytes = input === undefined ? Buffer.alloc(0) : Buffer.from(input);
  const entries = Object.entries(env).sort(([left], [right]) => left.localeCompare(right));
  return {
    argv: [program, ...args], cwd: path.resolve(cwd), timeoutMs,
    input: { present: input !== undefined, bytes: inputBytes.length, digest: sha256(inputBytes) },
    environment: { names: entries.map(([name]) => name), digest: sha256(Buffer.from(JSON.stringify(entries))) },
  };
}

async function reserveCompatibilityEvidence(assignmentDirectory) {
  const directory = path.join(assignmentDirectory, 'command-evidence');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entries = (await readdir(directory)).sort();
  const grouped = new Map();
  for (const name of entries) {
    const match = /^command-([0-9]{6})\.(json|stdout|stderr)$/.exec(name);
    if (match === null) throw new Error('legacy command evidence contains an unsupported entry');
    const extensions = grouped.get(match[1]) ?? [];
    extensions.push(match[2]);
    grouped.set(match[1], extensions);
  }
  let expectedIndex = 1;
  for (const [index, extensions] of grouped) {
    if (Number(index) !== expectedIndex++) throw new Error('legacy command evidence indexes are missing or ambiguous');
    if (!sameJson(extensions.sort(), ['json', 'stderr', 'stdout'])) {
      throw new Error(`legacy command-${index} evidence is incomplete; child outcome is uncertain`);
    }
    await authenticateStoredCommand(directory, index);
  }
  const index = grouped.size + 1;
  const prefix = path.join(directory, `command-${String(index).padStart(6, '0')}`);
  return { index, prefix };
}

function requireDurableAuthorization(authorization, command, context, assignmentDirectory) {
  requireStoredDurableAuthorization(authorization, assignmentDirectory);
  if (!sameJson(authorization.command, command) || !sameJson(authorization.context, context)) {
    throw new Error('durable command authorization differs from the requested invocation');
  }
}

function requireStoredDurableAuthorization(authorization, assignmentDirectory) {
  const command = authorization?.command;
  const compatibility = authorization?.compatibilityEvidence;
  if (authorization?.contract !== 'mdlm-demo-command-authorization@1' || authorization.purpose !== 'assignment-worker' ||
      !sameJson(Object.keys(authorization).sort(), ['command', 'compatibilityEvidence', 'context', 'contract', 'createdAt', 'purpose']) ||
      !Number.isFinite(Date.parse(authorization.createdAt)) ||
      !sameJson(Object.keys(command ?? {}).sort(), ['argv', 'cwd', 'environment', 'input', 'timeoutMs']) ||
      !Array.isArray(command.argv) || command.argv.length === 0 || command.argv.some(value => typeof value !== 'string' || value.length === 0) ||
      typeof command.cwd !== 'string' || !path.isAbsolute(command.cwd) || !Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1 ||
      !sameJson(Object.keys(command.input ?? {}).sort(), ['bytes', 'digest', 'present']) || typeof command.input.present !== 'boolean' ||
      !Number.isSafeInteger(command.input.bytes) || command.input.bytes < 0 || !/^sha256:[0-9a-f]{64}$/.test(command.input.digest ?? '') ||
      !sameJson(Object.keys(command.environment ?? {}).sort(), ['digest', 'names']) || !Array.isArray(command.environment.names) ||
      command.environment.names.some(value => typeof value !== 'string' || value.length === 0) ||
      !sameJson([...command.environment.names].sort(), command.environment.names) || new Set(command.environment.names).size !== command.environment.names.length ||
      !/^sha256:[0-9a-f]{64}$/.test(command.environment.digest ?? '') ||
      !authorization.context || typeof authorization.context !== 'object' || Array.isArray(authorization.context) ||
      !sameJson(Object.keys(authorization.context).sort(), durableAuthorizationContextKeys(authorization.context)) ||
      !validOperationalRecoveryTransition(authorization.context.operationalRecoveryTransition) ||
      !validSnapshotReference(authorization.context.initialSnapshot) ||
      !sameJson(Object.keys(compatibility ?? {}).sort(), ['index', 'prefix']) || !Number.isSafeInteger(compatibility.index) || compatibility.index < 1 ||
      compatibility.prefix !== path.join(assignmentDirectory, 'command-evidence', `command-${String(compatibility.index).padStart(6, '0')}`)) {
    throw new Error('durable command authorization is malformed');
  }
  requireDurableDecisionInput(authorization);
}

function durableAuthorizationContextKeys(context) {
  return [
    'assignment', 'decisionEvidence', 'decisionInputBase64', 'initialSnapshot', 'privateEvidenceBefore', 'shimDirectory',
    ...('operationalRecoveryTransition' in context ? ['operationalRecoveryTransition'] : []),
  ].sort();
}

function validOperationalRecoveryTransition(value) {
  return value === undefined || (value && typeof value === 'object' && !Array.isArray(value) &&
    sameJson(Object.keys(value).sort(), ['digest', 'path']) && path.isAbsolute(value.path) &&
    /^sha256:[0-9a-f]{64}$/.test(value.digest ?? ''));
}

async function authenticatedAuthorizationTransitionMode(reference, assignmentId) {
  if (reference === undefined) return null;
  if (!validOperationalRecoveryTransition(reference)) throw new Error('durable command recovery transition is malformed');
  const evidence = await immutableFileEvidence(reference.path);
  if (evidence.digest !== reference.digest) throw new Error('durable command recovery transition digest differs');
  const document = JSON.parse(evidence.bytes.toString('utf8'));
  if (!document || document.contract !== 'mdlm-demo-operational-failure-retry@1' ||
      document.assignmentId !== assignmentId || !['run', 'resume'].includes(document.mode)) {
    throw new Error('durable command recovery transition document is malformed');
  }
  return document.mode;
}

function validSnapshotReference(reference) {
  return reference?.contract === 'mdlm-demo-snapshot-created@1' && reference.status === 'complete' &&
    sameJson(Object.keys(reference).sort(), ['contract', 'digest', 'snapshotDirectory', 'status']) &&
    typeof reference.snapshotDirectory === 'string' && path.isAbsolute(reference.snapshotDirectory) &&
    /^sha256:[0-9a-f]{64}$/.test(reference.digest ?? '');
}

async function authenticateDurableInitialSnapshot(authorization) {
  const verified = await verifySnapshot(
    authorization.context.initialSnapshot.snapshotDirectory,
    authorization.context.initialSnapshot.digest,
    false,
  );
  const initial = verified.snapshot;
  const assignment = authorization.context.assignment;
  const processPackage = normalizeProcessPackage(assignment?.package, 'durable command initial Process Package');
  if (initial.repository !== authorization.command.cwd || initial.assignment?.id !== assignment?.id ||
      !sameProcessPackageIdentity(initial.status?.package, processPackage) ||
      !sameProcessPackageIdentity(initial.diagnosis?.package, processPackage)) {
    throw new Error('authorized initial snapshot differs from the durable command context');
  }
  return verified;
}

function requireDurableDecisionInput(authorization) {
  const input = authorization.command.input;
  const encoded = authorization.context.decisionInputBase64;
  const evidence = authorization.context.decisionEvidence;
  if (encoded === null) {
    if (evidence !== null || !sameJson(input, {
      present: false, bytes: 0, digest: sha256(Buffer.alloc(0)),
    })) throw new Error('durable command absent input contradicts its decision context');
    return;
  }
  if (typeof encoded !== 'string') throw new Error('durable command decision input is malformed');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded || bytes.length < 1 || bytes.at(-1) !== 0x0a ||
      !sameJson(input, { present: true, bytes: bytes.length, digest: sha256(bytes) }) ||
      !evidence || !sameJson(Object.keys(evidence).sort(), ['authorityBasis', 'digest', 'origin']) ||
      evidence.origin !== 'operator-selected' || typeof evidence.authorityBasis !== 'string' || evidence.authorityBasis.length === 0 ||
      sha256(bytes.subarray(0, -1)) !== evidence.digest) {
    throw new Error('durable command input differs from its operator decision context');
  }
}

async function authenticateDurableCommandResult(authorization, authorizationEvidence, resultDocument, assignmentDirectory) {
  requireStoredDurableAuthorization(authorization, assignmentDirectory);
  if (resultDocument?.contract !== 'mdlm-demo-command-result@1' ||
      !sameJson(Object.keys(resultDocument).sort(), ['authorization', 'contract', 'process', 'repository']) ||
      !sameJson(resultDocument.authorization, { path: authorizationEvidence.path, digest: authorizationEvidence.digest }) ||
      !validLifecycleRepository(resultDocument.repository)) {
    throw new Error('durable command result does not authenticate its exact authorization');
  }
  const record = resultDocument.process;
  const expectedKeys = [
    'argv', 'completedAt', 'cwd', 'exitStatus', 'observedOutputBytes', 'outputLimitExceeded', 'signal',
    'spawnError', 'startedAt', 'stderrBase64', 'stderrSha256', 'stdoutBase64', 'stdoutSha256', 'timedOut', 'timeoutMs',
  ].sort();
  if (!record || !sameJson(Object.keys(record).sort(), expectedKeys)) {
    throw new Error('durable command result process identity or termination is malformed');
  }
  requireCompleteProcessRecord(record, 'durable command result');
  if (!sameJson(record.argv, authorization.command.argv) || record.cwd !== authorization.command.cwd ||
      record.timeoutMs !== authorization.command.timeoutMs) {
    throw new Error('durable command result process identity differs from its authorization');
  }
  const stdout = Buffer.from(record.stdoutBase64, 'base64');
  const stderr = Buffer.from(record.stderrBase64, 'base64');
  if (stdout.toString('base64') !== record.stdoutBase64 || stderr.toString('base64') !== record.stderrBase64 ||
      sha256(stdout) !== record.stdoutSha256 || sha256(stderr) !== record.stderrSha256 ||
      !retainedOutputMatchesObserved(record, stdout, stderr)) {
    throw new Error('durable command result streams differ from their authenticated record');
  }
  const commandEvidence = authorization.compatibilityEvidence;
  await persistCompatibilityEvidence(commandEvidence.prefix, record, stdout, stderr);
  return { ...record, stdout, stderr, commandEvidence, [durableResultRepository]: resultDocument.repository };
}

function validLifecycleRepository(repository) {
  return repository && sameJson(Object.keys(repository).sort(), [
    'clean', 'head', 'porcelainSha256', 'trackedState', 'tree',
  ]) && /^[0-9a-f]{40,64}$/.test(repository.head ?? '') &&
    /^[0-9a-f]{40,64}$/.test(repository.tree ?? '') &&
    /^sha256:[0-9a-f]{64}$/.test(repository.trackedState ?? '') &&
    /^sha256:[0-9a-f]{64}$/.test(repository.porcelainSha256 ?? '') &&
    typeof repository.clean === 'boolean';
}

async function captureLifecycleRepository(repository, timeoutMs) {
  const options = { cwd: repository, timeoutMs, env: gitEnvironment() };
  const [head, tree, status, stagedDiff, worktreeDiff] = await Promise.all([
    runProcess('git', ['rev-parse', 'HEAD^{commit}'], options),
    runProcess('git', ['rev-parse', 'HEAD^{tree}'], options),
    runProcess('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], options),
    runProcess('git', ['diff', '--binary', '--no-ext-diff', '--cached', 'HEAD', '--'], options),
    runProcess('git', ['diff', '--binary', '--no-ext-diff', '--'], options),
  ]);
  if (![head, tree, status, stagedDiff, worktreeDiff].every(commandSucceeded)) {
    throw new Error('repository boundary could not be captured after the durable child result');
  }
  const headIdentity = head.stdout.toString('utf8').trim();
  const treeIdentity = tree.stdout.toString('utf8').trim();
  if (!/^[0-9a-f]{40,64}$/.test(headIdentity) || !/^[0-9a-f]{40,64}$/.test(treeIdentity)) {
    throw new Error('repository boundary returned malformed Git identities after the durable child result');
  }
  const trackedState = sha256(Buffer.from(
    `${headIdentity}\0staged\0${stagedDiff.stdout.toString('utf8')}\0worktree\0${worktreeDiff.stdout.toString('utf8')}`,
  ));
  return {
    head: headIdentity,
    tree: treeIdentity,
    trackedState,
    clean: status.stdout.length === 0,
    porcelainSha256: sha256(status.stdout),
  };
}

async function persistCompatibilityEvidence(prefix, record, stdout, stderr) {
  await writeSyncedOrMatch(`${prefix}.stdout`, stdout);
  await writeSyncedOrMatch(`${prefix}.stderr`, stderr);
  await writeSyncedOrMatch(`${prefix}.json`, Buffer.from(`${JSON.stringify(record, null, 2)}\n`));
  await syncDirectory(path.dirname(prefix));
}

async function writeSyncedOrMatch(file, bytes) {
  const existing = await optionalLstat(file);
  if (existing !== null) {
    const evidence = await readCanonicalEvidenceFile(file);
    if (!evidence.bytes.equals(bytes)) throw new Error('durable command compatibility evidence differs from the complete result');
    return;
  }
  await writeExclusiveSynced(file, bytes);
}

export function decodeMdlmPiResult(processResult, expectedStdout = null) {
  const stdout = trailingJson(processResult.stdout);
  const stderr = trailingJson(processResult.stderr);
  const reserved = processResult.exitStatus === 1 ? findReservedStop(stderr) : null;
  if (reserved !== null) return { kind: 'reserved-stop', status: 'reserved-shim-stop', stop: reserved };
  if (processResult.timedOut || processResult.outputLimitExceeded || processResult.signal !== null || [129, 130, 143].includes(processResult.exitStatus)) {
    const status = processResult.timedOut ? 'mdlm-pi-timeout'
      : processResult.outputLimitExceeded ? 'mdlm-pi-output-limit'
        : 'mdlm-pi-interrupted';
    return { kind: 'interruption', status, document: stdout ?? stderr };
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
  if (isTypedOperationalFailure(processResult, stderr, expectedStdout)) {
    const code = typeof stderr.error === 'object' ? stderr.error.code : 'LEGACY_MDLM_COMMAND_FAILURE';
    return {
      kind: 'operational-failure', status: 'mdlm-pi-operational-failure',
      detail: `mdlm-pi reported authenticated operational failure '${code}'`,
      document: stderr,
    };
  }
  return {
    kind: 'failure', status: 'mdlm-pi-contract-failure',
    detail: document === null ? `mdlm-pi exit ${processResult.exitStatus} did not end with a typed JSON result` : `mdlm-pi exit ${processResult.exitStatus} and result status '${status}' disagree`,
    document,
  };
}

const mdlmPiOperationalFailureContract = 'mdlm-pi-operational-failure@1';
const maximumOperationalProgressBytes = 64 * 1024;

export function operationalFailureHasCompleteAttemptEvidence(document) {
  return document?.contract !== mdlmPiOperationalFailureContract ||
    (document.telemetry?.completeAssignmentObserved === false &&
      document.telemetry.stopReason !== null && document.telemetry.retriesConsumed !== null &&
      document.telemetry.provider !== null && document.telemetry.model !== null &&
      (document.telemetry.providerError === null || document.telemetry.providerError?.truncated === false));
}

export function operationalFailureRetryMode(document) {
  return document?.contract === mdlmPiOperationalFailureContract &&
      document?.error?.code === 'PI_SETTLED_WITHOUT_COMPLETION'
    ? 'resume'
    : 'run';
}
const piStopReasons = new Set(['stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']);

function isTypedOperationalFailure(processResult, stderr, expectedStdout) {
  if (processResult.exitStatus !== 1 || processResult.timedOut || processResult.signal !== null ||
      processResult.outputLimitExceeded || processResult.spawnError !== null ||
      !isRecognizedOperationalStdout(processResult.stdout, expectedStdout) ||
      stderr?.contract !== mdlmPiOperationalFailureContract || stderr.status !== 'operational-failure') return false;
  if (!sameJson(Object.keys(stderr).sort(), ['contract', 'error', 'status', 'telemetry']) ||
      !sameJson(Object.keys(stderr.error ?? {}).sort(), ['code', 'message']) ||
      !sameJson(Object.keys(stderr.telemetry ?? {}).sort(), [
        'completeAssignmentObserved', 'model', 'provider', 'providerError', 'retriesConsumed', 'stopReason',
      ])) return false;
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(stderr.error.code ?? '') ||
      !isBoundedText(stderr.error.message, 1, 256) ||
      containsSecretLookingText(stderr.error.message) ||
      containsSecretLookingText(processResult.stdout.toString('utf8')) ||
      !isNullableIdentity(stderr.telemetry.provider) || !isNullableIdentity(stderr.telemetry.model) ||
      !(stderr.telemetry.stopReason === null || piStopReasons.has(stderr.telemetry.stopReason)) ||
      !(stderr.telemetry.retriesConsumed === null ||
        (Number.isSafeInteger(stderr.telemetry.retriesConsumed) && stderr.telemetry.retriesConsumed >= 0 && stderr.telemetry.retriesConsumed <= 100)) ||
      !(stderr.telemetry.completeAssignmentObserved === null ||
        typeof stderr.telemetry.completeAssignmentObserved === 'boolean') ||
      (stderr.error.code === 'PI_SETTLED_WITHOUT_COMPLETION' && stderr.telemetry.completeAssignmentObserved !== false) ||
      !matchesCommandIdentity(processResult.argv, '--provider', stderr.telemetry.provider) ||
      !matchesCommandIdentity(processResult.argv, '--model', stderr.telemetry.model) ||
      !isRedactedProviderError(stderr.telemetry.providerError)) return false;
  try { return sameJson(JSON.parse(processResult.stderr.toString('utf8')), stderr); }
  catch { return false; }
}

function isLegacyQualifiedOperationalFailure(processResult, stderr) {
  if (processResult.exitStatus !== 1 || processResult.timedOut || processResult.signal !== null ||
      processResult.outputLimitExceeded || processResult.spawnError !== null || processResult.stdout.length !== 0 ||
      stderr?.status !== 'operational-failure' ||
      !sameJson(Object.keys(stderr).sort(), ['details', 'error', 'status']) ||
      stderr.error !== 'MDLM command exceeded 30000ms' ||
      !sameJson(Object.keys(stderr.details ?? {}).sort(), ['arguments']) ||
      !sameJson(stderr.details.arguments, ['status', '--json'])) return false;
  try { return sameJson(JSON.parse(processResult.stderr.toString('utf8')), stderr); }
  catch { return false; }
}

function matchesCommandIdentity(argv, option, observed) {
  if (observed === null) return true;
  if (!Array.isArray(argv)) return false;
  const index = argv.indexOf(option);
  return index >= 0 && argv[index + 1] === observed;
}

function isNullableIdentity(value) {
  return value === null || (isBoundedText(value, 1, 128) && /^[A-Za-z0-9._:/-]+$/.test(value));
}

function isRedactedProviderError(value) {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !sameJson(Object.keys(value).sort(), ['message', 'truncated']) ||
      !isBoundedText(value.message, 0, 512) || typeof value.truncated !== 'boolean') return false;
  return !containsSecretLookingText(value.message) &&
    !/\b[A-Za-z0-9+/]{32,}={0,2}\b/u.test(value.message);
}

const secretLookingTextPattern = /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@|bearer\s+[^\s,;]+|["']?(?:x[-_ ]?api[-_ ]?key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|authorization|token|secret|password)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,"';}]+)|(?:sk|rk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}|(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|A3T)[A-Z0-9]{16}|(?:glpat-|npm_|AIza)[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8,})/iu;
const maximumEscapedCredentialLayers = 6;

function containsSecretLookingText(value) {
  let candidate = value;
  for (let layer = 0; layer <= maximumEscapedCredentialLayers; layer++) {
    if (secretLookingTextPattern.test(candidate)) return true;
    const unescaped = candidate.replace(/\\(["'\\])/gu, '$1');
    if (unescaped === candidate) return false;
    candidate = unescaped;
  }
  return false;
}

function isBoundedText(value, minimum, maximum) {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function isRecognizedOperationalStdout(bytes, expected) {
  if (!Buffer.isBuffer(bytes) || !Buffer.isBuffer(expected) ||
      bytes.length > maximumOperationalProgressBytes || expected.length > maximumOperationalProgressBytes) return false;
  const source = bytes.toString('utf8');
  return Buffer.from(source).equals(bytes) && !source.includes('\r') && bytes.equals(expected);
}

function expectedOperationalStdout(assignment, status) {
  const scenario = assignment?.scenario?.reference ?? assignment?.scenarioReference;
  if (typeof assignment?.id !== 'string' || typeof scenario !== 'string') return null;
  let source = `Assignment ${assignment.id}: ${scenario}\n`;
  const outcome = status?.currentOutcome;
  if (outcome?.outcome !== 'attention-required') return Buffer.from(source);
  if (outcome.assignment?.allocation !== 'active' || outcome.assignment.id !== assignment.id ||
      outcome.authorityRequirement?.mode !== 'attended') return null;
  source += '\nMDLM requires attended authority.\n';
  if (typeof outcome.explanation === 'string') source += `${outcome.explanation}\n`;
  for (const name of ['authorityRequirement', 'attentionContext', 'checkpointConversation']) {
    if (outcome[name] !== undefined) source += `${JSON.stringify(outcome[name], null, 2)}\n`;
  }
  source += 'Explicit conclusion from the named authority holder (not chat approval): ';
  return Buffer.from(source);
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

async function finalizeExhaustedBoundary(output, postSnapshot) {
  const evidence = output[exhaustedBoundaryEvidence];
  if (evidence === undefined) return output;
  delete output[exhaustedBoundaryEvidence];
  try {
    if (postSnapshot.status !== 'complete') throw new Error('exhausted Assignment post-run snapshot is incomplete');
    const captured = JSON.parse(await readFile(path.join(postSnapshot.snapshotDirectory, 'snapshot.json'), 'utf8'));
    const disposition = await authenticateExhaustedBoundary({
      ...evidence, assignment: captured.assignment, status: captured.status, captured,
    });
    output.assignmentDisposition = disposition;
    return output;
  } catch (error) {
    output.status = 'stopped';
    output.recoverable = false;
    output.reason = 'exhausted-boundary-drift';
    output.detail = error instanceof Error ? error.message : String(error);
    delete output.outcome;
    delete output.transactionPhase;
    delete output.trustedRepositoryAdvance;
    delete output.assignmentDisposition;
    return output;
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
    if (!operationalFailureHasCompleteAttemptEvidence(output.mdlmPi?.document)) {
      throw new Error('worker failure lacks complete authenticated terminal and response-capture evidence');
    }
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
    const marker = await reuseOperationalFailureMarker({
      request, context, assignmentDirectory, processPackage: initial.status.package,
      commandEvidence: evidence.commandEvidence, initial,
    }) ?? await writeOperationalFailureMarker({
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
    const retryCommand = operationalFailureRetryMode(output.mdlmPi.document);
    output.operationalFailureRecovery = {
      verified: true,
      assignmentId: output.assignmentId,
      retryCommand,
      resumeAllowed: retryCommand === 'resume',
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

async function reuseOperationalFailureMarker({ request, context, assignmentDirectory, processPackage, commandEvidence, initial }) {
  const directory = operationalRecoveryDirectory(context, request.assignmentId);
  await recoverPendingOperationalRecoveryWrites(directory);
  const runIdentity = observedRunIdentity(initial.provenance, processPackage, request.operator, request);
  const history = await readOperationalRecoveryHistory({
    directory, request, context, assignmentDirectory, processPackage, runIdentity,
  });
  const matching = history.markers.filter(marker => marker.index === commandEvidence.index);
  if (matching.length === 0) return null;
  if (matching.length !== 1 || history.transitions.has(commandEvidence.index)) {
    throw new Error('durable operational failure marker is ambiguous or already transitioned');
  }
  return { path: matching[0].path, digest: matching[0].digest };
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

async function inspectOperationalRecovery({
  request, mode, context, assignmentDirectory, captured, snapshotResult, processPackage, runIdentity,
  trustedCompletedTransaction,
}) {
  try {
    const directory = operationalRecoveryDirectory(context, request.assignmentId);
    await recoverPendingOperationalRecoveryWrites(directory);
    const history = await readOperationalRecoveryHistory({
      directory, request, context, assignmentDirectory, processPackage, runIdentity,
    });
    if (history.markers.some(marker =>
      (marker.document.source === 'verified-finalization') !==
        (marker.typedContract === mdlmPiOperationalFailureContract))) {
      throw new Error('operational failure marker source does not match its versioned failure contract');
    }
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
      if (pendingLegacyUpgrade === null) {
        const transitioned = history.markers.filter(marker => history.transitions.has(marker.index)).at(-1);
        if (transitioned === undefined) return { ok: true, requiredNextMode: null, transition: null };
        if (!trustedCompletedTransaction) {
          requireActiveOperationalBoundary(transitioned.document, captured, request.assignmentId);
        }
        const transition = history.transitions.get(transitioned.index);
        if (mode !== transition.document.mode) {
          return {
            ok: true,
            requiredNextMode: transition.document.mode,
            recovery: {
              marker: { path: transitioned.path, digest: transitioned.digest },
              source: transitioned.document.source,
            },
          };
        }
        return { ok: true, requiredNextMode: null, transition: { path: transition.path, digest: transition.digest } };
      }
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
      return { ok: true, requiredNextMode: null, transition: null };
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
    const transitionEvidence = await immutableFileEvidence(transitionPath);
    if (marker.document.source === 'legacy-command-evidence-migration') {
      await upgradeLegacyRunIdentity(context, marker.document, runIdentity);
    }
    return {
      ok: true,
      requiredNextMode: null,
      transition: { path: transitionEvidence.path, digest: transitionEvidence.digest },
    };
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
  const document = requireTypedOperationalFailure(
    stored.record,
    stored.stdout,
    stored.stderr,
    expectedOperationalStdout(assignmentForOperationalStdout(assignmentId, initial), initial.status),
  );
  const marker = {
    contract: 'mdlm-demo-operational-failure-marker@1',
    assignmentId,
    requiredNextMode: operationalFailureRetryMode(document),
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
      document: operationalFailureDocumentEvidence(stored.stderr, document),
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
    const typed = await validateOperationalFailureMarker({
      document, index: item.index, transitioned: retryEntries.has(item.index),
      request, context, assignmentDirectory, processPackage, runIdentity,
    });
    markers.push({ index: item.index, path: evidence.path, digest: evidence.digest, document, typedContract: typed.contract });
  }
  for (const [index, entry] of retryEntries) {
    const marker = markers.find(item => item.index === index);
    if (!marker) throw new Error('operational recovery retry has no matching failure marker');
    const evidence = await immutableFileEvidence(path.join(directory, entry.name));
    const document = JSON.parse(evidence.bytes.toString('utf8'));
    const expected = {
      contract: 'mdlm-demo-operational-failure-retry@1',
      assignmentId: request.assignmentId,
      mode: marker.document.requiredNextMode,
      marker: { path: marker.path, digest: marker.digest },
      lifecycleRepository: marker.document.postBoundary.lifecycleRepository,
      processPackage: marker.document.processPackage,
      runIdentity: marker.document.runIdentity,
      timeoutIdentity: marker.document.timeoutIdentity,
    };
    if (!sameJson(document, expected)) throw new Error('operational recovery retry transition is malformed or tampered');
    retryEntries.set(index, { path: evidence.path, digest: evidence.digest, document });
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
      document.assignmentId !== request.assignmentId || !['run', 'resume'].includes(document.requiredNextMode) ||
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
  const initialBoundary = await validateOperationalBoundary(document.initialBoundary, false);
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
  const typed = requireTypedOperationalFailure(
    stored.record,
    stored.stdout,
    stored.stderr,
    expectedOperationalStdout(
      assignmentForOperationalStdout(request.assignmentId, initialBoundary),
      initialBoundary.status,
    ),
  );
  const expectedDocument = operationalFailureDocumentEvidence(stored.stderr, typed);
  const expectedMode = operationalFailureRetryMode(typed);
  if (document.requiredNextMode !== expectedMode) {
    throw new Error('operational failure marker recovery mode differs from its typed failure');
  }
  if (!sameJson(failure.document, expectedDocument)) throw new Error('operational failure marker typed command document differs');
  return typed;
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
  return snapshot;
}

function assignmentForOperationalStdout(assignmentId, snapshot) {
  return {
    id: assignmentId,
    scenarioReference: snapshot.assignment?.scenarioReference,
  };
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

function requireTypedOperationalFailure(record, stdout, stderr, expectedStdout = null) {
  if (record.exitStatus !== 1 || record.timedOut !== false || record.signal !== null ||
      record.outputLimitExceeded !== false || record.spawnError !== null || record.stdoutSha256 !== sha256(stdout) ||
      record.stderrSha256 !== sha256(stderr) || record.observedOutputBytes !== stdout.length + stderr.length) {
    throw new Error('operational failure command termination evidence is not exact');
  }
  let document;
  try { document = JSON.parse(stderr.toString('utf8')); }
  catch { throw new Error('operational failure stderr is not one exact JSON document'); }
  const processResult = { ...record, stdout, stderr };
  if (!isLegacyQualifiedOperationalFailure(processResult, document) &&
      !isTypedOperationalFailure(processResult, document, expectedStdout)) {
    throw new Error('operational failure stderr is not a strictly typed operational failure');
  }
  return document;
}

function operationalFailureDocumentEvidence(stderr, document) {
  const errorBytes = typeof document.error === 'string'
    ? Buffer.from(document.error)
    : Buffer.from(JSON.stringify(document.error));
  const details = document.contract === mdlmPiOperationalFailureContract ? document.telemetry : document.details;
  return {
    digest: sha256(stderr),
    errorDigest: sha256(errorBytes),
    detailsDigest: sha256(Buffer.from(JSON.stringify(details))),
  };
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

async function recoverPendingDurableCommandWrites(directory) {
  const names = await readdir(directory);
  for (const name of names) {
    if (!name.endsWith('.pending')) continue;
    if (!/^(?:authorization|result|consumption)\.json\.pending$/.test(name)) {
      throw new Error('durable command directory contains an unsupported pending write');
    }
    const pending = path.join(directory, name);
    const target = pending.slice(0, -'.pending'.length);
    if (await optionalLstat(target) !== null) {
      throw new Error('durable command attempt contains an ambiguous completed and pending write');
    }
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

function selectedDecision(binding, assignmentId) {
  if (binding === null) return null;
  if (!binding || binding.contract !== 'mdlm-demo-bound-decision-catalog@1' ||
      !Number.isSafeInteger(binding.bytes) || binding.bytes < 0 || typeof binding.bytesBase64 !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(binding.digest ?? '')) {
    throw new Error('invalid bound decision catalog');
  }
  const bytes = Buffer.from(binding.bytesBase64, 'base64');
  if (bytes.length !== binding.bytes || sha256(bytes) !== binding.digest) throw new Error('bound decision catalog bytes differ');
  const catalog = JSON.parse(authoritativeDecisionUtf8.decode(bytes));
  if (catalog.contract !== 'mdlm-demo-decision-catalog@1') throw new Error('invalid decision catalog contract');
  const selected = catalog.decisions?.find(value => value.assignment === assignmentId);
  if (!selected) return null;
  if (selected.origin !== 'operator-selected' || typeof selected.authorityBasis !== 'string' || selected.authorityBasis.length === 0 || typeof selected.wording !== 'string') {
    throw new Error('decision must record operator-selected origin, authority basis, and wording');
  }
  if (!selected.wording.isWellFormed()) throw new Error('decision wording contains an unpaired UTF-16 surrogate');
  const digest = sha256(Buffer.from(selected.wording));
  if (selected.digest !== digest) throw new Error('operator decision wording digest differs');
  return { wording: selected.wording, evidence: { origin: selected.origin, authorityBasis: selected.authorityBasis, digest: selected.digest } };
}

function requireOriginalProvenanceBinding(provenance, request, label) {
  const configured = {
    source: {
      repository: provenance.source?.repository,
      commit: provenance.source?.expectedCommit,
      tree: provenance.source?.expectedTree,
    },
    package: { artifact: provenance.package?.path, digest: provenance.package?.expectedDigest },
    piPackage: { artifact: provenance.piPackage?.path, digest: provenance.piPackage?.expectedDigest },
    tooling: {
      root: provenance.tooling?.root,
      digest: provenance.tooling?.expectedDigest,
      lock: { path: provenance.tooling?.lock?.path, digest: provenance.tooling?.lock?.expectedDigest },
    },
    tools: {
      mdlm: { path: provenance.tools?.mdlm?.path, digest: provenance.tools?.mdlm?.expectedDigest },
      mdlmPi: { path: provenance.tools?.mdlmPi?.path, digest: provenance.tools?.mdlmPi?.expectedDigest },
    },
    qualificationHarness: {
      repository: provenance.qualificationHarness?.repository,
      commit: provenance.qualificationHarness?.expectedCommit,
      tree: provenance.qualificationHarness?.expectedTree,
      repositoryLocator: provenance.qualificationHarness?.repositoryLocator,
      manifest: {
        path: provenance.qualificationHarness?.manifest?.path,
        digest: provenance.qualificationHarness?.manifest?.expectedDigest,
      },
    },
  };
  const configuredHarness = configured.qualificationHarness;
  const measuredFiles = [
    provenance.package, provenance.piPackage, provenance.tooling?.lock,
    provenance.tools?.mdlm, provenance.tools?.mdlmPi, provenance.qualificationHarness?.manifest,
  ];
  if (provenance.valid !== true || !sameJson(request.provenance, configured) ||
      !sameJson(request.commands, { mdlm: configured.tools.mdlm.path, mdlmPi: configured.tools.mdlmPi.path }) ||
      (request.harness !== undefined && !sameJson(request.harness, {
        directory: configuredHarness.repository,
        commit: configuredHarness.commit,
        tree: configuredHarness.tree,
        repositoryLocator: configuredHarness.repositoryLocator,
      })) ||
      provenance.source?.clean !== true || provenance.source?.matches !== true ||
      provenance.source.observedCommit !== configured.source.commit || provenance.source.observedTree !== configured.source.tree ||
      provenance.tooling?.matches !== true || provenance.tooling?.containedTools !== true ||
      provenance.tooling.digest !== configured.tooling.digest ||
      provenance.qualificationHarness?.clean !== true || provenance.qualificationHarness?.matches !== true ||
      provenance.qualificationHarness.observedCommit !== configuredHarness.commit ||
      provenance.qualificationHarness.observedTree !== configuredHarness.tree ||
      measuredFiles.some(value => value?.matches !== true || value.digest !== value.expectedDigest)) {
    throw new Error(`${label} snapshot provenance does not authenticate the original configured paths and expected pins`);
  }
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

function advancingControllerJournal(captured, assignmentId) {
  if (captured.piJournal?.present !== true) return { present: false };
  let journal;
  let bytes;
  try {
    bytes = Buffer.from(captured.piJournal.bytesBase64, 'base64');
    if (bytes.toString('base64') !== captured.piJournal.bytesBase64 || sha256(bytes) !== captured.piJournal.digest) {
      throw new Error('captured mdlm-pi journal bytes do not match their snapshot digest');
    }
    journal = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return { present: true, ok: false, detail: `mdlm-pi journal is malformed: ${error.message}` };
  }
  if (journal.phase !== 'advancing') return { present: false };
  try {
    if (journal.contract !== 'mdlm-pi-run-journal@1' ||
        !sameJson(Object.keys(journal).sort(), ['advancement', 'contract', 'phase'])) {
      throw new Error('advancing mdlm-pi journal envelope is invalid');
    }
    const advancement = journal.advancement;
    if (!advancement || typeof advancement !== 'object' || Array.isArray(advancement) ||
        !sameJson(Object.keys(advancement).sort(), ['baseCommit', 'package', 'pending', 'previousTransactionId', 'purpose', 'repository'])) {
      throw new Error('advancing mdlm-pi journal body is invalid');
    }
    const processPackage = normalizeProcessPackage(advancement.package, 'advancing journal package');
    if (!sameProcessPackageIdentity(processPackage, captured.status.package) ||
        !sameProcessPackageIdentity(processPackage, captured.diagnosis.package)) {
      throw new Error('advancing journal, status, and doctor Process Package identities differ');
    }
    if (captured.status.ok !== true || captured.diagnosis.ok !== true ||
        captured.assignment.id !== assignmentId || captured.assignment.selected !== false ||
        captured.status.currentOutcome?.outcome !== 'assignment' ||
        captured.status.currentOutcome.assignment?.allocation !== 'not-allocated') {
      throw new Error('advancing journal does not accompany one completed deselected Assignment');
    }
    if (captured.lifecycleRepository.clean !== true ||
        !sameRepositoryFingerprint(advancement.repository, captured.lifecycleRepository) ||
        advancement.baseCommit !== captured.lifecycleRepository.head) {
      throw new Error('advancing journal does not bind the current clean repository');
    }
    if (advancement.purpose !== 'ordinary-allocation' || !Array.isArray(advancement.pending) || advancement.pending.length !== 0) {
      throw new Error('advancing journal is not at the supported empty ordinary-allocation boundary');
    }
    const recent = captured.status.recentTransaction;
    if (recent?.available !== true || recent.status !== 'completed' ||
        typeof advancement.previousTransactionId !== 'string' || advancement.previousTransactionId !== recent.id) {
      throw new Error('advancing journal does not identify the completed recent transaction');
    }
    return { present: true, ok: true, advancement, processPackage };
  } catch (error) {
    return { present: true, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function authenticateAdvancingControllerRecovery({ context, assignmentDirectory, captured, assignmentId, advancement, processPackage }) {
  const identity = await optionalCanonicalJson(path.join(assignmentDirectory, 'identity.json'));
  const global = await optionalCanonicalJson(path.join(context.identityDirectory, 'repository-identity.json'));
  if (identity?.contract !== 'mdlm-demo-assignment-identity@1' || identity.assignmentId !== assignmentId ||
      !sameJson(Object.keys(identity).sort(), ['assignmentId', 'assignmentRepository', 'contract', 'lifecycleRepository']) ||
      global?.contract !== 'mdlm-demo-repository-identity@1' ||
      !sameJson(Object.keys(global).sort(), ['contract', 'lastAssignment', 'lifecycleRepository']) ||
      !sameJson(identity.lifecycleRepository, global.lifecycleRepository) ||
      !sameRepositoryFingerprint(identity.assignmentRepository, identity.lifecycleRepository)) {
    throw new Error('advancing recovery lacks the exact prior Assignment and repository identities');
  }
  if (identity.lifecycleRepository.clean !== true || identity.lifecycleRepository.head === captured.lifecycleRepository.head) {
    throw new Error('advancing recovery does not cross a new clean publication boundary');
  }
  await authenticateLifecycleTransactionAncestry(
    context.repository,
    identity.lifecycleRepository.head,
    captured.lifecycleRepository.head,
    { finalAssignmentId: assignmentId },
  );
  const subject = await runProcess('git', ['show', '-s', '--format=%s', captured.lifecycleRepository.head], {
    cwd: context.repository, timeoutMs: 900_000, env: gitEnvironment(),
  });
  if (!commandSucceeded(subject) ||
      !subject.stdout.toString('utf8').trim().endsWith(` (${advancement.previousTransactionId})`)) {
    throw new Error('advancing journal recent transaction does not identify the current publication commit');
  }
  return { id: assignmentId, package: processPackage, repository: identity.assignmentRepository };
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
    const standaloneRecovery = existing?.document.timedOutCheckpointRecovery !== undefined
      ? 'timedOutCheckpointRecovery'
      : existing?.document.nonTimeoutMaterializedCheckpointRecovery !== undefined
        ? 'nonTimeoutMaterializedCheckpointRecovery'
        : null;
    if (standaloneRecovery !== null) {
      const retained = existing.document;
      if (retained.phase !== 'completed' || !sameJson(global.lifecycleRepository, captured.lifecycleRepository) ||
          !sameJson(retained.completedRepository, captured.lifecycleRepository) || retained.toAssignment !== assignmentId ||
          !sameProcessPackageIdentity(retained.package, processPackage)) {
        throw new Error('standalone checkpoint reconciliation is incomplete or differs from current Assignment B');
      }
      const sourceDirectory = retained.sourceAssignmentDirectory;
      if (typeof sourceDirectory !== 'string') throw new Error('standalone checkpoint reconciliation has no source Assignment directory');
      await authenticateCompletedStandaloneReconciliation(retained, standaloneRecovery);
      await validateExistingCheckpointTransaction(sourceDirectory, retained, existing.path);
      return {
        ok: true,
        result: { status: 'already-reconciled', fromAssignment: retained.fromAssignment, toAssignment: retained.toAssignment },
      };
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

async function authenticateCompletedStandaloneReconciliation(journal, recoveryField) {
  if (!['timedOutCheckpointRecovery', 'nonTimeoutMaterializedCheckpointRecovery'].includes(recoveryField) ||
      !sameJson(journal.evidence, journal[recoveryField])) {
    throw new Error('standalone checkpoint reconciliation evidence differs');
  }
  const manifests = journal[recoveryField];
  const authenticateManifest = async (manifest, label) => {
    if (!manifest || typeof manifest.path !== 'string' || !Number.isSafeInteger(manifest.bytes) ||
        !/^sha256:[0-9a-f]{64}$/.test(manifest.digest ?? '')) {
      throw new Error(`${label} manifest is malformed`);
    }
    const observed = await immutableFileEvidence(manifest.path);
    if (observed.bytes.length !== manifest.bytes || observed.digest !== manifest.digest) {
      throw new Error(`${label} differs from the completed reconciliation journal`);
    }
  };
  for (const name of ['request', 'repositoryIdentity', 'authorization', 'result', 'identity', 'config', 'processedAssignment', 'assignmentCheckpoint', 'packet']) {
    await authenticateManifest(manifests[name], name);
  }
  if (!Array.isArray(manifests.commands) || manifests.commands.length !== 2 ||
      manifests.commands.some(triplet => !Array.isArray(triplet) || triplet.length !== 3)) {
    throw new Error('completed reconciliation command manifests are malformed');
  }
  for (const [commandIndex, triplet] of manifests.commands.entries()) {
    for (const [partIndex, manifest] of triplet.entries()) {
      await authenticateManifest(manifest, `command ${commandIndex + 1} evidence ${partIndex + 1}`);
    }
  }
  if (!manifests.outerCommand || !sameJson(Object.keys(manifests.outerCommand).sort(), ['exit', 'stderr', 'stdout'])) {
    throw new Error('completed reconciliation outer controller manifests are malformed');
  }
  for (const name of ['stdout', 'stderr', 'exit']) {
    await authenticateManifest(manifests.outerCommand[name], `outer controller ${name}`);
  }
  for (const [name, postRun] of [['initialSnapshot', false], ['postSnapshot', true]]) {
    const snapshotPin = manifests[name];
    const verified = await verifySnapshot(snapshotPin?.directory, snapshotPin?.digest, postRun);
    if (!sameJson(verified.manifest, snapshotPin.manifest)) {
      throw new Error(`${name} manifest differs from the completed reconciliation journal`);
    }
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
  if (failureIndex !== 2 || transitionEntry.path !== transitionEvidence.path) {
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
  await authenticateLifecycleTransactionAncestry(
    context.repository,
    priorRepository.head,
    captured.lifecycleRepository.head,
    { firstAssignmentId: fromAssignment },
  );

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

async function authenticateLifecycleTransactionAncestry(repository, oldHead, newHead, expectedAssignment = {}) {
  const runGit = async args => {
    const result = await runProcess('git', args, { cwd: repository, timeoutMs: 900_000, env: gitEnvironment() });
    if (!commandSucceeded(result)) throw new Error(`Git ancestry evidence failed for ${args.join(' ')}`);
    return result.stdout;
  };
  await runGit(['merge-base', '--is-ancestor', oldHead, newHead]);
  const commits = (await runGit(['rev-list', '--reverse', `${oldHead}..${newHead}`])).toString('utf8').trim().split('\n').filter(Boolean);
  if (commits.length === 0) throw new Error('orphaned checkpoint did not advance through any lifecycle transaction commits');
  if (expectedAssignment.commitCount !== undefined && commits.length !== expectedAssignment.commitCount) {
    throw new Error(`lifecycle transaction ancestry contains ${commits.length} commits instead of exactly ${expectedAssignment.commitCount}`);
  }
  if (expectedAssignment.commits !== undefined && !sameJson(commits, expectedAssignment.commits)) {
    throw new Error('lifecycle transaction ancestry differs from the durable command publications');
  }
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
    const treeEntries = (await runGit(['ls-tree', '-r', commit, '--', transactionRoot])).toString('utf8').trim().split('\n').filter(Boolean);
    if (treeEntries.length !== paths.length || treeEntries.some(entry => !entry.startsWith('100644 blob '))) {
      throw new Error('intermediate lifecycle transaction contains a symlink, substitution, or unexpected tree entry');
    }
    let execution;
    try { execution = JSON.parse((await runGit(['show', `${commit}:${executionPath}`])).toString('utf8')); }
    catch { throw new Error('intermediate lifecycle transaction execution is not valid JSON'); }
    const outputPaths = execution?.outputs?.map(output => output?.lifecycleDatum?.path).sort();
    if (execution?.contract !== 'mdlm-scenario-execution@4' || execution.id !== executionId ||
        execution.status !== 'completed' || execution.definition?.scenario !== scenario ||
        execution.response?.contract !== 'mdlm-assignment-response@1' || typeof execution.response.assignment !== 'string' ||
        !Array.isArray(outputPaths) || outputPaths.length === 0 || new Set(outputPaths).size !== outputPaths.length ||
        outputPaths.some(output => typeof output !== 'string' || !output.startsWith(`${transactionRoot}/`)) ||
        !sameJson(paths, [executionPath, ...outputPaths].sort())) {
      throw new Error('intermediate commit does not correspond to one completed lifecycle transaction');
    }
    if (commit === commits[0] && expectedAssignment.firstAssignmentId !== undefined &&
        execution.response.assignment !== expectedAssignment.firstAssignmentId) {
      throw new Error('first lifecycle transaction does not belong to the completed Assignment');
    }
    if (commit === newHead && expectedAssignment.finalAssignmentId !== undefined &&
        execution.response.assignment !== expectedAssignment.finalAssignmentId) {
      throw new Error('final lifecycle transaction does not belong to the recovering Assignment');
    }
    if (commit === newHead && expectedAssignment.finalScenario !== undefined && scenario !== expectedAssignment.finalScenario) {
      throw new Error('final lifecycle transaction is not the exact package materialization Scenario');
    }
    if (commit === newHead && expectedAssignment.finalAssignmentExcludes?.includes(execution.response.assignment)) {
      throw new Error('final package materialization transaction attempted Assignment A or B');
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
  requireCompleteProcessRecord(record, `command-${index}`);
  const stdout = stdoutEvidence.bytes;
  const stderr = stderrEvidence.bytes;
  if (record.stdoutSha256 !== sha256(stdout) || record.stderrSha256 !== sha256(stderr) ||
      record.stdoutBase64 !== stdout.toString('base64') || record.stderrBase64 !== stderr.toString('base64') ||
      !retainedOutputMatchesObserved(record, stdout, stderr)) {
    throw new Error(`command-${index} raw bytes differ from the authenticated command record`);
  }
  return { record, stdout, stderr, evidence: files };
}

function retainedOutputMatchesObserved(record, stdout, stderr) {
  const retainedBytes = stdout.length + stderr.length;
  return record.observedOutputBytes === retainedBytes;
}

function requireCompleteProcessRecord(record, label) {
  const hasExitStatus = Number.isSafeInteger(record.exitStatus);
  const hasSignal = typeof record.signal === 'string' && record.signal.length > 0;
  const hasSpawnError = typeof record.spawnError === 'string' && record.spawnError.length > 0;
  if (!Array.isArray(record.argv) || record.argv.length === 0 || record.argv.some(value => typeof value !== 'string' || value.length === 0) ||
      typeof record.cwd !== 'string' || !path.isAbsolute(record.cwd) || !Number.isSafeInteger(record.timeoutMs) || record.timeoutMs < 1 ||
      typeof record.timedOut !== 'boolean' || record.outputLimitExceeded !== false ||
      !(record.exitStatus === null || hasExitStatus) || !(record.signal === null || hasSignal) ||
      !(record.spawnError === null || hasSpawnError) || (hasSignal && (hasExitStatus || hasSpawnError)) ||
      (hasExitStatus && record.exitStatus < 0 && !hasSpawnError) || (hasSpawnError && hasExitStatus && record.exitStatus >= 0) ||
      (!hasExitStatus && !hasSignal && !hasSpawnError) ||
      !Number.isSafeInteger(record.observedOutputBytes) || record.observedOutputBytes < 0 ||
      typeof record.startedAt !== 'string' || typeof record.completedAt !== 'string' ||
      !Number.isFinite(Date.parse(record.startedAt)) || !Number.isFinite(Date.parse(record.completedAt)) ||
      Date.parse(record.completedAt) < Date.parse(record.startedAt)) {
    throw new Error(`${label} process identity or termination is incomplete or incoherent`);
  }
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

function reconcileTargetBinding(request, originalRequest) {
  const originalRepository = path.resolve(originalRequest.repository);
  const originalState = path.resolve(originalRequest.stateDirectory);
  const targetRepository = path.resolve(request.repository);
  const targetState = path.resolve(request.stateDirectory);
  const exact = originalRepository === targetRepository && originalState === targetState;
  if (exact) {
    if (request.relocation !== undefined) throw new Error('exact reconciliation targets must not declare a relocation');
    return {
      relocated: false,
      translate: value => path.resolve(value),
      manifest: {
        contract: 'mdlm-demo-reconcile-target-binding@1', mode: 'exact',
        repository: { original: originalRepository, target: targetRepository },
        stateDirectory: { original: originalState, target: targetState },
        evidenceDirectory: {
          original: path.resolve(originalRequest.evidenceDirectory),
          target: path.resolve(originalRequest.evidenceDirectory),
        },
      },
    };
  }

  const relocation = request.relocation;
  if (!relocation) throw new Error('reconciliation targets differ from the original request without an authenticated relocation');
  const originalRoot = path.resolve(relocation.originalRoot);
  const targetRoot = path.resolve(relocation.targetRoot);
  if (path.dirname(originalRepository) !== originalRoot || path.dirname(originalState) !== originalRoot) {
    throw new Error('relocation originalRoot does not bind the original repository and state directory');
  }
  const translate = value => {
    const original = path.resolve(value);
    const relative = path.relative(originalRoot, original);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`relocation cannot translate path outside originalRoot: ${original}`);
    }
    return path.resolve(targetRoot, relative);
  };
  if (targetRepository !== translate(originalRepository) || targetState !== translate(originalState)) {
    throw new Error('repository and stateDirectory must share the exact authenticated relocation root');
  }
  return {
    relocated: true, translate,
    manifest: {
      contract: 'mdlm-demo-reconcile-target-binding@1', mode: 'relocated',
      relocation: { contract: relocation.contract, originalRoot, targetRoot },
      repository: { original: originalRepository, target: targetRepository },
      stateDirectory: { original: originalState, target: targetState },
      evidenceDirectory: {
        original: path.resolve(originalRequest.evidenceDirectory),
        target: translate(originalRequest.evidenceDirectory),
      },
    },
  };
}

function standaloneCheckpointRecoveryShape(originalRequest, relocated) {
  const evidenceDirectory = path.resolve(originalRequest.evidenceDirectory);
  const parent = path.dirname(evidenceDirectory);
  const timedOut = /^run-([0-9]+)-snapshot$/.exec(path.basename(evidenceDirectory));
  if (timedOut !== null) {
    return {
      kind: 'timed-out',
      requestPath: path.join(parent, `${timedOut[1]}-request.json`),
      outerPaths: Object.fromEntries(['stdout', 'stderr', 'exit'].map(name => [name, path.join(parent, `${timedOut[1]}-run.${name}`)])),
    };
  }
  const nonTimeout = /^run-([0-9]+)-snapshots$/.exec(path.basename(evidenceDirectory));
  if (nonTimeout !== null && nonTimeout[1] === '001' && originalRequest.signal === 'fresh-assignment') {
    return {
      kind: 'non-timeout-materialized',
      requestPath: path.join(parent, '004-run-001-request.json'),
      outerPaths: {
        ...Object.fromEntries(['stdout', 'stderr', 'exit'].map(name => [name, path.join(parent, `012-run-001.runner.${name}`)])),
        record: path.join(parent, '012-run-001.runner.command.json'),
      },
      outerRecordDigest: 'sha256:7f60baf8dc4dcfcbad9dac1b8e03dbb54b043ad9a4fb8032182f580b7392f025',
    };
  }
  if (!relocated) return { kind: 'timed-out', requestPath: null, outerPaths: null };
  throw new Error('reconciliation evidence directory and signal do not identify a supported recovery shape');
}

async function authenticateOuterControllerEvidence(pins, targetBinding, recoveryShape, originalRequest, timeoutMs) {
  const names = recoveryShape.kind === 'non-timeout-materialized'
    ? ['record', 'stdout', 'stderr', 'exit']
    : ['stdout', 'stderr', 'exit'];
  if (!sameJson(Object.keys(pins).sort(), [...names].sort())) {
    throw new Error(`outer command evidence for ${recoveryShape.kind} recovery has missing or extra records`);
  }
  if (recoveryShape.outerPaths !== null) {
    for (const name of names) {
      const expected = targetBinding.translate(recoveryShape.outerPaths[name]);
      if (path.resolve(pins[name].path) !== expected) {
        throw new Error(`outer ${name} pin does not match the authenticated target binding`);
      }
    }
  }
  const authenticated = Object.fromEntries(await Promise.all(names.map(async name => [
    name, await requirePinnedEvidence(pins[name], `outer controller ${name}`),
  ])));
  if (recoveryShape.kind === 'non-timeout-materialized') {
    if (authenticated.record.digest !== recoveryShape.outerRecordDigest) {
      throw new Error('outer command record differs from the fixed run-001 compatibility record');
    }
    await authenticateOuterCommandRecord(
      JSON.parse(authenticated.record.bytes.toString('utf8')), recoveryShape, originalRequest, timeoutMs,
    );
  }
  if (authenticated.stdout.bytes.length !== 0) {
    throw new Error('outer controller stdout contains an internal runner result');
  }
  const expectedError = Buffer.from('{"contract":"mdlm-demo-error@1","error":"untrusted durable command consumption snapshot differs from its authorized repository boundary"}\n');
  if (!authenticated.stderr.bytes.equals(expectedError) || !authenticated.exit.bytes.equals(Buffer.from('1\n'))) {
    throw new Error('outer controller stderr, exit status, or completion evidence differs from the preserved failed command');
  }
  return authenticated;
}

async function authenticateOuterCommandRecord(record, recoveryShape, originalRequest, timeoutMs) {
  const runner = record?.runner;
  const runtime = record?.runtime;
  const launcherPath = runner && path.join(runner.repository, runner.launcher?.path ?? '');
  const expectedArgv = ['node', launcherPath, 'run', '--input', recoveryShape.requestPath];
  if (record?.contract !== 'mdlm-demo-outer-command@1' ||
      !sameJson(Object.keys(record).sort(), ['argv', 'contract', 'cwd', 'runner', 'runtime']) ||
      !sameJson(record.argv, expectedArgv) || record.cwd !== '/home/ubuntu/git/mdlm' ||
      runtime?.name !== 'node' || typeof runtime.version !== 'string' ||
      !runner || runner.clean !== true || runner.porcelainSha256 !== sha256(Buffer.alloc(0)) ||
      runner.launcher?.path !== 'bin/mdlm-demo-runner.mjs' ||
      originalRequest.repository !== '/home/ubuntu/git/mdlm-successor-demos/operations/json-max-depth-ops-002/repository') {
    throw new Error('outer command record does not bind the exact run-001 argv, cwd, runtime, and runner launcher');
  }

  const runtimeFile = await readCanonicalEvidenceFile(runtime.executable?.path ?? '');
  if (runtimeFile.bytes.length !== runtime.executable.bytes || sha256(runtimeFile.bytes) !== runtime.executable.digest) {
    throw new Error('outer command runtime executable differs from its authenticated identity');
  }
  const version = await runProcess(runtime.executable.path, ['--version'], {
    cwd: record.cwd, timeoutMs: Math.min(timeoutMs, 30_000), env: controlledEnvironment(),
  });
  if (!commandSucceeded(version) || version.stdout.toString('utf8').trim() !== runtime.version || version.stderr.length !== 0) {
    throw new Error('outer command runtime version differs from its authenticated identity');
  }

  await requireCanonicalDirectory(runner.repository);
  const gitOptions = { cwd: runner.repository, timeoutMs, env: gitEnvironment() };
  const [commit, tree, status] = await Promise.all([
    runProcess('git', ['rev-parse', 'HEAD^{commit}'], gitOptions),
    runProcess('git', ['rev-parse', 'HEAD^{tree}'], gitOptions),
    runProcess('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], gitOptions),
  ]);
  if (![commit, tree, status].every(commandSucceeded) ||
      commit.stdout.toString('utf8').trim() !== runner.commit || tree.stdout.toString('utf8').trim() !== runner.tree ||
      status.stdout.length !== 0 || sha256(status.stdout) !== runner.porcelainSha256) {
    throw new Error('outer command runner Git commit, tree, or clean worktree differs');
  }
  await authenticateRunnerSourceClosure(runner.repository, runner.launcher, runner.dependencyClosure);
}

async function authenticateRunnerSourceClosure(repository, launcher, closure) {
  const entries = closure?.entries;
  if (closure?.contract !== 'mdlm-demo-runner-source-closure@1' || !Array.isArray(entries) || entries.length === 0 ||
      sha256(Buffer.from(JSON.stringify(entries))) !== closure.digest || !sameJson(entries[0], launcher)) {
    throw new Error('outer command runner dependency closure record is malformed');
  }
  const files = new Map();
  for (const entry of entries) {
    if (!entry || !sameJson(Object.keys(entry).sort(), ['bytes', 'digest', 'path']) ||
        typeof entry.path !== 'string' || path.posix.normalize(entry.path) !== entry.path || path.posix.isAbsolute(entry.path) ||
        entry.path === '..' || entry.path.startsWith('../') || files.has(entry.path)) {
      throw new Error('outer command runner dependency closure contains an invalid or duplicate path');
    }
    const evidence = await readCanonicalEvidenceFile(path.join(repository, entry.path));
    if (evidence.bytes.length !== entry.bytes || sha256(evidence.bytes) !== entry.digest) {
      throw new Error(`outer command runner dependency differs: ${entry.path}`);
    }
    files.set(entry.path, evidence.bytes.toString('utf8'));
  }

  const reached = new Set();
  const pending = [launcher.path];
  while (pending.length > 0) {
    const relative = pending.pop();
    if (reached.has(relative)) continue;
    const source = files.get(relative);
    if (source === undefined) throw new Error(`outer command runner dependency closure omits ${relative}`);
    reached.add(relative);
    const patterns = [/(?:\bfrom\s*|\bimport\s*)['"](\.[^'"]+)['"]/g, /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
        if (!files.has(dependency)) throw new Error(`outer command runner dependency closure omits ${dependency}`);
        pending.push(dependency);
      }
    }
  }
  if (!sameJson([...reached].sort(), [...files.keys()].sort())) {
    throw new Error('outer command runner dependency closure contains unreferenced or substituted files');
  }
}

async function requireCanonicalPathAbsent(file, trustedRoot, label) {
  const root = path.resolve(trustedRoot);
  const expected = path.resolve(file);
  const relative = path.relative(root, expected);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} is outside its trusted root`);
  }
  await requireCanonicalDirectory(root);
  let current = root;
  const parts = relative.split(path.sep);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let information;
    try { information = await lstat(current); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (information.isSymbolicLink()) throw new Error(`${label} has a symbolic-link path component`);
    if (index === parts.length - 1) throw new Error(`${label} is present`);
    if (!information.isDirectory()) throw new Error(`${label} has a non-directory path component`);
  }
}

async function inspectStandaloneReconciliationDirectory(identityDirectory, journalName, authenticatedRecord) {
  await requireCanonicalDirectory(identityDirectory);
  const directory = path.join(identityDirectory, 'checkpoint-reconciliations');
  let created = false;
  try { await mkdir(directory, { mode: 0o700 }); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (created) await syncDirectory(identityDirectory);
  await requireCanonicalDirectory(directory);
  const information = await lstat(directory, { bigint: true });
  const identity = { directory, dev: information.dev, ino: information.ino };
  const journalPath = path.join(directory, journalName);
  const journalCandidates = Object.fromEntries(['authenticated', 'boundary-advanced', 'completed']
    .map(phase => [phase, canonicalJsonBytes({ ...authenticatedRecord, phase })]));
  const originalJournal = await optionalCanonicalJson(journalPath);
  let originalPhase = null;
  if (originalJournal !== null) {
    originalPhase = originalJournal.phase;
    if (journalCandidates[originalPhase] === undefined ||
        !canonicalJsonBytes(originalJournal).equals(journalCandidates[originalPhase])) {
      throw new Error('checkpoint reconciliation journal differs from the authenticated command evidence');
    }
  }
  const permittedPendingPhases = originalPhase === null
    ? ['authenticated']
    : originalPhase === 'authenticated'
      ? ['authenticated', 'boundary-advanced']
      : originalPhase === 'boundary-advanced'
        ? ['boundary-advanced', 'completed']
        : ['completed'];
  const permittedPendingBytes = permittedPendingPhases.map(phase => journalCandidates[phase]);
  const pendingExpectedBytes = await matchPendingDurableJsonReplacement(journalPath, permittedPendingBytes);
  await recoverDurableJsonReplacement(journalPath, pendingExpectedBytes ?? permittedPendingBytes[0]);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > 1 || (entries.length === 1 && entries[0].name !== journalName)) {
    throw new Error('checkpoint reconciliation directory contains prior, extra, or ambiguous journals');
  }
  let existing = null;
  if (entries.length === 1) {
    if (!entries[0].isFile() || entries[0].isSymbolicLink()) {
      throw new Error('checkpoint reconciliation journal is not a regular file');
    }
    existing = JSON.parse((await readCanonicalEvidenceFile(journalPath)).bytes.toString('utf8'));
  }
  return { directory, identity, journalPath, existing };
}

async function assertTrustedDirectory(identity) {
  const information = await lstat(identity.directory, { bigint: true });
  if (!information.isDirectory() || information.isSymbolicLink() || information.dev !== identity.dev || information.ino !== identity.ino ||
      await realpath(identity.directory) !== identity.directory) {
    throw new Error('checkpoint reconciliation directory changed after authentication');
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
    ...(value.priorRepositoryIdentity === undefined ? {} : { priorRepositoryIdentity: value.priorRepositoryIdentity }),
    completedRepository: value.completedRepository,
    scenario: value.scenario,
    sourceScenario: value.sourceScenario,
    package: value.package,
    ...(value.checkpointRecovery === undefined ? {} : { checkpointRecovery: value.checkpointRecovery }),
    ...(value.orphanedCheckpointRecovery === undefined ? {} : { orphanedCheckpointRecovery: value.orphanedCheckpointRecovery }),
    ...(value.timedOutCheckpointRecovery === undefined ? {} : { timedOutCheckpointRecovery: value.timedOutCheckpointRecovery }),
    ...(value.nonTimeoutMaterializedCheckpointRecovery === undefined
      ? {} : { nonTimeoutMaterializedCheckpointRecovery: value.nonTimeoutMaterializedCheckpointRecovery }),
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
    ...(journal.timedOutCheckpointRecovery === undefined ? {} : { timedOutCheckpointRecovery: journal.timedOutCheckpointRecovery }),
    ...(journal.nonTimeoutMaterializedCheckpointRecovery === undefined
      ? {} : { nonTimeoutMaterializedCheckpointRecovery: journal.nonTimeoutMaterializedCheckpointRecovery }),
  };
}

async function completeCheckpointReconciliation({
  journalPath, journal, globalPath, global, sourceDirectory,
  trustedJournalDirectory = null, trustedJournalDirectoryIdentity = null,
}) {
  const persistJournal = trustedJournalDirectory === null
    ? value => writeJournal(journalPath, value)
    : value => writeTrustedReconciliationJournal(journalPath, value, trustedJournalDirectoryIdentity);
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
    const trustedPriorIdentity = journal.priorRepositoryIdentity === undefined
      ? sameJson(global.lifecycleRepository, journal.priorRepository)
      : sameJson(global, journal.priorRepositoryIdentity);
    if (trustedPriorIdentity) {
      await durableWriteJson(globalPath, advancedIdentity, 'checkpoint-reconciliation-global');
    } else if (!sameJson(global, advancedIdentity)) {
      throw new Error('global repository identity advanced to an unrelated boundary');
    }
  } else if (!sameJson(global, advancedIdentity)) {
    throw new Error('global repository identity does not match the journaled checkpoint advance');
  }
  if (journal.phase === 'authenticated') {
    journal = { ...journal, phase: 'boundary-advanced' };
    await persistJournal(journal);
  }

  const transactionPath = path.join(sourceDirectory, 'transaction.json');
  const completedSource = completedCheckpointTransaction(journal, journalPath);
  const existingTransaction = await optionalCanonicalJson(transactionPath);
  if (existingTransaction === null) await durableWriteJson(transactionPath, completedSource, 'checkpoint-reconciliation-assignment');
  else if (!sameJson(existingTransaction, completedSource)) throw new Error('source Assignment transaction differs from the checkpoint reconciliation');
  if (journal.phase !== 'completed') {
    journal = { ...journal, phase: 'completed' };
    await persistJournal(journal);
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

async function commitPublication(repository, publication, baseCommit, timeoutMs, assignmentDirectory, options = {}) {
  await validatePublication(repository, publication);
  const head = await invoke(assignmentDirectory, 'git', ['rev-parse', 'HEAD^{commit}'], repository, timeoutMs);
  if (!commandSucceeded(head)) throw new Error('repository HEAD cannot be inspected');
  const currentHead = head.stdout.toString('utf8').trim();
  const expected = [...publication.outputPaths].sort();
  if (currentHead !== baseCommit) return reconcileCommittedPublication(repository, publication, baseCommit, currentHead, timeoutMs, assignmentDirectory);
  const status = await invoke(assignmentDirectory, 'git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], repository, timeoutMs);
  if (!commandSucceeded(status)) throw new Error('repository status cannot be inspected');
  const changed = porcelainPaths(status.stdout).sort();
  const expectedWorktreePaths = options.expectedWorktreePaths ?? expected;
  if (!sameJson(changed, expectedWorktreePaths)) throw new Error('working tree does not contain exactly the accepted transaction outputs');
  await verifyBlobs(repository, publication.blobs, 'worktree', timeoutMs, assignmentDirectory);
  const add = await invoke(assignmentDirectory, 'git', ['add', '--', ...expected], repository, timeoutMs);
  if (!commandSucceeded(add)) throw new Error('Git could not stage the accepted transaction');
  const staged = await invoke(assignmentDirectory, 'git', ['diff', '--cached', '--name-only', '-z'], repository, timeoutMs);
  if (!commandSucceeded(staged) || !sameJson(staged.stdout.toString('utf8').split('\0').filter(Boolean).sort(), expected)) throw new Error('Git staged paths differ from the canonical publication');
  const commit = await invoke(assignmentDirectory, 'git', ['commit', '-m', `mdlm: publish ${publication.scenario} (${publication.executionId})`, '--', ...expected], repository, timeoutMs);
  if (!commandSucceeded(commit)) throw new Error('Git publication commit failed');
  maybeInjectedCrash(options.crashPhase ?? 'publication', 'after-git-commit');
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
async function waitAtDecisionCatalogPreflightBarrier(binding) {
  const barrier = process.env.MDLM_DEMO_TEST_DECISION_CATALOG_BARRIER;
  if (typeof barrier !== 'string' || barrier.length === 0) return;
  await writeFile(path.join(barrier, 'ready'), `${JSON.stringify({ digest: binding?.digest ?? null })}\n`, { flag: 'wx', mode: 0o600 });
  for (;;) {
    try { await lstat(path.join(barrier, 'release')); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
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
async function writeTrustedReconciliationJournal(file, value, directoryIdentity) {
  if (path.dirname(file) !== directoryIdentity.directory) {
    throw new Error('checkpoint reconciliation journal escaped its trusted directory');
  }
  await assertTrustedDirectory(directoryIdentity);
  await durableReplaceJson(file, value, value.phase);
  await assertTrustedDirectory(directoryIdentity);
}
async function durableWriteJson(file, value, phase) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await durableReplaceJson(file, value, phase);
}
function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}
async function durableReplaceJson(file, value, phase) {
  const bytes = canonicalJsonBytes(value);
  if (await recoverDurableJsonReplacement(file, bytes)) return;
  const { intent, temporary } = durableJsonReplacementPaths(file);
  const intentBytes = Buffer.from(`${JSON.stringify({
    contract: 'mdlm-demo-durable-json-replacement@1',
    target: path.resolve(file),
    temporary,
    bytes: bytes.length,
    digest: sha256(bytes),
    bytesBase64: bytes.toString('base64'),
  }, null, 2)}\n`);
  await writeSyncedExclusive(intent, intentBytes);
  await syncDirectory(path.dirname(file));
  await writeSyncedExclusive(temporary, bytes);
  await syncDirectory(path.dirname(file));
  maybeInjectedCrash(phase, 'after-temp-sync');
  await rename(temporary, file);
  await syncDirectory(path.dirname(file));
  maybeInjectedCrash(phase, 'after-rename');
  await rm(intent);
  await syncDirectory(path.dirname(file));
}

function durableJsonReplacementPaths(file) {
  const resolved = path.resolve(file);
  const prefix = path.join(path.dirname(resolved), `.${path.basename(resolved)}.durable-replacement`);
  return { intent: `${prefix}.json`, temporary: `${prefix}.tmp` };
}

async function writeSyncedExclusive(file, bytes) {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

async function matchPendingDurableJsonReplacement(file, candidates) {
  const { intent } = durableJsonReplacementPaths(file);
  const intentInformation = await optionalLstat(intent);
  if (intentInformation === null) return null;
  if (!intentInformation.isFile() || intentInformation.isSymbolicLink()) {
    throw new Error('durable JSON replacement pending intent is not a regular file');
  }
  let pending;
  try { pending = JSON.parse((await readCanonicalEvidenceFile(intent)).bytes.toString('utf8')); }
  catch (error) { throw new Error(`durable JSON replacement pending intent is invalid: ${error.message}`); }
  if (typeof pending?.bytesBase64 !== 'string') {
    throw new Error('durable JSON replacement pending intent does not contain replacement bytes');
  }
  const pendingBytes = Buffer.from(pending.bytesBase64, 'base64');
  const expected = candidates.find(candidate => candidate.equals(pendingBytes));
  if (expected === undefined) {
    throw new Error('durable JSON replacement pending intent bytes differ from every authenticated replacement');
  }
  return expected;
}

async function recoverDurableJsonReplacement(file, expectedBytes) {
  if (!Buffer.isBuffer(expectedBytes)) throw new Error('durable JSON replacement recovery requires authenticated expected bytes');
  const resolved = path.resolve(file);
  const directory = path.dirname(resolved);
  const basename = path.basename(resolved);
  const { intent, temporary } = durableJsonReplacementPaths(resolved);
  const supported = new Set([path.basename(intent), path.basename(temporary)]);
  const unexpected = (await readdir(directory)).filter(name =>
    name.startsWith(`.${basename}.`) && !supported.has(name));
  if (unexpected.length !== 0) throw new Error(`durable JSON replacement has unexpected temporary evidence: ${unexpected.join(', ')}`);

  const intentInformation = await optionalLstat(intent);
  const temporaryInformation = await optionalLstat(temporary);
  if (intentInformation === null) {
    if (temporaryInformation !== null) throw new Error('durable JSON replacement temporary bytes have no authenticated pending intent');
    return false;
  }
  if (!intentInformation.isFile() || intentInformation.isSymbolicLink()) {
    throw new Error('durable JSON replacement pending intent is not a regular file');
  }
  let pending;
  try { pending = JSON.parse((await readCanonicalEvidenceFile(intent)).bytes.toString('utf8')); }
  catch (error) { throw new Error(`durable JSON replacement pending intent is invalid: ${error.message}`); }
  if (!pending || !sameJson(Object.keys(pending).sort(), [
    'bytes', 'bytesBase64', 'contract', 'digest', 'target', 'temporary',
  ]) || pending.contract !== 'mdlm-demo-durable-json-replacement@1' || pending.target !== resolved ||
      pending.temporary !== temporary || !Number.isSafeInteger(pending.bytes) || pending.bytes < 0 ||
      !/^sha256:[0-9a-f]{64}$/.test(pending.digest ?? '') || typeof pending.bytesBase64 !== 'string') {
    throw new Error('durable JSON replacement pending intent does not bind the exact target and temporary bytes');
  }
  const bytes = Buffer.from(pending.bytesBase64, 'base64');
  if (bytes.toString('base64') !== pending.bytesBase64 || bytes.length !== pending.bytes || sha256(bytes) !== pending.digest ||
      !bytes.equals(expectedBytes)) {
    throw new Error('durable JSON replacement pending intent bytes differ from the requested replacement');
  }

  if (temporaryInformation !== null) {
    if (!temporaryInformation.isFile() || temporaryInformation.isSymbolicLink() ||
        !(await readCanonicalEvidenceFile(temporary)).bytes.equals(bytes)) {
      throw new Error('durable JSON replacement temporary bytes differ from the authenticated pending intent');
    }
  } else {
    const targetInformation = await optionalLstat(resolved);
    if (targetInformation !== null) {
      if (!targetInformation.isFile() || targetInformation.isSymbolicLink()) {
        throw new Error('durable JSON replacement target is not a regular file');
      }
      if ((await readCanonicalEvidenceFile(resolved)).bytes.equals(bytes)) {
        await rm(intent);
        await syncDirectory(directory);
        return true;
      }
    }
    await writeSyncedExclusive(temporary, bytes);
    await syncDirectory(directory);
  }
  await rename(temporary, resolved);
  await syncDirectory(directory);
  await rm(intent);
  await syncDirectory(directory);
  return true;
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
function validateReconcileRequest(value) {
  const requestKeys = value?.relocation === undefined
    ? ['contract', 'evidence', 'repository', 'stateDirectory', 'timeoutMs']
    : ['contract', 'evidence', 'relocation', 'repository', 'stateDirectory', 'timeoutMs'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !sameJson(Object.keys(value).sort(), requestKeys.sort())) {
    throw new Error('reconcile request contains unsupported or missing fields');
  }
  for (const name of ['repository', 'stateDirectory']) {
    required(value[name], name);
    if (!path.isAbsolute(value[name])) throw new Error(`${name} must be an absolute path`);
  }
  requirePositiveSafeInteger(value.timeoutMs, 'timeoutMs');
  if (value.timeoutMs > 900_000) throw new Error('timeoutMs must not exceed 900000');
  if (value.relocation !== undefined) {
    const relocation = value.relocation;
    if (!relocation || typeof relocation !== 'object' || Array.isArray(relocation) ||
        !sameJson(Object.keys(relocation).sort(), ['contract', 'originalRoot', 'targetRoot']) ||
        relocation.contract !== 'mdlm-demo-reconcile-relocation@1') {
      throw new Error('relocation must contain exactly contract, originalRoot, and targetRoot');
    }
    for (const name of ['originalRoot', 'targetRoot']) {
      required(relocation[name], `relocation.${name}`);
      if (!path.isAbsolute(relocation[name])) throw new Error(`relocation.${name} must be an absolute path`);
    }
  }
  const keys = [
    'assignmentCheckpoint', 'authorization', 'commands', 'identity', 'initialSnapshot', 'outerCommand', 'postSnapshot',
    'processedAssignment', 'repositoryIdentity', 'request', 'result', 'shimConfig', 'stopPacket',
  ].sort();
  const evidence = value.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) ||
      !sameJson(Object.keys(evidence).sort(), keys)) {
    throw new Error(`reconcile evidence must contain exactly ${keys.join(', ')}`);
  }
  for (const name of ['request', 'repositoryIdentity', 'authorization', 'result', 'identity', 'shimConfig', 'processedAssignment', 'assignmentCheckpoint', 'stopPacket']) {
    validatePinnedFile(evidence[name], `evidence.${name}`);
  }
  const outerCommandKeys = Object.keys(evidence.outerCommand ?? {}).sort();
  if (!evidence.outerCommand || typeof evidence.outerCommand !== 'object' || Array.isArray(evidence.outerCommand) ||
      (!sameJson(outerCommandKeys, ['exit', 'stderr', 'stdout']) &&
       !sameJson(outerCommandKeys, ['exit', 'record', 'stderr', 'stdout']))) {
    throw new Error('evidence.outerCommand must contain stdout, stderr, and exit, with at most one command record');
  }
  for (const name of outerCommandKeys) {
    validatePinnedFile(evidence.outerCommand[name], `evidence.outerCommand.${name}`);
  }
  for (const name of ['initialSnapshot', 'postSnapshot']) {
    const pin = evidence[name];
    if (!pin || typeof pin !== 'object' || Array.isArray(pin) ||
        !sameJson(Object.keys(pin).sort(), ['digest', 'directory'])) {
      throw new Error(`evidence.${name} must contain exactly directory and digest`);
    }
    required(pin.directory, `evidence.${name}.directory`);
    if (!path.isAbsolute(pin.directory)) throw new Error(`evidence.${name}.directory must be an absolute path`);
    requireSha256(pin.digest, `evidence.${name}.digest`);
  }
  if (!Array.isArray(evidence.commands) || evidence.commands.length !== 2) {
    throw new Error('evidence.commands must contain exactly two command triplets');
  }
  for (const [index, triplet] of evidence.commands.entries()) {
    if (!triplet || typeof triplet !== 'object' || Array.isArray(triplet) ||
        !sameJson(Object.keys(triplet).sort(), ['record', 'stderr', 'stdout'])) {
      throw new Error(`evidence.commands[${index}] must contain exactly record, stdout, and stderr`);
    }
    for (const name of ['record', 'stdout', 'stderr']) validatePinnedFile(triplet[name], `evidence.commands[${index}].${name}`);
  }
}
function validateRunRequest(value) {
  const allowed = new Set([
    'adapterInputsPath', 'assignmentId', 'checkpointRecovery', 'commands', 'contract', 'correctionContinuation', 'decisionCatalogPath',
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
  if (value.correctionContinuation !== undefined) {
    const continuation = value.correctionContinuation;
    if (!continuation || typeof continuation !== 'object' || Array.isArray(continuation) ||
        !sameJson(Object.keys(continuation).sort(), ['digest', 'responsePath'])) {
      throw new Error('correctionContinuation must contain exactly responsePath and digest');
    }
    required(continuation.responsePath, 'correctionContinuation.responsePath');
    if (!path.isAbsolute(continuation.responsePath)) throw new Error('correctionContinuation.responsePath must be an absolute path');
    if (!/^sha256:[0-9a-f]{64}$/.test(continuation.digest ?? '')) {
      throw new Error('correctionContinuation.digest must be sha256:<64 lowercase hex>');
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
