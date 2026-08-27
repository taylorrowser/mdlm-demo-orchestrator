import { readFile } from 'node:fs/promises';
import { classify } from './classify.mjs';
import { buildDecisionCatalogRequest, validateDecisionCatalogRequest } from './decision-catalog.mjs';
import { snapshot } from './evidence.mjs';
import { run } from './orchestrator.mjs';

async function readRequest(args) {
  if (args.length === 0) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  if (args.length === 2 && args[0] === '--input') {
    return JSON.parse(await readFile(args[1], 'utf8'));
  }
  throw new Error('expected JSON on stdin or --input <file>');
}

async function main(args) {
  const [command, ...rest] = args;
  const request = await readRequest(rest);
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
