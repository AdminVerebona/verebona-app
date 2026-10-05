/**
 * État canonique d'un bien — types publics (CDC 15 §12 SVC-04, SVC-05).
 */
import type { FieldOrigin } from '@/services/ai/evidence/evidence.types';
import type { AssetFamily } from '@/services/canonical/registry';

/**
 * Origine d'une valeur canonique. Mêmes valeurs que l'origine structurée du
 * CDC IA §6.2 (`<champ>__origin`) : USER, ADMIN (humaines), et les origines
 * automatiques DOCUMENT_EXTRACTION (T1), RECONCILIATION (T3), IMPORT,
 * SYSTEM_RULE.
 */
export type CanonicalOrigin = FieldOrigin;

/** D'où vient la valeur lue (diagnostic de la transition D-10). */
export type CanonicalValueFrom = 'key' | 'alias' | 'column';

export interface CanonicalFieldState {
  key: string;
  value: unknown;
  origin: CanonicalOrigin;
  /** `<champ>__updatedAt` si connu ; null pour une valeur historique non tracée. */
  updatedAt: string | null;
  /** Provenance déclarée dans la fiche (`<champ>__source`), si présente. */
  source?: string;
  /** Clé canonique, alias historique (clé brute) ou colonne historique (repli D-10). */
  from: CanonicalValueFrom;
  /** Alias ou colonne effectivement lus quand `from` ≠ `key`. */
  fromName?: string;
  /**
   * false : la valeur stockée ne se normalise pas selon le registre (saisie
   * historique hors format) ; `value` est alors la valeur brute.
   */
  normalized?: boolean;
}

export interface CanonicalAssetState {
  assetId: number;
  accountId: number;
  family: AssetFamily;
  category: string;
  /** Clés canoniques renseignées (valeur non vide) → état. */
  fields: Record<string, CanonicalFieldState>;
  /** `assets.updated_at` (ISO). */
  assetUpdatedAt: string | null;
}

/** Provenance d'une écriture (journal `canonical_field_writes`). */
export interface CanonicalWriteSource {
  /** `asset_details`, `assistant_command`, `document`, `reconciliation`, `import`, `admin`… */
  type: string;
  id?: string | number | null;
}

/** Trace IA facultative d'une écriture automatique (colonnes 0103 de `ai_field_updates`). */
export interface AutomaticWriteTrace {
  evidenceId?: number | null;
  decisionType?: string | null;
  reasonCode?: string | null;
  provider?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  confidence?: string | null;
  /** Autorité de la preuve (`<champ>__authority`) — arbitrages T3 futurs. */
  authority?: number | null;
  /** Date du document preuve (`<champ>__sourceDate`, ISO). */
  sourceDate?: string | null;
}

export interface CanonicalFieldWrite {
  /** Clé canonique ou alias (résolu par le registre). */
  key: string;
  value: unknown;
  /**
   * Valeur attendue en place (contrôle optimiste) : si la valeur canonique
   * courante diffère, rien n'est écrit (`conflict`).
   */
  expectedCurrent?: unknown;
  /** Unité de la valeur brute si elle diffère de l'unité canonique. */
  sourceUnit?: string;
  trace?: AutomaticWriteTrace;
}

export interface WriteCanonicalAssetFieldInput {
  assetId: number;
  accountId: number;
  key: string;
  value: unknown;
  origin: CanonicalOrigin;
  actorUserId?: number | null;
  source?: CanonicalWriteSource;
  traceId?: string | null;
  expectedCurrent?: unknown;
  sourceUnit?: string;
  trace?: AutomaticWriteTrace;
  /** Publie ASSET_UPDATED après écriture (défaut : oui). */
  emitEvent?: boolean;
}

export interface WriteCanonicalAssetFieldsInput extends Omit<WriteCanonicalAssetFieldInput, 'key' | 'value' | 'expectedCurrent' | 'sourceUnit' | 'trace'> {
  writes: CanonicalFieldWrite[];
}

/**
 * Issue d'une écriture pour une clé :
 *   written    valeur (ou origine) écrite ;
 *   unchanged  même valeur, même origine (ou origine automatique sur une
 *              valeur identique) : rien à écrire ;
 *   protected  écriture automatique refusée sur une valeur humaine ;
 *   invalid    clé inconnue, hors famille ou valeur non normalisable ;
 *   conflict   la valeur en place n'est plus celle attendue.
 */
export type CanonicalWriteOutcome = 'written' | 'unchanged' | 'protected' | 'invalid' | 'conflict';

export interface CanonicalFieldWriteResult {
  /** Clé canonique (ou clé demandée si elle est inconnue). */
  key: string;
  requestedKey: string;
  outcome: CanonicalWriteOutcome;
  reason?: string;
  previousValue: unknown;
  previousOrigin: CanonicalOrigin | null;
  nextValue: unknown;
  origin: CanonicalOrigin;
  /** Colonnes historiques recopiées (nom SQL → valeur). */
  mirrors: Record<string, unknown>;
}

export interface CanonicalWriteResult {
  /** Bien introuvable dans le compte. */
  notFound: boolean;
  fields: CanonicalFieldWriteResult[];
}
