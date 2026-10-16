/**
 * Lot 61 — T1-GEM-12 (BO › Exécutions IA) : statut SÉPARÉ des trois phases T1
 * (extraction, structuration, persistance) et détail technique de l'échec.
 * Un seul composant, mise en page fluide (`flex-wrap`) : identique sur
 * desktop et mobile.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { React?: typeof React }).React = React;
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { T1PhasesLine } = await import('../ExecutionReportPanel');

describe('T1-GEM-12 — phases T1 dans le rapport BO', () => {
  it('T1-GEM-12 : extraction réussie, structuration en échec (code, étape), persistance non exécutée', () => {
    const html = renderToStaticMarkup(h(T1PhasesLine, { phases: {
      extraction: { state: 'SUCCEEDED', detail: { files: [{ fileId: 98, status: 'COMPLETE', pageCount: 2 }] } },
      structuring: { state: 'FAILED', detail: { code: 'REQUEST_BUILD_FAILED', stage: 'request_build', recoverable: false } },
      persistence: { state: 'NOT_RUN', detail: { reason: 'structuration non aboutie' } },
    } }));
    expect(html).toContain('Extraction · réussie');
    expect(html).toContain('Structuration · en échec');
    expect(html).toContain('Persistance · non exécutée');
    expect(html).toContain('REQUEST_BUILD_FAILED');
    expect(html).toContain('request_build');
    expect(html).toContain('flex-wrap');
  });

  it('T1-GEM-12 : rapport antérieur (sans phases) → rien affiché', () => {
    expect(renderToStaticMarkup(h(T1PhasesLine, { phases: undefined }))).toBe('');
  });
});
