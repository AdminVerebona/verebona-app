/**
 * GET /api/admin/ai/reconciliation-shadow
 *
 * Rapport du mode observation — CDC §10.2 : « les décisions ne sont pas
 * appliquées, elles sont comparées au comportement actuel, les écarts sont
 * mesurés ».
 *
 * C'est la sortie attendue des trois semaines d'observation qui précèdent la
 * bascule de `AI_RECONCILIATION_ENGINE`. Sans elle, l'observation produit des
 * milliers de lignes en base que personne n'ouvre, et la bascule se décide
 * quand même à l'aveugle.
 *
 * Paramètres :
 *   ?days=21        fenêtre d'observation (défaut : les trois semaines du §10.2)
 *   ?accountId=123  restreint à un compte ; absent = tous
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { requireAdmin } from '@/lib/auth-guards';
import { ensureMigrations } from '@/db';
import { getShadowReport } from '@/services/ai/reconciliation/shadow-report.service';
import { getFlagMode } from '@/services/ai/flags/ai-feature-flags';

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  await ensureMigrations();

  const url = new URL(req.url);
  const days = Number(url.searchParams.get('days') ?? '21');
  const accountId = Number(url.searchParams.get('accountId') ?? '0');

  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    return NextResponse.json({ error: 'INVALID_WINDOW' }, { status: 400 });
  }

  const mode = getFlagMode('AI_RECONCILIATION_ENGINE');

  try {
    const report = await getShadowReport({
      sinceDays: days,
      accountId: accountId > 0 ? accountId : undefined,
    });

    return NextResponse.json({
      flagMode: mode,
      // Un rapport lu alors que le moteur est déjà basculé décrit le passé, pas
      // une décision à prendre. Le dire explicitement évite un contresens.
      observationActive: mode === 'shadow',
      ...report,
    });
  } catch (e) {
    // Table absente : les migrations 0105 ne sont pas appliquées. Ce n'est pas
    // une erreur serveur, c'est un état de déploiement — il doit se lire.
    const err = e as { code?: string; message?: string };
    if (err.code === '42P01') {
      return NextResponse.json(
        { error: 'RECONCILIATION_TABLES_MISSING', message: 'Migration 0105 non appliquée.' },
        { status: 409 },
      );
    }
    console.error('GET /api/admin/ai/reconciliation-shadow error:', e);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
