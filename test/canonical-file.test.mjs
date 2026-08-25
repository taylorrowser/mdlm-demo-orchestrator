import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdtemp, mkdir, open, rename, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readCanonicalFile } from '../src/canonical-file.mjs';

const callPaths = ['optional evidence', 'checkpoint evidence'];

function trackedHandle(handle, state) {
  return {
    fd: handle.fd,
    stat: options => handle.stat(options),
    readFile: async () => {
      state.read = true;
      return handle.readFile();
    },
    close: async () => {
      state.closed = true;
      return handle.close();
    },
  };
}

async function expectRejectedWithoutRead(file, label, mutate, pattern) {
  const state = { read: false, closed: false };
  const openAndMutate = async (openedPath, flags) => {
    assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW);
    const handle = await open(openedPath, flags);
    await mutate();
    return trackedHandle(handle, state);
  };
  await assert.rejects(readCanonicalFile(file, label, openAndMutate), pattern);
  assert.equal(state.read, false);
  assert.equal(state.closed, true);
}

for (const label of callPaths) {
  test(`${label} rejects final and intermediate symlinks before reading`, async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-canonical-symlink-'));
    const outside = path.join(scratch, 'outside');
    await mkdir(outside);
    const external = path.join(outside, 'evidence.json');
    await writeFile(external, 'external bytes\n');

    const finalLink = path.join(scratch, 'final.json');
    await symlink(external, finalLink);
    await assert.rejects(readCanonicalFile(finalLink, label), new RegExp(`${label} is not a regular file`));

    const linkedParent = path.join(scratch, 'linked-parent');
    await symlink(outside, linkedParent);
    await expectRejectedWithoutRead(
      path.join(linkedParent, 'evidence.json'),
      label,
      async () => {},
      new RegExp(`${label} has a symbolic-link path component`),
    );
  });

  test(`${label} rejects final and intermediate path substitutions before reading`, async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-canonical-race-'));
    const finalFile = path.join(scratch, 'final.json');
    await writeFile(finalFile, 'trusted bytes\n');
    await expectRejectedWithoutRead(finalFile, label, async () => {
      await rename(finalFile, path.join(scratch, 'opened-final.json'));
      await writeFile(finalFile, 'substituted bytes\n');
    }, /changed while it was being read/);

    const parent = path.join(scratch, 'parent');
    const openedParent = path.join(scratch, 'opened-parent');
    await mkdir(parent);
    const nestedFile = path.join(parent, 'evidence.json');
    await writeFile(nestedFile, 'trusted bytes\n');
    await expectRejectedWithoutRead(nestedFile, label, async () => {
      await rename(parent, openedParent);
      await mkdir(parent);
      await writeFile(nestedFile, 'substituted bytes\n');
    }, /symbolic-link path component or changed while it was being read/);
  });
}
