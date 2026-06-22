/**
 * Client Gemini via Google AI Studio (API key) — V3.3
 * Modèle nominal : gemini-1.5-pro
 * Fallback : gemini-2.0-flash — uniquement sur échec technique, sortie invalide, ou sortie vide
 */

import { GoogleGenerativeAI, GenerativeModel, type Part } from '@google/generative-ai';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isVideoMimeType, isPdfMimeType, uploadUrlToGemini, deleteGeminiFile } from './upload-to-gemini';
import mammoth from 'mammoth';
import JSZip from 'jszip';

const NOMINAL_MODEL   = 'gemini-3.1-flash-lite';
const FALLBACK_MODEL  = 'gemini-3.5-flash';
const FALLBACK2_MODEL = 'gemini-2.5-pro';

export const PROMPT_VERSIONS = {
  extract:           'extract_v1',
  extract_full:      'extract_full_v1',   // passe unique méta + détail + agenda
  agenda_detect:     'agenda_detect_v1',
  extract_agenda:    'extract_agenda_v1',
  extract_meta:      'extract_meta_v1',
  extract_detail:    'extract_detail_v1',
  detect_groups:     'detect_groups_v1',
  coherence:         'coherence_v1',
} as const;

export type PromptName = keyof typeof PROMPT_VERSIONS;

function loadPrompt(promptVersion: string): string {
  const promptPath = join(
    process.cwd(),
    'src', 'services', 'document-ai', 'prompts',
    `${promptVersion}.txt`,
  );
  return readFileSync(promptPath, 'utf8');
}

export interface GeminiCallOptions {
  promptVersion: string;
  /** Publicly accessible URLs (S3 presigned) or GCS URIs */
  fileUrls: string[];
  mimeType: string;
  /** Per-file mimeTypes (overrides mimeType when provided, same length as fileUrls) */
  fileMimeTypes?: string[];
  /** Dynamic substitutions in the prompt template, e.g. { ASSET_CONTEXT: '...' } */
  promptSubstitutions?: Record<string, string>;
}

export interface GeminiAnalysisResult {
  parsed: unknown;
  rawText: string;
  model: string;
  usedFallback: boolean;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

// Tarifs Gemini en micros USD par token (1 USD = 1_000_000 micros)
export const COST_MICROS_PER_TOKEN: Record<string, { input: number; output: number }> = {
  'gemini-1.5-flash-8b': { input: 0.0375, output: 0.15  }, // $0.0375/M input, $0.15/M output
  'gemini-2.5-flash':    { input: 0.075,  output: 0.30  }, // $0.075/M input, $0.30/M output
  'gemini-2.5-pro':      { input: 1.25,   output: 10.0  }, // $1.25/M input, $10/M output
};

export function calcCostMicros(model: string, inputTokens: number, outputTokens: number): number {
  const rates = COST_MICROS_PER_TOKEN[model] ?? COST_MICROS_PER_TOKEN['gemini-1.5-flash-8b'];
  return Math.round((inputTokens * rates.input + outputTokens * rates.output));
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Returns true for MIME types Gemini cannot process as binary inline data */
function isUnsupportedBinaryMime(mimeType: string): boolean {
  return mimeType === DOCX_MIME || mimeType === XLSX_MIME ||
    mimeType === 'application/msword' || mimeType === 'application/vnd.ms-excel';
}

const IMAGE_MIME_MAP: Record<string, string> = {
  'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
  'gif': 'image/gif', 'webp': 'image/webp', 'bmp': 'image/bmp',
};

/**
 * Downloads a DOCX and returns either its plain text (if the document has text)
 * or a list of embedded images (if it's a scan with no text layer).
 */
async function extractDocxContent(url: string): Promise<
  | { type: 'text'; value: string }
  | { type: 'images'; parts: Array<{ inlineData: { mimeType: string; data: string } }> }
  | { type: 'empty' }
> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Téléchargement DOCX échoué: HTTP ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Try text extraction first
  const textResult = await mammoth.extractRawText({ buffer });
  if (textResult.value && textResult.value.trim().length > 20) {
    return { type: 'text', value: textResult.value };
  }

  // No text — DOCX probably contains scanned images. Extract them from the ZIP.
  const zip = await JSZip.loadAsync(buffer);
  const imageParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
  const imageFiles = Object.keys(zip.files).filter(name => {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    return name.startsWith('word/media/') && ext in IMAGE_MIME_MAP;
  });

  // Gemini inlineData limit: ~20 MB total. Cap at 10 images to stay safe.
  const capped = imageFiles.slice(0, 10);
  await Promise.all(capped.map(async (name) => {
    const ext = name.split('.').pop()!.toLowerCase();
    const mimeType = IMAGE_MIME_MAP[ext];
    const data = await zip.files[name].async('base64');
    imageParts.push({ inlineData: { mimeType, data } });
  }));

  if (imageParts.length === 0) {
    // DOCX vide ou non lisible — on laisse Gemini analyser sans contenu binaire
    // (il retournera des champs vides mais l'analyse ne plantera pas)
    return { type: 'empty' };
  }
  return { type: 'images', parts: imageParts };
}

async function urlToInlineData(url: string, mimeType: string): Promise<{ inlineData: { mimeType: string; data: string } }> {
  // GCS URIs (gs://) are handled natively by Gemini — pass as fileData
  // S3 presigned URLs must be downloaded server-side and sent as base64 inlineData
  // because Gemini's servers cannot access private S3 buckets
  if (url.startsWith('gs://')) {
    return { inlineData: { mimeType, data: url } }; // won't be used, handled below
  }
  const res = await fetch(url);
  if (!res.ok) {
    const hint = res.status === 403
      ? ' — URL S3 expirée ou accès refusé'
      : res.status === 404
      ? ' — fichier introuvable dans le stockage'
      : '';
    throw new Error(`Téléchargement du fichier échoué: HTTP ${res.status}${hint}`);
  }
  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  return { inlineData: { mimeType, data: base64 } };
}

interface CallModelResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

async function callModel(
  model: GenerativeModel,
  options: GeminiCallOptions,
): Promise<CallModelResult> {
  let promptText = loadPrompt(options.promptVersion);
  if (options.promptSubstitutions) {
    for (const [key, value] of Object.entries(options.promptSubstitutions)) {
      promptText = promptText.replace(`{{${key}}}`, value);
    }
  }
  // Remove any unresolved substitution markers
  promptText = promptText.replace(/\{\{[A-Z_]+\}\}/g, '');

  // Build file parts:
  // - GCS URIs (gs://) → fileData.fileUri (Gemini accès natif)
  // - Weblinks (text/html) → injecté comme texte dans le prompt, pas de binaire à fetcher
  //   (les sites externes bloquent souvent les bots avec 403/429)
  // - Tout autre fichier → téléchargé côté serveur → inlineData base64
  const webLinkTexts: string[] = [];
  const fileParts: Part[] = [];

  await Promise.all(options.fileUrls.map(async (url, i) => {
    const mime = options.fileMimeTypes?.[i] ?? options.mimeType;
    if (url.startsWith('gs://') || url.startsWith('https://generativelanguage.googleapis.com/')) {
      // GCS URI ou Gemini Files API URI — accès natif par Gemini
      fileParts.push({ fileData: { mimeType: mime, fileUri: url } });
    } else if (mime === 'text/html') {
      // Weblink : passer l'URL comme texte, Gemini extrait le titre/contexte sans fetch
      webLinkTexts.push(`URL du document web : ${url}`);
    } else if (isUnsupportedBinaryMime(mime)) {
      // DOCX/XLSX : Gemini ne supporte pas ces MIME types en inlineData.
      // On extrait le texte s'il existe, sinon on récupère les images scannées intégrées.
      const content = await extractDocxContent(url);
      if (content.type === 'text') {
        webLinkTexts.push(`Contenu du document (DOCX) :\n${content.value}`);
      } else if (content.type === 'images') {
        // Images scannées : on les envoie comme inlineData image à Gemini
        fileParts.push(...content.parts);
      }
      // type === 'empty' : DOCX vide ou illisible — on envoie juste le prompt sans contenu binaire
    } else {
      const { inlineData } = await urlToInlineData(url, mime);
      fileParts.push({ inlineData });
    }
  }));

  // Injecter les URLs weblink en tête de prompt
  const fullPrompt = webLinkTexts.length > 0
    ? `${webLinkTexts.join('\n')}\n\n${promptText}`
    : promptText;

  const result = await model.generateContent([
    { text: fullPrompt },
    ...fileParts,
  ]);

  const text = result.response.text();
  if (!text || text.trim().length === 0) {
    throw new Error('Empty response from model');
  }
  const usage = result.response.usageMetadata;
  return {
    text,
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
  };
}

function sanitizeJsonText(text: string): string {
  // Supprimer les caractères de contrôle invalides en JSON (sauf \t \n \r)
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function parseJsonFromText(text: string): unknown {
  const attempts = [
    () => JSON.parse(text),
    () => JSON.parse(sanitizeJsonText(text)),
    // Extraire depuis un bloc ```json ... ```
    () => {
      const m = text.match(/```(?:json)?\s*([\s\S]+?)```/);
      if (!m) throw new Error('no block');
      return JSON.parse(sanitizeJsonText(m[1].trim()));
    },
    // Extraire le premier objet JSON { ... } trouvé dans la réponse
    () => {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start === -1 || end === -1 || end <= start) throw new Error('no object');
      return JSON.parse(sanitizeJsonText(text.slice(start, end + 1)));
    },
  ];

  for (const attempt of attempts) {
    try { return attempt(); } catch { /* essai suivant */ }
  }
  throw new Error('No valid JSON found in response');
}

/**
 * Appelle Gemini avec fallback.
 * Pour les vidéos : uploade d'abord le fichier via Gemini Files API (requis car les URLs
 * presignées S3 privées ne sont pas accessibles par Gemini directement).
 * Fallback uniquement sur : échec technique, JSON invalide, sortie vide.
 */
export async function callGeminiWithFallback(options: GeminiCallOptions): Promise<GeminiAnalysisResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  // ── Vidéos et PDFs : upload préalable vers Gemini Files API ───────────────
  // Gemini ne peut pas récupérer des URLs presignées S3 privées (OVH).
  // On télécharge ces fichiers côté serveur et on les uploade vers l'API Files.
  // Les PDFs passent aussi par l'API Files : l'inlineData base64 provoque des réponses
  // vides sur certains PDFs denses (brochures commerciales, documents multi-pages lourds).
  let resolvedOptions = options;
  const geminiNamesToCleanup: string[] = [];

  const needsFilesApi = options.fileMimeTypes
    ? options.fileMimeTypes.some(m => isVideoMimeType(m) || isPdfMimeType(m))
    : isVideoMimeType(options.mimeType) || isPdfMimeType(options.mimeType);

  if (needsFilesApi) {
    const resolvedUrls: string[] = [];
    const resolvedMimeTypes: string[] = [];

    for (let i = 0; i < options.fileUrls.length; i++) {
      const mime = options.fileMimeTypes?.[i] ?? options.mimeType;
      if (isVideoMimeType(mime) || isPdfMimeType(mime)) {
        const prefix = isVideoMimeType(mime) ? 'video' : 'pdf';
        const displayName = `${prefix}-analysis-${Date.now()}-${i}`;
        const { fileUri, geminiName } = await uploadUrlToGemini(options.fileUrls[i], mime, displayName);
        resolvedUrls.push(fileUri);
        geminiNamesToCleanup.push(geminiName);
      } else {
        resolvedUrls.push(options.fileUrls[i]);
      }
      resolvedMimeTypes.push(mime);
    }

    resolvedOptions = {
      ...options,
      fileUrls: resolvedUrls,
      fileMimeTypes: resolvedMimeTypes,
    };
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  // extract_detail requires more tokens (full transcription of multi-page docs)
  const isDetailPass = options.promptVersion.includes('detail');
  const maxOutputTokens = isDetailPass ? 8000 : 3000;

  // Configs : JSON strict en premier, texte libre en dernier recours
  const jsonConfig  = { maxOutputTokens, responseMimeType: 'application/json' };
  const plainConfig = { maxOutputTokens };

  const nominalModel   = genAI.getGenerativeModel({ model: NOMINAL_MODEL,   generationConfig: jsonConfig });
  const fallbackModel  = genAI.getGenerativeModel({ model: FALLBACK_MODEL,  generationConfig: jsonConfig });
  const fallback2Model = genAI.getGenerativeModel({ model: FALLBACK2_MODEL, generationConfig: jsonConfig });
  // Mode texte libre : dernier recours, Gemini répond en markdown, on extrait le JSON manuellement
  const fallback2PlainModel = genAI.getGenerativeModel({ model: FALLBACK2_MODEL, generationConfig: plainConfig });

  let rawText: string;
  let usedFallback = false;
  let modelUsed = NOMINAL_MODEL;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  try {
    // Tentative 1 : flash-8b (le moins cher), JSON forcé
    try {
      const r = await callModel(nominalModel, resolvedOptions);
      rawText = r.text;
      totalInputTokens += r.inputTokens;
      totalOutputTokens += r.outputTokens;
      parseJsonFromText(rawText);
    } catch (nominalError) {
      console.warn(`[GEMINI] ${NOMINAL_MODEL} failed:`, (nominalError as Error).message, '— fallback sur', FALLBACK_MODEL);

      // Tentative 2 : flash-2.5, JSON forcé
      try {
        const r = await callModel(fallbackModel, resolvedOptions);
        rawText = r.text;
        totalInputTokens += r.inputTokens;
        totalOutputTokens += r.outputTokens;
        parseJsonFromText(rawText);
        usedFallback = true;
        modelUsed = FALLBACK_MODEL;
      } catch (fallbackError) {
        console.warn(`[GEMINI] ${FALLBACK_MODEL} failed:`, (fallbackError as Error).message, '— fallback sur', FALLBACK2_MODEL);

        // Tentative 3 : pro-2.5, JSON forcé
        try {
          const r = await callModel(fallback2Model, resolvedOptions);
          rawText = r.text;
          totalInputTokens += r.inputTokens;
          totalOutputTokens += r.outputTokens;
          parseJsonFromText(rawText);
          usedFallback = true;
          modelUsed = FALLBACK2_MODEL;
        } catch (fallback2Error) {
          const lastMsg = (fallback2Error as Error).message;
          const isJsonParseError = lastMsg.includes('No valid JSON') || lastMsg.includes('Empty response');

          if (!isJsonParseError) {
            throw new Error(`Tous les modèles ont échoué (${NOMINAL_MODEL} → ${FALLBACK_MODEL} → ${FALLBACK2_MODEL}). Dernière erreur : ${lastMsg}`);
          }

          // Tentative 4 : pro-2.5 en texte libre (dernier recours)
          console.warn(`[GEMINI] JSON forcé échoué sur tous les modèles — tentative texte libre avec ${FALLBACK2_MODEL}.`);
          try {
            const r = await callModel(fallback2PlainModel, resolvedOptions);
            rawText = r.text;
            totalInputTokens += r.inputTokens;
            totalOutputTokens += r.outputTokens;
            parseJsonFromText(rawText);
            usedFallback = true;
            modelUsed = FALLBACK2_MODEL;
          } catch {
            console.warn(`[GEMINI] Toutes tentatives échouées pour la passe "${options.promptVersion}" — résultat vide retourné.`);
            rawText = '{}';
            usedFallback = true;
            modelUsed = FALLBACK2_MODEL;
          }
        }
      }
    }
  } finally {
    await Promise.all(geminiNamesToCleanup.map(name => deleteGeminiFile(name)));
  }

  return {
    parsed: parseJsonFromText(rawText!),
    rawText: rawText!,
    model: modelUsed,
    usedFallback,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    costMicros: calcCostMicros(modelUsed, totalInputTokens, totalOutputTokens),
  };
}
