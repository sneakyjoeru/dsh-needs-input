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
assert.deepEqual(mod.inject, ['slots', 'sessions']);
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
const isYellow = (s, read = 0) => Boolean(s?.needsInput !== 'none' && s.needsInputSeq > read);
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
assert.equal(isYellow(needsInputProjection.apply(needsInputProjection.init({}, 0), { type: 'turn/end', seq: 9, data: { reason: { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } } } })), true);
assert.equal(isYellow(needsInputProjection.apply(needsInputProjection.init({}, 0), { type: 'turn/end', seq: 9, data: { reason: { kind: 'max-tokens' } } })), true);

// 3. Workspace aggregation: both colours independent; a yellow chat is not double-counted as green.
const states = { a: { needsInput: 'failed', needsInputSeq: 11, completedSeq: 12 }, b: { needsInput: 'none', needsInputSeq: 3, completedSeq: 12 }, c: { needsInput: 'none', needsInputSeq: 0, completedSeq: 0 } };
const count = (ids, reads = {}) => ids.reduce((acc, id) => {
  if (isYellow(states[id], reads[id + ':y'] ?? 0)) acc.yellow++;
  else if (isGreen(states[id], reads[id + ':g'] ?? 0)) acc.green++;
  return acc;
}, { yellow: 0, green: 0 });
assert.deepEqual(count(['a', 'b', 'c']), { yellow: 1, green: 1 });
assert.deepEqual(count(['a', 'b', 'c'], { 'b:g': 12 }), { yellow: 1, green: 0 }, 'opening b clears the workspace green');
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
assert.deepEqual(wc.get('allArchived'), { yellow: 0, green: 0 }, 'all chats archived -> no indicator');
assert.deepEqual(wc.get('onlyHidden'), { yellow: 0, green: 0 }, 'subagent children and non-current blank drafts never count');
assert.deepEqual(wc.get('mixed'), { yellow: 0, green: 1 }, 'the archived member is skipped, the live one still counts');
assert.deepEqual(wc.get('empty'), { yellow: 0, green: 0 }, 'empty workspace -> no indicator');
assert.deepEqual(mod.workspaceCounts(snap, {}, 'draft').get('onlyHidden'), { yellow: 1, green: 0 }, 'the CURRENT blank draft is listed, so it counts');
const unarchived = { ...snap, workspaces: { ...snap.workspaces, archivedSessionIds: [] } };
assert.deepEqual(mod.workspaceCounts(unarchived, {}, undefined).get('allArchived'), { yellow: 1, green: 1 }, 'unarchiving brings the dots back');

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
assert.deepEqual(mod.workspaceCounts(seedSnap, seeded, undefined).get('w'), { yellow: 0, green: 1 }, 'only the chat that finished while watching counts; not the whole workspace');
assert.equal(mod.seedMarks(seedSnap, seeded, NOW), null, 'already-seeded marks are never rewritten (no loop, read state preserved)');
const partial = { 'old1:y': 11, 'old1:g': 12 };
const afterPartial = mod.seedMarks(seedSnap, partial, NOW);
assert.equal(afterPartial['old1:g'], 12, 'an existing mark is left alone');
assert.equal(afterPartial['old2:y'], 11, 'a missing mark is still filled in');
assert.equal(mod.seedMarks({ sessions: { byId: {}, projectionsBySession: {} }, workspaces: { items: [] } }, {}, NOW), null, 'nothing to seed -> no write');

console.log('ALL PASS: module-loader wrapper, shell.overlay registration, projection transitions, per-colour watermarks, workspace aggregation, archived/hidden chats excluded, first-visit seeding');
