# MDLM AgentSession

`AgentSession` starts one persistent Codex or Pi session, sends later stakeholder
answers to that same session, and reports the last transport receipt. The agent
drives the public MDLM CLI and decides how to handle each result.

```js
import { AgentSession } from 'mdlm-demo-orchestrator';

const agent = new AgentSession();
const session = await agent.start(repository, goal, release, {
  kind: 'pi',
  model: 'openrouter/z-ai/glm-5.3-flash',
  thinking: 'low',
});

const orientation = agent.observe(session);
await agent.send(session, 'Stakeholder answer: use UTF-8 bytes. Continue.');
```

The public instance methods are exactly `start`, `attach`, `send`, and
`observe`.

The start prompt tells the agent to run `mdlm next` after each unit of work, to
complete ordinary Assignments, and to ask for stakeholder input only at an
Attention Required boundary or an exact blocker. The session module does not
parse MDLM results, construct authority, prepare responses, submit, settle, or
own lifecycle recovery.

## Reattaching after host closure

Configure the same non-empty `descriptorKey` on the original and replacement
hosts. An observation then includes an HMAC-authenticated descriptor. Persist
that descriptor after the adapter command has closed, and keep the key separate
from it.

```js
const original = new AgentSession({ descriptorKey });
const session = await original.start(repository, goal, release, harness);
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
`{ kind: 'codex', allowEmptyDestination: true }`. Codex can then operate from a
harness workspace while the agent creates and initializes the child repository
named by the goal. Existing repository sessions remain strict.

Codex uses the `workspace-write` sandbox by default. A host that already
isolates the agent process may select another Codex-supported mode with
`sandbox`, for example `{ kind: 'codex', sandbox: 'danger-full-access' }`.
AgentSession preserves that selection when it resumes the session.

## Check

```bash
npm run check
```
