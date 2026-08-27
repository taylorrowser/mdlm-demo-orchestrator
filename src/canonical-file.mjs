import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function readCanonicalFile(file, label, openFile = open, options = {}) {
  const expected = path.resolve(file);
  let handle;
  try {
    try {
      handle = await openFile(expected, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error.code === 'ELOOP') throw new Error(`${label} is not a regular file: ${expected}`);
      throw error;
    }
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new Error(`${label} is not a regular file: ${expected}`);
    await verifyOpenFile(handle, expected, opened, label);
    const bytes = options.maxBytes === undefined
      ? await handle.readFile()
      : await readWithinLimit(handle, opened, options.maxBytes, label);
    await verifyOpenFile(handle, expected, opened, label);
    return { path: expected, bytes };
  } finally {
    await handle?.close();
  }
}

async function readWithinLimit(handle, opened, maxBytes, label) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error(`${label} byte limit is invalid`);
  if (opened.size > BigInt(maxBytes)) throw new Error(`${label} exceeds ${maxBytes}-byte limit`);
  const bytes = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  for (;;) {
    const result = await handle.read(bytes, offset, bytes.length - offset, null);
    offset += result.bytesRead;
    if (offset > maxBytes) throw new Error(`${label} exceeds ${maxBytes}-byte limit`);
    if (result.bytesRead === 0) return bytes.subarray(0, offset);
  }
}

async function verifyOpenFile(handle, expected, opened, label) {
  let descriptorTarget;
  try {
    descriptorTarget = await realpath(`/proc/self/fd/${handle.fd}`);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${label} changed while it was being read: ${expected}`);
    throw error;
  }
  if (descriptorTarget !== expected) {
    throw new Error(`${label} has a symbolic-link path component or changed while it was being read: ${expected}`);
  }

  let current;
  try {
    current = await lstat(expected, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${label} changed while it was being read: ${expected}`);
    throw error;
  }
  if (!current.isFile() || current.isSymbolicLink()) throw new Error(`${label} is not a regular file: ${expected}`);
  const descriptor = await handle.stat({ bigint: true });
  if (current.dev !== opened.dev || current.ino !== opened.ino ||
      descriptor.dev !== opened.dev || descriptor.ino !== opened.ino ||
      descriptor.size !== opened.size || descriptor.mtimeNs !== opened.mtimeNs || descriptor.ctimeNs !== opened.ctimeNs) {
    throw new Error(`${label} changed while it was being read: ${expected}`);
  }
}
