/**
 * Retour utilisateur de la file de dépôt — lot 31 (L31-5).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PLUS DE PANNEAU FLOTTANT « ENVOI DE DOCUMENTS »
 *
 * Le suivi flottant (bas droite, lot 26) était perçu comme un toast non
 * souhaité : « La notification suffit ». Le retour d'un envoi RÉUSSI est
 * porté par des mécanismes existants :
 *   · la modale d'ajout montre la progression du lot qu'elle a lancé ;
 *   · après confirmation, l'indicateur « Analyse(s) en cours… Voir » du
 *     header (bandeau mobile) puis la notification de fin de lot (cloche) ;
 *   · le document apparaît dans les listes (`document-added`).
 * Aucun toast de succès « document ajouté ».
 *
 * Un ÉCHEC reste toujours signalé, de façon visible :
 *   · fin de lot avec échecs : message d'erreur (la modale reste ouverte sur
 *     le lot si elle le suit encore, sinon le message propose « Reprendre ») ;
 *   · envois interrompus restaurés après fermeture, échec d'une reprise
 *     automatique : message d'erreur avec « Reprendre » ;
 *   · « Reprendre » ouvre la modale d'ajout, qui liste les envois à reprendre
 *     (section « Envois à reprendre ») avec leurs actions.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { ElementDepot } from '@/lib/upload-queue';

/** Événement fenêtre : ouvrir la modale d'ajout sur les envois à reprendre. */
export const EVENEMENT_REPRISE_DEPOTS = 'upload-queue:resume';

export function ouvrirRepriseDepots(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENEMENT_REPRISE_DEPOTS));
}

/** Échoué ou interrompu : à reprendre ou à abandonner par l'utilisateur. */
export function estEnSouffrance(e: ElementDepot): boolean {
  return e.etape === 'echec' || e.etape === 'interrompu';
}

/** Envois en souffrance hors du lot suivi par la modale (`lotSuivi`). */
export function envoisAReprendre(elements: ElementDepot[], lotSuivi: string | null = null): ElementDepot[] {
  return elements.filter((e) => estEnSouffrance(e) && e.lotId !== lotSuivi);
}

const pluriel = (n: number, s: string, p: string) => (n > 1 ? p : s);

/** Message des envois interrompus restaurés (fermeture, rechargement). */
export function messageEnvoisInterrompus(n: number): string {
  return `${n} ${pluriel(n, 'envoi de document interrompu', 'envois de documents interrompus')}`;
}

/** Message d'échec d'une reprise automatique (retour au premier plan). */
export function messageRepriseEchouee(n: number): string {
  return `${n} ${pluriel(n, 'document non ajouté', 'documents non ajoutés')} après reprise`;
}

/** Mémoire des signalements de la supervision (une par session d'onglet). */
export interface MemoireSignalements {
  /** Envois interrompus déjà signalés (un message par restauration). */
  interrompus: Set<string>;
  /** Reprises automatiques dont l'issue reste à surveiller. */
  relances: Set<string>;
}

export const nouvelleMemoireSignalements = (): MemoireSignalements => ({ interrompus: new Set(), relances: new Set() });

/**
 * Messages d'erreur à afficher pour un nouvel état de la file : envois
 * restaurés « interrompus » pas encore signalés, reprises automatiques
 * retombées en échec. Met à jour `memoire` (chaque cas n'est signalé qu'une
 * fois). Les échecs d'un lot sont signalés par la modale (fin de lot).
 */
export function signalementsDepot(elements: ElementDepot[], memoire: MemoireSignalements): string[] {
  const messages: string[] = [];
  const interrompus = elements.filter((e) => e.etape === 'interrompu' && !memoire.interrompus.has(e.operationId));
  for (const e of interrompus) memoire.interrompus.add(e.operationId);
  if (interrompus.length > 0) messages.push(messageEnvoisInterrompus(interrompus.length));
  let echecsRelance = 0;
  for (const e of elements) {
    if (!memoire.relances.has(e.operationId)) continue;
    if (e.etape === 'echec') { echecsRelance += 1; memoire.relances.delete(e.operationId); }
    else if (e.etape === 'termine' || e.etape === 'annule') memoire.relances.delete(e.operationId);
  }
  if (echecsRelance > 0) messages.push(messageRepriseEchouee(echecsRelance));
  return messages;
}

export const DESCRIPTION_REPRISE = 'Reprenez-les depuis « Ajouter un document ».';
export const ACTION_REPRISE = 'Reprendre';
