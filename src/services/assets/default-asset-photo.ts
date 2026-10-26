/**
 * Vignette par défaut d'un bien — lot 59, point 2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « S'IL Y A UNE PHOTO RATTACHÉE À UN BIEN, LA METTRE PAR DÉFAUT EN VIGNETTE »
 *
 *   · une vignette CHOISIE (`assets.thumbnailUrl`, tiroir « Vignette du
 *     bien ») l'emporte toujours ;
 *   · sinon, la première photo rattachée au bien — périmètre COMMUN des
 *     documents d'un bien (`asset-document-scope` : `asset_id`,
 *     `linked_asset_id` ou lien PRIMARY / SECONDARY actif ; un bien
 *     seulement cité n'en fait pas partie) —, fichier du compte, téléversé,
 *     non supprimé, ni brouillon ni ignoré, pas un lien web, affichable par
 *     le navigateur ;
 *   · une image classée comme un AUTRE document (facture scannée, contrat
 *     photographié…) n'est jamais prise : seules les photos (`PHOTO`), les
 *     images pas encore classées, puis les photos de sinistre ;
 *   · ordre stable : rang, puis la plus ANCIENNE (une nouvelle photo ne
 *     remplace pas la vignette déjà affichée), puis l'identifiant.
 *
 * Calculée à la LECTURE : rien n'est écrit en base (aucune migration, aucune
 * reprise des biens existants), une photo supprimée cesse aussitôt d'être la
 * vignette, et choisir une vignette dans le tiroir reste le seul geste
 * d'écriture. Le client affiche `effectiveThumbnailUrl` par la route signée
 * existante `GET /api/assets/[id]/thumbnail`, qui applique la même règle.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { thumbnailSourceKind } from '@/services/documents/thumbnails/thumbnail-spec';

interface AssetPhotoCandidate {
  id: number;
  assetId: number | null;
  linkedAssetId: number | null;
  /** Autres biens rattachés par un lien N-N PRIMARY / SECONDARY actif. */
  otherAssetIds?: readonly number[] | null;
  mimeType: string | null;
  fileExtension?: string | null;
  originalFilename?: string | null;
  documentTypeCode: string | null;
  s3Key: string | null;
  uploadedAt: Date | string | null;
}

interface DefaultAssetPhoto {
  fileId: number;
  s3Key: string;
}

/** Types de document qui désignent une photo du bien (rang croissant). */
const PHOTO_TYPE_RANK: Readonly<Record<string, number>> = {
  PHOTO: 0,
  PHOTO_ETAT: 2,
  CLAIM_DAMAGE_PHOTO: 3,
};
/** Image pas encore classée (analyse en cours ou non lancée). */
const UNCLASSIFIED_RANK = 1;

/**
 * Rang d'une image candidate, `null` si elle ne peut pas servir de vignette :
 * pas une image affichable (HEIC, SVG, TIFF, PDF…), ou classée comme un autre
 * document.
 */
export function defaultPhotoRank(c: Pick<AssetPhotoCandidate, 'mimeType' | 'fileExtension' | 'originalFilename' | 'documentTypeCode' | 's3Key'>): number | null {
  if (thumbnailSourceKind({ mimeType: c.mimeType, fileExtension: c.fileExtension, originalFilename: c.originalFilename, s3Key: c.s3Key }) !== 'image') return null;
  const mime = (c.mimeType ?? '').toLowerCase();
  if (mime.includes('tiff')) return null; // non affichable tel quel par les navigateurs
  const code = c.documentTypeCode?.trim();
  if (!code) return UNCLASSIFIED_RANK;
  return PHOTO_TYPE_RANK[code] ?? null;
}

const time = (d: Date | string | null): number => {
  if (!d) return Number.MAX_SAFE_INTEGER;
  const t = (d instanceof Date ? d : new Date(d)).getTime();
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
};

/** Photo par défaut de chaque bien demandé (pure, testée). */
export function pickDefaultAssetPhotos(assetIds: readonly number[], candidates: readonly AssetPhotoCandidate[]): Map<number, DefaultAssetPhoto> {
  const wanted = new Set(assetIds);
  const best = new Map<number, { rank: number; t: number; c: AssetPhotoCandidate }>();
  for (const c of candidates) {
    if (!c.s3Key) continue;
    const rank = defaultPhotoRank(c);
    if (rank === null) continue;
    const t = time(c.uploadedAt);
    for (const assetId of new Set([c.assetId, c.linkedAssetId, ...(c.otherAssetIds ?? [])])) {
      if (assetId == null || !wanted.has(assetId)) continue;
      const cur = best.get(assetId);
      if (!cur || rank < cur.rank || (rank === cur.rank && (t < cur.t || (t === cur.t && c.id < cur.c.id)))) {
        best.set(assetId, { rank, t, c });
      }
    }
  }
  return new Map([...best].map(([assetId, b]) => [assetId, { fileId: b.c.id, s3Key: b.c.s3Key! }]));
}

/** Vignette à afficher : la vignette choisie, sinon la photo par défaut. */
export function effectiveThumbnailUrl(thumbnailUrl: string | null | undefined, photo: DefaultAssetPhoto | null | undefined): string | null {
  return thumbnailUrl || photo?.s3Key || null;
}

/**
 * Photos par défaut des biens d'un compte — une requête, bornée aux biens
 * demandés et au compte (jamais le fichier d'un autre compte). Ne lève
 * jamais : une vignette manquante ne doit pas priver la liste du reste.
 */
export async function loadDefaultAssetPhotos(accountId: number, assetIds: readonly number[]): Promise<Map<number, DefaultAssetPhoto>> {
  const ids = [...new Set(assetIds.filter((x) => Number.isSafeInteger(x) && x > 0))];
  if (ids.length === 0) return new Map();
  try {
    const [{ db }, { assetFiles, documentAssetLinks }, { and, eq, inArray, isNull, or, like }, scope] = await Promise.all([
      import('@/db'), import('@/db/schema'), import('drizzle-orm'), import('@/services/documents/asset-document-scope'),
    ]);
    const files = await db
      .select({
        id: assetFiles.id,
        assetId: assetFiles.assetId,
        linkedAssetId: assetFiles.linkedAssetId,
        mimeType: assetFiles.mimeType,
        fileExtension: assetFiles.fileExtension,
        originalFilename: assetFiles.originalFilename,
        documentTypeCode: assetFiles.documentTypeCode,
        s3Key: assetFiles.s3Key,
        uploadedAt: assetFiles.uploadedAt,
      })
      .from(assetFiles)
      .where(and(
        eq(assetFiles.accountId, accountId),
        scope.documentInAssetsCondition(ids),
        or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
        isNull(assetFiles.deletedAt),
        eq(assetFiles.isWebLink, false),
        eq(assetFiles.isDraft, false),
        eq(assetFiles.isIgnored, false),
        like(assetFiles.mimeType, 'image/%'),
      ));
    if (files.length === 0) return new Map();
    // Liens N-N PRIMARY / SECONDARY actifs vers les biens demandés, lus à part :
    // `OTHER_ASSET_IDS_SQL` suppose une requête avec jointure (colonnes
    // qualifiées) — sur `asset_files` seule, sa sous-requête corrélée lirait
    // `document_asset_links.id` au lieu de `asset_files.id`.
    const links = await db
      .select({ fileId: documentAssetLinks.fileId, assetId: documentAssetLinks.assetId })
      .from(documentAssetLinks)
      .where(and(
        eq(documentAssetLinks.accountId, accountId),
        inArray(documentAssetLinks.fileId, files.map((f) => f.id)),
        inArray(documentAssetLinks.assetId, ids),
        eq(documentAssetLinks.status, 'ACTIVE'),
        inArray(documentAssetLinks.linkRole, [...scope.ASSET_LIST_LINK_ROLES]),
      ));
    const parFichier = new Map<number, number[]>();
    for (const l of links) {
      if (l.assetId == null) continue;
      parFichier.set(l.fileId, [...(parFichier.get(l.fileId) ?? []), l.assetId]);
    }
    const rows = files.map((f) => ({ ...f, otherAssetIds: parFichier.get(f.id) ?? [] }));
    return pickDefaultAssetPhotos(ids, rows);
  } catch (e) {
    console.warn('[vignette par défaut] photos indisponibles :', (e as Error).message);
    return new Map();
  }
}
