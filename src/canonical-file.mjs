import { constants } from 'node:fs';
import { lstat, open, readlink, realpath, readdir } from 'node:fs/promises';
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
    await verifyOpenPath(handle, expected, opened, label, 'file');
    const bytes = options.maxBytes === undefined
      ? await handle.readFile()
      : await readWithinLimit(handle, opened, options.maxBytes, label);
    await verifyOpenPath(handle, expected, opened, label, 'file');
    return { path: expected, bytes, mode: Number(opened.mode) };
  } finally {
    await handle?.close();
  }
}

export async function readCanonicalDirectory(directory, label, openDirectory = open, options = {}) {
  const expected = path.resolve(directory);
  let handle;
  try {
    try {
      handle = await openDirectory(expected, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error.code === 'ELOOP') throw new Error(`${label} is not a real directory: ${expected}`);
      throw error;
    }
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory()) throw new Error(`${label} is not a real directory: ${expected}`);
    await verifyOpenPath(handle, expected, opened, label, 'directory');
    const names = await (options.readDirectory ?? readdir)(`/proc/self/fd/${handle.fd}`);
    await verifyOpenPath(handle, expected, opened, label, 'directory');
    return { path: expected, names: names.sort(), mode: Number(opened.mode) };
  } finally {
    await handle?.close();
  }
}

export async function readCanonicalSymlink(file, root, label, options = {}) {
  const expected = path.resolve(file);
  const parent = path.dirname(expected);
  if (await realpath(parent) !== parent) throw new Error(`${label} has a symbolic-link path component: ${expected}`);
  const before = await lstat(expected, { bigint: true });
  if (!before.isSymbolicLink()) throw new Error(`${label} is not a symbolic link: ${expected}`);
  if (before.size > BigInt(options.maxBytes ?? 4096)) throw new Error(`${label} exceeds ${options.maxBytes ?? 4096}-byte limit`);
  const target = await (options.readLink ?? readlink)(expected);
  const resolved = await realpath(expected);
  const canonicalRoot = path.resolve(root);
  const relative = path.relative(canonicalRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its root: ${expected}`);
  }
  const after = await lstat(expected, { bigint: true });
  if (!after.isSymbolicLink() || !sameIdentity(before, after)) {
    throw new Error(`${label} changed while it was being read: ${expected}`);
  }
  return { path: expected, target, mode: Number(before.mode) };
}

async function readWithinLimit(handle, opened, maxBytes, label) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error(`${label} byte limit is invalid`);
  if (opened.size > BigInt(maxBytes)) throw new Error(`${label} exceeds ${maxBytes}-byte limit`);
  const capacity = Math.min(maxBytes + 1, Number(opened.size) + 1);
  const bytes = Buffer.allocUnsafe(capacity);
  let offset = 0;
  for (;;) {
    const result = await handle.read(bytes, offset, bytes.length - offset, null);
    offset += result.bytesRead;
    if (offset > maxBytes) throw new Error(`${label} exceeds ${maxBytes}-byte limit`);
    if (result.bytesRead === 0) return bytes.subarray(0, offset);
  }
}

async function verifyOpenPath(handle, expected, opened, label, kind) {
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
  const correctKind = kind === 'file' ? current.isFile() && !current.isSymbolicLink() : current.isDirectory() && !current.isSymbolicLink();
  if (!correctKind) throw new Error(`${label} is not a real ${kind}: ${expected}`);
  const descriptor = await handle.stat({ bigint: true });
  if (!sameIdentity(current, opened) || !sameIdentity(descriptor, opened)) {
    throw new Error(`${label} changed while it was being read: ${expected}`);
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
