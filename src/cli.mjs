import { readFile } from 'node:fs/promises';
import { classify } from './classify.mjs';
import {
  buildDecisionCatalogRequest, decisionCatalogLimits, readFileWithinLimit, validateDecisionCatalogRequest,
} from './decision-catalog.mjs';
import { snapshot } from './evidence.mjs';
import { run } from './orchestrator.mjs';

async function readRequest(args, maxBytes) {
  if (args.length === 0) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (maxBytes !== undefined && bytes > maxBytes) throw new Error(`decision catalog request exceeds ${maxBytes}-byte limit`);
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  if (args.length === 2 && args[0] === '--input') {
    const bytes = maxBytes === undefined
      ? await readFile(args[1])
      : await readFileWithinLimit(args[1], maxBytes, 'decision catalog request');
    return JSON.parse(bytes.toString('utf8'));
  }
  throw new Error('expected JSON on stdin or --input <file>');
}

async function main(args) {
  const [command, ...rest] = args;
  const decisionCatalogCommand = command === 'decision-catalog-build' || command === 'decision-catalog-validate';
  const request = await readRequest(rest, decisionCatalogCommand ? decisionCatalogLimits.buildRequestBytes : undefined);
  if (command === 'classify') return classify(request);
  if (command === 'decision-catalog-build') return buildDecisionCatalogRequest(request);
  if (command === 'decision-catalog-validate') return validateDecisionCatalogRequest(request);
  if (command === 'snapshot') return snapshot(request);
  if (command === 'run' || command === 'resume') return run(request, command);
  throw new Error('usage: mdlm-demo-runner snapshot|classify|decision-catalog-build|decision-catalog-validate|run|resume [--input file]');
}

try {
  const output = await main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ contract: 'mdlm-demo-error@1', error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
