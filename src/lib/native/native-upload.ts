/**
 * Envoi natif de fond — lot 95 (CDC 12 §11 UPL-01/02/05/06/09, G0-05, REC-029..032).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Remplace UNIQUEMENT le PUT vers l'URL signée du stockage (étape
 * « transfert » de la file `lib/upload-queue.ts`) par un transfert natif qui
 * continue app en arrière-plan : URLSession *background* sur iOS, service de
 * transfert Android (`@capgo/capacitor-uploader`). Presign, confirmation et
 * idempotence (`operationId` tiré AVANT l'envoi, identique à chaque reprise,
 * APP-PERF-30) sont ceux du Web : un rejeu ne crée jamais de doublon.
 *
 *   · Le fichier est copié dans le cache PRIVÉ de l'app (sandbox, NET-10),
 *     puis effacé dès la fin du transfert, réussi ou non (UPL-05).
 *   · Annulation : le transfert natif est retiré (UPL-10).
 *   · Limite connue (à qualifier au Gate 0, UPL-08) : si le système TUE
 *     l'app pendant le transfert, la confirmation n'a lieu qu'à la
 *     réouverture, et la file actuelle demande alors de resélectionner le
 *     fichier (état « interrompu » du Web). Voir la doc Gate 0 § « Upload ».
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NATIVE_PLUGINS, listenNative, nativePlugin } from './bridge';

type Directory = 'CACHE';
interface FilesystemPlugin {
  writeFile(o: { path: string; data: string; directory: Directory; recursive?: boolean }): Promise<{ uri: string }>;
  appendFile(o: { path: string; data: string; directory: Directory }): Promise<void>;
  getUri(o: { path: string; directory: Directory }): Promise<{ uri: string }>;
  deleteFile(o: { path: string; directory: Directory }): Promise<void>;
}
interface UploaderPlugin {
  startUpload(o: Record<string, unknown>): Promise<{ id: string }>;
  removeUpload(o: { id: string }): Promise<void>;
  addListener?: (event: string, cb: (data: unknown) => void) => unknown;
}
interface UploadEvent { name: 'uploading' | 'completed' | 'failed'; id: string; payload?: { percent?: number; error?: string; statusCode?: number } }

/** Taille des tranches écrites (multiple de 3 : base64 sans remplissage intermédiaire). */
export const CHUNK_BYTES = 3 * 256 * 1024;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Nom de fichier temporaire sûr (pur). */
export function tempUploadPath(name: string, rand: string): string {
  const base = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'document';
  return `verebona-envois/${rand}-${base}`;
}

function annulation(): Error {
  const e = new Error('Upload annulé');
  e.name = 'AbortError';
  return e;
}

/** Envoi natif si la coque l'embarque, sinon null (le Web garde son XHR). */
export function nativeUploadSender(): ((url: string, file: File, mimeType: string, signal: AbortSignal, onProgress: (f: number) => void) => Promise<void>) | null {
  const fs = nativePlugin<FilesystemPlugin>(NATIVE_PLUGINS.filesystem);
  const up = nativePlugin<UploaderPlugin>(NATIVE_PLUGINS.uploader);
  if (!fs || !up) return null;

  return async (url, file, mimeType, signal, onProgress) => {
    if (signal.aborted) throw annulation();
    const path = tempUploadPath(file.name, globalThis.crypto.randomUUID?.() ?? String(Date.now()));
    let uploadId: string | null = null;
    let stop: (() => void) | null = null;
    try {
      // Copie dans le cache privé, par tranches (pas de chaîne géante en mémoire).
      for (let offset = 0; offset < file.size || offset === 0; offset += CHUNK_BYTES) {
        if (signal.aborted) throw annulation();
        const data = toBase64(new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer()));
        if (offset === 0) await fs.writeFile({ path, data, directory: 'CACHE', recursive: true });
        else await fs.appendFile({ path, data, directory: 'CACHE' });
        if (file.size === 0) break;
      }
      const { uri } = await fs.getUri({ path, directory: 'CACHE' });

      // Abonnement AVANT le démarrage : aucun événement perdu ; ceux reçus
      // avant l'identifiant du transfert sont rejoués ensuite.
      let traiter: ((e: UploadEvent) => void) | null = null;
      const enAvance: UploadEvent[] = [];
      stop = await listenNative<UploadEvent>(up, 'events', (e) => {
        if (traiter && uploadId) traiter(e); else enAvance.push(e);
      });

      await new Promise<void>((resolve, reject) => {
        const surAnnulation = () => {
          if (uploadId) void up.removeUpload({ id: uploadId }).catch(() => undefined);
          reject(annulation());
        };
        signal.addEventListener('abort', surAnnulation, { once: true });
        traiter = (e: UploadEvent) => {
          if (e?.id !== uploadId) return;
          if (e.name === 'uploading' && typeof e.payload?.percent === 'number') onProgress(Math.min(1, e.payload.percent / 100));
          else if (e.name === 'completed') {
            signal.removeEventListener('abort', surAnnulation);
            const code = e.payload?.statusCode ?? 200;
            if (code >= 200 && code < 300) { onProgress(1); resolve(); }
            else reject(new Error(`${file.name} : le stockage a refusé le fichier (${code}).`));
          } else if (e.name === 'failed') {
            signal.removeEventListener('abort', surAnnulation);
            reject(new Error(`${file.name} : transfert interrompu. Il reprendra à la prochaine tentative.`));
          }
        };
        up.startUpload({
          filePath: uri,
          serverUrl: url,
          method: 'PUT',
          uploadType: 'binary',
          headers: { 'Content-Type': mimeType },
          mimeType,
          maxRetries: 3,
          notificationTitle: 'Envoi d’un document à Verebona',
        }).then((r) => {
          uploadId = r.id;
          if (signal.aborted) { surAnnulation(); return; }
          for (const e of enAvance.splice(0)) traiter?.(e);
        }, reject);
      });
    } finally {
      stop?.();
      await fs.deleteFile({ path, directory: 'CACHE' }).catch(() => undefined);
    }
  };
}
