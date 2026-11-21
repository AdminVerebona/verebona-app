/**
 * Carte #812 (reprise après la recette KO du 21/11/2026) — RENDU des composants de période de la fiche
 * (tiroir) d'un document : `DocumentBusinessPeriodField` (période principale) et `DocumentPeriodsDetail`
 * (autres natures). Rendu réel des composants (HTML statique), sans navigateur ; le test en vrai
 * navigateur, gabarit mobile, est `c812-fiche-periodes-navigateur.test.ts`.
 *
 *   C812-UI-01  l'API ne restitue pas de validité → aucune ligne « Début de validité » ; la garantie reste ;
 *   C812-UI-02  l'API ne restitue rien → aucun bloc (rien n'est inventé côté écran) ;
 *   C812-UI-03  témoin : le composant n'ajoute ni ne retire rien — ce que l'API restitue est rendu tel quel ;
 *   C812-UI-04  une vue d'un AUTRE document (réponse en retard) n'est jamais rendue ;
 *   C812-UI-05  le tiroir du document monte bien ces composants sur la lecture de la route des périodes.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DocumentPeriodsView, PeriodView } from '@/services/documents/business-periods/service';

(globalThis as { React?: typeof React }).React = React;
const { DocumentBusinessPeriodField, DocumentPeriodsDetail } = await import('../BusinessPeriods');

const DOC = 7;
const ligne = (id: number, kind: PeriodView['kind'], line: string, start: string | null, end: string | null): PeriodView => ({ id, kind, segment: 0, start, end, line, userCorrected: false });
const GARANTIE = ligne(31, 'WARRANTY', 'Période de garantie : du 17/11/2026 au 17/11/2028', '2026-11-17', '2028-11-17');
const VALIDITE = ligne(30, 'VALIDITY', 'Début de validité : 17/11/2026', '2026-11-17', null);
const vue = (principal: PeriodView | null, secondary: PeriodView[] = [], documentId = DOC): DocumentPeriodsView => ({
  documentId, principal: principal ? { kind: principal.kind, line: principal.line, segments: [principal] } : null, secondary, coverageHistories: [],
});
const rendre = (view: DocumentPeriodsView | null) => {
  const periods = { view, reload: () => {} };
  return renderToStaticMarkup(h('div', null, h(DocumentBusinessPeriodField, { documentId: DOC, periods }), h(DocumentPeriodsDetail, { documentId: DOC, periods })));
};

describe('C812 — fiche du document : rendu des périodes', () => {
  it('C812-UI-01 — l’API ne restitue pas de validité : aucune ligne « Début de validité », la garantie est affichée', () => {
    const html = rendre(vue(GARANTIE));
    expect(html).toContain('Période de garantie : du 17/11/2026 au 17/11/2028');
    expect(html).not.toMatch(/validité/i);
    expect(html).toContain('data-testid="business-period-principal"');
    // Carte #782 : lecture seule dans le tiroir — aucun bouton, donc aucun « Corriger ».
    expect(html).not.toMatch(/<button|Corriger/);
  });

  it('C812-UI-02 — l’API ne restitue aucune période : aucun bloc, aucun texte', () => {
    expect(rendre(vue(null))).toBe('<div></div>');
    expect(rendre(null)).toBe('<div></div>');
  });

  it('C812-UI-03 — témoin : le composant rend exactement ce que l’API restitue (il ne filtre ni n’ajoute rien)', () => {
    const html = rendre(vue(VALIDITE, [GARANTIE]));
    expect(html).toContain('Début de validité : 17/11/2026');
    expect(html).toContain('Période de garantie : du 17/11/2026 au 17/11/2028');
    expect(html).toContain('data-testid="business-period-secondary"');
    expect(html).not.toMatch(/<button|Corriger/);
  });

  it('C812-UI-04 — la vue d’un autre document n’est jamais rendue', () => {
    expect(rendre(vue(VALIDITE, [GARANTIE], 8))).toBe('<div></div>');
  });

  it('C812-UI-05 — le tiroir monte ces composants sur `useDocumentPeriods` (route des périodes), sans autre source', () => {
    const tiroir = readFileSync(resolve(__dirname, '../../assets/DocumentDrawer.tsx'), 'utf8');
    expect(tiroir).toMatch(/useDocumentPeriods\(/);
    expect(tiroir).toMatch(/<DocumentBusinessPeriodField\b/);
    expect(tiroir).toMatch(/<DocumentPeriodsDetail\b/);
    // Le libellé « Début de validité » n'existe dans aucun composant : il vient toujours du serveur (`periodLine`).
    const composant = readFileSync(resolve(__dirname, '../BusinessPeriods.tsx'), 'utf8');
    expect(`${tiroir}\n${composant}`).not.toMatch(/Début de validité/);
  });
});
