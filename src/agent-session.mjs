import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createCodexAdapter, createPiAdapter } from './agent-session-adapters.mjs';

const DESCRIPTOR_CONTRACT = 'mdlm-agent-session-descriptor@1';
const CODEX_SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const EVIDENCE_LOOKUP_INSTRUCTION =
  'For evidence lookup, use an exact path supplied in these instructions. Otherwise, search only the current workspace with rg or rg --files. If the evidence is absent there, stop and ask for its exact path; keep every search within the workspace.';

export class AgentSession {
  #adapters;
  #descriptorKey;
  #newId;
  #sessions = new Map();

  constructor({ adapters, descriptorKey, newId = randomUUID } = {}) {
    this.#adapters = adapters ?? {
      codex: createCodexAdapter(),
      pi: createPiAdapter(),
    };
    this.#descriptorKey = normalizeDescriptorKey(descriptorKey);
    this.#newId = newId;
  }

  async start(cwd, goal, release, harness) {
    const spec = harnessSpec(harness);
    const proposedId = this.#newId();
    const receipt = await this.#adapters[spec.kind].start({
      cwd,
      id: proposedId,
      prompt: agentPrompt(goal, release, spec),
      spec,
    });
    const session = Object.freeze({ id: receipt.sessionId ?? proposedId, harness: spec.kind });
    this.#sessions.set(sessionKey(session), {
      cwd, session, spec, turns: 1, lastReceipt: receipt, commandClosure: 'closed',
    });
    return session;
  }

  attach(descriptor) {
    if (this.#descriptorKey === undefined) {
      throw new Error('descriptorKey is required to attach a session');
    }
    authenticateDescriptor(descriptor, this.#descriptorKey);
    const current = descriptorSession(descriptor);
    const key = sessionKey(current.session);
    if (this.#sessions.has(key)) throw new Error(`session ${current.session.id} is already attached`);
    this.#sessions.set(key, current);
    return current.session;
  }

  async send(session, message) {
    const current = this.#session(session);
    if (current.commandClosure !== 'closed') {
      throw new Error(`session ${current.session.id} has an active or ambiguous command`);
    }
    current.commandClosure = 'open';
    try {
      const receipt = await this.#adapters[current.session.harness].send({
        cwd: current.cwd,
        id: current.session.id,
        message: `${message}\n\n${EVIDENCE_LOOKUP_INSTRUCTION}`,
        spec: current.spec,
      });
      current.turns += 1;
      current.lastReceipt = receipt;
      current.commandClosure = 'closed';
      return receipt;
    } catch (error) {
      current.commandClosure = 'ambiguous';
      throw error;
    }
  }

  observe(session) {
    const current = this.#session(session);
    const observation = {
      session: current.session,
      state: observationState(current),
      turns: current.turns,
      lastReceipt: current.lastReceipt,
    };
    if (this.#descriptorKey !== undefined) {
      observation.descriptor = createDescriptor(current, this.#descriptorKey);
    }
    return structuredClone(observation);
  }

  #session(session) {
    const current = this.#sessions.get(sessionKey(session));
    if (!current) throw new Error(`unknown session ${session?.id ?? ''}`);
    return current;
  }
}

function createDescriptor(current, key) {
  const payload = {
    contract: DESCRIPTOR_CONTRACT,
    session: current.session,
    cwd: current.cwd,
    spec: current.spec,
    turns: current.turns,
    lastReceipt: current.lastReceipt,
    commandClosure: current.commandClosure,
  };
  return {
    ...payload,
    authentication: { algorithm: 'hmac-sha256', digest: descriptorDigest(payload, key) },
  };
}

function authenticateDescriptor(descriptor, key) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new Error('session descriptor is required');
  }
  const { authentication, ...payload } = descriptor;
  if (authentication?.algorithm !== 'hmac-sha256' || !validDigest(authentication.digest)) {
    throw new Error('session descriptor authentication is missing or invalid');
  }
  const expected = Buffer.from(descriptorDigest(payload, key), 'hex');
  const actual = Buffer.from(authentication.digest, 'hex');
  if (!timingSafeEqual(actual, expected)) throw new Error('session descriptor authentication failed');
}

function descriptorSession(descriptor) {
  if (descriptor.contract !== DESCRIPTOR_CONTRACT) throw new Error('session descriptor contract is invalid');
  const { session, cwd, spec, turns, lastReceipt, commandClosure } = descriptor;
  if (!session || typeof session.id !== 'string' || session.id.length === 0 ||
      !['codex', 'pi'].includes(session.harness)) {
    throw new Error('session descriptor identity is missing or invalid');
  }
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('session descriptor cwd is missing');
  const normalizedSpec = harnessSpec(spec);
  if (normalizedSpec.kind !== session.harness || canonicalJson(normalizedSpec) !== canonicalJson(spec)) {
    throw new Error('session descriptor harness settings are inconsistent');
  }
  if (!Number.isSafeInteger(turns) || turns < 1) throw new Error('session descriptor turn count is invalid');
  if (commandClosure !== 'closed') throw new Error('session descriptor command closure is missing or ambiguous');
  validateReceipt(lastReceipt, session, cwd, normalizedSpec);
  return {
    cwd,
    session: Object.freeze(structuredClone(session)),
    spec: structuredClone(normalizedSpec),
    turns,
    lastReceipt: structuredClone(lastReceipt),
    commandClosure: 'closed',
  };
}

function validateReceipt(receipt, session, cwd, spec) {
  if (!receipt || receipt.sessionId !== session.id) {
    throw new Error('session descriptor receipt identity is missing or inconsistent');
  }
  if (typeof receipt.ok !== 'boolean' || !Number.isInteger(receipt.exitCode) ||
      receipt.ok !== (receipt.exitCode === 0) || typeof receipt.stdout !== 'string' ||
      typeof receipt.stderr !== 'string') {
    throw new Error('session descriptor closed receipt is inconsistent');
  }
  const command = receipt.command;
  const expectedFile = session.harness === 'pi' ? 'pi' : 'codex';
  if (!command || command.file !== expectedFile || command.cwd !== cwd ||
      !Array.isArray(command.args) || command.args.some(argument => typeof argument !== 'string')) {
    throw new Error('session descriptor receipt command is inconsistent');
  }
  if (session.harness === 'pi' &&
      (option(command.args, '--session-id') !== session.id || option(command.args, '--model') !== spec.model ||
       option(command.args, '--thinking') !== spec.thinking)) {
    throw new Error('session descriptor receipt command does not match its identity or harness settings');
  }
  if (session.harness === 'codex') {
    validateCodexCommand(command.args, session, cwd, spec);
  }
}

function validateCodexCommand(args, session, cwd, spec) {
  const emptyDestination = args.includes('--skip-git-repo-check');
  if (emptyDestination !== spec.allowEmptyDestination || args[0] !== 'exec') {
    throw new Error('session descriptor receipt command does not match its harness settings');
  }
  if (args[1] === 'resume') {
    if (args[2] !== '--json' || option(args, '-m') !== spec.model ||
        !hasOption(args, '-c', `model_reasoning_effort=${JSON.stringify(spec.effort)}`) ||
        !hasOption(args, '-c', `sandbox_mode=${JSON.stringify(spec.sandbox)}`) ||
        args.at(-2) !== session.id || args.at(-1) !== '-') {
      throw new Error('session descriptor receipt command does not match its identity or harness settings');
    }
    return;
  }
  if (args[1] !== '--json' || option(args, '-C') !== cwd || option(args, '-m') !== spec.model ||
      option(args, '--sandbox') !== spec.sandbox ||
      option(args, '-c') !== `model_reasoning_effort=${JSON.stringify(spec.effort)}` || args.at(-1) !== '-') {
    throw new Error('session descriptor receipt command does not match its harness settings');
  }
}

function observationState(current) {
  if (current.commandClosure === 'open') return 'transport-active';
  if (current.commandClosure === 'ambiguous') return 'transport-ambiguous';
  return current.lastReceipt.ok ? 'turn-complete' : 'transport-failed';
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function hasOption(args, name, value) {
  return args.some((argument, index) => argument === name && args[index + 1] === value);
}

function descriptorDigest(payload, key) {
  return createHmac('sha256', key).update(canonicalJson(payload)).digest('hex');
}

function normalizeDescriptorKey(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.length > 0) return Buffer.from(value);
  if (ArrayBuffer.isView(value) && value.byteLength > 0) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error('descriptorKey must be a non-empty string or byte array');
}

function validDigest(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sessionKey(session) {
  return `${session?.harness}:${session?.id}`;
}

function harnessSpec(value) {
  const spec = typeof value === 'string' ? { kind: value } : value;
  if (spec?.kind === 'codex') {
    const sandbox = spec.sandbox ?? 'workspace-write';
    if (!CODEX_SANDBOXES.has(sandbox)) {
      throw new Error("Codex sandbox must be 'read-only', 'workspace-write', or 'danger-full-access'");
    }
    return {
      kind: 'codex',
      model: spec.model ?? 'gpt-5.6-terra',
      effort: spec.effort ?? 'medium',
      sandbox,
      allowEmptyDestination: spec.allowEmptyDestination === true,
    };
  }
  if (spec?.kind === 'pi') {
    return { kind: 'pi', model: spec.model ?? 'openrouter/z-ai/glm-5.3-flash', thinking: spec.thinking ?? 'low' };
  }
  throw new Error("harness must be 'codex' or 'pi'");
}

function agentPrompt(goal, release, spec) {
  const releaseText = typeof release === 'string' ? release : JSON.stringify(release);
  const repositoryInstruction = spec.kind === 'codex' && spec.allowEmptyDestination
    ? 'The working directory is the exact repository root and may begin empty. Run `mdlm init .` before any Git or repository command, then keep all work in that directory. '
    : 'Use the repository identified by the goal as the repository root. ';
  return `Goal:\n${goal}\n\nMDLM release:\n${releaseText}\n\n` +
    `Work autonomously toward the goal using the public mdlm CLI. ${repositoryInstruction}` +
    'Run mdlm next whenever you finish the current work. Read each result and decide what to do. ' +
    'An Assignment is work, never a stop: execute it, submit or settle it as the public CLI directs, then run mdlm next again. Stop only on a typed terminal outcome, Attention Required, or an exact blocker that prevents the current work. ' +
    `${EVIDENCE_LOOKUP_INSTRUCTION} ` +
    'The Goal and MDLM release text are context only. They never answer or authorize an Attention Required Assignment. ' +
    'On every Attention Required outcome, stop and report the exact Assignment, question, required authority, and impact. ' +
    'Use --authority only after a later manager message names that exact Assignment and supplies the authority holder\'s decision. Then continue.';
}
