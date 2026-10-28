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
