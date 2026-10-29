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
 *   · Sans session : les fichiers sont gardés EN MÉMOIRE le temps de la
 *     connexion puis proposés (IMP-04) ; une connexion qui recharge la page
 *     (ou une app fermée entre-temps) les perd : le message demande alors de
 *     partager à nouveau (« message clair si conservation impossible ») —
 *     aucune copie de documents personnels n'est laissée sur le disque.
 */
import { readNativeFile } from './files';

export interface SharedFileRef { uri: string; name: string; mimeType: string }

export interface ShareTriage {
  accepted: SharedFileRef[];
  refused: Array<{ name: string; reason: string }>;
}

const ACCEPTES = /^(application\/pdf|image\/(jpeg|png|heic|heif|webp|gif|tiff))$/i;

/** Tri des fichiers reçus (pur, testé). */
export function triageSharedFiles(files: unknown): ShareTriage {
  const out: ShareTriage = { accepted: [], refused: [] };
  if (!Array.isArray(files)) return out;
  for (const f of files) {
    const r = f as Partial<SharedFileRef> | null;
    const name = typeof r?.name === 'string' && r.name.trim() ? r.name.trim() : 'Fichier sans nom';
    if (!r || typeof r.uri !== 'string' || !r.uri) { out.refused.push({ name, reason: 'Fichier illisible.' }); continue; }
    const mime = typeof r.mimeType === 'string' ? r.mimeType.toLowerCase() : '';
    if (!ACCEPTES.test(mime)) { out.refused.push({ name, reason: 'Format non pris en charge : seuls les PDF et les images sont acceptés.' }); continue; }
    out.accepted.push({ uri: r.uri, name, mimeType: mime });
  }
  return out;
}

/** Lit un fichier partagé (copie privée de l'app) en `File`. */
export async function readSharedFile(ref: SharedFileRef): Promise<File> {
  const blob = await readNativeFile(ref.uri, ref.mimeType);
  return new File([blob], ref.name, { type: ref.mimeType });
}
