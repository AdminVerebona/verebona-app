/**
 * Combined enrichment + coherence check — single Gemini call.
 *
 * Fusionne les deux appels séparés (applyAiSuggestionsToAsset + coherenceCheckAsset)
 * en un seul appel Gemini, divisant par deux le coût de la passe horaire.
 */

import { db } from '@/db';
import { assets, assetFiles, aiFieldUpdates, agendaItems, agendaAssetLinks } from '@/db/schema';
import { eq, and, isNull, not, or, inArray } from 'drizzle-orm';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
import { AiUsageTracker } from './ai-usage-tracker';
import { emitAssetUpdated } from '../coherence/impact-propagation.service';
import { getAllowedFieldsSet } from '@/lib/field-validator';
import { calcCostMicros } from './gemini-client';
import type { AiBusinessResult } from '@/types/ai-usage';

// ─── Section / field registry (mirrors apply-ai-suggestions.ts) ──────────

const FAMILY_SECTIONS: Record<string, string[]> = {
  IMMOBILIER: ['common', 'location_identification', 'physical_characteristics', 'occupancy_usage', 'performance_technical', 'valuation', 'insurance'],
  VEHICULE:   ['common', 'vehicle_identification', 'vehicle_technical', 'vehicle_usage', 'vehicle_insurance', 'valuation'],
  OBJET:      ['common', 'object_identification', 'object_condition', 'object_provenance', 'object_usage', 'valuation', 'insurance'],
};

const SECTION_FIELDS: Record<string, string[]> = {
  common:                   ['name', 'description', 'acquisitionDate', 'acquisitionPrice', 'acquisitionLocation', 'notes'],
  location_identification:  ['address1', 'address2', 'postalCode', 'city', 'country', 'cadastralRef', 'lotNumber', 'floor', 'gpsCoords'],
  physical_characteristics: ['livingArea', 'landArea', 'roomCount', 'bedroomCount', 'levels', 'constructionYear', 'generalCondition'],
  occupancy_usage:          ['occupancyUsage', 'occupancyStatus', 'monthlyRent', 'charges', 'occupancyNotes'],
  performance_technical:    ['heatingType', 'mainEnergy', 'dpeClass', 'dpeDate', 'gesClass', 'networks'],
  valuation:                ['estimatedValue', 'valuationSource', 'valuationDate'],
  vehicle_identification:   ['make', 'model', 'registrationNumber', 'vin', 'year'],
  vehicle_technical:        ['engine', 'fuelType', 'fiscalHp', 'powerKw', 'ptac', 'seats', 'firstRegistrationDate'],
  vehicle_usage:            ['vehicleOwnershipStatus', 'mileage', 'mileageUnit', 'mileageDate', 'primaryUse'],
  vehicle_insurance:        ['isInsured', 'insurer', 'insuranceExpiry', 'insuranceContractNumber', 'insuranceClientNumber', 'insurancePremium', 'nextInspection'],
  object_identification:    ['objectCategory', 'brand', 'modelName', 'serialNumber'],
  object_condition:         ['condition', 'dimensions', 'weight', 'accessories'],
  object_provenance:        ['acquisitionMode', 'provenance', 'authenticityProof'],
  object_usage:             ['primaryUse', 'storageLocation', 'lastRevision', 'isInsured'],
  insurance:                ['isInsured', 'insurer', 'insuranceContractNumber', 'insuranceClientNumber', 'insuranceExpiry', 'insurancePremium'],
};

const ATOMIC_FIELDS: Record<string, string> = {
  address1:           'address',
  city:               'city',
  postalCode:         'postalCode',
  registrationNumber: 'registrationNumber',
};

// ─── Helpers ──────────────────────────────────────────────────────────────

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

// ─── AI call with fallback ─────────────────────────────────────────────────

const COHERENCE_NOMINAL_MODEL   = 'gemini-3.1-flash-lite';
const COHERENCE_FALLBACK_MODEL  = 'gemini-2.5-flash-lite';
const COHERENCE_FALLBACK2_MODEL = 'gemini-2.0-flash-lite';

const MODEL_TIMEOUT_MS = 45_000; // 45s par appel modèle — échoue vite si le modèle n'est pas disponible

async function callOneModel(model: GenerativeModel, prompt: string): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const result = await model.generateContent(prompt, { timeout: MODEL_TIMEOUT_MS });
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

async function callGeminiCombined(prompt: string): Promise<{ parsed: unknown; inputTokens: number; outputTokens: number; costMicros: number }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  const genAI = new GoogleGenerativeAI(apiKey);

  const jsonConfig = { responseMimeType: 'application/json' as const, maxOutputTokens: 8000 };
  const nominal   = genAI.getGenerativeModel({ model: COHERENCE_NOMINAL_MODEL, generationConfig: jsonConfig });
  const fallback  = genAI.getGenerativeModel({ model: COHERENCE_FALLBACK_MODEL, generationConfig: jsonConfig });
  const fallback2 = genAI.getGenerativeModel({ model: COHERENCE_FALLBACK2_MODEL, generationConfig: jsonConfig });
  let rawText: string = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let modelUsed = COHERENCE_NOMINAL_MODEL;

  try {
    const r = await callOneModel(nominal, prompt);
    rawText = r.text;
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    parseJsonResponse(rawText);
  } catch (err) {
    console.warn(`[enrich-coherence] ${COHERENCE_NOMINAL_MODEL} failed (${err instanceof Error ? err.message.slice(0, 80) : err}) — fallback on ${COHERENCE_FALLBACK_MODEL}`);
    try {
      const r = await callOneModel(fallback, prompt);
      rawText = r.text;
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      parseJsonResponse(rawText);
      modelUsed = COHERENCE_FALLBACK_MODEL;
    } catch {
      console.warn(`[enrich-coherence] ${COHERENCE_FALLBACK_MODEL} failed — fallback on ${COHERENCE_FALLBACK2_MODEL}`);
      try {
        const r = await callOneModel(fallback2, prompt);
        rawText = r.text;
        inputTokens += r.inputTokens;
        outputTokens += r.outputTokens;
        parseJsonResponse(rawText);
        modelUsed = COHERENCE_FALLBACK2_MODEL;
      } catch {
        // Tous les Flash-lite ont echoue -> on propage l'erreur
        throw new Error('Tous les modeles Flash-lite ont echoue');
      }
    }
  }

  const costMicros = calcCostMicros(modelUsed, inputTokens, outputTokens);
  return { parsed: parseJsonResponse(rawText!), inputTokens, outputTokens, costMicros };
}

// ─── Combined function ──────────────────────────────────────────────────────

export interface CoherenceAlertFromCombined {
  field: string;
  section: string;
  currentValue: string;
  issue: string;
  suggestedValue: string | null;
  sourceDocument: string;
  detectedAt: string;
}

export interface EnrichAndCoherenceResult {
  enriched: boolean;
  alertsFound: number;
  updatesApplied: number;
}

export async function applyAiEnrichmentAndCoherence({
  assetId,
  accountId,
}: {
  assetId: number;
  accountId: number;
}): Promise<EnrichAndCoherenceResult> {
  // 1. Load asset
  const [assetRow] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.accountId, accountId), isNull(assets.deletedAt)))
    .limit(1);

  if (!assetRow || assetRow.status === 'ARCHIVED') return { enriched: false, alertsFound: 0, updatesApplied: 0 };

  // 2. Parse existing keyCharacteristics
  let kc: Record<string, unknown> = {};
  try { kc = assetRow.keyCharacteristics ? JSON.parse(assetRow.keyCharacteristics) : {}; } catch {}

  const family = assetRow.category === 'VEHICULE' ? 'VEHICULE'
    : assetRow.category === 'IMMOBILIER' ? 'IMMOBILIER'
    : 'OBJET';

  const applicableSections = FAMILY_SECTIONS[family] ?? [];

  // Build sections JSON for the prompt (only applicable sections)
  const sectionsForPrompt: Record<string, string[]> = {};
  for (const sk of applicableSections) {
    const allowed = SECTION_FIELDS[sk] ?? [];
    if (allowed.length > 0) sectionsForPrompt[sk] = allowed;
  }

  // Current sections from keyCharacteristics
  const currentSections: Record<string, Record<string, unknown>> = {};
  for (const sk of applicableSections) {
    currentSections[sk] = {};
    for (const fk of (SECTION_FIELDS[sk] ?? [])) {
      if (fk in kc) currentSections[sk][fk] = kc[fk];
    }
  }

  // Build existing values lines for the prompt
  const existingValueLines: string[] = [];
  for (const sectionKey of applicableSections) {
    for (const fieldKey of (SECTION_FIELDS[sectionKey] ?? [])) {
      const value = currentSections[sectionKey]?.[fieldKey];
      if (!isEmptyValue(value)) {
        existingValueLines.push(`- ${sectionKey}.${fieldKey} = ${JSON.stringify(value)}`);
      }
    }
  }

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
      or(
        not(isNull(assetFiles.extractedText)),
        not(isNull(assetFiles.description)),
      ),
    ));

  // 3b. Load agenda items linked to this asset
  const agendaItemsList = await db
    .select({
      id: agendaItems.id,
      title: agendaItems.title,
      startDate: agendaItems.startDate,
      endDate: agendaItems.endDate,
      manualStatus: agendaItems.manualStatus,
      homeCategory: agendaItems.homeCategory,
    })
    .from(agendaItems)
    .innerJoin(agendaAssetLinks, eq(agendaAssetLinks.agendaItemId, agendaItems.id))
    .where(
      and(
        eq(agendaAssetLinks.assetId, assetId),
        isNull(agendaItems.manualStatus), // only pending items
        eq(agendaItems.accountId, accountId),
      ),
    );

  const agendaBlocks: string[] = agendaItemsList.map(item => {
    const dateStr = item.startDate
      ? new Date(item.startDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
      : 'Date non précisée';
    return `- ID:${item.id} | "${item.title}" | ${dateStr} | ${item.homeCategory ?? 'non classé'}`;
  });

  const exploitableDocs = docs.filter(d => d.extractedText && d.extractedText.trim().length > 20);
  const hasAgendaContent = agendaItemsList.length >= 2;
  if (exploitableDocs.length === 0 && !hasAgendaContent) {
    return { enriched: false, alertsFound: 0, updatesApplied: 0 };
  }

  // ── Document type validation guard — prevents AI hallucination on financial fields ──
  // Fields that require SPECIFIC document types before accepting an AI-suggested value.
  // If no linked document has one of these types, the AI's proposal is likely a hallucination.
  const FIELD_VALID_DOC_TYPES: Record<string, string[]> = {
    acquisitionPrice: ['ACTE_TRANSACTION', 'FACTURE', 'DEVIS'],
    estimatedValue:   ['EXPERTISE', 'ACTE_TRANSACTION', 'DEVIS'],
    monthlyRent:      ['CONTRAT', 'FACTURE', 'ACTE_TRANSACTION'],
    charges:          ['FACTURE', 'DEVIS', 'CONTRAT'],
    insurancePremium: ['ATTESTATION_ASSURANCE', 'FACTURE', 'DEVIS'],
    mileage:          ['RAPPORT_ENTRETIEN', 'CONTRAT', 'CERT_ADMIN', 'EXPERTISE', 'FACTURE'],
    livingArea:       ['ACTE_TRANSACTION', 'SURFACE_CARREZ', 'EXPERTISE', 'PLAN_CONSTRUCTION'],
    landArea:         ['ACTE_TRANSACTION', 'EXPERTISE', 'PLAN_CONSTRUCTION'],
    constructionYear: ['ACTE_TRANSACTION', 'EXPERTISE', 'PLAN_CONSTRUCTION', 'CERT_ADMIN', 'PERMIS_CONSTRUIRE'],
    dpeClass:         ['DPE', 'EXPERTISE', 'AUDIT_ENERGETIQUE', 'DIAGNOSTIC'],
    gesClass:         ['DPE', 'EXPERTISE', 'AUDIT_ENERGETIQUE', 'DIAGNOSTIC'],
  };
  const availableDocTypes = new Set(docs.map(d => d.documentType).filter(Boolean));

  function hasValidDocType(fieldKey: string): boolean {
    const validTypes = FIELD_VALID_DOC_TYPES[fieldKey];
    if (!validTypes) return true; // no restriction — any doc type is fine
    return validTypes.some(t => availableDocTypes.has(t));
  }

  // 4. Build prompt from combined template
  const promptTemplate = readFileSync(
    join(process.cwd(), 'src', 'services', 'document-ai', 'prompts', 'enrich_coherence_v1.txt'),
    'utf8'
  );

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
    .replace('{{EXISTING_VALUES}}', existingValueLines.length > 0 ? existingValueLines.join('\n') : '(aucun champ renseigné)')
    .replace('{{SECTIONS_JSON}}', JSON.stringify(sectionsForPrompt, null, 2))
    .replace('{{DOCUMENTS_TEXT}}', docBlocks.join('\n\n'))
    .replace('{{AGENDA_EVENTS}}', hasAgendaContent ? agendaBlocks.join('\n') : '(aucun événement agenda en attente)');

  // 5. Call Gemini (one call, instrumented)
  let aiResult: unknown;
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicros = 0;
  let opId: number | null = null;

  try {
    opId = await AiUsageTracker.startOperation({
      accountId,
      operationCategory: 'enrichissement',
      origin: 'daily_enrichment',
      isBillable: true,
      environment: 'production',
    });

    const { parsed, inputTokens: i, outputTokens: o, costMicros: c } = await callGeminiCombined(prompt);
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
    console.error('[enrich-coherence] AI call failed:', err);
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
    return { enriched: false, alertsFound: 0, updatesApplied: 0 };
  }

  interface AgendaSuggestionResult {
    agendaItemId: number;
    suggestedAction: 'mark_realise';
    reason: string;
    relatedItemIds: number[];
    confidence: number;
  }

  const result = aiResult as {
    sections?: Record<string, Record<string, { value: unknown; confidence: string }>>;
    coherenceUpdates?: Record<string, { oldValue: string; newValue: string; reason: string; sourceDocument: string }>;
    coherenceAlerts?: Array<{ field: string; section: string; currentValue: string; issue: string; suggestedValue: string | null; sourceDocument: string }>;
    hasUsableSuggestions?: boolean;
    hasUpdates?: boolean;
    hasAlerts?: boolean;
    agendaSuggestions?: AgendaSuggestionResult[];
  };

  // 6. Apply enrichment (fill empty fields)
  let enriched = false;
  const updatedKc = { ...kc };
  const atomicUpdates: Record<string, unknown> = {};
  let nameUpdate: string | undefined;

  if (result?.sections && Object.keys(result.sections).length > 0) {
    for (const [sectionKey, fieldMap] of Object.entries(result.sections)) {
      if (!applicableSections.includes(sectionKey)) continue;
      if (!fieldMap || typeof fieldMap !== 'object') continue;

      const allowedFields = SECTION_FIELDS[sectionKey] ?? [];

      for (const [fieldKey, suggestion] of Object.entries(fieldMap)) {
        if (!allowedFields.includes(fieldKey)) continue;
        if (!suggestion || typeof suggestion !== 'object') continue;

        // Skip if field already has a value
        const existingVal = currentSections[sectionKey]?.[fieldKey];
        if (!isEmptyValue(existingVal)) continue;

        // Skip if none of the linked documents match the valid types for this field
        // (protection against AI hallucinating values like acquisitionPrice from a non-sale document)
        if (!hasValidDocType(fieldKey)) {
          console.log(`[enrich-coherence] Saut enrichissement ${fieldKey} pour asset ${assetId} : aucun document de type valide (${(FIELD_VALID_DOC_TYPES[fieldKey] ?? []).join(', ')})`);
          continue;
        }

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
        // Traçabilité : valeur détectée automatiquement par l'IA
        updatedKc[fieldKey + '_origin'] = 'auto';
        enriched = true;
      }
    }

    // Consistency rules
    if (updatedKc['occupancyStatus'] === 'PROPRIETAIRE') {
      delete updatedKc['monthlyRent'];
    }
    const finalVehicleOwnership = updatedKc['vehicleOwnershipStatus'] ?? kc['vehicleOwnershipStatus'];
    if (finalVehicleOwnership === 'LLD' || finalVehicleOwnership === 'LOA') {
      delete updatedKc['acquisitionPrice'];
    }
  }

  // 7. Apply coherence updates (overwrite existing values with document-corrected values)
  const coherenceUpdates = result?.coherenceUpdates ?? {};
  let hadUpdates = false;

  // Détermination des champs autorisés pour cette catégorie de bien
  // (protection contre les hallucinations Gemini qui mélangent les types)
  const allowedFieldsSet = getAllowedFieldsSet(assetRow.category);

  // Determine which sections each field belongs to
  const fieldToSection: Record<string, string> = {};
  for (const sk of applicableSections) {
    for (const fk of (SECTION_FIELDS[sk] ?? [])) {
      fieldToSection[fk] = sk;
    }
  }

  const historyRows: (typeof aiFieldUpdates.$inferInsert)[] = [];
  // Collect alerts for manually-set fields that contradict documents
  const manualFieldAlerts: CoherenceAlertFromCombined[] = [];
  const dismissedFields: string[] = Array.isArray(kc.dismissedCoherenceAlerts)
    ? kc.dismissedCoherenceAlerts as string[]
    : [];

  for (const [fieldKey, update] of Object.entries(coherenceUpdates)) {
    if (!update || !update.newValue || update.newValue === update.oldValue) continue;
    // Ne pas appliquer de mise à jour sur un champ qui n'appartient pas à la catégorie du bien
    // (évite qu'un VEHICULE reçoive les champs d'un OBJET via hallucination Gemini)
    if (fieldKey !== 'name' && !allowedFieldsSet.has(fieldKey)) continue;

    // Protection contre les hallucinations : vérifier que le document source est du bon type
    if (!hasValidDocType(fieldKey)) {
      console.log(`[enrich-coherence] Saut coherenceUpdate ${fieldKey} pour asset ${assetId} : aucun document de type valide (${(FIELD_VALID_DOC_TYPES[fieldKey] ?? []).join(', ')})`);
      continue;
    }

    const normalized = normalizeValue(fieldKey, update.newValue);
    if (normalized === null || normalized === undefined) continue;

    const oldVal = updatedKc[fieldKey];
    const fieldOrigin = kc[fieldKey + '_origin'] as string | undefined;

    // Règle : si le champ a été défini manuellement par l'utilisateur,
    // ne pas remplacer automatiquement → alerte de cohérence
    if (fieldOrigin === 'manual') {
      if (!dismissedFields.includes(fieldKey)) {
        manualFieldAlerts.push({
          field: fieldKey,
          section: fieldToSection[fieldKey] ?? 'common',
          currentValue: String(updatedKc[fieldKey] ?? ''),
          issue: update.reason
            ? `Document contredit cette valeur. ${update.reason}`
            : `Document contredit cette valeur. Valeur document: ${update.newValue}`,
          suggestedValue: String(update.newValue),
          sourceDocument: update.sourceDocument ?? '',
          detectedAt: new Date().toISOString(),
        });
      }
      // Ne pas appliquer la mise à jour automatique pour un champ manuel
      continue;
    }

    // Champ auto-rempli ou sans origine → application automatique de la mise à jour
    if (fieldKey === 'name') {
      nameUpdate = String(normalized).trim();
    } else if (fieldKey in ATOMIC_FIELDS) {
      atomicUpdates[ATOMIC_FIELDS[fieldKey]] = normalized;
      updatedKc[fieldKey] = normalized;
    } else {
      updatedKc[fieldKey] = normalized;
    }
    // Traçabilité : marquer comme détecté automatiquement
    updatedKc[fieldKey + '_origin'] = 'auto';
    hadUpdates = true;

    // Track old value for history if field was updated
    if (oldVal !== undefined && oldVal !== normalized) {
      historyRows.push({
        accountId,
        assetId,
        fieldKey,
        oldValue: String(oldVal),
        newValue: String(normalized),
      });
    }
  }

  // 8. Apply coherence alerts (merge AI alerts + manual-field-turned-alerts, skip dismissed fields)
  const aiAlerts = result?.coherenceAlerts ?? [];
  const rawAlerts = [...manualFieldAlerts, ...(Array.isArray(aiAlerts) ? aiAlerts : [])];
  let alertsFound = 0;

  if (rawAlerts.length > 0) {
    const alerts: CoherenceAlertFromCombined[] = rawAlerts
      .filter(a => a.field && a.issue && !dismissedFields.includes(a.field) && allowedFieldsSet.has(a.field))
      .map(a => ({ ...a, detectedAt: new Date().toISOString() }));
    updatedKc.coherenceAlerts = alerts;
    alertsFound = alerts.length;
  } else {
    // Clear previous alerts if none found
    updatedKc.coherenceAlerts = [];
  }

  // Preserve dismissedCoherenceAlerts in updated key characteristics
  if (dismissedFields.length > 0) {
    updatedKc.dismissedCoherenceAlerts = dismissedFields;
  }

  // 8. Persist — single UPDATE
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

  // 9. Save enrichment history
  // historyRows initialized above, continuing to populate
  for (const [fieldKey, newVal] of Object.entries(updatedKc)) {
    if (fieldKey === 'coherenceAlerts' || fieldKey === 'valuationHistory') continue;
    const oldVal = kc[fieldKey];
    if (oldVal === newVal) continue;
    if (newVal === null || newVal === undefined) continue;
    historyRows.push({
      accountId,
      assetId,
      fieldKey,
      oldValue: oldVal != null ? String(oldVal) : null,
      newValue: String(newVal),
    });
  }
  if (nameUpdate !== undefined && nameUpdate !== assetRow.name) {
    historyRows.push({
      accountId,
      assetId,
      fieldKey: 'name',
      oldValue: assetRow.name,
      newValue: nameUpdate,
    });
  }
  if (historyRows.length > 0) {
    await db.insert(aiFieldUpdates).values(historyRows).catch(() => { /* non-bloquant */ });
  }

  console.log(`[enrich-coherence] ${assetRow.name} (id=${assetId}): enrichi=${enriched}, corrections=${hadUpdates ? Object.keys(coherenceUpdates).length : 0}, alertes=${alertsFound}`);

  // Emettre un evenement d impact pour la propagation en cascade
  if (enriched || hadUpdates || alertsFound > 0) {
    const changedFields: Record<string, unknown> = {};
    if (nameUpdate !== undefined) changedFields.name = nameUpdate;
    for (const [k, v] of Object.entries(updatedKc)) {
      if (k === 'coherenceAlerts' || k === 'valuationHistory' || k === 'dismissedCoherenceAlerts') continue;
      const oldVal = kc[k];
      if (oldVal !== v && v !== null && v !== undefined) changedFields[k] = v;
    }
    emitAssetUpdated(accountId, assetId, changedFields).catch(() => {});
  }

  // 10. Apply agenda suggestions (mark_realise)
  const agendaSuggestions = result?.agendaSuggestions ?? [];
  let agendaApplied = 0;
  for (const suggestion of agendaSuggestions) {
    if (suggestion.confidence < 0.7) continue;
    if (suggestion.suggestedAction !== 'mark_realise') continue;
    try {
      const [current] = await db
        .select({ id: agendaItems.id, manualStatus: agendaItems.manualStatus })
        .from(agendaItems)
        .where(eq(agendaItems.id, suggestion.agendaItemId))
        .limit(1);

      if (!current) continue;
      if (current.manualStatus === 'realise' || current.manualStatus === 'annule') continue;

      await db
        .update(agendaItems)
        .set({ manualStatus: 'realise', updatedAt: new Date() })
        .where(eq(agendaItems.id, suggestion.agendaItemId));

      agendaApplied++;
      console.log(`[enrich-coherence] Agenda ${suggestion.agendaItemId} marqué "réalisé" — ${suggestion.reason}`);
    } catch (err) {
      console.error(`[enrich-coherence] Échec suggestion agenda ${suggestion.agendaItemId}:`, err);
    }
  }

  return { enriched, alertsFound, updatesApplied: hadUpdates ? Object.keys(coherenceUpdates).length : 0 };
}
