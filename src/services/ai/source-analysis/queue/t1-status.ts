/**
 * État des analyses T1 d'un compte, en LECTURE SEULE — CDC BO IA E-06, T1-024.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CE MODULE REMPLACE
 *
 * Au montage de l'application, le bandeau d'analyse appelait
 * `/api/analysis/check-pending`, qui RELANÇAIT les analyses en attente : la
 * reprise T1 dépendait de l'ouverture d'une session dans un navigateur. Le
 * E-06 l'exclut — « le recovery T1 fonctionnel doit être exclusivement
 * serveur/worker/queue ». La reprise est faite par `analysis-recovery`
 * (planificateur serveur et passage planifié T1) ; le bandeau, lui, ne fait
 * plus que LIRE l'état, ici.
 *
 * Deux sources, toutes deux PERSISTANTES (file durable seule depuis le lot
 * 16b) — l'état survit donc à un redémarrage et le polling du bandeau
 * continue de fonctionner :
 *   · l'état du fichier (`asset_files.analysis_state`) ;
 *   · la file durable (`ai_job_queue`) : un job T1 vivant fait foi, et donne
 *     l'heure de la prochaine tentative (backoff, report quota).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';

type Row = Record<string, unknown>;

export interface T1FileStatus {
  fileId: number;
  /** `queued` : en attente de son tour ; `analyzing` : en cours. */
  state: 'queued' | 'analyzing';
  /** File durable : prochaine tentative prévue (backoff, report). */
  nextAttemptAt: string | null;
}

export interface T1QueueStatus {
  /** Toujours `durable` (lot 16b) ; conservé pour les clients qui le lisent. */
  mode: 'durable';
  files: T1FileStatus[];
}

/** Borne de lecture : le bandeau n'affiche qu'un compteur. */
const LIMIT = 200;

export async function getT1QueueStatus(accountId: number): Promise<T1QueueStatus> {
  const mode: T1QueueStatus['mode'] = 'durable';

  const fichiers = await pgClient.unsafe(
    `SELECT id, analysis_state FROM asset_files
      WHERE account_id = $1 AND deleted_at IS NULL
        AND analysis_state IN ('UPLOADED', 'ANALYZING')
      ORDER BY id
      LIMIT $2`,
    [accountId, LIMIT] as never[],
  );

  const parFichier = new Map<number, T1FileStatus>();
  for (const r of fichiers as unknown as Row[]) {
    const fileId = Number(r.id);
    parFichier.set(fileId, {
      fileId,
      state: r.analysis_state === 'ANALYZING' ? 'analyzing' : 'queued',
      nextAttemptAt: null,
    });
  }

  // Illisible (migration absente…) : l'état des fichiers suffit.
  try {
    const jobs = await pgClient.unsafe(
      `SELECT target_id, status, available_at FROM ai_job_queue
        WHERE treatment = 'T1' AND account_id = $1 AND target_type = 'asset_file'
          AND status IN ('PENDING', 'RUNNING')
        ORDER BY created_at
        LIMIT $2`,
      [accountId, LIMIT] as never[],
    );
    for (const j of jobs as unknown as Row[]) {
      const fileId = Number(j.target_id);
      if (!Number.isInteger(fileId)) continue;
      parFichier.set(fileId, {
        fileId,
        state: j.status === 'RUNNING' ? 'analyzing' : 'queued',
        nextAttemptAt: j.status === 'PENDING' && j.available_at
          ? new Date(String(j.available_at)).toISOString()
          : null,
      });
    }
  } catch (e) {
    console.warn('[t1-status] file durable illisible :', (e as Error).message);
  }

  return { mode, files: [...parFichier.values()] };
}
