# MDLM demo orchestrator

This public repository contains the issue #213 recovery runner. It does not yet contain a successful public demonstration and has not run a real lifecycle repository.

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

The shim also stops before the first different Assignment B prepared after Assignment A. It emits `assignment-checkpoint` for an ordinary B or `accepted-assignment-then-external` for an external B, and both stops explicitly name `completedAssignment` A. The runner trusts either stop as completion of A only after authenticating the exact retained B packet and proving from a complete post-run snapshot that B is the selected active Assignment at the packet's clean repository and Process Package boundary. A valid result returns B as `pre-submission` and advances repository-wide identity to that exact boundary; B's later run uses its own Assignment-keyed state. Same-Assignment stops, arbitrary process text, packets outside the private shim stop directory, and packet, package, repository, or status mismatches never advance trust. Before interception, the shim runs the same successful `scenario prepare` contract validator as the orchestrator. An exit-0 result with a wrong command, Assignment, package, repository, Scenario, response schema, or exact-input shape is a typed command-contract failure. The shim does not inspect worker text, terminal output, or transcript phrases.

## Recovery rules

Every `run` and `resume` first resolves the lifecycle repository and worktree-private Git directory, then acquires a repository-wide lock beneath the canonical common Git directory. The lock is independent of caller-selected state paths and covers snapshotting, reconciliation, execution, and the post-run snapshot. The runner writes and syncs owner state at a unique private same-directory path, then uses an atomic no-clobber hard link to publish the canonical lock. The canonical path therefore never exposes a new ownerless directory. Ownerless or partial legacy locks are treated as initializing. Reclamation uses an atomic claim tied to the stale lock inode so competing reclaimers cannot remove a replacement lock. The runner then reconciles `doctor`, `status`, the active Assignment, assignment-keyed transaction state, Git, tools, package bytes, the installed Process Package, and source identities.

| Observed state | Result |
| --- | --- |
| Attended answer, active Assignment, matching fingerprints | Continue the same Assignment with a catalog decision |
| Attended Review correction, active Assignment, matching fingerprints | Continue the same Assignment |
| Lost correction worker session with an authentic durable `mdlm-pi` journal | Resume only if the installed controller exposes an authentic journal-resume operation; otherwise stop without stdin replay or Assignment restart |
| Clean command interruption before submission starts | Continue the same Assignment |
| Typed `mdlm-pi` operational failure with an exact unchanged clean post-run boundary and no transaction, controller journal, checkpoint, or private publication evidence before or after | Write a durable Assignment-scoped recovery marker and return `pre-submission-operational-failure`; reject `resume`, while a later `run` may retry |
| External adapter stop before submission | Re-run the adapter against the same packet bytes |
| Authenticated A-to-B checkpoint with active B at the exact clean packet boundary | Complete A, advance repository identity once, and return B pre-submission |
| Later B run with an old-runner A-to-B checkpoint still retained under A's private state | Require the operator-pinned post-run snapshot, reconcile the checkpoint once, complete A, then continue B without invoking A |
| Parent killed after an orphaned child completed A and checkpointed B, but before the parent wrote child command evidence or a post-run result | Require `orphanedCheckpointRecovery` with every external trust pin, authenticate the complete old and new boundaries, complete A once, then run B without invoking A |
| Accepted external publication followed by package-authored materializations | Record one create-once `mdlm next`, publish each exact completed transaction in output order, retire its exact pre-publication lease, then record one final `next` and checkpoint the Assignment at the clean final commit |
| Accepted external publication followed by preserved `mdlm next` materializations that were committed outside the runner | Require `materializedNextRecovery`, authenticate the accepted old boundary, exact `mdlm-next@1` bytes, ordered transaction commits, and final active Assignment, then advance repository identity once without replaying `next` or its executions |
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

A failed command is not enough to make a retry safe. For typed `mdlm-pi` operational failures, finalization compares the initial and post-run Git and MDLM command bytes, lifecycle identity, selected active Assignment, and Process Package. Both boundaries must be clean and exact. Runner and `mdlm-pi` journals must be absent in both snapshots with no read error. The Assignment-private stop directory must contain no checkpoint evidence before or after the child process. Changed or uncertain bytes, any journal, private checkpoint evidence, an untyped exit, or an ambiguous result remains nonrecoverable.

A recoverable `pre-submission-operational-failure` does not authorize `resume`. The runner writes an immutable marker under the worktree-private Git directory, keyed by Assignment and failed command index. It binds both repository boundaries, the Assignment and Process Package, the pinned run identity, all three failed-command evidence file hashes, the typed failure document hashes, and the outer and `mdlm-pi` timeout values. File and directory `fsync` plus atomic rename make marker creation crash-safe.

Every later `run` or `resume` validates the complete marker history before generic run-identity pinning, Scenario prepare, or `mdlm-pi` starts. A legacy marker binds the canonical regular `run-identity.json` path and its exact `@4` bytes, length, and digest. Missing, changed, extra, or symlinked identity bytes fail closed. An active marker returns typed `wrong-recovery-mode` for `resume` and leaves `@4` unchanged. A matching `run` writes an immutable retry transition and atomically upgrades the exact bound identity to `@5` with file and directory `fsync`. Crash recovery accepts `@4` until that recorded transition finishes the upgrade, and accepts exact `@5` afterward. Neither the marker nor its transition is deleted. Modified, duplicate, or ambiguous history stops as `operational-recovery-marker-invalid` before worker or model invocation. Preserve the Assignment state, command evidence, snapshots, and worktree-private recovery history.

The run-008 compatibility path handles the one real attempt made before markers existed. It requires `operationalFailureRecovery` with operator-pinned paths and digests for the preserved result, initial snapshot, and post-run snapshot. The runner resolves canonical paths, rejects symlinks and non-regular files, verifies both complete manifests and every file, and requires the result to reference those exact pins. The result must name Assignment `bdb9ffc9-3491-443b-88b0-80d5dc800781`, the exact typed 30000 ms `mdlm status --json` failure, and the matching private command bytes.

Both snapshots must prove the same clean active Assignment, repository, Process Package, and absent journals. The current boundary must still equal the post-run boundary. Private state must contain the exact Scenario prepare and `mdlm-pi run` command pair, the matching Assignment identity and shim configuration, no checkpoint evidence, and an exact `mdlm-demo-run-identity@4` for the pinned operator, artifacts, tools, source, harness, and Process Package. That identity has no timeout fields. Missing pins, extra commands, changed bytes, another Assignment, or another identity version cannot migrate.

The six request pins are the external trust root for this compatibility path. The operator or caller must copy them out-of-band from the preserved prior result, not calculate them from replacement evidence or mutable private state. Once those authorized pins are supplied, substituting evidence without changing the pins cannot migrate. The generic public runner cannot establish the provenance of pins that a caller deliberately fabricates. That caller already chooses the repository, commands, decisions, and recovery request, so issue-specific digests are test anchors and operator input, not production constants.

The run-009 orphaned-child path is separate. The shell wrapper killed the parent while it was snapshotting and finalizing, after `mdlm-pi` had completed Assignment A and the shim had checkpointed Assignment B. The parent therefore never wrote an `mdlm-pi` completion triplet, result, or post-run repository boundary. This is not ordinary checkpoint recovery, and the runner does not invent the missing parent evidence.

`orphanedCheckpointRecovery` supplies external trust pins for the run-009 initial snapshot, durable retry transition, exact Scenario prepare triplet, shim configuration, processed-Assignment marker, Assignment checkpoint marker, retained B packet, and a preserved clean post-run B snapshot. The runner requires exact keys at every level. It canonicalizes every path, rejects symlinks and non-regular files, verifies both complete snapshot manifests and all manifest-bound files, and checks every pinned file digest before using its contents.

The initial snapshot must show clean selected A at the old trusted repository boundary. The retry history must contain only the exact durable failure marker and run-only retry transition, with the 600000 ms command, 840000 ms Assignment, and 900000 ms child timeout policy. The transition and current durable identity must prove the exact operator and upgraded `mdlm-demo-run-identity@5`. Private A evidence must contain exactly the original Scenario prepare, the second-command operational failure, and the pinned retry prepare. Both prepare packets must match A, its repository boundary, and each other. Missing, extra, or later command evidence fails closed.

The prepare packet, shim configuration, processed marker, checkpoint marker, and stop packet must agree on A, B, the Process Package, configured tools, operator identity, old repository boundary, new repository boundary, and B Scenario. The pinned post-run snapshot and current initial snapshot must both show the same clean selected active B boundary by HEAD, tree, tracked-state digest, package, status, Assignment, and successful doctor result. Both doctors must report zero Process Package drift.

The runner also proves that the old HEAD is an ancestor of the new HEAD. Every intermediate commit must have one parent, an exact `mdlm: publish SCENARIO (EXECUTION_ID)` subject, paths confined to that execution's transaction directory, and a matching completed `mdlm-scenario-execution@4` record. Any merge, unrelated path, malformed transaction, missing execution output, or unexplained commit stops recovery.

After authentication, the existing durable reconciliation journal atomically advances repository identity and writes A's completed transaction. File and directory `fsync` plus atomic rename make every phase resumable. A repeated request verifies the same pins and returns `already-reconciled`. Recovery never prepares A or invokes its model. B proceeds through its normal `run` path.

After verification, the runner writes the durable run-only marker. `resume` stops before prepare or `mdlm-pi` starts and leaves the `@4` identity unchanged. `run` atomically upgrades it to `mdlm-demo-run-identity@5` with 600000 ms command, 840000 ms Assignment, and 900000 ms outer timeouts before one retry. Existing native `@5` marker recovery is unchanged.

Once a journal reaches `submitting`, only exact accepted-execution evidence can settle the transaction. Journal replacement uses a unique temporary file, file `fsync`, parent-directory `fsync`, atomic rename, and a second parent-directory `fsync`.

After a new external publication, the runner records `mdlm next --json` under create-once command evidence. A nonempty `materializedExecutions` list must name completed execution records whose canonical transaction paths account for the entire dirty worktree. The runner captures their blobs and commits one transaction at a time in output order. Its closure journal recognizes an exact commit completed before a crash and never repeats either `next` command. Missing or partial command evidence is uncertain and stops recovery.

The first `next` lease must match its reported Assignment, Process Package, and the accepted external publication boundary. After all listed transactions are committed, the runner removes only those exact lease bytes. It then records one final `next`, requires no further materializations, and uses the post-run snapshot to authenticate the final active Assignment at the clean final commit before advancing repository identity. A zero-length materialization list leaves the accepted-publication result unchanged. Operator-pinned `materializedNextRecovery` remains available for runs created by older runner versions.

A clean unrelated lifecycle-repository commit is drift, not recovery. Expected values supplied by a later request cannot bless changes to source, harness, artifact, executable target, installed Process Package, or an existing Assignment boundary. Successive ordinary Assignments get separate immutable directories beneath `stateDirectory/assignments`; repository identity and locking remain repository-wide.

A later B `run` or `resume` may repair the old-runner case where A reached a clean B boundary but the repository-wide identity still names A. Recovery runs before the generic repository-drift check. It requires A's assignment identity, both command-evidence triplets, shim configuration, the sole retained B packet, and `checkpointRecovery` in the request. The operator must copy the post-run snapshot path and digest from the preserved A run result before upgrading the runner. A digest read or recalculated from the mutable checkpoint state is not an external pin.

The runner canonicalizes the pinned snapshot directory with `realpath`, rejects symlinks, checks the operator's digest against the exact manifest bytes, and verifies every manifest-bound file. The snapshot must be a complete post-run snapshot. Its repository path, clean Git HEAD, tree, tracked state, deselected A record, active-B status, and doctor and status Process Package must match the retained packet and the current initial snapshot. The runner also verifies raw checkpoint byte hashes, Base64 fields, argv, executable paths, working directory, timeout and process termination fields, typed stderr, operator settings, package identity, Scenario, and both repository fingerprints. It rejects missing files, extra commands or stops, same-Assignment checkpoints, dirty state, and any current boundary other than the pinned B boundary. The retained `mdlm-pi` stdout is hash-checked but never used as semantic proof.

The recovery writes one `mdlm-demo-checkpoint-reconciliation@1` journal beneath the worktree-private Git directory. The journal binds the canonical snapshot path, operator digest, and verified manifest identity. File and directory `fsync` plus atomic rename make its `authenticated`, `boundary-advanced`, and `completed` phases resumable. It advances repository identity only from the recorded A boundary, writes A's completed transaction once, and leaves lifecycle data untouched. Repeating recovery verifies the same pinned snapshot and retained bytes, then returns `checkpointReconciliation.status: "already-reconciled"`; it does not invoke `mdlm-pi` for A or prepare A again.

Normal A-to-B checkpoints authenticated during the same runner invocation do not use `checkpointRecovery`.

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

`test/fixtures/calculator-run-003-checkpoint` retains the real run-003 A identity, both command triplets, shim configuration, and B stop packet byte for byte. `test/fixtures/calculator-run-003-post-snapshot` retains the authoritative post-run snapshot whose manifest digest is `sha256:8bf25285f59b0deddfbbaaabbea617da6682d2f66ef239c0ff9665203da2838e`. The process tests assert the fixture digests before deriving scratch-repository boundaries from them.

`test/fixtures/calculator-run-009-orphaned-checkpoint` retains the real run-009 initial snapshot, the preserved run-012 clean B post-run snapshot, A's Assignment identity, all three command-evidence triplets, shim configuration, processed marker, A-to-B checkpoint marker, retained B packet, operational failure marker, retry transition, and upgraded run identity. Tests anchor the initial manifest at `sha256:5ee054a6c1b49a340e45e100f47378cbbb9b88c71072270a79a1f22ba536ed0b` and the post-run manifest at `sha256:62e54259deb615c39530282ef66df299fa03ecfd569e4032814f08831350f348`, plus every private trust artifact digest.

`test/fixtures/calculator-run-008-operational-failure` retains the exact run result, both immutable snapshots, Assignment identity, shim configuration, and both private command-evidence triplets for the real 30000 ms `mdlm status --json` failure. Before deriving portable scratch-repository material, tests require the exact result digest `940cd1d5ee4d332907ff4d92af5b0d1789e66cb8687c60bb909324d71ad76523`, initial manifest digest `fe25aabb438387d7a6828e1bf4c168b75bb0b8d517c627c7ceb57334e6865b7f`, and post-run manifest digest `e44d04e03e803736581ba95ecb4f95cae92d390de24921d76ce8c07a1225a817`. The regression begins from markerless `@4` state. It does not create a native marker and delete it.

Every command record includes spawn errors and output-limit state as well as exit/signal/deadline evidence. Nonzero commands, malformed JSON, and semantic contract violations produce a complete immutable snapshot whose result is `command-failure`; evidence capture does not substitute an exception for the failed command. `mdlm doctor --json` is checked against the shape the CLI emits: command `doctor`, boolean `ok`, safe diagnostics, Process Package identity, baseline verification counts, and generated projection summaries. Doctor output has no contract discriminator. Status and Assignment JSON must retain their exact versioned contract and command discriminators, supported outcome/allocation/disposition, Process Package, repository fingerprint, and Assignment shapes before the runner exposes semantic state. Every run also returns a post-run snapshot.

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
  "timeoutMs": 900000,
  "mdlmPiCommandTimeoutMs": 600000,
  "mdlmPiAssignmentTimeoutMs": 840000,
  "signal": "clean-interrupted-command",
  "checkpointRecovery": {
    "snapshotDirectory": "/absolute/path/to/preserved/post-run-snapshot",
    "digest": "sha256:POST_RUN_MANIFEST_SHA256_FROM_PRESERVED_RUN_RESULT"
  },
  "orphanedCheckpointRecovery": {
    "initialSnapshotDirectory": "/home/ubuntu/git/mdlm-successor-demos/evidence/issue-212-final/calculator-post214/run-009-snapshot/snapshot-000001",
    "initialSnapshotDigest": "sha256:5ee054a6c1b49a340e45e100f47378cbbb9b88c71072270a79a1f22ba536ed0b",
    "retryTransition": {
      "path": "/home/ubuntu/git/mdlm-successor-demos/issue-212/calculator-post214-resumable-20260825T0050Z/.git/mdlm-demo-orchestrator/operational-failure-recoveries/bdb9ffc9-3491-443b-88b0-80d5dc800781-622b1ddf8c21/retry-000002.json",
      "digest": "sha256:fb5472e57ac0d1b2760c26f06045f8f7c64ee2723d21077e07d08559f3e7173f"
    },
    "prepare": {
      "record": { "path": "/home/ubuntu/git/mdlm-successor-demos/evidence/issue-212-final/calculator-post214/private-state/assignments/bdb9ffc9-3491-443b-88b0-80d5dc800781-622b1ddf8c21/command-evidence/command-000003.json", "digest": "sha256:3a604548fbf8817c5c68ef31d005598b4644e1ceddce0267f8c620315c8b0995" },
      "stdout": { "path": "/home/ubuntu/git/mdlm-successor-demos/evidence/issue-212-final/calculator-post214/private-state/assignments/bdb9ffc9-3491-443b-88b0-80d5dc800781-622b1ddf8c21/command-evidence/command-000003.stdout", "digest": "sha256:33a70ec41e03544a59d40d9cec3a6365df055f836b95b7b8c48575dfe40b2ad2" },
      "stderr": { "path": "/home/ubuntu/git/mdlm-successor-demos/evidence/issue-212-final/calculator-post214/private-state/assignments/bdb9ffc9-3491-443b-88b0-80d5dc800781-622b1ddf8c21/command-evidence/command-000003.stderr", "digest": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }
    },
    "shimConfig": { "path": "/home/ubuntu/git/mdlm-successor-demos/evidence/issue-212-final/calculator-post214/private-state/assignments/bdb9ffc9-3491-443b-88b0-80d5dc800781-622b1ddf8c21/shim/config.json", "digest": "sha256:e40adb042520fcfb6ebf15e8a2b6790b930fcc319b70c972d52e8488d6db9865" },
    "processedAssignment": { "path": "/home/ubuntu/git/mdlm-successor-demos/evidence/issue-212-final/calculator-post214/private-state/assignments/bdb9ffc9-3491-443b-88b0-80d5dc800781-622b1ddf8c21/shim/processed-assignment.json", "digest": "sha256:f67ee9ac146adb5498ff8c091b6a3f2725dbcfc57c863e4f56553798f5003008" },
    "assignmentCheckpoint": { "path": "/home/ubuntu/git/mdlm-successor-demos/evidence/issue-212-final/calculator-post214/private-state/assignments/bdb9ffc9-3491-443b-88b0-80d5dc800781-622b1ddf8c21/shim/assignment-checkpoint.json", "digest": "sha256:5c61bd67b05cba4aabbfa373bcf771b3d6ffd59815d86972f5241b37241a31d9" },
    "stopPacket": { "path": "/home/ubuntu/git/mdlm-successor-demos/evidence/issue-212-final/calculator-post214/private-state/assignments/bdb9ffc9-3491-443b-88b0-80d5dc800781-622b1ddf8c21/shim/stops/1b7355d0-b445-4c70-b76d-2242299e3170.json", "digest": "sha256:b49c5ce2503bc145e40805ec242466d0b08976b24c5afa56b85d04077a334e2b" },
    "postSnapshotDirectory": "/home/ubuntu/git/mdlm-successor-demos/evidence/issue-212-final/calculator-post214/run-012-snapshot/snapshot-000002",
    "postSnapshotDigest": "sha256:62e54259deb615c39530282ef66df299fa03ecfd569e4032814f08831350f348"
  },
  "materializedNextRecovery": {
    "acceptedResult": {
      "path": "/home/ubuntu/git/mdlm-successor-demos/evidence/issue-212-final/calculator-post214/run-035.runner.stdout",
      "digest": "sha256:3adf13603980f3b441ba5956ce9a2d36edebb862f25d2f577aaaf3480c75294b"
    },
    "oldSnapshot": {
      "directory": "/home/ubuntu/git/mdlm-successor-demos/evidence/issue-212-final/calculator-post214/run-035-snapshot/snapshot-000002",
      "digest": "sha256:c7133f84e054b892c7bbe692c21d000b8d9c8d83900f4fb2ad3a7ad3f520a21f"
    },
    "nextStdout": {
      "path": "/home/ubuntu/git/mdlm-successor-demos/evidence/issue-212-final/calculator-post214/post-run-035-next.stdout",
      "digest": "sha256:d66988a937e8828479b7a09fea90d019246ca343fb8863ee8ba4813d9d06b689"
    },
    "nextStderr": {
      "path": "/home/ubuntu/git/mdlm-successor-demos/evidence/issue-212-final/calculator-post214/post-run-035-next.stderr",
      "digest": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    },
    "nextExit": {
      "path": "/home/ubuntu/git/mdlm-successor-demos/evidence/issue-212-final/calculator-post214/post-run-035-next.exit",
      "digest": "sha256:9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa"
    },
    "finalSnapshot": {
      "directory": "/home/ubuntu/git/mdlm-successor-demos/evidence/issue-212-final/calculator-post214/run-036-snapshot/snapshot-000001",
      "digest": "sha256:2026779c7dc29e5dac5b19a8e7af171735588f28d1434a7d0accd88854ab508f"
    }
  },
  "operationalFailureRecovery": {
    "resultPath": "/home/ubuntu/git/mdlm-successor-demos/evidence/issue-212-final/calculator-post214/run-008.runner.stdout",
    "resultDigest": "sha256:940cd1d5ee4d332907ff4d92af5b0d1789e66cb8687c60bb909324d71ad76523",
    "initialSnapshotDirectory": "/home/ubuntu/git/mdlm-successor-demos/evidence/issue-212-final/calculator-post214/run-008-snapshot/snapshot-000001",
    "initialSnapshotDigest": "sha256:fe25aabb438387d7a6828e1bf4c168b75bb0b8d517c627c7ceb57334e6865b7f",
    "postSnapshotDirectory": "/home/ubuntu/git/mdlm-successor-demos/evidence/issue-212-final/calculator-post214/run-008-snapshot/snapshot-000002",
    "postSnapshotDigest": "sha256:e44d04e03e803736581ba95ecb4f95cae92d390de24921d76ce8c07a1225a817"
  },
  "operator": {
    "provider": "openai-codex",
    "model": "gpt-5.6-sol",
    "thinking": "high"
  },
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

The `checkpointRecovery` object is optional except for after-the-fact reconciliation of a checkpoint retained by an older runner. It accepts exactly `snapshotDirectory` and `digest`. Preserve the prior run result before upgrading, then copy its `postRunSnapshot.snapshotDirectory` and `postRunSnapshot.digest` values into the recovery request. Do not derive the requested digest from the checkpoint packet, current repository, or mutable private state.

The `materializedNextRecovery` object is optional except for the preserved run-035 to run-036 materialization gap. It accepts exactly `acceptedResult`, `oldSnapshot`, `nextStdout`, `nextStderr`, `nextExit`, and `finalSnapshot`. File pins accept exactly `path` and `digest`; snapshot pins accept exactly `directory` and `digest`. The runner reads pinned files through no-follow descriptors and verifies complete snapshot manifests before parsing them.

Recovery requires the accepted result and old snapshot to agree on the old clean publication boundary. It then checks the exact successful `mdlm-next@1` result and Process Package, including every completed materialized execution in evaluation order. The commits between the old and final boundaries must form a single-parent chain with one canonical publication subject and one matching transaction directory per listed execution. Each transaction must contain regular files, a completed matching `mdlm-scenario-execution@4`, and exactly its declared outputs. Missing, reordered, extra, merged, unrelated, symlinked, or substituted evidence fails closed.

The pinned final pre-run snapshot and the live initial snapshot must agree on the clean HEAD, tree, tracked-state digest, selected active Assignment, Assignment repository fingerprint, Process Package, successful doctor result, and zero process drift. After authentication, a durable `authenticated`, `boundary-advanced`, and `completed` journal advances repository identity with atomic write, file sync, directory sync, and rename. Recovery never runs `mdlm next` or republishes a transaction. Repeating the same pinned request returns `materializedNextReconciliation.status: "already-reconciled"`.

The `operationalFailureRecovery` object is optional except for migration of the markerless run-008 failure. It accepts exactly `resultPath`, `resultDigest`, `initialSnapshotDirectory`, `initialSnapshotDigest`, `postSnapshotDirectory`, and `postSnapshotDigest`. Copy all six values out-of-band from the preserved prior result. A digest calculated from mutable private state or replacement evidence is not an authorized external pin.

The `orphanedCheckpointRecovery` object is optional except when a child checkpoint survived without its parent command completion and result. Its top-level keys and every `{ path, digest }` object are exact. The example contains the preserved canonical run-009 paths. Copy every digest from an independently authorized request or evidence index. Recalculating a digest after changing private evidence defeats the operator trust process and does not make the changed evidence authentic.

The `operator` object is mandatory for `run` and `resume`. Provider and model are safe nonempty scalar tokens. Thinking is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. The runner validates these values before resolving or snapshotting the lifecycle repository, pins them in durable run identity, rejects exact drift on resume, and passes them to `mdlm-pi` as explicit `--provider`, `--model`, and `--thinking` arguments.

Every run and resume request must include positive safe integers for `timeoutMs`, `mdlmPiCommandTimeoutMs`, and `mdlmPiAssignmentTimeoutMs`. Each `mdlm-pi` timeout must leave at least 60000 ms below the outer timeout so the runner can terminate the child and capture its post-run snapshot. The issue #212 policy is 900000 ms outer, 600000 ms per MDLM command, and 840000 ms per Assignment. The runner passes the inner values only through `MDLM_PI_COMMAND_TIMEOUT_MS` and `MDLM_PI_ASSIGNMENT_TIMEOUT_MS` in its allowlisted child environment. Ambient values cannot override the request. Both values are part of durable run identity, and resume rejects drift. A new `run` may upgrade a matching legacy identity once by binding the explicit values.

`timeoutMs` bounds each child command. It is not a wall-clock bound for the whole runner. Initial snapshot commands run before the child, and the post-run snapshot, checkpoint authentication, durable reconciliation, and finalization run afterward. External shell wrappers must not impose a 930 second deadline around a request with `timeoutMs: 900000`. Allow additional time for snapshot and finalization work, or do not use an outer wrapper. The child timeout policy is unchanged.

Each archive digest is the SHA-256 of its configured file bytes. Archive identities, installed-tree identity, lock identity, executable identities, and the MDLM Process Package identity remain separate. The installed-tree digest is independent of its absolute root and covers neighboring dependencies as well as `mdlm` and `mdlm-pi`; both configured executables and the lockfile must resolve within that tree. Configured paths and resolved real paths are recorded where applicable. The runner compares the Process Package identity across status, Assignment state, and packet data. It does not claim that a tarball digest equals the Process Package digest unless the operator supplies evidence for that relationship.

## Commands

```bash
npm test
npm run check
```

For issue #212, `operator-inputs/issue-213-first-run.json` must select provider `openai-codex`, model `gpt-5.6-sol`, and thinking `high`. After an operator creates and reviews that request, the exact first real-demo command is:

```bash
cd /home/ubuntu/git/mdlm-demo-orchestrator && node ./bin/mdlm-demo-runner.mjs run --input ./operator-inputs/issue-213-first-run.json
```

That command has not been run. The reviewed runner is published at `https://github.com/taylorrowser/mdlm-demo-orchestrator`; no real-demonstration result has public acceptance status yet.

## Current limits

- The runner supports the issue #213 Phase 1 path. It is not a general workflow scheduler.
- An uncertain submit or publication requires operator evidence. Automatic recovery refuses it.
- `mdlm-pi` owns worker-session correction recovery. The inspected packaged controller reports `assignment-correction-session-lost` but exposes no correction-session resume command, so this runner currently stops without stdin replay or Assignment restart even when the durable context is authentic.
- Accepted publication paths must use a UUIDv4 execution ID and remain canonical regular files below `.lifecycle/data/.transactions/<execution-id>`. Traversal, duplicate paths, symlink components, and canonical-path changes are rejected before hashing or staging.
- Child processes receive an allowlisted environment. Git subprocesses additionally use isolated system/global configuration; ambient Git, Node, and shell-startup injection variables are removed. The policy is recorded in each snapshot.
- For the issue #212 run, the authoritative `mdlm` archive is SHA-256 `8f7eb4b7d4e04a053713c72debc2a4a71d7878a0a9ed084ade8c964e9eef6cf7`, and the separate `mdlm-pi` archive is SHA-256 `d3e99c2ebd13f1167ac2041f586b9bbe8fa738388020d9103cad10b90f17df3b`. The read-only installed tooling root currently hashes to `sha256:a16e6aeeb1ee082a500e11494d5c924f29a44f71736d4681e2895ee653f4c5f0` across 17,276 entries, with lock identity `sha256:028cb194bc2b0bfdaf8e631cd03cd3bf3aeadb64e2284eaad7e19061da90b294`. The MDLM archive was rebuilt from source commit `516f9e0ef52bb5fcc47cce56282a44075c5af4f2` and tree `623575c22b53bd6a2a21c73c4420ca5f26aaa172`. Its installed Process Package independently recomputes as `sha256:ee99e698d36e406a836a796a36fc1db2d2451072ad662c0e06805ab5c20fe5ac`. Archive, installed closure, and Process Package digests remain distinct identities and must match their configured boundaries.
