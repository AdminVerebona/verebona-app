/**
 * Lot 105B — JOURNAL de la promotion automatique IA (`ai_promotion_events`,
 * migration 0985) : revalidation à la frontière d'activation et dans la
 * transaction finale, blocages et relances A1, contrôles post-activation,
 * retours arrière. Chaque décision porte sa VERSION DE RÉFÉRENCE (empreintes,
 * identifiants) — jamais de secret, jamais de contenu de document.
 */
import { pgClient } from '@/db';

export type PromotionEventKind =
  | 'ACTIVATION_GATE' | 'ACTIVATION_TX' | 'A1_BLOCKED' | 'A1_RELAUNCH' | 'A1_WAITING' | 'ACTIVATED'
  | 'POST_CHECK' | 'POST_ALERT' | 'ROLLBACK' | 'ROLLBACK_FAILED' | 'WATCH_END'
  // Lot 113I (migration 1488) : promotion / retour arrière CIBLÉS, refus de rollback, états de surveillance, budget.
  | 'TARGETED_PROMOTION' | 'TARGETED_ROLLBACK' | 'ROLLBACK_REFUSED' | 'WATCH_STATE' | 'BUDGET';

export interface PromotionEvent {
  id: number;
  environment: string;
  kind: PromotionEventKind;
  candidateVersionId: number | null;
  campaignId: number | null;
  treatment: string | null;
  allowed: boolean | null;
  code: string | null;
  message: string;
  reference: Record<string, unknown>;
  createdAt: string;
}

type Row = Record<string, unknown>;

/** Écrit un événement (table absente : ignoré, jamais une panne de la promotion elle-même… sauf refus déjà décidé). */
export async function recordPromotionEvent(e: {
  environment: string; kind: PromotionEventKind; candidateVersionId?: number | null; campaignId?: number | null; treatment?: string | null;
  allowed?: boolean | null; code?: string | null; message: string; reference?: Record<string, unknown>;
}): Promise<number | null> {
  try {
    const [r] = (await pgClient.unsafe(
      `INSERT INTO ai_promotion_events (environment, kind, candidate_version_id, campaign_id, treatment, allowed, code, message, reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id`,
      [e.environment, e.kind, e.candidateVersionId ?? null, e.campaignId ?? null, e.treatment ?? null, e.allowed ?? null, e.code ?? null,
        e.message.slice(0, 2000), JSON.stringify(e.reference ?? {})] as never[],
    )) as unknown as Row[];
    return Number(r.id);
  } catch (err) {
    console.error('[promotion-ia] journal :', (err as Error).message);
    return null;
  }
}

const toEvent = (r: Row): PromotionEvent => ({
  id: Number(r.id), environment: String(r.environment), kind: String(r.kind) as PromotionEventKind,
  candidateVersionId: r.candidate_version_id == null ? null : Number(r.candidate_version_id), campaignId: r.campaign_id == null ? null : Number(r.campaign_id),
  treatment: r.treatment == null ? null : String(r.treatment), allowed: r.allowed == null ? null : Boolean(r.allowed), code: r.code == null ? null : String(r.code),
  message: String(r.message ?? ''), reference: (r.reference ?? {}) as Record<string, unknown>, createdAt: new Date(String(r.created_at)).toISOString(),
});

/** Derniers événements (BO, diagnostic global). */
export async function listPromotionEvents(p: { environment: string; limit?: number; kinds?: PromotionEventKind[]; sinceMs?: number; query?: (t: string, params: unknown[]) => Promise<Row[]> }): Promise<PromotionEvent[]> {
  const query = p.query ?? (async (t: string, params: unknown[]) => (await pgClient.unsafe(t, params as never[])) as unknown as Row[]);
  try {
    const rows = await query(
      `SELECT * FROM ai_promotion_events WHERE environment = $1 AND ($2::text[] IS NULL OR kind = ANY($2::text[]))
          AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz) ORDER BY id DESC LIMIT $4`,
      [p.environment, p.kinds ?? null, p.sinceMs ? new Date(Date.now() - p.sinceMs).toISOString() : null, Math.min(500, p.limit ?? 50)],
    );
    return rows.map(toEvent);
  } catch {
    return [];
  }
}
