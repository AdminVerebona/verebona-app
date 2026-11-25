/**
 * Carte #863 (P1-B1, AC08/AC13) — conservation du LITTÉRAL et PREUVE d'une
 * absence. Règle pure (`raw-value-absence.ts`) et chemin ACTIF d'écriture
 * (`insertFactRows`, avant toute persistance T1 — faits génériques, hors
 * catalogue, reprises et chemins sans donnée canonique compris). L'écriture et
 * la relecture en base réelle (et le rapport BO) sont prouvées par
 * `src/test/e2e/scenarios/c863-gateway-fencing-couts-alertes.e2e.ts`.
 *
 * Fixtures SYNTHÉTIQUES ; aucun appel fournisseur.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ calls: [] as Array<{ sql: string; params: unknown[] }>, unites: [] as Array<{ source_unit_id: string; texte: string }> }));
vi.mock('@/db', () => {
  const unsafe = vi.fn(async (sql: string, params: unknown[] = []) => {
    db.calls.push({ sql, params });
    if (sql.includes('information_schema.columns')) return [{ n: (params[1] as string[]).length }];
    if (sql.includes('FROM document_source_units')) return db.unites;
    if (sql.includes('INSERT INTO document_facts')) return [{ id: db.calls.length }];
    return [];
  });
  return { db: {}, pgClient: { unsafe, begin: async (fn: (tx: { unsafe: typeof unsafe }) => Promise<void>) => fn({ unsafe }) } };
});

import {
  checkRawValueAbsence, literalOccurrences, literalCoverageOf, describesReadableText, provesIllegibleZone, parseLiteralNumber,
  readRawValueAbsence, RAW_LITERAL_MAX,
} from '../master/raw-value-absence';
import { insertFactRows } from '../../knowledge/document-knowledge.service';
import { __resetCanonicalColumnsForTests } from '../../evidence/canonical-columns';
import type { DocumentFactRecord } from '../../knowledge/document-knowledge';

const E = { accountId: 1, fileId: 55, sourceType: 'asset_file' as const, provider: 'fake', model: 'm', promptVersion: 'v' };
const fait = (over: Partial<DocumentFactRecord> = {}): DocumentFactRecord => ({
  factKey: 'acquisitionPrice', subject: null, attribute: null, label: null, valueText: '1234.5', valueNumber: 1234.5, valueUnit: 'EUR',
  valueJson: 1234.5, normalizedValue: '1234.5', periodStart: null, periodEnd: null, confidence: 'certain', excerpt: 'Total TTC : 1 234,50 €',
  location: { page: 1 }, evidenceOrigin: 'TEXT_EXTRACTION', visualEvidence: null,
  canonicalKey: 'acquisitionPrice', rawKey: 'Total TTC', rawValue: null, valueType: 'money_eur', canonicalUnit: 'EUR', projectionOrigin: 'MODEL_CANONICAL',
  ...over,
});
const ecrits = () => db.calls.filter((c) => c.sql.includes('INSERT INTO document_facts'));
/** Valeur écrite pour une colonne (colonnes et VALUES appariées, paramètres `$n` résolus). `undefined` : colonne non écrite. */
const colonne = (i: number, nom: string): unknown => {
  const c = ecrits()[i];
  const cols = c.sql.slice(c.sql.indexOf('(') + 1, c.sql.indexOf(')')).split(',').map((x) => x.trim());
  const v = c.sql.slice(c.sql.indexOf('VALUES') + 6);
  const vals = v.slice(v.indexOf('(') + 1, v.lastIndexOf(')')).split(',').map((x) => x.trim());
  const k = cols.indexOf(nom);
  if (k < 0) return undefined;
  const m = /^\$(\d+)/.exec(vals[k] ?? '');
  return m ? c.params[Number(m[1]) - 1] : vals[k];
};

beforeEach(() => {
  db.calls = []; db.unites = [];
  __resetCanonicalColumnsForTests(null);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('C863-B1 — règle pure : correspondance vérifiable à la valeur du fait', () => {
  it('C863-B1-01 — montant : littéral EXACT récupéré (ponctuation, espaces, symbole), jamais la valeur normalisée', () => {
    expect(parseLiteralNumber('1 234,50')).toBe(1234.5);
    expect(parseLiteralNumber('1.234,50')).toBe(1234.5);
    expect(parseLiteralNumber('1,234.50')).toBe(1234.5);
    const r = checkRawValueAbsence(fait());
    expect(r).toEqual({ status: 'RECOVERED', code: null, rawValue: '1 234,50 €', from: 'EXCERPT' });
    // Valeur normalisée (1234.5) ≠ littéral : le littéral rendu est celui ÉCRIT.
    expect(r.status === 'RECOVERED' && r.rawValue).not.toBe('1234.5');
  });

  it('C863-B1-02 — citation HORS SUJET (« total TTC » sans le montant) : jamais LITERAL_IN_EXCERPT, absence NON justifiée', () => {
    expect(checkRawValueAbsence(fait({ excerpt: 'Total TTC : voir page 2' }))).toEqual({ status: 'UNJUSTIFIED', code: 'UNJUSTIFIED', rejected: null });
    expect(checkRawValueAbsence(fait({ excerpt: 'Total TTC : 1 243,50 €' })).status).toBe('UNJUSTIFIED');
    // Plusieurs écritures DIFFÉRENTES de la même valeur : littéral présent mais ambigu → motif, rien n'est choisi.
    expect(checkRawValueAbsence(fait({ excerpt: 'Total : 1 234,50 € (soit 1234.50 EUR)' }))).toEqual({ status: 'JUSTIFIED', code: 'LITERAL_IN_EXCERPT' });
  });

  it('C863-B1-03 — unité source : persistée ET portant la valeur — sinon refusée ; valeur longue conservée par référence', () => {
    const long = 'ballon thermodynamique 270 litres, '.repeat(70).trim();
    expect(long.length).toBeGreaterThan(RAW_LITERAL_MAX);
    const longFait = fait({ valueText: long, valueNumber: null, normalizedValue: long, valueType: 'text', excerpt: long.slice(0, 60).trim() });
    const textes = new Map([['u1', `Désignation : ${long}`], ['u2', 'Autre paragraphe sans rapport']]);
    expect(checkRawValueAbsence({ ...longFait, sourceUnitIds: ['u1'], sourceUnitTexts: textes })).toEqual({ status: 'JUSTIFIED', code: 'SOURCE_UNIT_REFERENCE' });
    // Unité qui ne porte PAS la valeur (mauvaise valeur) : refusée.
    expect(checkRawValueAbsence({ ...longFait, sourceUnitIds: ['u2'], sourceUnitTexts: textes }).status).toBe('UNJUSTIFIED');
    // Unité NON persistée (aucun texte connu) : refusée.
    expect(checkRawValueAbsence({ ...longFait, sourceUnitIds: ['u1'], sourceUnitTexts: null }).status).toBe('UNJUSTIFIED');
    // Littéral court absent de la citation mais présent UNE fois dans l'unité : récupéré exactement depuis l'unité.
    const court = fait({ excerpt: null, evidenceOrigin: 'TEXT_EXTRACTION', valueNumber: 78000, valueText: '78000', normalizedValue: '78000', valueType: 'quantity', canonicalUnit: 'km' });
    expect(checkRawValueAbsence({ ...court, sourceUnitIds: ['u3'], sourceUnitTexts: new Map([['u3', 'Kilométrage relevé : 78 000 km']]) }))
      .toEqual({ status: 'RECOVERED', code: null, rawValue: '78 000 km', from: 'SOURCE_UNIT' });
  });

  it('C863-B1-04 — booléen : « Oui » écrit = littéral (récupéré) ; présence sans mot écrit = NO_LITERAL ; jamais déduit du seul type', () => {
    const b = { valueType: 'boolean', valueText: 'true', valueNumber: null, normalizedValue: 'true' };
    expect(checkRawValueAbsence(fait({ ...b, excerpt: 'Raccordement au tout-à-l’égout : Oui' }))).toMatchObject({ status: 'RECOVERED', rawValue: 'Oui' });
    expect(checkRawValueAbsence(fait({ ...b, excerpt: 'Diagnostic amiante joint en annexe' }))).toEqual({ status: 'JUSTIFIED', code: 'NO_LITERAL' });
    // Booléen SANS aucune preuve : le type seul ne justifie rien.
    expect(checkRawValueAbsence({ valueType: 'boolean' }).status).toBe('UNJUSTIFIED');
    // Présence observée visuellement (case cochée, sans texte lu) : NO_LITERAL.
    expect(checkRawValueAbsence(fait({ ...b, excerpt: null, evidenceOrigin: 'VISUAL_ANALYSIS', visualEvidence: { description: 'case cochée en bas de page' } })).code).toBe('VISUAL_ONLY');
  });

  it('C863-B1-05 — visuel : étiquette LISIBLE ≠ observation sans texte (VISUAL_ONLY seulement sans texte lisible)', () => {
    const v = (description: string) => fait({ excerpt: null, evidenceOrigin: 'VISUAL_ANALYSIS', visualEvidence: { description }, valueText: 'Atlantic', valueNumber: null, normalizedValue: 'Atlantic', valueType: 'string' });
    expect(describesReadableText('étiquette lisible « Atlantic Calypso »')).toBe(true);
    expect(checkRawValueAbsence(v('étiquette lisible « Atlantic Calypso » sur le ballon')).status).toBe('UNJUSTIFIED');
    expect(checkRawValueAbsence(v('ballon d’eau chaude blanc fixé au mur'))).toEqual({ status: 'JUSTIFIED', code: 'VISUAL_ONLY' });
  });

  it('C863-B1-06 — ILLISIBLE : prouvé (description ET zone localisée) ou refusé ; jamais inventé', () => {
    const v = (visualEvidence: Record<string, unknown>) => fait({ excerpt: null, evidenceOrigin: 'VISUAL_ANALYSIS', visualEvidence: visualEvidence as never });
    expect(provesIllegibleZone({ description: 'numéro de série illisible', page: 2 })).toBe(true);
    expect(checkRawValueAbsence(v({ description: 'numéro de série illisible (reflet)', page: 2, region: { x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.2 } }))).toEqual({ status: 'JUSTIFIED', code: 'ILLEGIBLE' });
    // Non localisé : pas de preuve de ZONE.
    expect(checkRawValueAbsence(v({ description: 'numéro de série illisible' })).code).not.toBe('ILLEGIBLE');
    // Motif proposé par l'amont sans preuve : rejeté et tracé.
    expect(checkRawValueAbsence({ ...v({ description: 'plaque nette' }), rawValueAbsence: 'ILLEGIBLE' })).toMatchObject({ code: 'VISUAL_ONLY' });
  });

  it('C863-B1-07 — règle déterministe : origine ÉTABLIE (règle nommée) exigée', () => {
    expect(checkRawValueAbsence(fait({ excerpt: 'x', projectionOrigin: 'DETERMINISTIC_RULE', projectionRule: 'ACQ_PRICE_FROM_AMOUNT' }))).toEqual({ status: 'JUSTIFIED', code: 'DERIVED_BY_RULE' });
    expect(checkRawValueAbsence(fait({ excerpt: 'x', projectionOrigin: 'DETERMINISTIC_RULE', projectionRule: null })).code).not.toBe('DERIVED_BY_RULE');
  });

  it('C863-B1-08 — 0 et false sont des littéraux ; un 0 écrit est récupéré tel quel', () => {
    expect(checkRawValueAbsence({ rawValue: 0 }).status).toBe('LITERAL');
    expect(checkRawValueAbsence({ rawValue: false }).status).toBe('LITERAL');
    expect(checkRawValueAbsence(fait({ valueNumber: 0, valueText: '0', normalizedValue: '0', excerpt: 'Solde restant dû : 0,00 €' }))).toMatchObject({ status: 'RECOVERED', rawValue: '0,00 €' });
    expect(literalOccurrences('Échéance au 05/03/2026', { normalizedValue: '2026-03-05', valueType: 'date' })).toEqual(['05/03/2026']);
  });

  it('C863-B1-09 — lecture et couverture : jamais « complet » avec une absence non justifiée ou un fait antérieur sans motif', () => {
    expect(readRawValueAbsence({ rawValue: null, rawValueAbsence: null })).toBe('LEGACY_UNSPECIFIED');
    expect(literalCoverageOf([{ rawValue: '12 €' }, { rawValue: null, rawValueAbsence: 'VISUAL_ONLY' }]).status).toBe('COMPLETE');
    expect(literalCoverageOf([{ rawValue: '12 €' }, { rawValue: null, rawValueAbsence: 'UNJUSTIFIED' }])).toMatchObject({ status: 'INCOMPLETE', unjustified: 1 });
    expect(literalCoverageOf([{ rawValue: '12 €' }, { rawValue: null, rawValueAbsence: null }])).toMatchObject({ status: 'NOT_ESTABLISHED', legacy: 1 });
  });
});

describe('C863-B1 — chemin ACTIF d’écriture (avant toute persistance T1)', () => {
  const tx = async () => ({ unsafe: (await import('@/db')).pgClient.unsafe as never });

  it('C863-B1-10 — littéral récupéré ÉCRIT dans raw_value (provenance tracée), absence non justifiée écrite explicitement', async () => {
    await insertFactRows(await tx(), E, 9, [fait(), fait({ factKey: 'autre', excerpt: 'Total TTC : voir page 2' })], { canonical: true, provenance: false, rawValueAbsence: true });
    expect(colonne(0, 'raw_value')).toBe('1 234,50 €');
    expect(colonne(0, 'raw_value_absence')).toBeUndefined();
    expect(JSON.parse(String(colonne(0, 'location')))).toMatchObject({ page: 1, rawValueSource: 'EXCERPT' });
    expect(colonne(1, 'raw_value')).toBeNull();
    expect(colonne(1, 'raw_value_absence')).toBe('UNJUSTIFIED');
  });

  it('C863-B1-11 — fait GÉNÉRIQUE sans donnée canonique : contrôlé et motif écrit (aucune clé ni bien inventés)', async () => {
    const generique: DocumentFactRecord = {
      factKey: 'couleur_facade', subject: 'façade', attribute: 'couleur', label: 'Couleur', valueText: 'ocre', valueNumber: null, valueUnit: null,
      valueJson: 'ocre', normalizedValue: null, periodStart: null, periodEnd: null, confidence: 'probable', excerpt: 'Total TTC : 1 234,50 €',
      location: {}, evidenceOrigin: 'TEXT_EXTRACTION', visualEvidence: null,
    };
    await insertFactRows(await tx(), E, 9, [generique], { canonical: false, provenance: false, rawValueAbsence: true });
    expect(ecrits()[0].sql).not.toMatch(/canonical_key/);
    expect(colonne(0, 'raw_value_absence')).toBe('UNJUSTIFIED');
    // Même fait, citation qui le PROUVE, colonnes 0218 absentes : emplacement prouvé écrit (littéral non stockable).
    db.calls = [];
    await insertFactRows(await tx(), E, 9, [{ ...generique, excerpt: 'Façade enduite, teinte ocre' }], { canonical: false, provenance: false, rawValueAbsence: true });
    expect(colonne(0, 'raw_value_absence')).toBe('LITERAL_IN_EXCERPT');
  });

  it('C863-B1-12 — REPRISE (unités déjà en base) : textes relus dans la transaction, référence vérifiée sur l’unité PERSISTÉE', async () => {
    const long = 'ballon thermodynamique 270 litres, '.repeat(70).trim();
    db.unites = [{ source_unit_id: 'page:2:block:1', texte: `Désignation : ${long}` }];
    await insertFactRows(await tx(), E, 9, [fait({ valueText: long, valueNumber: null, normalizedValue: long, valueType: 'text', excerpt: long.slice(0, 40).trim(), sourceUnitIds: ['page:2:block:1'] })],
      { canonical: true, provenance: true, rawValueAbsence: true });
    expect(db.calls.some((c) => c.sql.includes('FROM document_source_units'))).toBe(true);
    expect(colonne(0, 'raw_value_absence')).toBe('SOURCE_UNIT_REFERENCE');
    // Unité absente de la base : la référence ne vaut rien.
    db.calls = []; db.unites = [];
    await insertFactRows(await tx(), E, 9, [fait({ valueText: long, valueNumber: null, normalizedValue: long, valueType: 'text', excerpt: long.slice(0, 40).trim(), sourceUnitIds: ['page:2:block:1'] })],
      { canonical: true, provenance: true, rawValueAbsence: true });
    expect(colonne(0, 'raw_value_absence')).toBe('UNJUSTIFIED');
  });

  it('C863-B1-13 — prompt T1 : restitution EXACTE de tout littéral lisible, plus aucune sélection « selon l’utilité »', () => {
    const prompt = readFileSync(join(process.cwd(), 'src/services/ai/prompts/source-analysis/t1_master_v1.txt'), 'utf8');
    expect(prompt).not.toMatch(/preuve utile/);
    expect(prompt).toMatch(/EXACTEMENT tel qu’il est écrit dans la source, tout littéral lisible/);
    expect(prompt).toMatch(/Ne le sélectionne jamais selon son utilité/);
    expect(prompt).toMatch(/séparée/);
  });
});
