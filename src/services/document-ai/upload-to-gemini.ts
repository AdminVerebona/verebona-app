/**
 * Utilitaire : télécharge un fichier depuis S3 puis l'uploade vers Gemini Files API.
 * Nécessaire pour les vidéos — Gemini ne peut pas récupérer des URLs presignées S3
 * privées (OVH) directement via fileData.fileUri.
 *
 * Retourne l'URI Gemini (`files/xxxx`) à passer en fileData.fileUri.
 * Supprime automatiquement le fichier Gemini après l'analyse (TTL 48h max, mais on nettoie).
 */

import { GoogleAIFileManager, FileState } from '@google/generative-ai/server';

const VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
  'video/x-matroska',
]);

// PDFs are also uploaded via Files API for better reliability:
// Gemini sometimes returns empty responses when PDFs are sent as inlineData base64,
// particularly for dense commercial/visual documents. The Files API is more robust.
const PDF_MIME_TYPES = new Set(['application/pdf']);

export function isVideoMimeType(mimeType: string): boolean {
  return VIDEO_MIME_TYPES.has(mimeType);
}

export function isPdfMimeType(mimeType: string): boolean {
  return PDF_MIME_TYPES.has(mimeType);
}

/**
 * Télécharge un fichier depuis une URL (URL presignée S3) et l'uploade vers Gemini Files API.
 * Retourne l'URI Gemini à utiliser dans fileData.fileUri.
 */
export async function uploadUrlToGemini(
  url: string,
  mimeType: string,
  displayName: string,
): Promise<{ fileUri: string; geminiName: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  // 1. Télécharger le fichier depuis S3
  const response = await fetch(url);
  if (!response.ok) {
    const hint = response.status === 403
      ? ' — accès S3 refusé (URL expirée ou restrictions réseau)'
      : response.status === 404
      ? ' — fichier introuvable dans le stockage S3'
      : '';
    throw new Error(`Téléchargement S3 échoué: HTTP ${response.status}${hint}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // 2. Uploader vers Gemini Files API via l'API REST (multipart)
  //    On utilise fetch directement car GoogleAIFileManager attend un chemin de fichier
  //    alors que nous avons un Buffer en mémoire.
  const boundary = `----GeminiBoundary${Date.now()}`;

  // RFC 2046 multipart: each part is --boundary\r\n<headers>\r\n\r\n<body>
  // The metadata part ends with \r\n\r\n before the JSON body, then \r\n before next boundary
  const metadataPart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=utf-8\r\n` +
    `\r\n` +
    JSON.stringify({ file: { display_name: displayName } }) +
    `\r\n`;

  // File part header — body (binary buffer) is concatenated directly after
  const filePart =
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n` +
    `Content-Transfer-Encoding: binary\r\n` +
    `\r\n`;

  const closing = `\r\n--${boundary}--\r\n`;

  const metaBytes = Buffer.from(metadataPart, 'utf8');
  const fileHeaderBytes = Buffer.from(filePart, 'utf8');
  const closingBytes = Buffer.from(closing, 'utf8');

  const body = Buffer.concat([metaBytes, fileHeaderBytes, buffer, closingBytes]);

  const uploadRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'X-Goog-Upload-Protocol': 'multipart',
      },
      body,
    },
  );

  if (!uploadRes.ok) {
    const errText = await uploadRes.text().catch(() => '');
    throw new Error(`Gemini file upload failed: HTTP ${uploadRes.status} — ${errText}`);
  }

  const uploadJson = await uploadRes.json() as { file?: { name?: string; uri?: string; state?: string } };
  const geminiName = uploadJson.file?.name;
  const fileUri = uploadJson.file?.uri;

  if (!geminiName || !fileUri) {
    throw new Error(`Gemini file upload: unexpected response — ${JSON.stringify(uploadJson)}`);
  }

  // 3. Attendre que le fichier soit ACTIVE (traitement côté Gemini)
  await waitForGeminiFileActive(apiKey, geminiName);

  return { fileUri, geminiName };
}

/**
 * Supprime un fichier uploadé vers Gemini Files API.
 * À appeler après l'analyse pour libérer le quota (TTL max 48h de toute façon).
 */
export async function deleteGeminiFile(geminiName: string): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return;

  try {
    await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${geminiName}?key=${apiKey}`,
      { method: 'DELETE' },
    );
  } catch {
    // Non-bloquant — le fichier expire de toute façon après 48h
  }
}

async function waitForGeminiFileActive(apiKey: string, geminiName: string, maxWaitMs = 300_000): Promise<void> {
  const pollIntervalMs = 3_000;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${geminiName}?key=${apiKey}`,
    );
    if (!res.ok) throw new Error(`Failed to poll Gemini file status: HTTP ${res.status}`);

    const json = await res.json() as { state?: string };
    if (json.state === 'ACTIVE') return;
    if (json.state === 'FAILED') throw new Error('Gemini file processing failed (state=FAILED)');

    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  throw new Error('Gemini file did not become ACTIVE within timeout');
}
