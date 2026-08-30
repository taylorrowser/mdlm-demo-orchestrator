import { spawn } from 'node:child_process';

export function createCodexAdapter(execute = executeCommand) {
  return {
    async start({ cwd, prompt, spec }) {
      const command = {
        file: 'codex',
        cwd,
        input: prompt,
        args: [
          'exec', '--json', '-C', cwd,
          ...(spec.allowEmptyDestination ? ['--skip-git-repo-check'] : []),
          '--sandbox', 'workspace-write', '-m', spec.model,
          '-c', `model_reasoning_effort=${JSON.stringify(spec.effort)}`, '-',
        ],
      };
      return codexReceipt(await execute(command), command);
    },
    async send({ cwd, id, message, spec }) {
      const command = {
        file: 'codex',
        cwd,
        input: message,
        args: [
          'exec', 'resume', '--json',
          ...(spec.allowEmptyDestination ? ['--skip-git-repo-check'] : []),
          '-m', spec.model,
          '-c', `model_reasoning_effort=${JSON.stringify(spec.effort)}`,
          id, '-',
        ],
      };
      return codexReceipt(await execute(command), command, id);
    },
  };
}

export function createPiAdapter(execute = executeCommand) {
  return {
    async start({ cwd, id, prompt, spec }) {
      const command = piCommand(cwd, id, prompt, spec);
      return receipt(await execute(command), command, id);
    },
    async send({ cwd, id, message, spec }) {
      const command = piCommand(cwd, id, message, spec);
      return receipt(await execute(command), command, id);
    },
  };
}

function piCommand(cwd, id, message, spec) {
  return {
    file: 'pi',
    cwd,
    args: [
      '--print', '--mode', 'json', '--session-id', id,
      '--model', spec.model, '--thinking', spec.thinking, message,
    ],
  };
}

function codexReceipt(result, command, fallbackId) {
  const events = result.stdout.split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const sessionId = events.find(event => event.type === 'thread.started')?.thread_id ?? fallbackId;
  return { ...receipt(result, command, sessionId), events };
}

function receipt(result, command, sessionId) {
  return {
    sessionId,
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    command: { file: command.file, args: command.args, cwd: command.cwd },
  };
}

function executeCommand(command) {
  return new Promise(resolve => {
    const child = spawn(command.file, command.args, { cwd: command.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('close', exitCode => resolve({
      exitCode,
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
    }));
    child.stdin.end(command.input);
  });
}
