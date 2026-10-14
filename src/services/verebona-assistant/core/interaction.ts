/**
 * Nature du message comprise par T2 — lot 54E (#419 §15, écarts 3 à 5).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * T2 DIT CE QUE L'UTILISATEUR FAIT ; LE SERVEUR DÉCIDE CE QUI EST POSSIBLE
 *
 * « La date de fin de LLD de la Cupra est le 21/05/2027 » n'est pas une
 * question : l'utilisateur APPORTE une information. Aucun verbe de commande
 * (« mets », « modifie »…) n'est exigé, et aucune règle « phrase affirmative
 * = mise à jour » n'est codée : c'est T2 qui lit la nature du message
 * (`interactionMode`) et le rôle de chaque information apportée
 * (`suppliedFacts[].role`).
 *
 *   UPDATE_PROPOSAL / ACTION_REQUEST  → proposition : le SERVEUR résout la
 *       cible, la capacité d'écriture, les droits, la valeur actuelle, puis
 *       prépare un plan PENDING_CONFIRMATION (CommandPlan existant) —
 *       JAMAIS d'écriture avant confirmation explicite ;
 *   AMBIGUOUS + information à enregistrer → même proposition (la
 *       confirmation EST la question) ;
 *   CONTEXT_ONLY → accusé de lecture, rien n'est enregistré ;
 *   QUERY / MIXED → la question suit son cours ; une information de
 *       contexte sert à comprendre, jamais à écrire.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { RouteInteraction, SuppliedFact } from '../types/contracts';

export type InteractionHandling = 'proposal' | 'context_only' | null;

/** Informations à proposer à l'enregistrement (pure, testée). */
export function updateFactsOf(i: RouteInteraction | undefined | null): SuppliedFact[] {
  if (!i) return [];
  const avecValeur = i.suppliedFacts.filter((f) => (f.normalizedValue ?? f.value ?? '').trim() !== '');
  if (i.mode === 'UPDATE_PROPOSAL' || i.mode === 'ACTION_REQUEST') return avecValeur.filter((f) => f.role !== 'context');
  if (i.mode === 'AMBIGUOUS') return avecValeur.filter((f) => f.role === 'update');
  return [];
}

/** Traitement de la nature du message (pure, testée) ; `null` : la question suit son cours. */
export function interactionHandling(i: RouteInteraction | undefined | null): InteractionHandling {
  if (!i) return null;
  if (updateFactsOf(i).length) return 'proposal';
  if (i.mode === 'CONTEXT_ONLY') return 'context_only';
  return null;
}

/** Réponse à une information donnée pour le seul contexte (aucune écriture). */
export const CONTEXT_ONLY_MESSAGE = 'Merci pour cette précision. Je n’ai rien modifié dans vos données. '
  + 'Si vous souhaitez l’enregistrer, dites-le-moi et je vous proposerai la modification à confirmer.';

/** Proposition impossible faute de capacité d'écriture côté assistant. */
export const UPDATE_DISABLED_MESSAGE = 'Merci pour cette information. Les modifications depuis l’assistant ne sont pas disponibles actuellement : rien n’a été modifié.';

/** Compte en lecture seule (fin d'essai). */
export const UPDATE_READ_ONLY_MESSAGE = 'Votre compte est en lecture seule : je ne peux pas proposer de modification. Rien n’a été modifié.';
