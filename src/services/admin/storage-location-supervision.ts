/**
 * Supervision de la localisation du stockage documentaire — lot 102C.
 *
 * Appelé au démarrage (après les migrations) et à chaque balayage de
 * Supervision (tâche quotidienne `daily-supervision-sweep` et ouverture de
 * l'écran) :
 *   · région hors liste autorisée → anomalie « Autres traitements
 *     techniques » ouverte ou consolidée ;
 *   · région autorisée (ou stockage non configuré) → résolution automatique.
 * Ne lève jamais. Détail sans secret (région, hôte, motifs).
 */
import { autoResolveAnomaly, buildFingerprint, reportAnomaly } from '@/services/admin/anomaly.service';
import { evaluateStorageLocation, type StorageLocationStatus } from '@/lib/storage-location';

export const STORAGE_LOCATION_FINGERPRINT = buildFingerprint('other', 'storage-location', 'not-allowed');

export async function syncStorageLocationAnomaly(
  status: StorageLocationStatus = evaluateStorageLocation(),
): Promise<'reported' | 'resolved' | 'none'> {
  try {
    if (status.status === 'error') {
      const id = await reportAnomaly({
        domain: 'other',
        fingerprint: STORAGE_LOCATION_FINGERPRINT,
        title: 'Stockage documentaire hors des régions autorisées (France)',
        detail: {
          region: status.region,
          endpointHost: status.endpointHost,
          endpointRegion: status.endpointRegion,
          problems: status.problems,
          allowedRegions: status.allowedRegions,
          acknowledged: status.acknowledged,
          action: 'Corriger OVH_S3_ENDPOINT / OVH_S3_REGION (Scalingo › Environment) puis redéployer — docs/exploitation/localisation-stockage.md.',
        },
      });
      return id === null ? 'none' : 'reported';
    }
    const resolved = await autoResolveAnomaly(STORAGE_LOCATION_FINGERPRINT, {
      origin: 'storage_location_check',
      cause: status.status === 'ok' ? status.message : 'Stockage non configuré',
    });
    return resolved ? 'resolved' : 'none';
  } catch (e) {
    console.error('[storage-location] supervision impossible :', (e as Error).message);
    return 'none';
  }
}
