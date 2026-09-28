/**
 * Détail d'une requête T2 — sources réellement utilisées (LOG-UI-07) et
 * accès RESTREINT au contenu conversationnel (LOG-UI-08, WF-45).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SOURCES : LA LISTE, PAS LE TEXTE
 *
 * `verebona_message_sources` garde, pour chaque réponse, les sources citées
 * (type, identifiant, titre figé, rang, pertinence, disponibilité). L'extrait
 * (`excerpt_snapshot`) est un morceau de document du client : il n'est PAS
 * rendu ici — seulement ce qui permet d'identifier la source.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONTENU : ACCÈS RESTREINT, JUSTIFIÉ, TRACÉ, ET QUI DISPARAÎT À LA PURGE
 *
 * · Réservé aux administrateurs listés dans `AI_T2_CONTENT_ADMIN_IDS`
 *   (identifiants séparés par des virgules). Variable absente : tout
 *   administrateur, mais toujours avec justification et trace.
 * · Justification obligatoire (≥ 15 caractères), consignée avec le résultat
 *   dans `ai_t2_content_access_log` — y compris les refus.
 * · Seul le contenu non expiré (< 3 mois, `expires_at` non échu) est rendu ;
 *   une fois purgé, il n'existe plus nulle part (ni base, ni archive — WF-45).
 */
import { pgClient } from '@/db';

type Row = Record<string, unknown>;

export interface T2Source {
  messageId: number;
  sourceType: string;
  sourceId: string;
  title: string | null;
  rank: number | null;
  relevanceScore: number | null;
  isAvailable: boolean;
}

export async function getT2RequestSources(requestId: string): Promise<T2Source[]> {
  const rows = (await pgClient.unsafe(
    `SELECT s.message_id, s.source_type, s.source_id, s.title_snapshot, s.rank, s.relevance_score, s.is_available
       FROM verebona_message_sources s
       JOIN verebona_messages m ON m.id = s.message_id
      WHERE m.request_id = $1
      ORDER BY s.message_id, s.rank NULLS LAST, s.id
      LIMIT 100`,
    [requestId] as never[],
  )) as unknown as Row[];
  return rows.map((r) => ({
    messageId: Number(r.message_id),
    sourceType: String(r.source_type),
    sourceId: String(r.source_id),
    title: r.title_snapshot == null ? null : String(r.title_snapshot),
    rank: r.rank == null ? null : Number(r.rank),
    relevanceScore: r.relevance_score == null ? null : Number(r.relevance_score),
    isAvailable: Boolean(r.is_available),
  }));
}

export const T2_CONTENT_MIN_REASON = 15;
/** Au-delà, le contenu est réputé purgé même si une ligne subsiste (T2 : 3 mois). */
export const T2_CONTENT_MAX_AGE_DAYS = 92;

/** Pur : l'administrateur est-il autorisé par la liste restreinte (AI_T2_CONTENT_ADMIN_IDS) ? Liste absente ou vide = personne. */
export function isContentAccessAllowed(adminUserId: number, raw: string | undefined = process.env.AI_T2_CONTENT_ADMIN_IDS): boolean {
  const ids = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  // Fermé par défaut (LOG-UI-08, WF-45) : sans liste explicite, aucun
  // administrateur ne lit le contenu des conversations.
  if (ids.length === 0) return false;
  return ids.includes(String(adminUserId));
}

export type T2ContentResult =
  | { ok: true; accountId: number | null; messages: Array<{ role: string; content: string | null; createdAt: string; expiresAt: string }> }
  | { ok: false; code: 'REASON_REQUIRED' | 'FORBIDDEN' | 'NOT_FOUND' | 'EXPIRED'; message: string };

async function logAccess(adminUserId: number, requestId: string, accountId: number | null, reason: string, result: string): Promise<void> {
  await pgClient.unsafe(
    `INSERT INTO ai_t2_content_access_log (admin_user_id, request_id, account_id, reason, result)
     VALUES ($1, $2, $3, $4, $5)`,
    [adminUserId, requestId, accountId, reason.slice(0, 500), result] as never[],
  ).catch((e: Error) => console.error('[t2-content] trace d’accès non enregistrée :', e.message));
}

export async function readT2Content(p: { adminUserId: number; requestId: string; reason: string }): Promise<T2ContentResult> {
  const reason = (p.reason ?? '').trim();
  if (reason.length < T2_CONTENT_MIN_REASON) {
    return { ok: false, code: 'REASON_REQUIRED', message: `Justification obligatoire (${T2_CONTENT_MIN_REASON} caractères minimum).` };
  }
  if (!isContentAccessAllowed(p.adminUserId)) {
    await logAccess(p.adminUserId, p.requestId, null, reason, 'DENIED');
    return { ok: false, code: 'FORBIDDEN', message: 'Accès au contenu conversationnel réservé (AI_T2_CONTENT_ADMIN_IDS).' };
  }
  const rows = (await pgClient.unsafe(
    `SELECT account_id, role, content, created_at, expires_at
       FROM verebona_messages
      WHERE request_id = $1
      ORDER BY created_at, id LIMIT 20`,
    [p.requestId] as never[],
  )) as unknown as Row[];
  if (rows.length === 0) {
    await logAccess(p.adminUserId, p.requestId, null, reason, 'NOT_FOUND');
    return { ok: false, code: 'NOT_FOUND', message: 'Aucun contenu : la conversation a été purgée ou n’a pas été conservée.' };
  }
  const accountId = rows[0].account_id == null ? null : Number(rows[0].account_id);
  const now = Date.now();
  const vivants = rows.filter((r) => {
    const exp = new Date(String(r.expires_at)).getTime();
    const age = now - new Date(String(r.created_at)).getTime();
    return exp > now && age < T2_CONTENT_MAX_AGE_DAYS * 86_400_000;
  });
  if (vivants.length === 0) {
    await logAccess(p.adminUserId, p.requestId, accountId, reason, 'EXPIRED');
    return { ok: false, code: 'EXPIRED', message: 'Contenu expiré : il n’est plus consultable (purge à 3 mois).' };
  }
  await logAccess(p.adminUserId, p.requestId, accountId, reason, 'GRANTED');
  return {
    ok: true,
    accountId,
    messages: vivants.map((r) => ({
      role: String(r.role),
      content: r.content == null ? null : String(r.content),
      createdAt: new Date(String(r.created_at)).toISOString(),
      expiresAt: new Date(String(r.expires_at)).toISOString(),
    })),
  };
}
