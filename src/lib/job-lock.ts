/**
 * Verrou de tâche planifiée, à bail daté.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS PROPRIÉTÉS, ET POURQUOI CHACUNE COMPTE
 *
 * PARTAGÉ. Le verrou vit en base, pas en mémoire : deux instances derrière
 * un répartiteur de charge ne peuvent pas travailler en même temps. Un
 * booléen de module ne protège qu'un processus, et laissait donc chaque
 * instance relancer les mêmes documents.
 *
 * AUTO-LIBÉRÉ. Le bail porte une date de fin. Un processus tué au milieu
 * d'un tour ne bloque rien : le bail expire et le travail reprend. Un verrou
 * booléen resté à `true` après un crash aurait bloqué jusqu'au redémarrage.
 *
 * ATOMIQUE. L'acquisition est un seul `INSERT … ON CONFLICT DO UPDATE …
 * WHERE`, donc une seule instruction. Lire puis écrire laisserait la place à
 * deux processus qui lisent « libre » au même instant.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import { sql } from 'drizzle-orm';
import { hostname } from 'os';
import { randomUUID } from 'crypto';

/** Identité du détenteur — journalisée, jamais utilisée pour décider. */
const OWNER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

export interface JobLockHandle {
  name: string;
  owner: string;
}

/**
 * Tente de prendre le bail. Rend `null` si un autre processus le détient
 * encore — l'appelant doit alors passer son tour, sans erreur ni attente.
 *
 * `ttlMs` doit majorer largement la durée d'un tour : un bail trop court
 * serait repris par une autre instance pendant que le travail continue.
 */
export async function acquireJobLock(
  name: string,
  ttlMs: number,
): Promise<JobLockHandle | null> {
  const until = new Date(Date.now() + ttlMs);
  try {
    const rows = await db.execute(sql`
      INSERT INTO job_locks (name, locked_until, locked_by, updated_at)
      VALUES (${name}, ${until}, ${OWNER}, NOW())
      ON CONFLICT (name) DO UPDATE
        SET locked_until = EXCLUDED.locked_until,
            locked_by    = EXCLUDED.locked_by,
            updated_at   = NOW()
        WHERE job_locks.locked_until < NOW()
      RETURNING name
    `);
    const pris = Array.isArray(rows) ? rows.length > 0 : Number((rows as { count?: number })?.count ?? 0) > 0;
    return pris ? { name, owner: OWNER } : null;
  } catch (err) {
    // Table absente (migration pas encore passée) ou base indisponible : on
    // ne prend pas le verrou. Refuser de travailler est le comportement sûr —
    // travailler sans verrou reviendrait à ne pas en avoir.
    console.error(`[job-lock] acquisition impossible (${name}) :`, err);
    return null;
  }
}

/** Rend le bail. Sans effet si un autre processus l'a repris entre-temps. */
export async function releaseJobLock(handle: JobLockHandle): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE job_locks
         SET locked_until = NOW(), updated_at = NOW()
       WHERE name = ${handle.name} AND locked_by = ${handle.owner}
    `);
  } catch (err) {
    // Le bail expirera de lui-même : un échec ici ne bloque personne.
    console.error(`[job-lock] libération impossible (${handle.name}) :`, err);
  }
}

/**
 * Exécute `travail` sous verrou. Rend `null` si le verrou n'a pas pu être
 * pris — c'est un cas normal, pas une erreur.
 */
export async function withJobLock<T>(
  name: string,
  ttlMs: number,
  travail: () => Promise<T>,
): Promise<T | null> {
  const handle = await acquireJobLock(name, ttlMs);
  if (!handle) return null;
  try {
    return await travail();
  } finally {
    await releaseJobLock(handle);
  }
}
