/**
 * Pastille de statut d'un bloc CIL (lot 112A, décision PO du 06/11).
 *
 * UNE règle, lue par l'écran de préparation ET par le PDF CIL : la pastille
 * combine
 *   · le statut de BLOC de la préparation (règle produit validée : présence,
 *     B6 lot 75A, blocage CIL-RULE-002) — il décide du blocage et de
 *     « Non applicable » ;
 *   · le statut granulaire du service commun d'état CIL (lot 111U,
 *     `services/cil/state`, même projection que l'onglet Informations).
 *
 * Aucun calcul parallèle : on ne relit aucune donnée ici, on ne fait que
 * traduire les deux statuts déjà calculés par le service commun.
 *
 *   bloc « complete » + état « renseigné »                 → Renseigné
 *   bloc « complete » + état partiel / à confirmer         → Partiel
 *     (au moins un élément exploitable, une partie des données attendues manque
 *     ou reste à confirmer)
 *   bloc « complete » + état « manquant »                  → À compléter
 *     (ex. B9 : des documents existent mais aucun n'est une annexe ; même
 *     lecture que l'onglet Informations, qui affiche « Manquant »)
 *   bloc « unknown » (non bloquant) + état « partiel »      → Partiel
 *   bloc « missing » (bloquant CIL-RULE-002)                → Manquant (inchangé)
 *   bloc « invalid » (ex. travaux sans date)                → À compléter (inchangé)
 *   bloc « not_applicable » (déclaration justifiée)         → Non applicable
 *   instantané antérieur sans état granulaire               → statut de bloc
 *
 * Pure, sans accès base : importable côté client.
 */
import type { CilItemStatus } from './cil-catalog';

export type CilBlockPresenceStatus = 'complete' | 'missing' | 'invalid' | 'unknown' | 'not_applicable';
export type CilBlockPillStatus = CilBlockPresenceStatus | 'partial';

/** Ton sémantique ; chaque rendu le traduit dans sa charte (moteur V12, Sérénité). */
export type CilPillTone = 'ok' | 'warn' | 'bad' | 'neutral';

/**
 * Libellés TEXTE des pastilles (lisibles en impression noir et blanc : le
 * statut ne repose jamais sur la seule couleur). Mêmes textes partout.
 */
export const CIL_BLOCK_PILL: Record<CilBlockPillStatus, { label: string; tone: CilPillTone }> = {
  complete: { label: 'Renseigné', tone: 'ok' },
  partial: { label: 'Partiel', tone: 'warn' },
  missing: { label: 'Manquant', tone: 'bad' },
  unknown: { label: 'À compléter', tone: 'warn' },
  // CDC §2.1 « invalid » (ex. travaux sans date) : rendu « À compléter ».
  invalid: { label: 'À compléter', tone: 'warn' },
  not_applicable: { label: 'Non applicable', tone: 'neutral' },
};

export function cilBlockPillStatus(status: CilBlockPresenceStatus, cilStatus?: CilItemStatus | null): CilBlockPillStatus {
  if (!cilStatus) return status;
  if (status === 'complete') {
    if (cilStatus === 'renseigne' || cilStatus === 'non_applicable') return 'complete';
    return cilStatus === 'manquant' ? 'unknown' : 'partial';
  }
  if (status === 'unknown' && cilStatus === 'partiel') return 'partial';
  return status;
}

/** Bloc « à compléter » au sens des compteurs (préparation et PDF) : partiel, inconnu ou à corriger. */
export function cilPillIsTodo(s: CilBlockPillStatus): boolean {
  return s === 'partial' || s === 'unknown' || s === 'invalid';
}
