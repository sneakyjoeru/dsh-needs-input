# DSH Needs-Input and Completion Markers

Adds separate per-session unread markers: yellow for a turn ending `blocked`, `error`, or `max-tokens`; green for a turn ending `completed`. Workspace rows independently aggregate yellow and green from all member sessions. Native live approval/question/plan-review yellow indicators remain owned by DSH.

## Acknowledgement

- Opening a session stores both projection sequence watermarks in browser `localStorage` and clears its unread yellow/green markers.
- A new user message clears the host yellow `needsInput` reason. It does not erase a prior green completion; opening the chat acknowledges each color independently.
- Markers are per browser for read state. The underlying turn outcome is host-persisted.

## Upgrade durability

This is a normal DSH profile bundle (`dsh-needs-input`) with persistent source under `$DSH_HOME/plugins/dsh-needs-input`. It does not patch DSH-installed JavaScript. The package must be selected in the profile and the live client-module graph reconciled before the browser sees changes. A package install or `dsh --dump-config` alone does not prove runtime activation. Never restart dsh-web until all chats are confirmed stopped.

Test: `node $DSH_HOME/plugins/dsh-needs-input/verify.mjs`.
