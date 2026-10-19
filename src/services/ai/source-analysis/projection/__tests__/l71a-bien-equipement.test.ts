/**
 * Lot 71A — BUG P1 « confusion des données entre biens et équipements »
 * (projection T1 déterministe, code seulement — prompts inchangés).
 *
 * EQP-01  Facture d'achat d'un ÉQUIPEMENT déposée sur la maison : les faits
 *         d'acquisition ciblant l'équipement restent sur l'équipement ; la
 *         règle « justificatif d'achat du bien » ne déduit JAMAIS la date ni
 *         le prix d'achat de la MAISON depuis la date / le montant du document.
 * EQP-02  Achat d'un équipement (ligne d'achat ciblant l'équipement) : sa
 *         date et son prix d'achat sont conservés (plus retirés comme « pièce
 *         détachée ») ; l'acquisition du bien reste exclue.
 * EQP-03  Même preuve (valeur + extrait) pour le bien ET un équipement :
 *         acte authentique → la valeur est celle du BIEN (fait d'équipement
 *         requalifié en connaissance générique) ; facture → celle de
 *         l'ÉQUIPEMENT (fait du bien requalifié). Jamais les deux.
 * EQP-03b Valeurs différentes ou extraits différents : rien n'est requalifié
 *         (deux acquisitions distinctes, une date identique ne prouve rien).
 * EQP-04  Non-régression : ticket d'achat du bien seul inchangé (P-T1-02).
 */
import { describe, it, expect } from 'vitest';
import { T1AnalyzeDocumentOutput, type T1Fact } from '../../master/t1-contract';
import { checkFactEvidence } from '../../master/fact-evidence';
import { projectDocumentFacts, type ProjectionContext } from '../document-projection';
import { PROJECTION_RULES } from '../rules';
import { loadT1Fixture } from '../../__fixtures__/t1/load';

const MAISON = 30;
const ROBOT = 502;
const CHAUDIERE = 501;

function ctx(): ProjectionContext {
  return {
    knownAssetId: MAISON,
    documentAssetId: MAISON,
    assetFamilies: new Map([[MAISON, 'IMMOBILIER']]),
    verifiedIds: { ASSET: new Set([MAISON]), EQUIPMENT: new Set([ROBOT, CHAUDIERE]), ROOM: new Set(), SUPPLIER: new Set() },
  };
}

const cible = (type: 'ASSET' | 'EQUIPMENT', entityId: number) => ({
  type, entityId, rawLabel: type === 'ASSET' ? 'Maison' : 'Robot aspirateur', confidence: 'certain', evidenceSignals: [],
});
const fait = (canonicalKey: string | null, value: string | number, excerpt: string, t: ReturnType<typeof cible>, over: Record<string, unknown> = {}) => ({
  canonicalKey, rawValue: String(value), normalizedValue: value,
  valueType: canonicalKey === 'acquisitionPrice' ? 'money_eur' : canonicalKey === 'acquisitionDate' ? 'date' : 'string',
  canonicalUnit: canonicalKey === 'acquisitionPrice' ? 'EUR' : null,
  target: t, provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt, page: 1 }, ...over,
});

/** Sortie T1 d'une facture (ou d'un acte) déposée sur la maison. */
function analyse(p: { canonicalType: string; documentTypeCode: string | null; facts: unknown[]; title?: string }) {
  const base = loadT1Fixture('t1-04-equipement-chaudiere.json').recording.output as Record<string, unknown>;
  const out = {
    ...base,
    document: {
      title: { value: p.title ?? 'Facture Robot aspirateur', confidence: 'certain', evidence: { excerpt: 'FACTURE', page: 1 } },
      documentDate: { value: '2025-03-10', confidence: 'certain', evidence: { excerpt: 'Date : 10/03/2025', page: 1 } },
      amountCents: { value: 49900, confidence: 'certain', evidence: { excerpt: 'Total TTC 499,00 €', page: 1 } },
      classification: {
        canonicalType: p.canonicalType, rubricCode: 'PROPERTY_MANAGEMENT', documentTypeCode: p.documentTypeCode,
        confidence: 0.95, evidence: { excerpt: 'FACTURE' },
      },
    },
    entities: {
      assets: [{ entityId: MAISON, rawLabel: 'Maison', score: 0.97, confidence: 'certain', evidenceSignals: ['12 rue Exemple'], reason: 'adresse' }],
      rooms: [], equipments: [{ entityId: ROBOT, rawLabel: 'Robot aspirateur', score: 0.95, confidence: 'certain', evidenceSignals: ['ROOMBA'], reason: 'désignation' }],
      suppliers: [], multiAsset: false,
    },
    transcription: 'FACTURE\nRobot aspirateur Roomba i7 499,00 €\nTotal TTC 499,00 €',
    tables: [],
    facts: p.facts,
    hasExploitableContent: true,
  };
  const parsed = T1AnalyzeDocumentOutput.parse(out);
  const facts = parsed.facts.map(checkFactEvidence).filter((c) => c.ok).map((c) => (c as { fact: T1Fact }).fact);
  return projectDocumentFacts({ ...parsed, facts }, ctx());
}

const sur = (type: string, id: number) => (f: { target: { targetType: string; targetEntityId: number | null } }) =>
  f.target.targetType === type && f.target.targetEntityId === id;

describe('EQP-01 — facture d’achat d’un équipement déposée sur le bien', () => {
  it('aucune date ni aucun prix d’achat du BIEN déduits du document ; ceux de l’équipement conservés', () => {
    const p = analyse({
      canonicalType: 'FACTURE', documentTypeCode: 'ACQUISITION_INVOICE',
      facts: [
        fait('acquisitionDate', '2025-03-10', 'Date d’achat : 10/03/2025', cible('EQUIPMENT', ROBOT)),
        fait('acquisitionPrice', 499, 'Total TTC 499,00 €', cible('EQUIPMENT', ROBOT)),
      ],
    });
    const acquisitionsBien = p.facts.filter((f) => ['acquisitionDate', 'acquisitionPrice'].includes(f.canonicalKey ?? '') && sur('ASSET', MAISON)(f));
    expect(acquisitionsBien).toEqual([]);
    expect(p.facts.filter((f) => f.canonicalKey && sur('EQUIPMENT', ROBOT)(f)).map((f) => [f.canonicalKey, f.value]))
      .toEqual([['acquisitionDate', '2025-03-10'], ['acquisitionPrice', 499]]);
    expect(p.appliedRules).toContain(PROJECTION_RULES.EQUIPMENT_PURCHASE_NO_ASSET_ACQUISITION);
  });
});

describe('EQP-02 — achat d’un équipement (ligne d’achat ciblant l’équipement)', () => {
  it('date et prix d’achat de l’équipement conservés ; aucune acquisition du bien', () => {
    const p = analyse({
      canonicalType: 'FACTURE', documentTypeCode: 'ACQUISITION_INVOICE',
      facts: [
        fait(null, 'Robot aspirateur Roomba i7', 'Robot aspirateur Roomba i7 499,00 €', cible('EQUIPMENT', ROBOT),
          { rawKey: 'désignation', semanticEvent: { type: 'purchase', nature: 'HISTORICAL' } }),
        fait('acquisitionDate', '2025-03-10', 'Date d’achat : 10/03/2025', cible('EQUIPMENT', ROBOT)),
        fait('acquisitionPrice', 499, 'Total TTC 499,00 €', cible('EQUIPMENT', ROBOT)),
      ],
    });
    expect(p.purpose).toBe('PART_PURCHASE');
    expect(p.facts.filter((f) => f.canonicalKey && sur('EQUIPMENT', ROBOT)(f)).map((f) => f.canonicalKey))
      .toEqual(['acquisitionDate', 'acquisitionPrice']);
    expect(p.facts.some((f) => ['acquisitionDate', 'acquisitionPrice'].includes(f.canonicalKey ?? '') && sur('ASSET', MAISON)(f))).toBe(false);
  });

  it('pièce détachée POUR un équipement (achat ciblant un autre équipement) : acquisition de l’équipement retirée', () => {
    const p = analyse({
      canonicalType: 'FACTURE', documentTypeCode: 'ACQUISITION_INVOICE',
      facts: [
        fait(null, 'Brosse latérale', 'Brosse latérale 19,00 €', cible('EQUIPMENT', CHAUDIERE),
          { rawKey: 'désignation', semanticEvent: { type: 'purchase', nature: 'HISTORICAL' } }),
        fait('acquisitionPrice', 19, 'Brosse latérale 19,00 €', cible('EQUIPMENT', ROBOT)),
      ],
    });
    expect(p.purpose).toBe('PART_PURCHASE');
    expect(p.facts.some((f) => f.canonicalKey === 'acquisitionPrice')).toBe(false);
  });
});

describe('EQP-03 — même preuve pour le bien ET l’équipement : jamais les deux', () => {
  const doublon = (canonicalType: string, documentTypeCode: string | null) => analyse({
    canonicalType, documentTypeCode, title: canonicalType === 'ACTE_NOTARIE' ? 'Acte de vente' : 'Facture',
    facts: [
      fait('acquisitionDate', '2019-06-14', 'Signé le 14/06/2019', cible('ASSET', MAISON)),
      fait('acquisitionDate', '2019-06-14', 'Signé le 14/06/2019', cible('EQUIPMENT', ROBOT)),
    ],
  });

  it('acte authentique : la date est celle du BIEN, le fait d’équipement devient générique', () => {
    const p = doublon('ACTE_NOTARIE', null);
    expect(p.facts.filter((f) => f.canonicalKey === 'acquisitionDate').map((f) => f.target.targetType)).toEqual(['ASSET']);
    const generique = p.facts.find((f) => f.canonicalKey === null && sur('EQUIPMENT', ROBOT)(f));
    expect(generique).toMatchObject({ rawKey: 'acquisitionDate', ruleCode: PROJECTION_RULES.ENTITY_ACQUISITION_SAME_EVIDENCE_AS_ASSET });
  });

  it('facture : la date est celle de l’ÉQUIPEMENT, le fait du bien devient générique (aucune déduction pour le bien)', () => {
    const p = doublon('FACTURE', 'ACQUISITION_INVOICE');
    expect(p.facts.filter((f) => f.canonicalKey === 'acquisitionDate').map((f) => f.target.targetType)).toEqual(['EQUIPMENT']);
    expect(p.facts.find((f) => f.canonicalKey === null && sur('ASSET', MAISON)(f)))
      .toMatchObject({ rawKey: 'acquisitionDate', ruleCode: PROJECTION_RULES.ASSET_ACQUISITION_SAME_EVIDENCE_AS_EQUIPMENT });
    expect(p.facts.some((f) => f.canonicalKey === 'acquisitionPrice' && sur('ASSET', MAISON)(f))).toBe(false);
  });

  it('EQP-03b — même date mais extraits différents : deux acquisitions distinctes, rien n’est requalifié', () => {
    const p = analyse({
      canonicalType: 'ACTE_NOTARIE', documentTypeCode: null, title: 'Acte de vente',
      facts: [
        fait('acquisitionDate', '2019-06-14', 'Signé le 14/06/2019', cible('ASSET', MAISON)),
        fait('acquisitionDate', '2019-06-14', 'Robot acheté le 14/06/2019', cible('EQUIPMENT', ROBOT)),
      ],
    });
    expect(p.facts.filter((f) => f.canonicalKey === 'acquisitionDate').map((f) => f.target.targetType).sort()).toEqual(['ASSET', 'EQUIPMENT']);
  });
});

describe('EQP-04 — non-régression : achat du bien seul', () => {
  it('ticket de la draisienne : date et prix d’acquisition du bien toujours déduits', () => {
    const f = loadT1Fixture('p-t1-02-ticket-draisienne.json');
    const parsed = T1AnalyzeDocumentOutput.parse(f.recording.output);
    const facts = parsed.facts.map(checkFactEvidence).filter((c) => c.ok).map((c) => (c as { fact: T1Fact }).fact);
    const p = projectDocumentFacts({ ...parsed, facts }, {
      knownAssetId: 184, documentAssetId: 184, assetFamilies: new Map([[184, 'OBJECT']]),
      verifiedIds: { ASSET: new Set([184]), EQUIPMENT: new Set(), ROOM: new Set(), SUPPLIER: new Set() },
    });
    expect(p.facts.filter((x) => x.origin === 'DETERMINISTIC_RULE').map((x) => x.canonicalKey).sort()).toEqual(['acquisitionDate', 'acquisitionPrice']);
  });
});
