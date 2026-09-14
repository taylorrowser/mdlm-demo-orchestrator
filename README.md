# MDLM AgentSession

`AgentSession` starts one persistent Codex or Pi session, sends later stakeholder
answers to that same session, and reports the last transport receipt. The agent
drives the public MDLM CLI and decides how to handle each result.

```js
import { AgentSession } from 'mdlm-demo-orchestrator';

const agent = new AgentSession();
const session = await agent.start(repository, release, {
  kind: 'pi',
  model: 'openrouter/z-ai/glm-5.3-flash',
  thinking: 'low',
});

const orientation = agent.observe(session);
await agent.send(session, 'Stakeholder answer: use UTF-8 bytes. Continue.');
```

The public instance methods are exactly `start`, `attach`, `send`, and
`observe`.

AgentSession generates the launch Goal from the repository, release, public CLI
loop, and stop contract. Product intent enters through a later manager message
bound to the exact action and context. The agent discovers work with
`mdlm expectations --json`, chooses an eligible item, and retrieves its
package-owned guidance with `mdlm expectations show <action> [<exact-subject>]
--json`. It publishes proposals and runs verification through direct operations.
If a result is uncertain, it queries settlement before retrying and continues
from accepted results without repeating completed work.

Independent review still requires an independent verdict. Stakeholder decisions
must come from a manager message identifying the exact protected action and
context. The agent stops at a typed completion boundary or reports an exact
blocker when no eligible work can proceed. Optional work does not hold up
completion. Resumed sends repeat these same instructions. Local corrections
remain part of the active turn; progress belongs in commentary.

The fake-adapter regression checks instruction delivery, not model obedience.
Fresh operation must confirm the agent uses direct operations through the next
lifecycle boundary. The session module does not parse MDLM results, rank work,
construct authority, prepare proposals, submit, settle, or own lifecycle recovery.

## Durable controller

Long-lived hosts can expose a Unix socket with the packaged controller helper:

```js
import { listenAgentSessionController } from 'mdlm-demo-orchestrator/controller';

await listenAgentSessionController({
  socketPath,
  currentState,
  beginSend,
  recordClientDisconnect,
  recordPreSendFailure,
});
```

`beginSend` must synchronously write the controller-owned numbered request and
in-flight records, mark the host busy, and start `AgentSession.send`. If that
pre-send work throws, the helper returns `pre-send-rejected`, calls
`recordPreSendFailure`, and keeps the controller alive for status inspection.
The manager must keep prepared messages and authority records outside the
controller's request, in-flight, and receipt paths.

## Reattaching after host closure

Configure the same non-empty `descriptorKey` on the original and replacement
hosts. An observation then includes an HMAC-authenticated descriptor. Persist
that descriptor after the adapter command has closed, and keep the key separate
from it.

```js
const original = new AgentSession({ descriptorKey });
const session = await original.start(repository, release, harness);
await writeDescriptor(original.observe(session).descriptor);

const replacement = new AgentSession({ descriptorKey });
const sameSession = replacement.attach(await readDescriptor());
await replacement.send(sameSession, stakeholderAnswer);
```

`attach` does not call an adapter or consume a turn. It rejects an invalid HMAC,
an identity or harness mismatch, a changed working directory, an inconsistent
receipt, and any command closure state other than `closed`. `observe` returns
the preserved receipt and turn count immediately after attachment.

## Harnesses

Codex defaults to `gpt-5.6-terra` with medium effort. Pi defaults to
`openrouter/z-ai/glm-5.3-flash` with low thinking.

For a deliberately empty Codex destination, set
`{ kind: 'codex', allowEmptyDestination: true }`. Create that exact empty
directory and pass it as `repository`; the agent runs `mdlm init .` there before
any Git command. Do not pass a parent workspace or ask the agent to infer or
create a child repository. Existing repository sessions remain strict.

Codex uses the `workspace-write` sandbox by default. A host that already
isolates the agent process may select another Codex-supported mode with
`sandbox`, for example `{ kind: 'codex', sandbox: 'danger-full-access' }`.
AgentSession preserves that selection when it resumes the session.

For a service or another restricted environment, bind the authenticated harness
executable explicitly:

```js
{ kind: 'codex', executable: '/absolute/path/to/codex' }
```

`start` checks the file before it invokes the adapter. Without `executable`, it
resolves the existing `codex` or `pi` command through the current `PATH`, then
uses and records that exact path for the session.

## Check

```bash
npm run check
```
