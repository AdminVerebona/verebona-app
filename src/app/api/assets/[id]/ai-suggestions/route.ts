/**
 * POST /api/assets/[id]/ai-suggestions
 * Génère des suggestions IA pour les champs de l'onglet Informations d'un bien,
 * en utilisant le texte extrait des documents déjà en base.
 * Réservé aux comptes premium.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets, assetFiles } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { isPremiumPlan } from '@/types/domain';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ─── Section/field registry ───────────────────────────────────────────────────

const FAMILY_SECTIONS: Record<string, string[]> = {
  IMMOBILIER: ['common', 'location_identification', 'physical_characteristics', 'occupancy_usage', 'performance_technical', 'valuation'],
  VEHICULE: ['common', 'vehicle_identification', 'vehicle_technical', 'vehicle_usage', 'vehicle_insurance', 'valuation'],
  OBJET: ['common', 'object_identification', 'object_condition', 'object_provenance', 'object_usage', 'valuation'],
};

// All valid fields per section (must match AssetDetailsTab SECTION_FIELDS exactly)
const SECTION_FIELDS: Record<string, string[]> = {
  common: ['name', 'status', 'description', 'acquisitionDate', 'acquisitionPrice', 'acquisitionCurrency', 'acquisitionLocation', 'estimatedValue', 'estimatedValueCurrency', 'estimatedValueDate', 'estimatedValueMode', 'notes'],
  location_identification: ['address1', 'address2', 'postalCode', 'city', 'country', 'cadastralRef', 'lotNumber', 'floor'],
  physical_characteristics: ['livingArea', 'landArea', 'roomCount', 'bedroomCount', 'levels', 'constructionYear', 'generalCondition'],
  occupancy_usage: ['occupancyUsage', 'occupancyStatus', 'monthlyRent', 'charges', 'occupancyNotes'],
  performance_technical: ['heatingType', 'mainEnergy', 'dpeClass', 'dpeDate', 'gesClass'],
  valuation: ['estimatedValue', 'valuationSource', 'valuationDate'],
  vehicle_identification: ['make', 'model', 'registrationNumber', 'vin', 'year'],
  vehicle_technical: ['engine', 'fuelType', 'fiscalHp', 'powerKw', 'ptac', 'seats', 'firstRegistrationDate'],
  vehicle_usage: ['vehicleOwnershipStatus', 'mileage', 'mileageUnit', 'mileageDate', 'primaryUse'],
  vehicle_insurance: ['isInsured', 'insurer', 'insuranceExpiry', 'nextInspection'],
  object_identification: ['objectCategory', 'brand', 'modelName', 'serialNumber'],
  object_condition: ['condition', 'dimensions', 'weight', 'accessories'],
  object_provenance: ['acquisitionMode', 'provenance', 'authenticityProof'],
  object_usage: ['primaryUse', 'storageLocation', 'lastRevision', 'isInsured'],
};

// ─── Prompt loading ──────────────────────────────────────────────────────────

function loadPrompt(): string {
  return readFileSync(
    join(process.cwd(), 'src', 'services', 'document-ai', 'prompts', 'asset_suggest_v1.txt'),
    'utf8'
  );
}

// ─── Value normalisation ─────────────────────────────────────────────────────

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  if (typeof v === 'string' && v.toLowerCase() === 'null') return true;
  if (typeof v === 'string' && v.toLowerCase() === 'n/a') return true;
  if (typeof v === 'string' && v.toLowerCase() === 'non renseigné') return true;
  return false;
}

function normalizeValue(key: string, raw: unknown): unknown {
  if (isEmptyValue(raw)) return null;

  // Booleans
  if (key === 'isInsured') {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') return raw === 'true';
    return null;
  }

  // Numbers
  const numericFields = ['acquisitionPrice', 'estimatedValue', 'monthlyRent', 'charges', 'livingArea', 'landArea', 'roomCount', 'bedroomCount', 'levels', 'constructionYear', 'powerKw', 'ptac', 'seats', 'mileage', 'weight', 'year'];
  if (numericFields.includes(key)) {
    const n = Number(raw);
    return isNaN(n) ? null : n;
  }

  // Dates — must be ISO YYYY-MM-DD
  const dateFields = ['acquisitionDate', 'estimatedValueDate', 'dpeDate', 'firstRegistrationDate', 'mileageDate', 'insuranceExpiry', 'nextInspection', 'lastRevision', 'valuationDate'];
  if (dateFields.includes(key)) {
    const s = String(raw);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // Try to parse partial dates
    try {
      const d = new Date(s);
      if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    } catch {}
    return null;
  }

  // Final guard — never return empty strings
  if (typeof raw === 'string' && raw.trim() === '') return null;
  return raw;
}

// ─── AI call (text-only) ─────────────────────────────────────────────────────

const NOMINAL_MODEL  = 'gemini-2.5-flash';
const FALLBACK_MODEL = 'gemini-2.5-flash';

async function callGeminiTextOnly(prompt: string): Promise<unknown> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const genAI = new GoogleGenerativeAI(apiKey);

  function parseJson(text: string): unknown {
    try { return JSON.parse(text); } catch {}
    const match = text.match(/```(?:json)?\s*([\s\S]+?)```/);
    if (match) return JSON.parse(match[1].trim());
    throw new Error('No valid JSON in response');
  }

  async function tryModel(modelName: string): Promise<unknown> {
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    if (!text?.trim()) throw new Error('Empty response');
    return parseJson(text);
  }

  try {
    return await tryModel(NOMINAL_MODEL);
  } catch (err1) {
    console.warn('[ai-suggestions] Nominal model failed:', (err1 as Error).message, '— fallback');
    return await tryModel(FALLBACK_MODEL);
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return apiError(400, 'INVALID_INPUT', 'Valid asset ID required');

    let session;
    try {
      session = await SessionService.getSession(request);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    // Premium plan check
    const planType = session.planType ?? '';
    if (!isPremiumPlan(planType)) {
      return apiError(403, 'PLAN_UPGRADE_REQUIRED', 'Cette fonctionnalité est réservée aux comptes premium');
    }

    // Fetch asset
    const [assetRow] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId), isNull(assets.deletedAt)))
      .limit(1);

    if (!assetRow) return apiError(404, 'NOT_FOUND', 'Asset not found');
    if (assetRow.status === 'ARCHIVED') return apiError(403, 'ACCESS_DENIED', 'Asset is archived');

    // Fetch all documents — use extractedText (passe 2) or fall back to description (passe 1)
    const docs = await db
      .select({
        id: assetFiles.id,
        originalFilename: assetFiles.originalFilename,
        documentType: assetFiles.documentType,
        extractedText: assetFiles.extractedText,
        description: assetFiles.description,
        retainedTitle: assetFiles.retainedTitle,
      })
      .from(assetFiles)
      .where(and(
        eq(assetFiles.assetId, assetId),
        eq(assetFiles.accountId, session.currentAccountId),
        isNull(assetFiles.deletedAt),
      ));

    // Use extractedText (full) when available, fall back to description field
    const exploitableDocs = docs
      .map(d => ({ ...d, usableText: d.extractedText?.trim() || d.description?.trim() || null }))
      .filter(d => d.usableText && d.usableText.length > 20);

    if (exploitableDocs.length === 0) {
      return NextResponse.json({ hasUsableSuggestions: false, sections: {}, reason: 'NO_DOCUMENTS' });
    }

    // Read body — optional currentSections passed by the frontend
    let currentSections: Record<string, Record<string, unknown>> = {};
    try {
      const body = await request.json();
      if (body?.currentSections && typeof body.currentSections === 'object') {
        currentSections = body.currentSections;
      }
    } catch { /* no body or invalid JSON — ignore */ }

    // Determine family
    const family = assetRow.category === 'VEHICULE' ? 'VEHICULE'
      : assetRow.category === 'IMMOBILIER' ? 'IMMOBILIER'
      : 'OBJET';

    const applicableSections = FAMILY_SECTIONS[family] ?? FAMILY_SECTIONS.OBJET;

    // Build sections description for prompt (only field names, not values)
    const sectionsForPrompt: Record<string, string[]> = {};
    for (const s of applicableSections) {
      if (SECTION_FIELDS[s]) sectionsForPrompt[s] = SECTION_FIELDS[s];
    }

    // Build existing values summary — list fields that are already non-empty
    const existingValueLines: string[] = [];
    for (const [sectionKey, sectionData] of Object.entries(currentSections)) {
      if (!applicableSections.includes(sectionKey)) continue;
      for (const [fieldKey, value] of Object.entries(sectionData)) {
        if (value === null || value === undefined || value === '') continue;
        if (typeof value === 'string' && value.trim() === '') continue;
        existingValueLines.push(`- ${sectionKey}.${fieldKey} = ${JSON.stringify(value)}`);
      }
    }
    const existingValuesText = existingValueLines.length > 0
      ? existingValueLines.join('\n')
      : '(aucun champ renseigné)';

    // Build documents text block (deduplicated, no character limit)
    const seen = new Set<string>();
    const docBlocks: string[] = [];

    for (const doc of exploitableDocs) {
      const text = doc.usableText!;
      const hash = text.substring(0, 200);
      if (seen.has(hash)) continue;
      seen.add(hash);

      const title = doc.retainedTitle || doc.originalFilename || `Document ${doc.id}`;
      const block = `--- ${title} (type: ${doc.documentType}) ---\n${text}`;
      docBlocks.push(block);
    }

    const documentsText = docBlocks.join('\n\n');

    // Build prompt
    let prompt = loadPrompt();
    prompt = prompt
      .replace('{{FAMILY}}', family)
      .replace('{{ASSET_NAME}}', assetRow.name)
      .replace('{{EXISTING_VALUES}}', existingValuesText)
      .replace('{{SECTIONS_JSON}}', JSON.stringify(sectionsForPrompt, null, 2))
      .replace('{{DOCUMENTS_TEXT}}', documentsText);

    // Call AI
    let aiResult: unknown;
    try {
      aiResult = await callGeminiTextOnly(prompt);
    } catch (err) {
      console.error('[ai-suggestions] AI call failed:', err);
      return NextResponse.json({ error: 'AI_ERROR', message: 'Une erreur est survenue lors de l\'analyse.' }, { status: 500 });
    }

    const result = aiResult as { sections?: Record<string, Record<string, { value: unknown; confidence: string }>>; hasUsableSuggestions?: boolean };

    if (!result?.sections || Object.keys(result.sections).length === 0) {
      return NextResponse.json({ hasUsableSuggestions: false, sections: {} });
    }

    // Sanitize: only keep known sections/fields, normalize values
    const sanitized: Record<string, Record<string, { value: unknown; confidence: 'high' | 'medium' | 'low' }>> = {};

    for (const [sectionKey, fieldMap] of Object.entries(result.sections)) {
      if (!applicableSections.includes(sectionKey)) continue;
      if (!fieldMap || typeof fieldMap !== 'object') continue;

      const allowedFields = SECTION_FIELDS[sectionKey] ?? [];
      const sectionOut: Record<string, { value: unknown; confidence: 'high' | 'medium' | 'low' }> = {};

      for (const [fieldKey, suggestion] of Object.entries(fieldMap)) {
        if (!allowedFields.includes(fieldKey)) continue;
        if (!suggestion || typeof suggestion !== 'object') continue;

        const raw = (suggestion as { value: unknown; confidence?: string }).value;
        const conf = (suggestion as { value: unknown; confidence?: string }).confidence;

        const normalized = normalizeValue(fieldKey, raw);
        if (normalized === null || normalized === undefined) continue;
        if (typeof normalized === 'string' && normalized.trim() === '') continue;

        const confidence: 'high' | 'medium' | 'low' =
          conf === 'high' ? 'high' : conf === 'medium' ? 'medium' : 'low';

        sectionOut[fieldKey] = { value: normalized, confidence };
      }

      if (Object.keys(sectionOut).length > 0) {
        sanitized[sectionKey] = sectionOut;
      }
    }

    // Coherence check — if owner, never suggest monthlyRent
    const suggestedOccupancyStatus = sanitized['occupancy_usage']?.['occupancyStatus']?.value;
    const existingOccupancyStatus  = currentSections['occupancy_usage']?.['occupancyStatus'];
    const finalStatus = suggestedOccupancyStatus ?? existingOccupancyStatus;
    if (finalStatus === 'PROPRIETAIRE') {
      if (sanitized['occupancy_usage']) {
        delete sanitized['occupancy_usage']['monthlyRent'];
        if (Object.keys(sanitized['occupancy_usage']).length === 0) delete sanitized['occupancy_usage'];
      }
    }

    // Coherence check — if LLD/LOA, never suggest acquisitionPrice nor acquisitionDate
    const suggestedVehicleOwnership = sanitized['vehicle_usage']?.['vehicleOwnershipStatus']?.value;
    const existingVehicleOwnership  = currentSections['vehicle_usage']?.['vehicleOwnershipStatus'];
    const finalVehicleOwnership = suggestedVehicleOwnership ?? existingVehicleOwnership;
    if (finalVehicleOwnership === 'LLD' || finalVehicleOwnership === 'LOA') {
      if (sanitized['common']) {
        delete sanitized['common']['acquisitionPrice'];
        delete sanitized['common']['acquisitionDate'];
        if (Object.keys(sanitized['common']).length === 0) delete sanitized['common'];
      }
    }

    const hasUsable = Object.keys(sanitized).length > 0;

    return NextResponse.json({ hasUsableSuggestions: hasUsable, sections: sanitized });

  } catch (error) {
    if (error instanceof Response) return error;
    console.error('POST /api/assets/[id]/ai-suggestions error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
