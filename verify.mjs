import assert from 'node:assert/strict';
import fs from 'node:fs';
import { needsInputProjection } from './index.mjs';

// 1. Browser half is a window.__ModuleLoader__ factory (the format the profile client-module
//    scan executes), exports {name, inject, apply}, and apply registers into shell.overlay.
const client = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8');
let loaded;
const fakeWindow = { __ModuleLoader__: { load: (reg) => { loaded = reg; } } };
new Function('window', client)(fakeWindow);
assert.equal(loaded?.id, 'dsh-needs-input');
const fakeReact = { useRef: () => ({ current: null }), useEffect: () => {}, createElement: () => null };
const mod = loaded.factory((name) => { assert.equal(name, 'react'); return fakeReact; });
assert.equal(mod.name, 'dsh-needs-input');
assert.deepEqual(mod.inject.slice(0, 2), ['slots', 'sessions']);
const registrations = [];
mod.apply({
  get: () => undefined,
  effect: () => () => {},
  slots: { inject: (seat, make) => { registrations.push({ seat, made: make() }); }, register: (opts, component) => ({ opts, component }) },
});
assert.equal(registrations.length, 1);
assert.equal(registrations[0].seat, 'shell.overlay', 'additive list seat, never the single sidebar.workspaces seat');
assert.equal(registrations[0].made.opts.name, 'shell.overlay');
assert.equal(typeof registrations[0].made.component, 'function');

// 2. Host projection: yellow on blocked/error/max-tokens, green on completed, independent sequences.
const isYellow = (s, read = 0) => Boolean(s?.needsInput !== 'none' && s?.needsInput !== 'error' && s.needsInputSeq > read);
const isGreen = (s, read = 0) => Boolean(s?.completedSeq > 0 && s.completedSeq > read);
let state = needsInputProjection.init({}, 0);
assert.deepEqual(state, { needsInput: 'none', needsInputSeq: 0, completedSeq: 0 });
state = needsInputProjection.apply(state, { type: 'turn/end', seq: 4, time: 10, data: { reason: { kind: 'blocked' } } });
assert.deepEqual(state, { needsInput: 'blocked', needsInputSeq: 4, completedSeq: 0 });
assert.equal(isYellow(state), true);
state = needsInputProjection.apply(state, { type: 'turn/end', seq: 5, time: 20, data: { reason: { kind: 'completed' } } });
assert.deepEqual(state, { needsInput: 'blocked', needsInputSeq: 4, completedSeq: 5 }, 'completion does not erase outstanding yellow');
state = needsInputProjection.apply(state, { type: 'user/message', seq: 6, time: 30, data: {} });
assert.deepEqual(state, { needsInput: 'none', needsInputSeq: 6, completedSeq: 5 }, 'reply clears yellow, keeps green');
assert.equal(isGreen(state, 4), true);
assert.equal(isGreen(state, 5), false, 'reading at/after the completion clears green');
const errState = needsInputProjection.apply(needsInputProjection.init({}, 0), { type: 'turn/end', seq: 9, data: { reason: { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } } } });
assert.equal(errState.needsInput, 'error', 'a turn that ended on an error is its own state');
assert.equal(isYellow(errState), false, 'an error is RED, not yellow');
assert.equal(mod.ackFor(errState, { y: 3, g: 1 }).y, 3, 'opening/reading an error chat does not acknowledge it');
assert.equal(needsInputProjection.apply(errState, { type: 'user/message', seq: 10, data: { source: { kind: 'user' } } }).needsInput, 'none', 'the next message in the chat clears it - same model or another one');
assert.equal(isYellow(needsInputProjection.apply(needsInputProjection.init({}, 0), { type: 'turn/end', seq: 9, data: { reason: { kind: 'max-tokens' } } })), true);

// 3. Workspace aggregation: both colours independent; a yellow chat is not double-counted as green.
const states = { a: { needsInput: 'failed', needsInputSeq: 11, completedSeq: 12 }, b: { needsInput: 'none', needsInputSeq: 3, completedSeq: 12 }, c: { needsInput: 'none', needsInputSeq: 0, completedSeq: 0 } };
const count = (ids, reads = {}) => ids.reduce((acc, id) => {
  if (isYellow(states[id], reads[id + ':y'] ?? 0)) acc.yellow++;
  else if (isGreen(states[id], reads[id + ':g'] ?? 0)) acc.green++;
  return acc;
}, { red: 0, yellow: 0, green: 0 });
assert.deepEqual(count(['a', 'b', 'c']), { red: 0, yellow: 1, green: 1 });
assert.deepEqual(count(['a', 'b', 'c'], { 'b:g': 12 }), { red: 0, yellow: 1, green: 0 }, 'opening b clears the workspace green');
// 4. The SHIPPED workspaceCounts: a workspace whose chats are all archived (or are subagent
//    children / stale blank drafts) has nothing to open, so it must show no dot (owner 2026-10-27).
const proj = (st) => ({ values: { needsInput: st } });
const snap = {
  sessions: {
    byId: { a: { id: 'a' }, b: { id: 'b' }, sub: { id: 'sub', origin: 'subagent' }, draft: { id: 'draft', blank: true }, live: { id: 'live' } },
    projectionsBySession: { a: proj(states.a), b: proj(states.b), sub: proj(states.a), draft: proj(states.a), live: proj(states.b) },
  },
  workspaces: {
    archivedSessionIds: ['a', 'b'],
    items: [
      { workspaceId: 'allArchived', sessionIds: ['a', 'b'] },
      { workspaceId: 'onlyHidden', sessionIds: ['sub', 'draft'] },
      { workspaceId: 'mixed', sessionIds: ['a', 'live'] },
      { workspaceId: 'empty', sessionIds: [] },
    ],
  },
  status: new Map(),
};
const wc = mod.workspaceCounts(snap, {}, undefined);
assert.deepEqual(wc.get('allArchived'), { red: 0, yellow: 0, green: 0 }, 'all chats archived -> no indicator');
assert.deepEqual(wc.get('onlyHidden'), { red: 0, yellow: 0, green: 0 }, 'subagent children and non-current blank drafts never count');
assert.deepEqual(wc.get('mixed'), { red: 0, yellow: 0, green: 1 }, 'the archived member is skipped, the live one still counts');
assert.deepEqual(wc.get('empty'), { red: 0, yellow: 0, green: 0 }, 'empty workspace -> no indicator');
assert.deepEqual(mod.workspaceCounts(snap, {}, 'draft').get('onlyHidden'), { red: 0, yellow: 1, green: 0 }, 'the CURRENT blank draft is listed, so it counts');
const unarchived = { ...snap, workspaces: { ...snap.workspaces, archivedSessionIds: [] } };
assert.deepEqual(mod.workspaceCounts(unarchived, {}, undefined).get('allArchived'), { red: 0, yellow: 1, green: 1 }, 'unarchiving brings the dots back');

// 5. Fresh browser / cleared storage must NOT light up every finished chat (owner report 2026-10-27:
//    "occasionally marks all chats in workspace as unread"). Marks seed only for old activity; a chat
//    that finishes while the page is open still shows.
const NOW = 1_000_000;
const row = (id, updatedAt, st) => ({ id, updatedAt });
const seedSnap = {
  sessions: {
    byId: { old1: row('old1', NOW - 86_400_000), old2: row('old2', NOW - 3_600_000), fresh: row('fresh', NOW + 500) },
    projectionsBySession: {
      old1: proj(states.b),   // finished long ago
      old2: proj(states.a),   // blocked long ago
      fresh: proj(states.b),  // finished while this page was open
    },
  },
  workspaces: { archivedSessionIds: [], items: [{ workspaceId: 'w', sessionIds: ['old1', 'old2', 'fresh'] }] },
  status: new Map(),
};
const seeded = mod.seedMarks(seedSnap, {}, NOW);
assert.ok(seeded, 'first paint seeds');
assert.equal(seeded['old1:g'], 12, 'old completion recorded as already read');
assert.equal(seeded['old2:y'], 11, 'old block recorded as already read');
assert.equal(seeded['fresh:y'], undefined, 'activity newer than the page load stays unseeded');
assert.equal(seeded['fresh:g'], undefined);
assert.deepEqual(mod.workspaceCounts(seedSnap, seeded, undefined).get('w'), { red: 0, yellow: 0, green: 1 }, 'only the chat that finished while watching counts; not the whole workspace');
assert.equal(mod.seedMarks(seedSnap, seeded, NOW), null, 'already-seeded marks are never rewritten (no loop, read state preserved)');
const partial = { 'old1:y': 11, 'old1:g': 12 };
const afterPartial = mod.seedMarks(seedSnap, partial, NOW);
assert.equal(afterPartial['old1:g'], 12, 'an existing mark is left alone');
assert.equal(afterPartial['old2:y'], 11, 'a missing mark is still filled in');
assert.equal(mod.seedMarks({ sessions: { byId: {}, projectionsBySession: {} }, workspaces: { items: [] } }, {}, NOW), null, 'nothing to seed -> no write');

// 6. Host-side marks (owner request 2026-10-28: independent from the device that viewed the chats).
//    The read state lives in the plugin's settings namespace, so a desktop acknowledgement clears the
//    phone's dot; local storage only caches/falls back.
assert.deepEqual(mod.combineMarks({ 'a:y': 5 }, { a: { y: 9, g: 3 } }), { 'a:y': 9, 'a:g': 3 }, 'host mark wins when higher');
assert.deepEqual(mod.combineMarks({ 'a:y': 12 }, { a: { y: 9 } }), { 'a:y': 12 }, 'local mark kept when higher (just clicked, not yet flushed)');
assert.deepEqual(mod.combineMarks({}, {}), {}, 'no marks, no dots');
assert.deepEqual(mod.combineMarks({ 'x:g': 4 }, { x: { y: 0, g: 0 } }), { 'x:g': 4 }, 'zero host marks never clear a local one');
const acked = mod.ackFor({ needsInputSeq: 7, completedSeq: 11 }, { y: 3, g: 2 });
assert.equal(acked.y, 7); assert.equal(acked.g, 11); assert.ok(acked.t > 0);
assert.deepEqual(mod.combineAckObjects({ a: { y: 1, g: 1, t: 10 } }, { a: { y: 5, g: 0, t: 4 }, b: { y: 2, g: 0, t: 2 } }),
  { a: { y: 5, g: 1, t: 10 }, b: { y: 2, g: 0, t: 2 } }, 'two devices merge per chat, newest per colour');
const nsList = { namespaces: [
  { ns: 'llm-pi-ai', value: { providers: {} }, revision: 3 },
  { ns: 'needs-input-client', value: { acks: [{ id: 's1', y: 4, g: 9, t: 1 }] }, revision: 7 },
] };
const picked = mod.pickNamespace(nsList.namespaces);
assert.equal(picked.ns, 'needs-input-client');
assert.equal(picked.revision, 7);
assert.equal(mod.pickNamespace([{ ns: 'other', value: { acks: [] } }]).ns, 'other', 'fallback: the only namespace carrying acks');
assert.deepEqual(mod.rowsToMap([{ id: 'a', y: 2, g: 5, t: 1 }, { id: 'a', y: 7, g: 0, t: 3 }, { id: 'b' }]),
  { a: { y: 7, g: 5, t: 3 }, b: { y: 0, g: 0, t: 0 } }, 'host rows fold to a map, highest per colour');
assert.deepEqual(mod.mapToRows({ a: { y: 7, g: 5, t: 3 } }, [{ id: 'b', y: 1, g: 1, t: 1 }]),
  [{ id: 'a', y: 7, g: 5, t: 3 }, { id: 'b', y: 1, g: 1, t: 1 }], 'writing keeps rows this device did not touch');
assert.equal(mod.pickNamespace([]), null, 'no namespace yet -> local only');

console.log('ALL PASS: wrapper, registration, projection, watermarks, workspace aggregation, hidden chats, first-visit seeding, host-side shared marks');

// 9. Scheduled tasks (2026-11-02): a chat with an ACTIVE task gets no yellow/green; inactive tasks do not hide it.
{
  const ids = mod.activeScheduleSessions([
    { sessionId: 'cron', status: 'active' }, { sessionId: 'done', status: 'inactive' }, null, { status: 'active' },
  ]);
  assert.deepEqual([...ids], ['cron'], 'only active tasks with a session id count');
  const snap = {
    sessions: { byId: { cron: {}, done: {} }, projectionsBySession: {
      cron: { values: { needsInput: { needsInput: 'failed', needsInputSeq: 9, completedSeq: 8 } } },
      done: { values: { needsInput: { needsInput: 'none', needsInputSeq: 1, completedSeq: 5 } } },
    } },
    workspaces: { items: [{ workspaceId: 'w', sessionIds: ['cron', 'done'] }], archivedSessionIds: [] },
    status: new Map([['cron', { completionUnread: true }]]),
  };
  assert.deepEqual(mod.workspaceCounts(snap, {}, undefined, ids).get('w'), { red: 0, yellow: 0, green: 1 }, 'scheduled chat (even with native completionUnread) is not counted; the finished one is');
  assert.deepEqual(mod.workspaceCounts(snap, {}, undefined, new Set()).get('w'), { red: 0, yellow: 1, green: 1 }, 'once the task ends the chat counts again');
}
console.log('schedule suppression: ok');

// 10. A RUNNING chat never counts toward its workspace (its row shows the native running dot only).
{
  const snap = {
    sessions: { byId: { live: {} }, projectionsBySession: { live: { values: { needsInput: { needsInput: 'none', needsInputSeq: 693, completedSeq: 688 } } } } },
    workspaces: { items: [{ workspaceId: 'w', sessionIds: ['live'] }], archivedSessionIds: [] },
    status: new Map([['live', { running: true }]]),
  };
  assert.deepEqual(mod.workspaceCounts(snap, { 'live:g': 578 }, undefined).get('w'), { red: 0, yellow: 0, green: 0 }, 'running chat is not "finished unread"');
  snap.status = new Map([['live', { running: false }]]);
  assert.deepEqual(mod.workspaceCounts(snap, { 'live:g': 578 }, undefined).get('w'), { red: 0, yellow: 0, green: 1 }, 'once it stops (not open), it counts');
}
console.log('running chats excluded: ok');

// 11. RED error dot (owner rule 2026-11-03): counted even when fully read, cleared only by continuing
//     the chat, and never swallowed by the first-visit seeding.
{
  const mk = (st) => ({ sessions: { byId: { e: {}, ok: {} }, projectionsBySession: {
    e: { values: { needsInput: st } },
    ok: { values: { needsInput: { needsInput: 'none', needsInputSeq: 1, completedSeq: 2 } } } } },
    workspaces: { items: [{ workspaceId: 'w', sessionIds: ['e', 'ok'] }], archivedSessionIds: [] }, status: new Map() });
  const err = { needsInput: 'error', needsInputSeq: 9, completedSeq: 0 };
  assert.deepEqual(mod.workspaceCounts(mk(err), { 'e:y': 9, 'e:g': 9 }, undefined).get('w'), { red: 1, yellow: 0, green: 1 }, 'a fully-read error chat still counts red');
  assert.deepEqual(mod.workspaceCounts(mk({ needsInput: 'blocked', needsInputSeq: 9, completedSeq: 0 }), { 'e:y': 9 }, undefined).get('w'), { red: 0, yellow: 0, green: 1 }, 'blocked is yellow and reading clears it, as before');
  const snap = { sessions: { byId: { e: { updatedAt: 1 } }, projectionsBySession: { e: { values: { needsInput: err } } } }, workspaces: { items: [{ workspaceId: 'w', sessionIds: ['e'] }] } };
  assert.equal(mod.seedMarks(snap, {}, 1000), null, 'first-visit seeding must not mark an error chat read');
  console.log('red error dot: ok');
}
