/**
 * Accès à la sortie d'un modèle IA depuis le BO — lot 33D (ticket « rapports
 * d'échec IA diagnostiquables », §4 Sécurité).
 *
 * La sortie d'un modèle reprend le contenu des documents des utilisateurs :
 *   · réservée aux administrateurs (garde de la route) et, si la variable
 *     `AI_MODEL_OUTPUT_ADMIN_IDS` est renseignée, aux seuls identifiants
 *     qu'elle liste (absente : tous les administrateurs du BO) ;
 *   · chaque consultation — accordée ou refusée — est journalisée
 *     (`admin_audit_log`, action `AI_MODEL_OUTPUT_READ`) ;
 *   · jamais écrite dans les journaux serveur ; réponse `no-store`.
 * Rétention : celle des traces IA (`ai-call-diagnostics-purge`).
 */
import { pgClient } from '@/db';
import { readTraceModelOutputs, type ModelOutputView } from '../gateway/diagnostics/diagnostic.repository';

/** Pur : l'administrateur est-il autorisé ? Liste vide ou absente = tous les administrateurs. */
export function isModelOutputAccessAllowed(adminUserId: number, raw: string | undefined = process.env.AI_MODEL_OUTPUT_ADMIN_IDS): boolean {
  const ids = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length === 0 || ids.includes(String(adminUserId));
}

export type ModelOutputAccess =
  | { ok: true; callId: number; traceId: string; outputs: ModelOutputView[] }
  | { ok: false; code: 'FORBIDDEN' | 'NOT_FOUND'; message: string };

async function journal(adminUserId: number, callId: number, purpose: string, result: 'SUCCESS' | 'DENIED' | 'FAILURE', count: number): Promise<void> {
  await import('@/lib/admin-audit').then(({ logAdminAction }) => logAdminAction({
    adminId: adminUserId,
    action: 'AI_MODEL_OUTPUT_READ',
    targetType: 'AI_EXECUTION',
    targetId: callId,
    result,
    details: { purpose, outputs: count },
  })).catch((e: Error) => console.error('[ai-model-output] journal admin non écrit :', String(e.message).slice(0, 200)));
}

export async function readModelOutputsForAdmin(p: { adminUserId: number; callId: number; purpose: 'detail' | 'export' }): Promise<ModelOutputAccess> {
  if (!isModelOutputAccessAllowed(p.adminUserId)) {
    await journal(p.adminUserId, p.callId, p.purpose, 'DENIED', 0);
    return { ok: false, code: 'FORBIDDEN', message: 'Consultation des sorties modèle réservée (AI_MODEL_OUTPUT_ADMIN_IDS).' };
  }
  const rows = (await pgClient.unsafe(
    `SELECT metadata->>'traceId' AS trace_id FROM ai_usage_event WHERE id = $1 LIMIT 1`,
    [p.callId] as never[],
  )) as unknown as Array<{ trace_id: string | null }>;
  const traceId = rows[0]?.trace_id ?? null;
  if (!traceId) {
    await journal(p.adminUserId, p.callId, p.purpose, 'FAILURE', 0);
    return { ok: false, code: 'NOT_FOUND', message: 'Appel introuvable ou sans trace.' };
  }
  const outputs = (await readTraceModelOutputs(traceId)).filter((o) => o.raw !== null || o.extracted !== null || o.parsed !== null);
  await journal(p.adminUserId, p.callId, p.purpose, 'SUCCESS', outputs.length);
  return { ok: true, callId: p.callId, traceId, outputs };
}
