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

Tests use the three approved public seams.

1. The JSON CLI is the operator boundary. `snapshot`, `classify`, `run`, and `resume` do not require imports from MDLM.
2. `src/adapter.mjs` consumes exact `mdlm-assignment-packet@2` bytes. It returns exact `mdlm-assignment-response@1` bytes or `mdlm-demo-reserved-stop@1` before submission.
3. Process tests run fake `mdlm` and `mdlm-pi` executables in scratch Git repositories. They check raw process evidence, transaction counts, and Git commit counts.

`bin/mdlm-demo-mdlm-shim.mjs` inspects only successful `scenario prepare` JSON. It intercepts these exact Scenario references before a worker starts:

- `realize-verification-environment@1`
- `register-pilot-target@1`
- `execute-verification-run@1`

The shim also stops before the next Assignment. It does not inspect worker text, terminal output, or transcript phrases.

## Recovery rules

Every `run` and `resume` starts with a create-once snapshot, then reconciles `doctor`, `status`, the active Assignment, the transaction journal, Git, tools, package bytes, and configured source identities. A one-writer directory lock covers this work.

| Observed state | Result |
| --- | --- |
| Attended answer, active Assignment, matching fingerprints | Continue the same Assignment with a catalog decision |
| Attended Review correction, active Assignment, matching fingerprints | Continue the same Assignment |
| Lost correction worker session with durable response and diagnostics digests | Continue the same Assignment; never resubmit the old bytes |
| Clean command interruption before submission starts | Continue the same Assignment |
| External adapter stop before submission | Re-run the adapter against the same packet bytes |
| Captured response, submission not started | Submit the captured exact bytes |
| Accepted execution with journaled output paths and Git blob identities | Finish or recognize the one exact publication commit |
| Completed transaction journal | Return `already-completed`; do not submit or commit again |
| Malformed, exhausted, stale, or abandoned Assignment | Stop as nonrecoverable |
| Repository, package, artifact, or source drift | Stop as nonrecoverable |
| Invalid provenance or failed integrity check | Stop as nonrecoverable |
| Submission started without accepted execution evidence | Stop as an uncertain transaction; never retry automatically |
| Accepted execution with missing, mismatched, or ambiguous Git publication evidence | Stop as uncertain publication; never retry automatically |
| Explicit terminal, invalid, dead-end, boundary, abandoned, or complete outcome | Stop as nonrecoverable |

A failed command is not enough to make a retry safe. The journal must still say that submission never started. Once the journal reaches `submitting`, only exact accepted-execution evidence can settle the transaction.

## Evidence

`snapshot` creates the requested directory with exclusive creation. A second call cannot replace it. The directory contains:

- raw stdout and stderr bytes for `git rev-parse`, `git status`, `mdlm doctor`, `mdlm status`, and `mdlm assignment show`
- argv, working directory, deadline, timestamps, exit status, signal, and SHA-256 for each command
- Git HEAD, tree, and porcelain status
- Assignment identity and state
- the transaction journal bytes and digest, when present
- source, qualification harness, package artifact, `mdlm`, and `mdlm-pi` identities
- `manifest.json` with byte lengths and SHA-256 values

The runner removes write permission from completed snapshot files and directories. Process commands after the snapshot go into create-once files under `stateDirectory/command-evidence`. The transaction journal remains mutable through atomic replacement. Each later snapshot captures its then-current bytes.

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
      "commit": "SOURCE_COMMIT"
    },
    "package": {
      "artifact": "/absolute/path/to/package.tgz",
      "digest": "sha256:ARTIFACT_SHA256"
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
      "commit": "79c87627aaf48ca3261a3476aa82c52524f3c938"
    }
  }
}
```

The artifact digest is the SHA-256 of the configured file bytes. The MDLM Process Package digest is a separate lifecycle identity. The runner compares that identity across status, Assignment state, and packet data. It does not claim that a tarball digest equals the Process Package digest unless the operator supplies evidence for that relationship.

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
- `mdlm-pi` owns worker-session correction recovery. If its durable correction context is missing, the runner stops without restarting the Assignment.
- For the issue #212 run, the authoritative `mdlm` archive is SHA-256 `8f7eb4b7d4e04a053713c72debc2a4a71d7878a0a9ed084ade8c964e9eef6cf7`, rebuilt from source commit `516f9e0ef52bb5fcc47cce56282a44075c5af4f2` and tree `623575c22b53bd6a2a21c73c4420ca5f26aaa172`. Its installed Process Package independently recomputes as `sha256:ee99e698d36e406a836a796a36fc1db2d2451072ad662c0e06805ab5c20fe5ac`. The archive digest and Process Package digest remain distinct identities and both must match their configured boundaries.
