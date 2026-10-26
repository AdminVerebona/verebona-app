/**
 * Lot 91C — projection T1 : la preuve d'une PROPRIÉTÉ métier n'est plus
 * confondue avec la preuve de RÉALISATION d'un événement.
 *
 *   L91C-01  document qui ENGAGE sans prouver la réalisation (déduit du
 *            catalogue documentaire et de la matrice d'autorité — aucun type
 *            codé en dur) : prix extrait, ciblé, prouvé → preuve canonique
 *            conservée, sans événement réalisé ni date d'acquisition ;
 *   L91C-02  la date d'acquisition reste une RÉALISATION : jamais établie
 *            par un tel document ;
 *   L91C-03  acte définitif : comportement inchangé (achat réalisé) ;
 *   L91C-04  facture de travaux / facture sans finalité / devis : jamais
 *            un prix d'acquisition ;
 *   L91C-05  acompte, dépôt de garantie, somme versée, preuve de paiement :
 *            jamais le prix total ;
 *   L91C-06  équipement : jamais rabattu sur le bien ;
 *   L91C-07  multi-biens, cible ambiguë ou non vérifiée : aucune attribution ;
 *   L91C-08  valeur estimée ≠ prix de transaction ;
 *   L91C-09  devise, preuve littérale, confiance ;
 *   L91C-10  règle pure `admitsPropertyWithoutRealization`.
 *
 * Fonction PURE : aucun mock, aucune base. Valeurs, noms de biens et
 * identifiants variés : aucun cas ne dépend d'une valeur particulière.
 */
import { describe, expect, it } from 'vitest';
import { T1AnalyzeDocumentOutput, type T1Fact } from '../../master/t1-contract';
import { checkFactEvidence } from '../../master/fact-evidence';
import { projectDocumentFacts, type ProjectionContext } from '../document-projection';
import { PROJECTION_RULES, admitsPropertyWithoutRealization, fieldStatesRealization, sourceAdmissibleForProperty } from '../rules';
import { agendaCandidatesFromFacts } from '../../master/to-source-analysis-result';
import { DOCUMENT_CATALOG, resolveDocumentType } from '@/services/canonical/registry';
import { getAuthorityMatrix } from '@/services/ai/reconciliation/decision/authority-matrix';

type Json = Record<string, any>;

/**
 * Types documentaires qui ENGAGENT une acquisition sans en prouver la
 * réalisation, lus dans le catalogue (aucune preuve `completed` d'achat) et
 * cités par l'ordre d'autorité du prix d'achat. Dérivés, jamais listés à la main.
 */
const ENGAGEANTS = DOCUMENT_CATALOG.filter((e) => e.businessTypes.includes('purchase')
  && !e.completionProofs.some((p) => p.establishes === 'completed')
  && (getAuthorityMatrix().fieldOrders.acquisitionPrice ?? []).includes(e.code)
  && e.authority === 'AUTHORITATIVE').map((e) => e.code);
/** Acte qui prouve la réalisation (preuve `completed` purchase), cité par la même matrice. */
const REALISANTS = DOCUMENT_CATALOG.filter((e) => e.authority === 'AUTHORITATIVE'
  && e.completionProofs.some((p) => p.establishes === 'completed' && (p.businessTypes ?? e.businessTypes).includes('purchase'))
  && (getAuthorityMatrix().fieldOrders.acquisitionPrice ?? []).includes(e.code)).map((e) => e.code);

/** Variantes génériques : biens, valeurs, libellés. */
const CAS = [
  { assetId: 7301, nom: 'Appartement Rivoli', euros: 312_500, brut: '312 500 €', extrait: 'Prix de vente : 312 500 €' },
  { assetId: 42, nom: 'Chalet', euros: 1_085_000.5, brut: '1 085 000,50 EUR', extrait: 'moyennant le prix de 1 085 000,50 EUR' },
  { assetId: 918, nom: 'Local commercial', euros: 74_900, brut: '74 900 €', extrait: 'Le prix convenu est fixé à 74 900 €' },
];

interface Opts {
  canonicalType: string | null;
  documentTypeCode?: string | null;
  rubricCode?: string | null;
  title?: string;
  facts: Json[];
  multiAsset?: boolean;
  assets?: Json[];
  transcription?: string;
  amountCents?: Json;
}

function projeter(o: Opts, ctx0: { assetId: number; equipmentIds?: number[]; verifiedAssets?: number[] }) {
  const titre = o.title ?? 'Document';
  const parsed = T1AnalyzeDocumentOutput.parse({
    task: 'ANALYZE_DOCUMENT',
    document: {
      title: { value: titre, confidence: 'certain', evidence: { excerpt: titre, page: 1 } },
      documentDate: { value: '2026-03-14', confidence: 'certain', evidence: { excerpt: 'Fait le 14/03/2026', page: 1 } },
      classification: {
        canonicalType: o.canonicalType, documentTypeCode: o.documentTypeCode ?? null, rubricCode: o.rubricCode ?? null,
        confidence: 0.95, evidence: { excerpt: titre, page: 1 },
      },
      ...(o.amountCents ? { amountCents: o.amountCents } : {}),
    },
    entities: {
      assets: o.assets ?? [{ entityId: ctx0.assetId, rawLabel: 'Bien', score: 0.97, confidence: 'certain', evidenceSignals: [], reason: 'lu' }],
      rooms: [], equipments: [], suppliers: [], multiAsset: o.multiAsset ?? false,
    },
    transcription: o.transcription ?? `${titre}\n${o.facts.map((f) => f.evidence?.excerpt ?? '').join('\n')}`,
    tables: [], facts: o.facts, hasExploitableContent: true,
  });
  const facts = parsed.facts.map(checkFactEvidence).filter((c) => c.ok).map((c) => (c as { fact: T1Fact }).fact);
  const ctx: ProjectionContext = {
    knownAssetId: ctx0.assetId, documentAssetId: ctx0.assetId,
    assetFamilies: new Map([[ctx0.assetId, 'IMMOBILIER' as const], ...(ctx0.verifiedAssets ?? []).map((id) => [id, 'IMMOBILIER' as const] as const)]),
    verifiedIds: {
      ASSET: new Set([ctx0.assetId, ...(ctx0.verifiedAssets ?? [])]), EQUIPMENT: new Set(ctx0.equipmentIds ?? []),
      ROOM: new Set<number>(), SUPPLIER: new Set<number>(),
    },
  };
  const p = projectDocumentFacts({ ...parsed, facts }, ctx);
  return { p, byKey: (k: string) => p.facts.filter((x) => x.canonicalKey === k), ctx };
}

const prix = (c: typeof CAS[number], over: Json = {}) => ({
  canonicalKey: 'acquisitionPrice', rawKey: 'prixVente', label: 'Prix de vente', subject: null, attribute: null,
  rawValue: c.brut, normalizedValue: c.euros, valueType: 'money_eur', canonicalUnit: 'EUR',
  target: { type: 'ASSET', entityId: c.assetId, rawLabel: c.nom, confidence: 'certain', evidenceSignals: [c.nom] },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: c.extrait, page: 2 },
  ...over,
});

describe('L91C-01 — document qui engage sans prouver la réalisation : la propriété est conservée', () => {
  it('le catalogue et la matrice désignent au moins un tel type (aucune liste codée ici)', () => {
    expect(ENGAGEANTS.length).toBeGreaterThan(0);
    expect(REALISANTS.length).toBeGreaterThan(0);
    for (const t of ENGAGEANTS) expect(sourceAdmissibleForProperty('acquisitionPrice', resolveDocumentType(t))).toBe(true);
  });

  for (const type of ENGAGEANTS) {
    for (const c of CAS) {
      it(`${type} · ${c.nom} : preuve canonique du prix, sans événement ni date d’acquisition`, () => {
        const { p, byKey, ctx } = projeter({ canonicalType: type, title: `Avant-contrat — ${c.nom}`, facts: [prix(c)] }, { assetId: c.assetId });
        expect(p.purpose).toBe('OTHER'); // la RÉALISATION n'est pas prouvée…
        expect(byKey('acquisitionPrice')).toEqual([expect.objectContaining({
          // … mais la PROPRIÉTÉ l'est : clé canonique, valeur, cible, preuve intactes.
          canonicalKey: 'acquisitionPrice', value: c.euros, origin: 'MODEL_CANONICAL', semanticEvent: null,
          ruleCode: PROJECTION_RULES.PROPERTY_EVIDENCE_WITHOUT_REALIZATION, confidence: 'certain',
          target: expect.objectContaining({ targetType: 'ASSET', targetEntityId: c.assetId }),
          evidence: expect.objectContaining({ excerpt: c.extrait }),
        })]);
        expect(p.appliedRules).toContain(PROJECTION_RULES.PROPERTY_EVIDENCE_WITHOUT_REALIZATION);
        expect(p.appliedRules).not.toContain(PROJECTION_RULES.ACQUISITION_WITHOUT_PURCHASE_PROOF);
        // Aucun achat réalisé inventé : ni date, ni événement purchase, ni règle déterministe, ni agenda.
        expect(byKey('acquisitionDate')).toHaveLength(0);
        expect(p.facts.some((f) => f.semanticEvent?.type === 'purchase')).toBe(false);
        expect(p.facts.some((f) => f.origin === 'DETERMINISTIC_RULE')).toBe(false);
        expect(agendaCandidatesFromFacts(p.facts, { documentAssetId: ctx.documentAssetId, multiAsset: p.multiAsset })).toEqual([]);
      });
    }
  }

  it('un événement purchase HISTORICAL proposé par le modèle sur le prix est retiré (aucune réalisation affirmée)', () => {
    const c = CAS[0];
    const { byKey } = projeter({ canonicalType: ENGAGEANTS[0], facts: [prix(c, { semanticEvent: { type: 'purchase', nature: 'HISTORICAL' } })] }, { assetId: c.assetId });
    expect(byKey('acquisitionPrice')[0]).toMatchObject({ semanticEvent: null, ruleCode: PROJECTION_RULES.PROPERTY_EVIDENCE_WITHOUT_REALIZATION });
  });
});

describe('L91C-02 — la date d’acquisition date la réalisation : jamais établie sans preuve de réalisation', () => {
  it('registre : acquisitionDate date une réalisation, acquisitionPrice non', () => {
    expect(fieldStatesRealization('acquisitionDate')).toBe(true);
    expect(fieldStatesRealization('acquisitionPrice')).toBe(false);
  });

  it('date proposée par le modèle → connaissance générique ; prix conservé', () => {
    const c = CAS[2];
    const { p, byKey } = projeter({ canonicalType: ENGAGEANTS[0], facts: [
      prix(c),
      { canonicalKey: 'acquisitionDate', rawKey: 'dateSignature', label: 'Date de signature', rawValue: '14/03/2026', normalizedValue: '2026-03-14',
        valueType: 'date', target: { type: 'ASSET', entityId: c.assetId, confidence: 'certain' }, provenance: 'TEXT_EXTRACTION',
        confidence: 'certain', evidence: { excerpt: 'Fait le 14/03/2026', page: 1 } },
    ] }, { assetId: c.assetId });
    expect(byKey('acquisitionDate')).toHaveLength(0);
    expect(p.facts.find((f) => f.rawKey === 'dateSignature')).toMatchObject({ canonicalKey: null, origin: 'GENERIC', ruleCode: PROJECTION_RULES.ACQUISITION_WITHOUT_PURCHASE_PROOF });
    expect(byKey('acquisitionPrice')).toHaveLength(1);
  });
});

describe('L91C-03 — acte définitif : comportement inchangé', () => {
  for (const type of REALISANTS) {
    it(`${type} : achat réalisé (événement purchase, date d’acquisition déduite)`, () => {
      const c = CAS[1];
      const { p, byKey } = projeter({ canonicalType: type, facts: [prix(c)] }, { assetId: c.assetId });
      expect(p.purpose).toBe('ASSET_PURCHASE');
      expect(byKey('acquisitionPrice')[0]).toMatchObject({ value: c.euros, semanticEvent: { type: 'purchase', nature: 'HISTORICAL' },
        ruleCode: PROJECTION_RULES.PURCHASE_EVENT_ON_ACQUISITION });
      expect(byKey('acquisitionDate')[0]).toMatchObject({ value: '2026-03-14', ruleCode: PROJECTION_RULES.PURCHASE_RECEIPT_ACQUISITION_DATE });
      expect(p.appliedRules).not.toContain(PROJECTION_RULES.PROPERTY_EVIDENCE_WITHOUT_REALIZATION);
    });
  }
});

describe('L91C-04 — facture de travaux, facture sans finalité, devis : jamais un prix d’acquisition', () => {
  it('facture de travaux (type V2 de prestation) : prix retiré', () => {
    const c = CAS[0];
    const { p, byKey } = projeter({ canonicalType: 'FACTURE', documentTypeCode: 'WORKS_INVOICE', facts: [prix(c, { label: 'Total TTC' })] }, { assetId: c.assetId });
    expect(p.purpose).toBe('SERVICE');
    expect(byKey('acquisitionPrice')).toHaveLength(0);
  });

  it('facture d’entretien énonçant une intervention réalisée : prix retiré', () => {
    const c = CAS[2];
    const { p, byKey } = projeter({ canonicalType: 'FACTURE', facts: [
      prix(c, { label: 'Total TTC' }),
      { canonicalKey: null, rawKey: 'intervention', rawValue: 'Entretien chaudière', normalizedValue: 'Entretien chaudière', valueType: 'string',
        target: { type: 'ASSET', entityId: c.assetId, confidence: 'certain' }, provenance: 'TEXT_EXTRACTION', confidence: 'certain',
        evidence: { excerpt: 'Entretien chaudière réalisé', page: 1 }, semanticEvent: { type: 'maintenance', nature: 'HISTORICAL' } },
    ] }, { assetId: c.assetId });
    expect(p.purpose).toBe('SERVICE');
    expect(byKey('acquisitionPrice')).toHaveLength(0);
  });

  it('facture sans finalité établie (justificatif SUPPORTING) : connaissance générique, comme avant', () => {
    const c = CAS[1];
    const { p, byKey } = projeter({ canonicalType: 'FACTURE', facts: [prix(c, { label: 'Total' })] }, { assetId: c.assetId });
    expect(p.purpose).toBe('OTHER');
    expect(byKey('acquisitionPrice')).toHaveLength(0);
    expect(p.facts.find((f) => f.rawKey === 'prixVente')).toMatchObject({ canonicalKey: null, ruleCode: PROJECTION_RULES.ACQUISITION_WITHOUT_PURCHASE_PROOF });
  });

  it('devis, bon de commande : jamais admis', () => {
    for (const t of ['DEVIS', 'BON_COMMANDE']) {
      const c = CAS[0];
      const { byKey } = projeter({ canonicalType: t, facts: [prix(c)] }, { assetId: c.assetId });
      expect(byKey('acquisitionPrice')).toHaveLength(0);
    }
  });
});

describe('L91C-05 — acompte, dépôt de garantie, paiement : jamais le prix total', () => {
  const c = CAS[0];
  const libelles: Json[] = [
    { label: 'Dépôt de garantie', evidence: { excerpt: 'Dépôt de garantie : 31 250 €', page: 2 } },
    { label: 'Acompte', evidence: { excerpt: 'Acompte de 31 250 €', page: 2 } },
    { label: 'Prix', evidence: { excerpt: 'Somme versée ce jour : 31 250 €', page: 2 } },
    { label: 'Prix', evidence: { excerpt: 'Indemnité d’immobilisation 31 250 €', page: 2 } },
    { label: 'Prix', evidence: { excerpt: 'Solde à régler : 31 250 €', page: 2 } },
  ];
  for (const l of libelles) {
    it(`« ${l.evidence.excerpt} » : connaissance générique`, () => {
      const { byKey } = projeter({ canonicalType: ENGAGEANTS[0], facts: [prix(c, l)] }, { assetId: c.assetId });
      expect(byKey('acquisitionPrice')).toHaveLength(0);
    });
  }

  it('document de paiement (type V2 de paiement) ou facture d’acompte : jamais admis', () => {
    const p1 = projeter({ canonicalType: ENGAGEANTS[0], documentTypeCode: 'ACQUISITION_PAYMENT', facts: [prix(c)] }, { assetId: c.assetId });
    expect(p1.byKey('acquisitionPrice').every((f) => f.ruleCode !== PROJECTION_RULES.PROPERTY_EVIDENCE_WITHOUT_REALIZATION)).toBe(true);
    const p2 = projeter({ canonicalType: ENGAGEANTS[0], title: 'Facture d’acompte', facts: [prix(c)] }, { assetId: c.assetId });
    expect(p2.byKey('acquisitionPrice')).toHaveLength(0);
  });
});

describe('L91C-06 — équipement : jamais rabattu sur le bien', () => {
  it('prix ciblant un équipement vérifié : jamais une preuve du bien', () => {
    const c = CAS[2];
    const { byKey } = projeter({ canonicalType: ENGAGEANTS[0], facts: [prix(c, {
      label: 'Prix de la cuisine équipée', target: { type: 'EQUIPMENT', entityId: 55, rawLabel: 'Cuisine', confidence: 'certain' },
    })] }, { assetId: c.assetId, equipmentIds: [55] });
    expect(byKey('acquisitionPrice').some((f) => f.target.targetType === 'ASSET')).toBe(false);
  });

  it('facture d’achat d’un meuble rangée en « Équipements et mobilier » : jamais le prix du bien (l86e)', () => {
    const c = CAS[1];
    const { p, byKey } = projeter({ canonicalType: 'FACTURE', documentTypeCode: 'ACQUISITION_INVOICE', rubricCode: 'EQUIPMENT_FURNITURE', facts: [prix(c, { label: 'Total TTC' })] }, { assetId: c.assetId });
    expect(p.purpose).toBe('PART_PURCHASE');
    expect(byKey('acquisitionPrice')).toHaveLength(0);
  });
});

describe('L91C-07 — multi-biens, cible ambiguë ou non vérifiée : aucune attribution arbitraire', () => {
  const c = CAS[0];
  it('document multi-biens : connaissance générique même si le modèle cible un bien', () => {
    const { byKey } = projeter({ canonicalType: ENGAGEANTS[0], multiAsset: true, facts: [prix(c)] }, { assetId: c.assetId });
    expect(byKey('acquisitionPrice')).toHaveLength(0);
  });

  it('deux biens vérifiés ciblés : connaissance générique', () => {
    const { byKey } = projeter({ canonicalType: ENGAGEANTS[0], facts: [prix(c), prix({ ...CAS[2], assetId: 8000 })] }, { assetId: c.assetId, verifiedAssets: [8000] });
    expect(byKey('acquisitionPrice')).toHaveLength(0);
  });

  it('autre bien mentionné, fait sans identifiant : cible ambiguë, aucune preuve', () => {
    const { byKey } = projeter({
      canonicalType: ENGAGEANTS[0],
      assets: [{ entityId: null, rawLabel: 'Parking', score: 0.5, confidence: 'probable', evidenceSignals: [], reason: 'lu' }],
      facts: [prix(c, { target: { type: 'ASSET', entityId: null, rawLabel: null, confidence: 'probable' } })],
    }, { assetId: c.assetId });
    expect(byKey('acquisitionPrice')).toHaveLength(0);
  });

  it('identifiant de bien non vérifié : neutralisé, aucune preuve', () => {
    const { byKey } = projeter({ canonicalType: ENGAGEANTS[0], facts: [prix(c, { target: { type: 'ASSET', entityId: 999_999, confidence: 'certain' } })] }, { assetId: c.assetId });
    expect(byKey('acquisitionPrice').some((f) => f.target.targetEntityId === 999_999)).toBe(false);
  });
});

describe('L91C-08 — valeur estimée ≠ prix de transaction', () => {
  it('« valeur estimée » annoncée comme prix : refusée', () => {
    const c = CAS[1];
    const { byKey } = projeter({ canonicalType: ENGAGEANTS[0], facts: [prix(c, { label: 'Valeur estimée', evidence: { excerpt: 'Valeur estimée du bien : 1 085 000,50 EUR', page: 3 } })] }, { assetId: c.assetId });
    expect(byKey('acquisitionPrice')).toHaveLength(0);
  });

  it('une valeur estimée sur un document de transaction reste refusée (règle O0 inchangée)', () => {
    const c = CAS[0];
    const { byKey } = projeter({ canonicalType: 'FACTURE', facts: [{ ...prix(c), canonicalKey: 'estimatedValue' }] }, { assetId: c.assetId });
    expect(byKey('estimatedValue')).toHaveLength(0);
    expect(byKey('acquisitionPrice')).toHaveLength(0);
  });
});

describe('L91C-09 — devise, preuve littérale, confiance', () => {
  const c = CAS[2];
  it('devise étrangère écrite : aucune preuve en euros', () => {
    const { byKey } = projeter({ canonicalType: ENGAGEANTS[0], facts: [prix(c, { rawValue: '74 900 CHF', evidence: { excerpt: 'Prix : 74 900 CHF', page: 1 } })] }, { assetId: c.assetId });
    expect(byKey('acquisitionPrice')).toHaveLength(0);
  });

  it('aucune devise écrite : euro présumé → proposition (probable)', () => {
    const { byKey } = projeter({
      canonicalType: ENGAGEANTS[0], transcription: 'Prix convenu 74900',
      facts: [prix(c, { rawValue: '74900', evidence: { excerpt: 'Prix convenu 74900', page: 1 } })],
    }, { assetId: c.assetId });
    expect(byKey('acquisitionPrice')[0]).toMatchObject({ confidence: 'probable', ruleCode: PROJECTION_RULES.PROPERTY_EVIDENCE_WITHOUT_REALIZATION });
  });

  it('observation visuelle sans extrait littéral : refusée', () => {
    const { byKey } = projeter({ canonicalType: ENGAGEANTS[0], facts: [prix(c, {
      provenance: 'VISUAL_ANALYSIS', evidence: {}, visualEvidence: { description: 'montant manuscrit', page: 1 },
    })] }, { assetId: c.assetId });
    expect(byKey('acquisitionPrice')).toHaveLength(0);
  });

  it('confiance conflictuelle : refusée ; probable : conservée telle quelle (T3 en fera une proposition)', () => {
    expect(projeter({ canonicalType: ENGAGEANTS[0], facts: [prix(c, { confidence: 'conflictual' })] }, { assetId: c.assetId }).byKey('acquisitionPrice')).toHaveLength(0);
    expect(projeter({ canonicalType: ENGAGEANTS[0], facts: [prix(c, { confidence: 'probable' })] }, { assetId: c.assetId }).byKey('acquisitionPrice')[0])
      .toMatchObject({ confidence: 'probable' });
  });
});

describe('L91C-10 — règle pure', () => {
  const base = {
    fieldKey: 'acquisitionPrice', entry: resolveDocumentType(ENGAGEANTS[0]), nature: 'PURCHASE' as const, origin: 'MODEL_CANONICAL',
    provenance: 'TEXT_EXTRACTION', excerpt: 'Prix : 10 €', labels: ['prix'], targetType: 'ASSET', targetEntityId: 1, multiAsset: false, confidence: 'certain',
  };
  it('admise / refusée avec un motif stable', () => {
    expect(admitsPropertyWithoutRealization(base)).toEqual({ ok: true });
    expect(admitsPropertyWithoutRealization({ ...base, fieldKey: 'acquisitionDate' })).toEqual({ ok: false, reason: 'FIELD_STATES_REALIZATION' });
    expect(admitsPropertyWithoutRealization({ ...base, entry: resolveDocumentType('FACTURE') })).toEqual({ ok: false, reason: 'SOURCE_NOT_ADMISSIBLE' });
    expect(admitsPropertyWithoutRealization({ ...base, entry: undefined })).toEqual({ ok: false, reason: 'SOURCE_NOT_ADMISSIBLE' });
    expect(admitsPropertyWithoutRealization({ ...base, nature: 'PAYMENT_PROOF' })).toEqual({ ok: false, reason: 'TRANSACTION_NOT_PURCHASE' });
    expect(admitsPropertyWithoutRealization({ ...base, origin: 'DETERMINISTIC_RULE' })).toEqual({ ok: false, reason: 'NOT_EXPLICIT_EXTRACTION' });
    expect(admitsPropertyWithoutRealization({ ...base, targetEntityId: null })).toEqual({ ok: false, reason: 'TARGET_NOT_ESTABLISHED' });
    expect(admitsPropertyWithoutRealization({ ...base, targetType: 'EQUIPMENT' })).toEqual({ ok: false, reason: 'TARGET_NOT_ESTABLISHED' });
    expect(admitsPropertyWithoutRealization({ ...base, multiAsset: true })).toEqual({ ok: false, reason: 'MULTI_ASSET' });
    expect(admitsPropertyWithoutRealization({ ...base, excerpt: '  ' })).toEqual({ ok: false, reason: 'NO_LITERAL_EVIDENCE' });
    expect(admitsPropertyWithoutRealization({ ...base, labels: ['Arrhes'] })).toEqual({ ok: false, reason: 'PARTIAL_PAYMENT' });
    expect(admitsPropertyWithoutRealization({ ...base, labels: ['Estimation'] })).toEqual({ ok: false, reason: 'VALUATION_NOT_PRICE' });
    expect(admitsPropertyWithoutRealization({ ...base, confidence: 'conflictual' })).toEqual({ ok: false, reason: 'CONFLICTUAL' });
  });
  it('un champ hors de la matrice explicite (ou piloté par la récence) n’est jamais admis par ce chemin', () => {
    expect(sourceAdmissibleForProperty('iban', resolveDocumentType(ENGAGEANTS[0]))).toBe(false);
    expect(sourceAdmissibleForProperty('mileage', resolveDocumentType(ENGAGEANTS[0]))).toBe(false);
  });
});
