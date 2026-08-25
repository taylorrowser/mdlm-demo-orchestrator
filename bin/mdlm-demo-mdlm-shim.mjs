#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../src/util.mjs';

const reserved = new Set(['realize-verification-environment@1', 'register-pilot-target@1', 'execute-verification-run@1']);

try {
  const configPath = process.env.MDLM_DEMO_SHIM_CONFIG;
  if (!configPath) throw new Error('MDLM_DEMO_SHIM_CONFIG is required');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config.contract !== 'mdlm-demo-shim-config@1') throw new Error('invalid shim configuration contract');
  const args = process.argv.slice(2);
  const input = await readStdin();
  const result = await runProcess(config.realMdlm, args, { cwd: process.cwd(), timeoutMs: config.timeoutMs, input: input.length === 0 ? undefined : input, env: process.env });
  if (args[0] === 'scenario' && args[1] === 'prepare' && result.exitStatus === 0) {
    const packet = JSON.parse(result.stdout.toString('utf8'));
    if (packet.contract !== 'mdlm-assignment-packet@2') throw new Error('scenario prepare did not return mdlm-assignment-packet@2');
    const assignment = packet.assignment?.id;
    const scenario = packet.scenario?.reference;
    const external = reserved.has(scenario);
    const checkpoint = assignment !== config.allowedAssignment;
    if (external || checkpoint) {
      await mkdir(config.stopDirectory, { recursive: true, mode: 0o700 });
      const packetPath = path.join(config.stopDirectory, `${safeId(assignment)}.json`);
      await writeOnceOrMatch(packetPath, result.stdout);
      const type = external && checkpoint
        ? 'accepted-assignment-then-external'
        : external ? 'external-adapter' : 'assignment-checkpoint';
      process.stdout.write(`${JSON.stringify({
        contract: 'mdlm-demo-reserved-stop@1', type,
        phase: 'before-worker', assignment, scenario, packetPath,
        ...(type === 'accepted-assignment-then-external' ? { completedAssignment: config.allowedAssignment } : {}),
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
  process.stderr.write(`${JSON.stringify({ contract: 'mdlm-demo-shim-error@1', error: error instanceof Error ? error.message : String(error) })}\n`);
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
function safeId(value) { return String(value).replace(/[^A-Za-z0-9._-]/g, '_'); }
