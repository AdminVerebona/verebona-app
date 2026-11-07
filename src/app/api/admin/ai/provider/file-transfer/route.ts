/**
 * /api/admin/ai/provider/file-transfer — lot 113R (carte #717).
 *
 *   GET  : configuration EFFECTIVE de l'envoi de fichiers (source de la clé
 *          par NOM, jamais sa valeur), dernières vérifications conservées,
 *          documents en attente technique pour un incident d'envoi, alerte
 *          ouverte.
 *   POST : « Tester l'envoi d'un fichier au fournisseur » — petit PDF de test
 *          (aucune donnée utilisateur) envoyé par le chemin de l'analyse, avec
 *          la clé active, puis supprimé ; réponse du fournisseur conservée et
 *          rendue sans secret (statut, code, message, raison, détails,
 *          identifiant de requête). Un test réussi déclenche le réexamen des
 *          documents en attente (rétablissement vérifié) ; un test en échec
 *          ne libère rien.
 *
 * Aucune génération : aucun coût de modèle. Garde administrateur.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const [{ effectiveTransferConfig, listTransferChecks, transferCheckRetentionDays }, { transferBlockedStock, TRANSFER_ALERT_CODE, transferProbeMinIntervalMs }, { listAlerts }] = await Promise.all([
      import('@/services/ai/transfer/transfer-probe'),
      import('@/services/ai/transfer/transfer-recovery'),
      import('@/services/ai/alerts/alerts.repository'),
    ]);
    const [config, checks, stock, alerts] = await Promise.all([
      effectiveTransferConfig(), listTransferChecks(10), transferBlockedStock(50),
      listAlerts({ status: 'open', codes: [TRANSFER_ALERT_CODE], limit: 5 }).catch(() => []),
    ]);
    return NextResponse.json({
      config, checks, stock, alert: alerts[0] ?? null,
      policy: { probeMinIntervalMinutes: Math.round(transferProbeMinIntervalMs() / 60_000), checkRetentionDays: transferCheckRetentionDays() },
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/provider/file-transfer');
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const { runTransferProbe } = await import('@/services/ai/transfer/transfer-probe');
    const check = await runTransferProbe({ origin: 'admin_test', adminUserId: guard.ctx.adminUserId });
    let reexamination: unknown = null;
    if (check.ok) {
      // Sous le bail de la reprise serveur (une seule à la fois) ; bail déjà
      // pris : le prochain tour réutilisera cette vérification réussie.
      const [{ reexamineTransferBlocked }, { withJobLock }] = await Promise.all([
        import('@/services/ai/transfer/transfer-recovery'), import('@/lib/job-lock'),
      ]);
      reexamination = await withJobLock('analysis-recovery', 15 * 60_000, () => reexamineTransferBlocked())
        ?? { skipped: 'recovery_running' };
    }
    return NextResponse.json({ check, reexamination });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/provider/file-transfer');
  }
}
