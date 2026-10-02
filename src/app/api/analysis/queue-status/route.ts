/**
 * GET /api/analysis/queue-status — CDC BO IA E-06.
 *
 * État des analyses T1 du compte courant (en attente, en cours), en lecture
 * seule. Remplace, pour le bandeau d'analyse, l'appel à
 * `/api/analysis/check-pending` : ouvrir l'application ne déclenche plus
 * aucune analyse, la reprise est exclusivement serveur (analysis-recovery).
 *
 * Lit l'état persistant (fichiers et file durable T1, seule file depuis le
 * lot 16b).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { getT1QueueStatus } from '@/services/ai/source-analysis/queue/t1-status';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request);
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ mode: null, files: [] });
    return NextResponse.json(await getT1QueueStatus(accountId));
  } catch (error) {
    const msg = (error as Error).message;
    if (msg === 'AUTH_REQUIRED' || msg === 'INVALID_TOKEN' || msg === 'ACCOUNT_SUSPENDED') {
      return NextResponse.json({ mode: null, files: [] }, { status: 401 });
    }
    console.error('GET /api/analysis/queue-status :', msg);
    return NextResponse.json({ mode: null, files: [] }, { status: 500 });
  }
}
