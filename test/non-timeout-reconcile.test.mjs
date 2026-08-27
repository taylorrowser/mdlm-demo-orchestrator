import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin/mdlm-demo-runner.mjs');
const fixture = path.join(root, 'test/fixtures/json-max-depth-run-001-reconciliation');
const originalRoot = '/home/ubuntu/git/mdlm-successor-demos/operations/json-max-depth-ops-002';
const assignmentA = '7086ad7d-93c6-4c0a-be11-6189377fd536';
const assignmentB = '23f27630-4073-4c0f-b842-37641b5f00ac';

function exec(program, args, cwd, input, env = process.env) {
  return spawnSync(program, args, { cwd, input, env, encoding: 'utf8', timeout: 20_000 });
}

function digestBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function digest(file) {
  return digestBytes(await readFile(file));
}

function assignmentKey(value) {
  const suffix = createHash('sha256').update(value).digest('hex').slice(-12);
  return `${value.replace(/[^A-Za-z0-9._-]/g, '_')}-${suffix}`;
}

async function pin(file) {
  return { path: file, digest: await digest(file) };
}

async function replacePinnedJson(pinRecord, mutate) {
  const value = JSON.parse(await readFile(pinRecord.path));
  await mutate(value);
  await chmod(pinRecord.path, 0o600);
  await writeFile(pinRecord.path, `${JSON.stringify(value, null, 2)}\n`);
  pinRecord.digest = await digest(pinRecord.path);
  return value;
}

async function run001Fixture() {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'mdlm-json-run-001-reconcile-'));
  const repository = path.join(scratch, 'repository');
  const clone = exec('git', ['clone', '--quiet', path.join(fixture, 'repository.bundle'), repository], root);
  assert.equal(clone.status, 0, clone.stderr);

  const identityDirectory = path.join(repository, '.git', 'mdlm-demo-orchestrator');
  await mkdir(identityDirectory, { recursive: true });
  await cp(path.join(fixture, 'repository-identity.json'), path.join(identityDirectory, 'repository-identity.json'));
  await cp(path.join(fixture, 'run-identity.json'), path.join(identityDirectory, 'run-identity.json'));

  const stateDirectory = path.join(scratch, 'private-state');
  const sourceDirectory = path.join(stateDirectory, 'assignments', assignmentKey(assignmentA));
  await mkdir(path.dirname(sourceDirectory), { recursive: true });
  await cp(path.join(fixture, 'assignment-a'), sourceDirectory, { recursive: true, preserveTimestamps: true });

  const evidenceRoot = path.join(scratch, 'evidence');
  const evidenceDirectory = path.join(evidenceRoot, 'run-001-snapshots');
  await mkdir(evidenceRoot);
  await cp(path.join(fixture, 'evidence/run-001-snapshots'), evidenceDirectory, { recursive: true, preserveTimestamps: true });
  const requestPath = path.join(evidenceRoot, '004-run-001-request.json');
  await cp(path.join(fixture, 'evidence/004-run-001-request.json'), requestPath);
  const repositoryIdentityEvidencePath = path.join(evidenceDirectory, 'repository-identity.json');
  await cp(path.join(fixture, 'repository-identity.json'), repositoryIdentityEvidencePath);
  const outerCommand = {};
  for (const stream of ['stdout', 'stderr', 'exit']) {
    const target = path.join(evidenceRoot, `012-run-001.runner.${stream}`);
    await cp(path.join(fixture, 'outer-command', `012-run-001.runner.${stream}`), target);
    outerCommand[stream] = await pin(target);
  }
  const outerCommandRecordPath = path.join(evidenceRoot, '012-run-001.runner.command.json');
  await cp(path.join(fixture, 'outer-command/012-run-001.runner.command.json'), outerCommandRecordPath);
  outerCommand.record = await pin(outerCommandRecordPath);

  const commandDirectory = path.join(sourceDirectory, 'command-evidence');
  const durableDirectory = path.join(sourceDirectory, 'durable-command');
  const shimDirectory = path.join(sourceDirectory, 'shim');
  return {
    scratch,
    repository,
    identityDirectory,
    sourceDirectory,
    stateDirectory,
    request: {
      contract: 'mdlm-demo-reconcile-request@1',
      repository,
      stateDirectory,
      timeoutMs: 900_000,
      relocation: {
        contract: 'mdlm-demo-reconcile-relocation@1',
        originalRoot,
        targetRoot: scratch,
      },
      evidence: {
        request: await pin(requestPath),
        repositoryIdentity: await pin(repositoryIdentityEvidencePath),
        initialSnapshot: {
          directory: path.join(evidenceDirectory, 'snapshot-000001'),
          digest: 'sha256:5e164767d5ee9685f7cfdd9b7b0bf5e81cf07069bf7781d10a4c617e06cb3f5d',
        },
        postSnapshot: {
          directory: path.join(evidenceDirectory, 'snapshot-000002'),
          digest: 'sha256:4b23cf6b6c0dc7c06cbca74886c05c3382d87b44709e74e18ea45986c892c6ec',
        },
        outerCommand,
        authorization: await pin(path.join(durableDirectory, 'authorization.json')),
        result: await pin(path.join(durableDirectory, 'result.json')),
        commands: await Promise.all(['000001', '000002'].map(async index => ({
          record: await pin(path.join(commandDirectory, `command-${index}.json`)),
          stdout: await pin(path.join(commandDirectory, `command-${index}.stdout`)),
          stderr: await pin(path.join(commandDirectory, `command-${index}.stderr`)),
        }))),
        identity: await pin(path.join(sourceDirectory, 'identity.json')),
        shimConfig: await pin(path.join(shimDirectory, 'config.json')),
        processedAssignment: await pin(path.join(shimDirectory, 'processed-assignment.json')),
        assignmentCheckpoint: await pin(path.join(shimDirectory, 'assignment-checkpoint.json')),
        stopPacket: await pin(path.join(shimDirectory, 'stops', `${assignmentB}.json`)),
      },
    },
  };
}

test('run 001 fixture preserves the non-timeout A-to-B materialization and failed consumption boundary', async () => {
  const fixtureManifest = path.join(fixture, 'copied-fixture.sha256');
  assert.equal(await digest(fixtureManifest), 'sha256:0182a757f8e75332d152efc44f04832b350df03afca67b996567c090657c3d8b');
  for (const line of (await readFile(fixtureManifest, 'utf8')).trimEnd().split('\n')) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    assert.ok(match, line);
    assert.equal(await digest(path.join(fixture, match[2])), `sha256:${match[1]}`, match[2]);
  }
  const expected = new Map([
    ['evidence/004-run-001-request.json', 'sha256:6f42876f39e0e0402b9f4c0fd1588c3da081d98d8fc2da09708af2128897c65c'],
    ['evidence/run-001-snapshots/snapshot-000001/manifest.json', 'sha256:5e164767d5ee9685f7cfdd9b7b0bf5e81cf07069bf7781d10a4c617e06cb3f5d'],
    ['evidence/run-001-snapshots/snapshot-000002/manifest.json', 'sha256:4b23cf6b6c0dc7c06cbca74886c05c3382d87b44709e74e18ea45986c892c6ec'],
    ['assignment-a/durable-command/authorization.json', 'sha256:23755da5b7e763a1894a1da757740493557e8becf9aa67315ee56ac988a3639b'],
    ['assignment-a/durable-command/result.json', 'sha256:b910ee0676eb1126be450ba0923d46b14cbab7cb677da9eed82e14a3a64250ed'],
    ['outer-command/012-run-001.runner.stdout', 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['outer-command/012-run-001.runner.stderr', 'sha256:2ab3869bb7fd1dadcbdea7ad89fd2b3f68eec2124d85370931b557c1bf7787e2'],
    ['outer-command/012-run-001.runner.exit', 'sha256:4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865'],
    ['outer-command/012-run-001.runner.command.json', 'sha256:7f60baf8dc4dcfcbad9dac1b8e03dbb54b043ad9a4fb8032182f580b7392f025'],
  ]);
  for (const [relative, expectedDigest] of expected) {
    assert.equal(await digest(path.join(fixture, relative)), expectedDigest, relative);
  }

  const durable = JSON.parse(await readFile(path.join(fixture, 'assignment-a/durable-command/result.json')));
  assert.equal(durable.process.timedOut, false);
  assert.equal(durable.process.exitStatus, 1);
  assert.equal(durable.process.signal, null);
  assert.equal(durable.process.stderrSha256, 'sha256:18f20d154d353e4801a90b4a9167a3ba3721662cf00191065a91fd4e5a5aff48');
  assert.equal(durable.repository.head, 'db99d2e68d7c764ea760986465263c80ca2edac7');
  assert.equal(
    await readFile(path.join(fixture, 'outer-command/012-run-001.runner.stderr'), 'utf8'),
    '{"contract":"mdlm-demo-error@1","error":"untrusted durable command consumption snapshot differs from its authorized repository boundary"}\n',
  );
  const value = await run001Fixture();
  const subjects = exec('git', ['log', '--format=%s', '96e3dc18aee3a7dc1fe752eb63bd7af528a6307e..db99d2e68d7c764ea760986465263c80ca2edac7'], value.repository);
  assert.equal(subjects.status, 0, subjects.stderr);
  assert.deepEqual(subjects.stdout.trim().split('\n'), [
    'mdlm: publish create-review-context@1 (56d8e1c1-a13f-478a-b997-a049a07992d9)',
    'mdlm: publish establish-initial-wayfinding-map@2 (0e6b8f39-5c03-47e7-91bb-ab5a9f037931)',
  ]);
});

test('public reconcile consumes non-timeout A without invoking A or B', async () => {
  const value = await run001Fixture();
  const before = exec('git', ['rev-parse', 'HEAD^{commit}', 'HEAD^{tree}'], value.repository);
  assert.equal(before.status, 0, before.stderr);

  const execution = exec(process.execPath, [cli, 'reconcile'], root, JSON.stringify(value.request));

  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(JSON.parse(execution.stdout), {
    contract: 'mdlm-demo-reconcile-result@1',
    status: 'reconciled',
    fromAssignment: assignmentA,
    toAssignment: assignmentB,
    priorRepository: {
      head: '96e3dc18aee3a7dc1fe752eb63bd7af528a6307e',
      tree: '9399992fdc0a548a4dfd31f691b0fd6c3c983ff5',
      trackedState: 'sha256:cd336eb4082ebc7b07f5c0eb052f81ad28c0770f9c2a2d67ad1f5b3145c092eb',
      clean: true,
      porcelainSha256: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
    completedRepository: {
      head: 'db99d2e68d7c764ea760986465263c80ca2edac7',
      tree: '93250ae685b37612d48fc3c65a97a4fd71fc2f03',
      trackedState: 'sha256:73b280c5bcee60115391da8519e09ef53503be7580db3c2e30792ff592c2a1ce',
      clean: true,
      porcelainSha256: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
  });
  const after = exec('git', ['rev-parse', 'HEAD^{commit}', 'HEAD^{tree}'], value.repository);
  assert.equal(after.stdout, before.stdout);
  assert.deepEqual(await readdir(path.join(value.stateDirectory, 'assignments')), [assignmentKey(assignmentA)]);
  assert.equal(await stat(path.join(value.sourceDirectory, 'transaction.json')).then(() => true, () => false), true);
  assert.equal(await stat(path.join(value.stateDirectory, 'assignments', assignmentKey(assignmentB))).then(() => true, () => false), false);
  const identity = JSON.parse(await readFile(path.join(value.identityDirectory, 'repository-identity.json')));
  assert.deepEqual(identity.lastAssignment, { id: assignmentA, outcome: 'accepted-publication', completed: true });

  const repeated = exec(process.execPath, [cli, 'reconcile'], root, JSON.stringify(value.request));
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).status, 'already-reconciled');
  assert.deepEqual(await readdir(path.join(value.stateDirectory, 'assignments')), [assignmentKey(assignmentA)]);
});

test('non-timeout recovery resumes at paired temp-sync and rename crashes for its five replacements', async t => {
  const replacements = [
    'authenticated',
    'checkpoint-reconciliation-global',
    'boundary-advanced',
    'checkpoint-reconciliation-assignment',
    'completed',
  ];
  for (const replacement of replacements) {
    for (const boundary of ['after-temp-sync', 'after-rename']) {
      const seam = `${replacement}:${boundary}`;
      await t.test(seam, async () => {
        const value = await run001Fixture();
        const crashed = exec(process.execPath, [cli, 'reconcile'], root, JSON.stringify(value.request), {
          ...process.env, MDLM_DEMO_TEST_CRASH: seam,
        });
        assert.equal(crashed.status, 86, `${seam}: ${crashed.stderr}`);

        const resumed = exec(process.execPath, [cli, 'reconcile'], root, JSON.stringify(value.request));
        assert.equal(resumed.status, 0, `${seam}: ${resumed.stderr}`);
        assert.match(JSON.parse(resumed.stdout).status, /^(?:reconciled|already-reconciled)$/);
        const trusted = JSON.parse(await readFile(path.join(value.identityDirectory, 'repository-identity.json')));
        assert.equal(trusted.lifecycleRepository.head, 'db99d2e68d7c764ea760986465263c80ca2edac7', seam);
        assert.deepEqual(trusted.lastAssignment, { id: assignmentA, outcome: 'accepted-publication', completed: true }, seam);
        assert.equal(JSON.parse(await readFile(path.join(value.sourceDirectory, 'transaction.json'))).phase, 'completed', seam);
      });
    }
  }
});

test('non-timeout recovery rejects wrong or extra pending replacement bytes', async t => {
  const cases = [
    ['wrong temporary bytes', async (directory, entries) => {
      const temporary = entries.find(name => name.endsWith('.tmp'));
      assert.ok(temporary);
      await writeFile(path.join(directory, temporary), 'wrong replacement bytes\n');
    }],
    ['extra temporary file', async (directory, entries) => {
      const intent = entries.find(name => name.endsWith('.json'));
      assert.ok(intent);
      await writeFile(path.join(directory, `${intent}.extra.tmp`), 'extra replacement bytes\n');
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const value = await run001Fixture();
      const identityPath = path.join(value.identityDirectory, 'repository-identity.json');
      const before = await readFile(identityPath);
      const crashed = exec(process.execPath, [cli, 'reconcile'], root, JSON.stringify(value.request), {
        ...process.env, MDLM_DEMO_TEST_CRASH: 'authenticated:after-temp-sync',
      });
      assert.equal(crashed.status, 86, crashed.stderr);
      const directory = path.join(value.identityDirectory, 'checkpoint-reconciliations');
      await mutate(directory, await readdir(directory));

      const resumed = exec(process.execPath, [cli, 'reconcile'], root, JSON.stringify(value.request));

      assert.equal(resumed.status, 1, `${name}: ${resumed.stdout}\n${resumed.stderr}`);
      assert.match(resumed.stderr, /durable JSON replacement|checkpoint reconciliation directory/, name);
      assert.deepEqual(await readFile(identityPath), before, name);
      assert.equal(await stat(path.join(value.sourceDirectory, 'transaction.json')).then(() => true, () => false), false, name);
    });
  }
});

test('non-timeout recovery rejects repinned outer command and runner substitutions before mutation', async t => {
  const cases = [
    ['runner argv', record => { record.argv[2] = 'resume'; }],
    ['cwd', (record, value) => { record.cwd = value.scratch; }],
    ['runtime', record => { record.runtime.executable.digest = `sha256:${'0'.repeat(64)}`; }],
    ['runner commit', record => { record.runner.commit = '1'.repeat(40); }],
    ['runner tree', record => { record.runner.tree = '2'.repeat(40); }],
    ['launcher digest', record => { record.runner.launcher.digest = `sha256:${'3'.repeat(64)}`; }],
    ['dependency closure', record => {
      record.runner.dependencyClosure.entries.find(entry => entry.path === 'src/cli.mjs').digest = `sha256:${'4'.repeat(64)}`;
      record.runner.dependencyClosure.digest = digestBytes(Buffer.from(JSON.stringify(record.runner.dependencyClosure.entries)));
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const value = await run001Fixture();
      await replacePinnedJson(value.request.evidence.outerCommand.record, record => mutate(record, value));
      const identityPath = path.join(value.identityDirectory, 'repository-identity.json');
      const before = await readFile(identityPath);

      const execution = exec(process.execPath, [cli, 'reconcile'], root, JSON.stringify(value.request));

      assert.equal(execution.status, 1, `${name}: ${execution.stdout}\n${execution.stderr}`);
      assert.match(execution.stderr, /outer command|runner|runtime|dependency closure/, name);
      assert.doesNotMatch(execution.stderr, /must contain exactly stdout, stderr, and exit/, name);
      assert.deepEqual(await readFile(identityPath), before, name);
      assert.equal(await stat(path.join(value.sourceDirectory, 'transaction.json')).then(() => true, () => false), false, name);
    });
  }
});

test('non-timeout recovery rejects coherently repinned provenance and executable evidence before mutation', async t => {
  const cases = [
    ['altered source configured path and expected commit/tree', async value => {
      await replacePinnedJson(value.request.evidence.request, request => {
        request.provenance.source = {
          repository: '/coherently-repinned/source',
          commit: '0'.repeat(40),
          tree: '1'.repeat(40),
        };
      });
    }],
    ['altered artifact, tooling, tool, and qualification-harness configured paths and expected pins', async value => {
      await replacePinnedJson(value.request.evidence.request, request => {
        request.provenance.package = {
          artifact: '/coherently-repinned/artifacts/mdlm.tgz',
          digest: `sha256:${'2'.repeat(64)}`,
        };
        request.provenance.piPackage = {
          artifact: '/coherently-repinned/artifacts/mdlm-pi.tgz',
          digest: `sha256:${'3'.repeat(64)}`,
        };
        request.provenance.tooling = {
          root: '/coherently-repinned/tooling',
          digest: `sha256:${'4'.repeat(64)}`,
          lock: {
            path: '/coherently-repinned/tooling/package-lock.json',
            digest: `sha256:${'5'.repeat(64)}`,
          },
        };
        request.provenance.tools = {
          mdlm: {
            path: '/coherently-repinned/tooling/mdlm.js',
            digest: `sha256:${'6'.repeat(64)}`,
          },
          mdlmPi: {
            path: '/coherently-repinned/tooling/mdlm-pi.js',
            digest: `sha256:${'7'.repeat(64)}`,
          },
        };
        request.provenance.qualificationHarness = {
          repository: '/coherently-repinned/harness',
          commit: '8'.repeat(40),
          tree: '9'.repeat(40),
          repositoryLocator: 'https://example.invalid/coherently-repinned-harness.git',
          manifest: {
            path: '/coherently-repinned/harness/manifest.json',
            digest: `sha256:${'a'.repeat(64)}`,
          },
        };
      });
    }],
    ['coherently altered commands, authorization, result, and shim executable', async value => {
      const substituteRoot = path.join(value.scratch, 'substitute-executables');
      const substituteMdlm = path.join(substituteRoot, 'mdlm.js');
      const substituteMdlmPi = path.join(substituteRoot, 'mdlm-pi.js');
      const substituteShim = path.join(substituteRoot, 'mdlm-demo-mdlm-shim.mjs');
      await mkdir(substituteRoot);
      for (const file of [substituteMdlm, substituteMdlmPi, substituteShim]) {
        await writeFile(file, '#!/usr/bin/env node\n');
        await chmod(file, 0o755);
      }
      await replacePinnedJson(value.request.evidence.request, request => {
        request.commands.mdlm = substituteMdlm;
        request.commands.mdlmPi = substituteMdlmPi;
        request.provenance.tools.mdlm = { path: substituteMdlm, digest: null };
        request.provenance.tools.mdlmPi = { path: substituteMdlmPi, digest: null };
      });
      const requestDocument = JSON.parse(await readFile(value.request.evidence.request.path));
      requestDocument.provenance.tools.mdlm.digest = await digest(substituteMdlm);
      requestDocument.provenance.tools.mdlmPi.digest = await digest(substituteMdlmPi);
      await writeFile(value.request.evidence.request.path, `${JSON.stringify(requestDocument, null, 2)}\n`);
      value.request.evidence.request.digest = await digest(value.request.evidence.request.path);

      await replacePinnedJson(value.request.evidence.commands[0].record, record => {
        record.argv[0] = substituteMdlm;
      });
      const second = await replacePinnedJson(value.request.evidence.commands[1].record, record => {
        record.argv[0] = substituteMdlmPi;
        record.argv[4] = substituteShim;
      });
      await replacePinnedJson(value.request.evidence.shimConfig, config => {
        config.realMdlm = substituteMdlm;
      });
      const authorization = await replacePinnedJson(value.request.evidence.authorization, document => {
        document.command.argv = second.argv;
      });
      await replacePinnedJson(value.request.evidence.result, document => {
        document.authorization.digest = value.request.evidence.authorization.digest;
        document.process = second;
      });
      assert.deepEqual(authorization.command.argv, second.argv);
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const value = await run001Fixture();
      await mutate(value);
      const identityPath = path.join(value.identityDirectory, 'repository-identity.json');
      const before = await readFile(identityPath);

      const execution = exec(process.execPath, [cli, 'reconcile'], root, JSON.stringify(value.request));

      assert.equal(execution.status, 1, `${name}: ${execution.stdout}\n${execution.stderr}`);
      assert.match(execution.stderr, /mdlm-demo-error@1/, name);
      assert.deepEqual(await readFile(identityPath), before, name);
      assert.equal(await stat(path.join(value.sourceDirectory, 'transaction.json')).then(() => true, () => false), false, name);
    });
  }
});

test('non-timeout recovery rejects missing, drifted, truncated, and cross-run evidence before mutation', async () => {
  const cases = [
    ['missing outer command record', value => { delete value.request.evidence.outerCommand.record; }],
    ['missing result', value => rm(value.request.evidence.result.path)],
    ['repository drift', async value => {
      await writeFile(path.join(value.repository, 'unrelated.txt'), 'unrelated\n');
      const add = exec('git', ['add', 'unrelated.txt'], value.repository);
      assert.equal(add.status, 0, add.stderr);
      const commit = exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'unrelated'], value.repository);
      assert.equal(commit.status, 0, commit.stderr);
    }],
    ['truncated command output with a matching operator pin', async value => {
      const file = value.request.evidence.commands[1].stdout.path;
      const bytes = await readFile(file);
      await chmod(file, 0o600);
      await writeFile(file, bytes.subarray(0, bytes.length - 1));
      value.request.evidence.commands[1].stdout.digest = await digest(file);
    }],
    ['package drift with a matching operator pin', async value => {
      const file = value.request.evidence.stopPacket.path;
      const packet = JSON.parse(await readFile(file));
      packet.package.digest = `sha256:${'0'.repeat(64)}`;
      await chmod(file, 0o600);
      await writeFile(file, `${JSON.stringify(packet, null, 2)}\n`);
      value.request.evidence.stopPacket.digest = await digest(file);
    }],
    ['cross-run request substitution', async value => {
      await cp(path.join(root, 'test/fixtures/run-046-reconciliation/request.json'), value.request.evidence.request.path);
      value.request.evidence.request.digest = await digest(value.request.evidence.request.path);
    }],
    ['prior B attempt evidence', value => mkdir(path.join(value.stateDirectory, 'assignments', assignmentKey(assignmentB)))],
  ];
  for (const [name, mutate] of cases) {
    const value = await run001Fixture();
    await mutate(value);
    const identityPath = path.join(value.identityDirectory, 'repository-identity.json');
    const before = await readFile(identityPath);

    const execution = exec(process.execPath, [cli, 'reconcile'], root, JSON.stringify(value.request));

    assert.equal(execution.status, 1, `${name}: ${execution.stdout}\n${execution.stderr}`);
    assert.match(execution.stderr, /mdlm-demo-error@1/, name);
    assert.deepEqual(await readFile(identityPath), before, name);
    assert.equal(await stat(path.join(value.sourceDirectory, 'transaction.json')).then(() => true, () => false), false, name);
    assert.deepEqual(
      await readdir(path.join(value.identityDirectory, 'checkpoint-reconciliations')).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      }),
      [],
      name,
    );
  }
});
