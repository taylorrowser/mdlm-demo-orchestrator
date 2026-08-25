# Throwaway operator conversation prototype

Question: What should MDLM look like when an attended answer becomes an exact durable decision and autonomous work continues without a stream of UI noise?

Three structurally different variants live at one throwaway route and switch with `?variant=A|B|C`, the floating arrows, or the keyboard arrow keys.

```bash
npm run prototype
```

Open `http://127.0.0.1:4173/prototype/operator-conversation?variant=A`.

All issue #212 calculator content is static. Confirming a decision changes browser memory only. This route performs no repository mutation, MDLM command, or model call.
