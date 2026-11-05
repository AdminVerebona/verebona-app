/**
 * Lot 111I — cibles proposées aux sélecteurs multiples de rattachement
 * (tiroir « Modifier le document », ajout de document) : biens du compte actif
 * groupés avec leurs pièces et équipements. Lecture seule, bornée au compte.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { getSession } from '@/lib/auth-guards';
import { listTargetOptions, type TargetsExecutor } from '@/services/documents/document-targets/service';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session.currentAccountId) return NextResponse.json({ error: 'NO_ACCOUNT', message: 'Aucun compte sélectionné' }, { status: 400 });
    const groups = await listTargetOptions(db as unknown as TargetsExecutor, session.currentAccountId);
    return NextResponse.json({ groups });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('GET /api/document-targets/options error:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' }, { status: 500 });
  }
}
