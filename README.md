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

The public instance methods are exactly `start`, `send`, and `observe`.

The start prompt tells the agent to run `mdlm next` after each unit of work, to
complete ordinary Assignments, and to ask for stakeholder input only at an
Attention Required boundary or an exact blocker. The session module does not
parse MDLM results, construct authority, prepare responses, submit, settle, or
own lifecycle recovery.

## Harnesses

Codex defaults to `gpt-5.6-terra` with medium effort. Pi defaults to
`openrouter/z-ai/glm-5.3-flash` with low thinking.

For a deliberately empty Codex destination, set
`{ kind: 'codex', allowEmptyDestination: true }`. Codex can then operate from a
harness workspace while the agent creates and initializes the child repository
named by the goal. Existing repository sessions remain strict.

## Check

```bash
npm run check
```
