import { randomUUID } from 'node:crypto';
import { createCodexAdapter, createPiAdapter } from './agent-session-adapters.mjs';

export class AgentSession {
  #adapters;
  #newId;
  #sessions = new Map();

  constructor({ adapters, newId = randomUUID } = {}) {
    this.#adapters = adapters ?? {
      codex: createCodexAdapter(),
      pi: createPiAdapter(),
    };
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
    this.#sessions.set(sessionKey(session), { cwd, session, spec, turns: 1, lastReceipt: receipt });
    return session;
  }

  async send(session, message) {
    const current = this.#session(session);
    const receipt = await this.#adapters[current.session.harness].send({
      cwd: current.cwd,
      id: current.session.id,
      message,
      spec: current.spec,
    });
    current.turns += 1;
    current.lastReceipt = receipt;
    return receipt;
  }

  observe(session) {
    const current = this.#session(session);
    return structuredClone({
      session: current.session,
      state: current.lastReceipt.ok ? 'turn-complete' : 'transport-failed',
      turns: current.turns,
      lastReceipt: current.lastReceipt,
    });
  }

  #session(session) {
    const current = this.#sessions.get(sessionKey(session));
    if (!current) throw new Error(`unknown session ${session?.id ?? ''}`);
    return current;
  }
}

function sessionKey(session) {
  return `${session?.harness}:${session?.id}`;
}

function harnessSpec(value) {
  const spec = typeof value === 'string' ? { kind: value } : value;
  if (spec?.kind === 'codex') {
    return {
      kind: 'codex',
      model: spec.model ?? 'gpt-5.6-terra',
      effort: spec.effort ?? 'medium',
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
    ? 'The working directory is a harness workspace and may contain injected harness metadata. When the goal names an absent child repository, create and use that child as the repository root; run git init . and initialize MDLM inside that child. Do not initialize the harness workspace itself. '
    : 'Use the repository identified by the goal as the repository root. ';
  return `Goal:\n${goal}\n\nMDLM release:\n${releaseText}\n\n` +
    `Work autonomously toward the goal using the public mdlm CLI. ${repositoryInstruction}` +
    'Run mdlm next whenever you finish the current work. Read each result and decide what to do. ' +
    'When MDLM requires stakeholder authority you do not have, stop and report the exact question and impact. ' +
    'Continue after the stakeholder answer arrives in a later message.';
}
