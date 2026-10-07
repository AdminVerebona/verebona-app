/**
 * URL de lecture d'une miniature de document — partagée par
 * `GET /api/files/[id]/thumbnail` (Mes documents) et le résumé de l'accueil
 * (« Documents récents », lot 26 point 16).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE URL STABLE PAR HEURE, SIGNÉE UNE FOIS
 *
 *   · signature LOCALE (aucun appel au stockage), datée du début de l'heure :
 *     l'URL est identique pendant l'heure — le navigateur réutilise l'image
 *     en cache (`Cache-Control: private, max-age=3600` rendu par le stockage),
 *     et la route de Mes documents et l'accueil produisent la MÊME URL pour un
 *     même dérivé (un seul téléchargement pour les deux écrans) ;
 *   · validité 2 h : une URL servie en fin d'heure reste valable ≥ 1 h ;
 *   · mémorisée par (clé du dérivé, heure) dans un cache borné du processus :
 *     ni signature par carte ni par rendu — au plus une par dérivé et par
 *     heure et par instance. La clé du dérivé change avec la version de
 *     l'original (`documentThumbnailKey`) : jamais d'aperçu périmé.
 * Les droits sont contrôlés par l'appelant (route : `loadReadableFile` ;
 * accueil : documents du compte de la session).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { signGetUrl } from '@/lib/s3-config';
import { THUMBNAIL_FORMAT } from './thumbnail-spec';

/** Fenêtre d'arrondi de la signature. */
export const THUMBNAIL_SIGNING_WINDOW_MS = 60 * 60 * 1000;
/** Validité de l'URL : fenêtre + 1 h de marge. */
export const THUMBNAIL_SIGNED_TTL_S = 2 * 60 * 60;
/** Entrées gardées au plus (≈ 1 Ko chacune). */
const MAX_ENTRIES = 5_000;

const memo = new Map<string, string>();
let memoWindow = 0;
const stats = { signed: 0, reused: 0 };

export function thumbnailSigningDate(now: number = Date.now()): Date {
  return new Date(Math.floor(now / THUMBNAIL_SIGNING_WINDOW_MS) * THUMBNAIL_SIGNING_WINDOW_MS);
}

/** URL signée (stable pendant l'heure) du dérivé `s3Key`. */
export async function signedThumbnailUrl(
  s3Key: string,
  now: number = Date.now(),
  sign: typeof signGetUrl = signGetUrl,
): Promise<string> {
  const signingDate = thumbnailSigningDate(now);
  const window = signingDate.getTime();
  if (window !== memoWindow) {
    memo.clear();
    memoWindow = window;
  }
  const hit = memo.get(s3Key);
  if (hit) {
    stats.reused += 1;
    return hit;
  }
  const url = await sign({
    key: s3Key,
    expiresIn: THUMBNAIL_SIGNED_TTL_S,
    signingDate,
    responseContentType: THUMBNAIL_FORMAT,
    responseCacheControl: 'private, max-age=3600',
  });
  if (memo.size >= MAX_ENTRIES) memo.delete(memo.keys().next().value as string);
  memo.set(s3Key, url);
  stats.signed += 1;
  return url;
}

/** Compteurs (mesure, tests). */
export function thumbnailUrlStats(): { signed: number; reused: number; size: number } {
  return { ...stats, size: memo.size };
}

/** Réservé aux tests. */
export function resetThumbnailUrlMemo(): void {
  memo.clear();
  memoWindow = 0;
  stats.signed = 0;
  stats.reused = 0;
}
