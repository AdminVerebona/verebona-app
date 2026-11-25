/**
 * Carte #838 (B1, AC08/AC13) — valeur littérale `rawValue` d'un fait T1 :
 * conservée EXACTEMENT quand la source la fournit, sinon motif CODIFIÉ et
 * VÉRIFIABLE persisté avec le fait ; aucun `null` inexpliqué ; contrat T1 v7
 * et prompt actif INCHANGÉS (rawValue reste facultatif) ; faits antérieurs
 * lus « motif non renseigné », jamais un motif inventé.
 *
 * Chaîne traversée sur fixtures SYNTHÉTIQUES : contrat (Zod) → contrôle de
 * preuve → projection → champ extrait → fait persisté (SQL d'écriture) →
 * lecture. L'écriture et la relecture en base réelle sont prouvées par
 * `src/test/e2e/scenarios/c838-gateway-t1-ecarts.e2e.ts` (C838-E2E-B1).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ calls: [] as Array<{ sql: string; params: unknown[] }>, columnsReady: true }));
vi.mock('@/db', () => {
  const unsafe = vi.fn(async (sql: string, params: unknown[] = []) => {
    db.calls.push({ sql, params });
    if (sql.includes('information_schema.columns')) return [{ n: db.columnsReady ? (params[1] as string[]).length : 0 }];
    if (sql.includes('INSERT INTO document_extractions')) return [{ id: 77 }];
    if (sql.includes('INSERT INTO document_facts')) return [{ id: db.calls.length }];
    return [];
  });
  return { db: {}, pgClient: { unsafe, begin: async (fn: (tx: { unsafe: typeof unsafe }) => Promise<void>) => fn({ unsafe }) } };
});

import {
  RAW_VALUE_ABSENCE_CODES, checkRawValueAbsence, rawValueAbsenceHolds, readRawValueAbsence, LEGACY_RAW_VALUE_ABSENCE, RAW_VALUE_ABSENCE_LABELS,
} from '../master/raw-value-absence';
import { t1Fact } from '../master/t1-contract';
import { checkFactEvidence } from '../master/fact-evidence';
import { insertFactRows } from '../../knowledge/document-knowledge.service';
import { toFact } from '../../knowledge/document-knowledge';
import { projectedFactToExtractedField } from '../steps/persist-evidence.step';
import { __resetCanonicalColumnsForTests } from '../../evidence/canonical-columns';
import type { DocumentFactRecord } from '../../knowledge/document-knowledge';
import type { ProjectedFact } from '../master/t1-contract';

const projected = (over: Partial<ProjectedFact> = {}): ProjectedFact => ({
  canonicalKey: 'acquisitionPrice', rawKey: 'Total TTC', label: null, subject: null, attribute: null,
  rawValue: '1 234,50 €', value: 1234.5, valueType: 'money_eur', canonicalUnit: 'EUR',
  target: { targetType: 'ASSET', targetEntityId: 3, targetEntityLabel: 'Maison', targetConfidence: 'certain' },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: 'Total TTC : 1 234,50 €', page: 1 },
  semanticEvent: null, recurrence: null, periodStart: null, periodEnd: null, origin: 'MODEL_CANONICAL', ruleCode: null, ...over,
});
const enregistrement = (p: ProjectedFact, sourceUnitIds?: string[]): DocumentFactRecord =>
  toFact({ ...projectedFactToExtractedField(p), ...(sourceUnitIds ? { sourceUnitIds } : {}) });
const E = { accountId: 1, fileId: 55, sourceType: 'asset_file' as const, provider: 'fake', model: 'm', promptVersion: 'v' };
const ecrits = () => db.calls.filter((c) => c.sql.includes('INSERT INTO document_facts'));
const motifEcrit = (i: number): unknown => {
  const c = ecrits()[i];
  return c.sql.includes('raw_value_absence') ? c.params[c.params.length - 1] : undefined;
};

beforeEach(() => {
  db.calls = []; db.columnsReady = true;
  __resetCanonicalColumnsForTests(null);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('C838-B1 — règle pure', () => {
  it('C838-B1-01 — littéral présent : conservé, aucun motif (0 et false sont des littéraux)', () => {
    expect(checkRawValueAbsence({ rawValue: '1 234,50 €', excerpt: 'x' })).toEqual({ status: 'LITERAL', code: null });
    expect(checkRawValueAbsence({ rawValue: 0 }).status).toBe('LITERAL');
    expect(checkRawValueAbsence({ rawValue: false }).status).toBe('LITERAL');
    // Règle remplacée (carte #863, B1) : un littéral vide n'est pas un littéral ; la citation ne justifie l'absence
    // que si elle porte la VALEUR du fait — ici « 12 € » pour 12 : littéral RÉCUPÉRÉ exactement (avant : motif seul).
    expect(checkRawValueAbsence({ rawValue: '  ', excerpt: 'Total : 12 €', valueNumber: 12 })).toEqual({ status: 'RECOVERED', code: null, rawValue: '12 €', from: 'EXCERPT' });
  });

  it('C838-B1-02 — motifs déduits de la preuve, chacun avec sa précondition vérifiable', () => {
    // Règle complétée (carte #863, B1) : chaque motif exige désormais une preuve PORTANT la valeur du fait (citation,
    // texte d'unité persistée), une règle déterministe NOMMÉE, un booléen SANS mot écrit — jamais la seule forme.
    expect(checkRawValueAbsence({ evidenceOrigin: 'VISUAL_ANALYSIS', visualEvidence: { description: 'logo de la marque sur la façade' } }).code).toBe('VISUAL_ONLY');
    const long = 'Désignation '.repeat(200);
    expect(checkRawValueAbsence({ excerpt: 'Désignation Désignation', valueText: long.trim(), sourceUnitIds: ['page:2:block:4'], sourceUnitTexts: new Map([['page:2:block:4', long]]) }).code).toBe('SOURCE_UNIT_REFERENCE');
    expect(checkRawValueAbsence({ excerpt: 'Total : 12 € (soit 12,00 €)', valueNumber: 12 }).code).toBe('LITERAL_IN_EXCERPT');
    expect(checkRawValueAbsence({ projectionOrigin: 'DETERMINISTIC_RULE', projectionRule: 'ACQ_FROM_DOC_DATE', excerpt: 'x' }).code).toBe('DERIVED_BY_RULE');
    expect(checkRawValueAbsence({ valueType: 'boolean', excerpt: 'Diagnostic de performance énergétique annexé' }).code).toBe('NO_LITERAL');
    // Rien de vérifiable : signalé, jamais un null muet.
    expect(checkRawValueAbsence({})).toEqual({ status: 'UNJUSTIFIED', code: 'UNJUSTIFIED', rejected: null });
  });

  it('C838-B1-03 — motif proposé par l’amont (ILLEGIBLE) retenu SEULEMENT s’il est vérifié ; sinon rejeté et tracé', () => {
    // Règle complétée (carte #863, B1) : ILLEGIBLE exige la PREUVE d'une zone illisible (description qui le dit ET zone
    // localisée) ; un fait lu qui porte sa valeur donne son littéral (récupéré), jamais un motif de convenance.
    const visuel = { evidenceOrigin: 'VISUAL_ANALYSIS', visualEvidence: { description: 'plaque signalétique floue', page: 2 } };
    expect(checkRawValueAbsence({ ...visuel, rawValueAbsence: 'ILLEGIBLE' })).toEqual({ status: 'JUSTIFIED', code: 'ILLEGIBLE' });
    // Un fait LU (citation présente) ne peut pas être « illisible » : motif refusé, littéral récupéré à la place.
    expect(checkRawValueAbsence({ excerpt: 'Total : 12 €', valueNumber: 12, rawValueAbsence: 'ILLEGIBLE' })).toMatchObject({ status: 'RECOVERED', rawValue: '12 €' });
    expect(checkRawValueAbsence({ rawValueAbsence: 'INVENTÉ' })).toEqual({ status: 'UNJUSTIFIED', code: 'UNJUSTIFIED', rejected: 'INVENTÉ' });
    expect(rawValueAbsenceHolds('ILLEGIBLE', { evidenceOrigin: 'VISUAL_ANALYSIS', excerpt: 'cité' })).toBe(false);
    for (const c of RAW_VALUE_ABSENCE_CODES) expect(RAW_VALUE_ABSENCE_LABELS[c]).toBeTruthy();
  });

  it('C838-B1-04 — lecture : motif écrit, littéral → null, ANCIEN fait sans motif → LEGACY_UNSPECIFIED (rien d’inventé)', () => {
    expect(readRawValueAbsence({ rawValue: '12 €', rawValueAbsence: null })).toBeNull();
    expect(readRawValueAbsence({ rawValue: null, rawValueAbsence: 'VISUAL_ONLY' })).toBe('VISUAL_ONLY');
    expect(readRawValueAbsence({ rawValue: null, rawValueAbsence: null })).toBe(LEGACY_RAW_VALUE_ABSENCE);
    expect(readRawValueAbsence({ rawValue: null, rawValueAbsence: 'CODE_INCONNU' })).toBe(LEGACY_RAW_VALUE_ABSENCE);
  });
});

describe('C838-B1 — contrat et preuve inchangés, prompt versionné (#863)', () => {
  it('C838-B1-05 — contrat T1 v7 : rawValue reste FACULTATIF (aucun fait existant rejeté), prompt actif VERSIONNÉ (#863)', () => {
    const sans = t1Fact.parse({ canonicalKey: null, normalizedValue: 'bleu', target: { type: 'GENERIC' }, confidence: 'probable', evidence: { excerpt: 'couleur bleue' } });
    expect(sans.rawValue).toBeUndefined();
    expect(t1Fact.safeParse({ canonicalKey: null, rawValue: 'x'.repeat(2000), normalizedValue: 'x', target: { type: 'GENERIC' }, confidence: 'probable' }).success).toBe(true);
    // Le contrôle de preuve historique est inchangé (lu sans citation : écarté ; observé sans description : écarté).
    expect(checkFactEvidence({ ...sans, evidence: {} })).toEqual({ ok: false, reason: 'TEXT_WITHOUT_EXCERPT' });
    const prompt = readFileSync(join(process.cwd(), 'src/services/ai/prompts/source-analysis/t1_master_v1.txt'), 'utf8');
    // Règle remplacée (carte #863, B1) : la consigne « lorsque cela apporte une preuve utile » (sélection selon
    // l'utilité) est retirée ; tout littéral lisible est restitué exactement. Empreinte VERSIONNÉE (nouvelle valeur).
    expect(prompt).not.toContain('lorsque cela apporte une preuve utile');
    expect(prompt).toContain('EXACTEMENT tel qu’il est écrit dans la source, tout littéral lisible de la valeur');
    expect(createHash('sha256').update(prompt).digest('hex')).toBe(PROMPT_SHA256);
  });
});

describe('C838-B1 — écriture : motif persisté avec le fait, avant la base', () => {
  it('C838-B1-06 — littéral exact (y compris très long), visuel, référence d’unité, hors catalogue : SQL et paramètres', async () => {
    const long = 'Désignation : ' + 'pompe à chaleur air/eau, '.repeat(78);
    expect(long.length).toBeGreaterThan(1_900);
    const tresLong = 'ballon thermodynamique 270 litres, '.repeat(70).trim();
    expect(tresLong.length).toBeGreaterThan(2_000);
    const faits = [
      enregistrement(projected()),
      enregistrement(projected({ rawValue: long.slice(0, 2000), canonicalKey: null, rawKey: 'designation', origin: 'GENERIC', valueType: 'text', value: long.slice(0, 2000) })),
      enregistrement(projected({ rawValue: null, provenance: 'VISUAL_ANALYSIS', evidence: {}, visualEvidence: { description: 'chaudière murale blanche' }, valueType: 'string', value: 'murale' })),
      // Règle complétée (carte #863, B1) : la référence d'unité exige une unité PERSISTÉE dont le texte porte la valeur
      // (ici une désignation de plus de 2 000 caractères, conservée par référence).
      enregistrement(projected({ rawValue: null, value: tresLong, valueType: 'text', evidence: { excerpt: tresLong.slice(0, 80).trim(), page: 3 } }), ['page:3:block:7']),
      enregistrement(projected({ rawValue: null, canonicalKey: null, rawKey: 'couleur_facade', origin: 'GENERIC', valueType: 'string', value: 'ocre' })),
    ];
    await insertFactRows({ unsafe: (await import('@/db')).pgClient.unsafe as never }, E, 9, faits, {
      canonical: true, provenance: true, rawValueAbsence: true, unitTexts: new Map([['page:3:block:7', `Désignation complète : ${tresLong}`]]),
    });
    expect(ecrits()).toHaveLength(5);
    // Littéral EXACT conservé (colonne raw_value, paramètre 26), aucun motif.
    expect(ecrits()[0].params[25]).toBe('1 234,50 €');
    expect(motifEcrit(0)).toBeUndefined();
    expect(ecrits()[1].params[25]).toBe(long.slice(0, 2000));
    // Absences : motif codifié et vérifié.
    expect(motifEcrit(2)).toBe('VISUAL_ONLY');
    expect(motifEcrit(3)).toBe('SOURCE_UNIT_REFERENCE');
    // Hors catalogue (générique) sans littéral : fait conservé tel quel, clé NON inventée.
    expect(ecrits()[4].params[23]).toBeNull();
    // Règle remplacée (carte #863, B1) : sa citation (« Total TTC : 1 234,50 € ») ne porte PAS sa valeur (« ocre ») —
    // citation hors sujet : absence NON justifiée, explicite (avant : LITERAL_IN_EXCERPT de convenance).
    expect(motifEcrit(4)).toBe('UNJUSTIFIED');
  });

  it('C838-B1-07 — aucune preuve vérifiable : fait conservé, `UNJUSTIFIED` écrit et signalé (jamais un null muet)', async () => {
    const f: DocumentFactRecord = { ...enregistrement(projected({ rawValue: null })), excerpt: null };
    await insertFactRows({ unsafe: (await import('@/db')).pgClient.unsafe as never }, E, 9, [f], { canonical: true, provenance: false, rawValueAbsence: true });
    expect(motifEcrit(0)).toBe('UNJUSTIFIED');
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/UNJUSTIFIED/));
  });

  it('C838-B1-08 — colonne 1980 absente (retour arrière) : écriture inchangée, aucune perte du fait', async () => {
    await insertFactRows({ unsafe: (await import('@/db')).pgClient.unsafe as never }, E, 9, [enregistrement(projected({ rawValue: null, provenance: 'VISUAL_ANALYSIS', evidence: {}, visualEvidence: { description: 'd' } }))],
      { canonical: true, provenance: false, rawValueAbsence: false });
    expect(ecrits()).toHaveLength(1);
    expect(ecrits()[0].sql).not.toMatch(/raw_value_absence/);
    expect(ecrits()[0].params).toHaveLength(37);
  });
});

/**
 * Empreinte du prompt actif `t1_master_v1.txt`. Règle remplacée (carte #863, B1) : la consigne U6 est modifiée
 * (restitution exacte de tout littéral lisible) — nouvelle empreinte, versionnée par la clé de la passerelle.
 */
const PROMPT_SHA256 = '3a634f587d6674dca24988c15fe3688d32e18ff1f263c1cec0a74cc710ef3d9f';
