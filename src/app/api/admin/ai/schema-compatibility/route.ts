/**
 * GET /api/admin/ai/schema-compatibility — lot 114 (carte #776, travail 10).
 *
 * BO › Exécutions IA › Schémas structurés : usage RÉEL du schéma imposé
 * (acceptations, refus HTTP 400, nouveaux essais sans schéma, appels restés
 * en mode JSON, requêtes fournisseur réelles, jetons, coût, latence), filtré
 * par période, opération, modèle et version du contrat ; matrice de
 * compatibilité mémorisée par couple ; projection courante de chaque contrat
 * (contrôle statique) ; alertes de compatibilité ouvertes. Compteurs, codes,
 * versions et empreintes seulement — jamais de contenu de document, de
 * prompt ni de schéma.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const q = new URL(req.url).searchParams;
  const rawDays = q.get('days');
  const days = rawDays && /^\d{1,2}$/.test(rawDays) ? Math.min(Math.max(Number(rawDays), 1), 90) : 7;
  const operationCode = /^[a-z0-9_]{1,80}$/.test(q.get('operation') ?? '') ? q.get('operation') : null;
  const model = /^[A-Za-z0-9._:\/-]{1,120}$/.test(q.get('model') ?? '') ? q.get('model') : null;
  const cv = q.get('contractVersion');
  const contractVersion = cv && /^\d{1,4}$/.test(cv) ? Number(cv) : null;
  try {
    const { getSchemaCompatOverview } = await import('@/services/ai/gateway/schema-compat/overview');
    return NextResponse.json(await getSchemaCompatOverview({ days, operationCode, model, contractVersion }));
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/schema-compatibility');
  }
}
