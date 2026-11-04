/**
 * Lot 109J — rejeu PUR des cas document ↔ Opération signalés par l'export
 * T3:6033 (compte de test 11), SANS aucun nom en dur dans le code testé :
 *   · contrat PNO n°21 (document 205, avis d'échéance 215) ;
 *   · contrat auto « Peugeot » n°31 (227 / 232 / 236, échéance 235) ;
 *   · contrat auto « Clio » n°41 (244 / 246, échéance 249) — MÊME assureur que 31 ;
 *   · réparation n°54 (devis 266, facture 263, référence SONY-REP-2026-113).
 * Attendus : rattachement sur RÉFÉRENCE économique exacte (M1), jamais de
 * fusion sur le seul assureur / prestataire (31 ≠ 41), devis et facture d'une
 * même référence sur la même Opération.
 */
import { describe, expect, it } from 'vitest';
import type { CandidateIdentity } from '../model';
import { decideCandidate, type ExistingOperation, type MatchContext } from '../matching';

const norm = (v: string) => v.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
const ref = (kind: CandidateIdentity['refs'][number]['kind'], value: string) => ({ kind, value, normalized: norm(value) });
const ASSUREUR = 'assurancesdesalpes';

function candidat(o: Partial<CandidateIdentity> & Pick<CandidateIdentity, 'fileId'>): CandidateIdentity {
  return {
    candidateId: o.fileId, candidateKey: 'op1', established: true, confidence: 'certain', type: 'CONTRACT', status: 'REALIZED',
    role: 'OTHER_EVIDENCE', summary: 'Avis d’échéance', provider: 'Assurances des Alpes', providerKey: ASSUREUR,
    assetIds: [], targetAuthority: 'DOCUMENT', equipmentIds: [], refs: [],
    dates: { plannedDate: null, startDate: null, realizedDate: null, endDate: null }, hints: [], ...o,
  };
}
function operation(o: Partial<ExistingOperation> & Pick<ExistingOperation, 'id'>): ExistingOperation {
  return {
    typeCode: 'CONTRACT', status: 'REALIZED', providerKey: ASSUREUR, assetIds: [], refs: [],
    plannedDate: null, startDate: null, realizedDate: null, endDate: null, periodic: true, ...o,
  };
}
const ctx = (operations: ExistingOperation[]): MatchContext => ({ operations, confirmed: new Set(), rejected: new Set(), assetStatus: new Map() });

// Opérations canoniques (contrats déjà établis par leur document fondateur).
const PNO = operation({ id: 21, assetIds: [1], refs: [{ kind: 'POLICY', normalized: norm('PNO-21') }], label: 'Contrat d’assurance propriétaire non occupant' });
const PEUGEOT = operation({ id: 31, assetIds: [2], refs: [{ kind: 'POLICY', normalized: norm('AUTO-31') }], label: 'Contrat d’assurance automobile' });
const CLIO = operation({ id: 41, assetIds: [3], refs: [{ kind: 'POLICY', normalized: norm('AUTO-41') }], label: 'Contrat d’assurance automobile' });
const REPARATION = operation({
  id: 54, typeCode: 'INTERVENTION', status: 'ENVISAGED', providerKey: 'sonyservice', assetIds: [4], periodic: false,
  refs: [{ kind: 'QUOTE', normalized: norm('SONY-REP-2026-113') }], label: 'Devis de réparation',
});
const TOUTES = [PNO, PEUGEOT, CLIO, REPARATION];

describe('L109J-REL — rattachements document ↔ Opération (cas 6033)', () => {
  it('L109J-REL-01 — avis d’échéance PNO (215) : référence de contrat exacte → rattaché à l’Opération 21 (M1)', () => {
    const d = decideCandidate(candidat({ fileId: 215, assetIds: [1], refs: [ref('POLICY', 'PNO 21')] }), ctx(TOUTES));
    expect(d).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 21 });
  });

  it('L109J-REL-02 — échéances auto 235 et 249 du MÊME assureur : chacune sur SON contrat, jamais l’autre', () => {
    const d31 = decideCandidate(candidat({ fileId: 235, assetIds: [2], refs: [ref('POLICY', 'AUTO-31')] }), ctx(TOUTES));
    const d41 = decideCandidate(candidat({ fileId: 249, assetIds: [3], refs: [ref('POLICY', 'AUTO-41')] }), ctx(TOUTES));
    expect(d31).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 31 });
    expect(d41).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 41 });
  });

  it('L109J-REL-03 — pièce de l’assureur SANS référence ni bien commun : jamais rattachée sur le seul fournisseur', () => {
    const d = decideCandidate(candidat({ fileId: 999, assetIds: [], refs: [] }), ctx(TOUTES));
    expect(d.outcome).not.toBe('MATCH_AND_ENRICH');
    expect(d.detail.certain).toEqual([]);
  });

  it('L109J-REL-04 — pièce d’un contrat auto portant la référence 41 mais visant le bien du 31 : aucune fusion automatique 31/41', () => {
    const d = decideCandidate(candidat({ fileId: 246, assetIds: [2], refs: [ref('POLICY', 'AUTO-41')] }), ctx(TOUTES));
    expect(d.operationId === 31 && d.outcome === 'MATCH_AND_ENRICH').toBe(false);
  });

  it('L109J-REL-05 — facture 263 de la réparation (référence du devis 266 reprise) : même Opération 54, nature compatible', () => {
    const d = decideCandidate(candidat({
      fileId: 263, type: 'INTERVENTION', role: 'INVOICE', provider: 'Sony Service', providerKey: 'sonyservice', assetIds: [4],
      refs: [ref('QUOTE', 'SONY-REP-2026-113'), ref('INVOICE', 'F-2026-0263')], summary: 'Facture de réparation',
      dates: { plannedDate: null, startDate: null, realizedDate: '2026-05-12', endDate: null },
    }), ctx(TOUTES));
    expect(d).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 54 });
  });

  it('L109J-REL-06 — même référence portée par un AUTRE prestataire : jamais un rattachement automatique (référence fragile)', () => {
    const d = decideCandidate(candidat({
      fileId: 777, type: 'INTERVENTION', role: 'INVOICE', provider: 'Autre Réparateur', providerKey: 'autrereparateur', assetIds: [4],
      refs: [ref('QUOTE', 'SONY-REP-2026-113')], summary: 'Facture de réparation',
    }), ctx(TOUTES));
    expect(d.outcome === 'MATCH_AND_ENRICH' && d.operationId === 54).toBe(false);
  });
});
