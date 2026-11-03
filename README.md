# dsh-needs-input

Unread markers for the DeepSeek Harness web sidebar. A chat that wants your attention gets a coloured dot in
the sidebar, and the workspace it belongs to gets an aggregated dot, without the chat having to be opened.

Three independent colours, because three different things can happen to a chat:

| Dot | Colour | Means | Cleared by |
|---|---|---|---|
| red | error | the last turn ended with an error (provider failure, rate limit, engine crash, …) | sending a new message to that chat — any model |
| yellow | attention | the last turn ended `blocked`, or it stopped on the output-token limit (`max-tokens`) | opening the chat |
| green | finished | the last turn completed | opening the chat |

Red is deliberately not clearable by reading: an error is not resolved by looking at it. It goes away when the
chat is continued, which resets the chat's state on the host.

## How read state works

- A chat that is open in the main view is acknowledged continuously; clicking a sidebar row acknowledges it too.
- Two read stores are merged per chat and per colour, highest sequence winning: `localStorage` in each browser,
  and an `acks` list in the host settings namespace so a chat read on one device is read on the others.
- First visit seeds activity older than the page load as read, so a fresh browser does not light up the whole
  history. Error chats are exempt — their dot survives a first visit.
- A chat with an error has no read watermark at all: the browser never advances its acknowledgement, so only a
  new message in that chat (same model or another) can clear the red dot.

## Chats that are skipped

- archived chats — nothing to open from that workspace
- subagent children
- blank draft sessions other than the one currently open
- chats with an **active scheduled task** — the shipped schedule plugin's clock mark shows instead, and the
  redo dots return once the task is no longer active
- **running** chats — a chat in the middle of a turn is not finished, so it lights nothing in its workspace

## Rendering

- Session dots are appended to the leading cell of the sidebar row; workspace dots are inserted just before the
  workspace title, one per colour, with the chat count in the tooltip.
- DSH's own row indicators (pending interaction, running, completion reminder) keep priority: the plugin draws
  its dot only when the native indicator is idle.
- For a chat with an active scheduled task, DSH's in-page "completed" reminder is cleared so the clock stays
  visible. This touches the `uiSession` service defensively — if a future DSH changes it, the row falls back to
  the normal completion reminder instead of breaking.

## Install (web profile)

1. Add the package to the profile: `pnpm add file:<path>/dsh-needs-input-1.0.0.tgz`.
2. List `dsh-needs-input` in the profile's `dsh.profile.bundles` and add its row to the profile patch:
   `- id: needs-input-client` / `name: dsh-needs-input`.
3. Pick up browser changes by reloading the page; the host projection is imported once per process start, so a
   host-side change needs a DSH restart (never while chats are running).

## Host half and browser half

- **Host** (`index.mjs`): registers the `needsInput` session projection — states `none`, `blocked`,
  `max-tokens`, `error`, plus the legacy `failed` — and exposes the settings namespace that carries the shared
  read marks. It patches no DSH-installed JavaScript.
- **Browser** (`client.js`): paints the dots into the `shell.overlay` seat and calls only the settings and
  schedule-catalog APIs.

Services used — browser: `slots`, `sessions`, `remote`, `remote.settings`, `remote.schedule`, `uiSession`;
host: `sessionProjections`, `settings`.

## Behaviour notes

- The projection is at `stateVersion: 2`. The version bump makes the host discard cached rows from the previous
  version and re-fold from the session log, so chats that already ended on an error gain their dot without being
  reopened.
- A legacy `failed` row (written by a host that predates the separate error state) is treated as red as well, so
  the error dot works against either host version.
- Read marks are scoped to one DSH home: the `acks` list is stored in the profile patch, so switching profiles
  starts with a clean slate.

## Tests

```
node verify.mjs                 # pure units: projection, marks, aggregation — no DSH needed
node plugin-smoke.mjs $DSH_HOME # import + required-service check against an installed harness
```
