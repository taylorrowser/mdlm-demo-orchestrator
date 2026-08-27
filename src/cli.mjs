import { readFile } from 'node:fs/promises';
import { readCanonicalFile } from './canonical-file.mjs';
import { classify } from './classify.mjs';
import {
  buildDecisionCatalogRequest, decisionCatalogLimits, readFileWithinLimit, validateDecisionCatalogRequest,
} from './decision-catalog.mjs';
import { snapshot } from './evidence.mjs';
import { reconcile, run } from './orchestrator.mjs';
import { preflight, preflightFailure, preflightLimits } from './preflight.mjs';

const publicCommands = [
  'preflight',
  'snapshot',
  'classify',
  'decision-catalog-build',
  'decision-catalog-validate',
  'run',
  'resume',
  'reconcile',
];
const usage = `mdlm-demo-runner ${publicCommands.join('|')} [--input file]`;

async function readRequest(args, maxBytes, label = 'decision catalog request', canonical = false) {
  if (args.length === 0) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (maxBytes !== undefined && bytes > maxBytes) throw new Error(`${label} exceeds ${maxBytes}-byte limit`);
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  if (args.length === 2 && args[0] === '--input') {
    const bytes = canonical
      ? (await readCanonicalFile(args[1], label, undefined, { maxBytes })).bytes
      : maxBytes === undefined
        ? await readFile(args[1])
        : await readFileWithinLimit(args[1], maxBytes, label);
    return JSON.parse(bytes.toString('utf8'));
  }
  throw new Error('expected JSON on stdin or --input <file>');
}

async function main(args) {
  const [command, ...rest] = args;
  const helpRequested = (command === '--help' && rest.length === 0)
    || (publicCommands.includes(command) && rest.length === 1 && rest[0] === '--help');
  if (helpRequested) return { contract: 'mdlm-demo-help@1', usage, commands: publicCommands };
  if (!publicCommands.includes(command)) throw new Error(`usage: ${usage}`);
  if (command === 'preflight') {
    try {
      const request = await readRequest(rest, preflightLimits.requestBytes, 'preflight request', true);
      return preflight(request);
    } catch (error) {
      return preflightFailure(error);
    }
  }
  const decisionCatalogCommand = command === 'decision-catalog-build' || command === 'decision-catalog-validate';
  const request = await readRequest(rest, decisionCatalogCommand ? decisionCatalogLimits.buildRequestBytes : undefined);
  if (command === 'classify') return classify(request);
  if (command === 'decision-catalog-build') return buildDecisionCatalogRequest(request);
  if (command === 'decision-catalog-validate') return validateDecisionCatalogRequest(request);
  if (command === 'snapshot') return snapshot(request);
  if (command === 'run' || command === 'resume') return run(request, command);
  if (command === 'reconcile') return reconcile(request);
  throw new Error(`usage: ${usage}`);
}

export async function executeCli(args) {
  try {
    const output = await main(args);
    process.stdout.write(`${JSON.stringify(output)}\n`);
    if (output?.contract === 'mdlm-demo-preflight-result@1' && output.status === 'FAIL') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ contract: 'mdlm-demo-error@1', error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
