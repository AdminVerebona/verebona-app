/**
 * T3 — contrôle EXHAUSTIF de l'onglet « Informations » (lot 76J, ticket
 * « [P1] T3 — Généraliser le contrôle de complétude et de cohérence »).
 * Partie PURE : aucun accès base.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PAS DE SECOND CATALOGUE NI DE SECOND MOTEUR
 *
 * La liste des champs examinés est celle du REGISTRE CANONIQUE (`listFields`
 * pour la famille du bien, ou pour la cible ÉQUIPEMENT), celle-là même qui
 * construit les sections de l'onglet « Informations » (`section`), les
 * miroirs et `CanonicalAssetView`. Les colonnes d'identité et les
 * informations complémentaires sont les clés que le registre classe
 * `IDENTITY_COLUMN` / `ADDITIONAL_INFO`. Les décisions restent celles du
 * moteur commun (`decide`) : ce module ne fait que
 *   · dire, pour CHAQUE champ, s'il a été décidé sur preuves, s'il est vide
 *     ou renseigné sans preuve (« non vérifiable »), réservé à la saisie,
 *     hors capacité de la catégorie, ou colonne d'identité ;
 *   · protéger le texte libre (description, notes) : jamais réécrit ;
 *   · confronter la date d'achat aux événements « achat » de l'agenda et aux
 *     Opérations d'acquisition, en tenant compte de la PROVENANCE (deux
 *     données issues du même document ne sont jamais deux preuves).
 *
 * Un champ vide sans preuve ne produit JAMAIS de décision transmise au pont
 * « À traiter » : aucune carte n'est créée pour lui (T3-COH-08).
 * ══════════════════════════════════════════════════════════════════════════
 */
import {
  EXCLUDED_KEYS, getField, isFieldApplicableToAsset, listFields, normalizeDateValue, toAssetFamily,
  type CanonicalFieldDef, type CanonicalTargetType,
} from '@/services/canonical/registry';
import type { CurrentValue, ReconciliationDecision } from '../types';
import { normalize } from '../decision/normalizers';

/** Version du contrôle exhaustif : la changer fait repasser tout le stock (rattrapage automatique). */
export const INFORMATION_CHECK_VERSION = 'l76j-v1';

export type InventoryStatus =
  /** Champ décidé par le moteur, sur preuves. */
  | 'EVIDENCE'
  /** Vide, aucune preuve exploitable : non vérifiable, aucune carte. */
  | 'NO_EVIDENCE_EMPTY'
  /** Renseigné, aucune preuve : valeur conservée, non vérifiable. */
  | 'NO_EVIDENCE_FILLED'
  /** Saisie seule (D-D) : jamais inféré. */
  | 'INPUT_ONLY'
  /** Hors capacité de la catégorie (immatriculation d'un vélo, L32-1). */
  | 'NOT_APPLICABLE';

export interface InventoryLine {
  key: string;
  label: string;
  section: string | null;
  status: InventoryStatus;
  current: CurrentValue | null;
  freeText: boolean;
}

interface IdentityLine { key: string; value: unknown }

export interface InformationInventory {
  lines: InventoryLine[];
  identity: IdentityLine[];
  /** Champs du registre d'une AUTRE famille (ou cible) : non applicables, comptés seulement. */
  otherFamilyCount: number;
  /** Informations complémentaires (exports, D-12) : texte hors contrôle automatique. */
  additionalInfoCount: number;
}

const isEmpty = (c: CurrentValue | null) => !c || c.normalized === null || c.normalized === '';

/**
 * Inventaire exhaustif des champs de l'onglet « Informations » (pur).
 *   · `target` ASSET : champs du registre visant un bien, de la famille du
 *     bien ; capacité de catégorie contrôlée (`isFieldApplicableToAsset`) ;
 *   · `target` EQUIPMENT : champs admettant la cible équipement.
 * `decided` : clés décidées par le moteur sur preuves.
 */
export function informationInventory(p: {
  target: 'ASSET' | 'EQUIPMENT';
  category?: string | null;
  subtype?: string | null;
  current: (key: string) => CurrentValue | null;
  decided: ReadonlySet<string>;
  identity?: Record<string, unknown>;
}): InformationInventory {
  const cible: CanonicalTargetType = p.target;
  const famille = p.target === 'ASSET' ? toAssetFamily(p.category ?? null) ?? 'OBJECT' : undefined;
  const defs = listFields(famille, { targetType: cible });
  const tous = listFields(undefined, { targetType: cible });
  const lines: InventoryLine[] = defs.map((d) => {
    const current = p.current(d.key);
    let status: InventoryStatus;
    if (p.target === 'ASSET' && !isFieldApplicableToAsset(d.key, { category: p.category ?? null, subtype: p.subtype ?? null })) status = 'NOT_APPLICABLE';
    else if (d.inputOnly) status = 'INPUT_ONLY';
    else if (p.decided.has(d.key)) status = 'EVIDENCE';
    else status = isEmpty(current) ? 'NO_EVIDENCE_EMPTY' : 'NO_EVIDENCE_FILLED';
    return { key: d.key, label: d.label, section: d.section ?? null, status, current, freeText: d.freeText === true };
  });
  const identity = p.identity
    ? EXCLUDED_KEYS.filter((e) => e.kind === 'IDENTITY_COLUMN' && Object.prototype.hasOwnProperty.call(p.identity, e.key))
      .map((e) => ({ key: e.key, value: p.identity![e.key] ?? null }))
    : [];
  return {
    lines, identity,
    otherFamilyCount: tous.length - defs.length,
    additionalInfoCount: EXCLUDED_KEYS.filter((e) => e.kind === 'ADDITIONAL_INFO').length,
  };
}

/** Clé de texte libre (registre : `freeText`) — description, notes. */
export function isFreeTextKey(key: string): boolean {
  return getField(key)?.freeText === true;
}

/**
 * Texte libre : une valeur EN PLACE n'est jamais remplacée automatiquement
 * (pur). Une preuve peut compléter un champ vide ; un conflit reste proposé.
 */
export function guardFreeText(decision: ReconciliationDecision): ReconciliationDecision {
  if (decision.action !== 'update' || !isFreeTextKey(decision.fieldKey)) return decision;
  return { ...decision, action: 'keep', proposedValue: decision.currentValue, reasonCode: 'FREE_TEXT_PROTECTED' };
}

// ── Confrontation agenda / Opérations (date d'achat du bien) ────────────────

/** Événement « achat » de l'agenda lié au BIEN seul (jamais à un de ses équipements). */
export interface AgendaPurchaseObservation {
  source: 'AGENDA';
  id: number;
  date: string;
  automatic: boolean;
  /** Réalisé saisi par l'utilisateur, ou événement automatique confirmé par lui. */
  confirmed: boolean;
  /** Projection de la fiche elle-même (champ du bien, Opération issue de la fiche) : jamais une preuve. */
  derivedFromField: boolean;
  sourceFileIds: number[];
}

/** Opération d'acquisition RÉALISÉE du bien (sans équipement). */
export interface OperationAcquisitionObservation {
  source: 'OPERATION';
  id: number;
  date: string | null;
  amountEur: number | null;
  derivedFromField: boolean;
  sourceFileIds: number[];
}

export type AcquisitionObservation = AgendaPurchaseObservation | OperationAcquisitionObservation;

export type CrossVerdict =
  /** Même valeur que la fiche. */
  | 'CONSISTENT'
  /** Reflet de la fiche (projection) : ni preuve ni contradiction. */
  | 'DERIVED_FROM_FIELD'
  /** Divergence portée par une donnée automatique non confirmée : non retenue. */
  | 'AGENDA_UNCONFIRMED_NOT_RETAINED'
  | 'OPERATION_NOT_RETAINED'
  /** Achat confirmé par l'utilisateur : complète le champ vide. */
  | 'CONFIRMED_FILL'
  /** Achat confirmé par l'utilisateur, contredit par la fiche : arbitrage. */
  | 'CONFIRMED_AGENDA_CONTRADICTION'
  /** Plusieurs achats confirmés de dates différentes : abstention. */
  | 'CONFIRMED_AMBIGUOUS'
  /** Même arbitrage déjà proposé puis tranché par l'utilisateur : pas reproposé. */
  | 'ALREADY_ARBITRATED'
  /** Colonne historique miroir différente de la fiche (D-10). */
  | 'MIRROR_DIVERGENCE';

export interface CrossRecord {
  fieldKey: string;
  value: unknown;
  verdict: CrossVerdict;
  source: 'AGENDA' | 'OPERATION' | 'MIRROR';
  refId: number | string | null;
  confirmed: boolean;
  /** Indépendante des preuves déjà connues (aucun document en commun). */
  independent: boolean;
  sharedSourceFileIds: number[];
  /** Contradiction détectée (valeur ≠ fiche, fiche renseignée). */
  contradiction: boolean;
}

export interface AcquisitionCrossResult {
  records: CrossRecord[];
  /** Décision supplémentaire (complétion ou arbitrage) — au plus une, par le moteur commun. */
  decision: ReconciliationDecision | null;
  /** Signature de l'arbitrage proposé (mémoire « déjà tranché »). */
  signature: string | null;
}

/**
 * Jour calendaire d'une date (pure). Lot 81A : normaliseur MÉTIER du registre
 * (`normalizeDateValue` : ISO avec ou sans heure, JJ/MM/AAAA, objet Date) —
 * avant, seule une chaîne ISO était lue : une fiche au 06/05/2021 passait
 * pour VIDE face à l'agenda, une date d'agenda en objet Date était ignorée.
 */
const jour = (v: unknown): string | null => normalizeDateValue(v);

/** Signature stable d'un arbitrage croisé (pure). */
export function crossSignature(fieldKey: string, current: unknown, proposed: string, refIds: number[]): string {
  return `${fieldKey}|${normalize(fieldKey, current) ?? ''}|${proposed}|${[...refIds].sort((a, b) => a - b).join(',')}`;
}

/**
 * Date d'achat du BIEN confrontée à l'agenda et aux Opérations (pure).
 *
 *   · donnée projetée de la fiche → DERIVED_FROM_FIELD (jamais une preuve) ;
 *   · même date que la fiche → CONSISTENT ;
 *   · événement AUTOMATIQUE non confirmé, ou Opération documentaire,
 *     divergents → NON RETENUS (T3-COH-01 : la date de l'agenda n'est pas
 *     nécessairement la bonne ; seules les preuves décident, par le moteur) ;
 *   · achat CONFIRMÉ par l'utilisateur (une seule date) :
 *       fiche vide → complétion (EMPTY_FIELD_CONFIRMED_AGENDA) ;
 *       fiche différente → arbitrage (CONFIRMED_AGENDA_CONTRADICTION), une
 *       seule fois par signature : déjà tranché → ALREADY_ARBITRATED ;
 *   · provenance : documents de l'observation ∩ documents des preuves
 *     actives du champ → `independent: false` (T3-COH-10).
 *
 * `engineDecision` : décision du moteur sur preuves pour ce champ. Une
 * écriture, un conflit ou une revue en cours du moteur prime : la
 * confrontation n'ajoute alors que des constats.
 */
export function crossCheckAcquisitionDate(p: {
  current: CurrentValue | null;
  evidenceSourceIds: readonly number[];
  observations: readonly AcquisitionObservation[];
  engineDecision: ReconciliationDecision | null;
  /** Signature déjà proposée et TRANCHÉE (aucun conflit ouvert) pour ce champ. */
  arbitratedSignature: string | null;
}): AcquisitionCrossResult {
  const fieldKey = 'acquisitionDate';
  const cur = jour(p.current?.value ?? null);
  const preuves = new Set(p.evidenceSourceIds);
  const records: CrossRecord[] = [];
  const confirmes: AgendaPurchaseObservation[] = [];
  for (const o of p.observations) {
    const date = jour(o.date);
    if (!date) continue;
    const partages = o.sourceFileIds.filter((f) => preuves.has(f));
    const confirmed = o.source === 'AGENDA' && o.confirmed;
    const base = {
      fieldKey, value: date, source: o.source, refId: o.id, confirmed,
      independent: !o.derivedFromField && partages.length === 0, sharedSourceFileIds: partages,
    } as const;
    if (o.derivedFromField) { records.push({ ...base, verdict: 'DERIVED_FROM_FIELD', contradiction: false }); continue; }
    if (cur === date) { records.push({ ...base, verdict: 'CONSISTENT', contradiction: false }); continue; }
    if (confirmed) { confirmes.push(o as AgendaPurchaseObservation); continue; }
    records.push({
      ...base, verdict: o.source === 'AGENDA' ? 'AGENDA_UNCONFIRMED_NOT_RETAINED' : 'OPERATION_NOT_RETAINED',
      contradiction: cur !== null,
    });
  }

  const dates = [...new Set(confirmes.map((o) => jour(o.date)!))];
  const moteurDecide = !!p.engineDecision && ['apply', 'update', 'create_conflict', 'request_ai_review'].includes(p.engineDecision.action);
  let decision: ReconciliationDecision | null = null;
  let signature: string | null = null;
  const pousser = (verdict: CrossVerdict, contradiction: boolean) => {
    for (const o of confirmes) {
      const partages = o.sourceFileIds.filter((f) => preuves.has(f));
      records.push({
        fieldKey, value: jour(o.date), source: 'AGENDA', refId: o.id, confirmed: true,
        independent: partages.length === 0, sharedSourceFileIds: partages, verdict, contradiction,
      });
    }
  };
  if (confirmes.length === 0) return { records, decision, signature };
  if (dates.length > 1) { pousser('CONFIRMED_AMBIGUOUS', cur !== null); return { records, decision, signature }; }

  const date = dates[0];
  const base = { fieldKey, currentValue: p.current?.value ?? null, proposedValue: date, deterministic: true, confidence: 'certain' as const, evidenceIds: [] as number[] };
  if (cur === null) {
    if (moteurDecide) { pousser('CONFIRMED_FILL', false); return { records, decision, signature }; }
    decision = { ...base, action: 'apply', reasonCode: 'EMPTY_FIELD_CONFIRMED_AGENDA' };
    pousser('CONFIRMED_FILL', false);
    return { records, decision, signature };
  }
  signature = crossSignature(fieldKey, p.current?.value ?? null, date, confirmes.map((o) => o.id));
  if (p.arbitratedSignature === signature) {
    pousser('ALREADY_ARBITRATED', true);
    return { records, decision: null, signature };
  }
  if (p.engineDecision && ['apply', 'update', 'create_conflict', 'request_ai_review'].includes(p.engineDecision.action)) {
    pousser('CONFIRMED_AGENDA_CONTRADICTION', true);
    return { records, decision: null, signature: null };
  }
  decision = { ...base, action: 'create_conflict', reasonCode: 'CONFIRMED_AGENDA_CONTRADICTION', confidence: 'conflictual' };
  pousser('CONFIRMED_AGENDA_CONTRADICTION', true);
  return { records, decision, signature };
}

/**
 * Colonnes historiques miroirs différentes de la fiche (pure) — D-10 : la
 * fiche fait foi et la primitive aligne les miroirs à chaque écriture ; un
 * écart historique est SIGNALÉ (la colonne peut porter une saisie de
 * l'ancien formulaire de création), jamais corrigé d'office.
 */
export function mirrorDivergences(p: {
  defs: readonly CanonicalFieldDef[];
  kc: Record<string, unknown>;
  row: Record<string, unknown>;
  fromColumn: (def: CanonicalFieldDef, column: string) => unknown;
  same: (key: string, a: unknown, b: unknown) => boolean;
}): CrossRecord[] {
  const out: CrossRecord[] = [];
  for (const d of p.defs) {
    const v = p.kc[d.key];
    if (v === undefined || v === null || v === '') continue;
    for (const col of d.mirrorColumns ?? []) {
      if (!(col.column in p.row)) continue;
      const c = p.fromColumn(d, col.column);
      if (c === null || c === undefined || c === '') continue;
      if (p.same(d.key, v, c)) continue;
      out.push({
        fieldKey: d.key, value: c, verdict: 'MIRROR_DIVERGENCE', source: 'MIRROR', refId: col.column, confirmed: false,
        independent: false, sharedSourceFileIds: [], contradiction: true,
      });
    }
  }
  return out;
}
