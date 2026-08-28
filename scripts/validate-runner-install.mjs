#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const [manifestPath, expectedDigest] = process.argv.slice(2);
if (!manifestPath || !expectedDigest) throw new Error('usage: validate-runner-install <manifest> <sha256>');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = await readFile(manifestPath);
if (digest(manifestBytes) !== expectedDigest) throw new Error('external manifest digest mismatch');
const manifest = JSON.parse(manifestBytes);
if (manifest.contract !== 'mdlm-demo-runner-install@1') throw new Error('manifest contract mismatch');
const checkFile = async (record, absolute = record.path) => {
  const info = await stat(absolute);
  const bytes = await readFile(absolute);
  if (!info.isFile() || (info.mode & 0o777) !== record.mode || bytes.length !== record.bytes || digest(bytes) !== record.sha256) throw new Error(`file mismatch: ${absolute}`);
};
const archiveBytes = await readFile(manifest.archive.path);
if (archiveBytes.length !== manifest.archive.bytes || digest(archiveBytes) !== manifest.archive.sha256) throw new Error('archive mismatch');
await checkFile(manifest.package.packageJson);
const packageJson = JSON.parse(await readFile(manifest.package.packageJson.path, 'utf8'));
if (packageJson.name !== manifest.package.name || packageJson.version !== manifest.package.version) throw new Error('package metadata mismatch');
const distributionBytes = await readFile(manifest.distributionManifest.path);
if (distributionBytes.length !== manifest.distributionManifest.bytes || digest(distributionBytes) !== manifest.distributionManifest.sha256) throw new Error('distribution manifest bytes mismatch');
const distribution = JSON.parse(distributionBytes);
for (const key of ['contract', 'authority', 'package', 'launchers', 'files']) {
  if (JSON.stringify(distribution[key]) !== JSON.stringify(manifest.distributionManifest[key])) throw new Error(`distribution field mismatch: ${key}`);
}
const actualTree = [];
async function walk(directory, prefix = '') {
  const names = await readdir(directory); names.sort();
  for (const name of names) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const absolute = path.join(directory, name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`symlink rejected: ${relative}`);
    if (info.isDirectory()) { actualTree.push({ path: relative, type: 'directory', mode: info.mode & 0o777 }); await walk(absolute, relative); }
    else if (info.isFile()) { const bytes = await readFile(absolute); actualTree.push({ path: relative, type: 'file', mode: info.mode & 0o777, bytes: bytes.length, sha256: digest(bytes) }); }
    else throw new Error(`special file rejected: ${relative}`);
  }
}
await walk(manifest.package.root); actualTree.sort((a, b) => a.path.localeCompare(b.path));
if (JSON.stringify(actualTree) !== JSON.stringify(manifest.tree)) throw new Error('installed tree mismatch');
for (const launcher of manifest.launchers) await checkFile(launcher, launcher.absolutePath);
const publicInfo = await lstat(manifest.publicExecutable.path);
if (!publicInfo.isSymbolicLink() || await readlink(manifest.publicExecutable.path) !== manifest.publicExecutable.linkText) throw new Error('public link mismatch');
const target = await realpath(manifest.publicExecutable.path);
if (target !== manifest.publicExecutable.resolvedTarget) throw new Error('public target mismatch');
await checkFile({ mode: manifest.publicExecutable.effectiveMode, bytes: manifest.publicExecutable.bytes, sha256: manifest.publicExecutable.sha256 }, target);
console.log(JSON.stringify({ contract: 'mdlm-demo-runner-install-validation@1', status: 'PASS', entries: actualTree.length }));
