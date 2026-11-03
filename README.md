# DSH Needs-Input and Completion Markers

Adds separate per-session unread markers: yellow for a turn ending `blocked`, `error`, or `max-tokens`; green for a turn ending `completed`. Workspace rows independently aggregate yellow and green from all member sessions. Native live approval/question/plan-review yellow indicators remain owned by DSH.

## Acknowledgement

- Opening a session stores both projection sequence watermarks in browser `localStorage` and clears its unread yellow/green markers.
- A new user message clears the host yellow `needsInput` reason. It does not erase a prior green completion; opening the chat acknowledges each color independently.
- Markers are per browser for read state. The underlying turn outcome is host-persisted.

## Upgrade durability

This is a normal DSH profile bundle (`dsh-needs-input`) with persistent source under `$DSH_HOME/plugins/dsh-needs-input`. It does not patch DSH-installed JavaScript. The package must be selected in the profile and the live client-module graph reconciled before the browser sees changes. A package install or `dsh --dump-config` alone does not prove runtime activation. Never restart dsh-web until all chats are confirmed stopped.

Test: `node $DSH_HOME/plugins/dsh-needs-input/verify.mjs`.

## Read marks are shared across devices (2026-10-28)

Owner request: "make it reliable … independent from the device that viewed chats". The read marks
(`y` = needsInputSeq seen, `g` = completedSeq seen) live in the **host**, in this plugin's settings
namespace (`acks`: one `{id, y, g, t}` row per chat), written by the browser through
`settings/update` and read through `settings/describe` — both same-origin, so an acknowledgement made
on the desktop clears the dot on the phone.

- localStorage (`dsh.needs-input.read-v1`) is only a cache/fallback for when that API is unavailable.
- A chat shown in the **main view** is acknowledged continuously (previously only a sidebar click
  counted, so chats read in the main pane came back unread after a reload).
- First visit still seeds old activity as read, so history never lights up in bulk.

## Red error dot is sticky (owner rule 2026-11-03)

A turn that ended on an **error** (`turn/end` reason `error`, e.g. a provider 429) raises a **red** dot that
opening or reading the chat does **not** clear. It goes away only when the chat is proceeded with a new
message — same model or a different one (the host projection then sets `needsInput` back to `none`).

- Host (projection `stateVersion: 2`): `error` is its own state; the version bump discards cached v1 rows
  and re-folds from the session log, so chats that already ended on an error light up without being reopened.
- `max-tokens` is NOT an error and keeps the yellow dot, which reading clears. `blocked` stays yellow.
- The browser never advances the read mark for `error` (`ackFor`, the main-view auto-ack, the list
  subscription), and first-visit seeding skips error chats, so a fresh browser cannot swallow the dot.
- **The host half activates on the next dsh process start** — the running process keeps the module it
  imported at boot.
