/**
 * Réconciliation négative — CDC 15 T3-04 (lot 13). Fonctions PURES.
 *
 * « Si origine automatique et aucune preuve active, appliquer la meilleure
 *   preuve restante ou supprimer la valeur. Ne jamais supprimer USER/ADMIN. »
 *
 * Deux situations, pour une valeur d'origine AUTOMATIQUE (extraction ou
 * réconciliation) :
 *
 *   1. le champ a encore des preuves actives, mais aucune ne reproduit la
 *      valeur en place (sa preuve a été retirée) : la décision est reprise
 *      SANS l'autorité mémorisée de la preuve disparue — la meilleure preuve
 *      restante l'emporte selon la matrice (`withoutStaleAuthority`) ;
 *   2. le champ n'a plus AUCUNE preuve active : la valeur est retirée
 *      (`planRetractions`) — motif NO_REMAINING_EVIDENCE.
 *
 * Une valeur USER/ADMIN n'est jamais concernée (lecture prudente : origine
 * inconnue = USER). Une valeur importée ou issue d'une règle système (IMPORT,
 * SYSTEM_RULE) n'est pas fondée sur une preuve documentaire : elle n'est pas
 * retirée non plus.
 */
import { readOrigin } from './field-origin';
import { normalize } from './decision/normalizers';
import { resolveAlias } from '@/services/canonical/registry';
import type { FieldOrigin } from '../evidence/evidence.types';
import type { CurrentValue, DecisionInput, ReconciliationDecision } from './types';

/** Origines dont la valeur n'existe que par une preuve documentaire. */
export const EVIDENCE_BASED_ORIGINS: readonly FieldOrigin[] = ['DOCUMENT_EXTRACTION', 'RECONCILIATION'];

export const NEGATIVE_REASON = {
  RETRACT: 'NO_REMAINING_EVIDENCE',
  REPLACE: 'STALE_AUTO_VALUE_REPLACED',
  SHADOW_RETRACT: 'SHADOW_WOULD_RETRACT',
  SHADOW_REPLACE: 'SHADOW_WOULD_REPLACE_STALE',
} as const;

/** Forme de comparaison d'une clé : clé canonique si le registre la connaît. */
export function canonicalToken(key: string): string {
  return resolveAlias(key) ?? key;
}

const estVide = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
  || (Array.isArray(v) && v.length === 0);

/** Clé technique de la fiche (origine, date, autorité, métadonnées). */
const estMeta = (k: string) => k.includes('__') || /_origin$/.test(k);

export interface RetractionCandidate {
  fieldKey: string;
  currentValue: unknown;
  origin: FieldOrigin;
}

/**
 * Valeurs automatiques dont la DERNIÈRE preuve a disparu (titre de T3-04).
 *
 *  - `fieldsWithActiveEvidence` : champs ayant encore au moins une preuve
 *    active — jamais retirés ici ;
 *  - `retiredEvidence` : preuves du bien sorties de l'état ACTIVE
 *    (WITHDRAWN / SUPERSEDED), avec leur valeur.
 *
 * Un champ n'est retiré que si une preuve retirée de CE champ portait la
 * MÊME valeur normalisée que la valeur en place : c'est bien elle qui la
 * prouvait. Une valeur automatique historique antérieure au système de
 * preuves, ou produite par un autre document dont la preuve n'a jamais
 * existé, reste — on ne retire pas une valeur faute d'une preuve qu'elle
 * n'a jamais eue (relecture lot 13). Comparaison par clé canonique (alias
 * `prixAchat` ≡ `acquisitionPrice`) et valeurs normalisées.
 */
export function planRetractions(
  kc: Record<string, unknown> | null,
  fieldsWithActiveEvidence: Iterable<string>,
  retiredEvidence: Iterable<{ fieldKey: string; value: unknown }>,
): RetractionCandidate[] {
  if (!kc) return [];
  const prouves = new Set<string>();
  for (const k of fieldsWithActiveEvidence) prouves.add(canonicalToken(k));
  const retirees = new Map<string, Set<string>>();
  for (const r of retiredEvidence) {
    const t = canonicalToken(r.fieldKey);
    const n = normalize(t, r.value);
    if (n === null) continue;
    const set = retirees.get(t) ?? new Set<string>();
    set.add(n);
    retirees.set(t, set);
  }
  const out: RetractionCandidate[] = [];
  for (const [k, v] of Object.entries(kc)) {
    if (estMeta(k) || estVide(v) || typeof v === 'object') continue;
    const origin = readOrigin(kc, k);
    if (!EVIDENCE_BASED_ORIGINS.includes(origin)) continue;
    const t = canonicalToken(k);
    if (prouves.has(t)) continue;
    const courante = normalize(t, v);
    if (courante === null || !retirees.get(t)?.has(courante)) continue;
    out.push({ fieldKey: k, currentValue: v, origin });
  }
  return out;
}

/** Décision de retrait (enregistrée comme une mise à jour vers « vide »). */
export function retractionDecision(c: RetractionCandidate, shadow: boolean): ReconciliationDecision {
  return {
    fieldKey: c.fieldKey,
    currentValue: c.currentValue,
    proposedValue: shadow ? c.currentValue : null,
    // `reconciliation_decisions.action` est contraint (0105) : un retrait est
    // une mise à jour vers « vide » ; en observation, rien ne change (keep).
    action: shadow ? 'keep' : 'update',
    reasonCode: shadow ? NEGATIVE_REASON.SHADOW_RETRACT : NEGATIVE_REASON.RETRACT,
    confidence: 'certain',
    evidenceIds: [],
    deterministic: true,
  };
}

/**
 * Entrée de décision sans l'autorité ni la date de la preuve disparue : la
 * valeur en place ne vaut plus que ce que valent les preuves restantes.
 */
export function withoutStaleAuthority(input: DecisionInput): DecisionInput {
  if (!input.current) return input;
  const current: CurrentValue = { ...input.current, authorityScore: undefined, sourceDate: null, updatedAt: null };
  return { ...input, current };
}
