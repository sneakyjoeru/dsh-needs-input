import { z } from 'zod';

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
// cordis: a plugin must declare the services it reads from ctx, else
// "cannot get property 'sessionProjections' without inject" at boot (2026-10-26).
export const inject = ['sessionProjections'];
export function apply(ctx) {
  ctx.sessionProjections.register(needsInputProjection);
}
apply.inject = ['sessionProjections'];   // cordis reads inject from the plugin object (the default-exported function)
export default apply;
