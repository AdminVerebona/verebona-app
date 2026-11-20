/**
 * Carte Trello #806, volet B §8 — LISTE DES OPÉRATIONS : demande, recherche, tri, pagination, rendu (même composant
 * ordinateur et mobile).
 *
 *   L116CB-L01  lecture de la demande : valeurs inconnues → défaut, bornes, adresse sans valeurs par défaut
 *   L116CB-L02  recherche : tous les mots, sans accent ni casse, sur tout ce que la ligne nomme
 *   L116CB-L03  tri : ordre total et stable ; sans date et sans montant en fin de liste, jamais une date inventée
 *   L116CB-L04  pagination : aucune ligne perdue ni répétée ; page hors borne ramenée à la dernière
 *   L116CB-L05  rendu : chaque ligne est un lien, tout est nommé, rien n'est coupé, aucun état interne ; filtres,
 *               tri, pages ; états vides ; charte et cibles tactiles
 *   L116CB-L06  page et route : sous l'Agenda, sans entrée de menu ; lecture seule ; compte de la session seulement
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  OPERATION_LIST_LABELS as L, OPERATION_LIST_PAGE_SIZE, OPERATION_LIST_ROUTE, compareOperationListItems, operationListHaystack, operationListMatches,
  operationListQueryOf, operationListSearchParams, paginateOperationList,
  type OperationListItem, type OperationListPage, type OperationListQuery,
} from '../operation-list';

(globalThis as { React?: typeof React }).React = React;
const { ReferenceEventListContent } = await import('@/components/reference-events/ReferenceEventList');

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n?/g, '\n');
const visible = (s: string) => s.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*|import )/.test(l)).map((l) => l.replace(/\{\/\*.*?\*\/\}/g, '')).join('\n');
const params = (s: string) => new URLSearchParams(s);
const item = (id: number, over: Partial<OperationListItem> = {}): OperationListItem => ({
  id, title: `Intervention — Lot ${id}`, typeCode: 'INTERVENTION', typeLabel: 'Intervention', date: '2025-04-02', assets: [{ id: 7, name: 'Maison de Lyon' }],
  rooms: [], equipments: [], suppliers: [], provider: null, documentCount: 1, agendaItemCount: 0, contracts: [], netCents: 12000, unconvertedCount: 0, ...over,
});
const base: OperationListQuery = { q: '', type: null, assetId: null, state: 'ALL', sort: 'DATE_DESC', page: 1, pageSize: OPERATION_LIST_PAGE_SIZE };
const page = (items: OperationListItem[], over: Partial<OperationListPage> = {}): OperationListPage => ({
  items, total: items.length, totalAll: items.length, page: 1, pageSize: OPERATION_LIST_PAGE_SIZE, pages: 1, query: base,
  types: [{ code: 'INTERVENTION', label: 'Intervention' }, { code: 'CONTRACT', label: 'Contrat' }], assets: [{ id: 7, name: 'Maison de Lyon' }], ...over,
});
const rendre = (d: OperationListPage) => renderToStaticMarkup(h(ReferenceEventListContent, { data: d, onQuery: () => undefined }));

describe('L116CB-L01 — lecture de la demande', () => {
  it('défauts, bornes, valeurs inconnues écartées', () => {
    expect(operationListQueryOf(params(''))).toEqual(base);
    expect(operationListQueryOf(params('q=%20toiture%20%20zinc%20&type=contract&bien=12&etat=UNDATED&tri=TITLE&page=3&taille=500')))
      .toEqual({ q: 'toiture zinc', type: 'CONTRACT', assetId: 12, state: 'UNDATED', sort: 'TITLE', page: 3, pageSize: 100 });
    expect(operationListQueryOf(params('type=%3Bdrop&bien=-4&etat=EN_COURS&tri=prix&page=0&taille=abc'))).toEqual(base);
    expect(operationListQueryOf(params(`q=${'x'.repeat(300)}`)).q).toHaveLength(120);
  });
  it('adresse : seules les valeurs qui diffèrent du défaut y figurent ; aller-retour sans perte', () => {
    expect(operationListSearchParams(base)).toBe('');
    const q: OperationListQuery = { q: 'prêt', type: 'NONE', assetId: 4, state: 'NO_DOCUMENT', sort: 'AMOUNT_DESC', page: 2, pageSize: 50 };
    expect(operationListQueryOf(params(operationListSearchParams(q)))).toEqual(q);
  });
});

describe('L116CB-L02 — recherche', () => {
  const i = item(1, { title: 'Sinistre — Dégât des eaux', typeCode: 'CLAIM', typeLabel: 'Sinistre', rooms: ['Cuisine'], equipments: ['Chaudière Frisquet'], suppliers: ['Plâtrerie Morel'], contracts: [{ id: 9, label: 'Contrat — Assurance habitation' }] });
  const texte = operationListHaystack(i, ['Facture du plafond', 'SIN-806']);
  it('tous les mots, sans accent ni casse, sur l’intitulé, le type, le bien, la pièce, l’équipement, le fournisseur, le contrat, le justificatif, la référence', () => {
    for (const q of ['degat EAUX', 'sinistre', 'lyon', 'cuisine', 'frisquet', 'platrerie', 'assurance habitation', 'facture plafond', 'sin-806', '']) expect(operationListMatches(texte, q), q).toBe(true);
    for (const q of ['toiture', 'degat toiture', 'morel bordeaux']) expect(operationListMatches(texte, q), q).toBe(false);
  });
  it('une opération sans type se trouve par « type non précisé » ; les champs ne se mélangent pas', () => {
    expect(operationListMatches(operationListHaystack(item(2, { typeCode: null, typeLabel: null })), 'non précisé')).toBe(true);
    // « Lyon Cuisine » : deux champs voisins ne forment pas un mot à cheval.
    expect(operationListMatches(operationListHaystack(item(3, { assets: [{ id: 1, name: 'Mai' }], rooms: ['son'] })), 'maison')).toBe(false);
  });
});

describe('L116CB-L03 — tri', () => {
  const a = item(1, { date: '2025-04-02', title: 'Écluse', netCents: 500 });
  const b = item(2, { date: null, title: 'abri', netCents: null });
  const c = item(3, { date: '2026-01-10', title: 'Zinc', netCents: 90000 });
  const d = item(4, { date: '2025-04-02', title: 'Écluse', netCents: 500 });
  const ordre = (s: Parameters<typeof compareOperationListItems>[0]) => [a, b, c, d].sort(compareOperationListItems(s)).map((x) => x.id);
  it('par date : la plus récente ou la plus ancienne d’abord, les « sans date » toujours en fin ; égalité départagée', () => {
    expect(ordre('DATE_DESC')).toEqual([3, 4, 1, 2]);
    expect(ordre('DATE_ASC')).toEqual([4, 1, 3, 2]);
  });
  it('par intitulé (sans accent ni casse) et par montant (sans montant en fin)', () => {
    expect(ordre('TITLE')).toEqual([2, 4, 1, 3]);
    expect(ordre('AMOUNT_DESC')).toEqual([3, 4, 1, 2]);
  });
  it('ordre total : le même quel que soit l’ordre de départ', () => {
    for (const s of ['DATE_DESC', 'DATE_ASC', 'TITLE', 'AMOUNT_DESC'] as const) {
      expect([d, c, b, a].sort(compareOperationListItems(s)).map((x) => x.id)).toEqual(ordre(s));
    }
  });
});

describe('L116CB-L04 — pagination', () => {
  it('aucune ligne perdue ni répétée ; page hors borne ramenée à la dernière ; liste vide : une page', () => {
    const tout = Array.from({ length: 53 }, (_, i) => i + 1);
    const vus: number[] = [];
    for (let p = 1; p <= 3; p++) vus.push(...paginateOperationList(tout, p, 25).items);
    expect(vus).toEqual(tout);
    expect(paginateOperationList(tout, 99, 25)).toMatchObject({ page: 3, pages: 3 });
    expect(paginateOperationList(tout, 99, 25).items).toHaveLength(3);
    expect(paginateOperationList([], 4, 25)).toEqual({ items: [], page: 1, pages: 1 });
  });
});

describe('L116CB-L05 — rendu de la liste (même composant ordinateur et mobile)', () => {
  const riche = item(5, {
    title: 'Sinistre — Dégât des eaux dans la cuisine et la salle de bain du premier étage, côté jardin', typeCode: 'CLAIM', typeLabel: 'Sinistre', date: '2025-04-02',
    rooms: ['Cuisine', 'Salle de bain'], equipments: ['Chaudière'], suppliers: ['Plâtrerie Morel'], documentCount: 3, agendaItemCount: 2,
    contracts: [{ id: 9, label: 'Contrat — Assurance habitation' }], netCents: 198000, unconvertedCount: 1,
  });
  const html = rendre(page([riche, item(6, { typeCode: null, typeLabel: null, date: null, assets: [], documentCount: 0, netCents: null, provider: 'Garage Martin' })], { total: 2, totalAll: 40 }));
  it('chaque ligne : lien vers la fiche, type, date, biens cliquables, pièces, équipements, fournisseurs, contrat cliquable, montant', () => {
    expect(html).toContain('href="/agenda/evenements-reference/5"');
    expect(html).toContain('aria-label="Ouvrir l’opération : Sinistre — Dégât des eaux dans la cuisine et la salle de bain du premier étage, côté jardin"');
    expect(html).toMatch(/data-testid="operation-list-meta-5"[^>]*>Sinistre · 02\/04\/2025 · 3 justificatifs · 2 événements/);
    expect(html).toContain('href="/assets/7"');
    expect(html).toMatch(/Pièces<\/dt><dd[^>]*>Cuisine, Salle de bain/);
    expect(html).toMatch(/Équipements<\/dt><dd[^>]*>Chaudière/);
    expect(html).toMatch(/Fournisseurs<\/dt><dd[^>]*>Plâtrerie Morel/);
    expect(html).toContain('href="/agenda/evenements-reference/9"');
    expect(html).toMatch(/data-testid="operation-list-amount-5"[\s\S]*?1[\s  ]980,00[\s  ]€/);
    expect(html).toContain('1 montant dans une autre devise, non compté');
  });
  it('sans type, sans date, sans bien, sans justificatif, sans montant : dit tel quel, rien d’inventé', () => {
    expect(html).toMatch(/data-testid="operation-list-meta-6"[^>]*>Type non précisé · Sans date · Aucun justificatif · Aucun événement/);
    expect(html).not.toContain('data-testid="operation-list-amount-6"');
    expect(html).toMatch(/data-testid="operation-list-item-6"[\s\S]*?Fournisseurs<\/dt><dd[^>]*>Garage Martin/);
  });
  it('compte, filtres, tri : le total filtré et le total du compte sont dits ; aucun état interne proposé', () => {
    expect(html).toMatch(/data-testid="operation-list-count"[^>]*>2 opérations sur 40/);
    for (const id of ['search', 'type', 'asset', 'state', 'sort']) expect(html, id).toContain(`data-testid="operation-list-${id}"`);
    expect(html).toContain('<option value="NONE">Type non précisé</option>');
    for (const t of ['Avec une date', 'Sans date', 'Sans justificatif', 'Intitulé', 'Montant, le plus élevé d’abord']) expect(html, t).toContain(t);
    expect(html).not.toMatch(/Envisagé|Réalisé|Annulé|En cours|Terminé|Statut/);
    expect(JSON.stringify(L)).not.toMatch(/Envisagé|Réalisé\b|Annulé|En cours|Terminé|Statut|événement de référence/i);
  });
  it('pages : précédente / suivante, page courante ; une seule page : aucune navigation', () => {
    const p2 = rendre(page([item(1)], { total: 60, totalAll: 60, page: 2, pages: 3, query: { ...base, page: 2 } }));
    expect(p2).toMatch(/data-testid="operation-list-page"[^>]*>Page 2 sur 3/);
    expect(p2).toContain('data-testid="operation-list-previous"');
    expect(p2).toContain('data-testid="operation-list-next"');
    expect(html).not.toContain('data-testid="operation-list-pages"');
  });
  it('états vides : compte sans opération, ou aucun résultat pour la recherche (avec « Réinitialiser »)', () => {
    expect(rendre(page([], { total: 0, totalAll: 0 }))).toContain(L.empty);
    const filtre = rendre(page([], { total: 0, totalAll: 12, query: { ...base, q: 'xyz' } }));
    expect(filtre).toContain(L.emptyFiltered);
    expect(filtre).toContain('data-testid="operation-list-reset"');
    expect(rendre(page([item(1)]))).not.toContain('data-testid="operation-list-reset"');
  });
  it('charte Sérénité, cibles tactiles, aucun titre coupé', () => {
    for (const p of ['src/components/reference-events/ReferenceEventList.tsx', 'src/app/(dashboard)/agenda/evenements-reference/page.tsx', 'src/lib/reference-events/operation-list.ts']) {
      const code = visible(lire(p));
      expect(code, p).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|\b(?:text|bg|border)-(?:red|green|blue|gray|slate|amber|yellow|orange|emerald|zinc|neutral)-\d{2,3}\b/);
      expect(code, p).not.toMatch(/\buppercase\b|\btruncate\b|line-clamp/);
    }
    expect(html).toContain('min-h-[44px]');
    expect(html).toMatch(/h-11[^"]*md:h-9/);
  });
});

describe('L116CB-L06 — page et route', () => {
  it('sous l’Agenda, sans entrée de menu ; atteinte depuis la fiche', () => {
    expect(OPERATION_LIST_ROUTE).toBe('/agenda/evenements-reference');
    for (const menu of ['src/components/shell/AppSidebar.tsx', 'src/components/mobile/bottom-navigation.tsx']) expect(lire(menu), menu).not.toContain('evenements-reference');
    expect(lire('src/components/reference-events/ReferenceEventPageContent.tsx')).toContain('href={OPERATION_NAV_ROUTES.operations}');
    expect(lire('src/middleware.ts')).toContain("'/agenda/:path*'");
  });
  it('route : lecture seule, compte actif de la session, aucune écriture', () => {
    const route = lire('src/app/api/evenements-reference/route.ts');
    expect(route).toMatch(/export async function GET/);
    expect(route).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
    expect(route).toContain('readOperationList(Number(session.currentAccountId), operationListQueryOf(req.nextUrl.searchParams))');
    const lecture = visible(lire('src/services/business-operations/graph/reference-event-list.ts'));
    expect(lecture).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(lecture).not.toMatch(/LIMIT\s+\d/);
    expect(lecture).toContain('o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL');
  });
});
