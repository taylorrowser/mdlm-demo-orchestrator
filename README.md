# MDLM demo runner

The runner transports one MDLM operator transaction. It calls `mdlm next
--json` once, passes the included Assignment packet to one operator process,
then sends that process's response to `mdlm scenario submit --json`.

The runner understands the six `mdlm-next@2` outcomes and the three
`mdlm-submission-outcome@1` results. It does not inspect status, select work,
prepare Assignments, interpret Process Package routes, infer authority, or
assemble proposal fields.

## Run request

`mdlm-demo-runner run` reads one JSON value from standard input or from
`--input FILE`:

```json
{
  "contract": "mdlm-demo-run-request@2",
  "repository": "/absolute/lifecycle-repository",
  "stateDirectory": "/absolute/runner-state",
  "timeoutMs": 900000,
  "commands": {
    "mdlm": {
      "path": "/absolute/mdlm",
      "digest": "sha256:..."
    },
    "operator": {
      "path": "/absolute/operator",
      "digest": "sha256:...",
      "args": []
    }
  }
}
```

Both commands are authenticated before use. The operator receives the exact
`mdlm-assignment-packet@3` JSON on standard input and must return one
`mdlm-assignment-response@2` JSON value on standard output.

The runner records immutable packet and response bytes. It writes and syncs a
transaction journal before submission starts. If submission closure is
uncertain, a later invocation inspects the recorded execution or Assignment
identity. It never submits the response again. A retained repository lock is
not reclaimed merely because its process is absent.

`reviewer-lease` remains available for response-only delegated reviewers. It
does not grant lifecycle authority or write the lifecycle repository.

## Artifact checks

Build the npm artifact from a clean tree:

```bash
npm run manifest
npm run check
npm pack --json --pack-destination /absolute/artifact-directory
```

The launcher authenticates the distribution manifest and every packaged module
before loading the runner. Release and install records remain the external
authority for the tarball and installed executable identities.
