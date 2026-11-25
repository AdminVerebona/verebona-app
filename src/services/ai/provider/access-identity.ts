/**
 * IDENTITÉ PSEUDONYMISÉE D'UN ACCÈS FOURNISSEUR — lot 115, carte Trello #786
 * (écarts A01, A02, C01).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL ENDROIT POUR « QUEL ACCÈS ? », ET JAMAIS LA CLÉ
 *
 * Un verdict de disponibilité ne vaut que pour l'ACCÈS qui a envoyé. Pour le
 * dire sans jamais manipuler la clé, deux fonctions suffisent :
 *   · `keyFingerprint` — empreinte NON RÉVERSIBLE (SHA-256 tronqué) de la
 *     clé : c'est elle qui entre dans la clé canonique de l'état, dans
 *     l'identité de route et dans les clés d'alerte ;
 *   · `accessLabel`    — libellé pseudonymisé affiché au BO, dans les
 *     journaux, les traces et les exports (« clé …a1b2c3d4 »).
 *
 * Elles vivent dans un module À PART, PUR et SANS AUCUNE DÉPENDANCE :
 *   · ni base de données — la frontière d'admission (`operational-admission`)
 *     doit pouvoir figer l'empreinte de l'accès AVANT l'envoi, sur le chemin
 *     chaud, sans charger la persistance ;
 *   · ni classification, ni configuration — pour qu'aucun harnais de test qui
 *     simule la persistance ou le résolveur de clé ne puisse, par ricochet,
 *     priver le code de son empreinte.
 *
 * `model-operational.service` et `provider-secret` les réexportent : les
 * appelants historiques ne changent pas d'import, et il n'existe qu'UNE
 * définition de l'empreinte dans tout le dépôt.
 *
 * Aucun secret, aucune donnée de compte ne sort d'ici (#786, contrainte 5).
 */
import { createHash } from 'node:crypto';

/**
 * Empreinte non réversible d'une clé (jamais la clé elle-même) : SHA-256
 * tronqué à 16 caractères hexadécimaux. Stable, déterministe, pure.
 */
export function keyFingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

/** Accès pseudonymisé affiché (8 premiers caractères de l'empreinte, non réversible). */
export function accessLabel(fingerprint: string): string {
  return `clé …${fingerprint.slice(0, 8)}`;
}
