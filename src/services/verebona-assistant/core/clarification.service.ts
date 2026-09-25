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
import type { ClarificationCandidate, ClarificationState, ClarificationStatus } from '../types/machine';
import type { AssistantRequestInput } from '../types/contracts';
import { interpretTypedAnswer, isExpired, MAX_FAILED_ATTEMPTS } from './clarification-builder';

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
const TENTATIVES_MAX = MAX_FAILED_ATTEMPTS;

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
  // Déjà traitée (résolue, abandonnée…) : un ancien bouton ne la réactive pas.
  if (etat.status && etat.status !== 'PENDING') {
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
 * Charge la clarification en attente d'un utilisateur dans un compte.
 *
 * Le bornage au compte ET à l'utilisateur est dans la requête, pas dans un
 * contrôle qui suivrait : un état appartenant à un autre compte — ou à
 * l'autre membre d'un compte Duo — n'est jamais chargé, donc jamais comparé,
 * donc jamais accepté par mégarde.
 */
export async function chargerClarification(
  accountId: number,
  userId: number,
  /**
   * Clarification visée. Un utilisateur peut tenir plusieurs fils : l'état
   * est cherché dans LE fil qui porte cette clarification, jamais dans « le
   * premier fil actif ».
   */
  clarificationId?: string,
  /** Fil courant : sans identifiant de clarification, seule celle de CE fil compte. */
  conversationId?: number,
): Promise<{ etat: ClarificationState | null; conversationId: number | null }> {
  const rows = conversationId && !clarificationId
    ? await pgClient<{ id: number; clarification_state_json: unknown }[]>`
        SELECT id, clarification_state_json
        FROM verebona_conversations
        WHERE id = ${conversationId} AND account_id = ${accountId} AND user_id = ${userId} AND status = 'active'
        LIMIT 1
      `
    : clarificationId
    ? await pgClient<{ id: number; clarification_state_json: unknown }[]>`
        SELECT id, clarification_state_json
        FROM verebona_conversations
        WHERE account_id = ${accountId} AND user_id = ${userId} AND status = 'active'
          AND clarification_state_json->>'clarificationId' = ${clarificationId}
        LIMIT 1
      `
    : await pgClient<{ id: number; clarification_state_json: unknown }[]>`
        SELECT id, clarification_state_json
        FROM verebona_conversations
        WHERE account_id = ${accountId} AND user_id = ${userId} AND status = 'active'
        ORDER BY COALESCE(last_message_at, created_at) DESC
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


// ══════════════════════════════════════════════════════════════════════════
// PARCOURS COMPLET — création, choix sécurisé, reprise structurée, repli
// ══════════════════════════════════════════════════════════════════════════

export type ClarificationEvent =
  | 'CREATED' | 'CHOICE_ACCEPTED' | 'INVALID_CHOICE' | 'UNRECOGNIZED_ANSWER' | 'EXPIRED'
  | 'CANDIDATE_UNAVAILABLE' | 'RESUME_SUCCEEDED' | 'RESUME_FAILED' | 'FALLBACK' | 'ABANDONED'
  | 'CHAIN_EXHAUSTED';

/** Trace une étape. Ne lève jamais : la traçabilité ne bloque pas l'utilisateur. */
export async function traceClarification(
  etat: Pick<ClarificationState, 'clarificationId' | 'conversationId' | 'accountId' | 'userId'>,
  event: ClarificationEvent,
  detail: Record<string, unknown> = {},
): Promise<void> {
  try {
    await pgClient.unsafe(
      `INSERT INTO verebona_clarification_events
         (clarification_id, conversation_id, account_id, user_id, event_type, detail_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [etat.clarificationId, etat.conversationId ?? null, etat.accountId ?? 0, etat.userId ?? null,
       event, JSON.stringify(detail)] as never[],
    );
  } catch (e) {
    console.error('[verebona] trace de clarification non enregistrée :', (e as Error).message);
  }
}

/**
 * Enregistre une clarification sur SON fil. Rend `false` si le fil n'est pas
 * celui de l'utilisateur (ou n'existe plus) : l'orchestrateur ne présente
 * alors pas une question à laquelle on ne pourrait pas répondre.
 */
export async function saveClarification(etat: ClarificationState): Promise<boolean> {
  if (!etat.conversationId || !etat.accountId || !etat.userId) return false;
  const rows = await pgClient.unsafe(
    `UPDATE verebona_conversations
        SET clarification_state_json = $4::jsonb, machine_state = 'CLARIFYING', updated_at = now()
      WHERE id = $1 AND account_id = $2 AND user_id = $3 AND status = 'active'
      RETURNING id`,
    [etat.conversationId, etat.accountId, etat.userId, JSON.stringify(etat)] as never[],
  );
  const ok = (rows as unknown as unknown[]).length > 0;
  if (ok) {
    await traceClarification(etat, 'CREATED', {
      originalMessage: etat.originalMessage,
      originalIntent: etat.originalIntent,
      reason: etat.ambiguity?.reason,
      candidates: etat.candidates.map((c) => ({ id: c.id, label: c.label, secondaryLabel: c.secondaryLabel })),
      chainDepth: etat.chainDepth,
      expiresAt: etat.expiresAt,
    });
  }
  return ok;
}

async function enregistrerEtat(etat: ClarificationState): Promise<void> {
  await pgClient.unsafe(
    `UPDATE verebona_conversations SET clarification_state_json = $2::jsonb, updated_at = now() WHERE id = $1`,
    [etat.conversationId, JSON.stringify(etat)] as never[],
  );
}

async function clore(conversationId: number, statut: ClarificationStatus): Promise<void> {
  // L'état est retiré du fil : plus rien n'est « en attente ». Le statut
  // final est conservé dans la trace.
  void statut;
  await consommerClarification(conversationId);
}

/**
 * Le candidat choisi existe-t-il toujours, dans ce compte, et reste-t-il
 * accessible ? Vérifié à la reprise : entre la question et la réponse, le
 * bien a pu être supprimé, archivé ou transmis.
 */
export async function candidatToujoursValide(
  accountId: number,
  candidateType: ClarificationState['candidateType'],
  candidate: ClarificationCandidate,
): Promise<boolean> {
  if (!candidate.entityId) return false;
  const sql = candidateType === 'asset'
    ? `SELECT 1 FROM assets
        WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL
          AND coalesce(status, 'EN_SERVICE') NOT IN ('ARCHIVED', 'TRANSMIS')
        LIMIT 1`
    : candidateType === 'document'
      ? `SELECT 1 FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL LIMIT 1`
      : candidateType === 'agenda'
        ? `SELECT 1 FROM agenda_items WHERE id = $1 AND account_id = $2 LIMIT 1`
        : null;
  if (!sql) return false;
  const rows = await pgClient.unsafe(sql, [candidate.entityId, accountId] as never[]);
  return (rows as unknown as unknown[]).length > 0;
}

export type IssueClarification =
  /** Choix valide : reprendre la demande initiale avec ce candidat. */
  | { kind: 'resume'; etat: ClarificationState; candidate: ClarificationCandidate }
  /** Choix non retenu : la même question est reposée (candidats à jour). */
  | { kind: 'reask'; etat: ClarificationState; message: string }
  /** Tentatives épuisées ou plus aucun candidat : repli. */
  | { kind: 'fallback'; etat: ClarificationState; message: string }
  /** L'utilisateur a posé une autre question : clarification abandonnée. */
  | { kind: 'abandoned' }
  /** Refus sans reprise (introuvable, expirée). */
  | { kind: 'rejected'; motif: EchecClarification; message: string };

const REPLI = "Je n'arrive pas à identifier précisément l'élément concerné. Vous pouvez ouvrir la liste de vos biens pour le sélectionner, ou reformuler votre demande en le nommant.";

/**
 * Traite une réponse à une clarification — choix cliqué (`choiceId`) ou
 * réponse tapée (`typedText`).
 *
 * Contrôles, dans l'ordre : propriété (compte, utilisateur, fil), état
 * encore en attente, expiration, tentatives restantes, choix parmi les
 * candidats proposés, candidat toujours valide en base.
 */
export async function resoudreClarification(p: {
  accountId: number;
  userId: number;
  clarificationId?: string;
  /** Fil courant : une clarification d'un autre fil n'y est jamais consommée. */
  conversationId?: number;
  choiceId?: string;
  typedText?: string;
  now?: Date;
}): Promise<IssueClarification> {
  const now = p.now ?? new Date();
  const { etat, conversationId } = await chargerClarification(p.accountId, p.userId, p.clarificationId, p.conversationId);
  const refus = (motif: EchecClarification): IssueClarification => ({ kind: 'rejected', motif, message: messageEchec(motif) });

  if (!etat || !conversationId) return refus('INTROUVABLE');
  if (p.clarificationId && etat.clarificationId !== p.clarificationId) return refus('INTROUVABLE');
  // Propriété : double contrôle (la requête de chargement est déjà bornée).
  if ((etat.accountId && etat.accountId !== p.accountId) || (etat.userId && etat.userId !== p.userId)) {
    return refus('INTROUVABLE');
  }
  if (p.conversationId && p.conversationId !== conversationId) return refus('INTROUVABLE');
  const e: ClarificationState = { ...etat, conversationId, accountId: p.accountId, userId: p.userId };

  if (e.status && e.status !== 'PENDING') return refus('INTROUVABLE');
  if (!e.originalMessage) {
    // État d'un format antérieur, sans demande initiale : rien à reprendre.
    await clore(conversationId, 'ABANDONED');
    return refus('INTROUVABLE');
  }
  if (isExpired(e, now)) {
    await clore(conversationId, 'EXPIRED');
    await traceClarification(e, 'EXPIRED', { choiceId: p.choiceId ?? null });
    return refus('EXPIREE');
  }
  if (e.attemptCount >= MAX_FAILED_ATTEMPTS) {
    await clore(conversationId, 'EXHAUSTED');
    await traceClarification(e, 'FALLBACK', { attemptCount: e.attemptCount });
    return { kind: 'fallback', etat: e, message: REPLI };
  }

  // ── Quel candidat ? ──────────────────────────────────────────────────────
  let candidate: ClarificationCandidate | undefined;
  let echec: ClarificationEvent | null = null;
  if (p.choiceId !== undefined) {
    candidate = e.candidates.find((c) => c.id === p.choiceId);
    if (!candidate) echec = 'INVALID_CHOICE';
  } else {
    const lu = interpretTypedAnswer(e, p.typedText ?? '');
    if (lu.kind === 'new_question') {
      await clore(conversationId, 'ABANDONED');
      await traceClarification(e, 'ABANDONED', { typedText: p.typedText });
      return { kind: 'abandoned' };
    }
    if (lu.kind === 'match') candidate = lu.candidate;
    else echec = 'UNRECOGNIZED_ANSWER';
  }

  const tentativeEchouee = async (evt: ClarificationEvent, message: string, maj: Partial<ClarificationState> = {}) => {
    const suivant: ClarificationState = { ...e, ...maj, attemptCount: e.attemptCount + 1 };
    await traceClarification(e, evt, { choiceId: p.choiceId ?? null, typedText: p.typedText ?? null, attemptCount: suivant.attemptCount });
    if (suivant.attemptCount >= MAX_FAILED_ATTEMPTS || suivant.candidates.length < 2) {
      await clore(conversationId, 'EXHAUSTED');
      await traceClarification(e, 'FALLBACK', { attemptCount: suivant.attemptCount });
      return { kind: 'fallback', etat: suivant, message: REPLI } as IssueClarification;
    }
    await enregistrerEtat(suivant);
    return { kind: 'reask', etat: suivant, message } as IssueClarification;
  };

  if (echec || !candidate) {
    return tentativeEchouee(echec ?? 'INVALID_CHOICE', `Je n'ai pas reconnu votre choix. ${e.question}`);
  }

  // ── Le candidat existe-t-il toujours ? ───────────────────────────────────
  if (!(await candidatToujoursValide(p.accountId, e.candidateType, candidate))) {
    const restants: ClarificationCandidate[] = [];
    for (const c of e.candidates) {
      if (c.id !== candidate.id && await candidatToujoursValide(p.accountId, e.candidateType, c)) restants.push(c);
    }
    return tentativeEchouee('CANDIDATE_UNAVAILABLE', `Cet élément n'est plus disponible. ${e.question}`, { candidates: restants });
  }

  await clore(conversationId, 'RESOLVED');
  await traceClarification(e, 'CHOICE_ACCEPTED', { choiceId: candidate.id, label: candidate.label });
  return { kind: 'resume', etat: { ...e, status: 'RESOLVED' }, candidate };
}

/**
 * Demande de reprise : la demande INITIALE, son intention et son contexte,
 * avec le choix injecté comme paramètre structuré (§20.5) — plus de
 * « question de clarification + libellé » recollés.
 */
export function inputDeReprise(
  base: Pick<AssistantRequestInput, 'accountId' | 'userId' | 'planType' | 'locale'>,
  etat: ClarificationState,
  candidate: ClarificationCandidate,
): AssistantRequestInput {
  const assetId = etat.candidateType === 'asset' ? candidate.entityId ?? null : null;
  const documentId = etat.candidateType === 'document' ? candidate.entityId ?? null : null;
  return {
    ...base,
    message: etat.originalMessage ?? '',
    clientRequestId: `clarif:${etat.clarificationId}:${candidate.id}`,
    conversationId: etat.conversationId,
    // Le bien choisi devient le contexte de la reprise : recherche, actions
    // (« ajouter un document à ce bien ») et réponses exactes le visent.
    pageContext: assetId ? { assetId: String(assetId) } : documentId ? { documentId: String(documentId) } : undefined,
    resume: {
      clarificationId: etat.clarificationId,
      intent: etat.originalIntent,
      assetId,
      documentId,
      chainDepth: etat.chainDepth ?? 1,
      choiceLabel: candidate.secondaryLabel ? `${candidate.label} — ${candidate.secondaryLabel}` : candidate.label,
    },
  };
}
