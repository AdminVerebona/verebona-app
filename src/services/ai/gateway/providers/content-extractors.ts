/**
 * Extraction texte des formats bureautiques — reprise de `gemini-client.ts`.
 *
 * CDC §5.6 (minimisation) : on transmet du texte, jamais un binaire complet,
 * lorsque le format le permet.
 */
import mammoth from 'mammoth';
import JSZip from 'jszip';
import type { AiAttachment } from '../types';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function extractTextContent(att: AiAttachment): Promise<string | null> {
  if (att.mimeType.startsWith('text/') || att.mimeType === 'application/json') {
    const res = await fetch(att.url);
    return res.ok ? await res.text() : null;
  }

  if (att.mimeType === DOCX_MIME || att.mimeType === 'application/msword') {
    const buffer = await download(att.url);
    const result = await mammoth.extractRawText({ buffer });
    return result.value?.trim() ? result.value : null;
  }

  if (att.mimeType === XLSX_MIME || att.mimeType === 'application/vnd.ms-excel') {
    const buffer = await download(att.url);
    return extractXlsxSharedStrings(buffer);
  }

  return null;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Téléchargement échoué : HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Extraction légère du contenu textuel d'un XLSX sans dépendance lourde. */
async function extractXlsxSharedStrings(buffer: Buffer): Promise<string | null> {
  const zip = await JSZip.loadAsync(buffer);
  const shared = zip.file('xl/sharedStrings.xml');
  if (!shared) return null;
  const xml = await shared.async('text');
  const values = [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]);
  const text = values.join(' ').trim();
  return text.length > 0 ? text : null;
}
