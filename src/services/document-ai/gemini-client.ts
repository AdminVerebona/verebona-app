/**
 * Analyse documentaire historique — passes `extract_full` et `detect_groups`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PASSE PAR LA PASSERELLE (plan de retrait WF-41, E-05)
 *
 * Ce module instanciait le SDK Gemini, uploadait lui-même les PDF et vidéos
 * vers la Files API et enchaînait trois modèles codés en dur. Il passe
 * désormais par `AiGateway.execute`, sous l'opération
 * `legacy_document_analysis` de l'usage SOURCE_ANALYSIS (T1) : trace, coût
 * et jetons, arrêt d'urgence et état de T1 (`AI_BLOCKED`), disjoncteur, clé
 * du BO, modèles et plafonds de la version figée de T1.
 *
 * Inchangés : les gabarits de prompt et leurs substitutions, la préparation
 * des contenus (lien web cité, DOCX lu ou ses images scannées, fichiers
 * téléchargés côté serveur ; PDF et vidéos via la Files API, désormais par
 * l'adaptateur), le mode JSON natif, les plafonds de sortie (3 000 / 8 000),
 * le critère de repli (réponse vide ou JSON illisible), le dernier recours en
 * texte libre sur le dernier modèle, puis `{}`.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { executeLegacyPrompt } from '@/services/ai/gateway/legacy-prompt';
import { isAiGatewayError } from '@/services/ai/gateway/errors';
import { isProviderNativeUri } from '@/services/ai/gateway/providers/gemini-files';
import { resolveOperationConfig } from '@/services/ai/config/config-resolver';
import type { AiAttachment } from '@/services/ai/gateway/types';

/** Opération du référentiel portant ce module (usage SOURCE_ANALYSIS, T1). */
export const LEGACY_DOCUMENT_ANALYSIS_OPERATION = 'legacy_document_analysis';

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
  /** Compte analysé : trace, coût et quotas de la passerelle. */
  accountId: number;
  /** Fichiers analysés (`asset_files.id`) — trace de la passerelle. */
  sourceIds?: number[];
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

const VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
  'video/x-matroska',
]);

// PDF et vidéos passent par la Files API (l'adaptateur de la passerelle s'en
// charge) : l'inlineData base64 provoque des réponses vides sur certains PDF
// denses, et les URLs présignées S3 privées ne sont pas lisibles par Gemini.
function isVideoMimeType(mimeType: string): boolean {
  return VIDEO_MIME_TYPES.has(mimeType);
}

function isPdfMimeType(mimeType: string): boolean {
  return mimeType === 'application/pdf';
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

/** Télécharge un fichier côté serveur et le rend en base64 (données en ligne). */
async function downloadAsBase64(url: string): Promise<string> {
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
  return Buffer.from(buffer).toString('base64');
}

/** Prompt de la passe : gabarit du dépôt, substitutions, marqueurs non résolus retirés. */
function buildPromptText(options: GeminiCallOptions): string {
  let promptText = loadPrompt(options.promptVersion);
  if (options.promptSubstitutions) {
    for (const [key, value] of Object.entries(options.promptSubstitutions)) {
      promptText = promptText.replace(`{{${key}}}`, value);
    }
  }
  // Remove any unresolved substitution markers
  return promptText.replace(/\{\{[A-Z_]+\}\}/g, '');
}

/**
 * Contenus transmis au modèle, préparés comme par l'ancien client :
 * - URI GCS (gs://) ou Files API → référencée nativement ;
 * - lien web (text/html) → URL citée en tête de prompt, sans téléchargement
 *   (les sites externes bloquent souvent les robots avec 403/429) ;
 * - DOCX/XLSX → texte extrait en tête de prompt, sinon images scannées
 *   intégrées envoyées en ligne, sinon rien ;
 * - PDF et vidéos → pièce jointe par URL, uploadée vers la Files API par
 *   l'adaptateur (attente de l'état ACTIVE, suppression après l'appel) ;
 * - tout autre fichier → téléchargé côté serveur, envoyé en ligne (base64).
 */
async function prepareContents(options: GeminiCallOptions): Promise<{ prompt: string; attachments: AiAttachment[] }> {
  const promptText = buildPromptText(options);

  const prepared = await Promise.all(options.fileUrls.map(async (url, i): Promise<{ texts: string[]; attachments: AiAttachment[] }> => {
    const mime = options.fileMimeTypes?.[i] ?? options.mimeType;
    if (isProviderNativeUri(url)) {
      return { texts: [], attachments: [{ url, mimeType: mime }] };
    }
    if (mime === 'text/html') {
      return { texts: [`URL du document web : ${url}`], attachments: [] };
    }
    if (isUnsupportedBinaryMime(mime)) {
      const content = await extractDocxContent(url);
      if (content.type === 'text') {
        return { texts: [`Contenu du document (DOCX) :\n${content.value}`], attachments: [] };
      }
      if (content.type === 'images') {
        return {
          texts: [],
          attachments: content.parts.map((p, k) => ({
            url: `${url}#image-${k}`, mimeType: p.inlineData.mimeType, data: p.inlineData.data,
          })),
        };
      }
      // type === 'empty' : DOCX vide ou illisible — le prompt seul, sans contenu binaire
      return { texts: [], attachments: [] };
    }
    if (isVideoMimeType(mime) || isPdfMimeType(mime)) {
      const prefix = isVideoMimeType(mime) ? 'video' : 'pdf';
      return { texts: [], attachments: [{ url, mimeType: mime, displayName: `${prefix}-analysis-${Date.now()}-${i}` }] };
    }
    return { texts: [], attachments: [{ url, mimeType: mime, data: await downloadAsBase64(url) }] };
  }));

  const webLinkTexts = prepared.flatMap((p) => p.texts);
  // Injecter les URLs weblink en tête de prompt
  const prompt = webLinkTexts.length > 0
    ? `${webLinkTexts.join('\n')}\n\n${promptText}`
    : promptText;
  return { prompt, attachments: prepared.flatMap((p) => p.attachments) };
}

function sanitizeJsonText(text: string): string {
  // Supprimer les caractères de contrôle invalides en JSON (sauf \t \n \r)
   
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

/** Critère de repli de l'ancien client : réponse vide ou JSON illisible. */
function isUsableJsonText(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  try { parseJsonFromText(text); return true; } catch { return false; }
}

/**
 * Appelle le modèle via la passerelle, avec la chaîne de repli de la version
 * de configuration de T1 (principal → repli 1 → repli 2), en JSON natif.
 * Repli uniquement sur : échec technique, JSON invalide, sortie vide.
 * Si le DERNIER modèle a échoué sur une sortie invalide, dernier recours en
 * texte libre sur ce même modèle ; en cas d'échec, résultat vide `{}`.
 * `AI_BLOCKED` (arrêt d'urgence, T1 désactivé ou suspendu) est propagé.
 */
export async function callGeminiWithFallback(options: GeminiCallOptions): Promise<GeminiAnalysisResult> {
  const { prompt, attachments } = await prepareContents(options);

  // extract_detail requires more tokens (full transcription of multi-page docs)
  const isDetailPass = options.promptVersion.includes('detail');
  const maxOutputTokensCap = isDetailPass ? 8000 : 3000;

  const base = {
    useCaseCode: 'SOURCE_ANALYSIS' as const,
    operationCode: LEGACY_DOCUMENT_ANALYSIS_OPERATION,
    accountId: options.accountId,
    sourceIds: options.sourceIds,
    prompt,
    attachments,
    accept: isUsableJsonText,
    maxOutputTokensCap,
  };

  try {
    const r = await executeLegacyPrompt(base);
    return toResult(r.data, r);
  } catch (error) {
    const invalidOutput = isAiGatewayError(error)
      && error.code === 'ALL_MODELS_FAILED'
      && error.lastFailureCode === 'INVALID_OUTPUT';
    if (!invalidOutput) throw error;

    // Tentative de dernier recours : dernier modèle de la chaîne, texte libre
    // (Gemini répond en markdown, on extrait le JSON manuellement).
    const configuration = await resolveOperationConfig(LEGACY_DOCUMENT_ANALYSIS_OPERATION);
    const chain = [configuration.primaryModel, ...configuration.fallbackModels];
    const lastIndex = chain.length - 1;
    console.warn(`[GEMINI] JSON forcé échoué sur tous les modèles — tentative texte libre avec ${chain[lastIndex]}.`);
    try {
      const r = await executeLegacyPrompt({ ...base, jsonResponse: false, firstModelIndex: lastIndex, maxModelAttempts: 1 });
      return { ...toResult(r.data, r), usedFallback: true };
    } catch (lastError) {
      if (isAiGatewayError(lastError) && lastError.code === 'AI_BLOCKED') throw lastError;
      console.warn(`[GEMINI] Toutes tentatives échouées pour la passe "${options.promptVersion}" — résultat vide retourné.`);
      return {
        parsed: {}, rawText: '{}', model: chain[lastIndex], usedFallback: true,
        inputTokens: 0, outputTokens: 0, costMicros: 0,
      };
    }
  }
}

function toResult(
  rawText: string,
  r: { model: string; usedFallback: boolean; inputTokens: number; outputTokens: number; costMicros: number },
): GeminiAnalysisResult {
  return {
    parsed: parseJsonFromText(rawText),
    rawText,
    model: r.model,
    usedFallback: r.usedFallback,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costMicros: r.costMicros,
  };
}
