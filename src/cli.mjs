import { readFile } from 'node:fs/promises';
import { reviewerLease, reviewerLeaseLimits } from './reviewer-lease.mjs';
import { run } from './runner.mjs';
import { parseStrictJson } from './strict-json.mjs';

const publicCommands = ['run', 'reviewer-lease'];
const usage = `mdlm-demo-runner ${publicCommands.join('|')} [--input file]`;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

async function readRequest(args, maxBytes, label) {
  let bytes;
  if (args.length === 0) {
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (maxBytes !== undefined && length > maxBytes) throw new Error(`${label} exceeds ${maxBytes}-byte limit`);
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  } else if (args.length === 2 && args[0] === '--input') {
    bytes = await readFile(args[1]);
    if (maxBytes !== undefined && bytes.length > maxBytes) throw new Error(`${label} exceeds ${maxBytes}-byte limit`);
  } else {
    throw new Error('expected JSON on stdin or --input <file>');
  }
  let text;
  try { text = utf8.decode(bytes); }
  catch (error) { if (error instanceof TypeError) throw new Error(`${label} is not valid UTF-8`); throw error; }
  return parseStrictJson(text, label);
}

async function main(args) {
  const [command, ...rest] = args;
  const help = (command === '--help' && rest.length === 0)
    || (publicCommands.includes(command) && rest.length === 1 && rest[0] === '--help');
  if (help) return { contract: 'mdlm-demo-help@1', usage, commands: publicCommands };
  if (!publicCommands.includes(command)) throw new Error(`usage: ${usage}`);
  if (command === 'reviewer-lease') {
    return reviewerLease(await readRequest(rest, reviewerLeaseLimits.requestBytes, 'reviewer lease request'));
  }
  return run(await readRequest(rest, 64 * 1024, 'run request'));
}

export async function executeCli(args) {
  try {
    const output = await main(args);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ contract: 'mdlm-demo-error@1', error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
