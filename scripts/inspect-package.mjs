import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const compressedLimit = 8 * 1024 * 1024;
const expandedLimit = 16 * 1024 * 1024;
const launchers = new Set(['package/bin/mdlm-demo-runner.mjs']);

function unsafe(message) {
  throw new Error(`unsafe package archive: ${message}`);
}

function stringField(block, offset, length) {
  const end = block.indexOf(0, offset);
  return block.toString('utf8', offset, end === -1 || end > offset + length ? offset + length : end);
}

function octalField(block, offset, length, label) {
  const source = block.toString('ascii', offset, offset + length).replaceAll('\0', '').trim();
  if (!/^[0-7]+$/.test(source)) unsafe(`invalid ${label}`);
  const value = Number.parseInt(source, 8);
  if (!Number.isSafeInteger(value)) unsafe(`invalid ${label}`);
  return value;
}

function validatePath(name) {
  if (!name.startsWith('package/')
    || name.includes('\\')
    || name.startsWith('/')
    || path.posix.normalize(name) !== name
    || name.split('/').some(part => part.length === 0 || part === '.' || part === '..')) {
    unsafe(`invalid entry path ${JSON.stringify(name)}`);
  }
}

async function readArchive(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) unsafe('input is not a regular file');
    if (before.size > BigInt(compressedLimit)) unsafe(`compressed archive exceeds ${compressedLimit}-byte limit`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.length !== Number(before.size)) {
      unsafe('archive changed while being read');
    }
    return bytes;
  } catch (error) {
    if (error?.code === 'ELOOP') unsafe('archive is a symbolic link');
    throw error;
  } finally {
    await handle?.close();
  }
}

async function inspect(file) {
  let tar;
  try {
    tar = gunzipSync(await readArchive(file), { maxOutputLength: expandedLimit });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('unsafe package archive:')) throw error;
    unsafe(`cannot decompress: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (tar.length % 512 !== 0) unsafe('tar length is not block aligned');

  const files = [];
  const names = new Set();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset < tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every(byte => byte === 0)) {
      zeroBlocks += 1;
      offset += 512;
      continue;
    }
    if (zeroBlocks > 0) unsafe('nonzero entry follows tar terminator');

    const storedChecksum = octalField(block, 148, 8, 'header checksum');
    const checksumBlock = Buffer.from(block);
    checksumBlock.fill(0x20, 148, 156);
    const actualChecksum = checksumBlock.reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== actualChecksum) unsafe('header checksum mismatch');
    if (stringField(block, 257, 6) !== 'ustar') unsafe('entry is not POSIX ustar');

    const prefix = stringField(block, 345, 155);
    const basename = stringField(block, 0, 100);
    const name = prefix.length === 0 ? basename : `${prefix}/${basename}`;
    validatePath(name);
    if (names.has(name)) unsafe(`duplicate entry ${name}`);
    names.add(name);

    const type = String.fromCharCode(block[156] || 0x30);
    if (type !== '0') unsafe(`unsupported entry type ${JSON.stringify(type)} for ${name}`);
    const mode = octalField(block, 100, 8, 'entry mode');
    const expectedMode = launchers.has(name) ? 0o755 : 0o644;
    if (mode !== expectedMode) unsafe(`unsafe mode ${mode.toString(8)} for ${name}`);
    const size = octalField(block, 124, 12, 'entry size');
    const paddedSize = Math.ceil(size / 512) * 512;
    if (offset + 512 + paddedSize > tar.length) unsafe(`truncated body for ${name}`);
    files.push(name.slice('package/'.length));
    offset += 512 + paddedSize;
  }
  if (zeroBlocks < 2) unsafe('tar lacks two-block terminator');
  return files.sort();
}

try {
  if (process.argv.length !== 3) throw new Error('usage: inspect-package.mjs <package.tgz>');
  const files = await inspect(process.argv[2]);
  process.stdout.write(`${JSON.stringify({ contract: 'mdlm-demo-runner-package-inspection@1', files })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
