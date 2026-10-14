import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { detectCrossAccountRelations, readOnlyDetectionExecutor } from '@/services/security/cross-account/detection';
import { inventoryRemediation, readRemediationJournal } from '@/services/security/cross-account/remediation';
import { readIsolationHistory, recordIsolationCheck } from '@/services/security/cross-account/alerts';
import { guardAdmin, NO_STORE, opsError } from '../_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/ops/cross-account — contrôle « Relations intercomptes »
 * (lot 49, ticket SEC-P0 §5) pour BO › Exploitation : nombre par type,
 * comptes concernés, identifiants techniques. LECTURE SEULE (transaction
 * READ ONLY). Administrateur seulement.
 *
 * Lot 53 (retour PO D23) : `inventory` — par catégorie, relations
 * corrigeables, relevant du Duo (signalées, jamais corrigées) et
 * indécidables ; `journal` — dernières corrections appliquées depuis
 * Rattrapages (preuve, restauration). La correction elle-même passe par
 * `/api/admin/ops/backfills` (script `cross-account`).
 *
 * Lot 54 (SEC-07/08, « Isolation des comptes ») : `status` (Conforme /
 * Anomalies détectées / Contrôle incomplet), `history` (dernières
 * exécutions, dernier contrôle complet, dernier contrôle conforme) ; chaque
 * lecture est historisée (`trigger = bo`) sans toucher aux alertes. Le
 * lancement manuel du contrôle complet (alertes comprises) passe par la tâche
 * `cross-account-relations-check` (`/api/admin/ops/scheduled-tasks/…/run`).
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    const startedAt = new Date().toISOString();
    const rapport = await detectCrossAccountRelations();
    await recordIsolationCheck({
      startedAt, trigger: 'bo', status: rapport.status, total: rapport.total, checksTotal: rapport.checks.length,
      checksFailed: rapport.checksFailed, counts: Object.fromEntries(rapport.checks.map((c) => [c.code, c.count])),
      errors: Object.fromEntries(rapport.checks.filter((c) => c.error).map((c) => [c.code, c.error as string])),
      accountIds: rapport.accountIds, reported: 0, resolved: 0,
    });
    const { inventory, journal } = await readOnlyDetectionExecutor(async (q) => ({
      inventory: await inventoryRemediation(q),
      journal: await (async () => {
        try {
          await q('SAVEPOINT cross_account_journal');
          const j = await readRemediationJournal(q);
          await q('RELEASE SAVEPOINT cross_account_journal');
          return j;
        } catch {
          // Migration 0345 absente : journal indisponible, le contrôle reste lisible.
          await q('ROLLBACK TO SAVEPOINT cross_account_journal').catch(() => undefined);
          return null;
        }
      })(),
    }));
    const history = await readIsolationHistory();
    return NextResponse.json({ ...rapport, inventory, journal, history }, { headers: NO_STORE });
  } catch (e) {
    return opsError(e, 'isolation des comptes', 'OPS_CROSS_ACCOUNT_FAILED');
  }
}
