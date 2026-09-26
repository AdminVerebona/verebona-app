/**
 * Cycle de vie d'une demande : réservation, verrou, annulation — CDC §6.6,
 * §7.8, §9.6, §9.7, §27.4, §27.5, §30.4, §31.9, CA-22, CA-29, 37.17, 37.20.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA TRACE EST ÉCRITE AU DÉBUT, PLUS SEULEMENT À LA FIN
 *
 * `verebona_request_runs` n'était inséré qu'à la persistance de la réponse.
 * Trois conséquences :
 *   · `DELETE /requests/{id}` ne trouvait jamais de demande en cours :
 *     l'annulation n'annulait rien, et la réponse tardive réapparaissait au
 *     rechargement ;
 *   · deux envois identiques (double clic, réseau instable) lançaient deux
 *     pipelines — deux appels modèle facturés — avant que l'index unique des
 *     messages ne fasse échouer, en silence, le second ;
 *   · deux questions simultanées dans le même fil s'exécutaient en parallèle.
 *
 * Désormais, AVANT tout traitement, la route réserve la demande : une ligne
 * `pending` sous verrou transactionnel du fil. Elle porte le `client_request_id`
 * (index unique par utilisateur, migration 0176) : le second envoi identique
 * trouve la réservation et n'appelle rien. Une autre demande en cours dans le
 * même fil (moins de `staleAfterMs`) est refusée (409 REQUEST_IN_PROGRESS).
 *
 * À la persistance, la ligne est relue `FOR UPDATE` : annulée entre-temps, la
 * réponse n'est PAS enregistrée (aucune réponse tardive réinjectée), seule la
 * trace est complétée.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'crypto';
import { pgClient } from '@/db';

export type Reservation =
  /** Demande réservée : le traitement peut commencer avec cet identifiant. */
  | { kind: 'reserved'; requestId: string }
  /** Le MÊME envoi (même clientRequestId) est déjà en cours : aucun second appel. */
  | { kind: 'duplicate_in_progress'; requestId: string }
  /** Le même envoi est déjà terminé (réponse rejouable, annulée ou en échec). */
  | { kind: 'duplicate_finished'; requestId: string; status: string }
  /** Une AUTRE demande est en cours dans ce fil (§6.6 : une seule à la fois). */
  | { kind: 'thread_busy'; requestId: string };

export interface ReserveInput {
  accountId: number;
  userId: number;
  conversationId: number;
  clientRequestId: string;
  /** Au-delà, une réservation `pending` est considérée abandonnée (processus tué). */
  staleAfterMs: number;
}

type Row = { request_id: string; status: string | null; created_at: Date | string };

const estRecente = (r: Row, staleAfterMs: number) => Date.now() - new Date(r.created_at).getTime() < staleAfterMs;

export async function reserveRequest(p: ReserveInput): Promise<Reservation> {
  return pgClient.begin(async (tx) => {
    // Verrou du FIL : sérialise les réservations concurrentes du même fil,
    // sans bloquer les autres fils ni les autres utilisateurs.
    await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('verebona_req:' || $1::text))`, [p.conversationId] as never[]);

    // 1. Même envoi déjà vu (idempotence §31.9, bornée à l'utilisateur).
    const memes = (await tx.unsafe(
      `SELECT request_id, status, created_at FROM verebona_request_runs
        WHERE account_id = $1 AND user_id = $2 AND client_request_id = $3
        ORDER BY id DESC LIMIT 1`,
      [p.accountId, p.userId, p.clientRequestId] as never[],
    )) as unknown as Row[];
    const meme = memes[0];
    if (meme) {
      if (meme.status === 'pending' && estRecente(meme, p.staleAfterMs)) {
        return { kind: 'duplicate_in_progress' as const, requestId: meme.request_id };
      }
      if (meme.status === 'pending') {
        // Réservation abandonnée (redémarrage pendant le traitement) : on la
        // reprend plutôt que de bloquer l'envoi pour toujours.
        await tx.unsafe(
          `UPDATE verebona_request_runs SET created_at = now(), conversation_id = $2 WHERE request_id = $1`,
          [meme.request_id, p.conversationId] as never[],
        );
        return { kind: 'reserved' as const, requestId: meme.request_id };
      }
      return { kind: 'duplicate_finished' as const, requestId: meme.request_id, status: meme.status ?? 'ok' };
    }

    // 2. Une seule demande en cours par fil (§6.6, §9.7).
    const enCours = (await tx.unsafe(
      `SELECT request_id, status, created_at FROM verebona_request_runs
        WHERE conversation_id = $1 AND status = 'pending'
          AND created_at > now() - ($2::int * interval '1 millisecond')
        ORDER BY id DESC LIMIT 1`,
      [p.conversationId, p.staleAfterMs] as never[],
    )) as unknown as Row[];
    if (enCours[0]) return { kind: 'thread_busy' as const, requestId: enCours[0].request_id };

    // 3. Réservation. ON CONFLICT : filet de l'index unique (migration 0176)
    //    si deux fils différents recevaient le même clientRequestId.
    const requestId = randomUUID();
    const ins = (await tx.unsafe(
      `INSERT INTO verebona_request_runs
         (request_id, client_request_id, conversation_id, account_id, user_id, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT DO NOTHING RETURNING request_id`,
      [requestId, p.clientRequestId, p.conversationId, p.accountId, p.userId] as never[],
    )) as unknown as Array<{ request_id: string }>;
    if (!ins[0]) return { kind: 'duplicate_in_progress' as const, requestId };
    return { kind: 'reserved' as const, requestId };
  }) as Promise<Reservation>;
}

/** La demande a-t-elle été annulée ? Base injoignable : non (on continue). */
export async function isRequestCancelled(requestId: string | undefined): Promise<boolean> {
  if (!requestId) return false;
  try {
    const rows = (await pgClient.unsafe(
      `SELECT 1 FROM verebona_request_runs WHERE request_id = $1 AND status = 'cancelled' LIMIT 1`,
      [requestId] as never[],
    )) as unknown[];
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Clôt une réservation restée `pending` (persistance impossible, exception
 * dans la route) : sans cela, le fil resterait « occupé » jusqu'à
 * l'expiration de la réservation.
 */
export async function closePendingRequest(requestId: string, status: 'ok' | 'error', errorCode?: string | null): Promise<void> {
  try {
    await pgClient.unsafe(
      `UPDATE verebona_request_runs SET status = $2, error_code = COALESCE(error_code, $3)
        WHERE request_id = $1 AND status = 'pending'`,
      [requestId, status, errorCode ?? null] as never[],
    );
  } catch (e) {
    console.error('[verebona] clôture de la demande impossible', (e as Error).message);
  }
}

/** Statut courant d'une demande (après traitement : « cancelled » ?). */
export async function requestStatus(requestId: string): Promise<string | null> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT status FROM verebona_request_runs WHERE request_id = $1 LIMIT 1`,
      [requestId] as never[],
    )) as unknown as Array<{ status: string | null }>;
    return rows[0]?.status ?? null;
  } catch {
    return null;
  }
}
