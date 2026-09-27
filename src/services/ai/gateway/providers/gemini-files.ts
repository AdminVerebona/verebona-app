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

/** URI accessible nativement par Gemini (reprise de l'ancien `gemini-client`). */
export function isProviderNativeUri(url: string): boolean {
  return url.startsWith('gs://') || url.startsWith('https://generativelanguage.googleapis.com/');
}

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

  try {
    await appendParts(attachments, apiKey, parts, temporaryFileUris);
  } catch (e) {
    // Échec sur la pièce k : les fichiers 1..k-1 déjà envoyés à la Files API
    // doivent être supprimés ici — l'appelant ne reçoit jamais leurs URI.
    await cleanupTemporaryFiles(temporaryFileUris, apiKey);
    throw e;
  }

  return { parts, temporaryFileUris };
}

async function appendParts(
  attachments: AiAttachment[],
  apiKey: string,
  parts: Part[],
  temporaryFileUris: string[],
): Promise<void> {
  for (const att of attachments) {
    // Contenu déjà en mémoire (base64) : données en ligne, sans téléchargement.
    if (att.data !== undefined) {
      parts.push({ inlineData: { mimeType: att.mimeType, data: att.data } });
      continue;
    }

    // URI déjà lisible par le fournisseur (GCS, fichier Files API existant) :
    // référencée telle quelle — ni téléchargement, ni fichier temporaire à
    // supprimer, il ne nous appartient pas.
    if (isProviderNativeUri(att.url)) {
      parts.push({ fileData: { fileUri: att.url, mimeType: att.mimeType } });
      continue;
    }

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

  const json = (await upload.json()) as { file?: { uri?: string; name?: string; state?: string } };
  const uri = json.file?.uri;
  if (!uri) throw new Error('Upload Files API : URI absente de la réponse');

  // Un fichier encore en traitement chez le fournisseur (vidéo, gros PDF) fait
  // échouer la génération : attendre l'état ACTIVE, comme le faisait l'ancien
  // `upload-to-gemini`. Hors du délai de l'appel modèle, comme avant.
  if (json.file?.state && json.file.state !== 'ACTIVE') {
    const name = json.file.name ?? `files/${uri.split('/files/')[1] ?? ''}`;
    try {
      await waitForFileActive(name, apiKey);
    } catch (e) {
      await cleanupTemporaryFiles([uri], apiKey);
      throw e;
    }
  }
  return uri;
}

const ACTIVE_POLL_INTERVAL_MS = 3_000;
const ACTIVE_MAX_WAIT_MS = 300_000;

async function waitForFileActive(name: string, apiKey: string): Promise<void> {
  const deadline = Date.now() + ACTIVE_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}?key=${apiKey}`);
    if (!res.ok) throw new Error(`Suivi du fichier Files API impossible : HTTP ${res.status}`);
    const { state } = (await res.json()) as { state?: string };
    if (state === 'ACTIVE') return;
    if (state === 'FAILED') throw new Error('Traitement du fichier Files API échoué (state=FAILED)');
    await new Promise((r) => setTimeout(r, ACTIVE_POLL_INTERVAL_MS));
  }
  throw new Error("Le fichier Files API n'est pas devenu ACTIVE dans le délai");
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
