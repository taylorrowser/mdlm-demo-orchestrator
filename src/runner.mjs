import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseStrictJson } from './strict-json.mjs';
import { commandSucceeded, controlledEnvironment, runProcess } from './util.mjs';

const nextOutcomes = new Set([
  'assignment',
  'attention-required',
  'profile-boundary-reached',
  'lifecycle-complete',
  'process-dead-end',
  'invalid',
]);
const terminalOutcomes = new Set([
  'profile-boundary-reached',
  'lifecycle-complete',
  'process-dead-end',
  'invalid',
]);
const submissionOutcomes = new Set(['accepted', 'rejected', 'settlement-required']);

export function validateRunRequest(value) {
  const keys = ['commands', 'contract', 'repository', 'stateDirectory', 'timeoutMs'];
  exactObject(value, value?.authoritySupply === undefined ? keys : [...keys, 'authoritySupply'], 'run request');
  if (value.contract !== 'mdlm-demo-run-request@2') throw new Error("run request.contract must equal 'mdlm-demo-run-request@2'");
  absolutePath(value.repository, 'repository');
  absolutePath(value.stateDirectory, 'stateDirectory');
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 900_000) {
    throw new Error('timeoutMs must be a positive safe integer no greater than 900000');
  }
  exactObject(value.commands, ['mdlm', 'operator'], 'commands');
  validateCommand(value.commands.mdlm, 'commands.mdlm', false);
  validateCommand(value.commands.operator, 'commands.operator', true);
  if (value.authoritySupply !== undefined) validateAuthoritySupply(value.authoritySupply);
  return value;
}

export function validateNextOutcome(value) {
  object(value, 'next outcome');
  if (value.contract !== 'mdlm-next@2') throw new Error("next contract must equal 'mdlm-next@2'");
  if (!nextOutcomes.has(value.outcome)) throw new Error('next returned an unsupported outcome');
  if (value.outcome === 'assignment' || value.outcome === 'attention-required') {
    const assignment = object(value.assignment, 'next assignment');
    nonempty(assignment.id, 'next assignment.id');
    const packet = object(assignment.packet, 'next assignment.packet');
    if (packet.contract !== 'mdlm-assignment-packet@3') throw new Error("packet contract must equal 'mdlm-assignment-packet@3'");
    if (packet.assignment?.id !== assignment.id) throw new Error('packet Assignment differs from next Assignment');
    object(packet.responseScaffold, 'packet.responseScaffold');
    object(packet.responseSchema, 'packet.responseSchema');
  }
  if (value.outcome === 'attention-required') {
    const requirement = object(value.authorityRequirement, 'authorityRequirement');
    if (requirement.mode !== 'attended') throw new Error("authorityRequirement.mode must equal 'attended'");
    nonempty(requirement.authority, 'authorityRequirement.authority');
  }
  return value;
}

export function validateSubmissionOutcome(value, assignment, responseDigest) {
  object(value, 'submission outcome');
  if (value.contract !== 'mdlm-submission-outcome@1') {
    throw new Error("submission contract must equal 'mdlm-submission-outcome@1'");
  }
  if (!submissionOutcomes.has(value.outcome)) throw new Error('submission returned an unsupported outcome');
  if (value.assignment?.id !== assignment) throw new Error('submission Assignment differs from next Assignment');
  if (value.responseDigest !== responseDigest) throw new Error('submission response digest differs from captured response');
  if (value.outcome === 'rejected') {
    if (!Array.isArray(value.diagnostics) || value.retryable !== true || value.correctionConsumed !== false) {
      throw new Error('rejected submission must be retryable without consuming correction');
    }
  }
  if (value.outcome === 'settlement-required') validateSettlement(value);
  if (value.outcome === 'accepted') {
    object(value.receipt, 'accepted receipt');
    validateSettlement(value);
  }
  return value;
}

export async function run(request) {
  validateRunRequest(request);
  const repository = await requireDirectory(request.repository, 'repository');
  const stateDirectory = path.resolve(request.stateDirectory);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const commands = {
    mdlm: await authenticateCommand(request.commands.mdlm, 'MDLM'),
    operator: await authenticateCommand(request.commands.operator, 'operator'),
  };
  const gitDirectory = await gitCommonDirectory(repository, request.timeoutMs);
  const release = await acquireLock(gitDirectory);
  try {
    const journalPath = path.join(stateDirectory, 'transaction.json');
    const journal = await optionalJson(journalPath);
    if (journal !== null) {
      const recovered = await recover(journal, journalPath, repository, commands, request.authoritySupply, request.timeoutMs);
      if (recovered !== null) return recovered;
    }

    const nextProcess = await invoke(commands.mdlm.path, ['next', '--json'], repository, request.timeoutMs);
    await recordNextCommand(stateDirectory, nextProcess);
    if (!commandSucceeded(nextProcess)) throw new Error('mdlm next failed');
    const next = validateNextOutcome(parseJson(nextProcess.stdout, 'mdlm next'));
    const authority = authorityFor(next, request.authoritySupply);
    if (next.outcome === 'attention-required' && authority === undefined) {
      return { contract: 'mdlm-demo-run-result@2', status: 'attention-required', next };
    }
    if (terminalOutcomes.has(next.outcome)) {
      return { contract: 'mdlm-demo-run-result@2', status: next.outcome, next };
    }

    const assignment = next.assignment.id;
    const packetBytes = canonicalBytes(next.assignment.packet);
    const assignmentDirectory = path.join(stateDirectory, safeName(assignment));
    await mkdir(assignmentDirectory, { recursive: true, mode: 0o700 });
    await writeOnceOrMatch(path.join(assignmentDirectory, 'packet.json'), packetBytes);

    const operator = await invoke(
      commands.operator.path,
      commands.operator.args,
      repository,
      request.timeoutMs,
      packetBytes,
    );
    if (!commandSucceeded(operator)) throw new Error('operator failed before submission');
    const response = parseJson(operator.stdout, 'operator response');
    if (response.contract !== 'mdlm-assignment-response@2' || response.assignment !== assignment) {
      throw new Error('operator response contract or Assignment differs');
    }
    const responseBytes = canonicalBytes(response);
    const responseDigest = digest(responseBytes);
    const responsePath = path.join(assignmentDirectory, `${responseDigest.slice(7)}.response.json`);
    await writeOnceOrMatch(responsePath, responseBytes);

    const captured = {
      contract: 'mdlm-demo-transaction@3',
      phase: 'captured',
      assignment,
      repository,
      commands,
      package: next.assignment.packet.package,
      packetRepository: next.assignment.packet.repository,
      packetDigest: digest(packetBytes),
      packetPath: path.join(assignmentDirectory, 'packet.json'),
      responseDigest,
      responsePath,
      ...(request.authoritySupply === undefined ? {} : { authoritySupply: request.authoritySupply }),
    };
    await durableJson(journalPath, captured);
    await durableJson(journalPath, { ...captured, phase: 'submitting' });

    const submissionProcess = await invoke(
      commands.mdlm.path,
      ['scenario', 'submit', ...(authority === undefined ? [] : ['--authority', authority]), '--json'],
      repository,
      request.timeoutMs,
      responseBytes,
    );
    if (!commandSucceeded(submissionProcess)) {
      const uncertain = { ...captured, phase: 'settlement-required', settlement: { assignment } };
      await durableJson(journalPath, uncertain);
      return settlementResult(uncertain, 'publication-closure-uncertain');
    }
    let submission;
    try {
      submission = validateSubmissionOutcome(
        parseJson(submissionProcess.stdout, 'submission outcome'),
        assignment,
        responseDigest,
      );
    } catch {
      const uncertain = { ...captured, phase: 'settlement-required', settlement: { assignment } };
      await durableJson(journalPath, uncertain);
      return settlementResult(uncertain, 'publication-closure-uncertain');
    }
    await durableJson(journalPath, {
      ...captured,
      phase: submission.outcome,
      ...(submission.settlement ? { settlement: submission.settlement } : {}),
      submission,
    });
    return { contract: 'mdlm-demo-run-result@2', status: submission.outcome, next, submission };
  } finally {
    await release();
  }
}

async function recordNextCommand(stateDirectory, process) {
  const directory = path.join(stateDirectory, 'next-commands');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const names = await readdir(directory);
  const ordinal = names.reduce((maximum, name) => {
    const match = /^(\d{6})\.next\.json$/u.exec(name);
    return match === null ? maximum : Math.max(maximum, Number(match[1]));
  }, 0) + 1;
  const stem = String(ordinal).padStart(6, '0');
  const stdoutPath = path.join(directory, `${stem}.stdout`);
  const stderrPath = path.join(directory, `${stem}.stderr`);
  await durableBytes(stdoutPath, process.stdout);
  await durableBytes(stderrPath, process.stderr);
  await durableJson(path.join(directory, `${stem}.next.json`), {
    contract: 'mdlm-demo-command-evidence@1',
    command: 'next',
    argv: process.argv,
    cwd: process.cwd,
    startedAt: process.startedAt,
    completedAt: process.completedAt,
    timeoutMs: process.timeoutMs,
    timedOut: process.timedOut,
    outputLimitExceeded: process.outputLimitExceeded,
    observedOutputBytes: process.observedOutputBytes,
    exitStatus: process.exitStatus,
    signal: process.signal,
    spawnError: process.spawnError,
    stdout: { path: stdoutPath, bytes: process.stdout.length, digest: digest(process.stdout) },
    stderr: { path: stderrPath, bytes: process.stderr.length, digest: digest(process.stderr) },
  });
}

async function recover(journal, journalPath, repository, commands, authoritySupply, timeoutMs) {
  if (journal.contract !== 'mdlm-demo-transaction@3') throw new Error('transaction journal contract is invalid');
  await authenticateRecovery(journal, repository, commands, authoritySupply);
  if (journal.phase === 'accepted') {
    return { contract: 'mdlm-demo-run-result@2', status: 'accepted', submission: journal.submission, recovered: true };
  }
  if (journal.phase === 'submitting' || journal.phase === 'settlement-required') {
    const settlement = journal.settlement ?? { assignment: journal.assignment };
    const identity = settlement.execution ?? settlement.assignment;
    const inspected = await invoke(commands.mdlm.path, ['scenario', 'settlement', identity, '--json'], repository, timeoutMs);
    if (commandSucceeded(inspected)) {
      try {
        const submission = validateSubmissionOutcome(
          parseJson(inspected.stdout, 'settlement outcome'),
          journal.assignment,
          journal.responseDigest,
        );
        await durableJson(journalPath, {
          ...journal,
          phase: submission.outcome,
          ...(submission.settlement ? { settlement: submission.settlement } : {}),
          submission,
        });
        return { contract: 'mdlm-demo-run-result@2', status: submission.outcome, submission, recovered: true };
      } catch {
        // An unrecognized inspection result cannot authorize replay.
      }
    }
    return settlementResult({ ...journal, settlement }, 'publication-closure-uncertain');
  }
  return null;
}

async function authenticateRecovery(journal, repository, commands, authoritySupply) {
  if (journal.repository !== repository) throw new Error('transaction repository differs from the canonical repository');
  if (!sameJson(journal.commands, commands)) throw new Error('transaction command pins differ');
  if (journal.authoritySupply !== undefined) validateAuthoritySupply(journal.authoritySupply);
  if (!sameAuthoritySupply(journal.authoritySupply, authoritySupply)) throw new Error('transaction authority supply differs');
  object(journal.package, 'transaction package');
  object(journal.packetRepository, 'transaction packet repository');
  absolutePath(journal.packetPath, 'transaction packetPath');
  const packetBytes = await readFile(journal.packetPath);
  if (digest(packetBytes) !== journal.packetDigest) throw new Error('transaction packet digest differs');
  const packet = object(parseJson(packetBytes, 'transaction packet'), 'transaction packet');
  if (packet.contract !== 'mdlm-assignment-packet@3' || packet.assignment?.id !== journal.assignment) {
    throw new Error('transaction packet identity differs');
  }
  if (!sameJson(packet.package, journal.package) || !sameJson(packet.repository, journal.packetRepository)) {
    throw new Error('transaction packet package or repository identity differs');
  }
  if (journal.submission !== undefined) {
    validateSubmissionOutcome(journal.submission, journal.assignment, journal.responseDigest);
  }
}

function authorityFor(next, supply) {
  if (next.outcome !== 'attention-required') {
    if (supply !== undefined) throw new Error('authoritySupply is only valid for attention-required');
    return undefined;
  }
  if (supply === undefined) return undefined;
  if (supply.assignment !== next.assignment.id) throw new Error('authoritySupply Assignment differs from next Assignment');
  if (supply.authority !== next.authorityRequirement.authority) {
    throw new Error('authoritySupply authority differs from the declared authority');
  }
  return supply.authority;
}

function validateAuthoritySupply(value) {
  exactObject(value, ['assignment', 'authority'], 'authoritySupply');
  nonempty(value.assignment, 'authoritySupply.assignment');
  nonempty(value.authority, 'authoritySupply.authority');
}

function sameAuthoritySupply(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return left.assignment === right.assignment && left.authority === right.authority;
}

function settlementResult(journal, reason) {
  return {
    contract: 'mdlm-demo-run-result@2',
    status: 'settlement-required',
    submission: {
      contract: 'mdlm-submission-outcome@1',
      outcome: 'settlement-required',
      assignment: { id: journal.assignment },
      responseDigest: journal.responseDigest,
      settlement: journal.settlement,
      reason,
      orchestration: { action: 'inspect-settlement', replay: false },
    },
  };
}

function validateSettlement(value) {
  const settlement = object(value.settlement, 'submission settlement');
  nonempty(settlement.assignment, 'submission settlement.assignment');
  if (value.assignment?.id !== settlement.assignment) throw new Error('settlement Assignment differs');
  if (settlement.execution !== undefined) nonempty(settlement.execution, 'submission settlement.execution');
}

async function authenticateCommand(command, label) {
  const canonical = await realpath(command.path);
  const metadata = await lstat(canonical);
  if (!metadata.isFile()) throw new Error(`${label} command is not a regular file`);
  const bytes = await readFile(canonical);
  if (digest(bytes) !== command.digest) throw new Error(`${label} command digest differs`);
  return { ...command, path: canonical };
}

async function gitCommonDirectory(repository, timeoutMs) {
  const result = await invoke('/usr/bin/git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], repository, timeoutMs);
  if (!commandSucceeded(result)) throw new Error('repository Git directory is unavailable');
  return requireDirectory(result.stdout.toString('utf8').trim(), 'Git directory');
}

async function acquireLock(gitDirectory) {
  const lock = path.join(gitDirectory, 'mdlm-demo-runner.lock');
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('runner lock is already held; process absence does not authorize reclamation');
    throw error;
  }
  await writeFile(path.join(lock, 'owner.json'), `${JSON.stringify({ pid: process.pid })}\n`, { flag: 'wx', mode: 0o600 });
  return async () => rm(lock, { recursive: true });
}

async function invoke(program, args, cwd, timeoutMs, input) {
  return runProcess(program, args, { cwd, timeoutMs, input, env: controlledEnvironment() });
}

async function durableJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  await durableBytes(file, bytes);
}

async function durableBytes(file, bytes) {
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  const directory = await open(path.dirname(file), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function writeOnceOrMatch(file, bytes) {
  try {
    await writeFile(file, bytes, { flag: 'wx', mode: 0o400 });
  } catch (error) {
    if (error?.code !== 'EEXIST' || !(await readFile(file)).equals(bytes)) throw new Error('immutable Assignment evidence differs');
  }
}

async function optionalJson(file) {
  try { return parseJson(await readFile(file), 'transaction journal'); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function parseJson(bytes, label) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return parseStrictJson(text, label);
}

function canonicalBytes(value) { return Buffer.from(`${JSON.stringify(value)}\n`); }
function digest(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function safeName(value) { return value.replace(/[^A-Za-z0-9._-]/g, '_'); }
async function requireDirectory(value, label) {
  const canonical = await realpath(value);
  if (!(await lstat(canonical)).isDirectory()) throw new Error(`${label} is not a directory`);
  return canonical;
}
function validateCommand(value, label, args) {
  exactObject(value, args ? ['args', 'digest', 'path'] : ['digest', 'path'], label);
  absolutePath(value.path, `${label}.path`);
  if (!/^sha256:[0-9a-f]{64}$/.test(value.digest ?? '')) throw new Error(`${label}.digest is invalid`);
  if (args && (!Array.isArray(value.args) || value.args.some(item => typeof item !== 'string' || item.includes('\0')))) {
    throw new Error(`${label}.args must be an array of strings`);
  }
}
function absolutePath(value, label) {
  nonempty(value, label);
  if (!path.isAbsolute(value) || value.includes('\0')) throw new Error(`${label} must be an absolute path`);
}
function exactObject(value, keys, label) {
  object(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly ${expected.join(', ')}`);
  }
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function nonempty(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`);
}
