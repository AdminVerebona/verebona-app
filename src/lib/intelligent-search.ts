/**
 * intelligent-search.ts
 * Service de recherche intelligente en langage naturel — CDC Verebona V1
 *
 * Pipeline :
 *   1. Détection d'intention (question vs mot-clé)
 *   2. Chargement du contexte account
 *   3. Appel LLM (Gemini) pour génération de réponse
 *   4. Construction sources (résultats SQL classiques comme références)
 *   5. Logging dans ai_search_log
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFileSync } from 'fs';
import { join } from 'path';
import { db, pgClient } from '@/db';
import { aiSearchLog } from '@/db/schema';

const GEMINI_MODEL = 'gemini-2.5-flash';
const TIMEOUT_MS = 25_000;

// Plans Premium autorisés à la recherche intelligente
const PREMIUM_PLANS = new Set(['PREMIUM', 'PREMIUM_DUO', 'PREMIUM_PRO']);

export type ResponseMode =
  | 'answer'
  | 'sources_only'
  | 'upgrade_hint'
  | 'blocked_offer'
  | 'blocked_ambiguous'
  | 'no_result';

export interface SearchSource {
  id: string;
  category: 'Bien' | 'Document' | 'Agenda' | 'Fournisseur';
  label: string;
  sublabel?: string;
  href: string;
  docId?: number;
  supplierId?: number;
  mimeType?: string;
}

export interface IntelligentSearchResponse {
  responseMode: ResponseMode;
  answerText: string | null;
  sources: SearchSource[];
  upgradeHint: string | null;
  blockReason: string | null;
  trackingId: string;
  isIntelligent: true;
}

// ─── Chargement des données compte (même stratégie que gemini-search.ts) ──────

async function loadAccountContext(accountId: number): Promise<string> {
  const [assets, docs, suppliers] = await Promise.all([
    pgClient.unsafe(
      `SELECT id, name, category, subtype, city, notes, address,
              postal_code, status, general_condition, registration_number,
              purchase_date, purchase_location, dimensions, engine_info,
              equipment_list, key_characteristics, object_details, estimated_value_cents
       FROM assets
       WHERE account_id = $1 AND deleted_at IS NULL
       ORDER BY name
       LIMIT 200`,
      [accountId]
    ),
    pgClient.unsafe(
      `SELECT af.id, af.original_filename, af.document_type,
              af.description, af.supplier, af.notes, af.document_date,
              af.retained_title, af.amount_cents, af.retained_function_code,
              af.extracted_text, af.is_web_link, af.web_link_url,
              a.name AS asset_name
       FROM asset_files af
       LEFT JOIN assets a ON a.id = af.asset_id
       WHERE af.account_id = $1
         AND af.deleted_at IS NULL
         AND af.upload_status = 'COMPLETED'
         AND af.is_draft = false
       ORDER BY af.created_at DESC
       LIMIT 200`,
      [accountId]
    ),
    pgClient.unsafe(
      `SELECT id, name, email, phone, city, siret
       FROM suppliers
       WHERE account_id = $1 AND status = 'active'
       ORDER BY name
       LIMIT 100`,
      [accountId]
    ),
  ]);

  const lines: string[] = [];

  lines.push('=== BIENS ===');
  for (const a of assets as any[]) {
    const val = a.estimated_value_cents ? ` valeur_estimee=${(a.estimated_value_cents / 100).toFixed(0)}€` : '';
    lines.push(
      `BIEN id=${a.id} nom="${a.name}" type=${a.category} sous_type=${a.subtype ?? ''} ville="${a.city ?? ''}" statut=${a.status ?? ''} immatriculation=${a.registration_number ?? ''} date_achat=${a.purchase_date ?? ''}${val} notes="${(a.notes ?? '').slice(0, 300)}"`
    );
  }

  lines.push('');
  lines.push('=== DOCUMENTS ===');
  for (const d of docs as any[]) {
    const title = d.retained_title || d.original_filename || '';
    const montant = d.amount_cents != null ? ` montant_ttc=${(d.amount_cents / 100).toFixed(2)}€` : '';
    const text = d.extracted_text ? ` texte="${String(d.extracted_text).replace(/\n+/g, ' ').slice(0, 500)}"` : '';
    lines.push(
      `DOCUMENT id=${d.id} titre="${title}" type=${d.document_type ?? ''} fonction="${d.retained_function_code ?? ''}" bien="${d.asset_name ?? ''}" fournisseur="${d.supplier ?? ''}" date=${d.document_date ?? ''}${montant}${text}`
    );
  }

  lines.push('');
  lines.push('=== FOURNISSEURS ===');
  for (const s of suppliers as any[]) {
    lines.push(
      `FOURNISSEUR id=${s.id} nom="${s.name}" email="${s.email ?? ''}" telephone="${s.phone ?? ''}" ville="${s.city ?? ''}"`
    );
  }

  return lines.join('\n');
}

// ─── Détection d'intention (heuristiques uniquement — pas d'appel LLM) ────────

function detectIntent(query: string): boolean {
  const q = query.trim().toLowerCase();
  const wordCount = q.split(/\s+/).filter(Boolean).length;

  // Trop court → mot-clé
  if (wordCount <= 2) return false;

  const questionPatterns = [
    /^(qui|quel|quelle|quels|quelles|combien|quand|où|comment|est-ce|y a-t-il|qu'est)/i,
    /\?$/,
    /^(quel est|quelle est|quels sont|quelles sont)/i,
    /^(dis-moi|trouve|cherche|montre|c'est quoi|c'est qui)/i,
    /(est-il|est-elle|est-ce que|a-t-il|a-t-elle|avez-vous|ai-je)/i,
    /\b(mon|ma|mes|le|la|les)\b.*\b(assur|garanti|contrat|loyer|prix|montant|date|expir|fourniss)/i,
    /\b(j'ai|j'avais|j'ai payé|j'ai acheté|j'ai souscrit)/i,
  ];

  return questionPatterns.some(r => r.test(q));
}

// ─── Génération de réponse ────────────────────────────────────────────────────

async function generateAnswer(
  query: string,
  context: string,
  offerCode: string
): Promise<{ answer: string; inputTokens: number; outputTokens: number; costMicros: number }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  let promptTemplate: string;
  try {
    promptTemplate = readFileSync(
      join(process.cwd(), 'src', 'services', 'document-ai', 'prompts', 'intelligent_search_v1.txt'),
      'utf8'
    );
  } catch {
    promptTemplate = `Tu es un assistant de gestion patrimoniale.\nRéponds à cette question en te basant UNIQUEMENT sur les données fournies.\nNe fais pas de conseils juridiques ou financiers.\nRéponse courte (max 3 phrases).\n\nDONNÉES :\n{{CONTEXT}}\n\nQUESTION : {{QUERY}}\nRÉPONSE :`;
  }

  // Adapter le prompt pour PREMIUM_PRO (HT/TTC)
  let finalTemplate = promptTemplate;
  if (offerCode === 'PREMIUM_PRO') {
    finalTemplate = finalTemplate.replace(
      'Montants en TTC uniquement (sauf si le compte est PREMIUM_PRO : dans ce cas, indiquer HT et TTC si disponibles).',
      'Indiquer les montants HT et TTC si les deux sont disponibles dans les données. Sinon, indiquer celui disponible.'
    );
  }

  const prompt = finalTemplate.replace('{{QUERY}}', query).replace('{{CONTEXT}}', context);

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  // Estimation coût Gemini 2.5 Flash : ~0.075$/M input, ~0.30$/M output (en micro-€)
  const usageMeta = (result.response as any).usageMetadata;
  const inputTok = usageMeta?.promptTokenCount ?? Math.round(prompt.length / 4);
  const outputTok = usageMeta?.candidatesTokenCount ?? Math.round(text.length / 4);
  // Prix indicatif converti en micro-€ (1$ ≈ 0.92€)
  const costMicros = Math.round((inputTok * 0.075 + outputTok * 0.30) / 1_000_000 * 1_000_000 * 0.92);

  return { answer: text, inputTokens: inputTok, outputTokens: outputTok, costMicros };
}

// ─── Construction des sources (SQL classique post-réponse) ────────────────────

async function buildSources(query: string, accountId: number): Promise<SearchSource[]> {
  const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3).slice(0, 5);
  if (tokens.length === 0) return [];

  function escapeLike(val: string): string {
    return "'" + val.replace(/'/g, "''") + "'";
  }

  const patterns = tokens.map(t => escapeLike('%' + t + '%'));
  // Score ≥ 1 (au moins 1 token) pour les sources, plus large que la recherche classique
  const minScore = 1;

  const assetExprs = patterns.map(p =>
    `(CASE WHEN unaccent(lower(a.name)) ILIKE unaccent(lower(${p})) OR unaccent(lower(coalesce(a.notes,''))) ILIKE unaccent(lower(${p})) THEN 1 ELSE 0 END)`
  ).join(' + ');

  const docExprs = patterns.map(p =>
    `(CASE WHEN unaccent(lower(coalesce(af.retained_title, af.original_filename,''))) ILIKE unaccent(lower(${p})) OR unaccent(lower(coalesce(af.supplier,''))) ILIKE unaccent(lower(${p})) OR unaccent(lower(coalesce(af.document_type,''))) ILIKE unaccent(lower(${p})) THEN 1 ELSE 0 END)`
  ).join(' + ');

  const supplierExprs = patterns.map(p =>
    `(CASE WHEN unaccent(lower(s.name)) ILIKE unaccent(lower(${p})) THEN 1 ELSE 0 END)`
  ).join(' + ');

  const [assetRows, docRows, supplierRows] = await Promise.all([
    pgClient.unsafe(
      `SELECT id, name, category, subtype, city FROM assets a
       WHERE a.account_id = ${accountId} AND a.deleted_at IS NULL AND (${assetExprs}) >= ${minScore}
       ORDER BY (${assetExprs}) DESC LIMIT 3`
    ),
    pgClient.unsafe(
      `SELECT af.id, af.original_filename, af.retained_title, af.document_type, af.mime_type, a.name AS asset_name
       FROM asset_files af LEFT JOIN assets a ON a.id = af.asset_id
       WHERE af.account_id = ${accountId} AND af.deleted_at IS NULL AND af.upload_status = 'COMPLETED' AND af.is_draft = false
       AND (${docExprs}) >= ${minScore}
       ORDER BY (${docExprs}) DESC LIMIT 4`
    ),
    pgClient.unsafe(
      `SELECT id, name, city, email FROM suppliers s
       WHERE s.account_id = ${accountId} AND s.status = 'active' AND (${supplierExprs}) >= ${minScore}
       ORDER BY (${supplierExprs}) DESC LIMIT 2`
    ),
  ]);

  const sources: SearchSource[] = [
    ...(assetRows as any[]).map((r: any) => ({
      id: `asset-${r.id}`,
      category: 'Bien' as const,
      label: r.name,
      sublabel: [r.subtype, r.city].filter(Boolean).join(' · ') || r.category || undefined,
      href: `/assets/${r.id}`,
    })),
    ...(docRows as any[]).map((r: any) => ({
      id: `doc-${r.id}`,
      category: 'Document' as const,
      label: r.retained_title || r.original_filename || 'Document',
      sublabel: r.asset_name || r.document_type || undefined,
      href: `/documents`,
      docId: Number(r.id),
      mimeType: r.mime_type,
    })),
    ...(supplierRows as any[]).map((r: any) => ({
      id: `supplier-${r.id}`,
      category: 'Fournisseur' as const,
      label: r.name,
      sublabel: [r.city, r.email].filter(Boolean).join(' · ') || undefined,
      href: `/fournisseurs`,
      supplierId: Number(r.id),
    })),
  ];

  return sources;
}

// ─── Logging ──────────────────────────────────────────────────────────────────

async function logSearch(params: {
  accountId: number;
  userId: number | null;
  queryText: string;
  responseMode: ResponseMode;
  answerText: string | null;
  sourcesCount: number;
  offerCode: string;
  contextType?: string;
  contextId?: number;
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  provider: string;
  model: string;
  businessResult: string;
  blockReason: string | null;
  trackingId: string;
}) {
  try {
    await db.insert(aiSearchLog).values({
      accountId: params.accountId,
      userId: params.userId,
      queryText: params.queryText,
      responseMode: params.responseMode,
      answerText: params.answerText,
      sourcesCount: params.sourcesCount,
      offerCode: params.offerCode,
      contextType: params.contextType ?? null,
      contextId: params.contextId ?? null,
      costMicros: params.costMicros,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      durationMs: params.durationMs,
      provider: params.provider,
      model: params.model,
      businessResult: params.businessResult,
      blockReason: params.blockReason,
      trackingId: params.trackingId as any,
      environment: process.env.NODE_ENV === 'production' ? 'production' : 'staging',
      createdAt: new Date(),
    });
  } catch (e) {
    console.warn('[intelligent-search] log error:', (e as Error).message);
  }
}

// ─── Point d'entrée public ────────────────────────────────────────────────────

export async function intelligentSearch(params: {
  query: string;
  accountId: number;
  userId: number | null;
  offerCode: string;
  contextType?: string;
  contextId?: number;
}): Promise<IntelligentSearchResponse> {
  const t0 = Date.now();
  const trackingId = crypto.randomUUID();

  const makeResponse = (
    responseMode: ResponseMode,
    answerText: string | null,
    sources: SearchSource[],
    opts: {
      blockReason?: string;
      costMicros?: number;
      inputTokens?: number;
      outputTokens?: number;
      businessResult?: string;
    } = {}
  ): IntelligentSearchResponse => ({
    responseMode,
    answerText,
    sources,
    upgradeHint:
      responseMode === 'upgrade_hint'
        ? 'La recherche intelligente est disponible avec un abonnement Premium.'
        : null,
    blockReason: opts.blockReason ?? null,
    trackingId,
    isIntelligent: true,
  });

  // ── 1. Vérification offre ────────────────────────────────────────────────
  if (!PREMIUM_PLANS.has(params.offerCode)) {
    await logSearch({
      ...params,
      queryText: params.query,
      responseMode: 'upgrade_hint',
      answerText: null,
      sourcesCount: 0,
      costMicros: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - t0,
      provider: '',
      model: '',
      businessResult: 'refused_offer',
      blockReason: 'offer_not_eligible',
      trackingId,
    });
    return makeResponse('upgrade_hint', null, [], { blockReason: 'offer_not_eligible', businessResult: 'refused_offer' });
  }

  // ── 2. Détection d'intention (heuristiques, synchrone) ───────────────────
  const isQuestion = detectIntent(params.query);

  if (!isQuestion) {
    return makeResponse('sources_only', null, [], { businessResult: 'no_intent' });
  }

  // ── 3. Chargement contexte + sources en parallèle, puis génération ───────
  try {
    const [context, sources] = await Promise.all([
      loadAccountContext(params.accountId),
      buildSources(params.query, params.accountId),
    ]);

    const answerPromise = generateAnswer(params.query, context, params.offerCode);
    const timeoutPromise = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('answer timeout')), TIMEOUT_MS)
    );

    const { answer, inputTokens, outputTokens, costMicros } = await Promise.race([
      answerPromise,
      timeoutPromise,
    ]);

    // ── 4. Sources déjà chargées en parallèle ───────────────────────────
    const durationMs = Date.now() - t0;

    await logSearch({
      ...params,
      queryText: params.query,
      responseMode: 'answer',
      answerText: answer,
      sourcesCount: sources.length,
      costMicros,
      inputTokens,
      outputTokens,
      durationMs,
      provider: 'google',
      model: GEMINI_MODEL,
      businessResult: 'success',
      blockReason: null,
      trackingId,
    });

    return makeResponse('answer', answer, sources, { costMicros, inputTokens, outputTokens, businessResult: 'success' });

  } catch (err) {
    const durationMs = Date.now() - t0;
    console.error('[intelligent-search] error:', (err as Error).message);

    await logSearch({
      ...params,
      queryText: params.query,
      responseMode: 'no_result',
      answerText: null,
      sourcesCount: 0,
      costMicros: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs,
      provider: 'google',
      model: GEMINI_MODEL,
      businessResult: 'error',
      blockReason: (err as Error).message,
      trackingId,
    });

    return makeResponse('no_result', null, [], { blockReason: 'internal_error', businessResult: 'error' });
  }
}
