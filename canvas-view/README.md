# dsh-singularity-canvas-view

[中文](README.zh.md) | English

Purpose: Mount the Singularity map as a shell-native web client page: a `sidebar.panellist` left-rail entry plus the root-scoped `main` panel `singularity` hosting the map iframe, and own the session chat bridge. Graph management lives inside the map SPA.

Package: `@dangosys/dsh-singularity-canvas-view`

Dependencies: slots, locale, sessions (client); none on the server (empty apply)

config.yaml: none

### Tools

none

### Web APIs

none (consumes `/singularity/graph` to validate prompt submissions, and hosts the `/singularity/map/` SPA)

### Service state

none (browser-side mount only; the web client module is `src/frontend/client.js`, copied to `lib/client.js` by `scripts/build-client.mjs`)

## Design notes

- One construction: the client registers the left-rail entry (`sidebar.panellist` id `singularity`, order 30, label from the `singularity-canvas-view` locale namespace) and the matching `main` panel that renders the `/singularity/map/` iframe. The sidebar draws the row and selects the panel; canvas-view paints no overlay, pill switch, or graph list of its own.
- The client talks to the map iframe over postMessage: `singularity:open` / `singularity:prompt` into the frame, `singularity:transcript` / `singularity:prompt-result` / `singularity:session-error` back. The host adopts the `graphId` the frame reports and echoes it on every reply; malformed inbound messages are logged, never thrown out of the window listener. Transcript rows project durable session events, the session's durable `inbox` projection, and local submission echoes.
- `singularity:open` carries the node's `parentSessionId` (the map's spawn edge) for a child node. The bridge opens a Session under `subagents`' durable address contract: a client-known address wins, then the graph-edge parent resolves through `sessions.refreshProjections` to a catalog address, and otherwise the child is addressed as `{ parentSessionId, childSessionId, mode: 'unknown' }` — the binding snapshot upgrades `unknown` from the child's own identity. A root or plain Session keeps its bare id. A child whose identity is not `continuable`, or whose parent is unavailable, reports `readOnly: true` on its transcript frames and refuses `singularity:prompt` (its runtime owns the inbox).
- A prompt is refused with a named error when the graph is sealed legacy history: the submission's own read of `/singularity/graph` carries the graph's `access`, and `access.mode === 'legacy-readonly'` answers "this graph is sealed legacy history and takes no prompt" before readiness is even considered. A sealed graph has no live inbox, so the client never queues a prompt against one.
- The bridge retains an exact session reference when the frame first references a session (`sessions.retain(id, { source: 'canvasView' })`, awaiting `reference.ready`) and releases it on graph switch and panel unmount; `binding(id)` is only borrowed while that reference lives. `chatGeneration` guards async races: a stale binding — including one still awaiting its reference — is discarded when the panel unmounts or the frame switches graphs, and unmounting releases the reference and disposes the event, session, and inbox-projection subscriptions with it.
- This package is a browser client module (`dsh.client.platform = web`), not a Node service; all server routes it consumes are served by graph-web.
- Its client roster edges (`dsh.client.inject`) name only the rows this bundle needs: `@deepseek-ai/dsh-client-ui-layout` and `@deepseek-ai/dsh-client-ui-sidebar` (the declarers of the `main` and `sidebar.panellist` slots) plus `@deepseek-ai/dsh-client-locale`; React and sessions come from the shell's module table and are not declared.
