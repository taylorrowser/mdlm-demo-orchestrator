import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function readCanonicalFile(file, label, openFile = open) {
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
    await verifyOpenFile(handle.fd, expected, opened, label);
    const bytes = await handle.readFile();
    await verifyOpenFile(handle.fd, expected, opened, label);
    return { path: expected, bytes };
  } finally {
    await handle?.close();
  }
}

async function verifyOpenFile(fd, expected, opened, label) {
  let descriptorTarget;
  try {
    descriptorTarget = await realpath(`/proc/self/fd/${fd}`);
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
  if (current.dev !== opened.dev || current.ino !== opened.ino) {
    throw new Error(`${label} changed while it was being read: ${expected}`);
  }
}
