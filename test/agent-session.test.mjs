import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSession } from '../src/agent-session.mjs';
import { createCodexAdapter, createPiAdapter } from '../src/agent-session-adapters.mjs';

test('AgentSession exposes only start, send, and observe and leaves MDLM decisions to the agent', async () => {
  const calls = [];
  const fake = {
    async start(input) {
      calls.push(['start', input]);
      return { ok: true, sessionId: input.id, stdout: 'working', stderr: '', exitCode: 0 };
    },
    async send(input) {
      calls.push(['send', input]);
      return { ok: true, sessionId: input.id, stdout: 'waiting for stakeholder', stderr: '', exitCode: 0 };
    },
  };
  const agent = new AgentSession({ adapters: { codex: fake, pi: fake }, newId: () => 'session-1' });
  assert.deepEqual(
    Object.getOwnPropertyNames(AgentSession.prototype).filter(name => name !== 'constructor').sort(),
    ['observe', 'send', 'start'],
  );
  const session = await agent.start('/tmp/product', 'Build a byte counter.', 'mdlm@next', 'pi');
  assert.deepEqual(session, { id: 'session-1', harness: 'pi' });
  assert.match(calls[0][1].prompt, /Run mdlm next whenever/);
  assert.match(calls[0][1].prompt, /report the exact question and impact/);
  assert.match(calls[0][1].prompt, /An Assignment is work, never a stop/);
  assert.match(calls[0][1].prompt, /Stop only on a typed terminal outcome, Attention Required, or an exact blocker/);
  assert.doesNotMatch(calls[0][1].prompt, /scenario submit|authority envelope|prepare response|settlement/);
  await agent.send(session, 'Stakeholder answer: accept UTF-8 bytes. Continue.');
  assert.equal(agent.observe(session).turns, 2);
});

test('start prompt uses a goal-named absent child as the repository root', async () => {
  let prompt;
  const fake = {
    async start(input) {
      prompt = input.prompt;
      return { ok: true, sessionId: input.id, stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const agent = new AgentSession({ adapters: { codex: fake }, newId: () => 'session-child' });
  await agent.start(
    '/tmp/harness-workspace',
    'Create the absent child repository products/byte-counter and build a byte counter there.',
    'mdlm@next',
    { kind: 'codex', allowEmptyDestination: true },
  );

  assert.match(prompt, /working directory is a harness workspace/);
  assert.match(prompt, /goal names an absent child repository, create and use that child as the repository root/);
  assert.match(prompt, /run git init \. and initialize MDLM inside that child/);
  assert.doesNotMatch(prompt, /working directory itself is the repository root/);
});

test('Codex and Pi adapters render only persistent session commands', async () => {
  const commands = [];
  const execute = async command => {
    commands.push(command);
    return command.file === 'codex'
      ? { exitCode: 0, stdout: '{"type":"thread.started","thread_id":"codex-1"}\n', stderr: '' }
      : { exitCode: 0, stdout: '{"type":"agent_end"}\n', stderr: '' };
  };
  const agent = new AgentSession({
    adapters: { codex: createCodexAdapter(execute), pi: createPiAdapter(execute) },
    newId: () => 'pi-1',
  });
  const codex = await agent.start('/tmp/product', 'Count bytes.', 'release.json', {
    kind: 'codex',
    allowEmptyDestination: true,
  });
  await agent.send(codex, 'Continue.');
  await agent.start('/tmp/existing-product', 'Count bytes.', 'release.json', 'codex');
  const pi = await agent.start('/tmp/product', 'Count bytes.', 'release.json', 'pi');
  await agent.send(pi, 'Continue.');

  assert.deepEqual(commands.map(command => [command.file, command.args.slice(0, 3)]), [
    ['codex', ['exec', '--json', '-C']],
    ['codex', ['exec', 'resume', '--json']],
    ['codex', ['exec', '--json', '-C']],
    ['pi', ['--print', '--mode', 'json']],
    ['pi', ['--print', '--mode', 'json']],
  ]);
  assert.equal(commands[0].input.includes('Run mdlm next whenever'), true);
  assert.equal(commands[0].args.includes('--skip-git-repo-check'), true);
  assert.equal(commands[1].args.includes('--skip-git-repo-check'), true);
  assert.equal(commands[2].args.includes('--skip-git-repo-check'), false);
  assert.deepEqual(commands[1].args.slice(-2), ['codex-1', '-']);
  assert.equal(commands[3].args.includes('pi-1'), true);
  assert.equal(commands[4].args.includes('pi-1'), true);
});
