/**
 * APP-PERF-38 T-02 — écran d'erreur global : message maîtrisé, en français,
 * aucun nom d'outil historique présenté au client, aucun envoi hors page.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ErrorReporter, { GLOBAL_ERROR_MESSAGE, GLOBAL_ERROR_TITLE } from '../ErrorReporter';

// Le harnais (environnement node) compile le JSX en `React.createElement`.
(globalThis as { React?: typeof React }).React = React;

describe('écran d’erreur global', () => {
  it('message maîtrisé, référence de support, aucun nom d’outil historique', () => {
    const err = Object.assign(new Error('boum'), { digest: 'abc123' });
    const html = renderToStaticMarkup(createElement(ErrorReporter, { error: err, reset: () => {} }));
    expect(html).toContain(GLOBAL_ERROR_TITLE);
    expect(html).toContain('Réessayer');
    expect(html).toContain('Référence : abc123');
    expect(html).not.toMatch(/orchids|Something went wrong/i);
    expect(GLOBAL_ERROR_MESSAGE).not.toMatch(/orchids/i);
  });

  it('aucune transmission d’erreur à une fenêtre parente', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/ErrorReporter.tsx'), 'utf8');
    expect(src).not.toMatch(/postMessage\s*\(/);
  });

  it('pages ordinaires : rien n’est rendu', () => {
    expect(renderToStaticMarkup(createElement(ErrorReporter, {}))).toBe('');
  });
});
