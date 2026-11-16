/**
 * Lot 114O (Trello #744) — travaux D de la carte « Fiche et parcours » (CDC
 * « Opérations / Agenda V2.0 » §14, §15 ; AC01, AC22, AC41, AC56).
 *
 *   L114OD-U01  adresse stable de la page, sous l'Agenda ; identifiant validé
 *   L114OD-U02  titre : règle existante, puis « type — bien » (décision PO n° 2), puis déclaration fondatrice
 *   L114OD-U03  relations nommées dans les deux sens ; dates JJ/MM/AAAA, jamais fabriquées
 *   L114OD-U04  page (même composant desktop et mobile) : rubriques non vides seulement, « Sans date », liens,
 *               ni onglet, ni tiroir, ni état, ni « Opération », jetons de couleur seulement
 *   L114OD-U05  suggestions : catégorie propre, page entière (aucun tiroir), adresse validée, jamais masquée par le plafond
 *   L114OD-U06  moteur de recherche : champs autorisés ; déclaration et prestataire suffisent, le bien seul non
 *   L114OD-U07  gardes de code : route en lecture seule bornée au compte, liens existants vers la page, protection de session
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  REFERENCE_EVENT_PAGE_LABELS, REFERENCE_EVENT_ROUTE, REFERENCE_EVENT_SEARCH_CATEGORY, referenceEventDay, referenceEventHref,
  referenceEventIdFromParam, referenceEventPageTitle, referenceEventRelationLabel,
} from '../reference-event-page';
import { LIVE_MAX_RESULTS, liveSubtitle, toLiveResults } from '@/lib/verebona/live-search';
import { SEARCH_FIELDS, parseSearchQuery, runSearchPipeline, type SearchCandidate } from '@/lib/search/match-engine';
import type { ReferenceEventPageView } from '@/services/business-operations/graph/reference-event-page';

(globalThis as { React?: typeof React }).React = React;
const { ReferenceEventPageContent } = await import('@/components/reference-events/ReferenceEventPageContent');

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n?/g, '\n');
/** Code seulement (commentaires et imports retirés). */
const visible = (s: string) => s.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*|import )/.test(l)).map((l) => l.replace(/\{\/\*.*?\*\/\}/g, '')).join('\n');

const fiche = (over: Partial<ReferenceEventPageView> = {}): ReferenceEventPageView => ({
  id: 42, redirectedFrom: null, version: 3, title: 'Achat — Achat de la maison', ownLabel: 'Achat de la maison', typeCode: 'ACQUISITION', provider: 'Étude Dupont',
  dates: [{ role: 'REALIZED', date: '2021-03-15' }], undated: false,
  declarations: [{ id: 1, text: 'Nous avons signé chez le notaire', declaredOn: '2021-03-16', channel: 'ASSISTANT', purpose: 'CREATE' }],
  assets: [{ id: 7, name: 'Maison de Lyon' }],
  equipments: [{ id: 9, name: 'Chaudière', assetId: 7, assetName: 'Maison de Lyon' }],
  suppliers: [{ id: 5, name: 'Étude Dupont' }],
  coverages: [],
  documents: [{ fileId: 11, title: 'Acte de vente', date: '2021-03-15' }],
  agendaItems: [
    { id: 21, title: 'Signature chez le notaire', date: '2021-03-15', shared: false },
    { id: 22, title: 'Fin du prêt', date: '2041-03-15', shared: true },
    { id: 23, title: 'Remise des clés', date: null, shared: false },
  ],
  relations: [{ operationId: 43, label: 'Financement — Prêt immobilier', nature: 'FINANCING', direction: 'INCOMING' }],
  ...over,
});
const openers = { openDocument: () => undefined, openAgendaItem: () => undefined, openEquipment: () => undefined, onPeriodsSaved: () => undefined };
const rendre = (f: ReferenceEventPageView) => renderToStaticMarkup(h(ReferenceEventPageContent, { fiche: f, openers }));

describe('L114OD-U01 — adresse stable de la page', () => {
  it('sous l’Agenda (aucune rubrique nouvelle), identifiant numérique seulement', () => {
    expect(REFERENCE_EVENT_ROUTE).toBe('/agenda/evenements-reference');
    expect(referenceEventHref(42)).toBe('/agenda/evenements-reference/42');
    expect(referenceEventIdFromParam('42')).toBe(42);
    for (const v of ['', '0', '-1', '4.2', 'abc', '42abc', '1'.repeat(16), undefined, null, 42]) expect(referenceEventIdFromParam(v)).toBeNull();
  });
  it('la page existe à cette adresse et n’ajoute aucune entrée de menu', () => {
    expect(lire('src/app/(dashboard)/agenda/evenements-reference/[id]/page.tsx')).toContain('export default function ReferenceEventPage()');
    expect(lire('src/lib/verebona/live-search.ts')).not.toMatch(/nav-evenements|href: '\/agenda\/evenements-reference'/);
  });
});

describe('L114OD-U02 — titre de la page et du résultat de recherche', () => {
  const base = { typeCode: 'INTERVENTION', assetNames: [] as string[], declaration: null as string | null };
  it('la règle existante prime quand elle porte déjà un complément', () => {
    expect(referenceEventPageTitle({ ...base, baseLabel: 'Intervention — DPE', hasComplement: true, assetNames: ['Maison'], declaration: 'x' })).toBe('Intervention — DPE');
  });
  it('sans complément : « type — bien » (décision PO n° 2), premier bien non vide', () => {
    expect(referenceEventPageTitle({ ...base, baseLabel: 'Intervention', hasComplement: false, assetNames: ['  ', 'Maison de Lyon', 'Garage'] })).toBe('Intervention — Maison de Lyon');
  });
  it('sans bien : début de la déclaration fondatrice ; sans type : la déclaration seule (jamais « Dépense »)', () => {
    expect(referenceEventPageTitle({ ...base, baseLabel: 'Intervention', hasComplement: false, declaration: '  Remplacer   la chaudière ' })).toBe('Intervention — Remplacer la chaudière');
    expect(referenceEventPageTitle({ baseLabel: 'Dépense', hasComplement: false, typeCode: null, assetNames: [], declaration: 'Remplacer la chaudière' })).toBe('Remplacer la chaudière');
    expect(referenceEventPageTitle({ baseLabel: 'Dépense', hasComplement: false, typeCode: null, assetNames: [], declaration: 'x'.repeat(200) })).toHaveLength(80);
  });
  it('rien d’autre : le type seul, rien n’est inventé', () => {
    expect(referenceEventPageTitle({ ...base, baseLabel: 'Intervention', hasComplement: false })).toBe('Intervention');
  });
});

describe('L114OD-U03 — relations et dates', () => {
  it('une relation est nommée dans les deux sens', () => {
    expect(referenceEventRelationLabel('FINANCING', 'OUTGOING')).toBe('Finance');
    expect(referenceEventRelationLabel('FINANCING', 'INCOMING')).toBe('Financé par');
    expect(referenceEventRelationLabel('CLAIM_REPAIR', 'OUTGOING')).toBe('Réparé par');
    expect(referenceEventRelationLabel('CLAIM_REPAIR', 'INCOMING')).toBe('Répare le sinistre');
    expect(referenceEventRelationLabel('ASSOCIATED', 'UNDIRECTED')).toBe('Associé à');
    expect(referenceEventRelationLabel('CLAIM_CONTRACT', 'OUTGOING')).toBe('Contrat d’assurance');
    expect(referenceEventRelationLabel('CLAIM_CONTRACT', 'INCOMING')).toBe('Sinistre déclaré');
  });
  it('date JJ/MM/AAAA ; valeur absente ou illisible : null (aucune date fabriquée)', () => {
    expect(referenceEventDay('2041-03-15')).toBe('15/03/2041');
    expect(referenceEventDay('2041-03-15T00:00:00Z')).toBe('15/03/2041');
    for (const v of [null, undefined, '', '15/03/2041', 'demain']) expect(referenceEventDay(v)).toBeNull();
  });
});

describe('L114OD-U04 — page entière (même composant desktop et mobile)', () => {
  it('fiche complète : titre, dates qualifiées, rubriques, liens, événements à leur date', () => {
    const html = rendre(fiche());
    expect(html).toContain('data-testid="reference-event-page"');
    expect(html).toMatch(/<h1[^>]*data-testid="reference-event-page-title"[^>]*>Achat — Achat de la maison<\/h1>/);
    expect(html).toContain('Événement de référence');
    expect(html).toMatch(/Réalisé le<\/dt><dd[^>]*>15\/03\/2021<\/dd>/);
    expect(html).not.toContain('data-testid="reference-event-page-undated"');
    for (const id of ['declarations', 'assets', 'equipments', 'suppliers', 'documents', 'events', 'relations']) expect(html, id).toContain(`data-testid="reference-event-page-${id}"`);
    expect(html).toContain('Nous avons signé chez le notaire');
    expect(html).toContain('Déclaré le 16/03/2021');
    expect(html).toContain('href="/assets/7"');
    expect(html).toContain('href="/fournisseurs/5"');
    expect(html).toContain('href="/agenda/evenements-reference/43"');
    expect(html).toContain('Financé par');
    // Chaque événement à SA date ; sans date : « Sans date » ; partagé : signalé.
    expect(html).toMatch(/Fin du prêt.*Partagé avec un autre événement de référence.*15\/03\/2041/);
    expect(html).toMatch(/Remise des clés.*Sans date/);
    // Aucune couverture pour un achat : aucune rubrique artificielle.
    expect(html).not.toContain('data-testid="reference-event-page-coverages"');
    expect(html).not.toContain('data-testid="reference-event-page-empty"');
  });
  it('sans date, sans bien, sans document, sans événement : consultable, « Sans date », aucune date inventée', () => {
    const html = rendre(fiche({
      title: 'Remplacer la chaudière', ownLabel: null, typeCode: null, provider: null, dates: [], undated: true,
      declarations: [{ id: 1, text: 'Remplacer la chaudière', declaredOn: null, channel: 'ASSISTANT', purpose: 'CREATE' }],
      assets: [], equipments: [], suppliers: [], documents: [], agendaItems: [], relations: [],
    }));
    expect(html).toMatch(/data-testid="reference-event-page-undated"[^>]*>Sans date</);
    expect(html).not.toContain('data-testid="reference-event-page-dates"');
    expect(html).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(html).toContain('data-testid="reference-event-page-declarations"');
    for (const id of ['assets', 'equipments', 'suppliers', 'documents', 'events', 'relations', 'coverages']) expect(html, id).not.toContain(`data-testid="reference-event-page-${id}"`);
  });
  it('rien du tout : message d’état vide ; contrat sans couverture : texte existant', () => {
    const vide = rendre(fiche({ declarations: [], assets: [], equipments: [], suppliers: [], documents: [], agendaItems: [], relations: [], dates: [], undated: true, provider: null }));
    expect(vide).toContain(REFERENCE_EVENT_PAGE_LABELS.empty);
    const contrat = rendre(fiche({ typeCode: 'CONTRACT' }));
    expect(contrat).toContain('data-testid="coverage-history-empty"');
  });
  it('ni onglet, ni tiroir, ni état, ni « Opération » ; cibles tactiles ; charte (jetons seulement, pas de petites capitales)', () => {
    const html = rendre(fiche());
    expect(html).not.toMatch(/role="tab(list|panel)?"|role="dialog"/);
    expect(html).not.toMatch(/Opération|En cours|Expiré|Envisagé|Annulé|Terminé|Statut/i);
    expect(html).toContain('min-h-[44px]');
    for (const p of ['src/components/reference-events/ReferenceEventPageContent.tsx', 'src/app/(dashboard)/agenda/evenements-reference/[id]/page.tsx', 'src/lib/reference-events/reference-event-page.ts']) {
      const code = visible(lire(p));
      expect(code, p).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|\b(?:text|bg|border)-(?:red|green|blue|gray|slate|amber|yellow|orange|emerald|zinc|neutral)-\d{2,3}\b/);
      expect(code, p).not.toMatch(/\buppercase\b/);
      expect(code, p).not.toMatch(/Opération/);
      expect(code, p).not.toMatch(/<Sheet\b|<Tabs\b|<Drawer\b/);
    }
  });
});

describe('L114OD-U05 — suggestions de la recherche', () => {
  const row = (id: number, over: Record<string, unknown> = {}) => ({
    id: `reference-event-${id}`, category: REFERENCE_EVENT_SEARCH_CATEGORY, label: `Contrat — Assurance ${id}`, sublabel: 'Sans date', href: referenceEventHref(id), ...over,
  });
  it('catégorie propre, page entière, aucun tiroir', () => {
    const [r] = toLiveResults('assurance', [row(4)]);
    expect(r).toEqual({ id: 'reference-event-4', kind: 'reference_event', title: 'Contrat — Assurance 4', sub: 'Sans date', href: '/agenda/evenements-reference/4' });
    expect(liveSubtitle(r)).toBe('Événement de référence · Sans date');
  });
  it('une adresse qui n’est pas celle d’une page d’événement de référence est écartée', () => {
    for (const href of ['https://ailleurs.example/agenda/evenements-reference/4', '/agenda/evenements-reference/4/../../admin', '/agenda/evenements-reference/abc', '/assets/4']) {
      expect(toLiveResults('assurance', [row(4, { href })]), href).toEqual([]);
    }
  });
  it('le plafond ne masque jamais toute la catégorie : le premier événement de référence prend la dernière place', () => {
    const docs = Array.from({ length: 8 }, (_, i) => ({ id: `doc-${i}`, category: 'Document', label: `Assurance ${i}`, href: `/documents?tiroir=document:${i}` }));
    const out = toLiveResults('assurance', [...docs, row(4), row(5)]);
    expect(out).toHaveLength(LIVE_MAX_RESULTS);
    expect(out.filter((r) => r.kind === 'reference_event').map((r) => r.id)).toEqual(['reference-event-4']);
    expect(out[LIVE_MAX_RESULTS - 1].id).toBe('reference-event-4');
    // Sans événement de référence : comportement inchangé.
    expect(toLiveResults('assurance', docs).map((r) => r.id)).toEqual(docs.slice(0, LIVE_MAX_RESULTS).map((d) => d.id));
  });
});

describe('L114OD-U06 — moteur de recherche : champs autorisés d’un événement de référence', () => {
  const politique = { requireAllTokens: true, allowSemantic: false };
  const candidat = (fields: SearchCandidate['fields'], displayName = 'Remplacer la chaudière'): SearchCandidate =>
    ({ entityType: 'reference_event', entityId: 1, displayName, fields, retrievalStrategy: 'sql.token_like' });
  const cherche = (q: string, c: SearchCandidate) => runSearchPipeline(parseSearchQuery(q), [c], politique).results;
  it('champs déclarés : titre, référence, prestataire, fournisseur, déclaration ; le bien n’est qu’une relation', () => {
    expect(SEARCH_FIELDS.reference_event.map((f) => [f.field, f.kind])).toEqual([
      ['title', 'name'], ['reference', 'identifier'], ['provider', 'text'], ['supplierNames', 'text'], ['declaration', 'text'], ['assetNames', 'relation'],
    ]);
    expect(SEARCH_FIELDS.reference_event.find((f) => f.field === 'assetNames')?.relationEligible).toBeUndefined();
  });
  it('la déclaration suffit (événement de référence sans bien, sans document, sans événement)', () => {
    const r = cherche('chaudière', candidat({ title: 'Intervention', declaration: ['Je vais faire remplacer la chaudière'] }, 'Intervention'));
    expect(r).toHaveLength(1);
    expect(r[0].matchedField).toBe('declaration');
  });
  it('prestataire : trouvé ; bien concerné seul : écarté ; tous les mots exigés', () => {
    expect(cherche('atlantique', candidat({ title: 'Contrat — Assurance', provider: 'Mutuelle Atlantique' }, 'Contrat — Assurance'))).toHaveLength(1);
    expect(cherche('nantes', candidat({ title: 'Contrat — Assurance', assetNames: ['Appartement Nantes'] }, 'Contrat — Assurance'))).toEqual([]);
    expect(cherche('assurance automobile', candidat({ title: 'Contrat — Assurance habitation' }, 'Contrat — Assurance habitation'))).toEqual([]);
  });
});

describe('L114OD-U07 — gardes de code', () => {
  it('route de la page : lecture seule, compte de la session, 404 hors compte', () => {
    const route = lire('src/app/api/evenements-reference/[id]/fiche/route.ts');
    expect(route).toContain('export async function GET(');
    expect(route).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)\b/);
    expect(route).toContain('readReferenceEventPage(session.currentAccountId, operationId)');
    expect(route).toContain("apiError(404, 'NOT_FOUND'");
    expect(route).not.toMatch(/accountId\s*=\s*(req|params|url)/);
  });
  it('lecteur : chaque requête est bornée au compte ; aucune écriture', () => {
    const svc = lire('src/services/business-operations/graph/reference-event-page.ts');
    const requetes = svc.split('sql.unsafe(').slice(1).map((b) => b.slice(0, b.indexOf('params')));
    expect(requetes.length).toBeGreaterThanOrEqual(5);
    for (const r of requetes) expect(r).toMatch(/account_id = \$1/);
    expect(svc).not.toMatch(/\b(INSERT INTO|UPDATE [a-z_]+ SET|DELETE FROM)\b/);
    for (const sous of ['assetNames', 'supplierNames', 'declarations', 'foundingDeclaration', 'references', 'firstDocument']) {
      const bloc = svc.slice(svc.indexOf(`  ${sous}: \``));
      expect(bloc.slice(0, bloc.indexOf('`,')), sous).toMatch(/account_id = \$1/);
    }
  });
  it('recherche : événements de référence actifs du compte, panne isolée des autres catégories', () => {
    const svc = lire('src/services/search/global-search.service.ts');
    expect(svc).toContain('WHERE o.account_id = ${acc} AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL');
    expect(svc).toContain('referenceEventCandidatesSafe(accountId, q, mode)');
    expect(svc).toContain('href: referenceEventHref(id)');
  });
  it('liens existants « Voir l’événement de référence » : vers la page, tiroirs fermés au départ', () => {
    const liens = lire('src/components/documents/ReferenceEventSheet.tsx');
    expect(liens).toContain('const href = referenceEventHref(operationId);');
    expect(liens).toContain('window.dispatchEvent(new CustomEvent(CLOSE_ALL_DRAWERS_EVENT));');
    expect(liens).toContain('export const REFERENCE_EVENT_OPEN_LABEL = "Voir l’événement de référence";');
    expect(visible(liens)).not.toMatch(/<Sheet\b/);
    expect(lire('src/components/agenda/AgendaGroupingSection.tsx')).toContain('<ReferenceEventLink key={e.id} operationId={e.id} label={e.label} />');
    expect(lire('src/components/assets/TcoSection.tsx')).toContain('<ReferenceEventLink operationId={l.operationId} />');
  });
  it('la page hérite de la protection de session des pages de l’Agenda', () => {
    const mw = lire('src/middleware.ts');
    expect(mw).toContain("'/agenda/:path*'");
    expect(mw).toMatch(/'\/agenda',[\s\S]*pathname\.startsWith\(route \+ '\/'\)/);
  });
});
