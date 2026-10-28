import { z } from 'zod';
import Schema from '@deepseek-ai/schemastery';

export const NEEDS_INPUT_KEY = 'needsInput';
const schema = z.object({
  needsInput: z.enum(['none', 'blocked', 'failed']),
  needsInputSeq: z.number().int().nonnegative(),
  completedSeq: z.number().int().nonnegative(),
}).strict();
export const needsInputProjection = {
  key: NEEDS_INPUT_KEY,
  stateVersion: 1,
  stateSchema: schema,
  init: () => ({ needsInput: 'none', needsInputSeq: 0, completedSeq: 0 }),
  apply(state, event) {
    if (event.type === 'user/message') return { ...state, needsInput: 'none', needsInputSeq: event.seq };
    if (event.type !== 'turn/end') return state;
    const kind = event.data?.reason?.kind;
    if (kind === 'blocked') return { ...state, needsInput: 'blocked', needsInputSeq: event.seq };
    if (kind === 'error' || kind === 'max-tokens') return { ...state, needsInput: 'failed', needsInputSeq: event.seq };
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
// Deliberately NOT volatile: a packaged plugin resolves the profile's schemastery, whose `.volatile()`
// does not exist (measured 2026-10-28), and nothing in the host reads these marks live — the browser
// reads and writes them through the settings document, which is what makes them device independent.
const AckSchema = Schema.object({
  id: Schema.string().required().description('Session id (chat) this mark belongs to.'),
  y: Schema.number().default(0).description('Highest needsInputSeq the user has seen for this chat.'),
  g: Schema.number().default(0).description('Highest completedSeq the user has seen for this chat.'),
  t: Schema.number().default(0).description('Epoch ms of the last acknowledgement.'),
}).description('One chat read mark.');

export const Config = Schema.object({
  acks: Schema.array(AckSchema).default([])
    .description('Read marks written by the browser when a chat is viewed (shared by every device).'),
}).description('Unread-dot read marks (host-side, device independent).');

// cordis: a plugin must declare the services it reads from ctx, else
// "cannot get property 'sessionProjections' without inject" at boot (2026-10-26).
export const inject = ['sessionProjections'];
export function apply(ctx) {
  ctx.sessionProjections.register(needsInputProjection);
}
apply.inject = ['sessionProjections'];   // cordis reads inject from the plugin object (the default-exported function)
export default apply;
