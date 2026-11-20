/**
 * Lot 115F (Trello #791) — fiabilisation de l'arbitrage d'attributs d'un
 * événement de référence : les neuf écarts résiduels du ticket #750.
 *
 *   L115F-U-E01  détection sans seuil de jours (contrats et financements
 *                compris) ; devis ≠ facture ≠ réalisation conservés ;
 *   L115F-U-E04  prestataire canonique par autorité sémantique, invariant à
 *                l'ordre d'ingestion ;
 *   L115F-U-E05  révision successive PROUVÉE (relation déclarée, périodes
 *                disjointes) — sinon contradiction réelle ;
 *   L115F-U-E02  couverture des preuves exigée pour TOUT verdict ;
 *   L115F-U-E07  périmètre MATÉRIEL des preuves (scans identiques, pièce
 *                équivalente, pièce plus autoritaire, décision verrouillée) ;
 *   L115F-U-E06  toutes les alternatives exposées, carte sans document ;
 *   L115F-U-PO   bloc 54 du guide, aucun texte de prompt dans le code.
 * Tests purs (aucune base, aucune IA, aucune dépendance au jour).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalProvider, consolidateOperationState, semanticRoleOf, type CandidateIdentity, type SourceContribution,
} from '../model';
import {
  attributeChoiceKey, evidenceScopeKeyOf, needsArbitrationCard, qualifyAttributeConflicts,
  type AttributeReview, type QualificationContext,
} from '../attribute-conflicts';
import { buildArbitrationInput, validateArbitration, type RawArbitrationContext } from '../attribute-arbitration/contract';
import { attributeProposals, ATTRIBUTE_PROPOSALS_MAX, OPERATION_ATTRIBUTE_RULE } from '@/services/to-process/operation-cards';
import {
  DISPLAYED_PROPOSALS_MAX, DISPLAYED_PROPOSALS_MAX_BY_RULE, displayedProposalsMax, isDisplayableArbitration,
  selectDisplayedProposals,
} from '@/services/to-process/action-model';
import { PROCESSING_RULES } from '@/services/to-process/rules-catalog';

const TODAY = '2026-11-16';
const BIEN = 7;

function cand(over: Partial<CandidateIdentity> = {}): CandidateIdentity {
  return {
    candidateId: 1, candidateKey: 'op1', fileId: 10, established: true, confidence: 'certain', type: 'INTERVENTION',
    status: 'REALIZED', role: 'INVOICE', summary: 'Prestation', provider: null, providerKey: null,
    assetIds: [BIEN], targetAuthority: 'INFERENCE', equipmentIds: [], refs: [],
    dates: { plannedDate: null, startDate: null, realizedDate: null, endDate: null }, hints: [], ...over,
  };
}
const d = (over: Partial<CandidateIdentity['dates']>) => ({ plannedDate: null, startDate: null, realizedDate: null, endDate: null, ...over });
const ref = (kind: CandidateIdentity['refs'][number]['kind'], value: string) => ({ kind, value, normalized: value.toUpperCase() });
const src = (sourceId: number, identity: CandidateIdentity): SourceContribution => ({ sourceId, identity });

/** Relevé 78A puis qualification (même chemin que le consolidateur). */
function relever(type: CandidateIdentity['type'], sources: SourceContribution[], extra: Partial<QualificationContext> = {}) {
  const s = consolidateOperationState(type, sources, TODAY);
  const ctx: QualificationContext = {
    type: s.type, contributions: sources, provenance: s.provenance,
    sourceMeta: new Map(sources.map((x) => [x.sourceId, { authority: 'DOCUMENT', kind: 'DOCUMENT' }])),
    suspectSourceIds: new Set(), ...extra,
  };
  return { state: s, ctx, ...qualifyAttributeConflicts(s.attributeConflicts, ctx) };
}
const ligne = (r: ReturnType<typeof relever>, field: string) => r.alerting.concat(r.divergences).filter((c) => c.field === field);

describe('L115F-U-E01 — détection sans seuil de jours (E01)', () => {
  it('même prise d’effet d’un CONTRAT, 05/11 contre 12/11 : contradiction RÉELLE (avant : aucune fenêtre, donc aucune détection)', () => {
    const contrat = (over: Partial<CandidateIdentity>) => cand({ type: 'CONTRACT', role: 'CONTRACT_DOCUMENT', refs: [ref('CONTRACT', 'P-9')], ...over });
    const r = relever('CONTRACT', [
      src(1, contrat({ dates: d({ startDate: '2026-11-05' }) })),
      src(2, contrat({ candidateId: 2, fileId: 11, dates: d({ startDate: '2026-11-12' }) })),
    ]);
    expect(r.state.attributeConflicts.map((c) => c.field)).toEqual(['startDate']);
    // Aucun écart « matériel » (un contrat n'a pas de fenêtre) : la règle de rétention ne change pas.
    expect(r.state.attributeConflicts[0].materialGap).toBeUndefined();
    expect(r.state.startDate).toBe('2026-11-05');
    expect(ligne(r, 'startDate').map((c) => [c.role, c.qualification, c.reasonCode]))
      .toEqual([['CONTRACT_EFFECTIVE', 'REAL_CONFLICT_UNRESOLVED', 'SAME_REFERENCE']]);
    expect(needsArbitrationCard(r.alerting[0])).toBe(true);
  });

  it('devis du 05/11 et facture du 12/11 : ZÉRO conflit (rôles différents), et la date de réalisation reste celle de la facture', () => {
    const r = relever('INTERVENTION', [
      src(1, cand({ role: 'QUOTE', status: 'ENVISAGED', dates: d({ plannedDate: '2026-11-05' }) })),
      src(2, cand({ candidateId: 2, fileId: 11, role: 'INVOICE', dates: d({ realizedDate: '2026-11-12' }) })),
    ]);
    expect(r.state.attributeConflicts).toEqual([]);
    expect(r.alerting).toEqual([]);
    expect(r.state.realizedDate).toBe('2026-11-12');
  });

  // Règle remplacée (décision PO du 16/11, carte #791) : deux dates du MÊME JOUR ÉCONOMIQUE
  // (`SAME_DATE_DAYS`) sont relevées mais consultables — aucune question posée. Au-delà, contradiction.
  it('deux dates d’ACQUISITION du même jour économique (2 jours) : relevées, consultables, aucune carte ; au-delà de la tolérance, contradiction', () => {
    const acte = (over: Partial<CandidateIdentity>) => cand({ type: 'ACQUISITION', role: 'SALE_DOCUMENT', refs: [ref('ORDER', 'A-1')], ...over });
    const deux = (a: string, b: string) => relever('ACQUISITION', [
      src(1, acte({ dates: d({ realizedDate: a }) })),
      src(2, acte({ candidateId: 2, fileId: 11, dates: d({ realizedDate: b }) })),
    ]);
    const proche = deux('2026-03-12', '2026-03-14');
    expect(proche.state.realizedDate).toBe('2026-03-12');
    expect(ligne(proche, 'realizedDate').map((c) => [c.qualification, c.reasonCode])).toEqual([['LEGITIMATE_DIFFERENCE', 'SAME_ECONOMIC_DAY']]);
    expect(ligne(proche, 'realizedDate')[0].values.map((v) => v.value)).toEqual(['2026-03-12', '2026-03-14']);
    expect(proche.alerting).toEqual([]);
    const loin = deux('2026-03-12', '2026-03-28');
    expect(loin.state.realizedDate).toBe('2026-03-12');
    expect(ligne(loin, 'realizedDate').map((c) => [c.qualification, c.reasonCode])).toEqual([['REAL_CONFLICT_UNRESOLVED', 'SAME_REFERENCE']]);
    expect(needsArbitrationCard(loin.alerting[0])).toBe(true);
  });

  it('dates légitimes très ÉLOIGNÉES mais de rôles différents (signature, couverture, paiement) : aucune contradiction réelle', () => {
    const r = relever('CONTRACT', [
      src(1, cand({ type: 'CONTRACT', role: 'CONTRACT_DOCUMENT', dates: d({ startDate: '2019-01-01' }) })),
      src(2, cand({ candidateId: 2, fileId: 11, type: 'CONTRACT', role: 'CONTRACT_DOCUMENT', coverageDocument: true, dates: d({ startDate: '2026-04-01' }) })),
    ]);
    expect(semanticRoleOf('startDate', { role: 'CONTRACT_DOCUMENT', coverageDocument: true })).toBe('COVERAGE_START');
    expect(r.alerting).toEqual([]);
    expect(ligne(r, 'startDate').map((c) => c.reasonCode)).toEqual(['ROLES_DIFFER']);
  });
});

describe('L115F-U-E04 — prestataire canonique par autorité sémantique (E04)', () => {
  const facture = (id: number, nom: string) => src(id, cand({ candidateId: id, fileId: 10 + id, role: 'INVOICE', provider: nom, providerKey: nom.toLowerCase() }));
  const paiement = (id: number, nom: string) => src(id, cand({ candidateId: id, fileId: 10 + id, role: 'PAYMENT_PROOF', provider: nom, providerKey: nom.toLowerCase() }));
  const rapport = (id: number, nom: string) => src(id, cand({ candidateId: id, fileId: 10 + id, role: 'REPORT', provider: nom, providerKey: nom.toLowerCase() }));

  it('banque AVANT assureur : le prestataire reste celui qui facture ou contracte, dans les deux ordres d’ingestion', () => {
    expect(canonicalProvider([paiement(1, 'Banque Populaire'), facture(2, 'Assureur Nord')])).toBe('Assureur Nord');
    expect(canonicalProvider([facture(1, 'Assureur Nord'), paiement(2, 'Banque Populaire')])).toBe('Assureur Nord');
  });

  it('rôles différents (facturant, exécutant, intermédiaire) : aucune contradiction, et l’exécutant ne prend pas la place du facturant', () => {
    const r = relever('INTERVENTION', [paiement(1, 'Banque Populaire'), rapport(2, 'Diagnostics Ouest'), facture(3, 'Plomberie Durand')]);
    expect(r.state.provider).toBe('Plomberie Durand');
    expect(r.alerting).toEqual([]);
    expect(ligne(r, 'provider').map((c) => c.reasonCode)).toEqual(['ROLES_DIFFER']);
    expect(canonicalProvider([rapport(1, 'Diagnostics Ouest'), facture(2, 'Plomberie Durand')])).toBe('Plomberie Durand');
  });

  it('ancienne et nouvelle assurance (même rôle) : la plus ancienne source reste retenue, la contradiction est arbitrée — jamais écrasée', () => {
    const police = (id: number, nom: string, debut: string) => src(id, cand({
      candidateId: id, fileId: 10 + id, type: 'CONTRACT', role: 'CONTRACT_DOCUMENT', refs: [ref('POLICY', 'POL-5')],
      provider: nom, providerKey: nom.toLowerCase(), dates: d({ startDate: debut }),
    }));
    const r = relever('CONTRACT', [police(1, 'Assureur 2022', '2022-01-01'), police(2, 'Assureur 2024', '2024-01-01')]);
    expect(r.state.provider).toBe('Assureur 2022');
    expect(ligne(r, 'provider').map((c) => [c.role, c.qualification])).toEqual([['SUPPLIER', 'REAL_CONFLICT_UNRESOLVED']]);
    // Ordre d'ingestion inversé : même verdict, mêmes valeurs (seule la source fondatrice change).
    const inverse = relever('CONTRACT', [police(1, 'Assureur 2024', '2024-01-01'), police(2, 'Assureur 2022', '2022-01-01')]);
    expect(ligne(inverse, 'provider')[0].values.map((v) => v.value).sort()).toEqual(['Assureur 2022', 'Assureur 2024']);
    expect(ligne(inverse, 'provider')[0].qualification).toBe('REAL_CONFLICT_UNRESOLVED');
  });

  it('correction de l’utilisateur : sa valeur est le rôle le plus autoritaire, et elle n’est jamais comparée à un document', () => {
    const saisie = src(9, cand({ candidateId: 9, fileId: 0, role: null, provider: 'Chauffagiste Martin', providerKey: 'chauffagiste martin', agenda: { itemId: 3, realizedDate: null, realizationRecord: false } }));
    expect(canonicalProvider([facture(1, 'Plomberie Durand'), saisie])).toBe('Chauffagiste Martin');
    expect(semanticRoleOf('provider', saisie.identity)).toBe('USER_ENTRY');
  });
});

describe('L115F-U-E05 — révision successive PROUVÉE (E05)', () => {
  const police = (id: number, over: Partial<CandidateIdentity>) => src(id, cand({
    candidateId: id, fileId: 10 + id, type: 'CONTRACT', role: 'CONTRACT_DOCUMENT', refs: [ref('CONTRACT', 'P-1')], ...over,
  }));

  it('avenant AUTHENTIFIÉ (relation déclarée par le document) : divergence légitime, valeur actuelle non remplacée', () => {
    const r = relever('CONTRACT', [
      police(1, { provider: 'Assureur A', providerKey: 'assureura', dates: d({ startDate: '2022-01-01' }) }),
      police(2, { provider: 'Assureur B', providerKey: 'assureurb', dates: d({ startDate: '2024-01-01' }), documentRelation: 'AMENDMENT' }),
    ]);
    expect(r.alerting).toEqual([]);
    expect(ligne(r, 'provider').map((c) => c.reasonCode)).toEqual(['SUCCESSIVE_REVISION']);
    expect(r.state.provider).toBe('Assureur A');
  });

  it('deux débuts SANS lien prouvé : contradiction réelle (règle remplacée — avant, la seule différence de date suffisait)', () => {
    const r = relever('CONTRACT', [
      police(1, { dates: d({ startDate: '2022-01-01' }) }),
      police(2, { dates: d({ startDate: '2024-01-01' }) }),
    ]);
    expect(ligne(r, 'startDate').map((c) => [c.qualification, c.reasonCode])).toEqual([['REAL_CONFLICT_UNRESOLVED', 'SAME_REFERENCE']]);
  });

  it('assureur 2022 face à une source 2024 : arbitré ; périodes contractuelles DISJOINTES : légitime', () => {
    const sans = relever('CONTRACT', [
      police(1, { provider: 'Assureur 2022', providerKey: 'a2022', dates: d({ startDate: '2022-01-01' }) }),
      police(2, { provider: 'Assureur 2024', providerKey: 'a2024', dates: d({ startDate: '2024-01-01' }) }),
    ]);
    expect(ligne(sans, 'provider')[0].qualification).toBe('REAL_CONFLICT_UNRESOLVED');
    const terme = (start: string, end: string) => ({ evaluated: true, contractTerms: [{ start, end, openEnded: false }] });
    const avec = relever('CONTRACT', [
      police(1, { provider: 'Assureur 2022', providerKey: 'a2022', dates: d({ startDate: '2022-01-01' }), termQualification: terme('2022-01-01', '2023-12-31') }),
      police(2, { provider: 'Assureur 2024', providerKey: 'a2024', dates: d({ startDate: '2024-01-01' }), termQualification: terme('2024-01-01', '2025-12-31') }),
    ]);
    expect(avec.alerting).toEqual([]);
    expect(ligne(avec, 'provider').map((c) => c.reasonCode)).toEqual(['SUCCESSIVE_REVISION']);
    // Périodes qui se CHEVAUCHENT : rien n'est prouvé, la contradiction demeure.
    const chevauche = relever('CONTRACT', [
      police(1, { provider: 'Assureur 2022', providerKey: 'a2022', dates: d({ startDate: '2022-01-01' }), termQualification: terme('2022-01-01', '2024-06-30') }),
      police(2, { provider: 'Assureur 2024', providerKey: 'a2024', dates: d({ startDate: '2024-01-01' }), termQualification: terme('2024-01-01', '2025-12-31') }),
    ]);
    expect(ligne(chevauche, 'provider')[0].qualification).toBe('REAL_CONFLICT_UNRESOLVED');
  });

  it('devis alternatifs SIMULTANÉS (deux documents) : légitime ; deux dates contradictoires du MÊME devis : la contradiction suit son cours', () => {
    const devis = (id: number, fileId: number, prevue: string) => src(id, cand({
      candidateId: id, fileId, role: 'QUOTE', status: 'ENVISAGED', dates: d({ plannedDate: prevue }),
    }));
    const alternatifs = relever('INTERVENTION', [devis(1, 10, '2026-02-10'), devis(2, 11, '2026-03-10')]);
    expect(alternatifs.alerting).toEqual([]);
    expect(ligne(alternatifs, 'plannedDate').map((c) => c.reasonCode)).toEqual(['QUOTE_REVISION']);
    const memeDevis = relever('INTERVENTION', [devis(1, 10, '2026-02-10'), devis(2, 10, '2026-03-10')]);
    expect(ligne(memeDevis, 'plannedDate')[0].reasonCode).not.toBe('QUOTE_REVISION');
    // Devis CORRIGÉ (rectificatif déclaré) : légitime, même porté par le même document.
    const corrige = relever('INTERVENTION', [devis(1, 10, '2026-02-10'),
      src(2, cand({ candidateId: 2, fileId: 10, role: 'QUOTE', status: 'ENVISAGED', dates: d({ plannedDate: '2026-03-10' }), documentRelation: 'RECTIFICATION' }))]);
    expect(ligne(corrige, 'plannedDate').map((c) => c.reasonCode)).toEqual(['QUOTE_REVISION']);
  });
});

describe('L115F-U-E02 — couverture des preuves exigée pour TOUT verdict (E02)', () => {
  const valeur = (j: string, file: number) => ({ value: `2026-03-${j}`, normalized: `2026-03-${j}`, fileIds: [file], held: false, userProtected: false });
  const doc = (id: number, extrait: string) => ({ id, type: 'INVOICE', title: `Facture ${id}`, date: '2026-03-20', provider: 'Plomberie Durand', references: [], excerpts: [extrait] });
  const BASE: RawArbitrationContext = {
    today: TODAY, field: 'realizedDate', role: 'REALIZATION', operation: { typeCode: 'INTERVENTION', label: 'Chauffe-eau' },
    values: [valeur('12', 21), valeur('19', 22)], documents: [doc(21, 'Intervention réalisée le 12/03/2026'), doc(22, 'Intervention réalisée le 19/03/2026')],
  };
  const sortie = (over: Record<string, unknown>) => ({
    task: 'ATTRIBUTE_ARBITRATION', outcome: 'DISTINCT_FACTS', retainedValue: null, foreignDocument: null, confidence: 'certain',
    evidence: [{ document: 'D1', excerpt: 'Intervention réalisée le 12/03/2026' }], reason: 'Deux faits.', ...over,
  });

  it('cinq valeurs dont la dernière contredit les quatre autres : contexte INCOMPLET, aucun verdict (même « faits distincts »)', () => {
    const cinq: RawArbitrationContext = {
      ...BASE,
      values: ['01', '02', '03', '04', '05'].map((j, i) => valeur(j, 21 + i)),
      documents: ['01', '02', '03', '04', '05'].map((j, i) => doc(21 + i, `Intervention réalisée le ${j}/03/2026`)),
    };
    const b = buildArbitrationInput(cinq);
    expect(b.scope.complete).toBe(false);
    expect(b.scope.incomplete).toBe('VALUES_DROPPED');
    expect(b.input.bounds).toMatchObject({ complete: false, droppedValues: 1 });
    expect(b.scope.known).toHaveLength(5);
    for (const outcome of ['DISTINCT_FACTS', 'UNDECIDABLE'] as const) {
      const v = validateArbitration(sortie({ outcome }), b.scope);
      expect(v.ok, outcome).toBe(false);
      if (!v.ok) expect(v.problems.map((p) => p.issue)).toContain('CONTEXT_INCOMPLETE');
    }
    // Seule l'ABSTENTION reste recevable sur un contexte partiel.
    expect(validateArbitration(sortie({ outcome: 'ABSTAIN', evidence: [] }), b.scope)).toMatchObject({ ok: true, effect: null, ignored: 'ABSTAIN' });
  });

  it('sept documents dont le dernier change la conclusion : au-delà des bornes, aucun verdict n’est accepté', () => {
    const sept: RawArbitrationContext = {
      ...BASE,
      values: [{ ...valeur('12', 21), fileIds: [21, 22, 23, 24, 25, 26] }, { ...valeur('19', 27), fileIds: [27] }],
      documents: [21, 22, 23, 24, 25, 26, 27].map((id) => doc(id, 'Intervention réalisée le 12/03/2026')),
    };
    const b = buildArbitrationInput(sept);
    expect(b.scope.incomplete).toBe('DOCUMENTS_DROPPED');
    expect(validateArbitration(sortie({}), b.scope).ok).toBe(false);
  });

  it('pagination rompue ou source supprimée (document retenu jamais chargé) : couverture non prouvée', () => {
    const b = buildArbitrationInput({ ...BASE, documents: [BASE.documents[0]] });
    expect(b.scope.incomplete).toBe('DOCUMENT_NOT_LOADED');
    expect(validateArbitration(sortie({}), b.scope).ok).toBe(false);
  });

  it('valeur sans aucun document et non protégée : couverture non prouvée (aucune preuve à citer pour ce fait)', () => {
    const b = buildArbitrationInput({ ...BASE, values: [BASE.values[0], { ...BASE.values[1], fileIds: [] }] });
    expect(b.scope.incomplete).toBe('VALUE_WITHOUT_DOCUMENT');
    expect(validateArbitration(sortie({}), b.scope).ok).toBe(false);
  });

  it('contexte COMPLET : les verdicts gardent leur effet ; un document désigné étranger doit porter lui-même la preuve', () => {
    const b = buildArbitrationInput(BASE);
    expect(b.scope.complete).toBe(true);
    expect(validateArbitration(sortie({}), b.scope)).toMatchObject({ ok: true, effect: { outcome: 'DISTINCT_FACTS' } });
    const etranger = (ref2: string) => sortie({ outcome: 'LINK_ERROR', foreignDocument: 'D2', evidence: [{ document: ref2, excerpt: ref2 === 'D1' ? 'Intervention réalisée le 12/03/2026' : 'Intervention réalisée le 19/03/2026' }] });
    expect(validateArbitration(etranger('D1'), b.scope).ok).toBe(false);
    expect(validateArbitration(etranger('D2'), b.scope)).toMatchObject({ ok: true, effect: { outcome: 'LINK_ERROR', foreignFileId: 22 } });
  });
});

describe('L115F-U-E07 — périmètre matériel des preuves (E07)', () => {
  const item = (over: Partial<{ normalized: string; identity: CandidateIdentity | null; role: string; documentRole: CandidateIdentity['role']; authority: string | null }> = {}) => ({
    normalized: over.normalized ?? 'plomberie durand',
    identity: over.identity === undefined ? cand() : over.identity,
    src: { role: over.role ?? 'SUPPLIER', documentRole: over.documentRole ?? ('INVOICE' as const), authority: over.authority ?? 'DOCUMENT' },
  });

  it('vingt scans identiques, et une pièce ÉQUIVALENTE redéposée (autre identifiant) : MÊME empreinte, aucun réexamen', () => {
    const une = evidenceScopeKeyOf([item()]);
    expect(evidenceScopeKeyOf(Array.from({ length: 20 }, () => item()))).toBe(une);
    expect(evidenceScopeKeyOf([item({ identity: cand({ candidateId: 77, fileId: 999 }) })])).toBe(une);
  });

  it('pièce plus AUTORITAIRE, révision déclarée, identité ou date d’effet nouvelle : empreinte DIFFÉRENTE', () => {
    const une = evidenceScopeKeyOf([item()]);
    expect(evidenceScopeKeyOf([item({ documentRole: 'REPORT', role: 'EXECUTANT' })])).not.toBe(une);
    expect(evidenceScopeKeyOf([item({ identity: cand({ documentRelation: 'AMENDMENT' }) })])).not.toBe(une);
    expect(evidenceScopeKeyOf([item({ identity: cand({ refs: [ref('INVOICE', 'F-118')] }) })])).not.toBe(une);
    expect(evidenceScopeKeyOf([item({ identity: cand({ dates: d({ startDate: '2026-01-01' }) }) })])).not.toBe(une);
    expect(evidenceScopeKeyOf([item({ authority: 'USER' })])).not.toBe(une);
  });

  it('un examen T3 rendu sur un AUTRE périmètre ne couvre plus la ligne ; sans périmètre mémorisé (avant le lot 115), il la couvre encore', () => {
    const factures = (fileId: number) => [
      src(1, cand({ provider: 'Plomberie Durand', providerKey: 'plomberie durand', refs: [ref('INVOICE', 'F-118')] })),
      src(2, cand({ candidateId: 2, fileId, role: 'INVOICE', provider: 'Chauffage Martin', providerKey: 'chauffage martin', refs: [ref('INVOICE', 'F-118')] })),
    ];
    const base = relever('INTERVENTION', factures(11));
    const known = ligne(base, 'provider')[0].values.map((v) => v.normalized);
    const perimetre = ligne(base, 'provider')[0].evidenceKey!;
    expect(perimetre).toMatch(/^l115:[0-9a-f]{8}:\d+$/);
    const examen = (over: Partial<AttributeReview> = {}): Map<string, AttributeReview> => new Map([[attributeChoiceKey('provider', 'SUPPLIER'), {
      field: 'provider', role: 'SUPPLIER', known, outcome: 'LEGITIMATE_DIFFERENCE', reviewId: 6, ...over,
    }]]);
    // Même périmètre : le verdict couvre la ligne (pas un conflit).
    expect(relever('INTERVENTION', factures(11), { reviews: examen({ evidenceKey: perimetre }) }).alerting).toEqual([]);
    // Périmètre d'avant (non mémorisé) : toléré, aucun réexamen de masse au déploiement.
    expect(relever('INTERVENTION', factures(11), { reviews: examen() }).alerting).toEqual([]);
    // Preuve matériellement différente (pièce plus autoritaire) : le verdict ne couvre plus la ligne.
    const autre = relever('INTERVENTION', [
      src(1, cand({ provider: 'Plomberie Durand', providerKey: 'plomberie durand', refs: [ref('INVOICE', 'F-118')] })),
      src(2, cand({ candidateId: 2, fileId: 11, role: 'CONTRACT_DOCUMENT', provider: 'Chauffage Martin', providerKey: 'chauffage martin', refs: [ref('INVOICE', 'F-118')] })),
    ], { reviews: examen({ evidenceKey: perimetre }) });
    expect(autre.alerting.map((c) => c.qualification)).toEqual(['REAL_CONFLICT_UNRESOLVED']);
  });
});

describe('L115F-U-E06 — toutes les alternatives exposées (E06)', () => {
  const valeurs = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `2026-03-${String(i + 1).padStart(2, '0')}`, normalized: `2026-03-${String(i + 1).padStart(2, '0')}`, title: `Facture ${i + 1}` }));

  it('cinq valeurs (et plus) : toutes construites, la valeur en place en DERNIER et marquée (avant : la cinquième était perdue)', () => {
    const p = attributeProposals('realizedDate', valeurs(5), '2026-03-01');
    expect(p).toHaveLength(5);
    expect(p.at(-1)).toMatchObject({ value: 'ATTRIBUTE:2026-03-01', isCurrentValue: true });
    expect(p.filter((x) => !x.isCurrentValue).map((x) => x.value)).toEqual(['ATTRIBUTE:2026-03-02', 'ATTRIBUTE:2026-03-03', 'ATTRIBUTE:2026-03-04', 'ATTRIBUTE:2026-03-05']);
    expect(new Set(p.map((x) => x.value)).size).toBe(5);
    expect(p.every((x) => x.confidence > 0)).toBe(true);
  });

  it('plafond de sûreté : jamais plus de douze propositions, la valeur en place toujours présente', () => {
    const p = attributeProposals('realizedDate', valeurs(20), '2026-03-01');
    expect(p).toHaveLength(ATTRIBUTE_PROPOSALS_MAX);
    expect(p.at(-1)).toMatchObject({ isCurrentValue: true });
  });

  it('À L’ÉCRAN : plus de deux alternatives pour une contradiction d’attribut, la valeur en place toujours là (règle §8.5 complétée, carte #791)', () => {
    const p = attributeProposals('realizedDate', valeurs(8), '2026-03-01');
    const vues = selectDisplayedProposals(p, OPERATION_ATTRIBUTE_RULE);
    // Cinq alternatives (avant le lot 115 : deux), plus la valeur en place, marquée et en dernier.
    expect(vues).toHaveLength(6);
    expect(vues.filter((x) => !x.isCurrentValue)).toHaveLength(displayedProposalsMax(OPERATION_ATTRIBUTE_RULE));
    expect(vues.at(-1)).toMatchObject({ value: 'ATTRIBUTE:2026-03-01', isCurrentValue: true });
    // L'ordre reste la confiance décroissante (jamais l'ordre d'arrivée réinventé).
    expect(vues.slice(0, -1).map((x) => x.confidence)).toEqual([...vues.slice(0, -1).map((x) => x.confidence)].sort((a, b) => b - a));
    // Et la DONNÉE de la carte porte toujours tout : l'écran borne, la donnée non.
    expect(p.length).toBeGreaterThan(vues.length);
  });

  it('AUCUNE AUTRE CARTE n’est touchée : la borne commune reste deux, pour toutes les règles sauf les exceptions déclarées', () => {
    expect(DISPLAYED_PROPOSALS_MAX).toBe(2);
    expect(Object.keys(DISPLAYED_PROPOSALS_MAX_BY_RULE)).toEqual([OPERATION_ATTRIBUTE_RULE]);
    const quatre = [
      { value: 'A', label: 'A', confidence: 0.8 }, { value: 'B', label: 'B', confidence: 0.7 },
      { value: 'C', label: 'C', confidence: 0.6 }, { value: 'D', label: 'D', confidence: 1, isCurrentValue: true },
    ];
    // Sans code de règle : exactement ce qui était affiché avant le lot 115.
    expect(selectDisplayedProposals([...quatre]).map((x) => x.value)).toEqual(['A', 'B', 'D']);
    for (const r of PROCESSING_RULES.filter((x) => x.code !== OPERATION_ATTRIBUTE_RULE)) {
      expect(selectDisplayedProposals([...quatre], r.code).map((x) => x.value), r.code).toEqual(['A', 'B', 'D']);
      expect(displayedProposalsMax(r.code), r.code).toBe(2);
    }
    // Une règle inconnue, une exception absurde : la borne commune s'applique (jamais moins de deux).
    expect(displayedProposalsMax('RÈGLE-INCONNUE')).toBe(2);
    expect(displayedProposalsMax(null)).toBe(2);
    // §8.5 / ATP-05 inchangé : une valeur actuelle seule ne fait pas un arbitrage.
    expect(isDisplayableArbitration([{ value: 'D', label: 'D', confidence: 1, isCurrentValue: true }])).toBe(false);
  });

  it('sources 100 % STRUCTURÉES (aucun document) : la contradiction est bien relevée et appelle une carte', () => {
    const structuree = (id: number, date: string) => src(id, cand({
      candidateId: id, fileId: 0, type: 'ACQUISITION', role: null, dates: d({ realizedDate: date }),
      refs: [ref('ORDER', 'A-7')], structured: { nature: 'ACQUISITION' }, targetAuthority: 'USER',
    }));
    const r = relever('ACQUISITION', [structuree(1, '2026-01-10'), structuree(2, '2026-02-10')]);
    expect(ligne(r, 'realizedDate').map((c) => [c.role, c.qualification])).toEqual([['REALIZATION', 'REAL_CONFLICT_UNRESOLVED']]);
    expect(needsArbitrationCard(r.alerting[0])).toBe(true);
  });
});

describe('L115F-U-PO — bloc 54 du guide, aucun texte de prompt dans le code', () => {
  const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('le bloc 54 est écrit dans le guide du PO, nomme le contrat EXISTANT et n’ajoute aucun champ de sortie', () => {
    const guide = lire('docs/exploitation/prompts-a-appliquer-par-le-po.md');
    // Le numéro de SECTION dépend de l'ordre d'intégration des lots (l'étape 56 de #792 a été intégrée avant) :
    // la règle porte sur la présence du bloc de l'étape 54, pas sur son rang dans le guide.
    expect(guide).toMatch(/^## \d+\. Étape 54 — T3 : arbitrage d'un attribut contradictoire/m);
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : le bloc 54 est borné à SA section. Les sections
    // ajoutées ensuite au guide (dont l'étape 53, qui cite le mot « opération » pour le faire adopter) n'en font pas partie.
    const debut = guide.indexOf('Étape 54');
    const suite = guide.indexOf('\n## ', debut);
    const bloc = guide.slice(debut, suite === -1 ? undefined : suite);
    expect(bloc).toContain('PREUVES INCOMPLÈTES ET PREUVE PAR FAIT — contrat t3-attribute-arbitration-v1');
    expect(bloc).toContain('bounds.complete');
    // Aucun contrat nouveau : le marqueur du bloc 38 reste le seul, donc l'arbitrage reste actif sans le bloc 54.
    expect(bloc).not.toMatch(/t3-attribute-arbitration-v2/);
    expect(bloc).not.toMatch(/Opération\b/);
  });

  it('aucun texte de prompt n’est écrit dans le code de l’arbitrage (seuls le contrat et la validation y vivent)', () => {
    for (const f of ['contract.ts', 'decider.ts', 'review.ts']) {
      const t = lire(`src/services/business-operations/consolidation/attribute-arbitration/${f}`);
      expect(t, f).not.toMatch(/PREUVES INCOMPLÈTES ET PREUVE PAR FAIT/);
      expect(t, f).not.toMatch(/BRANCHE TASK = ATTRIBUTE_ARBITRATION\n/);
    }
  });
});
