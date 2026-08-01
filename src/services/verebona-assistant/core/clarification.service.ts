/**
 * Reprise de clarification — CDC §20.4, §20.5.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUATRE CONTRÔLES, ET LE PREMIER EST UNE QUESTION DE SÉCURITÉ
 *
 * La route de reprise recevait un identifiant de clarification et le
 * traitait — sans vérifier à qui il appartenait.
 *
 * Un identifiant deviné aurait suffi à répondre à la place d'un autre compte,
 * et donc à orienter l'assistant vers les documents de quelqu'un d'autre. Rien
 * n'aurait échoué ; la réponse serait simplement partie au mauvais endroit.
 *
 * Les trois autres relèvent de la justesse :
 *
 *   · EXPIRATION — trente minutes (§20.4). Au-delà, le contexte de la
 *     question a pu changer : répondre à une clarification d'hier
 *     produirait une réponse sur un état périmé ;
 *
 *   · CHOIX VALIDE — l'identifiant retenu doit figurer parmi les candidats
 *     proposés. Sans ce contrôle, un appelant désignerait n'importe quelle
 *     entité, y compris hors de son compte ;
 *
 *   · NOMBRE DE TENTATIVES — deux au plus (§20.3). Au-delà, l'assistant
 *     n'insiste pas : il rend la main plutôt que d'enfermer l'utilisateur
 *     dans une boucle de questions.
 *
 * ── L'ÉTAT EST CONSOMMÉ, PAS SEULEMENT LU ─────────────────────────────────
 *
 * Une clarification traitée est effacée dans la même opération. La laisser en
 * place permettrait de la rejouer indéfiniment, et `hasPendingClarification`
 * continuerait de croire qu'une question attend une réponse.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import type { ClarificationState } from '../types/machine';

export type EchecClarification =
  | 'INTROUVABLE'
  | 'EXPIREE'
  | 'CHOIX_INVALIDE'
  | 'TROP_DE_TENTATIVES';

export interface ClarificationResolue {
  etat: ClarificationState;
  /** Candidat retenu, tel qu'il figurait dans la proposition. */
  choix: { id: string; label: string };
  conversationId: number;
}

/** Deux tentatives au plus (§20.3). */
const TENTATIVES_MAX = 2;

/**
 * Décide du sort d'une reprise.
 *
 * Pure et exportée : c'est là que se joue le contrôle de propriété, et il doit
 * être vérifiable sans base. Une règle de sécurité testée uniquement de bout
 * en bout n'est testée qu'aux endroits où quelqu'un a pensé à l'éprouver.
 */
export function verifierClarification(
  etat: ClarificationState | null,
  clarificationId: string,
  choiceId: string,
  maintenant: Date = new Date(),
): { ok: true; choix: { id: string; label: string } } | { ok: false; motif: EchecClarification } {
  // L'état est déjà borné au compte par la requête qui l'a chargé. Ce
  // contrôle-ci vérifie que l'identifiant présenté est bien celui de l'état
  // trouvé — un autre identifiant, même valide ailleurs, ne s'applique pas.
  if (!etat || etat.clarificationId !== clarificationId) {
    return { ok: false, motif: 'INTROUVABLE' };
  }

  if (new Date(etat.expiresAt).getTime() <= maintenant.getTime()) {
    return { ok: false, motif: 'EXPIREE' };
  }

  if (etat.attemptCount >= TENTATIVES_MAX) {
    return { ok: false, motif: 'TROP_DE_TENTATIVES' };
  }

  const choix = etat.candidates.find((c) => c.id === choiceId);
  if (!choix) {
    // Le choix doit venir de la liste proposée. Accepter un identifiant
    // arbitraire reviendrait à laisser l'appelant désigner n'importe quelle
    // entité, y compris hors de son compte.
    return { ok: false, motif: 'CHOIX_INVALIDE' };
  }

  return { ok: true, choix: { id: choix.id, label: choix.label } };
}

/**
 * Charge la clarification en attente d'un compte.
 *
 * Le bornage au compte est dans la requête, pas dans un contrôle qui suivrait :
 * un état appartenant à un autre compte n'est jamais chargé, donc jamais
 * comparé, donc jamais accepté par mégarde.
 */
export async function chargerClarification(
  accountId: number,
): Promise<{ etat: ClarificationState | null; conversationId: number | null }> {
  const rows = await pgClient<{ id: number; clarification_state_json: unknown }[]>`
    SELECT id, clarification_state_json
    FROM verebona_conversations
    WHERE account_id = ${accountId} AND status = 'active'
    LIMIT 1
  `;
  if (rows.length === 0) return { etat: null, conversationId: null };

  const brut = rows[0].clarification_state_json;
  return {
    etat: (brut as ClarificationState | null) ?? null,
    conversationId: rows[0].id,
  };
}

/**
 * Efface la clarification traitée.
 *
 * Appelée que la reprise ait abouti ou échoué définitivement : une
 * clarification expirée ou épuisée doit disparaître, sinon
 * `hasPendingClarification` la signalerait indéfiniment et l'assistant
 * refuserait toute nouvelle question.
 */
export async function consommerClarification(conversationId: number): Promise<void> {
  await pgClient`
    UPDATE verebona_conversations
       SET clarification_state_json = NULL, updated_at = now()
     WHERE id = ${conversationId}
  `;
}

/** Incrémente le compteur sans consommer — cas d'un choix invalide. */
export async function incrementerTentative(
  conversationId: number,
  etat: ClarificationState,
): Promise<void> {
  const suivant = { ...etat, attemptCount: etat.attemptCount + 1 };
  await pgClient`
    UPDATE verebona_conversations
       SET clarification_state_json = ${JSON.stringify(suivant)}::jsonb, updated_at = now()
     WHERE id = ${conversationId}
  `;
}

/** Message destiné à l'utilisateur. Factuel, sans reproche. */
export function messageEchec(motif: EchecClarification): string {
  switch (motif) {
    case 'EXPIREE':
      return 'Cette question a expiré. Reformulez votre demande.';
    case 'TROP_DE_TENTATIVES':
      return 'Reformulez votre demande en précisant le bien ou le document concerné.';
    case 'CHOIX_INVALIDE':
      return 'Ce choix ne fait pas partie des propositions. Reformulez votre demande.';
    default:
      // Volontairement identique à `CHOIX_INVALIDE` : distinguer « n'existe
      // pas » de « ne vous appartient pas » renseignerait un appelant sur
      // l'existence de clarifications qui ne sont pas les siennes.
      return 'Ce choix ne fait pas partie des propositions. Reformulez votre demande.';
  }
}
