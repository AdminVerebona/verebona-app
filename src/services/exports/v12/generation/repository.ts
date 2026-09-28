/**
 * Accès base des générations V12 : file d'exécution durable sur la table
 * `export_generation` elle-même (migration 0212).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI PAS LA FILE `ai_job_queue`
 *
 * La file durable existante (`services/ai/queue`) est celle des TRAITEMENTS
 * IA : ses travaux sont typés T1/T3/T4 (contrainte CHECK de 0132), soumis au
 * disjoncteur, à l'arrêt d'urgence IA, aux quotas et au versionnement de
 * configuration du BO IA, et comptés dans ses métriques. Y inscrire la
 * génération de dossiers aurait (1) arrêté les exports à chaque arrêt
 * d'urgence IA, (2) mélangé leurs échecs à ceux des fournisseurs IA dans la
 * supervision, (3) imposé une migration du CHECK et du référentiel T1-T6.
 *
 * La ligne `export_generation` est donc elle-même le travail : statut
 * `queued`, prise atomique `FOR UPDATE SKIP LOCKED`, bail renouvelé
 * (`locked_until`), reprise après arrêt brutal, nouvelle tentative différée
 * (`next_attempt_at`) pour les erreurs transitoires — les mêmes garanties
 * que la file IA, sans ses dépendances.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { db } from '@/db';
import { exportGenerations, exportGenerationItems, exportGenerationLogs } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import type { ItemRecord } from '../render/render-dossier';

export type GenerationRow = typeof exportGenerations.$inferSelect;

export const LEASE_SECONDS = 120;
export const MAX_ATTEMPTS = 3;

const rowsOf = (r: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(r) ? r : ((r as { rows?: unknown[] })?.rows ?? [])) as Array<Record<string, unknown>>;

/** Générations en file ou en cours autorisées par compte (au-delà : 429). */
export const MAX_ACTIVE_PER_ACCOUNT = 3;

/** Délai au-delà duquel une exécution SANS bail (EXPORT_BRUT synchrone, ancien moteur) est réputée interrompue. */
const UNLEASED_STALE_MINUTES = 30;

/**
 * Prend la prochaine génération à faire (ou une génération abandonnée dont
 * le bail a expiré). Les abandons au-delà de `MAX_ATTEMPTS` sont d'abord
 * clos en échec : un dossier qui fait tomber le processus ne boucle pas.
 *
 * Prise ÉQUITABLE entre comptes (round-robin) : chaque candidate reçoit un
 * tour = son rang dans la file de son compte + le nombre de générations du
 * compte déjà en cours ; on prend le plus petit tour, puis la plus ancienne.
 * Un compte qui empile des demandes ne passe donc qu'une fois par tour, après
 * la plus ancienne demande de chacun des autres comptes.
 */
export async function claimNextGeneration(workerId: string): Promise<GenerationRow | null> {
  await db.execute(sql`
    UPDATE export_generation
       SET status = 'failed', error_code = 'RENDER_ERROR', locked_by = NULL, locked_until = NULL,
           completed_at = NOW(),
           error_payload = ${JSON.stringify({ code: 'RENDER_ERROR', technicalMessage: 'exécution abandonnée à répétition (arrêt du processus)' })}
     WHERE status = 'generating' AND locked_until IS NOT NULL AND locked_until < NOW()
       AND generation_attempt_count >= ${MAX_ATTEMPTS}
  `);
  await db.execute(sql`
    UPDATE export_generation
       SET status = 'failed', error_code = 'GENERATION_FAILED', completed_at = NOW(),
           error_payload = ${JSON.stringify({ code: 'GENERATION_FAILED', technicalMessage: 'exécution sans bail interrompue (arrêt du processus)' })}
     WHERE status = 'generating' AND locked_by IS NULL
       AND COALESCE(generation_started_at, created_at) < NOW() - make_interval(mins => ${UNLEASED_STALE_MINUTES})
  `);
  // Les conditions de prise sont répétées sur la ligne verrouillée (`e`) :
  // PostgreSQL les réévalue sur sa dernière version après attente du verrou,
  // si bien qu'une ligne prise entre-temps par une autre instance est écartée.
  const res = await db.execute(sql`
    WITH candidates AS (
      SELECT g.id, g.created_at,
             ROW_NUMBER() OVER (PARTITION BY g.account_id ORDER BY g.created_at, g.id)
               + COALESCE((SELECT COUNT(*) FROM export_generation r
                            WHERE r.account_id = g.account_id AND r.status = 'generating'
                              AND r.locked_until IS NOT NULL AND r.locked_until >= NOW()), 0) AS turn
        FROM export_generation g
       WHERE g.export_type <> 'EXPORT_BRUT'
         AND (
           (g.status = 'queued' AND (g.next_attempt_at IS NULL OR g.next_attempt_at <= NOW()))
           OR (g.status = 'generating' AND g.locked_until IS NOT NULL AND g.locked_until < NOW())
         )
    ),
    pick AS (
      SELECT e.id
        FROM export_generation e
        JOIN candidates c ON c.id = e.id
       WHERE e.export_type <> 'EXPORT_BRUT'
         AND (
           (e.status = 'queued' AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= NOW()))
           OR (e.status = 'generating' AND e.locked_until IS NOT NULL AND e.locked_until < NOW())
         )
       ORDER BY c.turn, c.created_at, c.id
       LIMIT 1
       FOR UPDATE OF e SKIP LOCKED
    )
    UPDATE export_generation
       SET status = 'generating',
           locked_by = ${workerId},
           locked_until = NOW() + make_interval(secs => ${LEASE_SECONDS}),
           generation_started_at = NOW(),
           generation_attempt_count = generation_attempt_count + 1,
           next_attempt_at = NULL
     WHERE id = (SELECT id FROM pick)
    RETURNING id
  `);
  const id = Number(rowsOf(res)[0]?.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  const [row] = await db.select().from(exportGenerations).where(eq(exportGenerations.id, id)).limit(1);
  return row ?? null;
}

/** Générations d'un compte en file ou en cours (plafond `MAX_ACTIVE_PER_ACCOUNT`). */
export async function countActiveGenerations(accountId: number): Promise<number> {
  const res = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM export_generation
     WHERE account_id = ${accountId} AND export_type <> 'EXPORT_BRUT' AND status IN ('queued', 'generating')
  `);
  return Number(rowsOf(res)[0]?.n ?? 0);
}

/** Renouvelle le bail ; `false` si la génération a été reprise par une autre instance. */
export async function renewGenerationLease(id: number, workerId: string): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE export_generation SET locked_until = NOW() + make_interval(secs => ${LEASE_SECONDS})
     WHERE id = ${id} AND locked_by = ${workerId} AND status = 'generating'
    RETURNING id
  `);
  return rowsOf(res).length > 0;
}

/** Mise à jour conditionnée au bail : une exécution dépossédée n'écrit plus rien. */
export async function updateOwnedGeneration(id: number, workerId: string, values: Partial<typeof exportGenerations.$inferInsert>): Promise<boolean> {
  const rows = await db.update(exportGenerations).set(values)
    .where(and(eq(exportGenerations.id, id), eq(exportGenerations.lockedBy, workerId)))
    .returning({ id: exportGenerations.id });
  return rows.length > 0;
}

export async function addGenerationLog(generationId: number, entry: {
  level: 'debug' | 'info' | 'warn' | 'error'; step?: string | null; code?: string | null; message: string; details?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await db.insert(exportGenerationLogs).values({
      generationId,
      level: entry.level,
      step: entry.step ?? null,
      code: entry.code ?? null,
      message: entry.message.slice(0, 2000),
      detailsJson: entry.details ?? null,
      createdAt: new Date(),
    });
  } catch (e) {
    // Un journal indisponible ne fait pas échouer une génération.
    console.error(`[exports-v12] journal de la génération ${generationId} indisponible :`, (e as Error).message);
  }
}

/** Remplace la traçabilité des éléments (une génération relancée repart de zéro). */
export async function replaceGenerationItems(generationId: number, items: ItemRecord[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(exportGenerationItems).where(eq(exportGenerationItems.generationId, generationId));
    const now = new Date();
    for (let i = 0; i < items.length; i += 200) {
      const chunk = items.slice(i, i + 200);
      if (!chunk.length) continue;
      await tx.insert(exportGenerationItems).values(chunk.map((it) => ({
        generationId,
        sourceType: it.sourceType,
        sourceId: it.sourceId,
        label: it.label.slice(0, 300),
        mode: it.mode,
        status: it.status,
        reason: it.reason,
        createdAt: now,
      })));
    }
  });
}
