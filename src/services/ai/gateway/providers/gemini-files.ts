/**
 * Préparation des pièces jointes Gemini — centralise la logique jusqu'ici
 * dispersée dans `upload-to-gemini.ts` et `gemini-client.ts`.
 *
 * Règle CDC §4.1.7 : les fichiers temporaires côté fournisseur sont supprimés
 * après usage, y compris en cas d'échec.
 */
import type { Part } from '@google/generative-ai';
import type { AiAttachment } from '../types';

const FILES_API = 'https://generativelanguage.googleapis.com/upload/v1beta/files';

const INLINE_IMAGE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
]);

/** Types nécessitant l'upload via Files API (taille, durée). */
function needsFilesApi(mimeType: string): boolean {
  return mimeType === 'application/pdf' || mimeType.startsWith('video/') || mimeType.startsWith('audio/');
}

export interface PreparedAttachments {
  parts: Part[];
  /** URIs à supprimer après l'appel. */
  temporaryFileUris: string[];
}

export async function prepareAttachmentParts(
  attachments: AiAttachment[],
  apiKey: string,
): Promise<PreparedAttachments> {
  const parts: Part[] = [];
  const temporaryFileUris: string[] = [];

  for (const att of attachments) {
    if (needsFilesApi(att.mimeType)) {
      const uri = await uploadToFilesApi(att, apiKey);
      temporaryFileUris.push(uri);
      parts.push({ fileData: { fileUri: uri, mimeType: att.mimeType } });
      continue;
    }

    if (INLINE_IMAGE_MIMES.has(att.mimeType)) {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`Téléchargement échoué (HTTP ${res.status}) : ${att.displayName ?? att.url}`);
      const data = Buffer.from(await res.arrayBuffer()).toString('base64');
      parts.push({ inlineData: { mimeType: att.mimeType, data } });
      continue;
    }

    // Bureautique et texte : extraction côté serveur, jamais d'envoi binaire.
    const { extractTextContent } = await import('./content-extractors');
    const text = await extractTextContent(att);
    if (text) parts.push({ text });
  }

  return { parts, temporaryFileUris };
}

async function uploadToFilesApi(att: AiAttachment, apiKey: string): Promise<string> {
  const res = await fetch(att.url);
  if (!res.ok) throw new Error(`Téléchargement échoué (HTTP ${res.status}) : ${att.displayName ?? att.url}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const upload = await fetch(`${FILES_API}?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'raw',
      'Content-Type': att.mimeType,
      'X-Goog-Upload-File-Name': att.displayName ?? 'source',
    },
    body: new Uint8Array(buffer),
  });
  if (!upload.ok) throw new Error(`Upload Files API échoué : HTTP ${upload.status}`);

  const json = (await upload.json()) as { file?: { uri?: string } };
  const uri = json.file?.uri;
  if (!uri) throw new Error('Upload Files API : URI absente de la réponse');
  return uri;
}

export async function cleanupTemporaryFiles(uris: string[], apiKey: string): Promise<void> {
  await Promise.all(
    uris.map(async (uri) => {
      try {
        const name = uri.split('/files/')[1];
        if (!name) return;
        await fetch(`https://generativelanguage.googleapis.com/v1beta/files/${name}?key=${apiKey}`, { method: 'DELETE' });
      } catch {
        // Non bloquant : les fichiers Files API expirent d'eux-mêmes sous 48 h.
      }
    }),
  );
}
