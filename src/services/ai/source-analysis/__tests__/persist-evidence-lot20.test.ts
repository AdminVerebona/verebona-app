/**
 * Preuves — décisions PO du 01/10/2026 (lot 20) :
 *   · D-C : chemin « étapes », un alias contextuel est écrit sous la clé
 *     retenue par le type documentaire (`dateFinContrat` d'un bail →
 *     leaseEndDate) ; rien ne change quand le document ne tranche rien ;
 *   · D-D : un champ de saisie seule (prix, surface d'annonce) n'est jamais
 *     écrit comme preuve, sur aucun chemin.
 * Base simulée : chaque requête SQL est capturée.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ calls: [] as Array<{ sql: string; params: unknown[] }>, nextId: 1000 }));
vi.mock('@/db', () => {
  const unsafe = vi.fn(async (sql: string, params: unknown[] = []) => {
    db.calls.push({ sql, params });
    if (sql.includes('information_schema.columns')) return [{ n: (params[1] as string[]).length }];
    if (sql.includes('FROM assets') && !sql.includes('JOIN')) return (params[1] as number[]).map((id) => ({ entityId: id, assetId: id }));
    if (sql.includes('INSERT INTO field_evidence')) return [{ id: db.nextId++ }];
    return [];
  });
  return { db: {}, pgClient: { unsafe, begin: async (fn: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) => fn({ unsafe }) } };
});

const { persistEvidence, persistProjectedFacts } = await import('../steps/persist-evidence.step');
const { __resetCanonicalColumnsForTests } = await import('../../evidence/canonical-columns');
import type { ProjectedFact } from '../master/t1-contract';
import type { ExtractedField, SourceInput, AiOperationTrace } from '../types';

const input: SourceInput = { sourceType: 'file', sourceIds: [55], accountId: 1, userId: 2, mimeTypes: [], displayNames: [], sourceVersion: 3 };
const trace: AiOperationTrace = {
  traceIds: ['00000000-0000-0000-0000-000000000001'], operationCodes: [], totalInputTokens: 0, totalOutputTokens: 0,
  totalCostMicros: 0, totalDurationMs: 0, usedFallback: false, models: ['gemini-x'],
};
const champ = (fieldKey: string, value: string | number): ExtractedField =>
  ({ fieldKey, value, confidence: 'certain', excerpt: `${fieldKey} : ${value}`, provenance: 'TEXT_EXTRACTION' } as ExtractedField);
/** Clé de champ ($3) de chaque INSERT. */
const clesEcrites = () => db.calls.filter((c) => c.sql.includes('INSERT INTO field_evidence')).map((c) => c.params[2]);

beforeEach(() => {
  db.calls = [];
  __resetCanonicalColumnsForTests(true);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('chemin « étapes » (persistEvidence)', () => {
  it('D-C : `dateFinContrat` d’une LLD → leaseEndDate ; d’une facture → clé brute (historique inchangé)', async () => {
    const lld = await persistEvidence({ input, leadSourceId: 55, assetId: 10, fields: [champ('dateFinContrat', '2028-06-30')], documentType: 'CONTRAT_LLD', trace });
    expect(clesEcrites()).toEqual(['leaseEndDate']);
    // Index des preuves : clé brute ET clé retenue (candidats agenda).
    expect([...lld.keys()].sort()).toEqual(['dateFinContrat', 'leaseEndDate']);
    db.calls = [];
    await persistEvidence({ input, leadSourceId: 56, assetId: 10, fields: [champ('dateFinContrat', '2028-06-30')], documentType: 'FACTURE', trace });
    expect(clesEcrites()).toEqual(['dateFinContrat']);
    db.calls = [];
    await persistEvidence({ input, leadSourceId: 57, assetId: 10, fields: [champ('numeroContrat', 'AX-778')], documentType: 'ATTESTATION_ASSURANCE', trace });
    expect(clesEcrites()).toEqual(['insuranceContractNumber']);
  });

  it('D-D : prix et surface d’annonce jamais écrits comme preuve, les autres champs oui', async () => {
    await persistEvidence({
      input, leadSourceId: 55, assetId: 10, documentType: 'ANNONCE_COMMERCIALE', trace,
      fields: [champ('prixAnnonce', 259000), champ('surfaceAnnoncee', 82), champ('surfaceCarrez', 78.4)],
    });
    expect(clesEcrites()).toEqual(['surfaceCarrez']);
  });
});

describe('branche maître (persistProjectedFacts)', () => {
  it('D-D : fait canonique de saisie seule → INPUT_ONLY_FIELD, jamais écrit', async () => {
    const f = (canonicalKey: string, value: number): ProjectedFact => ({
      canonicalKey, rawKey: null, label: null, subject: null, attribute: null, rawValue: String(value), value, valueType: 'number', canonicalUnit: null,
      target: { targetType: 'ASSET', targetEntityId: 10, targetEntityLabel: null, targetConfidence: 'certain' }, provenance: 'TEXT_EXTRACTION',
      confidence: 'certain', evidence: { excerpt: `${canonicalKey} ${value}` }, semanticEvent: null, recurrence: null,
      periodStart: null, periodEnd: null, origin: 'MODEL_CANONICAL', ruleCode: null,
    });
    const r = await persistProjectedFacts({ input, leadSourceId: 55, facts: [f('listingPrice', 259000), f('carrezArea', 78.4)], trace });
    expect(r.skipped.map((s) => [s.fact.canonicalKey, s.reason])).toEqual([['listingPrice', 'INPUT_ONLY_FIELD']]);
    expect(clesEcrites()).toEqual(['carrezArea']);
  });
});
