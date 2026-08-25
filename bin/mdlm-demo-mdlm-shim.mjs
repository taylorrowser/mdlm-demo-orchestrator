#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateScenarioPrepare } from '../src/contracts.mjs';
import { runProcess } from '../src/util.mjs';

const reserved = new Set(['realize-verification-environment@1', 'register-pilot-target@1', 'execute-verification-run@1']);
class CommandContractError extends Error {
  constructor(command, message) { super(message); this.command = command; }
}

try {
  const configPath = process.env.MDLM_DEMO_SHIM_CONFIG;
  if (!configPath) throw new Error('MDLM_DEMO_SHIM_CONFIG is required');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config.contract !== 'mdlm-demo-shim-config@1') throw new Error('invalid shim configuration contract');
  const args = process.argv.slice(2);
  const input = await readStdin();
  const result = await runProcess(config.realMdlm, args, { cwd: process.cwd(), timeoutMs: config.timeoutMs, input: input.length === 0 ? undefined : input, env: process.env });
  if (args[0] === 'scenario' && args[1] === 'prepare' && result.exitStatus === 0) {
    let packet;
    try {
      if (typeof args[2] !== 'string' || args[2].length === 0) throw new Error('scenario prepare command lacks an Assignment ID');
      packet = validateScenarioPrepare(JSON.parse(result.stdout.toString('utf8')), {
        assignmentId: args[2],
        package: config.package,
        ...(args[2] === config.allowedAssignment ? { repository: config.repository } : {}),
      });
    } catch (error) {
      throw new CommandContractError('scenario.prepare', error instanceof Error ? error.message : String(error));
    }
    const assignment = packet.assignment.id;
    const scenario = packet.scenario?.reference;
    const external = reserved.has(scenario);
    const checkpoint = assignment !== config.allowedAssignment;
    const shimDirectory = path.dirname(path.resolve(configPath));
    const processedPath = path.join(shimDirectory, 'processed-assignment.json');
    const processedBytes = jsonBytes({
      contract: 'mdlm-demo-shim-processed-assignment@1',
      assignment: config.allowedAssignment,
      package: config.package,
      repository: config.repository,
    });
    if (!checkpoint) await writeOnceOrMatch(processedPath, processedBytes);
    if (external || checkpoint) {
      if (checkpoint) await requireExactFile(processedPath, processedBytes, 'checkpoint occurred before the allowed Assignment was processed');
      const type = external && checkpoint
        ? 'accepted-assignment-then-external'
        : external ? 'external-adapter' : 'assignment-checkpoint';
      if (checkpoint) {
        await writeOnceOrMatch(path.join(shimDirectory, 'assignment-checkpoint.json'), jsonBytes({
          contract: 'mdlm-demo-shim-assignment-checkpoint@1',
          completedAssignment: config.allowedAssignment,
          assignment,
          scenario,
        }));
      }
      await mkdir(config.stopDirectory, { recursive: true, mode: 0o700 });
      const packetPath = path.join(config.stopDirectory, `${safeId(assignment)}.json`);
      await writeOnceOrMatch(packetPath, result.stdout);
      process.stdout.write(`${JSON.stringify({
        contract: 'mdlm-demo-reserved-stop@1', type,
        phase: 'before-worker', assignment, scenario, packetPath,
        ...(checkpoint ? { completedAssignment: config.allowedAssignment } : {}),
      })}\n`);
      process.stderr.write(result.stderr);
      process.exitCode = 97;
    } else {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exitCode = result.exitStatus ?? 1;
    }
  } else {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitStatus ?? 1;
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    contract: 'mdlm-demo-shim-error@1',
    type: error instanceof CommandContractError ? 'command-contract-failure' : 'shim-failure',
    ...(error instanceof CommandContractError ? { command: error.command } : {}),
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 98;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function writeOnceOrMatch(file, bytes) {
  try { await writeFile(file, bytes, { flag: 'wx', mode: 0o400 }); }
  catch (error) {
    if (error.code !== 'EEXIST' || !Buffer.from(await readFile(file)).equals(bytes)) throw new Error('intercepted packet bytes drifted');
  }
}
async function requireExactFile(file, bytes, message) {
  try {
    if (!Buffer.from(await readFile(file)).equals(bytes)) throw new Error(message);
  } catch (error) {
    if (error.message === message) throw error;
    throw new Error(message);
  }
}
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value)}\n`); }
function safeId(value) { return String(value).replace(/[^A-Za-z0-9._-]/g, '_'); }
