/**
 * Lot 109K — ticket « T1 couverture PDF + propagation », COR-02 (L109K-U-PROP).
 *
 * Règles pures : diff avant / après, incidences métier, réévaluation ciblée
 * d'un candidat par la barrière serveur existante, empreinte d'état
 * (convergence, déduplication), attribution, réparation pendant l'analyse.
 */
import { describe, expect, it } from 'vitest';
import {
  attributeFacts, candidateStateFingerprint, classifyFact, diffRepairFacts, enrichCandidatesWithRepairFacts, factCurrency,
  reevaluateCandidate, reevaluatedPayload, storedToAnchored, type PersistedFactRow, type StoredCandidateRow,
} from '../repair-propagation';
import type { T1FactWithRef } from '../../master/t1-contract';

let seq = 100;
const fait = (over: Partial<PersistedFactRow>): PersistedFactRow => ({
  id: ++seq, factKey: null, canonicalKey: null, rawKey: null, label: null, attribute: null, valueText: null, valueNumber: null, valueUnit: null,
  rawValue: null, valueType: null, excerpt: null, page: 1, evidenceOrigin: 'TEXT_EXTRACTION', confidence: 'certain', targetType: 'DOCUMENT',
  targetEntityId: null, targetEntityLabel: null, semanticEventType: null, semanticEventNature: null, sourceUnitIds: [], ...over,
});
const montant = (raw: string, over: Partial<PersistedFactRow> = {}) => fait({ label: 'Total TTC', rawValue: raw, valueText: raw, excerpt: `Total TTC ${raw}`, ...over });
const texte = (v: string) => fait({ label: 'Mention', rawValue: v, valueText: v, excerpt: v });

const candidat = (over: Partial<StoredCandidateRow> & { payload?: Record<string, unknown> } = {}): StoredCandidateRow => ({
  id: 1, candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'INTERVENTION', statusHint: 'ENVISAGED',
  summary: 'Traitement de charpente', ...over,
  payload: {
    sourceRoleHint: 'QUOTE', provider: 'Entreprise Exemple', targetHints: [{ type: 'ASSET', entityId: 7, rawLabel: 'Maison', confidence: 'certain' }],
    businessReferences: [{ kind: 'QUOTE', value: 'DV-2026-0042' }], temporalHints: {}, financialHints: [],
    evidence: [{ factId: 50, fingerprint: 'fp50', sourceUnitIds: ['u:1'] }], exclusionReason: null, adjustments: [], origin: 'PASS_1',
    ...(over.payload ?? {}),
  },
});
const gate = { documentTypeCode: 'QUOTE', verifiedIds: { ASSET: new Set([7]), EQUIPMENT: new Set<number>(), ROOM: new Set<number>() }, capabilities: { rooms: true, equipments: true } };

describe('L109K-U-PROP — diff et incidences métier', () => {
  it('classe montant, date, référence, prestataire, cible, nature, preuve de réalisation ; texte sans incidence', () => {
    expect(classifyFact(montant('880,00 €'))).toContain('AMOUNT');
    expect(classifyFact(fait({ label: 'Date du devis', rawValue: '04/11/2026', valueText: '2026-11-04', valueType: 'date' }))).toContain('DATE');
    expect(classifyFact(fait({ label: 'Devis n°', rawValue: 'DV-2026-0099', valueText: 'DV-2026-0099' }))).toContain('REFERENCE');
    expect(classifyFact(fait({ label: 'Prestataire', rawValue: 'Charpentes Durand', valueText: 'Charpentes Durand', targetType: 'SUPPLIER' }))).toContain('PROVIDER');
    expect(classifyFact(fait({ label: 'Bien', targetType: 'ASSET', targetEntityId: 7 }))).toContain('TARGET');
    expect(classifyFact(fait({ label: 'Travaux réalisés le', rawValue: '12/11/2026', semanticEventType: 'repair', semanticEventNature: 'HISTORICAL' })))
      .toEqual(expect.arrayContaining(['DATE', 'NATURE', 'REALIZATION_PROOF']));
    expect(classifyFact(texte('Merci de votre confiance'))).toEqual([]);
  });

  it('aucune incidence nouvelle : fait sans incidence, valeur déjà connue du document', () => {
    const avant = [montant('880,00 €')];
    const d1 = diffRepairFacts(avant, [...avant, texte('Conditions générales')]);
    expect(d1.added).toHaveLength(1);
    expect(d1.significant).toEqual([]);
    const d2 = diffRepairFacts(avant, [...avant, montant('880,00 EUR', { label: 'Net à payer' })]);
    expect(d2.significant).toEqual([]);
    const d3 = diffRepairFacts(avant, [...avant, montant('120,00 €', { label: 'Acompte' })]);
    expect(d3.categories).toEqual(['AMOUNT']);
    expect(diffRepairFacts(avant, avant).added).toEqual([]);
  });

  it('devise établie sur le fait (jamais présumée)', () => {
    expect(factCurrency({ rawValue: '880,00 €', valueText: null, excerpt: null, valueUnit: null }, 88_000).currency).toBe('EUR');
    expect(factCurrency({ rawValue: '880', valueText: null, excerpt: null, valueUnit: null }, 88_000).currency).toBe('XXX');
  });
});

describe('L109K-U-PROP — réévaluation ciblée par la barrière existante', () => {
  it('devis sans montant + montant récupéré → FORECAST_COST 880 € seulement, jamais REALIZED_COST', () => {
    const f = montant('880,00 €');
    const r = reevaluateCandidate(candidat(), [{ fact: f, kinds: ['AMOUNT'], rectifies: false }], gate);
    expect(r.after).not.toBe(r.before);
    expect(r.candidate!.financialHints).toEqual([expect.objectContaining({ role: 'FORECAST_COST', amountMinor: 88_000, currency: 'EUR', amountScope: 'TOTAL' })]);
    expect(r.candidate!.financialHints.some((h) => h.role === 'REALIZED_COST')).toBe(false);
    expect(r.changes).toEqual(expect.arrayContaining([`EVIDENCE_ADDED:${f.id}`, 'FINANCIAL_HINT_ADDED:FORECAST_COST']));
    // Payload : preuve et provenance attachées au fait PERSISTÉ, rien d'effacé.
    const p = reevaluatedPayload(candidat().payload, r, { origin: 'test' });
    expect(p.evidenceFactIds).toEqual([50, f.id]);
    expect((p.financialHints as Array<{ evidence: { factId: number } }>)[0].evidence.factId).toBe(f.id);
    expect(p.businessReferences).toEqual([{ kind: 'QUOTE', value: 'DV-2026-0042' }]);
  });

  it('facture : montant récupéré → REALIZED_COST (la facture est le justificatif)', () => {
    const c = candidat({ statusHint: 'REALIZED', payload: { sourceRoleHint: 'INVOICE' } });
    const r = reevaluateCandidate(c, [{ fact: montant('880,00 €'), kinds: ['AMOUNT'], rectifies: false }], { ...gate, documentTypeCode: 'INVOICE' });
    expect(r.candidate!.financialHints[0]).toMatchObject({ role: 'REALIZED_COST', amountMinor: 88_000 });
  });

  it('devis + preuve de réalisation : jamais REALIZED (statut, date) — la preuve est jointe, T3 décide', () => {
    const f = fait({ label: 'Travaux réalisés le', rawValue: '12/11/2026', semanticEventNature: 'HISTORICAL' });
    const r = reevaluateCandidate(candidat(), [{ fact: f, kinds: ['DATE', 'REALIZATION_PROOF'], rectifies: false }], gate);
    expect(r.candidate!.statusHint).not.toBe('REALIZED');
    expect(r.candidate!.temporalHints.realizedDate).toBeUndefined();
    expect(r.changes).toContain('REALIZATION_PROOF_ON_FORECAST_SOURCE');
  });

  it('contributions établies conservées : montant, prestataire différents → conflit tracé, jamais substitué', () => {
    const c = candidat({ payload: {
      provider: 'Entreprise Exemple',
      financialHints: [{ role: 'FORECAST_COST', amountMinor: 88_000, currency: 'EUR', amountScope: 'TOTAL', evidence: { factId: 50, fingerprint: 'fp50' } }],
    } });
    const r = reevaluateCandidate(c, [
      { fact: montant('990,00 €'), kinds: ['AMOUNT'], rectifies: true },
      { fact: fait({ label: 'Prestataire', rawValue: 'Autre Société', targetType: 'SUPPLIER' }), kinds: ['PROVIDER'], rectifies: false },
    ], gate);
    expect(r.changes).toEqual(expect.arrayContaining(['AMOUNT_CONFLICT_KEPT', 'PROVIDER_CONFLICT_KEPT']));
    expect(r.candidate!.financialHints).toHaveLength(1);
    expect(r.candidate!.financialHints[0].amountMinor).toBe(88_000);
    expect(r.candidate!.provider).toBe('Entreprise Exemple');
  });

  it('cible non vérifiée : neutralisée par la barrière (monde fermé)', () => {
    const r = reevaluateCandidate(candidat(), [{ fact: fait({ targetType: 'ASSET', targetEntityId: 999, targetEntityLabel: 'Inconnu' }), kinds: ['TARGET'], rectifies: false }], gate);
    expect(r.candidate!.targetHints.find((t) => t.rawLabel === 'Inconnu')?.entityId).toBeNull();
  });

  it('convergence : la nouvelle version réévaluée avec les mêmes faits ne change plus d’état (aucun second signal)', () => {
    const f = montant('880,00 €');
    const r1 = reevaluateCandidate(candidat(), [{ fact: f, kinds: ['AMOUNT'], rectifies: false }], gate);
    const v2 = candidat({ id: 2, payload: reevaluatedPayload(candidat().payload, r1, { origin: 'test' }) });
    const { candidate, anchors } = storedToAnchored(v2);
    expect(candidateStateFingerprint(candidate, anchors)).toBe(r1.after);
    const r2 = reevaluateCandidate(v2, [{ fact: f, kinds: ['AMOUNT'], rectifies: false }], gate);
    expect(r2.after).toBe(r2.before);
  });

  it('attribution : plusieurs candidats → seulement par unité source ou cible communes', () => {
    const a = candidat({ candidateKey: 'a' });
    const b = candidat({ candidateKey: 'b', id: 2, payload: { evidence: [{ factId: 60, fingerprint: 'fp60', sourceUnitIds: ['u:9'] }], targetHints: [] } });
    const fA = { fact: montant('10,00 €', { sourceUnitIds: ['u:1:cell:2'] }), kinds: ['AMOUNT' as const], rectifies: false };
    const fX = { fact: montant('20,00 €', { sourceUnitIds: ['u:77'], targetType: 'DOCUMENT' }), kinds: ['AMOUNT' as const], rectifies: false };
    const m = attributeFacts([a, b], [fA, fX]);
    expect(m.get('a')?.map((x) => x.fact.id)).toEqual([fA.fact.id]);
    expect(m.has('b')).toBe(false);
  });
});

describe('L109K-U-PROP — réparation pendant l’analyse (avant persistance)', () => {
  const t1 = (o: Partial<T1FactWithRef>): T1FactWithRef => ({
    canonicalKey: null, rawKey: null, label: null, rawValue: null, normalizedValue: null, target: { type: 'DOCUMENT', entityId: null, confidence: 'certain', evidenceSignals: [] },
    provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: {}, ...o,
  } as T1FactWithRef);
  const base = { candidateKey: 'op1', established: true, confidence: 'certain' as const, typeHint: 'INTERVENTION' as const, statusHint: 'ENVISAGED' as const,
    summary: 'Traitement', sourceRoleHint: 'QUOTE' as const, provider: 'Entreprise Exemple', targetHints: [], businessReferences: [], temporalHints: {},
    financialHints: [], evidenceFactRefs: ['fpA'], visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1' as const, adjustments: [] };

  it('montant apporté par la réparation : ancré sur l’empreinte du fait, FORECAST_COST ; texte seul : rien', () => {
    const repare = t1({ label: 'Total TTC', rawValue: '880,00 €', normalizedValue: '880,00 €', evidence: { excerpt: 'Total TTC 880,00 €', page: 2 }, t1FactRef: 'fpR' });
    const r = enrichCandidatesWithRepairFacts([base], { baseFacts: [t1({ label: 'Objet', rawValue: 'Traitement', t1FactRef: 'fpA' })], repairFacts: [repare], gate });
    expect(r.candidates[0].financialHints).toEqual([expect.objectContaining({ role: 'FORECAST_COST', amountMinor: 88_000, factRef: 'fpR' })]);
    expect(r.candidates[0].evidenceFactRefs).toEqual(['fpA', 'fpR']);
    expect(r.candidates[0].adjustments).toContain('REPAIR_ENRICHED');
    const rien = enrichCandidatesWithRepairFacts([base], { baseFacts: [], repairFacts: [t1({ label: 'Mention', rawValue: 'Merci', t1FactRef: 'fpT' })], gate });
    expect(rien.candidates[0]).toEqual(base);
  });
});
