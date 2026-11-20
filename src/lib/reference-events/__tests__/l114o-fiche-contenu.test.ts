/**
 * Lot 114O (Trello #744) — travaux D de la carte, CONTENU de la fiche :
 * SYNTHÈSE factuelle, MONTANTS et NOTE LIBRE (CDC « Opérations / Agenda
 * V2.0 » §5, §14, §18 ; AC42, AC52 à AC55, AC57).
 *
 *   L114OK-U01  textes : nouveaux listés, nom du champ repris du référentiel existant, jamais « Opération »
 *   L114OK-U02  montant en euros et période : jamais une date ni un montant fabriqués
 *   L114OK-U03  repères affichables : aucune rubrique vide, aucun zéro, devise non convertie signalée
 *   L114OK-U04  note : lecture de la demande (forme, borne), vide = retrait, texte inchangé = rien à enregistrer
 *   L114OK-U05  rendu de la page : « Synthèse » seulement si elle dit quelque chose ; la note sous « Votre déclaration »
 *   L114OK-U06  gardes de code : le montant vient du moteur EXISTANT, nombres dédoublonnés, lecture bornée au compte,
 *               aucune IA, aucune écriture ; la note n'est écrite que par la façade
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  REFERENCE_EVENT_NOTES_FIELD, REFERENCE_EVENT_NOTES_LABELS, REFERENCE_EVENT_NOTES_MAX, REFERENCE_EVENT_SUMMARY_LABELS,
  REFERENCE_EVENT_SUMMARY_SUPPLIERS_SHOWN, buildReferenceEventNotes, parseReferenceEventNotes, referenceEventEuros,
  referenceEventPeriodOf, referenceEventPeriodText, referenceEventSummaryEntries,
  type ReferenceEventSummary,
} from '../reference-event-summary';
import { NOTES_DESCRIPTION_LABEL, NOTES_MAX_LENGTH } from '@/lib/documents/notes-description';
import type { ReferenceEventPageView } from '@/services/business-operations/graph/reference-event-page';
import { sansTextes806 } from './textes-806';

(globalThis as { React?: typeof React }).React = React;
const { ReferenceEventPageContent } = await import('@/components/reference-events/ReferenceEventPageContent');

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n?/g, '\n');
/** Code seulement (commentaires et imports retirés). */
const visible = (s: string) => s.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*|import )/.test(l)).map((l) => l.replace(/\{\/\*.*?\*\/\}/g, '')).join('\n');

const synthese = (over: Partial<ReferenceEventSummary> = {}): ReferenceEventSummary => ({
  netCents: 123456, unconvertedCount: 0, documentCount: 3, agendaItemCount: 2,
  supplierNames: ['Thermo Services'], period: { from: '2024-01-10', to: '2024-04-02' }, ...over,
});

const fiche = (over: Partial<ReferenceEventPageView> = {}): ReferenceEventPageView => ({
  id: 42, redirectedFrom: null, version: 3, title: 'Intervention — Chaudière', ownLabel: 'Chaudière', typeCode: 'INTERVENTION',
  provider: 'Thermo Services', dates: [{ role: 'REALIZED', date: '2024-04-02' }], undated: false,
  declarations: [], assets: [], equipments: [], suppliers: [{ id: 5, name: 'Thermo Services' }], coverages: [],
  documents: [{ fileId: 11, title: 'Facture', date: '2024-04-02' }], agendaItems: [], relations: [],
  summary: synthese(), notes: null, ...over,
});
const openers = { openDocument: () => undefined, openAgendaItem: () => undefined, openEquipment: () => undefined, onPeriodsSaved: () => undefined };
const rendre = (f: ReferenceEventPageView) => renderToStaticMarkup(h(ReferenceEventPageContent, { fiche: f, openers }));
/** Gestes de la page (pour vérifier le geste de la note) — aucun n'est appelé par ces tests. */
const gestes = {
  correct: () => undefined, remove: () => undefined, linkAgenda: () => undefined, unlinkAgenda: () => undefined,
  linkDocument: () => undefined, unlinkDocument: () => undefined, linkSupplier: () => undefined,
  unlinkSupplier: () => undefined, associate: () => undefined, dissociate: () => undefined, editNotes: () => undefined,
};
const rendreAvecGestes = (f: ReferenceEventPageView) => renderToStaticMarkup(h(ReferenceEventPageContent, { fiche: f, openers, actions: gestes }));

describe('L114OK-U01 — textes', () => {
  it('le nom du champ libre est celui du référentiel EXISTANT (ticket #723) : aucune règle ni aucun texte dupliqué', () => {
    expect(REFERENCE_EVENT_NOTES_FIELD).toBe(NOTES_DESCRIPTION_LABEL);
    expect(REFERENCE_EVENT_NOTES_LABELS.field).toBe('Notes / Description');
    expect(REFERENCE_EVENT_NOTES_MAX).toBe(NOTES_MAX_LENGTH);
  });
  it('aucun texte ne dit « événement de référence », ni un état, ni une progression', () => {
    const tous = [...Object.values(REFERENCE_EVENT_SUMMARY_LABELS), ...Object.values(REFERENCE_EVENT_NOTES_LABELS)];
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    for (const t of tous) expect(t, t).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence|Statut|En cours|Envisagé|Annulé|pipeline|étape|progression/i);
    for (const t of tous) expect(t.length, t).toBeGreaterThan(0);
  });
  it('la synthèse dit ce qu’elle ne compte pas : devis et prévisions dehors, partage compté une fois', () => {
    expect(REFERENCE_EVENT_SUMMARY_LABELS.spentHint).toMatch(/devis/i);
    expect(REFERENCE_EVENT_SUMMARY_LABELS.note).toMatch(/une seule fois/);
  });
});

describe('L114OK-U02 — montant et période : rien n’est fabriqué', () => {
  it('montant : centimes d’euro écrits en français ; inconnu → rien du tout', () => {
    expect(referenceEventEuros(123456)?.replace(/ | /g, ' ')).toBe('1 234,56 €');
    expect(referenceEventEuros(0)?.replace(/ | /g, ' ')).toBe('0,00 €');
    expect(referenceEventEuros(-50000)?.replace(/ | /g, ' ')).toBe('-500,00 €');
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) expect(referenceEventEuros(v)).toBeNull();
  });
  it('période : bornes extrêmes des faits datés reçus, dates partielles ramenées à leur borne basse', () => {
    expect(referenceEventPeriodOf(['2024-04-02', '2024-01-10', '2024-02-29'])).toEqual({ from: '2024-01-10', to: '2024-04-02' });
    expect(referenceEventPeriodOf(['2020-03', '2021'])).toEqual({ from: '2020-03-01', to: '2021-01-01' });
    expect(referenceEventPeriodOf(['2024-04-02T10:00:00Z'])).toEqual({ from: '2024-04-02', to: '2024-04-02' });
  });
  it('aucune date inventée : rien de daté → aucune période ; valeurs impossibles ignorées', () => {
    expect(referenceEventPeriodOf([])).toBeNull();
    expect(referenceEventPeriodOf([null, undefined, '', 'bientôt', '2023-02-29', '2024-13-01'])).toBeNull();
    expect(referenceEventPeriodText(null)).toBeNull();
  });
  it('période écrite : « Du … au … » ; un seul jour : « Le … »', () => {
    expect(referenceEventPeriodText({ from: '2024-01-10', to: '2024-04-02' })).toBe('Du 10/01/2024 au 02/04/2024');
    expect(referenceEventPeriodText({ from: '2024-01-10', to: '2024-01-10' })).toBe('Le 10/01/2024');
  });
});

describe('L114OK-U03 — repères affichables', () => {
  it('synthèse complète : montant, justificatifs, période, événements, fournisseurs — dans cet ordre', () => {
    const e = referenceEventSummaryEntries(synthese({ agendaItemCount: 2 }));
    expect(e.map((x) => x.key)).toEqual(['spent', 'documents', 'period', 'agenda', 'suppliers']);
    expect(e[1].value).toBe('3');
    expect(e[2].value).toBe('Du 10/01/2024 au 02/04/2024');
    expect(e[4].value).toBe('Thermo Services');
  });
  it('AUCUNE rubrique sans information : ni zéro, ni « — », ni montant inventé', () => {
    const e = referenceEventSummaryEntries(synthese({ netCents: null, documentCount: 0, agendaItemCount: 0, supplierNames: [], period: null }));
    expect(e).toEqual([]);
    expect(referenceEventSummaryEntries(null)).toEqual([]);
    expect(referenceEventSummaryEntries(undefined)).toEqual([]);
    // Un nom vide n'est pas un fournisseur.
    expect(referenceEventSummaryEntries(synthese({ netCents: null, documentCount: 0, agendaItemCount: 0, period: null, supplierNames: ['', '  '] }))).toEqual([]);
  });
  it('un montant connu de 0 reste affiché (c’est un fait), un montant inconnu non', () => {
    expect(referenceEventSummaryEntries(synthese({ netCents: 0 })).map((x) => x.key)).toContain('spent');
    expect(referenceEventSummaryEntries(synthese({ netCents: null })).map((x) => x.key)).not.toContain('spent');
  });
  it('devise sans contre-valeur connue : signalée, jamais convertie (AC54)', () => {
    const un = referenceEventSummaryEntries(synthese({ unconvertedCount: 1 }))[0];
    expect(un.hint).toContain(REFERENCE_EVENT_SUMMARY_LABELS.spentUnconverted);
    const plusieurs = referenceEventSummaryEntries(synthese({ unconvertedCount: 3 }))[0];
    expect(plusieurs.hint).toContain(REFERENCE_EVENT_SUMMARY_LABELS.spentUnconvertedMany);
    expect(referenceEventSummaryEntries(synthese())[0].hint).toBe(REFERENCE_EVENT_SUMMARY_LABELS.spentHint);
  });
  it('fournisseurs : les trois premiers nommés, puis « et n autres » (aucune liste muette)', () => {
    expect(REFERENCE_EVENT_SUMMARY_SUPPLIERS_SHOWN).toBe(3);
    const quatre = referenceEventSummaryEntries(synthese({ supplierNames: ['A', 'B', 'C', 'D'] })).at(-1);
    expect(quatre?.value).toBe('A, B, C et 1 autre');
    const six = referenceEventSummaryEntries(synthese({ supplierNames: ['A', 'B', 'C', 'D', 'E', 'F'] })).at(-1);
    expect(six?.value).toBe('A, B, C et 3 autres');
  });
});

describe('L114OK-U04 — note libre de l’utilisateur', () => {
  it('demande lue : texte normalisé comme celui d’un document (bords et fins de ligne, jamais le contenu)', () => {
    expect(parseReferenceEventNotes('  Chaudière   remplacée   \nle 2 avril ')).toEqual({ ok: true, notes: 'Chaudière   remplacée\nle 2 avril' });
    for (const v of ['', '   ', null, undefined]) expect(parseReferenceEventNotes(v), String(v)).toEqual({ ok: true, notes: null });
  });
  it('refus : texte qui n’est pas un texte, texte trop long (borne du champ existant)', () => {
    expect(parseReferenceEventNotes(12).ok).toBe(false);
    expect(parseReferenceEventNotes({}).ok).toBe(false);
    expect(parseReferenceEventNotes('x'.repeat(NOTES_MAX_LENGTH)).ok).toBe(true);
    expect(parseReferenceEventNotes('x'.repeat(NOTES_MAX_LENGTH + 1))).toEqual({ ok: false, error: REFERENCE_EVENT_NOTES_LABELS.tooLong });
  });
  it('demande envoyée : la version lue par la page, et rien quand le texte n’a pas changé', () => {
    const courant = { notes: { text: 'Chaudière remplacée', updatedOn: '2024-04-03' }, version: 7 };
    expect(buildReferenceEventNotes(courant, 'Chaudière remplacée')).toEqual({ ok: false, error: REFERENCE_EVENT_NOTES_LABELS.unchanged });
    expect(buildReferenceEventNotes(courant, '  Chaudière remplacée  ')).toEqual({ ok: false, error: REFERENCE_EVENT_NOTES_LABELS.unchanged });
    expect(buildReferenceEventNotes(courant, 'Chaudière remplacée le 2 avril')).toEqual({ ok: true, body: { expectedVersion: 7, notes: 'Chaudière remplacée le 2 avril' } });
    // Vider le champ : retrait explicite.
    expect(buildReferenceEventNotes(courant, '   ')).toEqual({ ok: true, body: { expectedVersion: 7, notes: null } });
    // Aucune note, champ laissé vide : rien à enregistrer.
    expect(buildReferenceEventNotes({ notes: null, version: 2 }, '')).toEqual({ ok: false, error: REFERENCE_EVENT_NOTES_LABELS.unchanged });
    expect(buildReferenceEventNotes({ notes: null, version: 2 }, 'x'.repeat(NOTES_MAX_LENGTH + 1)).ok).toBe(false);
  });
});

describe('L114OK-U05 — rendu de la page (même composant ordinateur et mobile)', () => {
  it('« Synthèse » : chaque repère connu, et la phrase qui dit ce qui n’est pas compté', () => {
    const html = rendre(fiche());
    expect(html).toContain('data-testid="reference-event-page-summary"');
    expect(html).toContain(REFERENCE_EVENT_SUMMARY_LABELS.title);
    for (const k of ['spent', 'documents', 'period', 'agenda', 'suppliers']) {
      if (k === 'agenda') continue;
      expect(html, k).toContain(`data-summary-key="${k}"`);
    }
    expect(html).toContain('Du 10/01/2024 au 02/04/2024');
    expect(html).toContain(REFERENCE_EVENT_SUMMARY_LABELS.note);
  });
  it('rien de connu : aucune rubrique « Synthèse » (jamais un cadre vide)', () => {
    const html = rendre(fiche({ summary: { netCents: null, unconvertedCount: 0, documentCount: 0, agendaItemCount: 0, supplierNames: [], period: null } }));
    expect(html).not.toContain('data-testid="reference-event-page-summary"');
    // Appelant qui ne demande pas la synthèse : la page se rend quand même.
    expect(rendre(fiche({ summary: undefined }))).not.toContain('data-testid="reference-event-page-summary"');
  });
  it('la note est la PAROLE de l’utilisateur : affichée sous « Votre déclaration », avec sa date', () => {
    const html = rendre(fiche({
      declarations: [{ id: 1, text: 'Je fais remplacer la chaudière', declaredOn: '2024-03-01', channel: 'ASSISTANT', purpose: 'CREATE' }],
      notes: { text: 'Garantie 2 ans, contact Pierre', updatedOn: '2024-04-03' },
    }));
    const decl = html.indexOf('data-testid="reference-event-page-declarations"');
    const note = html.indexOf('data-testid="reference-event-page-notes"');
    expect(decl).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(decl);
    expect(html).toContain('Je fais remplacer la chaudière');
    expect(html).toContain('Garantie 2 ans, contact Pierre');
    expect(html).toContain('Modifié le 03/04/2024');
  });
  it('sans note et sans geste possible (lecture seule, aperçu) : aucune rubrique de note', () => {
    const html = rendre(fiche({ declarations: [], notes: null }));
    expect(html).not.toContain('data-testid="reference-event-page-notes"');
    expect(html).not.toContain('data-testid="reference-event-page-declarations"');
  });
  it('avec les gestes : « Ajouter une note » sans note, « Modifier » avec une note', () => {
    const sans = rendreAvecGestes(fiche({ notes: null }));
    expect(sans).toContain('data-testid="reference-event-action-notes"');
    expect(sans).toContain(REFERENCE_EVENT_NOTES_LABELS.add);
    expect(sans).toContain(REFERENCE_EVENT_NOTES_LABELS.empty);
    const avec = rendreAvecGestes(fiche({ notes: { text: 'Garantie 2 ans', updatedOn: null } }));
    expect(avec).toContain(REFERENCE_EVENT_NOTES_LABELS.edit);
    expect(avec).not.toContain(REFERENCE_EVENT_NOTES_LABELS.empty);
  });
  it('ni « événement de référence », ni onglet, ni tiroir, ni état ; cibles tactiles ; jetons de couleur seulement', () => {
    const html = rendreAvecGestes(fiche({ notes: { text: 'Garantie 2 ans', updatedOn: '2024-04-03' } }));
    expect(html).not.toMatch(/role="tab(list|panel)?"/);
    // Règle remplacée (carte #806) : « jamais "Opération" » — les textes NOUVEAUX de la carte #806 (liste fermée)
    // disent « opération » (décision du PO du 17/11/2026) ; les textes existants restent sous la garde d'origine.
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(sansTextes806(html)).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence|Statut|Envisagé|Annulé/i);
    expect(html).toContain('min-h-[44px]');
    for (const p of ['src/components/reference-events/ReferenceEventPageContent.tsx', 'src/lib/reference-events/reference-event-summary.ts']) {
      const code = visible(lire(p));
      expect(code, p).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|\b(?:text|bg|border)-(?:red|green|blue|gray|slate|amber|yellow|orange|emerald|zinc|neutral)-\d{2,3}\b/);
      expect(code, p).not.toMatch(/\buppercase\b|tracking-wide/);
      // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
      expect(code, p).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
    }
  });
});

describe('L114OK-U06 — gardes de code', () => {
  const service = lire('src/services/business-operations/graph/reference-event-page.ts');
  const pur = lire('src/lib/reference-events/reference-event-summary.ts');

  it('le MONTANT vient du moteur EXISTANT : aucun total recalculé dans la fiche, aucune règle de signe dupliquée', () => {
    const code = visible(service);
    expect(code).toContain("await import('../diagnostics/model')");
    expect(code).toContain('indicativeNetCents(comps)');
    // Ni signe, ni barème, ni conversion de devise écrits ici (c'est la règle du moteur).
    expect(visible(pur)).not.toMatch(/COMPONENT_SIGN|FORECAST_COST|REALIZED_COST|INDEMNITY|amount_eur|taux|rate/);
    expect(code).not.toMatch(/COMPONENT_SIGN\s*\[/);
  });
  it('AUCUN DOUBLE COMPTE : les nombres de la synthèse sont dédoublonnés, et aucun plafond ne les tronque', () => {
    expect(service).toContain('count(DISTINCT d.file_id)');
    expect(service).toContain('count(DISTINCT l.agenda_item_id)');
    // Le compte ne passe pas par la liste bornée à 200 de la lecture existante.
    expect(service).not.toMatch(/count\(DISTINCT[^)]*\)[^;]*LIMIT/);
  });
  it('lecture seule et bornée au compte : chaque requête porte le compte, aucune écriture, aucune IA', () => {
    const code = visible(service);
    const requetes = [...code.matchAll(/`((?:SELECT)[\s\S]*?)`/g)].map((m) => m[1]);
    expect(requetes.length).toBeGreaterThanOrEqual(5);
    for (const q of requetes) expect(q, q.slice(0, 80)).toMatch(/account_id\b/);
    expect(code).not.toMatch(/\b(INSERT INTO|DELETE FROM)\b|\bUPDATE business_operation/);
    expect(code).not.toMatch(/services\/ai\/|gateway|gemini|callModel/i);
  });
  it('le module des repères est PUR : aucune base, aucun serveur, aucune date du jour', () => {
    expect(pur).not.toMatch(/from '@\/db'|postgres|drizzle|next\/|process\.env/);
    expect(pur).not.toMatch(/new Date\(\)|Date\.now\(\)/);
  });
  it('la NOTE n’est écrite que par la façade, par une commande réservée à l’utilisateur', () => {
    const facade = lire('src/services/business-operations/operation-write.facade.ts');
    expect(facade).toContain('export function setOperationNotes(ctx: OperationWriteContext');
    const debut = facade.indexOf("'setOperationNotes', input, async");
    expect(facade.slice(debut, debut + 200)).toMatch(/ctx\.actor\.kind !== 'USER'\) return stop\(refused\('FORBIDDEN', 'USER_ONLY'\)\)/);
    // Aucun effet dérivé : la note ne crée ni composante, ni événement, ni rappel, ni source de protection.
    const corps = facade.slice(debut, facade.indexOf('export interface OperationTargetInput'));
    expect(corps).not.toMatch(/insertDeclaration|addSource|notification|agenda_items|financial/i);
    // La route est gardée, et elle appelle la commande.
    const route = lire('src/app/api/evenements-reference/[id]/notes/route.ts');
    expect(route).toContain('refuserSiLectureSeule(scope.accountId)');
    expect(route).toContain('setOperationNotes(scope.ctx');
    expect(route).not.toMatch(/\b(INSERT INTO|UPDATE |DELETE FROM)\b/);
  });
});
