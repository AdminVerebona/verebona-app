/**
 * POST /api/verebona/commands/[planId]/confirm — confirmation explicite d'une
 * commande préparée par l'assistant, puis exécution.
 *
 * Le corps ne porte AUCUN paramètre : seule l'action préparée, figée et
 * présentée à l'utilisateur est exécutée. Les contrôles (propriétaire,
 * expiration, empreinte, droits d'écriture à l'instant de la confirmation)
 * vivent dans `plan.service`. L'exécution passe par les services métier de
 * l'interface classique.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { confirmCommandPlan } from '@/services/verebona-assistant/commands/plan.service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ planId: string }> },
) {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });

  await ensureMigrations();
  const { planId } = await params;
  const r = await confirmCommandPlan({ planId, accountId, userId: session.userId });
  if (!r.ok) {
    const status = r.code === 'PLAN_NOT_FOUND' ? 404 : r.code === 'WRITE_REFUSED' ? 403 : 409;
    return NextResponse.json({ error: { code: r.code, message: r.message, recoverable: r.code !== 'WRITE_REFUSED' }, status: r.status ?? null }, { status });
  }
  return NextResponse.json({ planId, status: r.status, summary: r.summary, results: r.results });
}
