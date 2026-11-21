import { describe, expect, test } from 'vitest';
import { SITE_TEMPLATES, TEMPLATE, parseTemplate } from '../src/lib/template';

describe('parseTemplate', () => {
  test('reads hivis in the spellings people type', () => {
    for (const v of ['hivis', 'HiVis', ' hivis ', 'hi-vis', 'Hi_Vis', 'HI VIS']) expect(parseTemplate(v), v).toBe('hivis');
  });

  test('is Blueprint for everything else', () => {
    for (const v of ['blueprint', '', 'field', 'b', 'hivisx', undefined, null, 1, {}]) expect(parseTemplate(v), String(v)).toBe('blueprint');
  });

  test('the site defaults to Blueprint and only offers built-out templates', () => {
    expect(TEMPLATE).toBe('blueprint');
    expect(SITE_TEMPLATES).toEqual(['blueprint', 'hivis']);
  });
});
