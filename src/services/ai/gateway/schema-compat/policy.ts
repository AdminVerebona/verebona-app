/**
 * Lot 114 (carte #776, cahier des charges §5) — COMPATIBILITÉ DES SCHÉMAS DE
 * SORTIE transmis au fournisseur : états, clé d'un couple et politique de
 * réexamen. PUR (aucun accès base, aucune horloge implicite).
 *
 * Un « couple » est ce qui a RÉELLEMENT été transmis : fournisseur, modèle,
 * opération, contrat runtime canonique (identifiant, version, empreinte),
 * schéma fournisseur projeté (empreinte) et version de l'adaptateur de
 * projection. Changer l'un d'eux donne une AUTRE clé : une qualification ou
 * un refus antérieur ne s'applique plus (invalidation par construction, sans
 * purge ni remise à zéro).
 *
 * États (§5) :
 *   · NOT_TESTED             aucun appel réel observé avec ce schéma ;
 *   · QUALIFIED              le fournisseur a répondu à un appel RÉEL portant
 *                            ce schéma (jamais déduit d'un succès sans schéma) ;
 *   · REJECTED_CONFIRMED     refus observé : explicite (le fournisseur cite
 *                            le schéma) ou opérationnel (400 générique, puis
 *                            succès du même modèle sans schéma — #437) ;
 *   · NEEDS_RECHECK          réexamen dû et RÉSERVÉ par une instance ;
 *   · UNSUPPORTED_BY_CONTRACT le contrôle statique interdit l'envoi (schéma
 *                            jamais transmis ; motif tracé).
 *
 * Le schéma n'est PAS la cause démontrée d'un 400 générique : l'état dit
 * seulement ce qui a été observé (refus avec schéma, réponse sans). Aucune
 * cause interne n'est affirmée.
 */

export const SCHEMA_COMPAT_STATES = ['NOT_TESTED', 'QUALIFIED', 'REJECTED_CONFIRMED', 'NEEDS_RECHECK', 'UNSUPPORTED_BY_CONTRACT'] as const;
export type SchemaCompatState = (typeof SCHEMA_COMPAT_STATES)[number];

/** Motifs d'état (codes stables, tracés). */
export type SchemaCompatReason =
  /** Le fournisseur a refusé en citant le schéma (`STRUCTURED_OUTPUT_REJECTED`). */
  | 'EXPLICIT_SCHEMA_REJECTION'
  /** HTTP 400 INVALID_ARGUMENT générique avec schéma, puis réponse du même modèle sans schéma (#437). */
  | 'GENERIC_400_ANSWERED_WITHOUT_SCHEMA'
  /** Réponse du fournisseur à un appel réel portant le schéma. */
  | 'ACCEPTED_ON_REAL_CALL'
  /** Essai de réexamen sans conclusion (délai, réseau, autre refus) : rien n'est déduit. */
  | 'RETEST_INCONCLUSIVE'
  /** Motif statique d'absence de schéma (`too_complex`, `provider_contract`, `unrepresentable`, `projection_lossy`). */
  | `STATIC_${string}`;

/**
 * Politique de réexamen — paramètres CENTRALISÉS et VERSIONNÉS (à valider par
 * le PO). `version` est écrite avec chaque état : un changement de politique
 * se lit dans les traces.
 */
export const SCHEMA_COMPAT_POLICY = {
  version: 1,
  /** Premier réexamen après un refus (durée de l'ancienne mémoire locale : 6 h). */
  firstRetestMs: 6 * 3_600_000,
  /** Réexamen après le refus d'un couple qui avait déjà été accepté (refus possiblement propre à une requête). */
  retestAfterQualifiedMs: 3_600_000,
  /** Plafond du délai, doublé à chaque refus consécutif. */
  maxRetestMs: 7 * 24 * 3_600_000,
  /** Durée de réservation d'un réexamen par une instance (au-delà : réservation caduque, reprise possible). */
  retestLeaseMs: 10 * 60_000,
  /** Report après un réexamen sans conclusion. */
  inconclusiveRetestMs: 30 * 60_000,
} as const;

/** Identité d'un couple (ce qui a été transmis). */
export interface SchemaCoupleKey {
  provider: string;
  model: string;
  operationCode: string;
  contractId: string;
  contractVersion: number;
  /** Empreinte du contrat runtime canonique. */
  schemaHash: string;
  /** Empreinte du schéma fournisseur projeté ; `null` : aucun schéma transmissible. */
  providerSchemaHash: string | null;
  /** Version de l'adaptateur de projection (`PROVIDER_SCHEMA_ADAPTER_VERSION`). */
  adapterVersion: string;
}

/** Clé stable et lisible d'un couple (aucun contenu : identifiants, versions, empreintes). */
export function coupleKeyId(k: SchemaCoupleKey): string {
  return [k.provider, k.model, k.operationCode, `${k.contractId}@${k.contractVersion}`, k.schemaHash, k.providerSchemaHash ?? '-', k.adapterVersion]
    .map((x) => String(x).replace(/\|/g, '_')).join('|');
}

/** État connu d'un couple (mémoire locale ou partagée). Dates en millisecondes. */
export interface SchemaCoupleState {
  keyId: string;
  key: SchemaCoupleKey;
  state: SchemaCompatState;
  reason: SchemaCompatReason | null;
  acceptedCount: number;
  rejectionCount: number;
  consecutiveRejections: number;
  retestCount: number;
  lastAcceptedAt: number | null;
  lastRejectedAt: number | null;
  nextRetestAt: number | null;
  retestClaimedUntil: number | null;
  policyVersion: number;
}

/**
 * Délai avant le prochain essai AVEC schéma après un refus : `firstRetestMs`
 * doublé à chaque refus consécutif, plafonné ; un couple déjà accepté dont
 * c'est le premier refus est revu plus tôt. Jamais d'exclusion permanente.
 */
export function nextRetestDelayMs(consecutiveRejections: number, everAccepted: boolean): number {
  const n = Math.max(1, Math.floor(consecutiveRejections));
  if (n === 1 && everAccepted) return SCHEMA_COMPAT_POLICY.retestAfterQualifiedMs;
  return Math.min(SCHEMA_COMPAT_POLICY.maxRetestMs, SCHEMA_COMPAT_POLICY.firstRetestMs * 2 ** Math.min(n - 1, 20));
}

export type SchemaUse =
  /** Schéma transmis (couple non testé ou qualifié). */
  | { send: true; retest: false; why: 'not_tested' | 'qualified' }
  /** Schéma transmis pour un réexamen DÛ — à réserver avant l'envoi. */
  | { send: true; retest: true; why: 'retest_due' }
  /** Schéma non transmis : refus mémorisé, réexamen non dû ou réservé ailleurs. */
  | { send: false; retest: false; why: 'recent_rejection' | 'retest_in_progress' };

/** Faut-il transmettre le schéma à ce couple ? (pure) */
export function schemaUseOf(s: SchemaCoupleState | null, now: number): SchemaUse {
  if (!s || s.state === 'NOT_TESTED' || s.state === 'UNSUPPORTED_BY_CONTRACT') return { send: true, retest: false, why: 'not_tested' };
  if (s.state === 'QUALIFIED') return { send: true, retest: false, why: 'qualified' };
  if (s.retestClaimedUntil !== null && s.retestClaimedUntil > now) return { send: false, retest: false, why: 'retest_in_progress' };
  if (s.nextRetestAt !== null && s.nextRetestAt > now) return { send: false, retest: false, why: 'recent_rejection' };
  return { send: true, retest: true, why: 'retest_due' };
}

export type SchemaOutcome =
  | { kind: 'ACCEPTED' }
  | { kind: 'REJECTED'; reason: 'EXPLICIT_SCHEMA_REJECTION' | 'GENERIC_400_ANSWERED_WITHOUT_SCHEMA' }
  | { kind: 'INCONCLUSIVE' };

function blank(key: SchemaCoupleKey): SchemaCoupleState {
  return {
    keyId: coupleKeyId(key), key, state: 'NOT_TESTED', reason: null, acceptedCount: 0, rejectionCount: 0, consecutiveRejections: 0,
    retestCount: 0, lastAcceptedAt: null, lastRejectedAt: null, nextRetestAt: null, retestClaimedUntil: null, policyVersion: SCHEMA_COMPAT_POLICY.version,
  };
}

/**
 * Transition d'état après l'issue d'un appel qui PORTAIT le schéma (pure —
 * même règle que les écritures en base de `store.ts`).
 *   · ACCEPTED     → QUALIFIED, refus consécutifs remis à zéro ;
 *   · REJECTED     → REJECTED_CONFIRMED, prochain essai repoussé. IDEMPOTENT :
 *                    un second refus signalé alors que le premier est déjà
 *                    mémorisé et non échu (requêtes concurrentes parties avant
 *                    la mémorisation) ne double pas le délai ;
 *   · INCONCLUSIVE → rien n'est déduit ; un réexamen réservé est rendu, avec
 *                    un court report.
 */
export function applySchemaOutcome(prev: SchemaCoupleState | null, key: SchemaCoupleKey, o: SchemaOutcome, now: number): SchemaCoupleState {
  const s: SchemaCoupleState = { ...(prev ?? blank(key)), policyVersion: SCHEMA_COMPAT_POLICY.version };
  if (o.kind === 'ACCEPTED') {
    return { ...s, state: 'QUALIFIED', reason: 'ACCEPTED_ON_REAL_CALL', acceptedCount: s.acceptedCount + 1, consecutiveRejections: 0, lastAcceptedAt: now, nextRetestAt: null, retestClaimedUntil: null };
  }
  if (o.kind === 'REJECTED') {
    const dejaMemorise = s.state === 'REJECTED_CONFIRMED' && s.nextRetestAt !== null && s.nextRetestAt > now;
    if (dejaMemorise) return { ...s, reason: o.reason, rejectionCount: s.rejectionCount + 1, lastRejectedAt: now };
    const consecutive = s.consecutiveRejections + 1;
    return {
      ...s, state: 'REJECTED_CONFIRMED', reason: o.reason, rejectionCount: s.rejectionCount + 1, consecutiveRejections: consecutive,
      lastRejectedAt: now, nextRetestAt: now + nextRetestDelayMs(consecutive, s.lastAcceptedAt !== null), retestClaimedUntil: null,
    };
  }
  if (s.state !== 'NEEDS_RECHECK') return prev ?? s;
  return { ...s, state: 'REJECTED_CONFIRMED', reason: 'RETEST_INCONCLUSIVE', nextRetestAt: now + SCHEMA_COMPAT_POLICY.inconclusiveRetestMs, retestClaimedUntil: null };
}

/** Réservation d'un réexamen (pure) : `null` si non dû ou déjà réservé. */
export function claimRetestOf(s: SchemaCoupleState, now: number): SchemaCoupleState | null {
  const use = schemaUseOf(s, now);
  if (!use.send || !use.retest) return null;
  return { ...s, state: 'NEEDS_RECHECK', retestClaimedUntil: now + SCHEMA_COMPAT_POLICY.retestLeaseMs, retestCount: s.retestCount + 1 };
}

export const SCHEMA_COMPAT_STATE_LABELS: Record<SchemaCompatState, string> = {
  NOT_TESTED: 'Non testé',
  QUALIFIED: 'Accepté par le fournisseur (appel réel)',
  REJECTED_CONFIRMED: 'Refusé par le fournisseur',
  NEEDS_RECHECK: 'Réexamen en cours',
  UNSUPPORTED_BY_CONTRACT: 'Non transmissible (contrôle statique)',
};
