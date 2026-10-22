/**
 * Consolidation T3 des Opérations — règles PURES (lot 41, O3a ; CDC
 * Opérations V1 ch. 8, 11, B10, B11, C2.1, C10, C11, C11.1, C11.2, C12,
 * C12.1, C12.2, C12.3, C13).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * T1 EXTRAIT, T3 DÉCIDE — À PARTIR DE DONNÉES PERSISTÉES
 *
 * Un candidat T1 (`document_operation_candidates`, payload ancré du lot 40)
 * devient ici une IDENTITÉ candidate : nature, cible, période, prestataire,
 * références, montants qualifiés. Aucune lecture du fichier brut, aucun appel
 * IA (niveau M3 hors lot : voir `matching.ts`).
 *
 * Ce module ne touche pas la base : il rend
 *   · l'identité d'un candidat (`buildCandidateIdentity`) ;
 *   · les composantes financières que ses montants justifient
 *     (`componentsFromIdentity`, C12) et la règle anti-double-compte au
 *     niveau de l'Opération (`consolidateComponents`) ;
 *   · l'état consolidé d'une Opération depuis l'ensemble de ses sources
 *     documentaires actives (`consolidateOperationState` : statut C8 / B7,
 *     dates C11.1, type, prestataire, cibles C10, références, détails C13).
 *
 * Décisions de conception (documentées dans le rapport du lot) :
 *   · cible : seules les cibles T1 « certain » avec identifiant vérifié créent
 *     un lien (C10 : cible probable → aucun lien). À défaut, le bien auquel le
 *     document est rattaché sert de cible (autorité INFERENCE) ; sans l'un ni
 *     l'autre, l'Opération reste sans bien (P08, TARGET_UNRESOLVED dérivé) ;
 *   · identité d'une composante (C12.1) : rôle économique + portée +
 *     référence économique du document (numéro de facture, de devis) quand
 *     elle existe, sinon montant + devise + date + période. Deux copies d'une
 *     même facture produisent la même empreinte (F-032, F-108) ; une
 *     réanalyse qui corrige le montant d'une facture référencée supersède
 *     la composante (F-062, F-109) ;
 *   · acompte / solde (C12, F-092, F-093) : une facture TOTALE (portée TOTAL,
 *     ou facture finale sans portée) rend l'acompte et le solde de la même
 *     Opération non comptés (preuves de règlement) ; un acompte cité par
 *     plusieurs documents n'est qu'une composante (empreinte sans référence).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import {
  isBusinessOperationStatus, isIsoCurrency, isIsoDate, isMinorAmount, normalizeBusinessReference, normalizeOperationTypeHint,
  type BusinessOperationStatus, type BusinessOperationTypeCode, type Confidence, type FinancialComponentKind,
  type ReferenceKind, type SourceRole, REFERENCE_KINDS, SOURCE_ROLES,
} from '../model';

// ── Entrées persistées ─────────────────────────────────────────────────────

/** Indice financier persisté (payload lot 40, `candidatePayload`). */
export interface PersistedFinancialHint {
  role: string;
  amountMinor: number;
  /** « XXX » : devise non établie sur le document (lot 53D, D2). */
  currency: string;
  /** Lot 53D (Q16) : contre-valeur EUR écrite sur le document, vérifiée par la barrière T1. */
  amountEurMinor?: number | null;
  /** Lot 53D (D2) : devises plausibles d'un montant « XXX » (question de confirmation). */
  currencyCandidates?: string[];
  amountScope?: 'TOTAL' | 'DEPOSIT' | 'BALANCE' | 'INSTALLMENT' | 'FEE' | null;
  economicDate?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  /** Lot 40 : ancre du fait T1 qui porte le montant (`candidatePayload`). */
  evidence?: { factId?: number | null } | null;
  /** Lot 78A : rang de l'indice dans le payload persisté (trace composante → indice T1). */
  index?: number;
}

export interface PersistedTargetHint {
  type: 'ASSET' | 'EQUIPMENT' | 'ROOM';
  entityId: number | null;
  rawLabel?: string | null;
  confidence: string;
}

/** Ligne `document_operation_candidates` lue par T3 (champs utiles). */
export interface CandidateRecord {
  id: number;
  accountId: number;
  fileId: number;
  candidateKey: string;
  established: boolean;
  confidence: Confidence;
  typeHint: string | null;
  statusHint: string | null;
  summary: string;
  payload: {
    sourceRoleHint?: string | null;
    provider?: string | null;
    targetHints?: PersistedTargetHint[];
    businessReferences?: Array<{ kind: string; value: string }>;
    temporalHints?: { plannedDate?: string | null; startDate?: string | null; realizedDate?: string | null; endDate?: string | null };
    financialHints?: PersistedFinancialHint[];
  };
}

/** Contexte vérifié en base au moment de la consolidation. */
export interface IdentityContext {
  /** Bien principal du document (`asset_files.asset_id`, à défaut `linked_asset_id`), s'il existe encore. */
  fileAssetId: number | null;
  /** Biens du compte encore présents (non supprimés). */
  liveAssetIds: ReadonlySet<number>;
  /** Équipement → bien parent (équipements du compte encore présents). */
  equipmentAssets: ReadonlyMap<number, number>;
}

// ── Identité candidate ─────────────────────────────────────────────────────

export interface NormalizedReference {
  kind: ReferenceKind;
  value: string;
  normalized: string;
}

export interface CandidateDates {
  plannedDate: string | null;
  startDate: string | null;
  realizedDate: string | null;
  endDate: string | null;
}

export interface CandidateIdentity {
  candidateId: number;
  candidateKey: string;
  fileId: number;
  established: boolean;
  confidence: Confidence;
  type: BusinessOperationTypeCode | null;
  /** Statut que la source établit (statusHint, à défaut déduit du rôle). */
  status: BusinessOperationStatus;
  role: SourceRole | null;
  summary: string;
  provider: string | null;
  providerKey: string | null;
  /** Biens cibles résolus (cible certaine, sinon bien du document). */
  assetIds: number[];
  /** USER : bien de la donnée structurée elle-même (source ASSET_DATA, lot 43). */
  targetAuthority: 'DOCUMENT' | 'INFERENCE' | 'USER' | null;
  equipmentIds: number[];
  refs: NormalizedReference[];
  dates: CandidateDates;
  hints: PersistedFinancialHint[];
  /**
   * Lot 43 (O4) : identité d'une donnée STRUCTURÉE du bien (source
   * ASSET_DATA, `asset-data.ts`) et non d'un candidat T1 — sa nature et
   * l'origine de sa date (champ saisi, ou repli « passage au statut »).
   */
  structured?: { nature: string; dateBasis?: 'FIELD' | 'STATUS_CHANGE' | null };
  /**
   * Lot 47B : identité d'un élément d'AGENDA saisi / corrigé par
   * l'utilisateur (source AGENDA, `agenda-source.ts`).
   */
  agenda?: {
    itemId: number;
    /** Date de réalisation portée par l'élément (non future), si « réalisé ». */
    realizedDate: string | null;
    /** L'élément EST l'enregistrement de la réalisation (fait historique, « fait ») : sa date prime. */
    realizationRecord: boolean;
  };
}

const SUFFIXES_JURIDIQUES = /\b(sas|sasu|sarl|eurl|sa|sci|snc|ag|gmbh|ltd|llc|inc|bv|nv|spa|srl)\b/g;

/** Prestataire normalisé pour la comparaison (jamais pour l'affichage). */
export function normalizeProvider(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').replace(SUFFIXES_JURIDIQUES, ' ').replace(/\s+/g, '');
  return v.length >= 2 ? v : null;
}

const isRole = (v: unknown): v is SourceRole => typeof v === 'string' && (SOURCE_ROLES as readonly string[]).includes(v);
const isRefKind = (v: unknown): v is ReferenceKind => typeof v === 'string' && (REFERENCE_KINDS as readonly string[]).includes(v);
const dateOrNull = (v: unknown): string | null => (isIsoDate(v) ? v : null);

/** Statut établi par une source : son indice, sinon déduit du rôle (devis / commande → prévu). */
export function statusOfSource(statusHint: string | null, role: SourceRole | null): BusinessOperationStatus {
  if (isBusinessOperationStatus(statusHint)) {
    // Un devis ou une commande ne prouve jamais une réalisation (B10, C2.1).
    if (statusHint === 'REALIZED' && (role === 'QUOTE' || role === 'ORDER')) return 'ENVISAGED';
    return statusHint;
  }
  return role === 'QUOTE' || role === 'ORDER' ? 'ENVISAGED' : 'REALIZED';
}

/** Identité candidate d'un candidat persisté (pure). */
export function buildCandidateIdentity(c: CandidateRecord, ctx: IdentityContext): CandidateIdentity {
  const p = c.payload ?? {};
  const role = isRole(p.sourceRoleHint) ? p.sourceRoleHint : null;
  const certain = (p.targetHints ?? []).filter((t) => t.confidence === 'certain' && typeof t.entityId === 'number');
  const equipmentIds = [...new Set(certain.filter((t) => t.type === 'EQUIPMENT' && ctx.equipmentAssets.has(t.entityId as number)).map((t) => t.entityId as number))];
  const explicites = new Set<number>();
  for (const t of certain) {
    if (t.type === 'ASSET' && ctx.liveAssetIds.has(t.entityId as number)) explicites.add(t.entityId as number);
    if (t.type === 'EQUIPMENT') {
      const parent = ctx.equipmentAssets.get(t.entityId as number);
      if (parent !== undefined && ctx.liveAssetIds.has(parent)) explicites.add(parent);
    }
  }
  let assetIds = [...explicites].sort((a, b) => a - b);
  let targetAuthority: CandidateIdentity['targetAuthority'] = assetIds.length ? 'DOCUMENT' : null;
  if (!assetIds.length && ctx.fileAssetId !== null && ctx.liveAssetIds.has(ctx.fileAssetId)) {
    assetIds = [ctx.fileAssetId];
    targetAuthority = 'INFERENCE';
  }
  const vus = new Set<string>();
  const refs: NormalizedReference[] = [];
  for (const r of p.businessReferences ?? []) {
    if (!isRefKind(r?.kind) || typeof r.value !== 'string') continue;
    const normalized = normalizeBusinessReference(r.value);
    if (!normalized || vus.has(`${r.kind}:${normalized}`)) continue;
    vus.add(`${r.kind}:${normalized}`);
    refs.push({ kind: r.kind, value: r.value.trim(), normalized });
  }
  const t = p.temporalHints ?? {};
  // Lot 78A : le rang d'origine de chaque indice est conservé (trace composante → indice → fait).
  const hints = (p.financialHints ?? []).map((h, index) => (h ? { ...h, index } : h))
    .filter((h) => h && isMinorAmount(h.amountMinor) && isIsoCurrency(h.currency));
  return {
    candidateId: c.id,
    candidateKey: c.candidateKey,
    fileId: c.fileId,
    established: c.established,
    confidence: c.confidence,
    type: normalizeOperationTypeHint(c.typeHint),
    status: statusOfSource(c.statusHint, role),
    role,
    summary: c.summary,
    provider: p.provider?.trim() || null,
    providerKey: normalizeProvider(p.provider),
    assetIds,
    targetAuthority,
    equipmentIds,
    refs,
    dates: {
      plannedDate: dateOrNull(t.plannedDate),
      startDate: dateOrNull(t.startDate),
      realizedDate: dateOrNull(t.realizedDate),
      endDate: dateOrNull(t.endDate),
    },
    hints,
  };
}

// ── Lot 55B : preuve périodique (échéance d'un contrat) ────────────────────

/**
 * Le candidat porte-t-il la preuve d'une ÉCHÉANCE (pure) : un montant de
 * portée INSTALLMENT, ou une période facturée réelle (début < fin) ? Lue
 * telle que T1 l'a extraite (aucune interprétation du libellé) : c'est un
 * INDICE qui rend un contrat existant plausible pour la facture (M3 tranche),
 * jamais une preuve de rattachement à lui seul.
 */
export function hasRecurringPeriod(id: Pick<CandidateIdentity, 'hints'>): boolean {
  return id.hints.some((h) => h.amountScope === 'INSTALLMENT'
    || (isIsoDate(h.periodStart) && isIsoDate(h.periodEnd) && (h.periodStart as string) < (h.periodEnd as string)));
}

/** Clé de la période facturée d'un candidat (première période réelle), sinon null. */
export function billingPeriodKey(id: Pick<CandidateIdentity, 'hints'>): string | null {
  const h = id.hints.find((x) => isIsoDate(x.periodStart) && isIsoDate(x.periodEnd) && (x.periodStart as string) < (x.periodEnd as string));
  return h ? `${h.periodStart}/${h.periodEnd}` : null;
}

/**
 * Lot 55B — les sources d'une Opération prouvent-elles une relation
 * CONTRACTUELLE (pure) ? Toutes les sources documentaires sont compatibles
 * avec un contrat (qualifiées CONTRACT, ou échéances périodiques qualifiées
 * INTERVENTION / OTHER / sans type), au moins une est une échéance, ET : une
 * source est qualifiée CONTRACT, ou au moins deux échéances portent des
 * périodes facturées DIFFÉRENTES.
 * Une installation ou une réparation ponctuelle (aucune période) l'empêche :
 * l'Opération garde son type. Ne s'applique qu'à des sources que T3 a déjà
 * réunies (M0 / M1 / M3) — jamais une raison de rattacher.
 */
export function recurringContractEvidence(sources: readonly SourceContribution[]): boolean {
  const docs = sources.filter((s) => !s.identity.agenda && !s.identity.structured);
  if (!docs.length) return false;
  const compatibles = docs.every((s) => s.identity.type === 'CONTRACT'
    || ((s.identity.type === null || s.identity.type === 'INTERVENTION' || s.identity.type === 'OTHER') && hasRecurringPeriod(s.identity)));
  if (!compatibles) return false;
  // Au moins une échéance : une Opération qualifiée autrement dont les seules
  // sources sont des documents contractuels garde son type (C5-11, F-055).
  if (!docs.some((s) => hasRecurringPeriod(s.identity))) return false;
  if (docs.some((s) => s.identity.type === 'CONTRACT')) return true;
  const periodes = new Set(docs.map((s) => billingPeriodKey(s.identity)).filter((k): k is string => k !== null));
  return periodes.size >= 2;
}

/**
 * Lot 78A — fenêtre de cohérence temporelle d'UNE transaction selon sa nature
 * (jours) : au-delà, l'écart est une contradiction (faible pour le
 * rapprochement, attribut contradictoire pour la consolidation).
 *   · acquisition / cession : commande → livraison → facture, compromis →
 *     acte (quelques mois) ;
 *   · sinistre : survenue et déclaration ;
 *   · intervention et autres : 3 × 120 j (lot 53, `FAR_WINDOW_FACTOR`) ;
 *   · contrat / financement : durée de vie longue, pas de fenêtre.
 */
export function transactionWindowDays(type: BusinessOperationTypeCode | null): number | null {
  switch (type) {
    case 'ACQUISITION': case 'DISPOSAL': return 180;
    case 'CLAIM': return 90;
    case 'CONTRACT': case 'FINANCING': return null;
    default: return 360;
  }
}

// ── Composantes financières (C12) ──────────────────────────────────────────

export interface DesiredComponent {
  fingerprint: string;
  kind: FinancialComponentKind;
  amountMinor: number;
  currency: string;
  /** Lot 53D (Q16) : contre-valeur EUR documentaire (jamais calculée), sinon null. */
  amountEurCents: number | null;
  /** Lot 53D (D2) : devise « XXX » — devises plausibles à confirmer. */
  currencyCandidates?: string[];
  economicDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  scope: PersistedFinancialHint['amountScope'] | null;
  /** Rôle de la source qui la porte (règle de facture totale). */
  sourceRole: SourceRole | null;
  label: string | null;
  /**
   * Lot 55B (D) : ce qui distingue ce fait économique d'un autre de même
   * montant — référence du document, date ou période, portée (acompte /
   * solde / frais), ou RIEN (`NONE` : ni référence, ni date, ni période).
   */
  identityBasis?: 'REFERENCE' | 'DATE' | 'PERIOD' | 'SCOPE' | 'NONE';
  /** Lot 78A (§4, §6) : indices T1 et faits persistés qui justifient ce montant (documents seulement). */
  evidence?: ComponentEvidence;
}

/** Lot 78A : justification exacte d'une composante par UNE source (candidat T1, indices, faits). */
export interface ComponentEvidence {
  candidateId: number | null;
  hintIndexes: number[];
  factIds: number[];
}

const fusionPreuves = (a: ComponentEvidence | undefined, b: ComponentEvidence | undefined): ComponentEvidence | undefined => {
  if (!a) return b;
  if (!b) return a;
  return {
    candidateId: a.candidateId ?? b.candidateId,
    hintIndexes: [...new Set([...a.hintIndexes, ...b.hintIndexes])].sort((x, y) => x - y),
    factIds: [...new Set([...a.factIds, ...b.factIds])].sort((x, y) => x - y),
  };
};

/** Référence économique PROPRE au document, selon son rôle (identité C12.1). */
function documentReference(id: CandidateIdentity): string | null {
  const kinds: ReferenceKind[] | null = id.role === 'QUOTE' ? ['QUOTE']
    : id.role === 'ORDER' ? ['ORDER']
      : id.role === 'INVOICE' || id.role === 'DEPOSIT_INVOICE' ? ['INVOICE']
        : null;
  if (!kinds) return null;
  const r = id.refs.find((x) => kinds.includes(x.kind));
  return r ? `${r.kind}:${r.normalized}` : null;
}

const empreinte = (parts: Array<string | number | null | undefined>): string =>
  createHash('sha256').update(parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('|')).digest('hex').slice(0, 32);

/**
 * Rôle économique d'un montant selon le rôle de la source (C2.1, B10, C12,
 * C12.2) — `null` : aucune composante.
 *   · PAYMENT, ou toute somme d'une preuve de paiement : jamais un coût (INV-FINAL-015) ;
 *   · devis / commande : coût PRÉVU, jamais réalisé (INV-013) ;
 *   · avoir : réduction (montant ≥ 0, signe porté par le rôle) ;
 *   · document contractuel : le tarif annoncé est un coût PRÉVU (C12.2 :
 *     seule une facture / cotisation due crée un coût réalisé, F-110) ;
 *   · rôle inconnu : aucune composante (T1-OP-004, F-119).
 */
export function componentKindOf(hintRole: string, sourceRole: SourceRole | null): FinancialComponentKind | null {
  if (hintRole === 'PAYMENT' || sourceRole === 'PAYMENT_PROOF') return null;
  if (sourceRole === 'OTHER_EVIDENCE') return null;
  switch (hintRole) {
    case 'FORECAST_COST':
      return 'FORECAST_COST';
    case 'REALIZED_COST':
      if (sourceRole === 'QUOTE' || sourceRole === 'ORDER' || sourceRole === 'CONTRACT_DOCUMENT') return 'FORECAST_COST';
      if (sourceRole === 'CREDIT_NOTE') return 'REDUCTION';
      return 'REALIZED_COST';
    case 'REDUCTION':
    case 'REFUND':
    case 'INDEMNITY':
    case 'PROCEED':
      return hintRole;
    default:
      return null;
  }
}

/** Composantes qu'un candidat justifie (C12, C12.1, C12.3 : devise d'origine, jamais convertie). */
export function componentsFromIdentity(id: CandidateIdentity): DesiredComponent[] {
  const ref = documentReference(id);
  const out = new Map<string, DesiredComponent>();
  // Lot 48 (C12 « facture déjà nette après remise », F-096) : une remise lue
  // sur le document qui porte lui-même le coût est déjà intégrée à son total ;
  // seule une remise APRÈS facturation (avoir) réduit le coût.
  const porteUnCout = id.role !== 'CREDIT_NOTE' && id.hints.some((h) => {
    const k = componentKindOf(h.role, id.role);
    return k === 'REALIZED_COST' || k === 'FORECAST_COST';
  });
  for (const h of id.hints) {
    const kind = componentKindOf(h.role, id.role);
    if (!kind) continue;
    if (kind === 'REDUCTION' && porteUnCout) continue;
    // Lot 78A : justification exacte (indice T1 et fait persisté), documents seulement.
    const preuve: ComponentEvidence | undefined = id.structured || id.agenda ? undefined : {
      candidateId: id.candidateId > 0 ? id.candidateId : null,
      hintIndexes: typeof h.index === 'number' ? [h.index] : [],
      factIds: typeof h.evidence?.factId === 'number' ? [h.evidence.factId] : [],
    };
    const scope = h.amountScope ?? null;
    const economicDate = dateOrNull(h.economicDate);
    const periodStart = dateOrNull(h.periodStart);
    const periodEnd = dateOrNull(h.periodEnd);
    // Acompte / solde : un même acompte cité par plusieurs documents est une
    // seule composante — identité par montant, sans référence ni date.
    // Lot 53D (D9) : plusieurs frais annexes d'une même facture restent distincts (montant dans l'identité).
    const fingerprint = scope === 'FEE'
      ? empreinte(['v1', kind, scope, ref, h.currency, h.amountMinor, economicDate])
      : scope === 'DEPOSIT' || scope === 'BALANCE'
      ? empreinte(['v1', kind, scope, h.currency, h.amountMinor])
      : ref
        ? empreinte(['v1', kind, scope, ref, periodStart, periodEnd])
        : empreinte(['v1', kind, scope, h.currency, h.amountMinor, economicDate, periodStart, periodEnd]);
    if (out.has(fingerprint)) {
      const deja = out.get(fingerprint)!;
      deja.evidence = fusionPreuves(deja.evidence, preuve);
      continue;
    }
    const identityBasis: DesiredComponent['identityBasis'] = scope === 'FEE' || scope === 'DEPOSIT' || scope === 'BALANCE' ? 'SCOPE'
      : ref ? 'REFERENCE' : periodStart || periodEnd ? 'PERIOD' : economicDate ? 'DATE' : 'NONE';
    const eur = h.currency !== 'EUR' && h.currency !== 'XXX' && isMinorAmount(h.amountEurMinor) ? h.amountEurMinor : null;
    out.set(fingerprint, {
      fingerprint, kind, amountMinor: h.amountMinor, currency: h.currency, amountEurCents: eur, economicDate, periodStart, periodEnd, scope,
      sourceRole: id.role, label: null,
      // Lot 55B : règle d'identité insuffisante réservée aux DOCUMENTS (une saisie
      // de la fiche ou de l'agenda garde son autorité propre, lots 43 / 47B).
      ...(id.structured || id.agenda ? {} : { identityBasis }),
      ...(h.currency === 'XXX' && h.currencyCandidates?.length ? { currencyCandidates: h.currencyCandidates.filter((c) => isIsoCurrency(c)).slice(0, 3) } : {}),
      ...(preuve ? { evidence: preuve } : {}),
    });
  }
  return [...out.values()];
}

export interface ComponentContribution extends DesiredComponent {
  sourceIds: number[];
  /** Lot 78A : justification exacte par source (candidat, indices T1, faits). */
  evidenceBySource?: Record<number, ComponentEvidence>;
}

const ajouterPreuve = (c: ComponentContribution, sourceId: number, e: ComponentEvidence | undefined) => {
  if (!e) return;
  c.evidenceBySource ??= {};
  c.evidenceBySource[sourceId] = fusionPreuves(c.evidenceBySource[sourceId], e)!;
};

/**
 * Composantes de l'Opération depuis TOUTES ses sources actives (C12, C12.1) :
 *   · même empreinte = même fait économique, soutenu par plusieurs sources
 *     (valeurs de la plus ancienne source en cas de divergence) ;
 *   · facture TOTALE présente (portée TOTAL, ou facture finale sans portée) :
 *     l'acompte et le solde ne sont PAS des coûts additionnels (F-092,
 *     INV-014) — ils restent des preuves de règlement.
 */
export function consolidateComponents(
  contributions: ReadonlyArray<{ sourceId: number; components: DesiredComponent[] }>,
  choices?: ReadonlyMap<string, AmountChoice>,
): ComponentContribution[] {
  return consolidateComponentsDetailed(contributions, choices).components;
}

/**
 * Montant retenu par l'utilisateur pour un même fait économique (décision
 * durable, lot 42, B19). `known` : valeurs connues au moment du choix — une
 * nouvelle valeur divergente rouvre la question (C6.3 : élément nouveau).
 */
export interface AmountChoice { amountMinor: number; currency: string; known?: Array<{ amountMinor: number; currency: string }> }

/**
 * Montant contradictoire de même rôle (B19, ch. 20 : « Montant réalisé
 * contradictoire entre preuves de même autorité → À traiter ») : même
 * empreinte (même facture, même devis…), montants ou devises différents
 * selon les sources.
 */
export interface AmountConflict {
  fingerprint: string;
  kind: FinancialComponentKind;
  /** Une option par valeur distincte, avec les sources qui la portent (ordre des sources). */
  options: Array<{ amountMinor: number; currency: string; sourceIds: number[] }>;
  /** Valeur actuellement retenue. */
  retained: AmountChoice;
  /** Tranché par une décision utilisateur encore valable. */
  resolvedByUser: boolean;
}

/**
 * Comme `consolidateComponents`, avec les contradictions de montant. Sans
 * décision de l'utilisateur, la valeur de la plus ancienne source est
 * conservée (aucune donnée économique ambiguë n'est modifiée, C5) ; une
 * décision dont la valeur est encore portée par une source l'emporte.
 */
export function consolidateComponentsDetailed(
  contributions: ReadonlyArray<{ sourceId: number; components: DesiredComponent[] }>,
  choices?: ReadonlyMap<string, AmountChoice>,
): { components: ComponentContribution[]; conflicts: AmountConflict[]; uncertain: UncertainDuplicate[] } {
  const par = new Map<string, ComponentContribution>();
  const valeurs = new Map<string, Array<{ amountMinor: number; currency: string; sourceIds: number[] }>>();
  /** Lot 54D (E03) : empreintes dont deux sources donnent des contre-valeurs EUR différentes. */
  const contreValeursContradictoires = new Set<string>();
  const contreValeurVue = new Set<string>();
  const ordonnees = [...contributions].sort((a, b) => a.sourceId - b.sourceId);
  /** Lot 55B (D) : documents sans référence, ni date, ni période, par empreinte. */
  const sansIdentite = new Map<string, number[]>();
  for (const { sourceId, components } of ordonnees) {
    for (const c of components) {
      if (c.identityBasis === 'NONE') sansIdentite.set(c.fingerprint, [...new Set([...(sansIdentite.get(c.fingerprint) ?? []), sourceId])]);
      const opts = valeurs.get(c.fingerprint) ?? [];
      const o = opts.find((x) => x.amountMinor === c.amountMinor && x.currency === c.currency);
      if (o) { if (!o.sourceIds.includes(sourceId)) o.sourceIds.push(sourceId); } else opts.push({ amountMinor: c.amountMinor, currency: c.currency, sourceIds: [sourceId] });
      valeurs.set(c.fingerprint, opts);
      const cur = par.get(c.fingerprint);
      if (cur) {
        if (!cur.sourceIds.includes(sourceId)) cur.sourceIds.push(sourceId);
        ajouterPreuve(cur, sourceId, c.evidence);
        // Lot 53D (Q16) : une contre-valeur EUR documentaire complète la composante.
        // Lot 54D (E03) : deux contre-valeurs DIFFÉRENTES pour le même fait → aucune
        // n'est retenue (jamais choisir un taux) : montant hors total EUR, signalé.
        if (cur.currency === c.currency && cur.amountMinor === c.amountMinor && c.amountEurCents !== null) {
          if (contreValeursContradictoires.has(c.fingerprint)) { /* reste nulle */ }
          else if (cur.amountEurCents === null && !contreValeurVue.has(c.fingerprint)) cur.amountEurCents = c.amountEurCents;
          else if (cur.amountEurCents !== null && cur.amountEurCents !== c.amountEurCents) {
            contreValeursContradictoires.add(c.fingerprint);
            cur.amountEurCents = null;
          }
        }
        // Un acompte reconnu par sa facture d'acompte garde son rôle de source.
        if (c.sourceRole === 'DEPOSIT_INVOICE') cur.sourceRole = 'DEPOSIT_INVOICE';
      } else {
        const { evidence: e0, ...reste } = c;
        const neuve: ComponentContribution = { ...reste, sourceIds: [sourceId] };
        ajouterPreuve(neuve, sourceId, e0);
        par.set(c.fingerprint, neuve);
      }
      if (c.amountEurCents !== null) contreValeurVue.add(c.fingerprint);
    }
  }
  // Lot 55B (D) : identité économique insuffisante — jamais d'addition ni
  // d'effacement arbitraire.
  //   · une source SANS référence (copie dont le numéro n'a pas été lu) dont
  //     le montant, la devise et la date (ou la période) sont ceux d'un fait
  //     IDENTIFIÉ par sa référence : même fait, une preuve de plus ;
  //   · une source sans référence, ni date, ni période (`NONE`) : son montant
  //     n'est compté qu'une fois avec un fait de même rôle et de même montant
  //     (copie ou autre échéance ?) — l'excédent reste CONNU, hors total
  //     (montant « UNCERTAIN_DUPLICATE »), jamais additionné ni perdu.
  const uncertain: UncertainDuplicate[] = [];
  const memeValeur = (a: ComponentContribution, b: ComponentContribution) =>
    a.kind === b.kind && a.currency === b.currency && a.amountMinor === b.amountMinor && a.currency !== 'XXX';
  for (const [fp, faible] of [...par]) {
    if (faible.identityBasis !== 'DATE' && faible.identityBasis !== 'PERIOD' && faible.identityBasis !== 'NONE') continue;
    if ((valeurs.get(fp) ?? []).length > 1) continue;
    const fort = [...par.values()].find((x) => x !== faible && x.identityBasis === 'REFERENCE' && memeValeur(x, faible)
      && (faible.identityBasis === 'NONE'
        || (faible.economicDate !== null && x.economicDate === faible.economicDate)
        || (faible.periodStart !== null && x.periodStart === faible.periodStart && x.periodEnd === faible.periodEnd)));
    const cible = fort ?? (faible.identityBasis === 'NONE'
      ? [...par.values()].find((x) => x !== faible && x.identityBasis !== undefined && memeValeur(x, faible) && x.sourceIds[0] < faible.sourceIds[0])
      : undefined);
    if (!cible) continue;
    for (const id of faible.sourceIds) if (!cible.sourceIds.includes(id)) cible.sourceIds.push(id);
    for (const [id, e] of Object.entries(faible.evidenceBySource ?? {})) ajouterPreuve(cible, Number(id), e);
    par.delete(fp);
    valeurs.delete(fp);
    if (faible.identityBasis === 'NONE') uncertain.push({ fingerprint: cible.fingerprint, absorbedFingerprint: fp, sourceIds: [...faible.sourceIds] });
  }
  for (const c of par.values()) {
    const docs = sansIdentite.get(c.fingerprint) ?? [];
    if (docs.length > 1 && (valeurs.get(c.fingerprint) ?? []).length < 2) {
      uncertain.push({ fingerprint: c.fingerprint, absorbedFingerprint: c.fingerprint, sourceIds: docs.slice(1) });
    }
  }
  const conflicts: AmountConflict[] = [];
  for (const [fp, brutes] of valeurs) {
    // Lot 53D (D2) : un même montant dont la devise n'est pas établie (« XXX »)
    // sur une source et ÉTABLIE sur une autre n'est pas une contradiction :
    // la devise écrite le confirme.
    const opts = brutes.filter((o) => o.currency !== 'XXX' || !brutes.some((x) => x.currency !== 'XXX' && x.amountMinor === o.amountMinor));
    for (const o of brutes) {
      if (opts.includes(o)) continue;
      const e = opts.find((x) => x.currency !== 'XXX' && x.amountMinor === o.amountMinor)!;
      for (const id of o.sourceIds) if (!e.sourceIds.includes(id)) e.sourceIds.push(id);
    }
    const cur0 = par.get(fp)!;
    if (cur0.currency === 'XXX') {
      const e = opts.find((x) => x.currency !== 'XXX' && x.amountMinor === cur0.amountMinor);
      if (e) { cur0.currency = e.currency; delete cur0.currencyCandidates; }
    }
    if (opts.length < 2) continue;
    const cur = cur0;
    const choix = choices?.get(fp);
    const retenu = choix ? opts.find((o) => o.amountMinor === choix.amountMinor && o.currency === choix.currency) : undefined;
    if (retenu) { cur.amountMinor = retenu.amountMinor; cur.currency = retenu.currency; }
    const nouvelle = !!choix?.known && opts.some((o) => !choix.known!.some((k) => k.amountMinor === o.amountMinor && k.currency === o.currency));
    conflicts.push({
      fingerprint: fp, kind: cur.kind, options: opts.map((o) => ({ ...o, sourceIds: [...o.sourceIds] })),
      retained: { amountMinor: cur.amountMinor, currency: cur.currency }, resolvedByUser: !!retenu && !nouvelle,
    });
  }
  const all = [...par.values()];
  const totale = all.some((c) => c.kind === 'REALIZED_COST'
    && (c.scope === 'TOTAL' || (c.scope === null && c.sourceRole === 'INVOICE')));
  return {
    components: all.filter((c) => !(totale && c.kind === 'REALIZED_COST' && (c.scope === 'DEPOSIT' || c.scope === 'BALANCE'))),
    conflicts,
    uncertain,
  };
}

/**
 * Lot 55B (D) : montant d'une source dont l'identité économique ne permet pas
 * de dire s'il s'agit d'une copie ou d'un autre fait (ni référence, ni date,
 * ni période) — compté UNE fois, l'excédent tenu hors total.
 */
export interface UncertainDuplicate {
  /** Composante retenue (comptée une fois). */
  fingerprint: string;
  /** Empreinte de la contribution non additionnée. */
  absorbedFingerprint: string;
  /** Sources dont le montant n'est pas additionné. */
  sourceIds: number[];
}

// ── État consolidé de l'Opération (C8, C11.1, C10, C13) ────────────────────

export interface SourceContribution {
  sourceId: number;
  identity: CandidateIdentity;
}

export interface ConsolidatedState {
  type: BusinessOperationTypeCode | null;
  status: BusinessOperationStatus;
  /** Une source certaine établit-elle la réalisation ? */
  realizationProven: boolean;
  plannedDate: string | null;
  startDate: string | null;
  realizedDate: string | null;
  endDate: string | null;
  provider: string | null;
  assets: Array<{ assetId: number; sourceId: number; authority: 'DOCUMENT' | 'INFERENCE' | 'USER' }>;
  equipments: Array<{ equipmentId: number; sourceId: number }>;
  references: Array<NormalizedReference & { sourceId: number }>;
  components: ComponentContribution[];
  /** Montants contradictoires de même rôle (lot 42, B19). */
  amountConflicts: AmountConflict[];
  /**
   * Lot 53D (D9) : montants CONNUS mais hors du total — frais annexes d'un
   * achat, montant documentaire écarté par la saisie de la fiche. Préservés
   * distinctement (futur TCO), jamais additionnés d'office.
   */
  sideAmounts: SideAmount[];
  contract: { contractReference: string | null; effectiveFrom: string | null; effectiveTo: string | null } | null;
  financing: {
    financingReference: string | null; lender: string | null; effectiveFrom: string | null; effectiveTo: string | null;
    /** Lot 53D (Q16) : capital emprunté lu sur une source (devise établie), jamais une dépense. */
    principalAmountMinor?: number | null; principalCurrency?: string | null;
  } | null;
  claim: { insurerClaimRef: string | null; policyReferenceText: string | null } | null;
  /** Lot 78A (§2C, §6) : source qui justifie chaque valeur conservée. */
  provenance: AttributeProvenance;
  /** Lot 78A (§2C) : valeurs contradictoires entre sources (jamais tranchées en silence). */
  attributeConflicts: AttributeConflict[];
}

export type ProvenancedField = 'plannedDate' | 'startDate' | 'realizedDate' | 'endDate' | 'provider';
export type AttributeProvenance = Partial<Record<ProvenancedField, { sourceId: number; value: string }>>;
export interface AttributeConflict {
  field: ProvenancedField;
  /** Valeurs distinctes et sources qui les portent (ordre des sources). */
  values: Array<{ value: string; sourceIds: number[] }>;
  /** Valeur conservée. */
  retained: string | null;
}

const ecartJoursModel = (a: string, b: string): number => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/**
 * Lot 78A (§2C) : valeurs d'un attribut selon les sources, contradiction
 * au-delà de la fenêtre de la transaction (dates) ou tiers distincts (pure).
 */
function attributeConflict(
  field: ProvenancedField, srcs: readonly SourceContribution[], valueOf: (s: SourceContribution) => string | null,
  window: number | null, key: (v: string) => string = (v) => v,
): AttributeConflict | null {
  const vals: Array<{ value: string; sourceIds: number[] }> = [];
  for (const s of srcs) {
    const v = valueOf(s);
    if (!v) continue;
    const o = vals.find((x) => key(x.value) === key(v));
    if (o) o.sourceIds.push(s.sourceId); else vals.push({ value: v, sourceIds: [s.sourceId] });
  }
  if (vals.length < 2) return null;
  if (field !== 'provider') {
    if (window === null) return null;
    const tri = vals.map((x) => x.value).sort();
    if (ecartJoursModel(tri[0], tri[tri.length - 1]) <= window) return null;
  }
  return { field, values: vals, retained: null };
}

/**
 * Lot 78A (§2C, §6) : source qui justifie chaque valeur conservée (pure) —
 * la plus ancienne source qui porte cette valeur (date du document, date
 * d'un montant, réalisation saisie à l'agenda).
 */
export function computeProvenance(
  v: Pick<ConsolidatedState, 'plannedDate' | 'startDate' | 'realizedDate' | 'endDate' | 'provider'>, sources: readonly SourceContribution[],
): AttributeProvenance {
  const srcs = [...sources].sort((a, b) => a.sourceId - b.sourceId);
  const out: AttributeProvenance = {};
  for (const k of ['plannedDate', 'startDate', 'realizedDate', 'endDate'] as const) {
    const val = v[k];
    if (!val) continue;
    const s = (k === 'realizedDate' ? srcs.find((x) => x.identity.agenda?.realizedDate === val) : undefined)
      ?? srcs.find((x) => x.identity.dates[k] === val)
      ?? (k === 'realizedDate' ? srcs.find((x) => x.identity.hints.some((h) => h.economicDate === val) || x.identity.dates.endDate === val) : undefined);
    if (s) out[k] = { sourceId: s.sourceId, value: val };
  }
  if (v.provider) {
    const s = srcs.find((x) => x.identity.provider === v.provider);
    if (s) out.provider = { sourceId: s.sourceId, value: v.provider };
  }
  return out;
}

const minDate = (v: Array<string | null>): string | null => v.filter((x): x is string => !!x).sort()[0] ?? null;
const maxDate = (v: Array<string | null>): string | null => v.filter((x): x is string => !!x).sort().at(-1) ?? null;

/** Date économique d'une composante de coût réalisée / de produit (repli C11.1). */
function economicFallback(srcs: SourceContribution[], kinds: FinancialComponentKind[]): string | null {
  const dates: Array<string | null> = [];
  for (const s of srcs) {
    for (const h of s.identity.hints) {
      const k = componentKindOf(h.role, s.identity.role);
      if (k && kinds.includes(k)) dates.push(dateOrNull(h.economicDate));
    }
  }
  return maxDate(dates);
}

/**
 * État consolidé depuis les sources documentaires ACTIVES de l'Opération
 * (pure). `today` (AAAA-MM-JJ) : contrat signé à effet futur = ENVISAGED
 * jusqu'à l'entrée en vigueur (décision PO Q13).
 */
export function consolidateOperationState(
  currentType: BusinessOperationTypeCode | null,
  sources: readonly SourceContribution[],
  today: string,
  amountChoices?: ReadonlyMap<string, AmountChoice>,
  opts: { recurringRequalification?: boolean } = {},
): ConsolidatedState {
  const srcs = [...sources].sort((a, b) => a.sourceId - b.sourceId);
  // Type : celui de l'Opération ; à défaut, le type non nul commun des candidats (F-054).
  // Lot 48 (C7.7, F-055) : OTHER → type connu commun à toutes les sources typées (même identité).
  const types = [...new Set(srcs.map((s) => s.identity.type).filter((t): t is BusinessOperationTypeCode => t !== null))];
  const commun = types.length === 1 ? types[0] : null;
  let type = currentType === null ? commun
    : currentType === 'OTHER' && commun !== null && commun !== 'OTHER' ? commun
      : currentType;
  // Lot 55B (A) : échéances d'un même contrat réunies par T3 (M0 / M1 / M3) —
  // l'Opération est la relation contractuelle, même si T1 a qualifié une
  // facture d'« intervention » ou sans type (jamais une installation ponctuelle).
  if ((type === null || type === 'INTERVENTION' || type === 'OTHER') && opts.recurringRequalification !== false
    && recurringContractEvidence(srcs)) type = 'CONTRACT';

  // Statut (C8, B7) : seules les sources CERTAINES établissent la réalisation ou l'annulation.
  const certaines = srcs.filter((s) => s.identity.confidence === 'certain');
  const realisation = certaines.filter((s) => s.identity.status === 'REALIZED');
  const annulation = certaines.filter((s) => s.identity.status === 'CANCELLED');
  let status: BusinessOperationStatus = realisation.length ? 'REALIZED' : annulation.length ? 'CANCELLED' : 'ENVISAGED';

  const all = (k: keyof CandidateDates, list: SourceContribution[] = srcs) => list.map((s) => s.identity.dates[k]);
  let plannedDate = minDate(all('plannedDate'));
  let startDate = minDate(all('startDate'));
  let realizedDate: string | null = null;
  let endDate = maxDate(all('endDate'));
  switch (type) {
    case 'CONTRACT':
    case 'FINANCING':
      // start_date = date d'effet ; la relation est réalisée par son entrée en vigueur (C11.1).
      realizedDate = null;
      break;
    case 'CLAIM':
      // Date de survenue seulement ; jamais de repli automatique (C11.1).
      realizedDate = minDate(all('realizedDate', realisation));
      break;
    case 'ACQUISITION':
      realizedDate = minDate(all('realizedDate', realisation)) ?? economicFallback(realisation, ['REALIZED_COST']);
      break;
    case 'DISPOSAL':
      realizedDate = minDate(all('realizedDate', realisation)) ?? economicFallback(realisation, ['PROCEED', 'REALIZED_COST']);
      break;
    default:
      // INTERVENTION, OTHER, type nul : date de prestation, sinon fin de période,
      // sinon date de facture (C11.1, C11.2).
      realizedDate = maxDate(all('realizedDate', realisation)) ?? maxDate(all('endDate', realisation))
        ?? economicFallback(realisation, ['REALIZED_COST']);
  }
  // Lot 78A (§2C) : dates d'une même transaction contradictoires entre sources
  // (au-delà de sa fenêtre) — jamais d'opération composite : pour un fait
  // unique (achat, cession, sinistre), la date de la source FONDATRICE (la
  // plus ancienne) est conservée, la contradiction est tracée.
  const fenetre = transactionWindowDays(type);
  const attributeConflicts: AttributeConflict[] = [];
  for (const k of ['plannedDate', 'startDate', 'realizedDate', 'endDate'] as const) {
    const liste = k === 'realizedDate' ? realisation : srcs;
    const conflit = attributeConflict(k, liste, (s) => s.identity.dates[k], fenetre);
    if (conflit) attributeConflicts.push(conflit);
  }
  const conflitRealise = attributeConflicts.find((c) => c.field === 'realizedDate');
  if (conflitRealise && (type === 'ACQUISITION' || type === 'DISPOSAL' || type === 'CLAIM')) realizedDate = conflitRealise.values[0].value;
  // Une réalisation non prouvée n'a pas de date de réalisation (la date prévue reste).
  if (status !== 'REALIZED') realizedDate = null;
  // Décision PO Q13 : contrat signé à effet futur = ENVISAGED jusqu'à la date d'effet.
  if (type === 'CONTRACT' && status === 'REALIZED' && startDate !== null && startDate > today) status = 'ENVISAGED';
  if (startDate && endDate && endDate < startDate) endDate = null;

  const provider = srcs.map((s) => s.identity.provider).find((p) => !!p) ?? null;
  const conflitTiers = attributeConflict('provider', srcs, (s) => s.identity.provider, null, (v) => normalizeProvider(v) ?? v);
  if (conflitTiers) attributeConflicts.push(conflitTiers);

  const assets: ConsolidatedState['assets'] = [];
  const vusA = new Set<number>();
  for (const s of srcs) {
    for (const a of s.identity.assetIds) {
      if (vusA.has(a)) continue;
      vusA.add(a);
      assets.push({ assetId: a, sourceId: s.sourceId, authority: s.identity.targetAuthority ?? 'INFERENCE' });
    }
  }
  // Une cible explicite (T1 certain) prime sur le rattachement du document (C9 : ne pas
  // écraser une cible prouvée par un simple classement).
  const explicites = assets.filter((a) => a.authority !== 'INFERENCE');
  const cibles = explicites.length ? explicites : assets;

  const equipments: ConsolidatedState['equipments'] = [];
  const vusE = new Set<number>();
  for (const s of srcs) for (const e of s.identity.equipmentIds) if (!vusE.has(e)) { vusE.add(e); equipments.push({ equipmentId: e, sourceId: s.sourceId }); }

  const references: ConsolidatedState['references'] = [];
  const vusR = new Set<string>();
  for (const s of srcs) {
    for (const r of s.identity.refs) {
      const k = `${r.kind}:${r.normalized}`;
      if (vusR.has(k)) continue;
      vusR.add(k);
      references.push({ ...r, sourceId: s.sourceId });
    }
  }

  const { components, conflicts: amountConflicts, uncertain } = consolidateComponentsDetailed(
    srcs.map((s) => ({ sourceId: s.sourceId, components: componentsFromIdentity(s.identity) })), amountChoices);

  // Lot 53D (D9) : frais annexes d'un ACHAT (portée FEE) — isolés, jamais
  // additionnés d'office au prix d'achat (inclusion TCO : CDC TCO à venir).
  const sideAmounts: SideAmount[] = [];
  const retenues = type === 'ACQUISITION'
    ? components.filter((c) => {
      if (c.scope !== 'FEE' || c.kind !== 'REALIZED_COST') return true;
      sideAmounts.push(sideAmountOf('ANCILLARY_FEE', c));
      return false;
    })
    : components;

  // Lot 55B (D) : montants non additionnés faute d'identité économique suffisante.
  for (const u of uncertain) {
    const c = retenues.find((x) => x.fingerprint === u.fingerprint);
    if (c) sideAmounts.push({ ...sideAmountOf('UNCERTAIN_DUPLICATE', c), fingerprint: u.absorbedFingerprint === u.fingerprint ? `${u.fingerprint}:dup` : u.absorbedFingerprint, sourceIds: [...u.sourceIds] });
  }

  // Lot 53D (Q16) : capital emprunté — détail du financement, jamais une composante.
  let principal: { amountMinor: number; currency: string } | null = null;
  if (type === 'FINANCING') {
    for (const s of srcs) {
      const h = s.identity.hints.find((x) => x.role === 'LOAN_PRINCIPAL' && x.currency !== 'XXX');
      if (h) { principal = { amountMinor: h.amountMinor, currency: h.currency }; break; }
    }
  }

  const premiereRef = (kinds: ReferenceKind[]) => references.find((r) => kinds.includes(r.kind))?.value ?? null;

  // Lot 78A (§2C, §6) : source qui justifie chaque valeur conservée.
  const provenance = computeProvenance({ plannedDate, startDate, realizedDate, endDate, provider }, srcs);
  const valeurs: Record<ProvenancedField, string | null> = { plannedDate, startDate, realizedDate, endDate, provider };
  for (const c of attributeConflicts) c.retained = valeurs[c.field];

  return {
    type,
    status,
    realizationProven: realisation.length > 0,
    plannedDate,
    startDate,
    realizedDate,
    endDate,
    provider,
    assets: cibles,
    equipments,
    references,
    components: retenues,
    amountConflicts: amountConflicts.filter((c) => retenues.some((r) => r.fingerprint === c.fingerprint)),
    sideAmounts,
    contract: type === 'CONTRACT' ? { contractReference: premiereRef(['CONTRACT', 'POLICY']), effectiveFrom: startDate, effectiveTo: endDate } : null,
    financing: type === 'FINANCING' ? {
      financingReference: premiereRef(['LOAN']), lender: provider, effectiveFrom: startDate, effectiveTo: endDate,
      ...(principal ? { principalAmountMinor: principal.amountMinor, principalCurrency: principal.currency } : {}),
    } : null,
    claim: type === 'CLAIM' ? { insurerClaimRef: premiereRef(['CLAIM']), policyReferenceText: premiereRef(['POLICY', 'CONTRACT']) } : null,
    provenance,
    attributeConflicts,
  };
}

// ── Lot 53D : montants hors total (D9) et devise confirmée (D2) ───────────

export const SIDE_AMOUNT_NATURES = ['ANCILLARY_FEE', 'DOCUMENT_AMOUNT_DIFFERS', 'UNCERTAIN_DUPLICATE'] as const;
export type SideAmountNature = (typeof SIDE_AMOUNT_NATURES)[number];

/**
 * Montant connu, tracé à ses sources, mais HORS du total de l'Opération :
 *   · ANCILLARY_FEE : frais annexes d'un achat (livraison, mise en service,
 *     immatriculation…) — préparés pour le futur TCO ;
 *   · DOCUMENT_AMOUNT_DIFFERS : prix (ou prix de vente) d'un document qui
 *     diffère de la valeur SAISIE sur la fiche — la saisie reste la
 *     référence, l'écart est exposé, jamais écrasé ni additionné ;
 *   · UNCERTAIN_DUPLICATE (lot 55B) : montant d'une source sans référence, ni
 *     date, ni période, égal à un fait déjà compté — copie ou autre échéance,
 *     on ne sait pas : compté une fois, l'excédent exposé ici.
 */
export interface SideAmount {
  nature: SideAmountNature;
  kind: FinancialComponentKind;
  fingerprint: string;
  amountMinor: number;
  currency: string;
  amountEurCents: number | null;
  economicDate: string | null;
  sourceIds: number[];
}

export function sideAmountOf(nature: SideAmountNature, c: ComponentContribution): SideAmount {
  return {
    nature, kind: c.kind, fingerprint: c.fingerprint, amountMinor: c.amountMinor, currency: c.currency,
    amountEurCents: c.amountEurCents, economicDate: c.economicDate, sourceIds: [...c.sourceIds],
  };
}

/** Devise confirmée par l'utilisateur pour un montant « XXX » (null : « je ne sais pas »). */
export interface CurrencyChoice { currency: string | null }

/**
 * Applique les devises confirmées (pure) : une composante « XXX » dont
 * l'empreinte a un choix prend la devise choisie ; « je ne sais pas » la
 * laisse hors des agrégats EUR, sans reposer la question.
 */
export function applyCurrencyChoices(components: ComponentContribution[], choices: ReadonlyMap<string, CurrencyChoice>): ComponentContribution[] {
  return components.map((c) => {
    const ch = choices.get(c.fingerprint);
    if (c.currency !== 'XXX' || !ch || !ch.currency || !isIsoCurrency(ch.currency) || ch.currency === 'XXX') return c;
    const { currencyCandidates: _c, ...reste } = c;
    return { ...reste, currency: ch.currency };
  });
}
