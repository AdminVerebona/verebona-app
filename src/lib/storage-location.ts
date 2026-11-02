/**
 * Localisation du stockage documentaire — lot 102C (ticket conformité
 * légale, P2 « Localisation du stockage documentaire » ; décision PO :
 * « Stockage durable des documents en France »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * JAMAIS SILENCIEUX
 *
 * La région et le point d'accès du stockage objet (OVH_S3_REGION,
 * OVH_S3_ENDPOINT, OVH_S3_BUCKET, lus par `s3-config.ts`) doivent désigner
 * une région AUTORISÉE (régions françaises, liste paramétrable). Sinon :
 *   · démarrage REFUSÉ en préproduction comme en production
 *     (NODE_ENV=production), message explicite — `assertStorageLocationAllowed`
 *     (instrumentation-node). Seule échappatoire, VISIBLE : la variable
 *     STORAGE_LOCATION_ACKNOWLEDGED_REGION posée à la région exacte en cause —
 *     le service démarre mais reste « Dégradé », l'anomalie de Supervision
 *     reste ouverte et le diagnostic global l'affiche ;
 *   · `/api/health` : section `storageLocation` (statut seul en public ;
 *     région, hôte, liste autorisée et motifs en diagnostic autorisé) et
 *     statut global « Dégradé » ;
 *   · Supervision : anomalie « Stockage documentaire hors des régions
 *     autorisées » (domaine « Autres traitements techniques »), ouverte au
 *     démarrage et à chaque balayage de Supervision, résolue seule ;
 *   · diagnostic global : `technique/versions.json` › `stockageDocumentaire`.
 * Hors production (développement, tests) : avertissement seulement.
 *
 * Paramètres (Scalingo) :
 *   STORAGE_ALLOWED_REGIONS     régions autorisées, séparées par des virgules
 *                               (défaut : gra,sbg,rbx,eu-west-par — OVH
 *                               Gravelines, Strasbourg, Roubaix, Paris) ;
 *   STORAGE_ALLOWED_ENDPOINT_HOSTS  hôtes autorisés EN PLUS des hôtes OVH
 *                               reconnus (s3.<région>.io|perf.cloud.ovh.net),
 *                               pour un point d'accès personnalisé dont la
 *                               localisation française est vérifiée ;
 *   STORAGE_ALLOWED_BUCKETS     (facultatif) seuls ces buckets sont admis.
 *
 * Module PUR (aucun réseau, aucune base) : les valeurs de secret ne sont
 * jamais lues ni renvoyées.
 * ══════════════════════════════════════════════════════════════════════════
 */

type Env = Record<string, string | undefined>;

export const DEFAULT_ALLOWED_REGIONS: readonly string[] = ['gra', 'sbg', 'rbx', 'eu-west-par'];

export type StorageLocationProblem =
  | 'REGION_NOT_ALLOWED'
  | 'ENDPOINT_REGION_NOT_ALLOWED'
  | 'ENDPOINT_NOT_RECOGNIZED'
  | 'ENDPOINT_INVALID'
  | 'BUCKET_NOT_ALLOWED'
  | 'PUBLIC_ENDPOINT_NOT_ALLOWED';

export interface StorageLocationStatus {
  /** `error` : hors liste autorisée ; `unconfigured` : stockage non configuré (aucune donnée n'y part). */
  status: 'ok' | 'error' | 'unconfigured';
  production: boolean;
  region: string | null;
  endpointHost: string | null;
  endpointRegion: string | null;
  bucket: string | null;
  allowedRegions: string[];
  problems: StorageLocationProblem[];
  /** Échappatoire posée et correspondant à la région en cause. */
  acknowledged: boolean;
  message: string;
}

const list = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

/** Région OVH déduite d'un hôte (`s3.gra.io.cloud.ovh.net`, `bucket.s3.sbg.perf.cloud.ovh.net`, `s3.rbx.cloud.ovh.net`). */
export function ovhRegionOfHost(host: string): string | null {
  const m = /(?:^|\.)s3\.([a-z0-9-]+)\.(?:(?:io|perf)\.)?cloud\.ovh\.net$/i.exec(host);
  return m ? m[1].toLowerCase() : null;
}

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

export function evaluateStorageLocation(env: Env = process.env): StorageLocationStatus {
  const production = env.NODE_ENV === 'production';
  const allowedRegions = list(env.STORAGE_ALLOWED_REGIONS).length ? list(env.STORAGE_ALLOWED_REGIONS) : [...DEFAULT_ALLOWED_REGIONS];
  const allowedHosts = list(env.STORAGE_ALLOWED_ENDPOINT_HOSTS);
  const allowedBuckets = list(env.STORAGE_ALLOWED_BUCKETS);
  const endpoint = (env.OVH_S3_ENDPOINT ?? '').trim();
  const bucket = (env.OVH_S3_BUCKET ?? '').trim() || null;
  // Même défaut que `s3-config.ts` (DEFAULT_REGION) : une région absente vaut « gra ».
  const region = ((env.OVH_S3_REGION ?? '').trim() || 'gra').toLowerCase();

  const base = { production, region, bucket, allowedRegions, acknowledged: false };
  if (!endpoint || !bucket) {
    return { ...base, status: 'unconfigured', endpointHost: null, endpointRegion: null, problems: [], message: 'Stockage documentaire non configuré : aucun document ne peut y être déposé.' };
  }

  const problems: StorageLocationProblem[] = [];
  const host = hostOf(endpoint);
  const endpointRegion = host ? ovhRegionOfHost(host) : null;
  if (!host) problems.push('ENDPOINT_INVALID');
  else if (endpointRegion) {
    if (!allowedRegions.includes(endpointRegion)) problems.push('ENDPOINT_REGION_NOT_ALLOWED');
  } else if (!allowedHosts.includes(host)) {
    problems.push('ENDPOINT_NOT_RECOGNIZED');
  }
  if (!allowedRegions.includes(region)) problems.push('REGION_NOT_ALLOWED');
  if (allowedBuckets.length && !allowedBuckets.includes(bucket.toLowerCase())) problems.push('BUCKET_NOT_ALLOWED');
  // Point d'accès public (navigateur, uploads signés) : même règle.
  const pubHost = env.NEXT_PUBLIC_OVH_S3_ENDPOINT ? hostOf(env.NEXT_PUBLIC_OVH_S3_ENDPOINT.trim()) : null;
  if (pubHost && pubHost !== host) {
    const pubRegion = ovhRegionOfHost(pubHost);
    if (pubRegion ? !allowedRegions.includes(pubRegion) : !allowedHosts.includes(pubHost)) problems.push('PUBLIC_ENDPOINT_NOT_ALLOWED');
  }

  const offending = endpointRegion && !allowedRegions.includes(endpointRegion) ? endpointRegion : region;
  const ack = (env.STORAGE_LOCATION_ACKNOWLEDGED_REGION ?? '').trim().toLowerCase();
  const acknowledged = problems.length > 0 && !!ack && (ack === offending || ack === host);

  const status = problems.length ? 'error' : 'ok';
  return {
    ...base,
    status,
    endpointHost: host,
    endpointRegion,
    problems,
    acknowledged,
    message: status === 'ok'
      ? `Stockage documentaire dans une région autorisée (${endpointRegion ?? region}).`
      : `Stockage documentaire hors des régions autorisées (${problems.join(', ')} ; région ${region}${endpointRegion ? `, point d’accès ${endpointRegion}` : host ? `, hôte ${host}` : ''} ; autorisées : ${allowedRegions.join(', ')}).`,
  };
}

/** Message de refus de démarrage (aucune valeur de secret). */
export function storageLocationStartupError(s: StorageLocationStatus): string {
  return `[storage-location] Démarrage refusé : ${s.message} `
    + 'Corriger OVH_S3_ENDPOINT / OVH_S3_REGION / OVH_S3_BUCKET, ou ajuster STORAGE_ALLOWED_REGIONS / STORAGE_ALLOWED_ENDPOINT_HOSTS '
    + 'si la région est bien en France. Échappatoire visible (statut Dégradé, anomalie ouverte) : '
    + `STORAGE_LOCATION_ACKNOWLEDGED_REGION=${s.endpointRegion && !s.allowedRegions.includes(s.endpointRegion) ? s.endpointRegion : s.region}. `
    + 'Voir docs/exploitation/localisation-stockage.md.';
}

/**
 * Garde de démarrage. Production (préproduction comprise) : lève si la
 * localisation n'est pas autorisée et non reconnue explicitement. Ailleurs :
 * avertissement. Renvoie le statut (journalisé par l'appelant).
 */
export function assertStorageLocationAllowed(env: Env = process.env): StorageLocationStatus {
  const s = evaluateStorageLocation(env);
  if (s.status !== 'error') return s;
  if (s.production && !s.acknowledged) throw new Error(storageLocationStartupError(s));
  console.error(`[storage-location] ${s.message}${s.acknowledged ? ' (reconnu par STORAGE_LOCATION_ACKNOWLEDGED_REGION : service Dégradé)' : ''}`);
  return s;
}
