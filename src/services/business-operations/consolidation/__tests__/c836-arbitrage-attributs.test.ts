/**
 * Carte #836 (Trello) — les neuf écarts résiduels de l'arbitrage d'attributs
 * d'un événement de référence, après le lot 115F (#791) et le lot 114 (#750).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Chaque écart porte ici DEUX familles de cas :
 *   · le cas POSITIF (le comportement corrigé) ;
 *   · le CONTRE-EXEMPLE — la situation que le code d'AVANT traitait mal, et
 *     qui échouerait sur lui (R01 / R02 l'exigent). Le commentaire de chaque
 *     contre-exemple dit ce que l'ancienne règle produisait.
 *
 *   C836-U-E09  aucune résolution sans APPLICATION VÉRIFIÉE en base ;
 *               escalade explicite après épuisement des reprises ;
 *   C836-U-E07  réexamen sur évolution MATÉRIELLE, empreintes historiques
 *               régularisées, choix USER jamais écrasé (question ciblée),
 *               aucune réouverture sur rejeu (20 scans) ;
 *   C836-U-E01  tolérance du même jour économique bornée à SON domaine ;
 *   C836-U-E05  preuve de succession liant les DEUX assertions comparées ;
 *   C836-U-E04  mise à jour CONTRÔLÉE du prestataire déjà en place ;
 *   C836-U-E02  inventaire des preuves avant sélection (13ᵉ unité, 7ᵉ
 *               référence, pagination rompue, inventaire impossible) ;
 *   C836-U-E03  déduplication Agenda bornée au rôle de date qu'il porte ;
 *   C836-U-E06  contradiction d'une opération 100 % structurée ;
 *   C836-U-E08  rattachement erroné ENCORE ACTIF : action exploitable.
 * Tests purs (aucune base, aucune IA, aucune dépendance au jour).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalProvider, consolidateOperationState, providerAuthorityUpdate, SAME_DATE_DAYS,
  type CandidateIdentity, type SourceContribution,
} from '../model';
import {
  attributeChoiceKey, choiceApplication, evidenceScopeKeyOf, needsArbitrationCard, qualifyAttributeConflicts,
  sameAssertionContradicted,
  type AttributeChoice, type AttributeReview, type ConflictField, type QualificationContext,
} from '../attribute-conflicts';
import { eligibleForArbitration } from '../attribute-arbitration/review';
import { buildArbitrationInput, validateArbitration, type RawArbitrationContext } from '../attribute-arbitration/contract';

const TODAY = '2026-11-24';
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

/** Relevé 78A puis qualification — MÊME chemin que le consolidateur (y compris le contrôle en base). */
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

// ── C836-U-E09 ────────────────────────────────────────────────────────────

describe('C836-U-E09 — aucune résolution sans application VÉRIFIÉE (E09)', () => {
  /** Deux factures de MÊME référence, deux prestataires : contradiction réelle (113AQ : SAME_REFERENCE). */
  const FACTURES = () => [
    src(1, cand({ provider: 'Plomberie Durand', providerKey: 'plomberie durand', refs: [ref('INVOICE', 'F-118')] })),
    src(2, cand({ candidateId: 2, fileId: 11, provider: 'Chauffage Martin', providerKey: 'chauffage martin', refs: [ref('INVOICE', 'F-118')] })),
  ];
  const base = relever('INTERVENTION', FACTURES());
  const valeurs = ligne(base, 'provider')[0].values;
  const MARTIN = valeurs.find((v) => v.value === 'Chauffage Martin')!.normalized;
  const known = valeurs.map((v) => v.normalized);
  const choixT3 = (application?: AttributeChoice['application']): Map<string, AttributeChoice> => new Map([
    [attributeChoiceKey('provider', 'SUPPLIER'), {
      field: 'provider' as ConflictField, role: 'SUPPLIER', normalized: MARTIN, known, by: 'T3' as const, reviewId: 5,
      ...(application ? { application } : {}),
    }],
  ]);
  const avec = (application: AttributeChoice['application'] | undefined, persisted: string | null | undefined) =>
    relever('INTERVENTION', FACTURES(), { choices: choixT3(application), ...(persisted === undefined ? {} : { persisted: { provider: persisted } }) });

  it('décision T3 APPLIQUÉE et constatée en base : contradiction tranchée, tracée « T3 », aucune carte', () => {
    const r = avec('APPLIED', 'Chauffage Martin');
    expect(r.alerting).toEqual([]);
    expect(r.divergences.map((c) => [c.qualification, c.reasonCode])).toEqual([['REAL_CONFLICT_RESOLVED', 'T3_ARBITRATED']]);
    expect(r.divergences[0].resolution).toMatchObject({ by: 'T3', value: 'Chauffage Martin', reviewId: 5 });
  });

  it('CONTRE-EXEMPLE — décision REÇUE mais jamais écrite (panne, échec SQL) : conflit OUVERT et carte posée (avant : « conflit réel tranché »)', () => {
    // Avant la carte #836 : `status = DECIDED` suffisait — la ligne était qualifiée REAL_CONFLICT_RESOLVED /
    // T3_ARBITRATED alors que l'opération portait encore l'ancienne valeur, et la carte était fermée.
    const r = avec('PENDING', 'Plomberie Durand');
    expect(r.divergences).toEqual([]);
    expect(r.alerting.map((c) => [c.qualification, c.reasonCode])).toEqual([['REAL_CONFLICT_UNRESOLVED', 'T3_APPLICATION_NOT_VERIFIED']]);
    expect(needsArbitrationCard(r.alerting[0])).toBe(true);
    // La décision reste TRACÉE sur la ligne (le BO sait qu'un arbitrage existe et qu'il n'a pas pris effet).
    expect(r.alerting[0].resolution).toMatchObject({ by: 'T3', value: 'Chauffage Martin', reviewId: 5 });
  });

  it('CONTRE-EXEMPLE — application en ÉCHEC (valeur protégée, écriture refusée) : conflit OUVERT (avant : « tranché »)', () => {
    const r = avec('FAILED', 'Plomberie Durand');
    expect(r.alerting.map((c) => c.reasonCode)).toEqual(['T3_APPLICATION_NOT_VERIFIED']);
    expect(needsArbitrationCard(r.alerting[0])).toBe(true);
  });

  it('plafond de reprises ÉPUISÉ : escalade EXPLICITE, conflit visible et actionnable (jamais un blocage silencieux)', () => {
    const r = avec('ESCALATED', 'Plomberie Durand');
    expect(r.alerting.map((c) => c.reasonCode)).toEqual(['T3_APPLICATION_ESCALATED']);
    expect(needsArbitrationCard(r.alerting[0])).toBe(true);
    // Escaladée ET pourtant écrite entre-temps : le CONTRÔLE EN BASE l'emporte sur l'état durable.
    expect(avec('ESCALATED', 'Chauffage Martin').divergences.map((c) => c.reasonCode)).toEqual(['T3_ARBITRATED']);
  });

  it('CONTRE-EXEMPLE — contrôle en base IMPOSSIBLE (aucune valeur relue) : jamais « résolu »', () => {
    expect(avec('APPLIED', undefined).alerting.map((c) => c.reasonCode)).toEqual(['T3_APPLICATION_NOT_VERIFIED']);
    expect(avec('APPLIED', null).alerting.map((c) => c.reasonCode)).toEqual(['T3_APPLICATION_NOT_VERIFIED']);
  });

  it('contrôle en base DISCORDANT (une autre valeur a été écrite) : conflit ouvert', () => {
    expect(avec('APPLIED', 'Sanitaire Leroy').alerting.map((c) => c.reasonCode)).toEqual(['T3_APPLICATION_NOT_VERIFIED']);
  });

  it('ligne ANTÉRIEURE à la migration 1785 (état d’application inconnu) : le contrôle en base décide seul — aucun réexamen de masse', () => {
    expect(avec('UNTRACKED', 'Chauffage Martin').divergences.map((c) => c.reasonCode)).toEqual(['T3_ARBITRATED']);
    expect(avec(undefined, 'Chauffage Martin').divergences.map((c) => c.reasonCode)).toEqual(['T3_ARBITRATED']);
    expect(avec('UNTRACKED', 'Plomberie Durand').alerting.map((c) => c.reasonCode)).toEqual(['T3_APPLICATION_NOT_VERIFIED']);
  });

  it('PROTECTION USER : la valeur choisie par l’utilisateur est écrite dans la même transaction — jamais soumise au cycle d’application T3', () => {
    const choixUser = new Map<string, AttributeChoice>([[attributeChoiceKey('provider', 'SUPPLIER'), {
      field: 'provider', role: 'SUPPLIER', normalized: MARTIN, known, by: 'USER', sourceId: 99,
    }]]);
    const r = relever('INTERVENTION', FACTURES(), { choices: choixUser, persisted: { provider: 'Chauffage Martin' } });
    expect(r.divergences.map((c) => [c.qualification, c.reasonCode, c.protection])).toEqual([['REAL_CONFLICT_RESOLVED', 'USER_ARBITRATED', 'USER']]);
    // Et une décision de l'utilisateur n'est jamais renvoyée à l'IA.
    const rouverte = relever('INTERVENTION', FACTURES(), { choices: choixUser, persisted: { provider: 'Plomberie Durand' } });
    expect(rouverte.divergences.map((c) => c.reasonCode)).toEqual(['USER_ARBITRATED']);
  });

  it('`choiceApplication` (pur) : états et formes de comparaison (date normalisée, prestataire équivalent)', () => {
    const date: AttributeChoice = { field: 'realizedDate', role: 'REALIZATION', normalized: '2026-03-12', known: [], by: 'T3' };
    expect(choiceApplication(date, '2026-03-12', '2026-03-12', 'k')).toBe('VERIFIED');
    // Même jour écrit dans un autre format : l'application est bien constatée (pas de faux échec).
    expect(choiceApplication(date, '2026-03-12', '12/03/2026', 'k')).toBe('VERIFIED');
    expect(choiceApplication(date, '2026-03-12', '2026-03-19', 'k')).toBe('NOT_VERIFIED');
    expect(choiceApplication({ ...date, application: 'ESCALATED' }, '2026-03-12', null, 'k')).toBe('ESCALATED');
  });
});

// ── C836-U-E07 ────────────────────────────────────────────────────────────

describe('C836-U-E07 — réexamen des décisions T3 obsolètes (E07)', () => {
  const facture = (id: number, over: Partial<CandidateIdentity> = {}) => src(id, cand({
    candidateId: id, fileId: 10 + id, provider: id === 1 ? 'Plomberie Durand' : 'Chauffage Martin',
    providerKey: id === 1 ? 'plomberie durand' : 'chauffage martin', refs: [ref('INVOICE', 'F-118')], ...over,
  }));

  it('VINGT scans identiques : même périmètre matériel, donc aucun réexamen (aucune réouverture sur rejeu)', () => {
    const une = relever('INTERVENTION', [facture(1), facture(2)]);
    const cle = ligne(une, 'provider')[0].evidenceKey;
    for (let i = 0; i < 20; i++) {
      const rejeu = relever('INTERVENTION', [facture(1), facture(2)]);
      expect(ligne(rejeu, 'provider')[0].evidenceKey, `scan ${i + 1}`).toBe(cle);
    }
  });

  it('autorité CHANGÉE, révision déclarée, identité ou période nouvelle : périmètre matériel DIFFÉRENT (réexamen dû), même à valeur textuelle égale', () => {
    const une = relever('INTERVENTION', [facture(1), facture(2)]);
    const cle = ligne(une, 'provider')[0].evidenceKey!;
    const autorite = relever('INTERVENTION', [facture(1), facture(2, { role: 'CONTRACT_DOCUMENT' })]);
    expect(ligne(autorite, 'provider')[0].evidenceKey).not.toBe(cle);
    const revision = relever('INTERVENTION', [facture(1), facture(2, { documentRelation: 'RECTIFICATION' })]);
    expect(ligne(revision, 'provider')[0].evidenceKey).not.toBe(cle);
    const periode = relever('INTERVENTION', [facture(1), facture(2, { dates: d({ startDate: '2026-01-01' }) })]);
    expect(ligne(periode, 'provider')[0].evidenceKey).not.toBe(cle);
    // Une facture RECTIFICATIVE (même valeur textuelle, relation déclarée) change le périmètre : c'est le cas
    // « facture rectificative après résolution » du ticket.
    expect(evidenceScopeKeyOf([{ normalized: 'x', identity: cand(), src: { role: 'SUPPLIER', documentRole: 'INVOICE', authority: 'DOCUMENT' } }]))
      .not.toBe(evidenceScopeKeyOf([{ normalized: 'x', identity: cand({ documentRelation: 'RECTIFICATION' }), src: { role: 'SUPPLIER', documentRole: 'INVOICE', authority: 'DOCUMENT' } }]));
  });

  it('CONTRE-EXEMPLE — choix de l’utilisateur et preuve matériellement NOUVELLE : question ciblée, valeur jamais écrasée (avant : rien, la décision restait figée)', () => {
    const r0 = relever('INTERVENTION', [facture(1), facture(2)]);
    const l0 = ligne(r0, 'provider')[0];
    const MARTIN = l0.values.find((v) => v.value === 'Chauffage Martin')!.normalized;
    const known = l0.values.map((v) => v.normalized);
    const choix = (evidenceKey?: string): Map<string, AttributeChoice> => new Map([[attributeChoiceKey('provider', 'SUPPLIER'), {
      field: 'provider' as ConflictField, role: 'SUPPLIER', normalized: MARTIN, known, by: 'USER' as const, sourceId: 99,
      ...(evidenceKey ? { evidenceKey } : {}),
    }]]);
    // Même périmètre que la réponse : la contradiction reste tranchée (aucune question inutile).
    const stable = relever('INTERVENTION', [facture(1), facture(2)], { choices: choix(l0.evidenceKey!), persisted: { provider: 'Chauffage Martin' } });
    expect(stable.divergences.map((c) => c.reasonCode)).toEqual(['USER_ARBITRATED']);
    // Périmètre matériel AUTRE (pièce plus autoritaire) : question ciblée, valeur de l'utilisateur en place et protégée.
    const change = relever('INTERVENTION', [facture(1), facture(2, { role: 'CONTRACT_DOCUMENT' })], { choices: choix(l0.evidenceKey!), persisted: { provider: 'Chauffage Martin' } });
    const l1 = change.alerting[0];
    expect([l1.qualification, l1.reasonCode, l1.protection]).toEqual(['REAL_CONFLICT_UNRESOLVED', 'USER_DECISION_EVIDENCE_CHANGED', 'USER']);
    expect(needsArbitrationCard(l1)).toBe(true);
    // Jamais renvoyée à l'IA : la valeur est protégée par l'utilisateur.
    expect(eligibleForArbitration(l1)).toBe(false);
    // Décision ANTÉRIEURE à la carte #836 (aucun périmètre mémorisé) : aucune question nouvelle au déploiement.
    const ancienne = relever('INTERVENTION', [facture(1), facture(2, { role: 'CONTRACT_DOCUMENT' })], { choices: choix(), persisted: { provider: 'Chauffage Martin' } });
    expect(ancienne.divergences.map((c) => c.reasonCode)).toEqual(['USER_ARBITRATED']);
  });

  it('un examen T3 « faits distincts » rendu sur un AUTRE périmètre ne couvre plus la ligne (acquis #791 conservé)', () => {
    const r0 = relever('INTERVENTION', [facture(1), facture(2)]);
    const l0 = ligne(r0, 'provider')[0];
    const examen = (evidenceKey?: string): Map<string, AttributeReview> => new Map([[attributeChoiceKey('provider', 'SUPPLIER'), {
      field: 'provider', role: 'SUPPLIER', known: l0.values.map((v) => v.normalized), outcome: 'LEGITIMATE_DIFFERENCE', reviewId: 6,
      ...(evidenceKey ? { evidenceKey } : {}),
    }]]);
    expect(relever('INTERVENTION', [facture(1), facture(2)], { reviews: examen(l0.evidenceKey!) }).alerting).toEqual([]);
    expect(relever('INTERVENTION', [facture(1), facture(2, { role: 'CONTRACT_DOCUMENT' })], { reviews: examen(l0.evidenceKey!) })
      .alerting.map((c) => c.qualification)).toEqual(['REAL_CONFLICT_UNRESOLVED']);
  });
});

// ── C836-U-E01 ────────────────────────────────────────────────────────────

describe('C836-U-E01 — le même jour économique n’efface plus une contradiction de la même assertion (E01)', () => {
  const vente = (id: number, role: CandidateIdentity['role'], jour: string, over: Partial<CandidateIdentity> = {}) => src(id, cand({
    candidateId: id, fileId: 10 + id, type: 'ACQUISITION', role, refs: [ref('ORDER', 'A-1')], dates: d({ realizedDate: jour }), ...over,
  }));

  it('CONTRE-EXEMPLE — deux ACTES de la même vente à J+2 : CONFLIT RÉEL (avant : « même jour économique », aucune question)', () => {
    const r = relever('ACQUISITION', [vente(1, 'SALE_DOCUMENT', '2026-03-12'), vente(2, 'SALE_DOCUMENT', '2026-03-14')]);
    expect(ligne(r, 'realizedDate').map((c) => [c.qualification, c.reasonCode])).toEqual([['REAL_CONFLICT_UNRESOLVED', 'SAME_REFERENCE']]);
    expect(needsArbitrationCard(r.alerting[0])).toBe(true);
    // … et la valeur conservée ne change pas (aucune règle de rétention touchée).
    expect(r.state.realizedDate).toBe('2026-03-12');
  });

  it('CONTRE-EXEMPLE — même assertion à J+7, borne exacte de la tolérance : CONFLIT RÉEL', () => {
    expect(SAME_DATE_DAYS).toBe(7);
    const r = relever('ACQUISITION', [vente(1, 'SALE_DOCUMENT', '2026-03-12'), vente(2, 'SALE_DOCUMENT', '2026-03-19')]);
    expect(r.state.attributeConflicts[0].sameEconomicDay).toBe(true);
    expect(ligne(r, 'realizedDate').map((c) => c.reasonCode)).toEqual(['SAME_REFERENCE']);
  });

  it('DOMAINE PRÉSERVÉ (décision PO du 16/11) — deux PIÈCES de natures différentes d’une même transaction à J+2 : différence consultable, aucune question', () => {
    const r = relever('ACQUISITION', [vente(1, 'SALE_DOCUMENT', '2026-06-30'), vente(2, 'REPORT', '2026-07-02')]);
    expect(r.alerting).toEqual([]);
    expect(ligne(r, 'realizedDate').map((c) => [c.qualification, c.reasonCode])).toEqual([['LEGITIMATE_DIFFERENCE', 'SAME_ECONOMIC_DAY']]);
    expect(r.state.realizedDate).toBe('2026-06-30');
  });

  it('FAITS DIFFÉRENTS — dates de rôles différents à J+2 (devis / facture, signature / couverture) : aucun faux conflit', () => {
    const devisFacture = relever('INTERVENTION', [
      src(1, cand({ role: 'QUOTE', status: 'ENVISAGED', dates: d({ plannedDate: '2026-11-05' }) })),
      src(2, cand({ candidateId: 2, fileId: 11, role: 'INVOICE', dates: d({ realizedDate: '2026-11-07' }) })),
    ]);
    expect(devisFacture.alerting).toEqual([]);
    const signatureCouverture = relever('CONTRACT', [
      src(1, cand({ type: 'CONTRACT', role: 'CONTRACT_DOCUMENT', refs: [ref('CONTRACT', 'P-9')], dates: d({ startDate: '2026-11-05' }) })),
      src(2, cand({ candidateId: 2, fileId: 11, type: 'CONTRACT', role: 'CONTRACT_DOCUMENT', coverageDocument: true, refs: [ref('CONTRACT', 'P-9')], dates: d({ startDate: '2026-11-07' }) })),
    ]);
    expect(signatureCouverture.alerting).toEqual([]);
    expect(ligne(signatureCouverture, 'startDate').map((c) => c.reasonCode)).toEqual(['ROLES_DIFFER']);
  });

  it('CONTRAT / FINANCEMENT : aucune fenêtre, donc aucun adoucissement — 05/11 contre 12/11 reste un conflit (acquis #791)', () => {
    for (const type of ['CONTRACT', 'FINANCING'] as const) {
      const r = relever(type, [
        src(1, cand({ type, role: 'CONTRACT_DOCUMENT', refs: [ref('CONTRACT', 'P-9')], dates: d({ startDate: '2026-11-05' }) })),
        src(2, cand({ candidateId: 2, fileId: 11, type, role: 'CONTRACT_DOCUMENT', refs: [ref('CONTRACT', 'P-9')], dates: d({ startDate: '2026-11-12' }) })),
      ]);
      expect(r.state.attributeConflicts[0].sameEconomicDay, type).toBeUndefined();
      expect(ligne(r, 'startDate').map((c) => c.qualification), type).toEqual(['REAL_CONFLICT_UNRESOLVED']);
    }
  });

  it('FUSEAUX : deux écritures du MÊME instant restent une seule valeur (aucun conflit inventé)', () => {
    const r = relever('ACQUISITION', [
      vente(1, 'SALE_DOCUMENT', '2026-03-12'),
      vente(2, 'SALE_DOCUMENT', '2026-03-11T23:30:00Z'),
    ]);
    expect(ligne(r, 'realizedDate').map((c) => c.reasonCode)).toEqual(['FORMAT_EQUIVALENT']);
    expect(r.alerting).toEqual([]);
  });

  it('`sameAssertionContradicted` (pur) : identité matérielle exigée, natures différentes exclues', () => {
    const it0 = (normalized: string, over: Partial<CandidateIdentity> = {}, role = 'REALIZATION', documentRole: CandidateIdentity['role'] = 'SALE_DOCUMENT') =>
      ({ normalized, identity: cand({ refs: [ref('ORDER', 'A-1')], ...over }), src: { role, documentRole, authority: 'DOCUMENT' } });
    expect(sameAssertionContradicted([it0('2026-03-12'), it0('2026-03-14')])).toBe(true);
    // Nature de pièce différente : deux pièces d'une même transaction, pas la même assertion.
    expect(sameAssertionContradicted([it0('2026-03-12'), it0('2026-03-14', {}, 'REALIZATION', 'REPORT')])).toBe(false);
    // Aucune identité matérielle (ni référence, ni même pièce) : rien n'est affirmé du même fait.
    const sansIdentite = { normalized: '2026-03-14', identity: null, src: { role: 'REALIZATION', documentRole: null, authority: null } };
    expect(sameAssertionContradicted([{ ...sansIdentite, normalized: '2026-03-12' }, sansIdentite])).toBe(false);
  });
});

// ── C836-U-E05 ────────────────────────────────────────────────────────────

describe('C836-U-E05 — preuve liant SPÉCIFIQUEMENT les deux assertions comparées (E05)', () => {
  const police = (id: number, over: Partial<CandidateIdentity>) => src(id, cand({
    candidateId: id, fileId: 10 + id, type: 'CONTRACT', role: 'CONTRACT_DOCUMENT', refs: [ref('CONTRACT', 'P-1')], ...over,
  }));
  const devis = (id: number, fileId: number, prevue: string, over: Partial<CandidateIdentity> = {}) => src(id, cand({
    candidateId: id, fileId, role: 'QUOTE', status: 'ENVISAGED', dates: d({ plannedDate: prevue }), ...over,
  }));

  it('CONTRE-EXEMPLE — le MÊME devis en deux PDF contradictoires : conflit (avant : deux identifiants de documents suffisaient à présumer deux devis)', () => {
    const r = relever('INTERVENTION', [
      devis(1, 10, '2026-02-10', { refs: [ref('QUOTE', 'DEV-7')] }),
      devis(2, 11, '2026-03-10', { refs: [ref('QUOTE', 'DEV-7')] }),
    ]);
    expect(ligne(r, 'plannedDate').map((c) => c.reasonCode)).not.toEqual(['QUOTE_REVISION']);
    expect(ligne(r, 'plannedDate').map((c) => c.qualification)).toEqual(['REAL_CONFLICT_UNRESOLVED']);
  });

  it('CONTRE-EXEMPLE — deux devis SANS aucune preuve d’identité : abstention, jamais « légitime » (avant : QUOTE_REVISION)', () => {
    const r = relever('INTERVENTION', [devis(1, 10, '2026-02-10'), devis(2, 11, '2026-03-10')]);
    expect(ligne(r, 'plannedDate').map((c) => [c.qualification, c.reasonCode])).toEqual([['INSUFFICIENT_EVIDENCE', 'FACT_IDENTITY_NOT_ESTABLISHED']]);
  });

  it('OFFRES DISTINCTES PROUVÉES (références de devis différentes) : différence légitime', () => {
    const r = relever('INTERVENTION', [
      devis(1, 10, '2026-02-10', { refs: [ref('QUOTE', 'DEV-1')] }),
      devis(2, 11, '2026-03-10', { refs: [ref('QUOTE', 'DEV-2')] }),
    ]);
    expect(r.alerting).toEqual([]);
    expect(ligne(r, 'plannedDate').map((c) => c.reasonCode)).toEqual(['QUOTE_REVISION']);
  });

  it('DEVIS CORRIGÉ PROUVÉ : le rectificatif d’une AUTRE pièce est une succession ; déclaré sur la pièce qui porte les deux valeurs, il ne prouve rien', () => {
    const lie = relever('INTERVENTION', [devis(1, 10, '2026-02-10'), devis(2, 11, '2026-03-10', { documentRelation: 'RECTIFICATION' })]);
    expect(ligne(lie, 'plannedDate').map((c) => c.reasonCode)).toEqual(['QUOTE_REVISION']);
    const memePiece = relever('INTERVENTION', [devis(1, 10, '2026-02-10'), devis(2, 10, '2026-03-10', { documentRelation: 'RECTIFICATION' })]);
    expect(ligne(memePiece, 'plannedDate').map((c) => c.reasonCode)).not.toEqual(['QUOTE_REVISION']);
  });

  it('CONTRAT REMPLACÉ : avenant déclaré entre DEUX pièces, ou périodes contractuelles disjointes — sinon la contradiction demeure', () => {
    const avenant = relever('CONTRACT', [
      police(1, { provider: 'Assureur A', providerKey: 'assureura', dates: d({ startDate: '2022-01-01' }) }),
      police(2, { provider: 'Assureur B', providerKey: 'assureurb', dates: d({ startDate: '2024-01-01' }), documentRelation: 'AMENDMENT' }),
    ]);
    expect(ligne(avenant, 'provider').map((c) => c.reasonCode)).toEqual(['SUCCESSIVE_REVISION']);
    expect(avenant.state.provider).toBe('Assureur A');
    // ANCIEN / NOUVEL ASSUREUR sans preuve de succession : contradiction réelle, l'utilisateur tranche.
    const sansPreuve = relever('CONTRACT', [
      police(1, { provider: 'Assureur 2022', providerKey: 'a2022', dates: d({ startDate: '2022-01-01' }) }),
      police(2, { provider: 'Assureur 2024', providerKey: 'a2024', dates: d({ startDate: '2024-01-01' }) }),
    ]);
    expect(ligne(sansPreuve, 'provider').map((c) => c.qualification)).toEqual(['REAL_CONFLICT_UNRESOLVED']);
  });

  it('RELATION INDÉMONTRABLE — une relation déclarée par la pièce qui porte AUSSI l’autre valeur n’est pas une succession (aucun avenant inventé)', () => {
    const r = relever('CONTRACT', [
      police(1, { fileId: 20, provider: 'Assureur A', providerKey: 'assureura', dates: d({ startDate: '2022-01-01' }), documentRelation: 'AMENDMENT' }),
      police(2, { fileId: 20, provider: 'Assureur B', providerKey: 'assureurb', dates: d({ startDate: '2024-01-01' }), documentRelation: 'AMENDMENT' }),
    ]);
    expect(ligne(r, 'provider').map((c) => c.reasonCode)).not.toEqual(['SUCCESSIVE_REVISION']);
  });
});

// ── C836-U-E04 ────────────────────────────────────────────────────────────

describe('C836-U-E04 — mise à jour CONTRÔLÉE du prestataire déjà en place (E04)', () => {
  const avec = (id: number, role: CandidateIdentity['role'], nom: string) => src(id, cand({
    candidateId: id, fileId: 10 + id, role, provider: nom, providerKey: nom.toLowerCase(),
  }));
  const banque = (id: number, nom: string) => avec(id, 'PAYMENT_PROOF', nom);
  const facture = (id: number, nom: string) => avec(id, 'INVOICE', nom);

  it('CONTRE-EXEMPLE — BANQUE en place, FACTURE du fournisseur ensuite : mise à jour contrôlée et tracée (avant : la banque restait « le prestataire »)', () => {
    const maj = providerAuthorityUpdate('Banque Populaire', [banque(1, 'Banque Populaire'), facture(2, 'Plomberie Durand')]);
    expect(maj).toEqual({ value: 'Plomberie Durand', reasonCode: 'T3_PROVIDER_MORE_AUTHORITATIVE' });
    // ORDRE INVERSE des sources : même résultat (invariance conservée).
    expect(providerAuthorityUpdate('Banque Populaire', [facture(1, 'Plomberie Durand'), banque(2, 'Banque Populaire')]))
      .toEqual({ value: 'Plomberie Durand', reasonCode: 'T3_PROVIDER_MORE_AUTHORITATIVE' });
    expect(canonicalProvider([banque(1, 'Banque Populaire'), facture(2, 'Plomberie Durand')])).toBe('Plomberie Durand');
  });

  it('FACTURE APRÈS PAIEMENT, acte notarié, rapport d’intervenant : seule une autorité STRICTEMENT supérieure remplace', () => {
    expect(providerAuthorityUpdate('Office Notarial Dupont', [avec(1, 'SALE_DOCUMENT', 'Office Notarial Dupont'), facture(2, 'Promoteur Sud')]))
      .toMatchObject({ value: 'Promoteur Sud' });
    // Le facturant en place NE CÈDE PAS la place à un exécutant ni à une banque.
    expect(providerAuthorityUpdate('Plomberie Durand', [facture(1, 'Plomberie Durand'), avec(2, 'REPORT', 'Diagnostics Ouest')])).toBeNull();
    expect(providerAuthorityUpdate('Plomberie Durand', [facture(1, 'Plomberie Durand'), banque(2, 'Banque Populaire')])).toBeNull();
  });

  it('À RANG ÉGAL (deux factures, deux prestataires) : AUCUNE décision d’office — la contradiction va à l’arbitrage', () => {
    expect(providerAuthorityUpdate('Plomberie Durand', [facture(1, 'Plomberie Durand'), facture(2, 'Chauffage Martin')])).toBeNull();
    const r = relever('INTERVENTION', [
      src(1, cand({ role: 'INVOICE', provider: 'Plomberie Durand', providerKey: 'plomberie durand', refs: [ref('INVOICE', 'F-1')] })),
      src(2, cand({ candidateId: 2, fileId: 11, role: 'INVOICE', provider: 'Chauffage Martin', providerKey: 'chauffage martin', refs: [ref('INVOICE', 'F-1')] })),
    ]);
    expect(ligne(r, 'provider').map((c) => c.qualification)).toEqual(['REAL_CONFLICT_UNRESOLVED']);
  });

  it('PROTECTIONS — valeur de l’utilisateur, rétablissement BO, import : jamais remplacée', () => {
    const saisie = src(1, cand({ role: null, provider: 'Chauffagiste Martin', providerKey: 'chauffagiste martin', agenda: { itemId: 3, realizedDate: null, realizationRecord: false } }));
    expect(providerAuthorityUpdate('Chauffagiste Martin', [saisie, facture(2, 'Plomberie Durand')])).toBeNull();
    for (const autorite of ['USER', 'ADMIN', 'IMPORT']) {
      expect(providerAuthorityUpdate('Banque Populaire', [banque(1, 'Banque Populaire'), facture(2, 'Plomberie Durand')], (id) => (id === 1 ? autorite : 'DOCUMENT')), autorite).toBeNull();
    }
  });

  it('CHANGEMENT D’ASSUREUR 2022 → 2024 (même rôle) : aucune mise à jour d’office, la contradiction est arbitrée', () => {
    const police = (id: number, nom: string) => src(id, cand({
      candidateId: id, fileId: 10 + id, type: 'CONTRACT', role: 'CONTRACT_DOCUMENT', provider: nom, providerKey: nom.toLowerCase(),
    }));
    expect(providerAuthorityUpdate('Assureur 2022', [police(1, 'Assureur 2022'), police(2, 'Assureur 2024')])).toBeNull();
  });

  it('valeur en place que PLUS AUCUNE source ne porte : laissée à la règle du RETRAIT (78A §5), pas à celle-ci', () => {
    expect(providerAuthorityUpdate('Ancien Prestataire', [facture(1, 'Plomberie Durand')])).toBeNull();
  });
});

// ── C836-U-E02 ────────────────────────────────────────────────────────────

describe('C836-U-E02 — inventaire des preuves AVANT sélection (E02)', () => {
  const valeur = (j: string, file: number) => ({ value: `2026-03-${j}`, normalized: `2026-03-${j}`, fileIds: [file], held: false, userProtected: false });
  const doc = (id: number, extrait: string, references: Array<{ kind: string; value: string }> = []) =>
    ({ id, type: 'INVOICE', title: `Facture ${id}`, date: '2026-03-20', provider: 'Plomberie Durand', references, excerpts: [extrait] });
  const BASE: RawArbitrationContext = {
    today: TODAY, field: 'realizedDate', role: 'REALIZATION', operation: { typeCode: 'INTERVENTION', label: 'Chauffe-eau' },
    values: [valeur('12', 21), valeur('19', 22)],
    documents: [doc(21, 'Intervention réalisée le 12/03/2026'), doc(22, 'Intervention réalisée le 19/03/2026')],
    inventory: { documentsMissing: 0, failedWindows: 0, units: { total: 4, kept: 4 }, references: { total: 2, kept: 2 } },
  };
  const sortie = (over: Record<string, unknown> = {}) => ({
    task: 'ATTRIBUTE_ARBITRATION', outcome: 'DISTINCT_FACTS', retainedValue: null, foreignDocument: null, confidence: 'certain',
    evidence: [{ document: 'D1', excerpt: 'Intervention réalisée le 12/03/2026' }], reason: 'Deux faits.', ...over,
  });

  it('inventaire COMPLET : la couverture est prouvée et les verdicts gardent leur effet', () => {
    const b = buildArbitrationInput(BASE);
    expect(b.scope.complete).toBe(true);
    expect(b.input.bounds).toMatchObject({ complete: true, droppedValues: 0, droppedDocuments: 0 });
    expect(b.input.bounds.droppedUnits).toBeUndefined();
    expect(validateArbitration(sortie(), b.scope)).toMatchObject({ ok: true, effect: { outcome: 'DISTINCT_FACTS' } });
  });

  it('CONTRE-EXEMPLE — 13ᵉ UNITÉ d’un document (plafond de 12 par document) : couverture NON prouvée, aucun verdict (avant : contexte réputé complet)', () => {
    const b = buildArbitrationInput({ ...BASE, inventory: { documentsMissing: 0, failedWindows: 0, units: { total: 13, kept: 12 }, references: { total: 2, kept: 2 } } });
    expect(b.scope.complete).toBe(false);
    expect(b.scope.incomplete).toBe('UNITS_DROPPED');
    expect(b.input.bounds).toMatchObject({ complete: false, droppedUnits: 1 });
    for (const outcome of ['DISTINCT_FACTS', 'UNDECIDABLE', 'RESOLVED'] as const) {
      const v = validateArbitration(sortie(outcome === 'RESOLVED' ? { outcome, retainedValue: 'V1' } : { outcome }), b.scope);
      expect(v.ok, outcome).toBe(false);
      if (!v.ok) expect(v.problems.map((p) => p.issue)).toContain('CONTEXT_INCOMPLETE');
    }
    // Seule l'ABSTENTION reste recevable sur un contexte partiel (acquis #791).
    expect(validateArbitration(sortie({ outcome: 'ABSTAIN', evidence: [] }), b.scope)).toMatchObject({ ok: true, ignored: 'ABSTAIN' });
  });

  it('CONTRE-EXEMPLE — RÉFÉRENCE hors des six premières : couverture non prouvée (la référence du même fait pouvait être la septième)', () => {
    const sept = Array.from({ length: 7 }, (_, i) => ({ kind: 'INVOICE', value: `F-${i + 1}` }));
    const b = buildArbitrationInput({ ...BASE, documents: [doc(21, 'Intervention réalisée le 12/03/2026', sept), BASE.documents[1]] });
    expect(b.scope.complete).toBe(false);
    expect(b.scope.incomplete).toBe('REFERENCES_DROPPED');
    expect(b.input.bounds.droppedReferences).toBe(1);
    // L'inventaire seul suffit aussi (références comptées à la collecte).
    const parInventaire = buildArbitrationInput({ ...BASE, inventory: { documentsMissing: 0, failedWindows: 0, units: { total: 4, kept: 4 }, references: { total: 12, kept: 10 } } });
    expect(parInventaire.scope.incomplete).toBe('REFERENCES_DROPPED');
  });

  it('PAGINATION INTERROMPUE ou SOURCE SUPPRIMÉE (fenêtre en échec, document demandé et absent) : couverture non prouvée', () => {
    expect(buildArbitrationInput({ ...BASE, inventory: { ...BASE.inventory!, failedWindows: 1 } }).scope.incomplete).toBe('COLLECTION_INTERRUPTED');
    expect(buildArbitrationInput({ ...BASE, inventory: { ...BASE.inventory!, documentsMissing: 1 } }).scope.incomplete).toBe('COLLECTION_INTERRUPTED');
  });

  it('INVENTAIRE IMPOSSIBLE (sonde des unités en échec) : couverture non prouvée — la limite de coût n’est pas l’exhaustivité', () => {
    const b = buildArbitrationInput({ ...BASE, inventory: { ...BASE.inventory!, unitsUnknown: true } });
    expect(b.scope.incomplete).toBe('INVENTORY_UNKNOWN');
    expect(validateArbitration(sortie(), b.scope).ok).toBe(false);
  });

  it('les bornes de COÛT du contrat ne changent pas (4 valeurs, 6 documents, 8 extraits, 6 références)', async () => {
    const { ARBITRATION_CONTEXT_BOUNDS } = await import('../attribute-arbitration/contract');
    expect(ARBITRATION_CONTEXT_BOUNDS).toEqual({ maxValues: 4, maxDocuments: 6, maxExcerptsPerDocument: 8, maxExcerptLength: 400, maxReferences: 6 });
    // 5ᵉ valeur et 7ᵉ document restent des couvertures non prouvées (acquis #791).
    const cinq = buildArbitrationInput({ ...BASE, values: ['01', '02', '03', '04', '05'].map((j, i) => valeur(j, 21 + i)), documents: ['01', '02', '03', '04', '05'].map((j, i) => doc(21 + i, `Intervention réalisée le ${j}/03/2026`)) });
    expect(cinq.scope.incomplete).toBe('VALUES_DROPPED');
    expect(cinq.scope.known).toHaveLength(5);
  });
});

// ── C836-U-E03, E06, E08 ──────────────────────────────────────────────────

describe('C836-U-E03 — déduplication Agenda bornée au rôle de date qu’il porte (E03)', () => {
  it('CONTRE-EXEMPLE — mêmes dates pour DEUX RÔLES : seule la réalisation peut être couverte par une carte de date d’Agenda', async () => {
    // Deux preuves de paiement contradictoires : rôle PAYMENT, jamais celui qu'un élément d'Agenda enregistre.
    const paiements = relever('INTERVENTION', [
      src(1, cand({ role: 'PAYMENT_PROOF', refs: [ref('INVOICE', 'F-5')], dates: d({ realizedDate: '2026-03-12' }) })),
      src(2, cand({ candidateId: 2, fileId: 11, role: 'PAYMENT_PROOF', refs: [ref('INVOICE', 'F-5')], dates: d({ realizedDate: '2026-04-20' }) })),
    ]);
    const l = ligne(paiements, 'realizedDate')[0];
    expect([l.field, l.role, l.qualification]).toEqual(['realizedDate', 'PAYMENT', 'REAL_CONFLICT_UNRESOLVED']);
    expect(needsArbitrationCard(l)).toBe(true);
    // La règle est la MÊME des deux côtés : génération de cartes et contrôle de cohérence.
    const { readFileSync } = await import('node:fs');
    const conso = readFileSync('src/services/business-operations/consolidation/consolidator.ts', 'utf8');
    expect(conso).toMatch(/const parAgenda = \(c: QualifiedAttributeConflict\) => c\.field === 'realizedDate' && c\.role === 'REALIZATION'/);
    const coh = readFileSync('src/services/coherence/registry/checks/operations-attribute-conflicts.ts', 'utf8');
    expect(coh).toMatch(/c->>'field' = 'realizedDate' AND c->>'role' = 'REALIZATION'/);
  });
});

describe('C836-U-E06 — contradiction d’une opération 100 % structurée (E06)', () => {
  it('aucune pièce, aucun candidat documentaire : la contradiction est relevée, qualifiée et appelle une carte', () => {
    const structuree = (id: number, date: string) => src(id, cand({
      candidateId: id, fileId: 0, type: 'ACQUISITION', role: null, dates: d({ realizedDate: date }),
      refs: [ref('ORDER', 'A-7')], structured: { nature: 'ACQUISITION' }, targetAuthority: 'USER',
    }));
    const r = relever('ACQUISITION', [structuree(1, '2026-01-10'), structuree(2, '2026-02-10')]);
    expect(ligne(r, 'realizedDate').map((c) => [c.role, c.qualification])).toEqual([['REALIZATION', 'REAL_CONFLICT_UNRESOLVED']]);
    expect(needsArbitrationCard(r.alerting[0])).toBe(true);
  });

  it('CONTRE-EXEMPLE — le contrôle de cohérence ne dépend PLUS d’une ligne de source DOCUMENT active', async () => {
    const { readFileSync } = await import('node:fs');
    const coh = readFileSync('src/services/coherence/registry/checks/operations-attribute-conflicts.ts', 'utf8');
    // Avant : `s.source_kind = 'DOCUMENT' AND s.locator ? 'candidateKey'` — une opération structurée ou
    // importée n'entrait jamais dans le contrôle, et sa carte absente n'était jamais signalée.
    expect(coh).not.toMatch(/WHERE s\.active AND s\.source_kind = 'DOCUMENT' AND s\.locator \? 'candidateKey'/);
    expect(coh).toMatch(/WHERE s\.active\)/);
    const { operationsAttributeConflictsCheck } = await import('@/services/coherence/registry/checks/operations-attribute-conflicts');
    expect(operationsAttributeConflictsCheck.version).toBe(4);
    expect(operationsAttributeConflictsCheck.anomalies).toContain('ATTRIBUTE_CONFLICT_ARBITRATION_MISSING');
  });
});

describe('C836-U-E08 — rattachement erroné ENCORE ACTIF : action exploitable (E08)', () => {
  it('verdict « document étranger » : le document désigné voyage avec la ligne, et le doute reste visible', () => {
    const factures = [
      src(1, cand({ provider: 'Plomberie Durand', providerKey: 'plomberie durand', refs: [ref('INVOICE', 'F-118')] })),
      src(2, cand({ candidateId: 2, fileId: 11, provider: 'Chauffage Martin', providerKey: 'chauffage martin', refs: [ref('INVOICE', 'F-118')] })),
    ];
    const l0 = ligne(relever('INTERVENTION', factures), 'provider')[0];
    const reviews = new Map<string, AttributeReview>([[attributeChoiceKey('provider', 'SUPPLIER'), {
      field: 'provider', role: 'SUPPLIER', known: l0.values.map((v) => v.normalized), outcome: 'LINK_ERROR', reviewId: 8,
      evidenceKey: l0.evidenceKey!, foreignFileId: 11,
    }]]);
    const r = relever('INTERVENTION', factures, { reviews });
    expect(r.alerting.map((c) => [c.qualification, c.reasonCode, c.foreignFileId]))
      .toEqual([['SOURCE_LINK_ERROR_SUSPECTED', 'T3_LINK_ERROR_SUSPECTED', 11]]);
    // Aucune carte « Arbitrer » sur l'attribut : le mauvais rattachement se traite d'abord (acquis #750).
    expect(needsArbitrationCard(r.alerting[0])).toBe(false);
  });

  it('CONTRE-EXEMPLE — la chaîne de réparation EXISTE pour un rattachement encore actif (avant : un doute ouvert sans suite)', async () => {
    const { readFileSync } = await import('node:fs');
    const conso = readFileSync('src/services/business-operations/consolidation/consolidator.ts', 'utf8');
    // Une question exploitable est posée sur le document encore ACTIF (aucune dissociation décidée par le code).
    expect(conso).toMatch(/cards\.match\.push\(\{ fileId, candidateKey: actif\.key, basis: 'CERTAIN', operationIds: \[operationId\], typeHint: state\.type \}\)/);
    expect(conso).toMatch(/T3_LINK_ERROR_SUSPECTED' && c\.foreignFileId !== undefined/);
    // … et rien n'est détaché, fusionné ni scindé par un traitement.
    expect(conso).not.toMatch(/deactivateSource\([^)]*T3_LINK_ERROR/);
  });
});
