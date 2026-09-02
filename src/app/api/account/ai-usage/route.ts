/**
 * GET /api/account/ai-usage
 * Retourne les quotas IA pour l'affichage dans Mon compte > Abonnement
 * CDC §3 — uniquement "Nombre de biens" et "Documents analysés"
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { accounts, assets, accountMemberships } from '@/db/schema';
import { eq, and, isNull, ne, sql } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { getEntitlements } from '@/services/entitlements.service';
import { getAnalysisQuotaState } from '@/services/commercial-model.service';

/**
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ CETTE ROUTE REDÉFINISSAIT LES QUOTAS DANS SON COIN
 *
 * Elle portait sa propre table `ANALYSIS_QUOTAS`, lisait `SUBSCRIPTION_LIMITS`
 * par `accounts.plan_type` et allait chercher les compteurs à la main. Trois
 * conséquences visibles à l'écran :
 *
 *   · pendant un essai, elle annonçait le quota ANNUEL (50 documents) au lieu
 *     du quota d'essai (10) — `plan_type` vaut STANDARD pendant l'essai et ne
 *     dit rien de la période en cours ;
 *   · sur un compte restreint, elle affichait la limite de biens de Standard
 *     alors que les droits effectifs sont à zéro — d'où le « 3 / 2 » ;
 *   · le seuil de blocage affiché ne correspondait pas à celui qui refuse
 *     réellement l'action.
 *
 * Les deux chiffres viennent désormais des services qui font autorité :
 * `entitlements` pour les biens, `getAnalysisQuotaState` pour les analyses —
 * ce dernier choisit lui-même entre période d'essai et période annuelle.
 * ══════════════════════════════════════════════════════════════════════════
 */

export async function GET(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    const userId = session.userId;

    // Récupère le compte de l'utilisateur
    const membership = await db
      .select({ accountId: accountMemberships.accountId })
      .from(accountMemberships)
      .where(and(eq(accountMemberships.userId, userId), eq(accountMemberships.status, 'active')))
      .limit(1)
      .then(r => r[0]);

    const accountId = membership?.accountId ?? session.currentAccountId;
    if (!accountId) {
      return NextResponse.json({ error: 'Compte introuvable' }, { status: 404 });
    }

    const currentYear = new Date().getFullYear();

    // Plan du compte
    const account = await db
      .select({ planType: accounts.planType })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1)
      .then(r => r[0]);

    if (!account) {
      return NextResponse.json({ error: 'Compte introuvable' }, { status: 404 });
    }

    const [entitlements, analysisState] = await Promise.all([
      getEntitlements(accountId),
      getAnalysisQuotaState(accountId),
    ]);

    const assetsQuota = entitlements.quotas.maxAssets;
    const documentsAnalyzedQuota = analysisState.includedQuota;
    const trialDocumentsQuota = analysisState.periodType === 'trial' ? analysisState.includedQuota : 0;

    // Nombre de biens actifs (hors archivés/supprimés)
    const assetsCountResult = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(assets)
      .where(
        and(
          eq(assets.accountId, accountId),
          isNull(assets.deletedAt),
          ne(assets.status, 'ARCHIVED'),
          ne(assets.lockState, 'HARD'),
        )
      )
      .then(r => r[0]?.cnt ?? 0);

    // Consommation : lue au même endroit que le quota, pour que « x sur y »
    // décrive une seule et même période.
    const documentsAnalyzedCount = analysisState.includedConsumed;
    const trialDocumentsCount = analysisState.periodType === 'trial' ? analysisState.includedConsumed : 0;

    // `|| 1` : un quota nul (compte restreint) ferait une division par zéro,
    // donc un NaN qui traverse toute la réponse jusqu'à la barre de progression.
    const assetsPercent = Math.min(100, Math.round((assetsCountResult / (assetsQuota || 1)) * 100));
    const documentsPercent = Math.min(100, Math.round((documentsAnalyzedCount / (documentsAnalyzedQuota || 1)) * 100));

    const shouldShowUpgradeCta = assetsPercent >= 90 || documentsPercent >= 90;
    const isAnyQuotaBlocked = assetsCountResult >= assetsQuota || documentsAnalyzedCount >= documentsAnalyzedQuota;

    return NextResponse.json({
      accountId,
      periodYear: currentYear,
      assetsCount: assetsCountResult,
      assetsQuota,
      documentsAnalyzedCount,
      documentsAnalyzedQuota,
      trialDocumentsCount,
      trialDocumentsQuota,
      shouldShowUpgradeCta,
      isAnyQuotaBlocked,
      assetsPercent,
      documentsPercent,
    });
  } catch (error: any) {
    if (error?.message === 'AUTH_REQUIRED' || error?.message === 'INVALID_TOKEN') {
      return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });
    }
    console.error('[GET /api/account/ai-usage]', error);
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}
