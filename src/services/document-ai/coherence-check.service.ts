/**
 * coherenceCheckAsset
 * ───────────────────
 * Détecte les incohérences entre les valeurs renseignées sur un bien
 * et le contenu de ses documents. Stocke les alertes dans
 * keyCharacteristics.coherenceAlerts pour affichage dans l'UI.
 *
 * Appelé par le cron horaire (hourly-enrichment) après la passe de remplissage.
 */

import { db } from '@/db';
import { assets, assetFiles } from '@/db/schema';
import { eq, and, isNull, not } from 'drizzle-orm';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
import { AiUsageTracker } from './ai-usage-tracker';
import type { AiBusinessResult } from '@/types/ai-usage';
import { calcCostMicros } from './gemini-client';

const COHERENCE_NOMINAL_MODEL  = 'gemini-1.5-flash-8b';
const COHERENCE_FALLBACK_MODEL = 'gemini-2.5-flash';
const COHERENCE_FALLBACK2_MODEL = 'gemini-2.5-pro';

export interface CoherenceAlert {
  field: string;
  section: string;
  currentValue: string;
  issue: string;
  suggestedValue: string | null;
  sourceDocument: string;
  detectedAt: string;
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && (v.trim() === '' || v.toLowerCase() === 'null')) return true;
  return false;
}

async function callOneModel(model: GenerativeModel, prompt: string): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const result = await model.generateContent(prompt);
  const text = result.response.text();
  const usage = (result.response.usageMetadata ?? {}) as { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  if (!text?.trim()) throw new Error('Empty response from Gemini');
  return {
    text,
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
  };
}

function parseJsonResponse(text: string): unknown {
  const attempts = [
    () => JSON.parse(text),
    () => { const m = text.match(/```(?:json)?\s*([\s\S]+?)```/); if (!m) throw new Error('no block'); return JSON.parse(m[1].trim()); },
    () => { const s = text.indexOf('{'); const e = text.lastIndexOf('}'); if (s === -1 || e <= s) throw new Error('no obj'); return JSON.parse(text.slice(s, e + 1)); },
  ];
  for (const attempt of attempts) {
    try { return attempt(); } catch { /* next */ }
  }
  throw new Error('No valid JSON in Gemini response');
}

async function callGeminiWithUsage(prompt: string): Promise<{ parsed: unknown; inputTokens: number; outputTokens: number; costMicros: number }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  const genAI = new GoogleGenerativeAI(apiKey);

  const jsonConfig = { responseMimeType: 'application/json' as const, maxOutputTokens: 4000 };
  const nominal   = genAI.getGenerativeModel({ model: COHERENCE_NOMINAL_MODEL, generationConfig: jsonConfig });
  const fallback  = genAI.getGenerativeModel({ model: COHERENCE_FALLBACK_MODEL, generationConfig: jsonConfig });
  const fallback2 = genAI.getGenerativeModel({ model: COHERENCE_FALLBACK2_MODEL, generationConfig: jsonConfig });

  let rawText: string;
  let inputTokens = 0;
  let outputTokens = 0;
  let modelUsed = COHERENCE_NOMINAL_MODEL;

  // Tentative 1 : flash-8b (le moins cher)
  try {
    const r = await callOneModel(nominal, prompt);
    rawText = r.text;
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    parseJsonResponse(rawText);
  } catch {
    // Tentative 2 : 2.5-flash
    console.warn(`[coherence-check] ${COHERENCE_NOMINAL_MODEL} failed — fallback sur ${COHERENCE_FALLBACK_MODEL}`);
    try {
      const r = await callOneModel(fallback, prompt);
      rawText = r.text;
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      parseJsonResponse(rawText);
      modelUsed = COHERENCE_FALLBACK_MODEL;
    } catch {
      // Tentative 3 : 2.5-pro
      console.warn(`[coherence-check] ${COHERENCE_FALLBACK_MODEL} failed — fallback sur ${COHERENCE_FALLBACK2_MODEL}`);
      const r = await callOneModel(fallback2, prompt);
      rawText = r.text;
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      parseJsonResponse(rawText);
      modelUsed = COHERENCE_FALLBACK2_MODEL;
    }
  }

  const costMicros = calcCostMicros(modelUsed, inputTokens, outputTokens);
  return { parsed: parseJsonResponse(rawText!), inputTokens, outputTokens, costMicros };
}

export async function coherenceCheckAsset({
  assetId,
  accountId,
}: {
  assetId: number;
  accountId: number;
}): Promise<{ alertsFound: number }> {
  // 1. Load asset
  const [assetRow] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.accountId, accountId), isNull(assets.deletedAt)))
    .limit(1);

  if (!assetRow || assetRow.status === 'ARCHIVED') return { alertsFound: 0 };

  // 2. Parse existing keyCharacteristics
  let kc: Record<string, unknown> = {};
  try { kc = assetRow.keyCharacteristics ? JSON.parse(assetRow.keyCharacteristics) : {}; } catch {}
  const dismissedFields = new Set<string>(
    Array.isArray(kc.dismissedCoherenceAlerts) ? kc.dismissedCoherenceAlerts as string[] : []
  );

  // Build non-empty current values for the prompt
  const currentValueLines: string[] = [];
  for (const [k, v] of Object.entries(kc)) {
    if (k === 'coherenceAlerts' || k === 'valuationHistory' || k === 'dismissedCoherenceAlerts') continue; // skip meta
    if (dismissedFields.has(k)) continue; // user dismissed this field
    if (!isEmptyValue(v)) currentValueLines.push(`- ${k} = ${JSON.stringify(v)}`);
  }
  // Include asset-level fields
  if (assetRow.name)     currentValueLines.push(`- name = ${JSON.stringify(assetRow.name)}`);
  if (assetRow.address)  currentValueLines.push(`- address1 = ${JSON.stringify(assetRow.address)}`);
  if (assetRow.city)     currentValueLines.push(`- city = ${JSON.stringify(assetRow.city)}`);

  if (currentValueLines.length === 0) return { alertsFound: 0 }; // nothing to check

  // 3. Load documents with extracted text
  const docs = await db
    .select({
      id:               assetFiles.id,
      originalFilename: assetFiles.originalFilename,
      documentType:     assetFiles.documentType,
      extractedText:    assetFiles.extractedText,
      description:      assetFiles.description,
      retainedTitle:    assetFiles.retainedTitle,
    })
    .from(assetFiles)
    .where(and(
      eq(assetFiles.assetId, assetId),
      eq(assetFiles.accountId, accountId),
      isNull(assetFiles.deletedAt),
      not(isNull(assetFiles.extractedText)),
    ));

  const exploitableDocs = docs.filter(d => d.extractedText && d.extractedText.trim().length > 20);
  if (exploitableDocs.length === 0) return { alertsFound: 0 };

  // 4. Build prompt
  const promptTemplate = readFileSync(
    join(process.cwd(), 'src', 'services', 'document-ai', 'prompts', 'coherence_check_v1.txt'),
    'utf8'
  );

  const family = assetRow.category === 'VEHICULE' ? 'VEHICULE'
    : assetRow.category === 'IMMOBILIER' ? 'IMMOBILIER'
    : 'OBJET';

  const seen = new Set<string>();
  const docBlocks: string[] = [];
  for (const doc of exploitableDocs) {
    const hash = doc.extractedText!.substring(0, 200);
    if (seen.has(hash)) continue;
    seen.add(hash);
    const title = doc.retainedTitle || doc.originalFilename || `Document ${doc.id}`;
    docBlocks.push(`--- ${title} (type: ${doc.documentType ?? 'inconnu'}) ---\n${doc.extractedText!}`);
  }

  const prompt = promptTemplate
    .replace('{{FAMILY}}', family)
    .replace('{{ASSET_NAME}}', assetRow.name)
    .replace('{{CURRENT_VALUES}}', currentValueLines.join('\n'))
    .replace('{{DOCUMENTS_TEXT}}', docBlocks.join('\n\n'));

  // 5. Call AI with cost tracking
  let aiResult: unknown;
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicros = 0;
  let opId: number | null = null;

  try {
    opId = await AiUsageTracker.startOperation({
      accountId,
      operationCategory: 'coherence_check',
      origin: 'daily_enrichment',
      isBillable: true,
      environment: 'production',
    });

    const { parsed, inputTokens: i, outputTokens: o, costMicros: c } = await callGeminiWithUsage(prompt);
    aiResult = parsed;
    inputTokens = i; outputTokens = o; costMicros = c;

    await AiUsageTracker.completeOperation({
      operationId: opId,
      businessResult: 'success',
      totalCostMicros: costMicros,
      totalInputTokens: inputTokens,
      totalOutputTokens: outputTokens,
    });
  } catch (err) {
    console.error('[coherence-check] AI call failed:', err);
    if (opId) {
      try {
        await AiUsageTracker.completeOperation({
          operationId: opId,
          businessResult: 'error',
          totalCostMicros: costMicros,
          totalInputTokens: inputTokens,
          totalOutputTokens: outputTokens,
          errorMessage: err instanceof Error ? err.message : 'unknown',
        });
      } catch {}
    }
    return { alertsFound: 0 };
  }

  const result = aiResult as { alerts?: CoherenceAlert[]; hasAlerts?: boolean };
  const rawAlerts = result?.alerts ?? [];

  if (!Array.isArray(rawAlerts) || rawAlerts.length === 0) {
    // Clear any previous alerts — no issues found
    const updatedKc = { ...kc, coherenceAlerts: [] };
    await db.update(assets)
      .set({ keyCharacteristics: JSON.stringify(updatedKc), updatedAt: new Date() } as any)
      .where(eq(assets.id, assetId));
    return { alertsFound: 0 };
  }

  // Stamp with detection date
  const alerts: CoherenceAlert[] = rawAlerts
    .filter(a => a.field && a.issue && !dismissedFields.has(a.field))
    .map(a => ({ ...a, detectedAt: new Date().toISOString() }));

  // 6. Persist alerts into keyCharacteristics
  const updatedKc = { ...kc, coherenceAlerts: alerts };
  await db.update(assets)
    .set({ keyCharacteristics: JSON.stringify(updatedKc), updatedAt: new Date() } as any)
    .where(eq(assets.id, assetId));

  console.log(`[coherence-check] ${assetRow.name} (id=${assetId}): ${alerts.length} alerte(s) détectée(s)`);
  return { alertsFound: alerts.length };
}
