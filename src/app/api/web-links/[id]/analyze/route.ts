/**
 * POST /api/web-links/[id]/analyze
 * Analyse IA d'un lien web (isWebLink = true) :
 *   1. Fetch la page web et extrait le texte brut
 *   2. Appelle Gemini (text-only) avec le prompt extract_agenda
 *   3. Crée un documentAnalysisRun + proposals en base
 *
 * Réservé aux comptes premium.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles, documentAnalysisRuns, documentAnalysisProposals, assets } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { getSession } from '@/lib/auth-guards';
import { AccountService } from '@/services/account-service';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveDocumentTypeCode } from '@/lib/document-type-constants';
import { canConsumeAnalysis, consumeAnalysisCredits } from '@/services/commercial-model.service';

// ─── Constants ────────────────────────────────────────────────────────────────

const NOMINAL_MODEL  = 'gemini-2.5-flash';
const FALLBACK_MODEL = 'gemini-2.5-flash';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadPrompt(): string {
  return readFileSync(
    join(process.cwd(), 'src', 'services', 'document-ai', 'prompts', 'extract_agenda_v1.txt'),
    'utf8'
  );
}

function parseJsonFromText(text: string): unknown {
  try { return JSON.parse(text); } catch {}
  const match = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (match) return JSON.parse(match[1].trim());
  throw new Error('No valid JSON found in response');
}

async function callGeminiTextOnly(prompt: string): Promise<{ parsed: unknown; rawText: string; model: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const genAI = new GoogleGenerativeAI(apiKey);

  async function tryModel(modelName: string) {
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    if (!text?.trim()) throw new Error('Empty response');
    const parsed = parseJsonFromText(text);
    return { parsed, rawText: text, model: modelName };
  }

  try {
    return await tryModel(NOMINAL_MODEL);
  } catch (err) {
    console.warn('[web-link analyze] Nominal model failed:', (err as Error).message, '— fallback');
    return await tryModel(FALLBACK_MODEL);
  }
}

/** Extrait le texte utile d'une page HTML (strip les balises). */
function extractTextFromHtml(html: string): string {
  // Remove scripts, styles, nav, footer, header blocks
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Strip remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/\s{2,}/g, ' ')
    .trim();

  return text;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    let session;
    try {
      session = await getSession(request);
    } catch (e) {
      return NextResponse.json({ error: 'AUTH_REQUIRED', message: 'Authentification requise' }, { status: 401 });
    }
    const { id: rawId } = await params;
    const accountId = session.currentAccountId ?? (await AccountService.getUserDefaultAccount(session.userId))?.id;

    if (!accountId) {
      return NextResponse.json({ error: 'NO_ACCOUNT', message: 'Aucun compte sélectionné' }, { status: 401 });
    }

    const quotaGate = await canConsumeAnalysis(accountId, 1);
    if (!quotaGate.allowed) {
      return NextResponse.json(
        { error: quotaGate.reason || 'ANALYSIS_QUOTA_REACHED', message: 'Quota de documents analysés atteint.' },
        { status: 403 }
      );
    }

    const assetFileId = parseInt(rawId);
    if (isNaN(assetFileId)) {
      return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
    }

    // Fetch the web-link record
    const [file] = await db
      .select()
      .from(assetFiles)
      .where(and(
        eq(assetFiles.id, assetFileId),
        eq(assetFiles.accountId, accountId),
        eq(assetFiles.isWebLink, true)
      ))
      .limit(1);

    if (!file) {
      return NextResponse.json({ error: 'NOT_FOUND', message: 'Lien web introuvable' }, { status: 404 });
    }

    if (!file.webLinkUrl) {
      return NextResponse.json({ error: 'NO_URL', message: 'Ce document ne contient pas d\'URL' }, { status: 400 });
    }

    // Fetch user assets for context
    const userAssets = await db
      .select({ id: assets.id, name: assets.name, category: assets.category, registrationNumber: assets.registrationNumber, subtype: assets.subtype, engineInfo: assets.engineInfo })
      .from(assets)
      .where(and(eq(assets.accountId, accountId), isNull(assets.deletedAt)))
      .limit(50);

    // ── Step 1: Fetch the web page ────────────────────────────────────────────
    let pageText = '';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000); // 15s timeout
      let fetchRes: Response;
      try {
        fetchRes = await fetch(file.webLinkUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Verebona/1.0; +https://verebona.com)',
            'Accept': 'text/html,application/xhtml+xml,*/*',
            'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
          },
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!fetchRes.ok) {
        return NextResponse.json(
          { error: 'FETCH_FAILED', message: `Impossible de récupérer la page (HTTP ${fetchRes.status})` },
          { status: 422 }
        );
      }

      const html = await fetchRes.text();
      pageText = extractTextFromHtml(html);

      if (pageText.trim().length < 30) {
        return NextResponse.json(
          { error: 'EMPTY_PAGE', message: 'La page web ne contient pas assez de texte exploitable' },
          { status: 422 }
        );
      }
    } catch (fetchErr: any) {
      if (fetchErr?.name === 'AbortError') {
        return NextResponse.json(
          { error: 'FETCH_TIMEOUT', message: 'La page a mis trop de temps à répondre' },
          { status: 422 }
        );
      }
      return NextResponse.json(
        { error: 'FETCH_FAILED', message: `Impossible d\'accéder à la page : ${fetchErr.message}` },
        { status: 422 }
      );
    }

    // ── Step 2: Build prompt ──────────────────────────────────────────────────
    const assetContext = userAssets.length > 0
      ? `Biens de l'utilisateur (utiliser pour matchedAssetId) :\n${userAssets.map(a => {
          const plate = a.registrationNumber ? ` [plaque:${a.registrationNumber}]` : '';
          const subtype = a.subtype ? ` [type:${a.subtype}]` : '';
          const engine = a.engineInfo ? ` [moteur:${a.engineInfo}]` : '';
          return `- id:${a.id} "${a.name}" (${a.category})${plate}${subtype}${engine}`;
        }).join('\n')}`
      : '';

    let promptTemplate = loadPrompt();
    promptTemplate = promptTemplate.replace('{{ASSET_CONTEXT}}', assetContext);
    // Remove any remaining unfilled placeholders
    promptTemplate = promptTemplate.replace(/\{\{[A-Z_]+\}\}/g, '');

    const fullPrompt = `${promptTemplate}

--- Contenu de la page web (URL: ${file.webLinkUrl}) ---
${pageText}
--- Fin du contenu ---`;

    // ── Step 3: Create analysis run ───────────────────────────────────────────
    const [run] = await db.insert(documentAnalysisRuns).values({
      assetFileId,
      lotId: null,
      inputFileHash: `weblink-${assetFileId}`,
      promptVersion: 'extract_agenda_v1_text',
      provider: 'gemini',
      model: NOMINAL_MODEL,
      status: 'analyzing',
      isCurrentReference: false,
      startedAt: new Date(),
      accountId,
    }).returning();

    // ── Step 4: Call Gemini ───────────────────────────────────────────────────
    let aiResult: { parsed: unknown; rawText: string; model: string };
    try {
      aiResult = await callGeminiTextOnly(fullPrompt);
    } catch (err) {
      await db.update(documentAnalysisRuns).set({
        status: 'failed',
        finishedAt: new Date(),
        errorMessage: (err as Error).message,
      }).where(eq(documentAnalysisRuns.id, run.id));

      return NextResponse.json({ error: 'AI_ERROR', message: 'Erreur lors de l\'analyse IA' }, { status: 500 });
    }

    const combined = aiResult.parsed as any;
    const extraction = combined;
    const agendaDetection = combined.agenda ?? { detectedDates: [], hasAgendaContent: false };
    const confidence = extraction.extractionConfidence ?? 0.7;

    // ── Step 5: Build & insert proposals ─────────────────────────────────────
    type ProposalInsert = Omit<typeof documentAnalysisProposals.$inferInsert, 'id' | 'createdAt'>;
    const proposalInserts: ProposalInsert[] = [];

    if (extraction.proposedTitle) {
      proposalInserts.push({ runId: run.id, assetFileId, accountId, proposalType: 'field', targetKey: 'retainedTitle', canonicalCode: null, displayLabel: 'Titre du document', proposedValueJson: JSON.stringify(extraction.proposedTitle), confidence: String(confidence), status: 'pending', finalValueJson: null });
    }
    if (extraction.proposedFunctionCode) {
      const resolvedCode = resolveDocumentTypeCode(extraction.proposedFunctionCode);
      proposalInserts.push({ runId: run.id, assetFileId, accountId, proposalType: 'field', targetKey: 'retainedFunctionCode', canonicalCode: resolvedCode, displayLabel: extraction.proposedFunctionLabel ?? resolvedCode, proposedValueJson: JSON.stringify(resolvedCode), confidence: String(confidence), status: 'pending', finalValueJson: null });
    }
    if (extraction.proposedDate) {
      proposalInserts.push({ runId: run.id, assetFileId, accountId, proposalType: extraction.proposedDateType === 'derived' ? 'derived_date' : 'field', targetKey: 'documentDate', canonicalCode: null, displayLabel: 'Date du document', proposedValueJson: JSON.stringify(extraction.proposedDate), confidence: String(confidence), status: 'pending', finalValueJson: null });
    }
    if (extraction.proposedSupplier) {
      proposalInserts.push({ runId: run.id, assetFileId, accountId, proposalType: 'field', targetKey: 'supplier', canonicalCode: null, displayLabel: 'Fournisseur', proposedValueJson: JSON.stringify(extraction.proposedSupplier), confidence: String(confidence), status: 'pending', finalValueJson: null });
    }
    if (extraction.proposedAmountCents != null && !isNaN(extraction.proposedAmountCents)) {
      proposalInserts.push({ runId: run.id, assetFileId, accountId, proposalType: 'field', targetKey: 'amountCents', canonicalCode: null, displayLabel: 'Montant', proposedValueJson: JSON.stringify(extraction.proposedAmountCents), confidence: String(confidence), status: 'pending', finalValueJson: null });
    }
    if (extraction.proposedLinks?.assetReference) {
      proposalInserts.push({ runId: run.id, assetFileId, accountId, proposalType: 'link', targetKey: 'assetReference', canonicalCode: null, displayLabel: 'Bien associé', proposedValueJson: JSON.stringify(extraction.proposedLinks.assetReference), confidence: String(confidence), status: 'pending', finalValueJson: null });
    }
    if (extraction.proposedLinks?.matchedAssetId) {
      const validAsset = userAssets.find(a => a.id === extraction.proposedLinks.matchedAssetId);
      if (validAsset) {
        proposalInserts.push({ runId: run.id, assetFileId, accountId, proposalType: 'link', targetKey: 'matchedAssetId', canonicalCode: null, displayLabel: `Bien associé : ${validAsset.name}`, proposedValueJson: JSON.stringify(extraction.proposedLinks.matchedAssetId), confidence: String(confidence), status: 'pending', finalValueJson: null });
      }
    }

    // Agenda suggestions
    if (agendaDetection.hasAgendaContent && agendaDetection.detectedDates?.length) {
      for (const d of agendaDetection.detectedDates) {
        if (d.confidence < 0.5) continue;
        proposalInserts.push({
          runId: run.id, assetFileId, accountId,
          proposalType: 'agenda_suggestion',
          targetKey: 'agenda_item',
          canonicalCode: d.dateType,
          displayLabel: d.label,
          proposedValueJson: JSON.stringify({ label: d.label, dateValue: d.dateValue ?? null, dateType: d.dateType, periodicity: d.periodicity ?? null, rawText: d.rawText }),
          confidence: String(d.confidence),
          status: 'pending',
          finalValueJson: null,
        });
      }
    }

    if (proposalInserts.length > 0) {
      await db.insert(documentAnalysisProposals).values(proposalInserts);
    }

    // ── Step 6: Finalize run + update file ────────────────────────────────────
    await db.transaction(async (tx) => {
      await tx.update(documentAnalysisRuns)
        .set({ isCurrentReference: false })
        .where(and(eq(documentAnalysisRuns.assetFileId, assetFileId), eq(documentAnalysisRuns.isCurrentReference, true)));

      await tx.update(documentAnalysisRuns).set({
        status: 'completed',
        isCurrentReference: true,
        model: aiResult.model,
        finishedAt: new Date(),
        rawResponseJson: aiResult.rawText,
      }).where(eq(documentAnalysisRuns.id, run.id));
    });

    // Store extracted text so it's usable by AI suggestions feature
    if (extraction.rawPageText || pageText) {
      await db.update(assetFiles).set({
        lastAnalysisAt: new Date(),
        extractedText: extraction.rawPageText ?? pageText,
      }).where(eq(assetFiles.id, assetFileId));
    }

    await consumeAnalysisCredits(accountId, 1);

    return NextResponse.json({ runId: run.id });

  } catch (error) {
    if (error instanceof Response) return error;
    console.error('POST /api/web-links/[id]/analyze error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
