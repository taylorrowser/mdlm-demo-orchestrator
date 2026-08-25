import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, readdir } from 'node:fs/promises';
import path from 'node:path';

export const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export async function toolingTreeDigest(root) {
  const entries = [];
  await visit(root, '.', entries);
  return sha256(Buffer.from(`${JSON.stringify({ contract: 'mdlm-demo-tooling-tree@1', entries })}\n`));
}

async function visit(root, relative, entries) {
  const absolute = relative === '.' ? root : path.join(root, ...relative.split('/'));
  const information = await lstat(absolute);
  const mode = (information.mode & 0o7777).toString(8).padStart(4, '0');
  if (information.isSymbolicLink()) {
    entries.push({ path: relative, type: 'symlink', mode, targetBase64: Buffer.from(await readlink(absolute)).toString('base64') });
    return;
  }
  if (information.isDirectory()) {
    entries.push({ path: relative, type: 'directory', mode });
    const names = await readdir(absolute);
    names.sort();
    for (const name of names) await visit(root, relative === '.' ? name : `${relative}/${name}`, entries);
    return;
  }
  if (!information.isFile()) throw new Error(`unsupported fixture tooling entry: ${relative}`);
  const bytes = await readFile(absolute);
  entries.push({ path: relative, type: 'file', mode, bytes: bytes.length, digest: sha256(bytes) });
}
