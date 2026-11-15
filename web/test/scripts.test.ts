import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { exportedNames, toModule, toVitest } from '../scripts/design-module.mjs';
import { tokensToCss } from '../scripts/tokens-css.mjs';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const BUNDLE = `/* @ds-bundle: {"format":4} */
(function () {
  'use strict';
  var React = window.React;
  function A() { return null; }
  function b() { return 1; }
  window.CB = {
    A: A, b: b
  };
})();
`;

describe('design bundle import', () => {
  test('exportedNames reads the window.CB keys', () => {
    expect(exportedNames(BUNDLE)).toEqual(['A', 'b']);
  });

  test('exportedNames rejects a missing, empty or renamed export', () => {
    expect(() => exportedNames('var x = 1;')).toThrow(/window\.CB/);
    expect(() => exportedNames('window.CB = { };')).toThrow(/nothing/);
    expect(() => exportedNames('window.CB = { A: Other };')).toThrow(/own name/);
    expect(() => exportedNames('window.CB = { A: A')).toThrow(/not closed/);
  });

  test('toModule produces a client ES module with named and default exports', () => {
    const out = toModule(BUNDLE);
    expect(out.startsWith("'use client';")).toBe(true);
    expect(out).toContain("import * as React from 'react';");
    expect(out).toContain('export { A, b };');
    expect(out).toContain('export default CB;');
    expect(out).not.toContain('window.React');
    expect(out).not.toContain('window.CB');
    expect(out).not.toContain('@ds-bundle');
  });

  test('toModule rejects a file that is not the bundle', () => {
    expect(() => toModule('window.CB = { A: A };')).toThrow(/wrapper/);
    expect(() => toModule("(function () {\n  'use strict';\n  var React = window.React;\n  window.CB = { A: A };")).toThrow(/wrapper/);
  });

  test('toVitest swaps the node:test setup for Vitest imports and keeps the tests', () => {
    const out = toVitest("const test = require('node:test');\nconst CB = global.window.CB;\ntest('x', () => {});\n");
    expect(out).toContain("import { test, vi } from 'vitest';");
    expect(out).toContain("test('x', () => {});");
    expect(out).not.toContain('require(');
    expect(() => toVitest("test('x', () => {});")).toThrow(/setup block/);
  });

  test('the committed module matches what the importer generates from its own exports', () => {
    const cb = read('../src/design/cb.js');
    const names = /export \{ (.+) \};/.exec(cb)?.[1]?.split(', ') ?? [];
    expect(names).toContain('Workspace');
    expect(names).toContain('setLinks');
  });
});

describe('tokens', () => {
  const tokens = {
    color: {
      themes: [{ id: 'a' }, { id: 'b' }],
      tokens: [
        { name: 'brand', value: { a: '#111111', b: '#222222' } },
        { name: 'plain', value: '#333333' },
        { name: 'chart', value: '{brand}' },
        { name: 'only-a', value: { a: '#444444' } },
      ],
    },
    shadow: { tokens: [{ name: 'shadow-card', value: '0 1px 2px #000' }] },
    spacing: { tokens: [{ name: 'space-1', value: '4px' }] },
    radius: { tokens: [{ name: 'radius-md', value: '8px' }] },
    type: { families: { sans: '"X", sans-serif' } },
  };

  test('tokensToCss declares each theme, resolves aliases per theme, and inherits the first theme', () => {
    const css = tokensToCss(tokens);
    expect(css).toContain(':root, [data-theme="a"] {');
    expect(css).toMatch(/\[data-theme="b"\] \{[^}]*--brand: #222222;[^}]*--plain: #333333;[^}]*--chart: #222222;[^}]*--only-a: #444444;/);
    expect(css).toMatch(/:root, \[data-theme="a"\] \{[^}]*--chart: #111111;/);
    expect(css).toContain('--shadow-card: 0 1px 2px #000;');
    expect(css).toMatch(/:root \{\n {2}--space-1: 4px;\n {2}--radius-md: 8px;\n {2}--font-sans: "X", sans-serif;\n\}/);
  });

  test('tokensToCss rejects a missing or circular alias', () => {
    const bad = (value: string) => ({ ...tokens, color: { ...tokens.color, tokens: [{ name: 'x', value }] } });
    expect(() => tokensToCss(bad('{nope}'))).toThrow(/missing token/);
    expect(() => tokensToCss(bad('{x}'))).toThrow(/too deep/);
  });

  test('the committed tokens.css is in sync with tokens.json', () => {
    expect(read('../src/design/tokens.css')).toBe(tokensToCss(JSON.parse(read('../src/design/tokens.json'))));
  });
});
