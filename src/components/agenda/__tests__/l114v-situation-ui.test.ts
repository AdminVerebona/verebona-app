/**
 * Lot 114V (Trello #742) — « A eu lieu | À prévoir » : interface (desktop ET
 * mobile : mêmes composants).
 *
 * Tous les points de création / modification manuelle (« Mon agenda », onglet
 * Agenda d'un bien, équipement, document, accueil, « + » desktop et mobile)
 * ouvrent les DEUX mêmes tiroirs. Le champ commun `SituationField` est rendu
 * (SSR, sans DOM), puis son câblage est vérifié dans chaque tiroir, dans les
 * vues de l'Agenda, dans le bloc d'accueil et sur la carte « À traiter ».
 * Le harnais n'a pas de navigateur : contraste, focus réel et lecteur d'écran
 * restent à vérifier en recette.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('sonner', () => ({ toast: Object.assign(() => {}, { info: () => {}, error: () => {}, success: () => {} }) }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/accueil',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: async () => [] } }));

(globalThis as { React?: typeof React }).React = React;
const { SituationField } = await import('../SituationField');
const { UpcomingEvents, toPlanSeeAllLabel } = await import('@/components/home/HomeBlocks');
const { ActionCard, isSituationQualificationCard } = await import('@/components/to-process/ActionCard');
const { situationChoicePayload, SITUATION_CARD_LABELS } = await import('@/components/to-process/AgendaSituationChoice');
const { SITUATION_QUESTION } = await import('@/lib/agenda/situation');
type ActionView = import('@/components/to-process/ActionCard').ActionView;

const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', p), 'utf8').replace(/\r\n?/g, '\n');
const champ = (value: 'A_EU_LIEU' | 'A_PREVOIR' | null) =>
  renderToStaticMarkup(h(SituationField, { id: 'x-situation', value, onChange: () => undefined }));
/** Segments rendus, dans l'ordre du DOM : [valeur, coché, tabindex, libellé]. */
const segments = (html: string) => [...html.matchAll(/<button[^>]*role="radio"[^>]*>([^<]*)<\/button>/g)].map((m) => ({
  situation: /data-situation="([^"]+)"/.exec(m[0])?.[1], checked: /aria-checked="([^"]+)"/.exec(m[0])?.[1],
  tabIndex: /tabindex="([^"]+)"/.exec(m[0])?.[1], label: m[1],
}));

describe('L114V-UI — sélecteur segmenté « Situation de l’événement »', () => {
  it('L114V-UI1 — deux segments horizontaux : GAUCHE « A eu lieu », DROITE « À prévoir » ; libellé du champ relié au groupe', () => {
    const html = champ('A_PREVOIR');
    expect(segments(html).map((s) => s.label)).toEqual(['A eu lieu', 'À prévoir']);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-labelledby="x-situation-libelle"');
    expect(html).toMatch(/<p id="x-situation-libelle"[^>]*>Situation de l’événement<\/p>/);
    expect(html).toContain('grid-cols-2');
    // Ni interrupteur, ni cases à cocher, ni troisième option.
    expect(html).not.toMatch(/role="switch"|role="checkbox"|type="checkbox"/);
    expect(segments(html)).toHaveLength(2);
  });

  it('L114V-UI2 — création : « À prévoir » (droite) sélectionné par défaut ; un seul arrêt de tabulation, sur le segment sélectionné', () => {
    expect(segments(champ('A_PREVOIR'))).toEqual([
      { situation: 'A_EU_LIEU', checked: 'false', tabIndex: '-1', label: 'A eu lieu' },
      { situation: 'A_PREVOIR', checked: 'true', tabIndex: '0', label: 'À prévoir' },
    ]);
    const creation = lire('components/agenda/CreateAgendaItemDrawer.tsx');
    expect(creation).toContain('useState<AgendaSituation>(DEFAULT_NEW_SITUATION)');
    expect(creation).toContain('setSituation(DEFAULT_NEW_SITUATION);');
  });

  it('L114V-UI3 — modification : la valeur persistée est sélectionnée ; élément hérité non qualifié : AUCUN segment sélectionné (rien de présumé)', () => {
    expect(segments(champ('A_EU_LIEU')).map((s) => [s.checked, s.tabIndex])).toEqual([['true', '0'], ['false', '-1']]);
    expect(segments(champ(null)).map((s) => [s.checked, s.tabIndex])).toEqual([['false', '0'], ['false', '-1']]);
  });

  it('L114V-UI4 — clavier et charte : flèches gauche / droite / haut / bas, segments de 40 px, jetons CSS seulement (aucune couleur brute)', () => {
    const src = lire('components/agenda/SituationField.tsx');
    for (const k of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp']) expect(src).toContain(`"${k}"`);
    expect(src).toContain('min-h-10');
    const classes = (src.match(/className=\{?[`"][^`"]*[`"]/g) ?? []).join(' ') + (src.match(/"(?:bg|text)-\[[^"]*"/g) ?? []).join(' ');
    expect(classes).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
    expect(src).toContain('bg-[color:var(--accent)] text-[color:var(--on-accent)]');
    // L'anneau de focus est celui de la charte (règle globale sur les boutons et `role="radio"`).
    expect(lire('app/globals.css')).toMatch(/\[role="radio"\][\s\S]{0,200}:focus-visible/);
  });
});

describe('L114V-UI — câblage des tiroirs (création ET modification, tous les points d’entrée)', () => {
  const creation = lire('components/agenda/CreateAgendaItemDrawer.tsx');
  const edition = lire('components/agenda/AgendaItemDrawer.tsx');

  it('L114V-UI5 — création : champ présent, valeur TOUJOURS envoyée (aucun clic requis), la date n’est ni masquée ni vidée', () => {
    expect(creation).toContain('<SituationField');
    expect(creation).toMatch(/apiClient\.post\("\/api\/agenda", \{[\s\S]*?\n        situation,\n/);
    // Changer de situation ne touche à aucune date du formulaire.
    const bloc = creation.slice(creation.indexOf('<SituationField'), creation.indexOf('{/* Dates */}'));
    expect(bloc).not.toMatch(/setStartDate|setEndDate|applyDates/);
    expect(creation.indexOf('<SituationField')).toBeLessThan(creation.indexOf('<Label>Date début</Label>'));
    // « Sans échéance » (lot 77A) ne s'applique qu'à un événement à prévoir.
    expect(creation).toContain('{situation !== "A_EU_LIEU" && <NoDeadlineField');
  });

  it('L114V-UI6 — modification : initialisée depuis la valeur PERSISTÉE (deux entrées en modification), jamais remise au défaut ; envoyée seulement si elle est choisie', () => {
    expect(edition).toContain('<SituationField');
    expect(edition.match(/setEditSituation\(situationOf\(item\.situation\)\)/g)).toHaveLength(2);
    expect(edition).not.toContain('DEFAULT_NEW_SITUATION');
    expect(edition).toContain('...(editSituation ? { situation: editSituation } : {}),');
    expect(edition).toContain('value={editSituation}');
    // Lecture : la situation persistée est affichée avec la même terminologie.
    expect(edition).toContain('data-testid="agenda-situation-lecture"');
  });

  it('L114V-UI7 — tous les points d’entrée passent par ces deux tiroirs (aucun autre formulaire n’écrit l’agenda)', () => {
    expect(lire('components/mobile/add-forms.tsx')).toContain("import('@/components/agenda/CreateAgendaItemDrawer')");
    for (const f of ['app/(dashboard)/agenda/page.tsx', 'components/assets/AssetAgendaTab.tsx', 'components/drawers/GlobalDrawerHost.tsx']) {
      expect(lire(f)).toMatch(/AgendaItemDrawer/);
    }
    const autres = ['components/assets/AssetAgendaTab.tsx', 'components/assets/EquipmentDrawer.tsx', 'app/(dashboard)/agenda/page.tsx']
      .filter((f) => /apiClient\.(post|put)\(["'`]\/api\/agenda["'`/]/.test(lire(f)));
    expect(autres).toEqual([]);
  });
});

describe('L114V-UI — Agenda : sections hors calendrier daté', () => {
  it('L114V-UI8 — liste et vue mensuelle : groupes « À prévoir », « Sans date », « Date inconnue » avec décompte ; action « Planifier » sur le même événement', () => {
    const page = lire('app/(dashboard)/agenda/page.tsx');
    expect(page).toContain('groupUndated(undated)');
    expect(page).toContain('{group.date === null && <p className="vb-group-label px-1">{group.label} · {group.items.length}</p>}');
    expect(page).toContain("onPlan={() => { setSelectedMode('edit'); setSelectedItem(item); }}");
    expect(page).toContain("undatedGroupOf(item) === 'A_PREVOIR'");
    expect(page).toContain('initialMode={selectedMode}');
    const mois = lire('components/agenda/AgendaPeriodViews.tsx');
    expect(mois).toContain('{groupUndated(undated).map((g) => (');
    expect(mois).toContain('<p className="vb-group-label px-1">{g.label} · {g.items.length}</p>');
    // Fiches (bien, équipement, tiroir) : libellé selon la situation (règle unique).
    expect(lire('components/assets/AssetAgendaTab.tsx')).toContain('!item.startDate ? undatedLabel(item)');
    expect(lire('app/api/equipments/[id]/agenda/route.ts')).toContain('situation: item.situation ?? null');
  });
});

describe('L114V-UI — accueil : groupe « À prévoir » de « Prochaines échéances »', () => {
  const datee = { id: 7, title: 'Contrôle technique', assetName: 'Clio', date: '2026-11-20', day: '20', month: 'nov.', rel: 'Dans 6 jours', tone: 'amber' as const, forecast: false };
  const toPlan = { items: [{ id: 41, title: 'Entretien pompe à chaleur', assetName: 'Maison' }, { id: 42, title: 'Ramonage', assetName: null }], total: 5 };

  it('L114V-UI9 — dans le bloc existant, SOUS les échéances datées ; intitulé, bien, mention « À prévoir », aucune date ni délai inventé', () => {
    const html = renderToStaticMarkup(h(UpcomingEvents, { items: [datee], toPlan }));
    expect(html.match(/data-home-section="home-echeances"/g)).toHaveLength(1);
    expect(html.indexOf('Contrôle technique')).toBeLessThan(html.indexOf('data-home-group="a-prevoir"'));
    const groupe = html.slice(html.indexOf('data-home-group="a-prevoir"'));
    expect(groupe).toMatch(/<h3 id="home-echeances-a-prevoir"[^>]*>À prévoir<\/h3>/);
    expect(groupe).toContain('Entretien pompe à chaleur');
    expect(groupe).toContain('Maison · À prévoir');
    expect(groupe).not.toMatch(/Aujourd’hui|Demain|Dans \d|En retard|nov\.|\d{4}/);
  });

  it('L114V-UI10 — action « Planifier » nommée par l’événement, bouton distinct de l’ouverture de la fiche ; lien vers la liste complète au-delà du plafond', () => {
    const html = renderToStaticMarkup(h(UpcomingEvents, { items: [], toPlan }));
    expect(html).toContain('aria-label="Planifier : Entretien pompe à chaleur"');
    expect(html.match(/>Planifier<\/button>/g)).toHaveLength(2);
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
    expect(html).toContain(`href="/agenda"`);
    expect(html).toContain(toPlanSeeAllLabel(5));
    // Sans échéance datée mais avec des événements à prévoir : pas de message « Aucune échéance ».
    expect(html).not.toContain('Aucune échéance pour l’instant');
    const src = lire('components/home/HomeBlocks.tsx');
    expect(src).toContain("openDrawer({ kind: 'echeance', id: e.id, initialMode: 'edit' })");
  });

  it('L114V-UI11 — sans événement à prévoir : bloc inchangé (aucun groupe vide) ; total égal aux lignes : pas de lien superflu', () => {
    const vide = renderToStaticMarkup(h(UpcomingEvents, { items: [], toPlan: { items: [], total: 0 } }));
    expect(vide).toContain('Aucune échéance pour l’instant');
    expect(vide).not.toContain('data-home-group="a-prevoir"');
    expect(renderToStaticMarkup(h(UpcomingEvents, { items: [datee] }))).not.toContain('data-home-group');
    const juste = renderToStaticMarkup(h(UpcomingEvents, { items: [], toPlan: { items: toPlan.items, total: 2 } }));
    expect(juste).not.toContain('Voir les');
  });
});

describe('L114V-UI — carte « À traiter » de qualification (élément hérité ambigu)', () => {
  const carte = (p: Partial<ActionView> = {}): ActionView => ({
    publicId: 'a1', targetType: 'AGENDA_ITEM', targetId: 12, fieldKey: 'date', relationKey: null, actionKind: 'COMPLETE', priority: 'DO_NEXT',
    ruleCode: 'DATA-AGENDA-DATE', question: SITUATION_QUESTION, proposals: [], inputType: null, target: { label: 'Entretien pompe à chaleur', assetName: 'Maison' }, ...p,
  });
  const rendre = (a: ActionView) => renderToStaticMarkup(h(ActionCard, { action: a, onChoose: () => {}, onOpenTarget: () => {} }));

  it('L114V-UI12 — question neutre, deux choix de MÊME poids sans présélection, date facultative, « Ouvrir »', () => {
    const html = rendre(carte());
    expect(html).toContain('Cet événement est-il à prévoir ou a-t-il déjà eu lieu ?');
    expect(html).not.toMatch(/quelle date/i);
    const boutons = [...html.matchAll(/<button[^>]*data-situation="([^"]+)"[^>]*>/g)];
    expect(boutons.map((b) => b[1])).toEqual(['A_EU_LIEU', 'A_PREVOIR']);
    // Même variante neutre pour les deux : aucune mise en avant, aucun état coché.
    const variantes = boutons.map((b) => /data-variant="([^"]+)"/.exec(b[0])?.[1] ?? /class="([^"]+)"/.exec(b[0])?.[1]);
    expect(variantes[0]).toBe(variantes[1]);
    expect(html).not.toMatch(/aria-checked="true"|aria-pressed="true"/);
    expect(html).toMatch(/<label[^>]*>Date \(facultative\)<\/label>/);
    expect(html).toMatch(/<input[^>]*type="date"[^>]*value=""/);
    expect(html).toContain('>Ouvrir<');
  });

  it('L114V-UI13 — seule la carte de qualification porte ces choix : arbitrage de dates (lot 83A) et date d’un fait établi inchangés', () => {
    expect(isSituationQualificationCard(carte())).toBe(true);
    expect(isSituationQualificationCard(carte({ question: 'À quelle date « Achat Clio » a-t-il lieu ?' }))).toBe(false);
    expect(isSituationQualificationCard(carte({ actionKind: 'ARBITRATE' }))).toBe(false);
    expect(isSituationQualificationCard(carte({ ruleCode: 'DATA-CONTRACT-END', targetType: 'DOCUMENT' }))).toBe(false);
    expect(rendre(carte({ question: 'À quelle date « Achat Clio » a-t-il lieu ?' }))).not.toContain('data-situation-choice');
  });

  it('L114V-UI14 — demande envoyée au service de l’Agenda : la situation, et la date SEULEMENT si elle est saisie (jamais une date fabriquée)', () => {
    expect(situationChoicePayload('A_PREVOIR', '')).toEqual({ situation: 'A_PREVOIR' });
    expect(situationChoicePayload('A_EU_LIEU', '  ')).toEqual({ situation: 'A_EU_LIEU' });
    expect(situationChoicePayload('A_EU_LIEU', '2026-03-02')).toEqual({ situation: 'A_EU_LIEU', startDate: '2026-03-02' });
    expect(situationChoicePayload('A_PREVOIR', '02/03/2026')).toEqual({ situation: 'A_PREVOIR' });
    const src = lire('components/to-process/AgendaSituationChoice.tsx');
    expect(src).toContain('apiClient.put(`/api/agenda/${agendaItemId}`, situationChoicePayload(situation, date))');
    expect(src).toContain('notifyToProcessChanged();');
    expect(SITUATION_CARD_LABELS.optionalDate).toBe('Date (facultative)');
  });
});
