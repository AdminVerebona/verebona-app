/**
 * Export RGPD « Mes données » — CDC Back-Office V1 GDP-020 à GDP-022.
 *
 * GET  /api/users/me/gdpr-export — état du dernier export de l'utilisateur.
 * POST /api/users/me/gdpr-export — demande un export.
 *
 * GDP-021 « générer immédiatement lorsque possible ; sinon traitement
 * asynchrone avec notification » : la génération démarre dans la requête et
 * dispose d'un court budget. Terminée à temps → 200 avec l'état prêt. Sinon
 * → 202 ; elle se poursuit après la réponse (`after`) et l'utilisateur est
 * notifié (GDPR_EXPORT_READY) quand l'archive est prête.
 *
 * Distinct des exports fonctionnels des biens (`/api/assets/[id]/exports`).
 */
import { NextRequest, NextResponse, after } from 'next/server';
import { SessionService } from '@/lib/session-service';
import {
  getLatestExport,
  markNotifyOnReady,
  purgeExpiredExports,
  requestGdprExport,
  runGdprExport,
  type GdprExportState,
} from '@/services/gdpr/gdpr-export.service';

const DOWNLOAD_PATH = '/api/users/me/gdpr-export/download';

function immediateBudgetMs(): number {
  const v = Number(process.env.GDPR_EXPORT_IMMEDIATE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 8000;
}

function body(exp: GdprExportState | null) {
  return {
    export: exp,
    downloadUrl: exp?.status === 'ready' ? DOWNLOAD_PATH : null,
  };
}

export async function GET(request: NextRequest) {
  let userId: number;
  try {
    userId = (await SessionService.getSession(request)).userId;
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
  try {
    return NextResponse.json(body(await getLatestExport(userId)), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[users/me/gdpr-export] lecture :', error);
    return NextResponse.json(
      { error: 'GDPR_EXPORT_READ_FAILED', message: 'Impossible de lire l’état de votre export. Réessayez.' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  let userId: number;
  try {
    userId = (await SessionService.getSession(request)).userId;
  } catch (error) {
    return SessionService.handleSessionError(error);
  }

  try {
    const { export: exp, created } = await requestGdprExport(userId);
    // Génération déjà en cours (double clic) : on renvoie son état.
    if (!created) return NextResponse.json(body(exp), { status: 202 });

    const run = runGdprExport(exp.id);
    const timeout = new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), immediateBudgetMs()));
    const first = await Promise.race([run, timeout]);

    if (first !== 'pending') {
      after(() => purgeExpiredExports({ limit: 20 }).catch(() => 0));
      return NextResponse.json(body(first ?? exp), { status: 200 });
    }

    // Asynchrone : la génération continue après la réponse, puis notifie.
    await markNotifyOnReady(exp.id);
    after(async () => {
      await run.catch(() => null);
      await purgeExpiredExports({ limit: 20 }).catch(() => 0);
    });
    return NextResponse.json(body({ ...exp, status: 'generating' }), { status: 202 });
  } catch (error) {
    console.error('[users/me/gdpr-export] demande :', error);
    return NextResponse.json(
      { error: 'GDPR_EXPORT_REQUEST_FAILED', message: 'Votre demande d’export n’a pas pu être enregistrée. Réessayez.' },
      { status: 500 },
    );
  }
}
