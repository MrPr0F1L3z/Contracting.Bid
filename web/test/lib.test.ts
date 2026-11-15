import { describe, expect, test } from 'vitest';
import { pushEvent, toDataLayerEvent } from '../src/lib/analytics';
import { rememberSignupEmail, takeSignupEmail } from '../src/lib/signupEmail';

function memoryStore() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data };
}

describe('analytics', () => {
  test('toDataLayerEvent prefixes the event and its props', () => {
    expect(toDataLayerEvent({ event: 'click', props: { id: 'hero_signup', experiment: 'landing_template', variant: 'blueprint' }, at: 5 })).toEqual({
      event: 'cb_click', cb_at: 5, cb_id: 'hero_signup', cb_experiment: 'landing_template', cb_variant: 'blueprint',
    });
  });

  test('toDataLayerEvent drops undefined and function props and tolerates no props', () => {
    expect(toDataLayerEvent({ event: 'x', props: { a: undefined, b: () => 1, c: 0 }, at: 1 })).toEqual({ event: 'cb_x', cb_at: 1, cb_c: 0 });
    expect(toDataLayerEvent({ event: 'x', at: 1 } as never)).toEqual({ event: 'cb_x', cb_at: 1 });
  });

  test('pushEvent appends to the layer and returns the row', () => {
    const layer: unknown[] = [];
    const row = pushEvent(layer, { event: 'signup_submit', props: { id: 'hero_signup' }, at: 9 });
    expect(layer).toEqual([row]);
    expect(row.event).toBe('cb_signup_submit');
  });
});

describe('signup email hand-off', () => {
  test('remember then take returns the trimmed email once', () => {
    const s = memoryStore();
    rememberSignupEmail('  sam@example.com ', s);
    expect(takeSignupEmail(s)).toBe('sam@example.com');
    expect(takeSignupEmail(s)).toBe('');
  });

  test('ignores empty and non-string values', () => {
    const s = memoryStore();
    for (const v of ['', '   ', undefined, null, 42, {}]) rememberSignupEmail(v, s);
    expect(s.data.size).toBe(0);
  });

  test('works without storage and when storage throws', () => {
    expect(() => rememberSignupEmail('a@b.co', null)).not.toThrow();
    expect(takeSignupEmail(null)).toBe('');
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => {} };
    expect(() => rememberSignupEmail('a@b.co', broken)).not.toThrow();
    expect(takeSignupEmail(broken)).toBe('');
  });
});
