/**
 * Aperçus de documents servis DANS une réponse de liste — accueil
 * (« Documents récents », lot 26 point 16) et file « À traiter » (vue Cartes,
 * lot 34 point 11).
 *
 * L'appelant lit l'état de la miniature dans la MÊME requête que ses lignes
 * (jointure `asset_file_thumbnails` sur fichier × variante : pas de N+1) ;
 * ce module ne fait que décider et signer :
 *   · miniature PRÊTE de la version courante → URL signée mémorisée
 *     (`thumbnail-url.ts` : au plus une signature locale par dérivé et par
 *     heure, aucune requête au stockage, URL stable → cache navigateur) ;
 *   · absente ou périmée → pas d'aperçu (icône côté client) et génération
 *     demandée, en plus de la tâche horaire `hourly-thumbnails-backfill`.
 * Ne lève jamais : un aperçu manquant ne doit pas priver la liste du reste.
 */
import { decideThumbnail, thumbnailSourceKind } from './thumbnail-spec';

export interface DocumentPreviewRow {
  id: number;
  s3Key: string | null;
  mimeType: string | null;
  fileExtension: string | null;
  originalFilename: string | null;
  isWebLink: boolean | null;
  thumbStatus: string | null;
  thumbSourceKey: string | null;
  thumbS3Key: string | null;
  thumbAttempts: number | null;
  thumbLeaseUntil: Date | null;
  thumbUpdatedAt: Date | null;
}

export interface DocumentPreviewDeps {
  enabled: () => boolean;
  sign: (s3Key: string) => Promise<string>;
  enqueue: (fileId: number) => void;
}

export const defaultDocumentPreviewDeps = async (): Promise<DocumentPreviewDeps> => {
  const [{ thumbnailsEnabled, enqueueThumbnail }, { signedThumbnailUrl }] = await Promise.all([
    import('./thumbnail.service'),
    import('./thumbnail-url'),
  ]);
  return { enabled: thumbnailsEnabled, sign: (k) => signedThumbnailUrl(k), enqueue: (id) => { enqueueThumbnail(id); } };
};

/** URL d'aperçu par identifiant de fichier (absent : pas d'aperçu). */
export async function documentPreviews(
  rows: DocumentPreviewRow[],
  depsP: Promise<DocumentPreviewDeps> | DocumentPreviewDeps = defaultDocumentPreviewDeps(),
  logContext = 'aperçus',
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  try {
    const deps = await depsP;
    if (!deps.enabled()) return out;
    const seen = new Set<number>();
    await Promise.all(rows.map(async (r) => {
      if (seen.has(r.id)) return;
      seen.add(r.id);
      if (!r.s3Key || !thumbnailSourceKind(r)) return;
      const row = r.thumbStatus && r.thumbSourceKey && r.thumbUpdatedAt
        ? {
            status: r.thumbStatus, sourceKey: r.thumbSourceKey, s3Key: r.thumbS3Key,
            attempts: r.thumbAttempts ?? 0, leaseUntil: r.thumbLeaseUntil, updatedAt: r.thumbUpdatedAt,
          }
        : null;
      const decision = decideThumbnail(row, r.s3Key);
      if (decision.action === 'serve') {
        try { out.set(r.id, await deps.sign(decision.s3Key)); } catch { /* icône */ }
      } else if (decision.action === 'generate') {
        deps.enqueue(r.id);
      }
    }));
  } catch (e) {
    console.warn(`[${logContext}] aperçus de documents indisponibles :`, (e as Error).message);
  }
  return out;
}
