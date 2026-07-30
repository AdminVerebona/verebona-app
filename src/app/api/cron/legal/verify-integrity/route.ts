/**
 * GET /api/cron/legal/verify-integrity — CDC 7 §16.2 et scénario R09.
 *
 * Contrôle périodique : le fichier servi correspond-il toujours à son
 * empreinte ? Fréquence recommandée : hebdomadaire.
 *
 * Répond 200 quand tout concorde, 409 dès qu'un écart existe — pour que la
 * supervision le voie sans avoir à lire le corps de la réponse. Ne répare
 * rien : le R09 exige que « la version ne soit pas remplacée automatiquement
 * par une autre ».
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import { verifyIntegrity } from '@/services/legal';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();
  const report = await verifyIntegrity();

  return NextResponse.json(report, { status: report.issues.length === 0 ? 200 : 409 });
}
