/**
 * Lecture d'un fichier natif (scan, partage entrant) — lot 95.
 *
 * Voie rapide : l'URL servie par la WebView (`convertFileSrc`). En mode A sur
 * iOS (page servie par le site distant), cette URL relève d'un autre schéma
 * (`capacitor://`) et peut être refusée par WebKit : repli sur
 * `Filesystem.readFile` (base64 par le pont, plus lent). Point qualifié au
 * Gate 0 (G0-04, G0-07).
 */
import { NATIVE_PLUGINS, nativeFileSrc, nativePlugin } from './bridge';

interface FilesystemRead { readFile(o: { path: string }): Promise<{ data: string | Blob }> }

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function readNativeFile(path: string, mime: string): Promise<Blob> {
  try {
    const res = await fetch(nativeFileSrc(path));
    if (res.ok) return await res.blob();
  } catch { /* repli ci-dessous */ }
  const fs = nativePlugin<FilesystemRead>(NATIVE_PLUGINS.filesystem);
  if (!fs) throw new Error('Fichier illisible');
  const { data } = await fs.readFile({ path });
  return typeof data === 'string' ? new Blob([base64ToBytes(data) as BlobPart], { type: mime }) : data;
}
