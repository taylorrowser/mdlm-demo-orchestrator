import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { AgentSession } from 'mdlm-demo-orchestrator';
import { createCodexAdapter, createPiAdapter } from 'mdlm-demo-orchestrator/adapters';

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
    ['attach', 'observe', 'send', 'start'],
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

test('AgentSession authenticates and reattaches a closed session without running a turn', async () => {
  const calls = [];
  const fake = {
    async start(input) {
      calls.push(['start', input]);
      return {
        ok: true,
        sessionId: input.id,
        stdout: 'waiting',
        stderr: '',
        exitCode: 0,
        command: {
          file: 'pi',
          args: ['--session-id', input.id, '--model', input.spec.model, '--thinking', input.spec.thinking],
          cwd: input.cwd,
        },
      };
    },
    async send(input) {
      calls.push(['send', input]);
      return {
        ok: true,
        sessionId: input.id,
        stdout: 'continued',
        stderr: '',
        exitCode: 0,
        command: {
          file: 'pi',
          args: ['--session-id', input.id, '--model', input.spec.model, '--thinking', input.spec.thinking],
          cwd: input.cwd,
        },
      };
    },
  };
  const descriptorKey = 'qualified-host-secret';
  const original = new AgentSession({
    adapters: { pi: fake },
    descriptorKey,
    newId: () => 'session-reattach',
  });
  const session = await original.start('/tmp/product', 'Count bytes.', 'mdlm@next', {
    kind: 'pi', model: 'openrouter/z-ai/glm-5.3-flash', thinking: 'low',
  });
  const before = original.observe(session);
  const persisted = JSON.parse(JSON.stringify(before.descriptor));

  const restored = new AgentSession({ adapters: { pi: fake }, descriptorKey });
  assert.deepEqual(restored.attach(persisted), session);
  assert.equal(calls.length, 1);
  assert.deepEqual(restored.observe(session), before);

  await restored.send(session, 'Stakeholder answer: approve. Continue.');
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], 'send');
  assert.deepEqual(calls[1][1], {
    cwd: '/tmp/product',
    id: 'session-reattach',
    message: 'Stakeholder answer: approve. Continue.\n\nFor evidence lookup, use an exact path supplied in these instructions. Otherwise, search only the current workspace with rg or rg --files. If the evidence is absent there, stop and ask for its exact path; keep every search within the workspace.',
    spec: { kind: 'pi', model: 'openrouter/z-ai/glm-5.3-flash', thinking: 'low' },
  });
  assert.equal(restored.observe(session).turns, 2);
});

test('AgentSession rejects mismatched identity and ambiguous command closure on attach', async () => {
  const descriptorKey = 'qualified-host-secret';
  const fake = {
    async start(input) {
      return {
        ok: true,
        sessionId: input.id,
        stdout: 'waiting',
        stderr: '',
        exitCode: 0,
        command: { file: 'pi', args: ['--session-id', input.id], cwd: input.cwd },
      };
    },
  };
  const original = new AgentSession({
    adapters: { pi: fake }, descriptorKey, newId: () => 'session-reattach',
  });
  const session = await original.start('/tmp/product', 'Count bytes.', 'mdlm@next', 'pi');
  const descriptor = original.observe(session).descriptor;

  assert.throws(
    () => new AgentSession({ adapters: { pi: fake }, descriptorKey: 'different-secret' }).attach(descriptor),
    /authentication failed/,
  );

  const mismatch = structuredClone(descriptor);
  mismatch.session.id = 'different-session';
  resignDescriptor(mismatch, descriptorKey);
  assert.throws(
    () => new AgentSession({ adapters: { pi: fake }, descriptorKey }).attach(mismatch),
    /receipt identity/,
  );

  const ambiguous = structuredClone(descriptor);
  ambiguous.commandClosure = 'unknown';
  resignDescriptor(ambiguous, descriptorKey);
  assert.throws(
    () => new AgentSession({ adapters: { pi: fake }, descriptorKey }).attach(ambiguous),
    /command closure/,
  );

  const codex = new AgentSession({
    adapters: {
      codex: {
        async start(input) {
          return {
            ok: true,
            sessionId: 'codex-session',
            stdout: '{"type":"thread.started","thread_id":"codex-session"}\n',
            stderr: '',
            exitCode: 0,
            command: {
              file: 'codex', cwd: input.cwd,
              args: [
                'exec', '--json', '-C', input.cwd, '--sandbox', 'workspace-write',
                '-m', 'wrong-model', '-c', 'model_reasoning_effort="high"', '-',
              ],
            },
          };
        },
      },
    },
    descriptorKey,
  });
  const codexSession = await codex.start('/tmp/product', 'Count bytes.', 'mdlm@next', 'codex');
  assert.throws(
    () => new AgentSession({ descriptorKey }).attach(codex.observe(codexSession).descriptor),
    /harness settings/,
  );
});

test('AgentSession refuses attachment and duplicate send while a command is unresolved', async () => {
  const descriptorKey = 'qualified-host-secret';
  let finishSend;
  let sendCalls = 0;
  const fake = {
    async start(input) {
      return piReceipt(input);
    },
    async send(input) {
      sendCalls += 1;
      return new Promise(resolve => {
        finishSend = () => resolve(piReceipt(input));
      });
    },
  };
  const original = new AgentSession({
    adapters: { pi: fake }, descriptorKey, newId: () => 'session-active',
  });
  const session = await original.start('/tmp/product', 'Count bytes.', 'mdlm@next', 'pi');

  const pending = original.send(session, 'Continue once.');
  const active = original.observe(session);
  assert.equal(active.state, 'transport-active');
  assert.equal(active.descriptor.commandClosure, 'open');
  assert.throws(
    () => new AgentSession({ adapters: { pi: fake }, descriptorKey }).attach(active.descriptor),
    /command closure/,
  );
  await assert.rejects(original.send(session, 'Do not duplicate.'), /active or ambiguous command/);
  assert.equal(sendCalls, 1);

  finishSend();
  await pending;
  assert.equal(original.observe(session).descriptor.commandClosure, 'closed');
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
  assert.match(prompt, /create the named child, change into it, then run git init \. and initialize MDLM there\. Keep the parent harness workspace limited to its injected harness metadata/);
  assert.doesNotMatch(prompt, /working directory itself is the repository root/);
});

test('start and continuation prompts bound evidence lookup to supplied paths or the workspace', async () => {
  const calls = [];
  const fake = {
    async start(input) {
      calls.push(input.prompt);
      return { ok: true, sessionId: input.id, stdout: '', stderr: '', exitCode: 0 };
    },
    async send(input) {
      calls.push(input.message);
      return { ok: true, sessionId: input.id, stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const agent = new AgentSession({ adapters: { pi: fake }, newId: () => 'session-bounded-search' });
  const session = await agent.start('/tmp/product', 'Use evidence to count bytes.', 'mdlm@next', 'pi');
  await agent.send(session, 'The decision is at /tmp/product/attended-decision-0001.json. Continue.');

  for (const prompt of calls) {
    assert.match(prompt, /use an exact path supplied in these instructions/);
    assert.match(prompt, /search only the current workspace with rg or rg --files/);
    assert.match(prompt, /absent there, stop and ask for its exact path/);
    assert.match(prompt, /keep every search within the workspace/);
  }
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

function resignDescriptor(descriptor, key) {
  const { authentication: _authentication, ...payload } = descriptor;
  descriptor.authentication = {
    algorithm: 'hmac-sha256',
    digest: createHmac('sha256', key).update(canonicalJson(payload)).digest('hex'),
  };
}

function piReceipt(input) {
  return {
    ok: true,
    sessionId: input.id,
    stdout: 'waiting',
    stderr: '',
    exitCode: 0,
    command: {
      file: 'pi',
      args: ['--session-id', input.id, '--model', input.spec.model, '--thinking', input.spec.thinking],
      cwd: input.cwd,
    },
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
