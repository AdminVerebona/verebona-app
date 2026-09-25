/**
 * Garde serveur — écritures et traitements IA. CDC 1 §8.3, §9.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA RÈGLE N'EXISTAIT QUE DANS L'INTERFACE
 *
 * `entitlements.service` calcule correctement `canWrite: false` quand l'essai
 * est terminé. Mais trois routes seulement le lisaient, et aucune n'était une
 * route d'écriture ou d'analyse.
 *
 * Conséquence : un compte sans abonnement qui appelait l'API directement —
 * ou dont l'interface offrait un chemin non gardé — déclenchait des analyses
 * facturées. Le seul `403` de `files/confirm` contrôlait la propriété du
 * fichier, pas les droits.
 *
 * Une règle commerciale appliquée seulement par le navigateur n'est pas
 * appliquée.
 *
 * ── CE QUI RESTE PERMIS ───────────────────────────────────────────────────
 *
 * La lecture, entièrement : consulter ses biens, ses documents, son agenda,
 * ses exports déjà produits. Et la recherche simple — `/api/search` —, qui
 * n'appelle aucun modèle.
 *
 * Seules la recherche IA et les écritures sont refusées. L'utilisateur garde
 * l'accès à ses données, ce que le message de fin d'essai lui promet.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextResponse } from 'next/server';
import { getEntitlements, restrictedRefusal } from '@/services/entitlements.service';

/** Format déjà compris par le client, via `parseWriteBlocked`. */
export interface RefusEcriture {
  code: 'TRIAL_EXPIRED' | 'SUBSCRIPTION_REQUIRED';
  message: string;
}

// Les statuts sont ceux que rend `getEntitlements` : `readonly` pour un
// essai échu, `canceled` pour un abonnement résilié, `none` pour un compte
// sans abonnement. « Essai terminé » et « pas d'abonnement » appellent des
// suites différentes — choisir une offre, ou en reprendre une. Un compte
// recréé avec une adresse dont l'essai est consommé relève du premier cas
// (cf. `restrictedRefusal`).

/**
 * Refuse l'écriture si le compte ne peut plus écrire.
 *
 * Rend `null` quand l'action est permise, sinon une réponse 403 prête à être
 * renvoyée :
 *
 *     const refus = await refuserSiLectureSeule(accountId);
 *     if (refus) return refus;
 *
 * ── 403 ET NON 402 ────────────────────────────────────────────────────────
 *
 * `402 Payment Required` décrirait mieux la situation, mais il est peu
 * implémenté par les clients HTTP et souvent traité comme une erreur
 * réseau. Le 403 est compris partout, et le code dans le corps porte la
 * nuance.
 */
export async function refuserSiLectureSeule(
  accountId: number,
): Promise<NextResponse | null> {
  const droits = await getEntitlements(accountId);
  if (droits.canWrite) return null;

  const refus: RefusEcriture = await restrictedRefusal(accountId, droits.status);
  return NextResponse.json(refus, { status: 403 });
}

/**
 * Variante pour les traitements IA.
 *
 * Identique aujourd'hui : un essai terminé interdit les deux. Elle existe
 * séparément parce que les deux règles peuvent diverger — une offre sans IA
 * mais avec écriture est un cas plausible, et il se traiterait ici sans
 * toucher aux trente routes d'écriture.
 */
export async function refuserSiPasDIA(
  accountId: number,
): Promise<NextResponse | null> {
  return refuserSiLectureSeule(accountId);
}
