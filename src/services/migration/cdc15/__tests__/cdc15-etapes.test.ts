/**
 * Rattrapages CDC 15 §14 (lot 17, volet B) — règles pures de chaque étape,
 * masquage du rapport, arguments du script, cartes MIG-REVIEW.
 */
import { describe, it, expect } from 'vitest';
import type { AssetRowJson } from '@/services/canonical/asset-state';
import { planKcAliases, resolveRawKey } from '../steps/mig01-aliases';
import { beforeV5, planAmounts } from '../steps/mig02-amounts';
import { decideOrigin, planOrigins } from '../steps/mig03-origins';
import { SUPERSEDE_CANDIDATES_SQL } from '../steps/mig04-supersede';
import { planMirrors, sameColumnValue } from '../steps/mig07-mirrors';
import { humanWriteSince, provenOrigin, writtenFromEvidence, type FieldWriteEvent } from '../history';
import { humanOriginProof } from '../origin-proof';
import { MASKED, maskReportValue } from '../mask';
import { formatRunSummary, toReportRow } from '../report';
import { parseBackfillArgs } from '../cli';
import { orderSteps } from '../runner';
import { formatMissing } from '../schema-check';
import { buildMigrationProposals, migrationRelation, migrationRelationKey, valueLabel } from '@/services/to-process/migration-review-cards';
import { assetBackupRows, kcDiff } from '../backup';
import { getRule, checkRulesCatalog } from '@/services/to-process/rules-catalog';

const row = (kc: Record<string, unknown>, over: Record<string, unknown> = {}): AssetRowJson =>
  ({ id: 5, account_id: 9, category: 'VEHICULE', key_characteristics: JSON.stringify(kc), ...over } as AssetRowJson);
const ev = (over: Partial<FieldWriteEvent>): FieldWriteEvent => ({ key: 'mileage', value: 1, origin: 'RECONCILIATION', at: 1, source: 'ai_field_updates', ...over });

describe('MIG-01 — alias', () => {
  it('clé vide : valeur normalisée (centimes → euros), provenance recopiée, alias conservé', () => {
    const p = planKcAliases(row({ purchasePriceCents: 1250000, purchasePriceCents_origin: 'auto', kilometrage: 45000 }));
    expect(p.kc).toMatchObject({ acquisitionPrice: 12500, acquisitionPrice__origin: 'DOCUMENT_EXTRACTION', purchasePriceCents: 1250000, mileage: 45000, kilometrage: 45000 });
    expect(p.entries.filter((e) => e.decision === 'APPLIED').map((e) => e.fieldKey).sort()).toEqual(['acquisitionPrice', 'mileage']);
    expect(p.cards).toEqual([]);
  });
  it('conflit alias / clé canonique : AMBIGUOUS + UNE carte, rien d’écrit ; même valeur : NO_CHANGE', () => {
    const p = planKcAliases(row({ mileage: 45000, kilometrage: 46000, compteur: 47000, odometer: 45000 }));
    expect(p.kc).toBeNull();
    expect(p.entries.filter((e) => e.decision === 'AMBIGUOUS')).toHaveLength(2);
    expect(p.entries.filter((e) => e.decision === 'NO_CHANGE')).toHaveLength(1);
    expect(p.cards).toEqual([expect.objectContaining({ key: 'mileage', reason: 'ALIAS_CONFLICT', current: 45000 })]);
    expect(p.cards[0].candidates.map((c) => c.value)).toEqual([46000, 47000]);
  });
  it('alias en désaccord sans clé : AMBIGUOUS ; alias illisible : AMBIGUOUS sans carte', () => {
    const p = planKcAliases(row({ kilometrage: 1000, compteur: 2000 }));
    expect(p.kc).toBeNull();
    expect(p.entries[0]).toMatchObject({ decision: 'AMBIGUOUS', reason: 'ALIASES_DISAGREE' });
    expect(p.cards).toHaveLength(1);
    const q = planKcAliases(row({ kilometrage: 'beaucoup' }));
    expect(q.entries[0]).toMatchObject({ decision: 'AMBIGUOUS', reason: 'ALIAS_UNNORMALIZABLE' });
    expect(q.cards).toEqual([]);
  });
  it('clé brute d’un fait ou d’une preuve : canonique, alias, famille inconnue, unité, générique', () => {
    expect(resolveRawKey('mileage', null)).toEqual({ kind: 'canonical', key: 'mileage' });
    expect(resolveRawKey('kilometrage', 'VEHICULE')).toEqual({ kind: 'alias', key: 'mileage' });
    expect(resolveRawKey('marque', null)).toEqual({ kind: 'ambiguous', reason: 'ALIAS_FAMILY_UNKNOWN' });
    expect(resolveRawKey('marque', 'VEHICULE')).toEqual({ kind: 'alias', key: 'make' });
    expect(resolveRawKey('purchasePriceCents', 'VEHICULE')).toMatchObject({ kind: 'ambiguous', reason: 'UNIT_CONVERSION_REQUIRED' });
    expect(resolveRawKey('couleurDuPortail', 'IMMOBILIER')).toEqual({ kind: 'generic' });
  });
});

describe('MIG-02 — montants ×100 (D-16)', () => {
  const base = { documentAmountsCents: [] as number[], history: undefined };
  const preuve = { id: 7, key: 'acquisitionPrice', eur: 12500, promptVersion: 'extract_source_v4', extractedAt: 10, sourceId: 70 };
  const ecrite = (over: Partial<FieldWriteEvent> = {}) => new Map([['acquisitionPrice', [ev({ key: 'acquisitionPrice', value: 1250000, at: 11, evidenceId: 7, ...over })]]]);
  const auto = (v: number, origin = 'RECONCILIATION') => row({ acquisitionPrice: v, acquisitionPrice__origin: origin });

  it('preuve exacte ET provenance établie (evidence_id, ou document source) : correction', () => {
    const d = planAmounts(auto(1250000), { ...base, evidences: [preuve], history: ecrite() });
    expect(d[0].entry).toMatchObject({ decision: 'APPLIED', reason: 'EXACT_EVIDENCE_X100', before: 1250000, after: 12500 });
    expect(d[0].correction).toMatchObject({ to: 12500, evidenceId: 7, origin: 'RECONCILIATION' });
    const parDocument = planAmounts(auto(1250000), { ...base, evidences: [preuve], history: ecrite({ evidenceId: null, fileId: 70 }) });
    expect(parDocument[0].entry.decision).toBe('APPLIED');
  });
  it('provenance non établie : dernière écriture d’une autre preuve, d’un autre document, ou absente → AMBIGUOUS + carte', () => {
    for (const h of [ecrite({ evidenceId: 8 }), ecrite({ evidenceId: null, fileId: 71 }), undefined]) {
      const d = planAmounts(auto(1250000), { ...base, evidences: [preuve], history: h });
      expect(d[0].entry).toMatchObject({ decision: 'AMBIGUOUS', reason: 'PROVENANCE_NOT_ESTABLISHED' });
      expect(d[0].card?.candidates[0].value).toBe(12500);
    }
  });
  it('scénario du relecteur : 150 000 € posé par IMPORT face à une preuve de 1 500 € → jamais corrigé automatiquement', () => {
    const p = { ...preuve, eur: 1500 };
    const d = planAmounts(auto(150000, 'IMPORT'), { ...base, evidences: [p], history: ecrite({ value: 150000 }) });
    expect(d[0].entry).toMatchObject({ decision: 'AMBIGUOUS', reason: 'AUTOMATIC_ORIGIN_NOT_DOCUMENTARY' });
    expect(d[0].correction).toBeUndefined();
    expect(d[0].card).toMatchObject({ current: 150000, candidates: [{ value: 1500 }] });
    expect(planAmounts(auto(150000, 'SYSTEM_RULE'), { ...base, evidences: [p], history: ecrite({ value: 150000 }) })[0].entry.decision).toBe('AMBIGUOUS');
  });
  it('origine humaine prouvée : SKIPPED_USER ; présumée (NO_AI_PROOF_PROTECTED, aucune info) : carte', () => {
    expect(planAmounts(row({ acquisitionPrice: 1250000, acquisitionPrice__origin: 'USER' }), { ...base, evidences: [preuve] })[0].entry.decision).toBe('SKIPPED_USER');
    const presumee = planAmounts(row({ acquisitionPrice: 1250000, acquisitionPrice__origin: 'USER', acquisitionPrice__originBasis: 'NO_AI_PROOF_PROTECTED' }),
      { ...base, evidences: [preuve] })[0];
    expect(presumee.entry).toMatchObject({ decision: 'AMBIGUOUS', reason: 'HUMAN_ORIGIN_PRESUMED' });
    expect(presumee.card).toBeDefined();
    expect(planAmounts(row({ acquisitionPrice: 1250000 }), { ...base, evidences: [preuve] })[0].entry.reason).toBe('HUMAN_ORIGIN_PRESUMED');
  });
  it('écriture humaine depuis la preuve, prompt v5 : AMBIGUOUS', () => {
    const h = new Map([['acquisitionPrice', [ev({ key: 'acquisitionPrice', origin: 'USER', at: 9, value: 999 }), ev({ key: 'acquisitionPrice', value: 1250000, at: 11, evidenceId: 7 })]]]);
    const x = planAmounts(auto(1250000), { ...base, evidences: [{ ...preuve, extractedAt: 5 }], history: h })[0];
    expect(x.entry).toMatchObject({ decision: 'AMBIGUOUS', reason: 'HUMAN_WRITE_SINCE_EVIDENCE' });
    const y = planAmounts(auto(1250000), { ...base, evidences: [{ ...preuve, promptVersion: 'extract_source_v5' }], history: ecrite() })[0];
    expect(y.entry.reason).toBe('EVIDENCE_X100_RECENT_PROMPT');
  });
  it('montant documentaire égal à la valeur : AMBIGUOUS, jamais corrigé ; preuve de même montant : aucun soupçon', () => {
    const d = planAmounts(auto(89900, 'DOCUMENT_EXTRACTION'), { ...base, evidences: [], documentAmountsCents: [89900] });
    expect(d[0].entry).toMatchObject({ decision: 'AMBIGUOUS', reason: 'DOCUMENT_AMOUNT_X100_NOT_FIELD_ATTRIBUTABLE' });
    expect(d[0].card?.candidates[0].value).toBe(899);
    expect(planAmounts(auto(12500), { ...base, evidences: [{ ...preuve }, { ...preuve, id: 2, eur: 125 }] })).toEqual([]);
    expect(beforeV5(null)).toBe(true);
    expect(beforeV5('extract_source_v4')).toBe(true);
    expect(beforeV5('extract_source_v5')).toBe(false);
    expect(beforeV5('t1_master_v1')).toBe(false);
  });
  it('provenance : dernière écriture seulement, même valeur', () => {
    expect(writtenFromEvidence([ev({ value: 5, evidenceId: 7 })], 'mileage', 5, { id: 7, sourceId: null })).toBe(true);
    expect(writtenFromEvidence([ev({ value: 5, evidenceId: 7 }), ev({ value: 6 })], 'mileage', 5, { id: 7, sourceId: null })).toBe(false);
    expect(writtenFromEvidence([ev({ value: 4, evidenceId: 7 })], 'mileage', 5, { id: 7, sourceId: null })).toBe(false);
  });
});

describe('MIG-03 — origines', () => {
  it('règle exacte', () => {
    expect(decideOrigin({ kind: 'structured', origin: 'USER' }, ev({ origin: 'RECONCILIATION' }))).toBeNull();
    expect(decideOrigin({ kind: 'structured', origin: 'RECONCILIATION' }, ev({ origin: 'USER' }))).toEqual({ origin: 'USER', reason: 'HUMAN_WRITE_PROVEN' });
    expect(decideOrigin({ kind: 'structured', origin: 'RECONCILIATION' }, null)).toBeNull();
    expect(decideOrigin({ kind: 'legacy', flag: 'manual' }, null)).toEqual({ origin: 'USER', reason: 'LEGACY_MANUAL' });
    expect(decideOrigin({ kind: 'legacy', flag: 'auto' }, ev({}))).toEqual({ origin: 'RECONCILIATION', reason: 'AI_WRITE_PROVEN' });
    expect(decideOrigin({ kind: 'legacy', flag: 'auto' }, null)).toEqual({ origin: 'USER', reason: 'NO_AI_PROOF_PROTECTED' });
    expect(decideOrigin({ kind: 'none' }, null)).toEqual({ origin: 'USER', reason: 'NO_AI_PROOF_PROTECTED' });
  });
  it('preuve = DERNIÈRE écriture de la valeur en place ; écriture humaine postérieure', () => {
    const h = [ev({ value: 1000, at: 1 }), ev({ value: 2000, at: 2 })];
    expect(provenOrigin(h, 'mileage', 2000)).toMatchObject({ value: 2000 });
    expect(provenOrigin(h, 'mileage', 1000)).toBeNull();
    expect(humanWriteSince([ev({ origin: 'USER', at: 5 })], 4)).toBe(true);
    expect(humanWriteSince([ev({ origin: 'USER', at: 3 })], 4)).toBe(false);
  });
  it('plan d’un bien : origine structurée posée, ancien format retiré, valeur intacte', () => {
    const p = planOrigins(row({ mileage: 45000, mileage_origin: 'auto', registrationNumber: 'AB-123-CD', make: 'Renault', make__origin: 'USER' }),
      new Map([['mileage', [ev({ value: 45000 })]]]));
    expect(p.kc).toMatchObject({ mileage: 45000, mileage__origin: 'RECONCILIATION', registrationNumber__origin: 'USER', make__origin: 'USER',
      registrationNumber__originBasis: 'NO_AI_PROOF_PROTECTED', mileage__originBasis: 'AI_WRITE_PROVEN' });
    expect(p.kc).not.toHaveProperty('make__originBasis');
    expect(p.kc).not.toHaveProperty('mileage_origin');
    expect(p.entries.find((e) => e.fieldKey === 'make')).toMatchObject({ decision: 'NO_CHANGE' });
    // Relance : plus rien à faire.
    expect(planOrigins(row(p.kc!), new Map([['mileage', [ev({ value: 45000 })]]])).kc).toBeNull();
  });
});

describe('MIG-04 — supersede', () => {
  it('même source, même champ, même cible, analyse postérieure ; preuves actives seulement', () => {
    expect(SUPERSEDE_CANDIDATES_SQL).toContain('n.source_id = o.source_id');
    expect(SUPERSEDE_CANDIDATES_SQL).toContain('n.field_key = o.field_key');
    expect(SUPERSEDE_CANDIDATES_SQL).toContain('n.analysis_run_id > o.analysis_run_id');
    expect(SUPERSEDE_CANDIDATES_SQL).not.toMatch(/DELETE/i);
  });
});

describe('MIG-07 — colonnes miroirs', () => {
  it('humain PROUVÉ : colonne alignée (copie restaurable) ; colonne vide : remplie ; fiche vide : remplie depuis la colonne', () => {
    const p = planMirrors(row({ registrationNumber: 'AB-123-CD', registrationNumber__origin: 'USER', mileage: 45000 },
      { registration_number: 'ZZ-999-ZZ', mileage_or_hours: null, purchase_date: '2019-01-01' }));
    expect(p.columns).toEqual({ registration_number: 'AB-123-CD', mileage_or_hours: 45000 });
    expect(p.backups).toEqual([{ column: 'registration_number', old: 'ZZ-999-ZZ', next: 'AB-123-CD' }, { column: 'mileage_or_hours', old: null, next: 45000 }]);
    expect(p.kc).toMatchObject({ acquisitionDate: '2019-01-01', acquisitionDate__origin: 'USER' });
    expect(p.entries.map((e) => e.reason).sort()).toEqual(['KC_FILLED_FROM_COLUMN', 'MIRROR_ALIGNED_ON_KC', 'MIRROR_FILLED']);
  });
  it('humain seulement PRÉSUMÉ (NO_AI_PROOF_PROTECTED, aucune origine) : AMBIGUOUS + carte, colonne intacte ; prouvé par le journal : aligné', () => {
    for (const kc of [{ registrationNumber: 'AB-123-CD' },
      { registrationNumber: 'AB-123-CD', registrationNumber__origin: 'USER', registrationNumber__originBasis: 'NO_AI_PROOF_PROTECTED' }]) {
      const p = planMirrors(row(kc, { registration_number: 'ZZ-999-ZZ' }));
      expect(p.columns).toEqual({});
      expect(p.entries[0]).toMatchObject({ decision: 'AMBIGUOUS', reason: 'COLUMN_DIFFERS_HUMAN_NOT_PROVEN' });
      expect(p.cards).toHaveLength(1);
    }
    const h = new Map([['registrationNumber', [ev({ key: 'registrationNumber', value: 'AB-123-CD', origin: 'USER' })]]]);
    expect(planMirrors(row({ registrationNumber: 'AB-123-CD', registrationNumber__origin: 'USER', registrationNumber__originBasis: 'NO_AI_PROOF_PROTECTED' },
      { registration_number: 'ZZ-999-ZZ' }), h).columns).toEqual({ registration_number: 'AB-123-CD' });
    expect(planMirrors(row({ registrationNumber: 'AB-123-CD', registrationNumber__origin: 'USER', registrationNumber__originBasis: 'LEGACY_MANUAL' },
      { registration_number: 'ZZ-999-ZZ' })).columns).toEqual({ registration_number: 'AB-123-CD' });
  });
  it('fiche automatique ≠ colonne : AMBIGUOUS + carte ; fiche ambiguë : AMBIGUOUS sans écriture', () => {
    const p = planMirrors(row({ registrationNumber: 'AB-123-CD', registrationNumber__origin: 'DOCUMENT_EXTRACTION' }, { registration_number: 'ZZ-999-ZZ' }));
    expect(p.columns).toEqual({});
    expect(p.entries[0]).toMatchObject({ decision: 'AMBIGUOUS', reason: 'COLUMN_DIFFERS_FROM_AUTOMATIC' });
    expect(p.cards[0]).toMatchObject({ key: 'registrationNumber', current: 'AB-123-CD', candidates: [{ value: 'ZZ-999-ZZ' }] });
    const q = planMirrors(row({ mileage: 1000, kilometrage: 2000 }, { mileage_or_hours: 5 }));
    expect(q.entries[0]).toMatchObject({ decision: 'AMBIGUOUS', reason: 'KC_AMBIGUOUS' });
    expect(q.columns).toEqual({});
  });
  it('prix : euros dans la fiche, centimes dans la colonne ; comparaison des colonnes ; preuve d’origine', () => {
    expect(planMirrors(row({ acquisitionPrice: 12500 }, { purchase_price_cents: 1250000 })).entries).toEqual([]);
    expect(sameColumnValue('2021-05-25T00:00:00', '2021-05-25')).toBe(true);
    expect(sameColumnValue(null, '')).toBe(true);
    expect(humanOriginProof({ k: 1, k_origin: 'manual' }, 'k', 'mileage', 1, undefined)).toBe('PROVEN');
    expect(humanOriginProof({ k: 1, k_origin: 'auto' }, 'k', 'mileage', 1, undefined)).toBe('AUTOMATIC');
    expect(humanOriginProof({ k: 1 }, 'k', 'mileage', 1, undefined)).toBe('PRESUMED');
    expect(humanOriginProof({ k: 1, k__origin: 'USER', k__originBasis: 'HUMAN_WRITE_PROVEN' }, 'k', 'mileage', 1, undefined)).toBe('PROVEN');
  });
});

describe('rapport, script, cartes', () => {
  it('masquage : clés sensibles, secrets, objets imbriqués', () => {
    expect(maskReportValue('address1', '12 rue des Lilas')).toBe(MASKED);
    expect(maskReportValue('adresse', '12 rue des Lilas')).toBe(MASKED);
    expect(maskReportValue('mileage', 45000)).toBe(45000);
    expect(maskReportValue('city', 'Lyon')).toBe(MASKED);
    expect(maskReportValue('postalCode', '69001')).toBe(MASKED);
    expect(maskReportValue('ville', 'Lyon')).toBe(MASKED);
    expect(maskReportValue('registrationNumber', { postal_code: '69001', city: 'Lyon', registration_number: 'AB' })).toEqual({ postal_code: MASKED, city: MASKED, registration_number: 'AB' });
    expect(maskReportValue(null, { address1: 'x', country: 'France' })).toEqual({ address1: MASKED, country: 'France' });
    expect(String(maskReportValue('notes', 'digicode : 4589'))).not.toContain('4589');
    const r = toReportRow('run', 'dry_run', { step: 'MIG-07', accountId: 1, assetId: 2, entityType: 'asset', entityId: 2, fieldKey: 'address1',
      before: { address: '1 rue X' }, after: { address: '2 rue Y' }, decision: 'APPLIED', reason: 'MIRROR_ALIGNED_ON_KC' });
    expect(r.before_value).not.toContain('rue');
    expect(r.entity_id).toBe('2');
  });
  it('arguments : étapes, simulation par défaut, erreurs ; ordre de « all »', () => {
    expect(parseBackfillArgs(['--step', 'MIG-02', '--account', '12'])).toMatchObject({ kind: 'run', steps: ['MIG-02'], accountId: 12, apply: false, dbReport: true });
    expect(parseBackfillArgs(['--step=all', '--apply', '--limit=10', '--no-db-report'])).toMatchObject({ steps: 'all', apply: true, limit: 10, dbReport: false });
    expect(parseBackfillArgs(['--step', 'MIG-09'])).toMatchObject({ kind: 'error' });
    expect(parseBackfillArgs(['--apply'])).toMatchObject({ kind: 'error' });
    expect(parseBackfillArgs(['--report', 'abc'])).toMatchObject({ kind: 'report', runId: 'abc', samples: 20 });
    expect(parseBackfillArgs(['--restore', 'abc'])).toEqual({ kind: 'restore', runId: 'abc' });
    const aide = parseBackfillArgs(['--help']);
    expect(aide.kind).toBe('help');
    expect((aide as { message: string }).message).toContain('SEULES les tables de rapport');
    expect(orderSteps('all')).toEqual(['MIG-01', 'MIG-03', 'MIG-02', 'MIG-04', 'MIG-07', 'MIG-08', 'MIG-05', 'MIG-06']);
    expect(orderSteps(['MIG-02', 'MIG-01'])).toEqual(['MIG-01', 'MIG-02']);
    expect(formatMissing([{ kind: 'table', name: 'cdc15_migration_report', migration: '0225' }])).toContain('ensureMigrations');
  });
  it('synthèse d’une exécution', () => {
    const t = formatRunSummary({
      run: { runId: 'r1', runMode: 'dry_run', steps: ['MIG-02'], accountId: 12, options: {}, cursors: {}, counts: {}, status: 'DONE', startedAt: 't0', finishedAt: 't1' },
      byStep: [{ step: 'MIG-02', decision: 'AMBIGUOUS', reason: 'DOCUMENT_AMOUNT_X100_NOT_FIELD_ATTRIBUTABLE', count: 3 }],
      samples: [{ step: 'MIG-02', decision: 'AMBIGUOUS', reason: 'X', accountId: 12, assetId: 5, entityType: 'asset', entityId: '5', fieldKey: 'acquisitionPrice', before: 89900, after: null }],
    });
    expect(t).toContain('SIMULATION');
    expect(t).toContain('MIG-02  AMBIGUOUS');
    expect(t).toContain('89900 → null');
  });
  it('carte MIG-REVIEW : règle au catalogue, relation par étape et champ, valeur actuelle + candidates', () => {
    expect(getRule('MIG-REVIEW')).toMatchObject({ targetType: 'ASSET', allowNotApplicable: true });
    expect(checkRulesCatalog()).toEqual([]);
    expect(migrationRelation('MIG-02', 'acquisitionPrice')).toBe('mig:MIG-02:acquisitionPrice');
    expect(migrationRelationKey('mig:MIG-07:acquisitionPrice')).toBe('acquisitionPrice');
    expect(migrationRelationKey('agenda:x')).toBeNull();
    const { question, proposals } = buildMigrationProposals({ step: 'MIG-02', accountId: 1, assetId: 2, key: 'acquisitionPrice', reason: 'X', current: 89900,
      candidates: [{ value: 899 }] });
    expect(question).toContain('Prix d’achat');
    expect(proposals).toEqual([
      expect.objectContaining({ value: 89900, isCurrentValue: true, label: expect.stringMatching(/^Garder 89\s900 €$/) }),
      expect.objectContaining({ value: 899, confidence: 0.5 }),
    ]);
    expect(valueLabel('acquisitionDate', '2021-05-25')).toBe('25/05/2021');
  });
});

describe('copie restaurable', () => {
  it('diff de fiche : valeurs et métadonnées, clé absente = null', () => {
    expect(kcDiff({ a: 1, a__origin: 'auto', b: 2 }, { a: 1, a__origin: 'USER', c: 3 })).toEqual([
      { name: 'a__origin', old: { v: 'auto' }, next: { v: 'USER' } },
      { name: 'b', old: { v: 2 }, next: null },
      { name: 'c', old: null, next: { v: 3 } },
    ]);
  });
  it('bien : clés de fiche et colonnes (forme texte), colonnes inchangées ignorées', () => {
    const r = assetBackupRows(5, { x: 1 }, { x: 2 }, { purchase_date: '2019-01-01', mileage_or_hours: 45000 }, { purchase_date: '2019-01-01', mileage_or_hours: 46000 });
    expect(r).toEqual([
      { targetType: 'asset_kc', targetId: 5, assetId: 5, name: 'x', old: { v: 1 }, next: { v: 2 } },
      { targetType: 'asset_column', targetId: 5, assetId: 5, name: 'mileage_or_hours', old: { v: '45000' }, next: { v: '46000' } },
    ]);
  });
});
