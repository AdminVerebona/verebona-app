/**
 * GET  /api/documents/title-coherence
 *   Analyse les titres des documents du compte et retourne les groupes incohérents.
 *   Réservé aux comptes premium.
 *
 * POST /api/documents/title-coherence
 *   Applique les suggestions de renommage sélectionnées.
 *   Body: { suggestions: { id: number; suggestedTitle: string }[] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { isPremiumPlan } from '@/types/domain';
import { titleCoherenceCheck, applyTitleCoherenceSuggestions } from '@/services/document-ai/title-coherence.service';

export async function GET(req: NextRequest) {
  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    if (!isPremiumPlan(session.planType ?? '')) {
      return apiError(403, 'PLAN_UPGRADE_REQUIRED', 'Cette fonctionnalité est réservée aux comptes premium');
    }

    const result = await titleCoherenceCheck({ accountId: session.currentAccountId });

    return NextResponse.json(result);
  } catch (error) {
    console.error('GET /api/documents/title-coherence error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}

export async function POST(req: NextRequest) {
  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    if (!isPremiumPlan(session.planType ?? '')) {
      return apiError(403, 'PLAN_UPGRADE_REQUIRED', 'Cette fonctionnalité est réservée aux comptes premium');
    }

    const body = await req.json().catch(() => ({}));
    const suggestions = body?.suggestions;

    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      return apiError(400, 'INVALID_INPUT', 'suggestions[] requis');
    }

    // Validate each suggestion
    const valid = suggestions.filter(
      (s: any) => typeof s.id === 'number' && typeof s.suggestedTitle === 'string' && s.suggestedTitle.trim()
    );

    if (valid.length === 0) return apiError(400, 'INVALID_INPUT', 'Aucune suggestion valide');

    const { applied } = await applyTitleCoherenceSuggestions({
      accountId: session.currentAccountId,
      suggestions: valid,
    });

    return NextResponse.json({ applied });
  } catch (error) {
    console.error('POST /api/documents/title-coherence error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
