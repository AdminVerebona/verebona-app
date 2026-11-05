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
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ItemRecord } from '../render/render-dossier';
import { CANCELLED_STEP_LEASE_EXPIRED, REPLACED_BY_NEW_GENERATION } from './identity';

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
  // Lot 111B : une génération remplacée dont l'exécution s'est arrêtée sans
  // clore l'annulation (redémarrage, bail expiré) est close `cancelled` —
  // jamais reprise, jamais classée en échec.
  await finalizeAbandonedCancellations();
  await db.execute(sql`
    UPDATE export_generation
       SET status = 'failed', error_code = 'RENDER_ERROR', locked_by = NULL, locked_until = NULL,
           completed_at = NOW(),
           error_payload = ${JSON.stringify({ code: 'RENDER_ERROR', technicalMessage: 'exécution abandonnée à répétition (arrêt du processus)' })}
     WHERE status = 'generating' AND locked_until IS NOT NULL AND locked_until < NOW()
       AND generation_attempt_count >= ${MAX_ATTEMPTS}
       AND cancel_requested_at IS NULL
  `);
  await db.execute(sql`
    UPDATE export_generation
       SET status = 'failed', error_code = 'GENERATION_FAILED', completed_at = NOW(),
           error_payload = ${JSON.stringify({ code: 'GENERATION_FAILED', technicalMessage: 'exécution sans bail interrompue (arrêt du processus)' })}
     WHERE status = 'generating' AND locked_by IS NULL
       AND COALESCE(generation_started_at, created_at) < NOW() - make_interval(mins => ${UNLEASED_STALE_MINUTES})
       AND cancel_requested_at IS NULL
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
         AND g.cancel_requested_at IS NULL
         AND (
           (g.status = 'queued' AND (g.next_attempt_at IS NULL OR g.next_attempt_at <= NOW()))
           OR (g.status = 'generating' AND g.locked_until IS NOT NULL AND g.locked_until < NOW())
         )
         -- Lot 111B : une régénération attend l'arrêt EFFECTIF de la génération qu'elle remplace.
         AND NOT EXISTS (SELECT 1 FROM export_generation o
                          WHERE o.replaced_by_generation_id = g.id AND o.status = 'generating')
    ),
    pick AS (
      SELECT e.id
        FROM export_generation e
        JOIN candidates c ON c.id = e.id
       WHERE e.export_type <> 'EXPORT_BRUT'
         AND e.cancel_requested_at IS NULL
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

/**
 * Générations d'un compte en file ou en cours (plafond `MAX_ACTIVE_PER_ACCOUNT`).
 * Lot 111B : une génération remplacée (annulation demandée) ne compte plus.
 */
export async function countActiveGenerations(accountId: number): Promise<number> {
  const res = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM export_generation
     WHERE account_id = ${accountId} AND export_type <> 'EXPORT_BRUT' AND status IN ('queued', 'generating')
       AND cancel_requested_at IS NULL
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

/**
 * Mise à jour conditionnée au bail : une exécution dépossédée n'écrit plus rien.
 *
 * Lot 111B — préconditions transactionnelles renforcées (une seule
 * instruction UPDATE, évaluée sur la dernière version de la ligne) :
 *   · même worker (`locked_by`) ET bail encore valide (`locked_until`) ;
 *   · statut toujours actif (`generating`) ;
 *   · aucune annulation demandée (`cancel_requested_at IS NULL`).
 * Une génération remplacée ne peut donc JAMAIS être publiée (ready /
 * partial), remise en file ni classée en échec par une exécution tardive.
 */
export async function updateOwnedGeneration(id: number, workerId: string, values: Partial<typeof exportGenerations.$inferInsert>): Promise<boolean> {
  const rows = await db.update(exportGenerations).set(values)
    .where(and(
      eq(exportGenerations.id, id),
      eq(exportGenerations.lockedBy, workerId),
      eq(exportGenerations.status, 'generating'),
      isNull(exportGenerations.cancelRequestedAt),
      sql`${exportGenerations.lockedUntil} IS NOT NULL AND ${exportGenerations.lockedUntil} >= NOW()`,
    ))
    .returning({ id: exportGenerations.id });
  return rows.length > 0;
}

/**
 * Lot 111B : générations remplaçantes référencées par des lignes annulées
 * (historique « Annulé — Remplacé par la génération … »), par identifiant.
 * Même bien que la ligne remplacée (garanti à l'écriture) ; `assetId` borne
 * malgré tout la lecture au bien consulté.
 */
export async function loadReplacementRefs(rows: Array<{ replacedByGenerationId?: number | null }>, assetId: number): Promise<Map<number, { id: number; publicId: string; exportType: string; createdAt: Date }>> {
  const ids = [...new Set(rows.map((r) => r.replacedByGenerationId).filter((x): x is number => typeof x === 'number' && x > 0))];
  if (!ids.length) return new Map();
  const found = await db.select({ id: exportGenerations.id, publicId: exportGenerations.publicId, exportType: exportGenerations.exportType, createdAt: exportGenerations.createdAt })
    .from(exportGenerations).where(and(inArray(exportGenerations.id, ids), eq(exportGenerations.assetId, assetId)));
  return new Map(found.map((r) => [r.id, r]));
}

/** Lot 111B : une annulation a-t-elle été demandée pour cette génération ? (lecture par clé primaire) */
export async function isGenerationCancelRequested(id: number): Promise<boolean> {
  const res = await db.execute(sql`SELECT cancel_requested_at IS NOT NULL AS c FROM export_generation WHERE id = ${id}`);
  const r = rowsOf(res)[0];
  // Ligne disparue (bien supprimé) : rien à publier non plus.
  return !r || r.c === true || r.c === 't';
}

/**
 * Lot 111B : clôt l'annulation observée par l'exécution qui détient la
 * génération — statut terminal `cancelled`, étape atteinte, bail libéré.
 * Conditionné au worker et à la demande d'annulation (sans effet sinon).
 */
export async function markGenerationCancelled(id: number, workerId: string, step: string): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE export_generation
       SET status = 'cancelled', cancelled_at = NOW(), completed_at = NOW(), cancelled_step = ${step},
           locked_by = NULL, locked_until = NULL, next_attempt_at = NULL
     WHERE id = ${id} AND locked_by = ${workerId} AND status = 'generating' AND cancel_requested_at IS NOT NULL
    RETURNING id
  `);
  const done = rowsOf(res).length > 0;
  if (done) {
    await addGenerationLog(id, {
      level: 'info', step, code: REPLACED_BY_NEW_GENERATION,
      message: 'Génération arrêtée : remplacée par une nouvelle génération (annulation volontaire).',
      details: { workerId },
    });
  }
  return done;
}

/**
 * Lot 111B : générations remplacées encore `generating` dont plus personne ne
 * tient le bail (processus arrêté, redémarrage) → `cancelled`. Les objets
 * éventuellement envoyés par l'exécution interrompue restent sous le préfixe
 * de la génération (`exports/…/{id}/a{n}/`), purgé avec le bien / le compte.
 */
export async function finalizeAbandonedCancellations(): Promise<number> {
  const res = await db.execute(sql`
    UPDATE export_generation
       SET status = 'cancelled', cancelled_at = NOW(), completed_at = NOW(),
           cancelled_step = ${CANCELLED_STEP_LEASE_EXPIRED}, locked_by = NULL, locked_until = NULL, next_attempt_at = NULL
     WHERE status = 'generating' AND cancel_requested_at IS NOT NULL
       AND (locked_until IS NULL OR locked_until < NOW())
    RETURNING id
  `);
  const ids = rowsOf(res).map((r) => Number(r.id));
  for (const id of ids) {
    await addGenerationLog(id, {
      level: 'info', step: CANCELLED_STEP_LEASE_EXPIRED, code: REPLACED_BY_NEW_GENERATION,
      message: 'Génération remplacée close après l’arrêt de son exécution (bail expiré).',
    });
  }
  return ids.length;
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
