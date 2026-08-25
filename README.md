# MDLM demo orchestrator

This repository contains the issue #213 recovery runner. It does not contain a successful public demonstration and has not run a real lifecycle repository.

The runner uses four JSON commands:

```text
mdlm-demo-runner snapshot [--input FILE]
mdlm-demo-runner classify [--input FILE]
mdlm-demo-runner run [--input FILE]
mdlm-demo-runner resume [--input FILE]
```

Without `--input`, each command reads one JSON value from standard input. It writes one JSON result to standard output. Errors go to standard error and return exit status 1.

## Approved seams

Tests use the approved public seams.

1. The JSON CLI is the operator boundary. `snapshot`, `classify`, `run`, and `resume` do not require imports from MDLM.
2. `src/adapter.mjs` consumes exact `mdlm-assignment-packet@2` bytes. It returns exact `mdlm-assignment-response@1` bytes or `mdlm-demo-reserved-stop@1` before submission.
3. Process tests run fake `mdlm` and `mdlm-pi` executables in scratch Git repositories. They check raw process evidence, transaction counts, and Git commit counts.
4. Deterministic integrations import the installed `mdlm-pi` controller and Assignment runner. They prove attended Review-correction wording reaches proposal authority context, accepted Scenarios are not replayed, and publication A is committed before external Assignment B reaches the worker boundary.

`bin/mdlm-demo-mdlm-shim.mjs` inspects only successful `scenario prepare` JSON. It intercepts these exact Scenario references before a worker starts:

- `realize-verification-environment@1`
- `register-pilot-target@1`
- `execute-verification-run@1`

The shim also stops before the next Assignment. When Assignment A has completed and the next prepared Assignment B is external, it emits `accepted-assignment-then-external`: A is a trusted completion and B remains pre-submission. Before interception, the shim runs the same successful `scenario prepare` contract validator as the orchestrator. An exit-0 result with a wrong command, Assignment, package, repository, Scenario, response schema, or exact-input shape is a typed command-contract failure. The orchestrator authenticates a stop against the exact packet retained in its private stop directory; arbitrary process text is not enough. The shim does not inspect worker text, terminal output, or transcript phrases.

## Recovery rules

Every `run` and `resume` first resolves the lifecycle repository and worktree-private Git directory, then acquires a repository-wide lock beneath the canonical common Git directory. The lock is independent of caller-selected state paths and covers snapshotting, reconciliation, execution, and the post-run snapshot. The runner writes and syncs owner state at a unique private same-directory path, then uses an atomic no-clobber hard link to publish the canonical lock. The canonical path therefore never exposes a new ownerless directory. Ownerless or partial legacy locks are treated as initializing. Reclamation uses an atomic claim tied to the stale lock inode so competing reclaimers cannot remove a replacement lock. The runner then reconciles `doctor`, `status`, the active Assignment, assignment-keyed transaction state, Git, tools, package bytes, the installed Process Package, and source identities.

| Observed state | Result |
| --- | --- |
| Attended answer, active Assignment, matching fingerprints | Continue the same Assignment with a catalog decision |
| Attended Review correction, active Assignment, matching fingerprints | Continue the same Assignment |
| Lost correction worker session with an authentic durable `mdlm-pi` journal | Resume only if the installed controller exposes an authentic journal-resume operation; otherwise stop without stdin replay or Assignment restart |
| Clean command interruption before submission starts | Continue the same Assignment |
| External adapter stop before submission | Re-run the adapter against the same packet bytes |
| Captured response, submission not started | Submit the captured exact bytes |
| Accepted execution with journaled output paths and Git blob identities | Before generic drift checks, finish or recognize the one exact publication commit by HEAD, parent, subject, paths, and blobs |
| Completed transaction journal | Return `already-completed`; do not submit or commit again |
| Malformed, exhausted, stale, or abandoned Assignment | Stop as nonrecoverable |
| Tracked or untracked lifecycle changes before prepare or submit | Stop as nonrecoverable repository dirtiness |
| Repository, package, artifact, installed-tool closure, or source drift | Stop as nonrecoverable |
| Invalid provenance or failed integrity check | Stop as nonrecoverable |
| Submission started without accepted execution evidence | Stop as an uncertain transaction; never retry automatically |
| Accepted execution with missing, mismatched, or ambiguous Git publication evidence | Stop as uncertain publication; never retry automatically |
| Explicit terminal, invalid, dead-end, boundary, abandoned, or complete outcome | Record the typed lifecycle outcome; never treat it as a generic retryable command failure |

A failed command is not enough to make a retry safe. The journal must still say that submission never started. Once the journal reaches `submitting`, only exact accepted-execution evidence can settle the transaction. Journal replacement uses a unique temporary file, file `fsync`, parent-directory `fsync`, atomic rename, and a second parent-directory `fsync`.

A clean unrelated lifecycle-repository commit is drift, not recovery. Expected values supplied by a later request cannot bless changes to source, harness, artifact, executable target, installed Process Package, or an existing Assignment boundary. Successive ordinary Assignments get separate immutable directories beneath `stateDirectory/assignments`; repository identity and locking remain repository-wide.

## Evidence

`snapshot` creates the requested directory with exclusive creation. A second call cannot replace it. The directory contains:

- raw stdout and stderr bytes for `git rev-parse`, `git status`, `mdlm doctor`, `mdlm status`, and `mdlm assignment show`
- argv, working directory, deadline, timestamps, exit status, signal, and SHA-256 for each command
- Git HEAD, tree, a tracked-state digest computed from HEAD plus staged and worktree patches, and porcelain status
- lifecycle repository identity kept separate from Assignment repository identity
- Assignment identity and state
- the transaction journal bytes and digest, when present
- exact source and qualification-harness commit/tree identities, harness repository locator, and harness manifest bytes
- separate MDLM and MDLM-Pi archive identities, configured/real executable identities, the lockfile identity, and a path-independent digest of the complete installed tooling tree (relative entry names, types, modes, symlink targets, sizes, and file digests)
- `manifest.json` with byte lengths and SHA-256 values

Every command record includes spawn errors and output-limit state as well as exit/signal/deadline evidence. Nonzero commands, malformed JSON, and semantic contract violations produce a complete immutable snapshot whose result is `command-failure`; evidence capture does not substitute an exception for the failed command. Successful MDLM JSON is checked for its exact command and contract, `ok`, supported outcome/allocation/disposition, Process Package, repository fingerprint, and Assignment shapes before semantic state is exposed. Every run also returns a post-run snapshot.

The runner removes write permission from completed snapshot files and directories. Process commands after the snapshot go into create-once files under the Assignment directory. The transaction journal remains mutable only through durable atomic replacement. Each later snapshot captures its then-current bytes.

## External adapter inputs

The environment adapter extracts one VSP with `payload.environment_profile` from packet `exactInputs`. It runs the issue #215 generator and preflight at the configured harness checkout. The checkout must have the configured clean HEAD and tree. The known public harness identity is:

```text
commit 79c87627aaf48ca3261a3476aa82c52524f3c938
tree   e7311ce6e36df8df6fa840ea2df70ff00fe316c1
```

The other two external Scenarios require an adapter input catalog:

```json
{
  "contract": "mdlm-external-adapter-inputs@1",
  "scenarios": {
    "register-pilot-target@1": {
      "kind": "exact-response",
      "responsePath": "/absolute/path/to/exact-response.json",
      "observationsPath": "/absolute/path/to/observations.json"
    },
    "execute-verification-run@1": {
      "kind": "exact-response",
      "responsePath": "/absolute/path/to/exact-response.json",
      "observationsPath": "/absolute/path/to/observations.json"
    }
  }
}
```

Each observations file uses `mdlm-external-observations@1`, names the Assignment and Scenario, and has a nonempty `product` object. The runner does not derive or invent product target observations.

## Operator decisions

Attended runs use a decision catalog. The digest covers the exact UTF-8 wording bytes.

```json
{
  "contract": "mdlm-demo-decision-catalog@1",
  "decisions": [
    {
      "assignment": "ASSIGNMENT_UUID",
      "wording": "THE EXACT ANSWER OR REVIEW CORRECTION",
      "origin": "operator-selected",
      "authorityBasis": "Standing authorization permits operator selection without pausing for user input.",
      "digest": "sha256:WORDING_SHA256"
    }
  ]
}
```

The runner records the origin, authority basis, and digest. It does not label the wording as user-authored.

## Run request

`run` requires `mdlm-demo-run-request@1`. `resume` uses the same fields with `mdlm-demo-resume-request@1`.

```json
{
  "contract": "mdlm-demo-run-request@1",
  "repository": "/absolute/path/to/lifecycle-repository",
  "assignmentId": "ASSIGNMENT_UUID",
  "stateDirectory": "/absolute/path/to/private-run-state",
  "evidenceDirectory": "/absolute/path/to/immutable-evidence",
  "timeoutMs": 30000,
  "signal": "clean-interrupted-command",
  "commands": {
    "mdlm": "/absolute/path/to/mdlm",
    "mdlmPi": "/absolute/path/to/mdlm-pi"
  },
  "adapterInputsPath": "/absolute/path/to/adapter-inputs.json",
  "decisionCatalogPath": "/absolute/path/to/decisions.json",
  "harness": {
    "directory": "/absolute/path/to/mdlm-phase1-qualification-harness",
    "commit": "79c87627aaf48ca3261a3476aa82c52524f3c938",
    "tree": "e7311ce6e36df8df6fa840ea2df70ff00fe316c1",
    "repositoryLocator": "https://github.com/taylorrowser/mdlm-phase1-qualification-harness.git"
  },
  "provenance": {
    "source": {
      "repository": "/absolute/path/to/mdlm-source",
      "commit": "SOURCE_COMMIT",
      "tree": "SOURCE_TREE"
    },
    "package": {
      "artifact": "/absolute/path/to/mdlm.tgz",
      "digest": "sha256:MDLM_ARCHIVE_SHA256"
    },
    "piPackage": {
      "artifact": "/absolute/path/to/mdlm-pi.tgz",
      "digest": "sha256:MDLM_PI_ARCHIVE_SHA256"
    },
    "tooling": {
      "root": "/absolute/path/to/installed-tooling-root",
      "digest": "sha256:PATH_INDEPENDENT_TREE_SHA256",
      "lock": {
        "path": "/absolute/path/to/installed-tooling-root/package-lock.json",
        "digest": "sha256:LOCKFILE_SHA256"
      }
    },
    "tools": {
      "mdlm": {
        "path": "/absolute/path/to/mdlm",
        "digest": "sha256:EXECUTABLE_SHA256"
      },
      "mdlmPi": {
        "path": "/absolute/path/to/mdlm-pi",
        "digest": "sha256:EXECUTABLE_SHA256"
      }
    },
    "qualificationHarness": {
      "repository": "/absolute/path/to/mdlm-phase1-qualification-harness",
      "commit": "79c87627aaf48ca3261a3476aa82c52524f3c938",
      "tree": "e7311ce6e36df8df6fa840ea2df70ff00fe316c1",
      "repositoryLocator": "https://github.com/taylorrowser/mdlm-phase1-qualification-harness.git",
      "manifest": {
        "path": "/absolute/path/to/tracked-qualification-manifest.json",
        "digest": "sha256:MANIFEST_SHA256"
      }
    }
  }
}
```

Each archive digest is the SHA-256 of its configured file bytes. Archive identities, installed-tree identity, lock identity, executable identities, and the MDLM Process Package identity remain separate. The installed-tree digest is independent of its absolute root and covers neighboring dependencies as well as `mdlm` and `mdlm-pi`; both configured executables and the lockfile must resolve within that tree. Configured paths and resolved real paths are recorded where applicable. The runner compares the Process Package identity across status, Assignment state, and packet data. It does not claim that a tarball digest equals the Process Package digest unless the operator supplies evidence for that relationship.

## Commands

```bash
npm test
npm run check
```

After an operator creates and reviews `operator-inputs/issue-213-first-run.json`, the exact first real-demo command is:

```bash
cd /home/ubuntu/git/mdlm-demo-orchestrator && node ./bin/mdlm-demo-runner.mjs run --input ./operator-inputs/issue-213-first-run.json
```

That command has not been run. No remote has been created, and no result from this repository has public acceptance status.

## Current limits

- The runner supports the issue #213 Phase 1 path. It is not a general workflow scheduler.
- An uncertain submit or publication requires operator evidence. Automatic recovery refuses it.
- `mdlm-pi` owns worker-session correction recovery. The inspected packaged controller reports `assignment-correction-session-lost` but exposes no correction-session resume command, so this runner currently stops without stdin replay or Assignment restart even when the durable context is authentic.
- Accepted publication paths must use a UUIDv4 execution ID and remain canonical regular files below `.lifecycle/data/.transactions/<execution-id>`. Traversal, duplicate paths, symlink components, and canonical-path changes are rejected before hashing or staging.
- Child processes receive an allowlisted environment. Git subprocesses additionally use isolated system/global configuration; ambient Git, Node, and shell-startup injection variables are removed. The policy is recorded in each snapshot.
- For the issue #212 run, the authoritative `mdlm` archive is SHA-256 `8f7eb4b7d4e04a053713c72debc2a4a71d7878a0a9ed084ade8c964e9eef6cf7`, and the separate `mdlm-pi` archive is SHA-256 `d3e99c2ebd13f1167ac2041f586b9bbe8fa738388020d9103cad10b90f17df3b`. The read-only installed tooling root currently hashes to `sha256:a16e6aeeb1ee082a500e11494d5c924f29a44f71736d4681e2895ee653f4c5f0` across 17,276 entries, with lock identity `sha256:028cb194bc2b0bfdaf8e631cd03cd3bf3aeadb64e2284eaad7e19061da90b294`. The MDLM archive was rebuilt from source commit `516f9e0ef52bb5fcc47cce56282a44075c5af4f2` and tree `623575c22b53bd6a2a21c73c4420ca5f26aaa172`. Its installed Process Package independently recomputes as `sha256:ee99e698d36e406a836a796a36fc1db2d2451072ad662c0e06805ab5c20fe5ac`. Archive, installed closure, and Process Package digests remain distinct identities and must match their configured boundaries.
