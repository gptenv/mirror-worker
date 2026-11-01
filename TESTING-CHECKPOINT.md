# Test this checkpoint

Use the exact commit recorded in draft PR #1. The verification worktree is separate from existing user checkouts.

## Fast local Worker check

With Node 24 and dependencies installed, run:

```sh
npm run test:worker
```

This runs the real local workerd bundle with synthetic services and disposable Durable Object storage. It needs no ChatGPT credentials or deployment. It checks owner rejection, restart persistence, JSON/SSE transcripts, migration rollback/retry, newer-schema refusal, and disconnect cleanup through the next ten-second heartbeat.

## Interactive UI

```sh
npm run dev
```

Open `http://127.0.0.1:5173/mirror/playground`. This documented development command starts the local Node server on port 8787 and the web UI on port 5173; it is distinct from the workerd acceptance harness above. Real chat and authenticated downloads require your own ChatGPT credentials. This handoff does not start real upstream traffic or deploy a Worker.

Check these existing flows:

1. Connect, send a short prompt, and continue the same conversation.
2. Stop a streaming reply, then retry; confirm the conversation remains usable.
3. Change the provider origin and confirm credentials remain scoped to the selected origin.
4. Try the authenticated Markdown, text, JSON, and HTML downloads.

For a broader synthetic check, run `npm run coverage` and `npm run test:e2e`. Coverage retains the 100% per-file thresholds. Worker recovery limits and diagnostics are documented in `WORKER-RECOVERY.md`.
