/**
 * Décisions PO du 01/10/2026 (lot 20, chantier A) appliquées au registre, aux
 * catalogues, aux candidats T4, à la projection T1, aux preuves et à la
 * primitive d'écriture : D-A, D-B, D-C, D-D. Fonctions PURES (aucune base).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const {
  catalogForPrompts, documentContextOf, documentMayCreateEvent, fieldTargetTypes, getField, isExcludedKey,
  isInputOnlyKey, listFields, resolveAlias, resolveAliasDetailed, resolveDocumentType,
} = await import('..');
const { creationAuthorization, AUTHORIZED_CREATION_TYPES } = await import('@/services/ai/agenda/agenda-intelligence.service');
const { buildAgendaCandidatesT4 } = await import('@/services/ai/source-analysis/steps/build-agenda-candidates.step');
const { contextualFieldKey } = await import('@/services/ai/source-analysis/steps/persist-evidence.step');
const { projectDocumentFacts } = await import('@/services/ai/source-analysis/projection/document-projection');
const { planCanonicalWrites } = await import('@/services/canonical/asset-state/write-canonical-asset-field');
import type { ExtractedField } from '@/services/ai/source-analysis/types';
import type { T1Fact } from '@/services/ai/source-analysis/master/t1-contract';

const cand = (over: Record<string, unknown>) => ({ title: 'x', date: '2027-01-01', confidence: 'certain' as const, excerpt: 'x', ...over });

describe('D-A — acte authentique et PV de contrôle technique créent des événements', () => {
  it('catalogue : mayCreateAgenda, types métier et preuves cohérents ; alias autorisés', () => {
    const acte = resolveDocumentType('ACTE_NOTARIE')!;
    expect(acte).toMatchObject({ code: 'ACTE_AUTHENTIQUE', mayCreateAgenda: true, businessTypes: ['purchase', 'sale'] });
    expect(acte.creationScope).toBeUndefined();
    const ct = resolveDocumentType('PV_CONTROLE_TECHNIQUE')!;
    expect(ct).toMatchObject({ code: 'CONTROLE_TECHNIQUE', mayCreateAgenda: true, businessTypes: ['inspection'] });
    expect(ct.completionProofs.map((p) => [p.code, p.establishes])).toEqual([['PV_CONTROLE_FAVORABLE', 'completed'], ['PV_CONTRE_VISITE', 'not_proven']]);
    for (const t of ['ACTE_AUTHENTIQUE', 'TITRE_PROPRIETE', 'PROPERTY_TITLE', 'CONTROLE_TECHNIQUE', 'VEHICLE_TECHNICAL_INSPECTION']) {
      expect(AUTHORIZED_CREATION_TYPES.has(t), t).toBe(true);
    }
  });

  it('T4-04 : achat / vente d’un acte et contrôle d’un PV autorisés à la création', () => {
    expect(creationAuthorization(cand({ documentType: 'ACTE_AUTHENTIQUE', businessType: 'sale', nature: 'HISTORICAL' }))).toMatchObject({ allowed: true, reasonCode: 'SOURCE_AUTHORIZED' });
    expect(creationAuthorization(cand({ documentType: 'CONTROLE_TECHNIQUE', businessType: 'inspection', nature: 'DEADLINE' }))).toMatchObject({ allowed: true });
    const [pv] = buildAgendaCandidatesT4(
      [{ fieldKey: 'nextInspection', canonicalKey: 'nextInspection', value: '2028-05-01', confidence: 'certain', excerpt: 'Prochain contrôle avant le 01/05/2028', provenance: 'TEXT_EXTRACTION' } as ExtractedField],
      { sourceFileId: 1, documentAssetId: 7, multiAsset: false, documentType: 'VEHICLE_TECHNICAL_INSPECTION' },
    );
    expect(pv).toMatchObject({ documentType: 'CONTROLE_TECHNIQUE', mayCreateAgenda: true, businessType: 'inspection', nature: 'DEADLINE' });
    expect(creationAuthorization(pv as never).allowed).toBe(true);
  });
});

describe('D-B — constat de sinistre : sinistre historique seulement', () => {
  const ctx = { sourceFileId: 9, documentAssetId: 3, multiAsset: false, documentTitle: 'Constat amiable', documentDate: '2026-03-14', documentType: 'CONSTAT_SINISTRE' };

  it('catalogue : autorisé, limité au sinistre HISTORIQUE (creationScope)', () => {
    const e = resolveDocumentType('CLAIM_DECLARATION')!;
    expect(e).toMatchObject({ code: 'CONSTAT_SINISTRE', mayCreateAgenda: true, creationScope: { businessTypes: ['claim'], natures: ['HISTORICAL'] } });
    expect(documentMayCreateEvent(e, { businessType: 'claim', nature: 'HISTORICAL' })).toBe(true);
    expect(documentMayCreateEvent(e, { businessType: 'claim', nature: 'DEADLINE' })).toBe(false);
    expect(documentMayCreateEvent(e, { businessType: 'repair', nature: 'HISTORICAL' })).toBe(false);
    expect(documentMayCreateEvent(e)).toBe(false);
    expect(documentMayCreateEvent(resolveDocumentType('FACTURE'))).toBe(true);
    expect(documentMayCreateEvent(resolveDocumentType('DEVIS'))).toBe(false);
    expect(documentMayCreateEvent(undefined)).toBe(false);
  });

  it('constat sans fait daté : candidat « Sinistre » HISTORIQUE daté du document, autorisé, sans citation fabriquée', () => {
    const cs = buildAgendaCandidatesT4([], ctx);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({
      businessType: 'claim', nature: 'HISTORICAL', date: '2026-03-14', dateSource: 'DOCUMENT_DATE', suggestedCategory: 'information',
      target: { type: 'ASSET', id: 3 }, mayCreateAgenda: true, documentType: 'CONSTAT_SINISTRE', excerpt: '',
    });
    expect(creationAuthorization(cs[0] as never)).toMatchObject({ allowed: true, reasonCode: 'SOURCE_AUTHORIZED' });
  });

  it('toute autre échéance d’un constat est proposée ; multi-biens ou sans date : rien ; jamais de doublon', () => {
    expect(creationAuthorization(cand({ documentType: 'CONSTAT_SINISTRE', businessType: 'repair', nature: 'HISTORICAL' }))).toMatchObject({ allowed: false, reasonCode: 'SOURCE_TYPE_NOT_AUTHORIZED' });
    // Même si le candidat se dit autorisé : la portée du type s'applique.
    expect(creationAuthorization(cand({ documentType: 'CONSTAT_SINISTRE', businessType: 'claim', nature: 'DEADLINE', mayCreateAgenda: true })).allowed).toBe(false);
    const garantie = buildAgendaCandidatesT4([{
      fieldKey: 'warrantyEndDate', canonicalKey: 'warrantyEndDate', value: '2028-01-01', confidence: 'certain', excerpt: 'garantie jusqu’au 01/01/2028', provenance: 'TEXT_EXTRACTION',
    } as ExtractedField], ctx).find((c) => c.businessType === 'warranty')!;
    expect(garantie.mayCreateAgenda).toBe(false);
    expect(creationAuthorization(garantie as never).allowed).toBe(false);
    expect(buildAgendaCandidatesT4([], { ...ctx, multiAsset: true })).toEqual([]);
    expect(buildAgendaCandidatesT4([], { ...ctx, documentDate: null })).toEqual([]);
    const fait = { fieldKey: 'x', value: 'x', confidence: 'certain', excerpt: 'Sinistre survenu', canonicalKey: null, provenance: 'TEXT_EXTRACTION',
      semanticEvent: { type: 'claim', nature: 'HISTORICAL' } } as unknown as ExtractedField;
    expect(buildAgendaCandidatesT4([fait], ctx).filter((c) => c.businessType === 'claim')).toHaveLength(1);
    // Autre type documentaire : aucun sinistre inventé.
    expect(buildAgendaCandidatesT4([], { ...ctx, documentType: 'FACTURE' })).toEqual([]);
  });
});

describe('D-C — alias contextuels par type documentaire', () => {
  it('dateFinContrat : bail / LOA / LLD → leaseEndDate ; autres → contractEndDate', () => {
    for (const t of ['CONTRAT_LOA', 'CONTRAT_LLD', 'LEASING_FINANCING_CONTRACT', 'BAIL_HABITATION', 'RENTAL_LEASE', 'contrat_lld']) {
      expect(resolveAlias('dateFinContrat', undefined, { documentType: t }), t).toBe('leaseEndDate');
    }
    for (const t of ['FACTURE', 'CONTRAT', 'CONTRAT_ASSURANCE', null, undefined]) {
      expect(resolveAlias('dateFinContrat', undefined, { documentType: t }), String(t)).toBe('contractEndDate');
    }
    // Sans contexte : résolution historique inchangée.
    expect(resolveAlias('dateFinContrat')).toBe('contractEndDate');
    expect(resolveAlias('date_fin_contrat', 'IMMOBILIER', { documentType: 'BAIL' })).toBe('leaseEndDate');
    // Famille sans bail (objet) : retombe sur contractEndDate.
    expect(resolveAlias('dateFinContrat', 'OBJECT', { documentType: 'CONTRAT_LOA' })).toBe('contractEndDate');
    expect(resolveAliasDetailed('dateFinContrat', 'VEHICULE', { documentType: 'CONTRAT_LOA' })).toEqual({ key: 'leaseEndDate', canonical: false });
  });

  it('numeroContrat : assurance → insuranceContractNumber ; autres → contractNumber', () => {
    for (const t of ['CONTRAT_ASSURANCE', 'ATTESTATION_ASSURANCE', 'AVIS_ECHEANCE', 'INSURANCE_POLICY', 'INSURANCE_DUE_NOTICE']) {
      expect(resolveAlias('numeroContrat', undefined, { documentType: t }), t).toBe('insuranceContractNumber');
    }
    for (const t of ['CONTRAT_LLD', 'FACTURE', null]) expect(resolveAlias('numeroContrat', undefined, { documentType: t })).toBe('contractNumber');
    expect(resolveAlias('numeroContrat')).toBe('contractNumber');
    expect(resolveAlias('numero_contrat', 'VEHICULE', { documentType: 'CONTRAT_ASSURANCE' })).toBe('insuranceContractNumber');
  });

  it('nature documentaire : catalogue d’abord, code ensuite', () => {
    expect(documentContextOf('PEB')).toEqual({ lease: false, insurance: false, dpe: true, diagnostic: false });
    expect(documentContextOf('AMIANTE')).toMatchObject({ diagnostic: true, dpe: false });
    expect(documentContextOf('CONTRAT_LOA')).toMatchObject({ lease: true, insurance: false });
    expect(documentContextOf('INSURANCE_CLAIMS')).toMatchObject({ insurance: true });
    expect(documentContextOf(null)).toEqual({ lease: false, insurance: false, dpe: false, diagnostic: false });
  });

  it('chemin « étapes » : la preuve porte la clé retenue par le document, rien ne change sinon', () => {
    expect(contextualFieldKey({ fieldKey: 'dateFinContrat' }, 'CONTRAT_LOA')).toBe('leaseEndDate');
    expect(contextualFieldKey({ fieldKey: 'numeroContrat' }, 'ATTESTATION_ASSURANCE')).toBe('insuranceContractNumber');
    expect(contextualFieldKey({ fieldKey: 'dateEtablissement' }, 'DPE')).toBe('dpeDate');
    // Branche générale = résolution historique : clé brute conservée (même empreinte).
    expect(contextualFieldKey({ fieldKey: 'dateFinContrat' }, 'FACTURE')).toBeNull();
    expect(contextualFieldKey({ fieldKey: 'dateEtablissement' }, 'FACTURE')).toBeNull();
    expect(contextualFieldKey({ fieldKey: 'acquisitionDate' }, 'FACTURE')).toBeNull();
    // Contrat enrichi : la clé canonique fournie fait foi.
    expect(contextualFieldKey({ fieldKey: 'dateFinContrat', canonicalKey: 'contractEndDate' }, 'CONTRAT_LOA')).toBeNull();
  });

  it('candidats agenda : fin de bail selon le document', () => {
    const f = { fieldKey: 'dateFinContrat', value: '2028-06-30', confidence: 'certain', excerpt: 'Fin du contrat : 30/06/2028', provenance: 'TEXT_EXTRACTION' } as ExtractedField;
    const base = { sourceFileId: 1, documentAssetId: 2, multiAsset: false };
    expect(buildAgendaCandidatesT4([f], { ...base, documentType: 'CONTRAT_LLD' })[0]).toMatchObject({ businessType: 'lease', originFieldKey: 'leaseEndDate' });
    expect(buildAgendaCandidatesT4([f], { ...base, documentType: 'FACTURE' })[0]).toMatchObject({ businessType: 'contract', originFieldKey: 'contractEndDate' });
  });
});

describe('D-D — clés classées au registre', () => {
  it('types, unités, familles, cibles ; plus aucune clé « non classée »', () => {
    expect(getField('carrezArea')).toMatchObject({ valueType: 'number', unit: 'm2', families: ['IMMOBILIER'] });
    expect(resolveAlias('surfaceCarrez', 'IMMOBILIER')).toBe('carrezArea');
    // Carrez ≠ surface habitable.
    expect(resolveAlias('surfaceHabitable', 'IMMOBILIER')).toBe('livingArea');
    expect(getField('parking')).toMatchObject({ valueType: 'string', families: ['IMMOBILIER'] });
    expect(resolveAlias('stationnement', 'IMMOBILIER')).toBe('parking');
    expect(resolveAlias('surfaceAnnoncee', 'IMMOBILIER')).toBe('listedArea');
    expect(resolveAlias('prixAnnonce', 'VEHICULE')).toBe('listingPrice');
    expect(getField('listingPrice')).toMatchObject({ valueType: 'money_eur', unit: 'EUR', inputOnly: true });
    expect(getField('listedArea')).toMatchObject({ unit: 'm2', inputOnly: true });
    for (const [k, c] of [['cop', 'cop'], ['fluideFrigorigene', 'refrigerant']] as const) {
      expect(resolveAlias(k), k).toBe(c);
      expect(fieldTargetTypes(getField(c)!)).toEqual(['EQUIPMENT']);
      expect(listFields('IMMOBILIER').some((d) => d.key === c), `${c} jamais sur la fiche du bien`).toBe(false);
    }
    // « puissance » d'un équipement : powerKw (colonne réelle equipment_cil_specs.power_kw), jamais la puissance fiscale.
    expect(resolveAlias('puissance')).toBe('powerKw');
    expect(fieldTargetTypes(getField('powerKw')!)).toContain('EQUIPMENT');
    expect(resolveAlias('puissanceFiscale', 'VEHICULE')).toBe('fiscalHp');
    expect(getField('diagnosticDate')).toMatchObject({ valueType: 'date', families: ['IMMOBILIER'] });
    expect(resolveAlias('dateEtablissement', 'IMMOBILIER', { documentType: 'DPE' })).toBe('dpeDate');
    expect(resolveAlias('dateEtablissement', 'IMMOBILIER', { documentType: 'ELECTRICITY_DIAGNOSTIC' })).toBe('diagnosticDate');
    expect(resolveAlias('dateEtablissement', undefined, { documentType: 'FACTURE' })).toBeUndefined();
    expect(resolveAlias('dateEtablissement')).toBeUndefined();
    expect(getField('hourMeter')).toMatchObject({ unit: 'h', families: ['VEHICULE', 'OBJECT'] });
    expect(fieldTargetTypes(getField('hourMeter')!)).toEqual(['ASSET', 'EQUIPMENT']);
    expect(getField('hourMeter')!.mirrorColumns ?? []).toEqual([]);
    expect(resolveAlias('compteurHoraire', 'VEHICULE')).toBe('hourMeter');
    expect(resolveAlias('kilometrage', 'VEHICULE')).toBe('mileage');
    for (const k of ['parking', 'surfaceCarrez', 'surfaceAnnoncee', 'prixAnnonce', 'puissance', 'cop', 'fluideFrigorigene', 'dateEtablissement']) {
      expect(isExcludedKey(k), k).toBeUndefined();
    }
  });

  it('saisie seule (inputOnly) : clé et alias reconnus, jamais demandés au modèle', () => {
    for (const k of ['listingPrice', 'prixAnnonce', 'prix_affiche', 'listedArea', 'surfaceAnnoncee']) expect(isInputOnlyKey(k), k).toBe(true);
    for (const k of ['livingArea', 'acquisitionPrice', 'parking', null, '', 'inconnu']) expect(isInputOnlyKey(k), String(k)).toBe(false);
    for (const family of [undefined, 'IMMOBILIER', 'VEHICULE', 'OBJECT'] as const) {
      const keys = catalogForPrompts({ family }).fields.map((f) => f.key);
      expect(keys).not.toContain('listingPrice');
      expect(keys).not.toContain('listedArea');
    }
    expect(catalogForPrompts({ family: 'IMMOBILIER' }).fields.find((f) => f.key === 'carrezArea')?.targets).toEqual(['ASSET']);
    expect(catalogForPrompts({ family: 'IMMOBILIER' }).fields.find((f) => f.key === 'cop')?.targets).toEqual(['EQUIPMENT']);
    expect(catalogForPrompts({ family: 'IMMOBILIER' }).documents.find((d) => d.code === 'CONSTAT_SINISTRE')?.mayCreateAgenda).toBe(true);
  });

  it('primitive d’écriture : un champ de saisie seule refuse toute origine automatique', () => {
    const row = { id: 1, account_id: 1, category: 'IMMOBILIER', key_characteristics: {} } as never;
    const ctx = (origin: 'RECONCILIATION' | 'DOCUMENT_EXTRACTION' | 'SYSTEM_RULE' | 'USER' | 'IMPORT') => ({ origin, now: '2026-10-02T00:00:00.000Z' });
    for (const o of ['RECONCILIATION', 'DOCUMENT_EXTRACTION', 'SYSTEM_RULE'] as const) {
      const p = planCanonicalWrites(row, [{ key: 'prixAnnonce', value: 259000 }], ctx(o));
      expect(p.results[0], o).toMatchObject({ key: 'listingPrice', outcome: 'protected', reason: 'INPUT_ONLY_FIELD' });
      expect(p.changed).toBe(false);
    }
    for (const o of ['USER', 'IMPORT'] as const) {
      const p = planCanonicalWrites(row, [{ key: 'prixAnnonce', value: 259000 }], ctx(o));
      expect(p.results[0], o).toMatchObject({ key: 'listingPrice', outcome: 'written', nextValue: 259000 });
    }
    // Champ ordinaire : inchangé.
    expect(planCanonicalWrites(row, [{ key: 'surfaceCarrez', value: 78.4 }], ctx('RECONCILIATION')).results[0])
      .toMatchObject({ key: 'carrezArea', outcome: 'written', nextValue: 78.4 });
  });
});

describe('projection T1 — D-C et D-D', () => {
  const ctxProj = {
    knownAssetId: 30, documentAssetId: 30,
    assetFamilies: new Map([[30, 'IMMOBILIER' as const]]),
    verifiedIds: { ASSET: new Set([30]), EQUIPMENT: new Set([501]), ROOM: new Set<number>(), SUPPLIER: new Set<number>() },
  };
  const fait = (canonicalKey: string, rawValue: string | number, normalizedValue: string | number, over: Partial<T1Fact> = {}): T1Fact => ({
    canonicalKey, rawValue, normalizedValue, valueType: typeof normalizedValue === 'number' ? 'number' : 'date', canonicalUnit: null,
    target: { type: 'ASSET', entityId: 30, rawLabel: 'Maison', confidence: 'certain' },
    provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: `${canonicalKey} : ${rawValue}` }, ...over,
  } as T1Fact);
  const analyse = (documentTypeCode: string, facts: T1Fact[]) => ({
    document: { classification: { canonicalType: documentTypeCode, documentTypeCode, confidence: 0.9 } },
    entities: { assets: [{ entityId: 30, rawLabel: 'Maison', confidence: 'certain' }], rooms: [], equipments: [], suppliers: [], multiAsset: false },
    facts,
  }) as never;

  it('alias contextuel résolu selon le document', () => {
    const bail = projectDocumentFacts(analyse('BAIL_HABITATION', [fait('dateFinContrat', '30/06/2028', '2028-06-30')]), ctxProj);
    expect(bail.facts[0]).toMatchObject({ canonicalKey: 'leaseEndDate', origin: 'MODEL_CANONICAL', semanticEvent: { type: 'lease', nature: 'DEADLINE' } });
    const dpe = projectDocumentFacts(analyse('DPE', [fait('dateEtablissement', '12/03/2026', '2026-03-12')]), ctxProj);
    expect(dpe.facts[0]).toMatchObject({ canonicalKey: 'dpeDate', semanticEvent: { type: 'dpe', nature: 'HISTORICAL' } });
    const facture = projectDocumentFacts(analyse('FACTURE', [fait('dateEtablissement', '12/03/2026', '2026-03-12')]), ctxProj);
    expect(facture.facts[0].canonicalKey).toBeNull();
  });

  it('équipement d’un bien IMMOBILIER (PAC) : puissance, COP, fluide, compteur horaire, marque sur l’ÉQUIPEMENT', () => {
    const equip = (canonicalKey: string, rawValue: string | number, normalizedValue: string | number) =>
      fait(canonicalKey, rawValue, normalizedValue, {
        valueType: typeof normalizedValue === 'number' ? 'number' : 'string',
        target: { type: 'EQUIPMENT', entityId: 501, rawLabel: 'PAC Atlantic', confidence: 'certain' },
      } as Partial<T1Fact>);
    const p = projectDocumentFacts(analyse('FICHE_TECHNIQUE', [
      equip('puissance', '11,2 kW', 11.2), equip('cop', '4,72', 4.72), equip('fluideFrigorigene', 'R410A', 'R410A'),
      equip('compteurHoraire', '1 250 h', 1250), equip('marque', 'Atlantic', 'Atlantic'),
    ]), ctxProj);
    expect(p.facts.map((f) => [f.canonicalKey, f.value, f.target.targetType, f.target.targetEntityId])).toEqual([
      ['powerKw', 11.2, 'EQUIPMENT', 501], ['cop', 4.72, 'EQUIPMENT', 501], ['refrigerant', 'R410A', 'EQUIPMENT', 501],
      ['hourMeter', 1250, 'EQUIPMENT', 501], ['brand', 'Atlantic', 'EQUIPMENT', 501],
    ]);
    expect(p.warnings.filter((w) => w.code === 'KEY_NOT_APPLICABLE_TO_FAMILY' || w.code === 'UNKNOWN_CANONICAL_KEY')).toEqual([]);
    // Résolution par cible : même règle que catalogForPrompts (famille ignorée pour un équipement).
    for (const [raw, key] of [['puissance', 'powerKw'], ['compteurHoraire', 'hourMeter'], ['cop', 'cop'], ['fluideFrigorigene', 'refrigerant'], ['marque', 'brand']]) {
      expect(resolveAlias(raw, 'IMMOBILIER', { targetType: 'EQUIPMENT' }), raw).toBe(key);
    }
    const immo = catalogForPrompts({ family: 'IMMOBILIER' }).fields;
    for (const k of ['powerKw', 'hourMeter', 'cop', 'refrigerant']) expect(immo.find((f) => f.key === k)?.targets, k).toEqual(['EQUIPMENT']);
    // Sur le BIEN immobilier lui-même : jamais (puissance et compteur ne sont pas des champs de maison).
    expect(resolveAlias('puissance', 'IMMOBILIER')).toBeUndefined();
    expect(resolveAlias('marque', 'IMMOBILIER', { targetType: 'ASSET' })).toBeUndefined();
    const surBien = projectDocumentFacts(analyse('FICHE_TECHNIQUE', [fait('puissance', '11,2 kW', 11.2)]), ctxProj);
    expect(surBien.facts[0].canonicalKey).toBeNull();
    // Pièce : seuls les champs de pièce.
    expect(resolveAlias('surfacePiece', 'IMMOBILIER', { targetType: 'ROOM' })).toBe('roomArea');
    expect(resolveAlias('puissance', undefined, { targetType: 'ROOM' })).toBeUndefined();
  });

  it('prix et surface d’annonce : jamais un fait canonique (connaissance générique, avertissement)', () => {
    const p = projectDocumentFacts(analyse('ANNONCE_COMMERCIALE', [
      fait('prixAnnonce', '259 000 €', 259000, { valueType: 'money_eur', canonicalUnit: 'EUR' }),
      fait('listedArea', '82 m²', 82),
      fait('surfaceCarrez', '78,4 m²', 78.4),
    ]), ctxProj);
    expect(p.facts.map((f) => f.canonicalKey)).toEqual([null, null, 'carrezArea']);
    expect(p.warnings.filter((w) => w.code === 'KEY_INPUT_ONLY').map((w) => w.target)).toEqual(['listingPrice', 'listedArea']);
  });
});
