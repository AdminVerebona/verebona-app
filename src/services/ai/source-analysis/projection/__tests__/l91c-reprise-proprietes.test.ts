/**
 * Lot 91C — rattrapage des propriétés neutralisées : décision PURE sur une
 * ligne persistée (même règle que la projection), clé d'origine retrouvée
 * sans deviner, catalogue BO et rapport lisible. Aucune base.
 */
import { describe, expect, it } from 'vitest';
import { decideNeutralizedFact, originalAcquisitionKey } from '../property-evidence-reprise';
import { DOCUMENT_CATALOG } from '@/services/canonical/registry';
import { getAuthorityMatrix } from '@/services/ai/reconciliation/decision/authority-matrix';
import { backfillDefinition, validateBackfillRequest } from '@/services/admin/ops/backfill/definitions';
import { summarizeBackfill } from '@/services/admin/ops/backfill/report-format';
import { findTask } from '@/services/scheduling/scheduled-tasks.catalog';

/** Type qui engage sans prouver la réalisation (dérivé du catalogue et de la matrice). */
const ENGAGEANT = DOCUMENT_CATALOG.find((e) => e.authority === 'AUTHORITATIVE' && e.businessTypes.includes('purchase')
  && !e.completionProofs.some((p) => p.establishes === 'completed')
  && (getAuthorityMatrix().fieldOrders.acquisitionPrice ?? []).includes(e.code))!.code;

const ligne = (over: Record<string, unknown> = {}) => ({
  id: 10, account_id: 3, file_id: 77, raw_key: 'prixVente', label: 'Prix de vente', attribute: null,
  excerpt: 'Prix de vente : 263 000 €', evidence_origin: 'TEXT_EXTRACTION', confidence: 'certain', value_type: 'money_eur',
  target_type: 'ASSET', target_entity_id: 501, title: 'Avant-contrat', document_type_code: null, multi_asset: false,
  legacy_type: ENGAGEANT, target_ok: true, linked: true, ...over,
});

describe('L91C-R — décision du rattrapage', () => {
  it('clé d’origine : type de valeur de la clé du registre', () => {
    expect(originalAcquisitionKey('money_eur')).toBe('acquisitionPrice');
    expect(originalAcquisitionKey('date')).toBe('acquisitionDate');
    expect(originalAcquisitionKey('string')).toBeNull();
    expect(originalAcquisitionKey(null)).toBeNull();
  });

  it('prix d’un document qui engage, bien vérifié et rattaché : repris', () => {
    expect(decideNeutralizedFact(ligne())).toEqual({ ok: true, fieldKey: 'acquisitionPrice', assetId: 501, documentType: ENGAGEANT });
  });

  it.each([
    [{ value_type: 'date' }, 'FIELD_STATES_REALIZATION'],
    [{ value_type: 'string' }, 'KEY_NOT_RECOVERABLE'],
    [{ legacy_type: 'FACTURE' }, 'SOURCE_NOT_ADMISSIBLE'],
    [{ legacy_type: null, document_type_code: 'WORKS_INVOICE' }, 'SOURCE_NOT_ADMISSIBLE'],
    [{ document_type_code: 'ACQUISITION_PAYMENT' }, 'TRANSACTION_NOT_PURCHASE'],
    [{ title: 'Facture d’acompte' }, 'TRANSACTION_NOT_PURCHASE'],
    [{ multi_asset: true }, 'MULTI_ASSET'],
    [{ multi_asset: null }, 'MULTI_ASSET_UNKNOWN'],
    [{ target_ok: false }, 'TARGET_NOT_ESTABLISHED'],
    [{ target_entity_id: null }, 'TARGET_NOT_ESTABLISHED'],
    [{ target_type: 'EQUIPMENT' }, 'TARGET_NOT_ESTABLISHED'],
    [{ excerpt: null }, 'NO_LITERAL_EVIDENCE'],
    [{ evidence_origin: 'VISUAL_ANALYSIS' }, 'NO_LITERAL_EVIDENCE'],
    [{ label: 'Dépôt de garantie' }, 'PARTIAL_PAYMENT'],
    [{ excerpt: 'Valeur vénale estimée : 263 000 €' }, 'VALUATION_NOT_PRICE'],
    [{ confidence: 'conflictual' }, 'CONFLICTUAL'],
    [{ linked: false }, 'DOCUMENT_NOT_LINKED_TO_TARGET'],
  ])('%o → refus %s', (over, reason) => {
    expect(decideNeutralizedFact(ligne(over))).toMatchObject({ ok: false, reason });
  });
});

describe('L91C-R — BO et tâche planifiée', () => {
  it('entrée « Rattrapages » : simulation et application, filtre compte, motif obligatoire', () => {
    const def = backfillDefinition('projection-property-evidence')!;
    expect(def.actions).toEqual(['simulate', 'apply']);
    expect(def.accountFilter).toBe(true);
    expect(def.description).not.toMatch(/Opération/);
    expect(validateBackfillRequest({ script: 'projection-property-evidence', action: 'apply', reason: '' })).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(validateBackfillRequest({ script: 'projection-property-evidence', action: 'simulate', accountId: 4 })).toMatchObject({ ok: true });
    expect(validateBackfillRequest({ script: 'projection-property-evidence', action: 'restore', runId: '00000000-0000-0000-0000-000000000000' }))
      .toMatchObject({ ok: false, code: 'ACTION_NOT_SUPPORTED' });
  });

  it('rapport lisible, sans valeur de prix', () => {
    const s = summarizeBackfill('projection-property-evidence', 'apply', null, { result: {
      mode: 'apply', runId: 'x', origin: 'BO', scanned: 5, admitted: 2, requalified: 2, evidenceWritten: 2, assetsReconciled: 1,
      refused: { SOURCE_NOT_ADMISSIBLE: 2, FIELD_STATES_REALIZATION: 1 }, failed: 0, more: false,
      items: [
        { factId: 1, accountId: 3, fileId: 9, assetId: 4, fieldKey: 'acquisitionPrice', documentType: ENGAGEANT, outcome: 'REQUALIFIED', evidenceId: 12 },
        { factId: 2, accountId: 3, fileId: 8, assetId: 4, fieldKey: 'acquisitionPrice', documentType: 'FACTURE', outcome: 'REFUSED', reason: 'SOURCE_NOT_ADMISSIBLE' },
      ],
    } });
    expect(s.headline).toMatch(/2 repris/);
    expect(s.counters).toContainEqual({ label: 'Non repris : type de document non admis pour le prix d’achat', value: 2 });
    expect(s.warnings.join(' ')).toMatch(/document 8/);
    expect(JSON.stringify(s)).not.toMatch(/263/);
  });

  it('tâche planifiée déclarée', () => {
    expect(findTask('projection-property-evidence-reprise')).toMatchObject({ schedule: { kind: 'interval' } });
  });
});
