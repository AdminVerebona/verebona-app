/**
 * Lot 111B — identité MÉTIER d'une génération de dossier V12 et vocabulaire
 * de la régénération remplaçante.
 *
 * Deux notions distinctes :
 *   · `requestHash` (enqueue.ts) : empreinte TECHNIQUE de la demande (format,
 *     sections, pièces, options) — sert au rejeu idempotent (double clic) ;
 *     elle change dès que l'utilisateur modifie une option ;
 *   · `identityKey` (ici) : le DOSSIER demandé — même compte, même bien, même
 *     type de dossier, même contexte métier (sinistre, variante) et même
 *     utilisateur. Une régénération explicite remplace les générations
 *     encore actives de MÊME identité, quelles que soient leurs options.
 *
 * L'utilisateur fait partie de l'identité : la génération d'un autre membre
 * du compte Premium Duo n'est jamais annulée automatiquement.
 */

import { createHash } from 'node:crypto';
import type { DossierCode } from '@/services/exports/catalog';

const SHORT: Record<DossierCode, string> = {
  CIL: 'CIL', DOSSIER_COMPLET: 'COMPLET', VENTE: 'VENTE', LOCATION: 'LOCATION', ASSURANCE_SOUSCRIPTION: 'ASSURANCE', ASSURANCE_SINISTRE: 'SINISTRE',
};

/** Référence imprimée d'une génération : « VBN-CIL-20260928-000123 » (date de Paris). */
export const generationReference = (code: DossierCode, id: number, today: string): string =>
  `VBN-${SHORT[code]}-${today.replace(/-/g, '')}-${String(id).padStart(6, '0')}`;

/** Version du format (la migration 1195 reprend exactement ce format pour l'existant). */
const IDENTITY_KEY_VERSION = 'v1';

export interface GenerationIdentity {
  accountId: number;
  assetId: number;
  exportType: string;
  /** Sinistre retenu (dossier Assurance-sinistre), sinon null. */
  claimOperationId?: number | null;
  /** Variante historique (corps `variant`), sinon null. */
  variant?: string | null;
  userId: number;
}

/** `v1:a{compte}:b{bien}:t{type}:c{sinistre|-}:v{variante|-}:u{utilisateur}` — identifiants seulement. */
export function generationIdentityKey(i: GenerationIdentity): string {
  const claim = i.claimOperationId && Number.isSafeInteger(i.claimOperationId) && i.claimOperationId > 0 ? String(i.claimOperationId) : '-';
  // Variante libre : empreinte courte (jamais de texte libre ni de séparateur dans la clé).
  const variant = i.variant ? createHash('sha256').update(i.variant).digest('hex').slice(0, 12) : '-';
  return `${IDENTITY_KEY_VERSION}:a${i.accountId}:b${i.assetId}:t${i.exportType}:c${claim}:v${variant}:u${i.userId}`;
}

/** Motif structuré d'annulation (contrainte `export_generation_cancel_reason_check`). */
export const REPLACED_BY_NEW_GENERATION = 'REPLACED_BY_NEW_GENERATION' as const;
export type CancelReason = typeof REPLACED_BY_NEW_GENERATION;

/** Textes UX (module partagé avec l'interface). */
export { REGENERATION_NOTICE, REPLACED_LABEL } from '@/lib/exports/regeneration';

/** Étape d'arrêt d'une génération annulée sans avoir démarré, ou dont l'exécution s'est interrompue. */
export const CANCELLED_STEP_QUEUED = 'queued';
export const CANCELLED_STEP_LEASE_EXPIRED = 'lease_expired';
export const CANCELLED_STEP_FORCED = 'forced_after_grace';

/** Arrêt coopératif : levée par les étapes du job dès que l'annulation est observée. */
export class GenerationCancelledError extends Error {
  constructor() { super('génération annulée (remplacée par une nouvelle génération)'); this.name = 'GenerationCancelledError'; }
}

/** Délai d'interrogation de la demande d'annulation par le worker (défaut 2 s). */
export const cancelPollMs = (): number => {
  const n = Number(process.env.EXPORTS_CANCEL_POLL_MS);
  return Number.isFinite(n) && n >= 250 ? Math.floor(n) : 2_000;
};

/**
 * Délai laissé à une exécution annulée pour s'arrêter d'elle-même (étape non
 * interruptible : inspection d'une pièce, conversion d'image) ; au-delà, le
 * worker clôt l'annulation et passe à la suite (défaut 30 s).
 */
export const cancelGraceMs = (): number => {
  const n = Number(process.env.EXPORTS_CANCEL_GRACE_MS);
  return Number.isFinite(n) && n >= 1_000 ? Math.floor(n) : 30_000;
};
