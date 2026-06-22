/**
 * applyAiSuggestionsToAsset
 * ─────────────────────────
 * Service serveur — après l'analyse d'un document, appelé en fire-and-forget
 * pour alimenter silencieusement les champs vides de l'onglet Informations
 * du bien lié, à partir du texte extrait de tous ses documents.
 *
 * Règles :
 *   • Seuls les champs actuellement vides (null / '' / undefined) sont écrits.
 *   • Les champs déjà renseignés ne sont jamais écrasés.
 *   • Le bien doit être ACTIF et appartenir au même compte.
 */

import { db } from '@/db';
import { assets, assetFiles, aiFieldUpdates } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AiUsageTracker } from './ai-usage-tracker';
import type { AiBusinessResult } from '@/types/ai-usage';
import { calcCostMicros } from './gemini-client';
import { isFieldAllowedForCategory } from '@/lib/field-validator';

// ─── Section / field registry (mirrors ai-suggestions/route.ts) ───────────────

const FAMILY_SECTIONS: Record<string, string[]> = {
  IMMOBILIER: ['common', 'location_identification', 'physical_characteristics', 'occupancy_usage', 'performance_technical', 'valuation'],
  VEHICULE:   ['common', 'vehicle_identification', 'vehicle_technical', 'vehicle_usage', 'vehicle_insurance', 'valuation'],
  OBJET:      ['common', 'object_identification', 'object_condition', 'object_provenance', 'object_usage', 'valuation'],
};

const SECTION_FIELDS: Record<string, string[]> = {
  common:                   ['name', 'description', 'acquisitionDate', 'acquisitionPrice', 'acquisitionLocation', 'estimatedValue', 'estimatedValueDate', 'estimatedValueMode', 'notes'],
  location_identification:  ['address1', 'address2', 'postalCode', 'city', 'country', 'cadastralRef', 'lotNumber', 'floor'],
  physical_characteristics: ['livingArea', 'landArea', 'roomCount', 'bedroomCount', 'levels', 'constructionYear', 'generalCondition'],
  occupancy_usage:          ['occupancyUsage', 'occupancyStatus', 'monthlyRent', 'charges', 'occupancyNotes'],
  performance_technical:    ['heatingType', 'mainEnergy', 'dpeClass', 'dpeDate', 'gesClass'],
  valuation:                ['estimatedValue', 'valuationSource', 'valuationDate'],
  vehicle_identification:   ['make', 'model', 'registrationNumber', 'vin', 'year'],
  vehicle_technical:        ['engine', 'fuelType', 'fiscalHp', 'powerKw', 'ptac', 'seats', 'firstRegistrationDate'],
  vehicle_usage:            ['vehicleOwnershipStatus', 'mileage', 'mileageUnit', 'mileageDate', 'primaryUse'],
  vehicle_insurance:        ['isInsured', 'insurer', 'insuranceExpiry', 'insuranceContractNumber', 'insuranceClientNumber', 'insurancePremium', 'nextInspection'],
  object_identification:    ['objectCategory', 'brand', 'modelName', 'serialNumber'],
  object_condition:         ['condition', 'dimensions', 'weight', 'accessories'],
  object_provenance:        ['acquisitionMode', 'provenance', 'authenticityProof'],
  object_usage:             ['primaryUse', 'storageLocation', 'lastRevision', 'isInsured'],
};

// Atomic fields that must be written to dedicated columns in addition to keyCharacteristics JSON
const ATOMIC_FIELDS: Record<string, string> = {
  address1:           'address',
  city:               'city',
  postalCode:         'postalCode',
  registrationNumber: 'registrationNumber',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && (v.trim() === '' || v.toLowerCase() === 'null' || v.toLowerCase() === 'n/a')) return true;
  return false;
}

function normalizeValue(key: string, raw: unknown): unknown {
  if (isEmptyValue(raw)) return null;
  if (key === 'isInsured') {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') return raw === 'true';
    return null;
  }
  const numericFields = ['acquisitionPrice', 'estimatedValue', 'monthlyRent', 'charges', 'livingArea', 'landArea', 'roomCount', 'bedroomCount', 'levels', 'constructionYear', 'powerKw', 'ptac', 'seats', 'mileage', 'weight', 'year', 'insurancePremium'];
  if (numericFields.includes(key)) {
    const n = Number(raw);
    return isNaN(n) ? null : n;
  }
  const dateFields = ['acquisitionDate', 'estimatedValueDate', 'dpeDate', 'firstRegistrationDate', 'mileageDate', 'insuranceExpiry', 'nextInspection', 'lastRevision', 'valuationDate'];
  if (dateFields.includes(key)) {
    const s = String(raw);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    try {
      const d = new Date(s);
      if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    } catch {}
    return null;
  }
  if (typeof raw === 'string' && raw.trim() === '') return null;
  return raw;
}

// ─── AI call ──────────────────────────────────────────────────────────────────

async function callGeminiWithUsage(prompt: string): Promise<{ parsed: unknown; inputTokens: number; outputTokens: number; costMicros: number }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8000 },
  });
  const result = await model.generateContent(prompt);
  const text = result.response.text();
  const usage = (result.response.usageMetadata ?? {}) as { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  const inputTokens = usage.promptTokenCount ?? 0;
  const outputTokens = usage.candidatesTokenCount ?? 0;
  const costMicros = calcCostMicros('gemini-2.5-flash', inputTokens, outputTokens);

  if (!text?.trim()) throw new Error('Empty response from Gemini');
  // Tentatives de parse dans l'ordre de robustesse
  const attempts = [
    () => JSON.parse(text),
    () => { const m = text.match(/```(?:json)?\s*([\s\S]+?)```/); if (!m) throw new Error('no block'); return JSON.parse(m[1].trim()); },
    () => { const s = text.indexOf('{'); const e = text.lastIndexOf('}'); if (s === -1 || e <= s) throw new Error('no obj'); return JSON.parse(text.slice(s, e + 1)); },
  ];
  for (const attempt of attempts) {
    try { return { parsed: attempt(), inputTokens, outputTokens, costMicros }; } catch { /* suivant */ }
  }
  throw new Error('No valid JSON in Gemini response');
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function applyAiSuggestionsToAsset({
  assetId,
  accountId,
  assetFileId: sourceFileId,
}: {
  assetId: number;
  accountId: number;
  assetFileId?: number;
}): Promise<void> {
  // 1. Load asset
  const [assetRow] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.accountId, accountId), isNull(assets.deletedAt)))
    .limit(1);

  if (!assetRow) return;
  if (assetRow.status === 'ARCHIVED') return;

  // 2. Load all documents with extracted text
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
    ));

  const exploitableDocs = docs
    .map(d => ({ ...d, usableText: d.extractedText?.trim() || d.description?.trim() || null }))
    .filter(d => d.usableText && d.usableText.length > 20);

  if (exploitableDocs.length === 0) return;

  // 3. Build current field values from keyCharacteristics
  let kc: Record<string, unknown> = {};
  try { kc = assetRow.keyCharacteristics ? JSON.parse(assetRow.keyCharacteristics) : {}; } catch {}

  // Build currentSections to pass to the prompt (so AI skips already-filled fields)
  const family = assetRow.category === 'VEHICULE' ? 'VEHICULE'
    : assetRow.category === 'IMMOBILIER' ? 'IMMOBILIER'
    : 'OBJET';
  const applicableSections = FAMILY_SECTIONS[family] ?? FAMILY_SECTIONS.OBJET;

  const currentSections: Record<string, Record<string, unknown>> = {};
  for (const s of applicableSections) {
    currentSections[s] = {};
    for (const f of (SECTION_FIELDS[s] ?? [])) {
      // Pull from kc, or from known asset columns
      let val: unknown = kc[f] ?? null;
      if (f === 'name') val = assetRow.name;
      if (f === 'address1') val = (assetRow as any).address ?? kc.address1 ?? null;
      if (f === 'postalCode') val = (assetRow as any).postalCode ?? kc.postalCode ?? null;
      if (f === 'city') val = (assetRow as any).city ?? kc.city ?? null;
      if (f === 'registrationNumber') val = (assetRow as any).registrationNumber ?? kc.registrationNumber ?? null;
      currentSections[s][f] = val;
    }
  }

  // 4. Build prompt
  const promptTemplate = readFileSync(
    join(process.cwd(), 'src', 'services', 'document-ai', 'prompts', 'asset_suggest_v1.txt'),
    'utf8'
  );

  const sectionsForPrompt: Record<string, string[]> = {};
  for (const s of applicableSections) {
    if (SECTION_FIELDS[s]) sectionsForPrompt[s] = SECTION_FIELDS[s];
  }

  const existingValueLines: string[] = [];
  for (const [sectionKey, sectionData] of Object.entries(currentSections)) {
    for (const [fieldKey, value] of Object.entries(sectionData)) {
      if (!isEmptyValue(value)) {
        existingValueLines.push(`- ${sectionKey}.${fieldKey} = ${JSON.stringify(value)}`);
      }
    }
  }

  const seen = new Set<string>();
  const docBlocks: string[] = [];
  for (const doc of exploitableDocs) {
    const hash = doc.usableText!.substring(0, 200);
    if (seen.has(hash)) continue;
    seen.add(hash);
    const title = doc.retainedTitle || doc.originalFilename || `Document ${doc.id}`;
    docBlocks.push(`--- ${title} (type: ${doc.documentType}) ---\n${doc.usableText!}`);
  }

  const prompt = promptTemplate
    .replace('{{FAMILY}}', family)
    .replace('{{ASSET_NAME}}', assetRow.name)
    .replace('{{EXISTING_VALUES}}', existingValueLines.length > 0 ? existingValueLines.join('\n') : '(aucun champ renseigné)')
    .replace('{{SECTIONS_JSON}}', JSON.stringify(sectionsForPrompt, null, 2))
    .replace('{{DOCUMENTS_TEXT}}', docBlocks.join('\n\n'));

  // 5. Call AI (instrumenté pour remonter les coûts "autres traitements" dans le suivi IA admin par compte)
  let aiResult: unknown;
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicros = 0;
  let opId: number | null = null;
  const businessResult: AiBusinessResult = 'success';

  try {
    opId = await AiUsageTracker.startOperation({
      accountId,
      userId: undefined,
      assetFileId: sourceFileId,
      operationCategory: 'enrichissement',
      origin: 'daily_enrichment',
      isBillable: true,
      environment: 'production',
    });

    const { parsed, inputTokens: i, outputTokens: o, costMicros: c } = await callGeminiWithUsage(prompt);
    aiResult = parsed;
    inputTokens = i; outputTokens = o; costMicros = c;

    await AiUsageTracker.completeOperation({
      operationId: opId,
      businessResult,
      totalCostMicros: costMicros,
      totalInputTokens: inputTokens,
      totalOutputTokens: outputTokens,
    });
  } catch (err) {
    console.error('[apply-ai-suggestions] AI call failed:', err);
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
    return;
  }

  const result = aiResult as { sections?: Record<string, Record<string, { value: unknown; confidence: string }>> };
  if (!result?.sections || Object.keys(result.sections).length === 0) return;

  // 6. Apply only to empty fields — merge into kc, write once
  const updatedKc = { ...kc };
  const atomicUpdates: Record<string, unknown> = {};
  let nameUpdate: string | undefined;

  for (const [sectionKey, fieldMap] of Object.entries(result.sections)) {
    if (!applicableSections.includes(sectionKey)) continue;
    if (!fieldMap || typeof fieldMap !== 'object') continue;

    const allowedFields = SECTION_FIELDS[sectionKey] ?? [];

    for (const [fieldKey, suggestion] of Object.entries(fieldMap)) {
      if (!allowedFields.includes(fieldKey)) continue;
      // Defense-in-depth : validation via le registre canonique
      if (!isFieldAllowedForCategory(fieldKey, assetRow.category)) continue;
      if (!suggestion || typeof suggestion !== 'object') continue;

      // Skip if field already has a value
      const existingVal = currentSections[sectionKey]?.[fieldKey];
      if (!isEmptyValue(existingVal)) continue;

      const raw = (suggestion as { value: unknown }).value;
      const normalized = normalizeValue(fieldKey, raw);
      if (normalized === null || normalized === undefined) continue;
      if (typeof normalized === 'string' && normalized.trim() === '') continue;

      if (fieldKey === 'name') {
        nameUpdate = String(normalized).trim();
      } else if (fieldKey in ATOMIC_FIELDS) {
        atomicUpdates[ATOMIC_FIELDS[fieldKey]] = normalized;
        updatedKc[fieldKey] = normalized;
      } else {
        updatedKc[fieldKey] = normalized;
      }
    }
  }

  // 6b. Coherence checks
  const finalOccupancyStatus = updatedKc['occupancyStatus'] ?? kc['occupancyStatus'];
  if (finalOccupancyStatus === 'PROPRIETAIRE') {
    delete updatedKc['monthlyRent'];
  }
  const finalVehicleOwnership = updatedKc['vehicleOwnershipStatus'] ?? kc['vehicleOwnershipStatus'];
  if (finalVehicleOwnership === 'LLD' || finalVehicleOwnership === 'LOA') {
    delete updatedKc['acquisitionPrice'];
  }

  // 7. Persist — single UPDATE
  const updatePayload: Record<string, unknown> = {
    keyCharacteristics: JSON.stringify(updatedKc),
    updatedAt: new Date(),
  };
  if (nameUpdate !== undefined) updatePayload.name = nameUpdate;
  if (atomicUpdates.address !== undefined)            updatePayload.address            = atomicUpdates.address;
  if (atomicUpdates.city !== undefined)               updatePayload.city               = atomicUpdates.city;
  if (atomicUpdates.postalCode !== undefined)         updatePayload.postalCode         = atomicUpdates.postalCode;
  if (atomicUpdates.registrationNumber !== undefined) updatePayload.registrationNumber = atomicUpdates.registrationNumber;

  await db.update(assets)
    .set(updatePayload as any)
    .where(and(eq(assets.id, assetId), eq(assets.accountId, accountId)));

  // Enregistrer l'historique des modifications
  const historyRows: (typeof aiFieldUpdates.$inferInsert)[] = [];
  for (const [fieldKey, newVal] of Object.entries(updatedKc)) {
    const oldVal = kc[fieldKey];
    if (oldVal === newVal) continue; // pas de changement
    if (newVal === null || newVal === undefined) continue;
    historyRows.push({
      accountId,
      assetId,
      assetFileId: sourceFileId ?? null,
      fieldKey,
      oldValue: oldVal != null ? String(oldVal) : null,
      newValue: String(newVal),
    });
  }
  if (nameUpdate !== undefined) {
    historyRows.push({
      accountId,
      assetId,
      assetFileId: sourceFileId ?? null,
      fieldKey: 'name',
      oldValue: assetRow.name,
      newValue: nameUpdate,
    });
  }
  if (historyRows.length > 0) {
    await db.insert(aiFieldUpdates).values(historyRows).catch(() => {/* non-bloquant */});
  }
}
