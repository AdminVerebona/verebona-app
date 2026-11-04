/**
 * Partage entrant (Verebona destination de partage) — lot 95 (CDC 12 IMP-02..06,
 * REC-025/026 ; G0-07).
 *
 * Le système remet à l'app un ou plusieurs fichiers (PDF, images) partagés
 * depuis Photos, Fichiers, Mail, une messagerie… (`@capgo/capacitor-share-target` :
 * intent SEND / SEND_MULTIPLE sur Android, extension de partage sur iOS).
 *   · Tri : PDF et images acceptés ; tout autre fichier est refusé AVEC son
 *     nom et le motif (REC-026, jamais d'échec silencieux).
 *   · Les fichiers acceptés entrent dans le formulaire d'ajout habituel
 *     (aperçu de la liste avant validation, IMP-03 ; mêmes contrôles, IMP-05/07).
 *   · Lot 108G : les partages sont gardés dans une FILE TECHNIQUE locale
 *     (`share-inbox.ts` : un élément par partage, conservé jusqu'à l'ajout
 *     confirmé ou l'abandon explicite, isolé par compte, purgé après 7 jours)
 *     — plus de perte au rechargement, à la connexion ou au 2e partage.
 *   · Formats : ceux que le serveur accepte (`lib/file-validation.ts`). Les
 *     photos HEIC / HEIF sont converties en JPEG par l'extension iOS (et
 *     signalées) ; reçues telles quelles (Android), elles sont refusées avec
 *     un motif explicite plutôt qu'échouer plus loin.
 */
import { readNativeFile } from './files';

export interface SharedFileRef { uri: string; name: string; mimeType: string }

export interface ShareTriage {
  accepted: SharedFileRef[];
  refused: Array<{ name: string; reason: string }>;
}

const ACCEPTES = /^(application\/pdf|image\/(jpeg|png|webp|gif))$/i;
const HEIC = /^image\/hei[cf](-sequence)?$/i;

/** Tri des fichiers reçus (pur, testé). */
export function triageSharedFiles(files: unknown): ShareTriage {
  const out: ShareTriage = { accepted: [], refused: [] };
  if (!Array.isArray(files)) return out;
  for (const f of files) {
    const r = f as Partial<SharedFileRef> | null;
    const name = typeof r?.name === 'string' && r.name.trim() ? r.name.trim() : 'Fichier sans nom';
    if (!r || typeof r.uri !== 'string' || !r.uri) { out.refused.push({ name, reason: 'Fichier illisible.' }); continue; }
    const mime = typeof r.mimeType === 'string' ? r.mimeType.toLowerCase() : '';
    if (HEIC.test(mime)) { out.refused.push({ name, reason: 'Photo HEIC non prise en charge ici : partagez-la au format JPEG (réglage « Plus compatible » de l’appareil photo).' }); continue; }
    if (!ACCEPTES.test(mime)) { out.refused.push({ name, reason: 'Format non pris en charge : PDF, JPEG, PNG, WEBP ou GIF uniquement.' }); continue; }
    out.accepted.push({ uri: r.uri, name, mimeType: mime });
  }
  return out;
}

/** Lit un fichier partagé (copie privée de l'app) en `File`. */
export async function readSharedFile(ref: SharedFileRef): Promise<File> {
  const blob = await readNativeFile(ref.uri, ref.mimeType);
  return new File([blob], ref.name, { type: ref.mimeType });
}
