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

import { createHash } from 'crypto';

export const SCHEMA_COMPAT_STATES = ['NOT_TESTED', 'QUALIFIED', 'REJECTED_CONFIRMED', 'NEEDS_RECHECK', 'UNSUPPORTED_BY_CONTRACT'] as const;
export type SchemaCompatState = (typeof SCHEMA_COMPAT_STATES)[number];

/**
 * Lot 115 (carte #784, §A3) — IDENTITÉ ÉLARGIE d'un couple.
 *
 * Écart confirmé par la carte : la clé ne portait ni le PROFIL DE GÉNÉRATION
 * effectif, ni la version du modèle réellement SERVIE. Deux appels au même
 * nom de modèle avec un plafond de sortie ou un budget de réflexion
 * différents ne contraignent pas le décodage de la même façon ; un alias mis
 * à jour chez le fournisseur ne doit pas hériter d'une qualification obsolète.
 *
 *   · le profil de génération est OBSERVABLE AVANT l'appel : son empreinte
 *     entre dans la clé (`generationProfileHash`) — un autre profil est un
 *     autre couple, sans purge ni remise à zéro ;
 *   · la version servie n'est observable qu'APRÈS la réponse : elle ne peut
 *     pas entrer dans la clé. Elle est MÉMORISÉE avec l'état
 *     (`servedModelVersion`) ; quand une version différente est observée, le
 *     refus mémorisé ne s'applique plus à la nouvelle version : le prochain
 *     essai avec schéma est dû (UN seul, réservé comme les autres) ;
 *   · fournisseur muet sur la version : `versionUncertain` — l'incertitude est
 *     marquée, aucune version n'est inventée et aucun état n'est déduit.
 */
export interface GenerationProfile {
  /** Plafond de sortie effectif (`null` : non imposé). */
  maxOutputTokens?: number | null;
  /** Description du budget de réflexion (`aucun`, `low`, `high`, `budget N`). */
  thinkingConfig?: string | null;
  /** Réponse en `application/json`. */
  jsonResponse?: boolean;
  /** Paramètres de génération effectifs (température, topP, topK…) — seuls les matériellement pertinents. */
  generation?: Record<string, unknown> | null;
}

/** Paramètres de génération retenus dans l'identité (les autres ne changent pas la contrainte de décodage). */
export const GENERATION_PROFILE_KEYS = ['temperature', 'topP', 'topK', 'candidateCount', 'seed', 'stopSequences', 'responseModalities'] as const;

/**
 * Empreinte STABLE et lisible du profil de génération (pure, sans horloge).
 * Profil vide : `'-'` (aucun paramètre matériel) — même valeur que les lignes
 * écrites avant ce lot, pour que la rétrocompatibilité soit exacte.
 */
export function generationProfileHashOf(p: GenerationProfile | null | undefined): string {
  if (!p) return '-';
  const gen: Record<string, unknown> = {};
  for (const k of GENERATION_PROFILE_KEYS) {
    const v = p.generation?.[k];
    if (v !== undefined && v !== null) gen[k] = v;
  }
  const payload = JSON.stringify([
    p.maxOutputTokens ?? null,
    (p.thinkingConfig ?? '').trim() || null,
    p.jsonResponse === true,
    Object.keys(gen).sort().map((k) => [k, gen[k]]),
  ]);
  if (payload === JSON.stringify([null, null, false, []])) return '-';
  return createHash('sha256').update(payload).digest('hex').slice(0, 12);
}

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
  /**
   * Lot 115 (#784, A3) : une version de modèle SERVIE différente de celle du
   * refus mémorisé a été observée — le refus ne concerne plus la version
   * servie aujourd'hui, un essai avec schéma est dû (un seul, réservé).
   */
  | 'SERVED_VERSION_CHANGED'
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
  /**
   * Lot 115 (#784, A3) : empreinte du profil de génération effectif
   * (`generationProfileHashOf`). `'-'` ou absent : aucun paramètre matériel —
   * la clé est alors celle des lignes écrites avant ce lot.
   */
  generationProfileHash?: string;
}

/** Clé stable et lisible d'un couple (aucun contenu : identifiants, versions, empreintes). */
export function coupleKeyId(k: SchemaCoupleKey): string {
  const profil = k.generationProfileHash ?? '-';
  return [
    k.provider, k.model, k.operationCode, `${k.contractId}@${k.contractVersion}`, k.schemaHash, k.providerSchemaHash ?? '-', k.adapterVersion,
    // Rétrocompatibilité exacte : un profil sans paramètre matériel ne change pas la clé historique.
    ...(profil === '-' ? [] : [`g:${profil}`]),
  ].map((x) => String(x).replace(/\|/g, '_')).join('|');
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
  /** Lot 115 (#784, A3) : dernière version de modèle SERVIE observée ; `null` : jamais observée. */
  servedModelVersion?: string | null;
  /** Lot 115 (#784, A3) : version servie au moment où l'état courant a été écrit ; `null` : inconnue alors. */
  servedVersionAtState?: string | null;
  /** Lot 115 (#784, A3) : le fournisseur n'a pas indiqué la version servie — incertitude MARQUÉE, rien n'est inventé. */
  versionUncertain?: boolean;
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
  /** `servedModelVersion` (lot 115, #784) : version réellement servie si le fournisseur l'indique. */
  | { kind: 'ACCEPTED'; servedModelVersion?: string | null }
  | { kind: 'REJECTED'; reason: 'EXPLICIT_SCHEMA_REJECTION' | 'GENERIC_400_ANSWERED_WITHOUT_SCHEMA'; servedModelVersion?: string | null }
  | { kind: 'INCONCLUSIVE'; servedModelVersion?: string | null };

function blank(key: SchemaCoupleKey): SchemaCoupleState {
  return {
    keyId: coupleKeyId(key), key, state: 'NOT_TESTED', reason: null, acceptedCount: 0, rejectionCount: 0, consecutiveRejections: 0,
    retestCount: 0, lastAcceptedAt: null, lastRejectedAt: null, nextRetestAt: null, retestClaimedUntil: null, policyVersion: SCHEMA_COMPAT_POLICY.version,
    servedModelVersion: null, servedVersionAtState: null, versionUncertain: false,
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
  // Lot 115 (#784, A3) : version servie observée lors de ce constat ; absente → incertitude marquée.
  const servie = o.servedModelVersion ?? null;
  const version = { servedModelVersion: servie ?? prev?.servedModelVersion ?? null, servedVersionAtState: servie, versionUncertain: servie === null };
  const s: SchemaCoupleState = { ...(prev ?? blank(key)), policyVersion: SCHEMA_COMPAT_POLICY.version };
  if (o.kind === 'ACCEPTED') {
    return { ...s, ...version, state: 'QUALIFIED', reason: 'ACCEPTED_ON_REAL_CALL', acceptedCount: s.acceptedCount + 1, consecutiveRejections: 0, lastAcceptedAt: now, nextRetestAt: null, retestClaimedUntil: null };
  }
  if (o.kind === 'REJECTED') {
    const dejaMemorise = s.state === 'REJECTED_CONFIRMED' && s.nextRetestAt !== null && s.nextRetestAt > now;
    if (dejaMemorise) return { ...s, ...version, reason: o.reason, rejectionCount: s.rejectionCount + 1, lastRejectedAt: now };
    const consecutive = s.consecutiveRejections + 1;
    return {
      ...s, ...version, state: 'REJECTED_CONFIRMED', reason: o.reason, rejectionCount: s.rejectionCount + 1, consecutiveRejections: consecutive,
      lastRejectedAt: now, nextRetestAt: now + nextRetestDelayMs(consecutive, s.lastAcceptedAt !== null), retestClaimedUntil: null,
    };
  }
  if (s.state !== 'NEEDS_RECHECK') return prev ?? s;
  return { ...s, state: 'REJECTED_CONFIRMED', reason: 'RETEST_INCONCLUSIVE', nextRetestAt: now + SCHEMA_COMPAT_POLICY.inconclusiveRetestMs, retestClaimedUntil: null };
}

/**
 * Lot 115 (carte #784, §A3) — VERSION SERVIE observée (après la réponse du
 * fournisseur, avec ou sans schéma). Pure.
 *
 *   · version absente → `versionUncertain` : l'incertitude est marquée, aucun
 *     état n'est déduit, aucun délai n'est touché ;
 *   · version identique à celle du dernier constat → simple mémorisation ;
 *   · version DIFFÉRENTE de celle d'un refus mémorisé → ce refus a été
 *     constaté sur une AUTRE version servie : il ne commande plus les appels
 *     d'aujourd'hui, le prochain essai avec schéma devient dû (un seul,
 *     réservé par une instance comme les autres — jamais de rafale). L'état
 *     reste REJECTED_CONFIRMED : rien n'est déclaré compatible.
 *
 * Rend `null` quand il n'y a rien à écrire (état inconnu, aucun changement).
 */
export function applyServedVersion(prev: SchemaCoupleState | null, servedModelVersion: string | null, now: number): SchemaCoupleState | null {
  if (!prev) return null;
  if (servedModelVersion === null) return prev.versionUncertain === true ? null : { ...prev, versionUncertain: true };
  const changement = prev.servedVersionAtState !== null && prev.servedVersionAtState !== undefined && prev.servedVersionAtState !== servedModelVersion;
  const requalification = changement && (prev.state === 'REJECTED_CONFIRMED' || prev.state === 'NEEDS_RECHECK');
  if (!changement && prev.servedModelVersion === servedModelVersion && prev.servedVersionAtState != null && prev.versionUncertain === false) return null;
  // Version inconnue au moment du constat : celle observée dans le MÊME appel devient la référence de cet état
  // (le refus a été constaté sur elle) — un changement ultérieur sera, lui, détecté.
  const s: SchemaCoupleState = {
    ...prev, servedModelVersion, versionUncertain: false,
    servedVersionAtState: prev.servedVersionAtState ?? servedModelVersion,
  };
  if (!requalification) return s;
  return { ...s, reason: 'SERVED_VERSION_CHANGED', nextRetestAt: now, retestClaimedUntil: null };
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
