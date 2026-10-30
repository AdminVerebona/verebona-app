/**
 * Supervision du runtime Node.js — lot 100C (CVE-2026-111497).
 *
 * Appelé une fois au démarrage de chaque conteneur (`instrumentation-node`),
 * après les migrations : le runtime ne change pas sans nouveau conteneur.
 *   · runtime non corrigé (sous le seuil de sa majeure, majeure sans seuil
 *     connu, version illisible) → anomalie « Autres traitements techniques »
 *     ouverte ou consolidée (une occurrence par démarrage de conteneur) ;
 *   · runtime corrigé → résolution automatique de l'anomalie ouverte.
 * Un runtime corrigé mais hors de la plage déclarée (`warning`) n'ouvre pas
 * d'anomalie : il est visible dans la santé du runtime (BO › Exploitation).
 *
 * Ne lève jamais : la supervision n'empêche pas le démarrage.
 */
import { autoResolveAnomaly, buildFingerprint, reportAnomaly } from '@/services/admin/anomaly.service';
import type { NodeRuntimeStatus } from '@/lib/health/node-runtime';

export const NODE_RUNTIME_FINGERPRINT = buildFingerprint('other', 'node-runtime', 'unpatched');

export async function syncNodeRuntimeAnomaly(
  runtime: NodeRuntimeStatus & { execPath: string },
  container: string | null = (process.env.CONTAINER ?? '').trim() || null,
): Promise<'reported' | 'resolved' | 'none'> {
  try {
    if (runtime.status === 'error') {
      const id = await reportAnomaly({
        domain: 'other',
        fingerprint: NODE_RUNTIME_FINGERPRINT,
        title: `Runtime Node non corrigé en service (${runtime.node})`,
        detail: {
          cve: 'CVE-2026-111497',
          node: runtime.node,
          execPath: runtime.execPath,
          verdict: runtime.verdict,
          patchedThreshold: runtime.patchedThreshold,
          enginesRange: runtime.enginesRange,
          container,
          action: 'Redéploiement complet (pas un redémarrage) puis relecture de BO › Exploitation › Santé › Runtime Node.',
        },
      });
      return id === null ? 'none' : 'reported';
    }
    const resolved = await autoResolveAnomaly(NODE_RUNTIME_FINGERPRINT, {
      origin: 'node_runtime_startup_check',
      cause: `Runtime en service : ${runtime.node}${container ? ` (${container})` : ''}`,
    });
    return resolved ? 'resolved' : 'none';
  } catch (e) {
    console.error('[runtime] supervision du runtime Node impossible :', (e as Error).message);
    return 'none';
  }
}
