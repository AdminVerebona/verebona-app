/**
 * BO › fiche Compte — opposition à l'utilisation des données pour
 * l'amélioration (lot 102D). Consultation seule : état, journal de preuve
 * (auteur, canal, libellé affiché, empreinte, date) et nombre total de
 * comptes opposés. Le BO ne modifie pas le choix de l'utilisateur.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import {
  countImprovementOptOuts, getImprovementPreference, listImprovementEvents,
} from '@/services/privacy/improvement-opt-out';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const { id } = await params;
  const accountId = Number(id);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    return NextResponse.json({ code: 'INVALID_ACCOUNT_ID', message: 'Compte invalide.' }, { status: 400 });
  }
  try {
    const [preference, events, totalOptedOut] = await Promise.all([
      getImprovementPreference(accountId), listImprovementEvents(accountId, 50), countImprovementOptOuts(),
    ]);
    return NextResponse.json({ preference, events, totalOptedOut });
  } catch (error) {
    console.error('[admin/accounts/data-use] GET :', (error as Error)?.message ?? error);
    return NextResponse.json({ code: 'DATA_USE_LOAD_FAILED', message: 'Impossible de charger ce réglage.' }, { status: 500 });
  }
}
