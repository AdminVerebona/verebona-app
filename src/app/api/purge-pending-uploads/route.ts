import { NextResponse } from 'next/server';
import { purgePendingUploads } from '@/services/documents/pending-uploads-purge.service';
import { withJobLock } from '@/lib/job-lock';

/**
 * GET /api/cron/purge-pending-uploads
 *
 * Purge les lignes `asset_files` restées en `PENDING` plus de 24 h : des
 * téléversements préparés par `/api/files/presign` puis jamais confirmés
 * (onglet fermé, réseau coupé, refus CORS du bucket).
 *
 * Protégée par CRON_SECRET. Fréquence conseillée : une fois par jour.
 *
 * ⚠️ Le tour est pris sous verrou partagé : deux instances déclenchées en
 * même temps programmeraient deux fois la suppression des mêmes objets de
 * stockage.
 *
 * Cette route n'est pas le seul déclencheur : le planificateur interne lance
 * la même purge une fois par jour, ce qui la rend indépendante de la mise en
 * place d'un cron externe.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const resultat = await withJobLock('pending-uploads-purge-manual', 10 * 60 * 1000, () =>
      purgePendingUploads(),
    );

    if (resultat === null) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: 'Une purge est déjà en cours.',
      });
    }

    return NextResponse.json({ ok: true, ...resultat, checkedAt: new Date().toISOString() });
  } catch (error) {
    console.error('[cron/purge-pending-uploads] erreur:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
