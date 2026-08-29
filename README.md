# MDLM demo runner

## New direct-agent demos

New demos should use `AgentSession` from `src/agent-session.mjs`. It starts one
persistent Codex or Pi session, sends later stakeholder answers to that same
session, and reports the last transport receipt:

```js
import { AgentSession } from './src/agent-session.mjs';

const agent = new AgentSession();
const session = await agent.start(repository, goal, release, {
  kind: 'pi',
  model: 'openrouter/z-ai/glm-5.3-flash',
  thinking: 'low',
});
const orientation = agent.observe(session);
await agent.send(session, 'Stakeholder answer: use UTF-8 bytes. Continue.');
```

The agent drives the public MDLM CLI. It initializes and starts the process when
needed, runs `mdlm next` after each unit of work, decides how to proceed, and
reports exact stakeholder questions when its authority runs out. `AgentSession`
does not interpret MDLM results or own lifecycle state.

The transaction runner below remains for canary086 and prior runner-based
lanes. Do not choose it for a new direct-agent demo.

The runner transports one MDLM operator transaction. It calls `mdlm next
--json` once, passes the included Assignment packet to one operator process,
then sends that process's response to `mdlm scenario submit --json`. For an
attended Assignment with an exact authority supply, the submit call includes
that authority.

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
  "authoritySupply": {
    "assignment": "exact-attended-assignment-id",
    "authority": "stakeholder"
  },
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

`authoritySupply` is optional and may be used only for an `attention-required`
outcome. Its Assignment and authority must exactly match that outcome. The
runner returns the exact `attention-required` result without invoking the
operator when the supply is absent. Invoke it again with the matching supply to
continue that Assignment. A mismatched supply is rejected before the operator
runs. The runner never derives authority from the operator response. For the
one matching submission it adds `--authority <authority>`. Ordinary
Assignments never receive an authority flag.

Both commands are authenticated before use. The operator receives the exact
`mdlm-assignment-packet@3` JSON on standard input and must return one
`mdlm-assignment-response@2` JSON value on standard output.

The runner records immutable packet and response bytes. It writes and syncs a
transaction journal before submission starts. If submission closure is
uncertain, a later invocation inspects the recorded execution or Assignment
identity. It never submits the response again. A retained repository lock is
not reclaimed merely because its process is absent.

Before parsing each `mdlm next` result, the runner durably records the child
command facts and exact stdout and stderr bytes under `next-commands/` in the
transaction state directory. A malformed or empty result may follow a
side-effecting Assignment claim. Stop and replace that lane; never retry the
consumed `next` boundary.

An invocation recovering an attended transaction must carry the same exact
`authoritySupply` so the runner can authenticate the journal. Recovery uses it
only as identity evidence and never submits it again.

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
