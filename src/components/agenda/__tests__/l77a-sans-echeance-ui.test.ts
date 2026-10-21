/**
 * Lot 77A — option « Sans échéance » : interface (desktop ET mobile).
 *
 * Tous les points d'entrée (« Mon agenda », onglet Agenda d'un bien,
 * équipement, document, accueil, « + » desktop et mobile) ouvrent les DEUX
 * mêmes tiroirs — création `CreateAgendaItemDrawer`, modification
 * `AgendaItemDrawer` — feuilles pleine largeur sur mobile. Le champ commun
 * `NoDeadlineField` est rendu (SSR), puis son câblage est vérifié dans chaque
 * tiroir et chaque vue de liste.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as { React?: typeof React }).React = React;
const { NoDeadlineField } = await import('../NoDeadlineField');

const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', p), 'utf8').replace(/\r\n?/g, '\n');
const etat = (p: Partial<{ startDate: string; noDeadline: boolean }> = {}) =>
  ({ startDate: '', startTime: '', endDate: '', endTime: '', noDeadline: false, ...p });
const rendre = (state: ReturnType<typeof etat>) =>
  renderToStaticMarkup(h(NoDeadlineField, { id: 'x-sans-echeance', state, onChange: () => undefined }));

describe('L77A-UI — champ « Sans échéance »', () => {
  it('L77A-UI1 — case à cocher de la charte, libellé clair relié, aide courte', () => {
    const html = rendre(etat());
    expect(html).toContain('data-slot="checkbox"');
    expect(html).toContain('id="x-sans-echeance"');
    expect(html).toContain('for="x-sans-echeance"');
    expect(html).toContain('Sans échéance');
    expect(html).toContain('aria-describedby="x-sans-echeance-aide"');
    expect(html).toContain('Cette tâche n’a pas de date à respecter.');
    expect(html).toContain('aria-checked="false"');
  });

  it('L77A-UI2 — état coché rendu', () => {
    expect(rendre(etat({ noDeadline: true }))).toContain('aria-checked="true"');
  });
});

describe('L77A-UI — câblage des tiroirs (création ET modification, desktop ET mobile)', () => {
  const creation = lire('components/agenda/CreateAgendaItemDrawer.tsx');
  const edition = lire('components/agenda/AgendaItemDrawer.tsx');

  it('L77A-UI3 — création : champ présent, date saisie → décoche, cocher → date retirée, valeur envoyée', () => {
    expect(creation).toContain('<NoDeadlineField');
    expect(creation).toContain('applyDates(toggleNoDeadline(dateState, checked))');
    expect(creation).toContain('applyDates(withDateEntry(dateState, { startDate: v }))');
    expect(creation).toContain('applyDates(withDateEntry(dateState, { endDate: v }))');
    expect(creation).toMatch(/apiClient\.post\("\/api\/agenda", \{[\s\S]*?noDeadline,/);
    expect(creation).toContain('className="w-full sm:max-w-[480px]');
  });

  it('L77A-UI4 — modification : champ présent, initialisé depuis l’élément, valeur envoyée', () => {
    expect(edition).toContain('<NoDeadlineField');
    expect(edition.match(/setEditNoDeadline\(item\.noDeadline === true\)/g)).toHaveLength(2);
    expect(edition).toContain('applyEditDates(toggleNoDeadline(editDates, checked))');
    expect(edition).toContain('applyEditDates(withDateEntry(editDates, { startDate: v }))');
    expect(edition).toMatch(/apiClient\.put\(`\/api\/agenda\/\$\{item\.id\}`, \{[\s\S]*?noDeadline: editNoDeadline,/);
    expect(edition).toContain('className="w-full sm:max-w-[520px]');
  });

  it('L77A-UI5 — tous les points d’entrée passent par ces deux tiroirs (aucun autre formulaire n’écrit l’agenda)', () => {
    expect(lire('components/mobile/add-forms.tsx')).toContain("import('@/components/agenda/CreateAgendaItemDrawer')");
    for (const f of ['app/(dashboard)/agenda/page.tsx', 'components/assets/AssetAgendaTab.tsx']) {
      expect(lire(f)).toMatch(/AgendaItemDrawer/);
    }
  });
});

describe('L77A-UI — affichage d’un élément « sans échéance »', () => {
  it('L77A-UI6 — groupe « Sans date » existant, mention discrète « Sans échéance » (liste, mensuel, bien, équipement, tiroir)', () => {
    expect(lire('app/(dashboard)/agenda/page.tsx')).toContain('{!item.startDate && item.noDeadline && (');
    expect(lire('components/agenda/AgendaPeriodViews.tsx')).toContain('{item.noDeadline && <span className="block text-[11px] text-muted-foreground">{NO_DEADLINE_LABEL}</span>}');
    expect(lire('components/assets/AssetAgendaTab.tsx')).toContain('!item.startDate ? undatedLabel(item)');
    expect(lire('components/assets/EquipmentDrawer.tsx')).toContain(": undatedLabel(item)}");
    expect(lire('app/api/equipments/[id]/agenda/route.ts')).toContain('noDeadline: item.noDeadline === true');
    const tiroir = lire('components/agenda/AgendaItemDrawer.tsx');
    expect(tiroir).toContain('if (!item.startDate) return undatedLabel(item);');
    expect(tiroir).toContain('{item.noDeadline ? (');
  });
});
