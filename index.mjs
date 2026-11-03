import { z } from 'zod';
// The profile's own schemastery (3.18.2, resolved from profiles/web/node_modules) has no `.volatile()`,
// and dsh-settings exposes a namespace ONLY for volatile fields (`volatileForm(schema)` in describe()).
// Use the harness copy (3.18.5), which is also what every shipped settings-exposed plugin uses.
import Schema from '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs';

export const NEEDS_INPUT_KEY = 'needsInput';
const schema = z.object({
  needsInput: z.enum(['none', 'blocked', 'failed', 'error']),
  needsInputSeq: z.number().int().nonnegative(),
  completedSeq: z.number().int().nonnegative(),
}).strict();
export const needsInputProjection = {
  key: NEEDS_INPUT_KEY,
  // 2 since 2026-11-03: 'error' is its own sticky state (red dot, cleared only by the next message in
  // that chat). The bump also makes the host discard cached v1 rows and re-fold from the log, so chats
  // that already ended on an error show the red dot without being reopened.
  stateVersion: 2,
  stateSchema: schema,
  init: () => ({ needsInput: 'none', needsInputSeq: 0, completedSeq: 0 }),
  apply(state, event) {
    if (event.type === 'user/message') return { ...state, needsInput: 'none', needsInputSeq: event.seq };
    if (event.type !== 'turn/end') return state;
    const kind = event.data?.reason?.kind;
    if (kind === 'blocked') return { ...state, needsInput: 'blocked', needsInputSeq: event.seq };
    // Owner rule 2026-11-03: a turn that ended on an error keeps the RED dot until the chat is
    // proceeded (a new message, same model or another one). Opening/reading it must not clear it.
    if (kind === 'error') return { ...state, needsInput: 'error', needsInputSeq: event.seq };
    // max-tokens is not an error: it keeps the yellow "needs you" dot, which reading clears.
    if (kind === 'max-tokens') return { ...state, needsInput: 'failed', needsInputSeq: event.seq };
    if (kind === 'completed') return { ...state, completedSeq: event.seq };
    return state;
  },
  wire: { viewSchema: schema, view: (state) => state },
};

/**
 * Read marks live in the HOST, not the browser (owner request 2026-10-28: "make it independent from
 * the device that viewed chats"). Declaring a Config gives this plugin a settings namespace, and the
 * settings API (`settings/describe`, `settings/update`) is same-origin for every browser, so a chat
 * read on the desktop is read on the phone too. One entry per session: `y` = needsInputSeq seen,
 * `g` = completedSeq seen, `t` = when it was marked (diagnostics only).
 */
const AckSchema = Schema.object({
  id: Schema.string().required().description('Session id (chat) this mark belongs to.'),
  y: Schema.number().default(0).description('Highest needsInputSeq the user has seen for this chat.'),
  g: Schema.number().default(0).description('Highest completedSeq the user has seen for this chat.'),
  t: Schema.number().default(0).description('Epoch ms of the last acknowledgement.'),
}).description('One chat read mark.');

export const Config = Schema.object({
  acks: Schema.array(AckSchema).default([]).volatile()   // leaf-level volatile = exposed via settings/describe + settings/update
    .description('Read marks written by the browser when a chat is viewed (shared by every device).'),
}).description('Unread-dot read marks (host-side, device independent).');

// cordis: a plugin must declare the services it reads from ctx, else
// "cannot get property 'sessionProjections' without inject" at boot (2026-10-26).
export const inject = ['sessionProjections'];
export function apply(ctx) {
  ctx.sessionProjections.register(needsInputProjection);
  // Keep the namespace API-only: no auto-generated "acks" form in Settings (same call shipped
  // plugins such as dsh-client-locale make). settings/describe still lists it for the browser half.
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });
}
apply.inject = ['sessionProjections'];
apply.Config = Config;   // dsh-settings reads the namespace schema from the plugin runtime (= this default export), not from a named export (2026-10-28)   // cordis reads inject from the plugin object (the default-exported function)
export default apply;
