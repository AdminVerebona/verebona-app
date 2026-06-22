/**
 * analyzeDocument — Service principal d'analyse IA V3.3
 * Contrat : { assetFileId, lotId?, lotItemId?, signedUrl, mimeType, promptVersion }
 * Sortie : { runId, proposals, agendaEffects }
 */

import { db } from '@/db';
import { documentAnalysisRuns, documentAnalysisProposals, assetFiles, documentLotItems } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { callGeminiWithFallback, PROMPT_VERSIONS } from './gemini-client';
import { resolveDocumentTypeCode } from '@/lib/document-type-constants';
import type { AnalyzeDocumentInput, AnalyzeDocumentOutput, Proposal, AgendaEffect } from '@/types/document-ai';

const PROVIDER = 'gemini';

interface SupplierCoordinates {
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
  siren?: string | null;
  siret?: string | null;
  vatNumber?: string | null;
  iban?: string | null;
  ibanHolderName?: string | null;
}

interface DocumentExtractionOutput {
  proposedTitle?: string | null;
  proposedDescription?: string | null;
  proposedFunctionCode?: string | null;
  proposedFunctionLabel?: string | null;
  proposedCilRubricCodes?: string[] | null;
  proposedDate?: string | null;
  proposedDateType?: 'explicit' | 'derived' | null;
  proposedSupplier?: string | null;
  proposedSupplierCoordinates?: SupplierCoordinates | null;
  proposedAmountCents?: number | null;
  proposedLinks?: {
    assetReference?: string | null;
    matchedAssetId?: number | null;
    roomReference?: string | null;
    equipmentReference?: string | null;
  };
  equipmentCandidates?: Array<{
    name: string;
    type: string | null;
    category: string | null;
    confidence: number;
    reason: string;
  }>;
  extractionConfidence?: number;
  extractionNotes?: string | null;
  rawPageText?: string | null;
}

interface AgendaDetectionOutput {
  detectedDates?: Array<{
    label: string;
    dateValue?: string | null;
    dateType: 'start' | 'end' | 'deadline' | 'renewal' | 'periodic';
    periodicity?: string | null;
    confidence: number;
    rawText: string;
    homeCategory?: 'action' | 'information';
  }>;
  hasAgendaContent?: boolean;
  extractionNotes?: string | null;
}

function buildProposalsFromExtraction(
  runId: number,
  assetFileId: number,
  accountId: number,
  extraction: DocumentExtractionOutput,
  confidence: number,
  userAssets?: Array<{ id: number; name: string; category: string; registrationNumber: string | null; subtype: string | null; engineInfo: string | null }>,
  hasManualAssetLink?: boolean
): Omit<typeof documentAnalysisProposals.$inferInsert, 'id' | 'createdAt'>[] {
  const proposals: Omit<typeof documentAnalysisProposals.$inferInsert, 'id' | 'createdAt'>[] = [];

  if (extraction.proposedTitle) {
    proposals.push({
      runId,
      assetFileId,
      accountId,
      proposalType: 'field',
      targetKey: 'retainedTitle',
      canonicalCode: null,
      displayLabel: 'Titre du document',
      proposedValueJson: JSON.stringify(extraction.proposedTitle),
      confidence: String(confidence),
      status: 'pending',
      finalValueJson: null,
    });
  }

  if (extraction.proposedFunctionCode) {
    const resolvedCode = resolveDocumentTypeCode(extraction.proposedFunctionCode);
    proposals.push({
      runId,
      assetFileId,
      accountId,
      proposalType: 'field',
      targetKey: 'retainedFunctionCode',
      canonicalCode: resolvedCode,
      displayLabel: extraction.proposedFunctionLabel ?? resolvedCode,
      proposedValueJson: JSON.stringify(resolvedCode),
      confidence: String(confidence),
      status: 'pending',
      finalValueJson: null,
    });
  }

  if (extraction.proposedCilRubricCodes && extraction.proposedCilRubricCodes.length > 0) {
    proposals.push({
      runId,
      assetFileId,
      accountId,
      proposalType: 'field',
      targetKey: 'cilRubricCodes',
      canonicalCode: null,
      displayLabel: `Rubriques CIL : ${extraction.proposedCilRubricCodes.join(', ')}`,
      proposedValueJson: JSON.stringify(extraction.proposedCilRubricCodes),
      confidence: String(confidence),
      status: 'pending',
      finalValueJson: null,
    });
  }

  if (extraction.proposedDate) {
    proposals.push({
      runId,
      assetFileId,
      accountId,
      proposalType: extraction.proposedDateType === 'derived' ? 'derived_date' : 'field',
      targetKey: 'documentDate',
      canonicalCode: null,
      displayLabel: 'Date du document',
      proposedValueJson: JSON.stringify(extraction.proposedDate),
      confidence: String(confidence),
      status: 'pending',
      finalValueJson: null,
    });
  }

  if (extraction.proposedSupplier) {
    proposals.push({
      runId,
      assetFileId,
      accountId,
      proposalType: 'field',
      targetKey: 'supplier',
      canonicalCode: null,
      displayLabel: 'Fournisseur',
      proposedValueJson: JSON.stringify(extraction.proposedSupplier),
      confidence: String(confidence),
      status: 'pending',
      finalValueJson: null,
    });
  }

  if (extraction.proposedAmountCents != null && !isNaN(extraction.proposedAmountCents)) {
    proposals.push({
      runId,
      assetFileId,
      accountId,
      proposalType: 'field',
      targetKey: 'amountCents',
      canonicalCode: null,
      displayLabel: 'Montant',
      proposedValueJson: JSON.stringify(extraction.proposedAmountCents),
      confidence: String(confidence),
      status: 'pending',
      finalValueJson: null,
    });
  }

  if (extraction.proposedDescription) {
    // Strip any unwanted AI-generated prefixes
    const cleanDesc = extraction.proposedDescription
      .replace(/^(description\s*(visuelle\s*)?(exhaustive\s*)?de\s*l['']image\s*:\s*)/i, '')
      .replace(/^(description\s*:\s*)/i, '')
      .replace(/^(photo\s+de\s+)/i, '')
      .replace(/^(image\s+de\s+)/i, '')
      .replace(/^(document\s+de\s+)/i, '')
      .trim();
    proposals.push({
      runId,
      assetFileId,
      accountId,
      proposalType: 'field',
      targetKey: 'description',
      canonicalCode: null,
      displayLabel: 'Description',
      proposedValueJson: JSON.stringify(cleanDesc),
      confidence: String(confidence),
      status: 'pending',
      finalValueJson: null,
    });
  }

  const assetRef = extraction.proposedLinks?.assetReference;
  if (assetRef) {
    proposals.push({
      runId,
      assetFileId,
      accountId,
      proposalType: 'link',
      targetKey: 'assetReference',
      canonicalCode: null,
      displayLabel: 'Bien associé',
      proposedValueJson: JSON.stringify(assetRef),
      confidence: String(confidence),
      status: 'pending',
      finalValueJson: null,
    });
  }

  // Direct asset match from AI — validate that the id exists in userAssets
  // Quand aucun bien n'est lié manuellement, on plafonne la confiance à 0.6 pour forcer
  // une validation humaine (VALIDATION_REQUIRED) plutôt qu'un auto-commit.
  // Cela évite d'associer des documents génériques (mandats SEPA, RIB…) à un bien par erreur.
  const matchedAssetId = extraction.proposedLinks?.matchedAssetId;
  if (matchedAssetId && userAssets) {
    const validAsset = userAssets.find(a => a.id === matchedAssetId);
    if (validAsset) {
      const assetLinkConfidence = hasManualAssetLink ? confidence : Math.min(confidence, 0.7);
      proposals.push({
        runId,
        assetFileId,
        accountId,
        proposalType: 'link',
        targetKey: 'matchedAssetId',
        canonicalCode: null,
        displayLabel: `Bien associé : ${validAsset.name}`,
        proposedValueJson: JSON.stringify(matchedAssetId),
        confidence: String(assetLinkConfidence),
        status: 'pending',
        finalValueJson: null,
      });
    }
  }

  // Pièce et équipement : uniquement pour les biens immobiliers
  const matchedAsset = matchedAssetId && userAssets ? userAssets.find(a => a.id === matchedAssetId) : null;
  const isImmobilier = matchedAsset?.category === 'IMMOBILIER' || (!matchedAsset && !userAssets?.some(a => a.category !== 'IMMOBILIER'));

  // Types de documents qui par nature ne concernent jamais un équipement ou une pièce spécifique.
  // Peu importe ce que l'IA renvoie, on rejette ces suggestions au niveau du code.
  const docCode = extraction.proposedFunctionCode?.toUpperCase() ?? '';
  const CODES_NO_EQUIPMENT: string[] = [
    'ACTE_TRANSACTION', 'PERMIS_CONSTRUIRE', 'SURFACE_CARREZ', 'EXPERTISE',
    'CONSTAT_SINISTRE', 'PLAN_CADASTRAL', 'PLAN_CONSTRUCTION',
    'DPE', 'AUDIT_ENERGETIQUE', 'AMIANTE', 'PLOMB', 'TERMITES',
    'GAZ', 'ELECTRICITE', 'ASSAINISSEMENT', 'ERNMT',
    'RE2020', 'LABEL_CERTIFICATION', 'ATTESTATION_ASSURANCE',
    'AUTRE', 'VIDEO',
  ];
  const CODES_NO_ROOM: string[] = [
    'ACTE_TRANSACTION', 'PERMIS_CONSTRUIRE', 'SURFACE_CARREZ', 'EXPERTISE',
    'PLAN_CADASTRAL', 'ATTESTATION_ASSURANCE', 'AUTRE', 'VIDEO',
  ];
  const allowEquipment = !CODES_NO_EQUIPMENT.includes(docCode);
  const allowRoom = !CODES_NO_ROOM.includes(docCode);

  const roomRef = extraction.proposedLinks?.roomReference;
  if (roomRef && isImmobilier && allowRoom) {
    proposals.push({
      runId,
      assetFileId,
      accountId,
      proposalType: 'link',
      targetKey: 'roomReference',
      canonicalCode: null,
      displayLabel: 'Pièce associée',
      proposedValueJson: JSON.stringify(roomRef),
      confidence: String(confidence),
      status: 'pending',
      finalValueJson: null,
    });
  }

  const equipmentRef = extraction.proposedLinks?.equipmentReference;
  if (equipmentRef && isImmobilier && allowEquipment) {
    proposals.push({
      runId,
      assetFileId,
      accountId,
      proposalType: 'link',
      targetKey: 'equipmentReference',
      canonicalCode: null,
      displayLabel: 'Équipement associé',
      proposedValueJson: JSON.stringify(equipmentRef),
      confidence: String(confidence),
      status: 'pending',
      finalValueJson: null,
    });
  }

  return proposals;
}

function buildAgendaEffectsFromDetection(
  runId: number,
  assetFileId: number,
  detection: AgendaDetectionOutput
): AgendaEffect[] {
  const effects: AgendaEffect[] = [];

  if (!detection.hasAgendaContent || !detection.detectedDates?.length) {
    return effects;
  }

  for (const date of detection.detectedDates) {
    if (!date.dateValue) continue;
    // All detected dates are created effects to be confirmed at commit time
    effects.push({
      effectType: 'created',
      agendaItemId: null,
      assetFileId,
      runId,
      metadata: {
        label: date.label,
        dateValue: date.dateValue,
        dateType: date.dateType,
        periodicity: date.periodicity,
        confidence: date.confidence,
        homeCategory: date.homeCategory ?? null,
      },
    });
  }

  return effects;
}

export async function analyzeDocument(
  input: AnalyzeDocumentInput & {
    accountId: number;
    userAssets?: Array<{ id: number; name: string; category: string; registrationNumber: string | null; subtype: string | null; engineInfo: string | null }>;
    existingTitles?: string[];
    existingAgendaItems?: Array<{ id?: number; title: string; startDate: string | null; manualStatus?: string | null }>;
    linkedAssetContext?: {
      assetId: number;
      assetName: string;
      assetCategory: string;
      rooms: Array<{ id: number; name: string; roomType: string }>;
      equipments: Array<{ id: number; name: string; type: string | null; category: string | null }>;
    };
    onProgress?: (stage: string) => Promise<void>;
  }
): Promise<AnalyzeDocumentOutput> {
  const { assetFileId, assetFileIds, lotId, signedUrl, signedUrls, mimeType, promptVersion, accountId, userAssets, existingTitles, existingAgendaItems, linkedAssetContext, onProgress } = input;

  const leadFileId = assetFileId;
  const allFileIds = assetFileIds || [leadFileId];
  const allUrls = signedUrls || [signedUrl];

  // Verify lead asset file exists and hash is available
  const [file] = await db.select().from(assetFiles).where(eq(assetFiles.id, leadFileId)).limit(1);
  if (!file) throw new Error(`Asset file ${leadFileId} not found`);
  const userNotesContext = file.notes?.trim()
    ? `Notes ajoutées par l'utilisateur sur ce document (à prendre en compte en priorité pour affiner l'analyse) :\n${file.notes.trim()}`
    : '';
  // sha256Hash may be missing on files copied via transmission — use a stable fallback
  const inputFileHash = file.sha256Hash ?? `no-hash-file-${leadFileId}`;

  // Create run in pending status
  const [run] = await db.insert(documentAnalysisRuns).values({
    assetFileId: leadFileId,
    lotId: lotId ?? null,
    inputFileHash,
    promptVersion,
    provider: PROVIDER,
    model: 'gemini-1.5-pro',
    status: 'pending',
    isCurrentReference: false,
    startedAt: new Date(),
    accountId,
  }).returning();

  await db.update(documentAnalysisRuns).set({ status: 'analyzing' }).where(eq(documentAnalysisRuns.id, run.id));

  try {
    let assetContext = '';
    if (userAssets && userAssets.length > 0) {
      const assetLines = userAssets.map(a => {
        const plate = a.registrationNumber ? ` [plaque:${a.registrationNumber}]` : '';
        const subtype = a.subtype ? ` [type:${a.subtype}]` : '';
        const engine = a.engineInfo ? ` [moteur:${a.engineInfo}]` : '';
        return `- id:${a.id} "${a.name}" (${a.category})${plate}${subtype}${engine}`;
      }).join('\n');
      assetContext = `Biens de l'utilisateur (utiliser pour matchedAssetId) :\n${assetLines}`;
    }

    let existingTitlesContext = '';
    if (existingTitles && existingTitles.length > 0) {
      const titleLines = existingTitles.map(t => `- "${t}"`).join('\n');
      existingTitlesContext = `Titres existants dans la bibliothèque (utiliser pour harmoniser la nomenclature) :\n${titleLines}`;
    }

    let existingAgendaContext = '';
    if (existingAgendaItems && existingAgendaItems.length > 0) {
      const lines = existingAgendaItems.map(i => {
        const status = i.manualStatus === 'realise' ? ' [RÉALISÉ]' : '';
        return `- id:${i.id ?? '?'} "${i.title}"${i.startDate ? ` (${i.startDate})` : ''}${status}`;
      }).join('\n');
      existingAgendaContext = `Événements agenda existants du compte (IMPORTANT : si ce document réalise ou correspond à l'un de ces événements, utiliser son libellé exact dans detectedDates. Ne pas créer un doublon si un événement existant correspond) :\n${lines}`;
    } else {
      existingAgendaContext = 'Aucun événement agenda existant.';
    }

    // Build linked asset context — used when user has manually set the asset before re-analysis
    let linkedAssetContextStr = '';
    if (linkedAssetContext) {
      const lines: string[] = [
        `BIEN DÉJÀ LIÉ MANUELLEMENT (priorité absolue pour matchedAssetId) :`,
        `- id:${linkedAssetContext.assetId} "${linkedAssetContext.assetName}" (${linkedAssetContext.assetCategory})`,
      ];
      if (linkedAssetContext.rooms.length > 0) {
        lines.push(`\nPièces connues de ce bien (information contextuelle) :`);
        for (const r of linkedAssetContext.rooms) {
          lines.push(`  - "${r.name}" (${r.roomType})`);
        }
      }
      // Ne pas injecter la liste des équipements : cela provoquerait du pattern-matching.
      // L'IA doit déduire l'équipement uniquement depuis le contenu du document lui-même.
      lines.push(`\nNOTE : Ce document a été déposé sur ce bien mais vérifie d'abord si le contenu correspond vraiment. Si le document mentionne clairement un autre bien (nom, plaque, adresse), utilise MATCHED_ASSET_ID_DIFFERENT de la section proposéeLinks avec l'id de l'autre bien. Si le document ne mentionne aucun bien en particulier, garde matchedAssetId=${linkedAssetContext.assetId}. Pour roomReference : utilise le nom exact d'une pièce listée ci-dessus UNIQUEMENT si le document traite directement de cette pièce (travaux, photo, diagnostic de cette pièce). Pour equipmentReference : extrais le nom de l'équipement depuis le contenu du document UNIQUEMENT si le document a pour objet principal cet équipement (facture, garantie, notice, contrat d'entretien de cet équipement). Ne jamais déduire un équipement depuis une simple mention dans le texte.`);
      linkedAssetContextStr = lines.join('\n');
    }

    // ── Passe unique (meta + detail + agenda en un seul appel) ────────────────
    await onProgress?.('lecture');
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    await onProgress?.('extraction');
    const fullResult = await callGeminiWithFallback({
      promptVersion: PROMPT_VERSIONS.extract_full,
      fileUrls: allUrls,
      mimeType,
      promptSubstitutions: {
        ASSET_CONTEXT: assetContext,
        EXISTING_TITLES: existingTitlesContext,
        LINKED_ASSET_CONTEXT: linkedAssetContextStr,
        EXISTING_AGENDA_CONTEXT: existingAgendaContext,
        USER_NOTES: userNotesContext,
      },
    });

    totalInputTokens += fullResult.inputTokens;
    totalOutputTokens += fullResult.outputTokens;

    await onProgress?.('analyse');
    const fullParsed = fullResult.parsed as DocumentExtractionOutput & { rawPageText?: string | null; agenda?: AgendaDetectionOutput };
    const extraction = fullParsed;

    // Pour les vidéos : corriger le code fonction et le préfixe du titre si Gemini ne l'a pas fait
    if (mimeType.startsWith('video/')) {
      extraction.proposedFunctionCode = 'VIDEO';
      extraction.proposedFunctionLabel = 'Vidéo';
      if (extraction.proposedTitle && !extraction.proposedTitle.toLowerCase().startsWith('vidéo')) {
        const cleaned = extraction.proposedTitle
          .replace(/^(photo|image|vidéo|video)\s+(de\s+|du\s+|d[''])?/i, '')
          .trim();
        extraction.proposedTitle = `Vidéo – ${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`;
      }
    }

    const confidence = extraction.extractionConfidence ?? 0.7;

    const agendaDetection: AgendaDetectionOutput = fullParsed.agenda ?? { detectedDates: [], hasAgendaContent: false };
    const rawPageText: string | null = fullParsed.rawPageText ?? null;

    if (rawPageText) extraction.rawPageText = rawPageText;

    const modelUsed = fullResult.model;
    const usedFallback = fullResult.usedFallback;

    await onProgress?.('alimentation');
    // Build proposals from extraction - associated with the lead file
    const proposalInserts = buildProposalsFromExtraction(run.id, leadFileId, accountId, extraction, confidence, userAssets, !!linkedAssetContext);
    const insertedProposals: Proposal[] = [];

    if (proposalInserts.length > 0) {
      const inserted = await db.insert(documentAnalysisProposals).values(proposalInserts).returning();
      for (const p of inserted) {
        insertedProposals.push({
          id: p.id,
          runId: p.runId,
          assetFileId: p.assetFileId,
          proposalType: p.proposalType as 'field' | 'link' | 'derived_date' | 'agenda_suggestion',
          targetKey: p.targetKey,
          canonicalCode: p.canonicalCode ?? null,
          displayLabel: p.displayLabel ?? null,
          proposedValueJson: p.proposedValueJson,
          confidence: p.confidence ? parseFloat(p.confidence) : null,
          status: p.status as 'pending',
          finalValueJson: p.finalValueJson ?? null,
          createdAt: p.createdAt.toISOString(),
        });
      }
    }

    // Build agenda effects
    const agendaEffects = buildAgendaEffectsFromDetection(run.id, leadFileId, agendaDetection);

    // Insert agenda suggestions as proposals so the drawer can surface them
    // Filter out suggestions that duplicate already-existing agenda items for this document
    if (agendaDetection.hasAgendaContent && agendaDetection.detectedDates?.length) {
      const normalizeTitle = (s: string) =>
        s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

      const existingNormalized = (existingAgendaItems ?? []).map(i => ({
        norm: normalizeTitle(i.title),
        date: i.startDate,
      }));

      const isDuplicate = (label: string, dateValue: string | null | undefined): boolean => {
        const norm = normalizeTitle(label);
        for (const ex of existingNormalized) {
          // Title similarity: one contains the other or they share ≥60% of tokens
          const aNorm = norm.split(' ').filter(t => t.length > 2);
          const bNorm = ex.norm.split(' ').filter(t => t.length > 2);
          const shared = aNorm.filter(t => bNorm.includes(t)).length;
          const maxLen = Math.max(aNorm.length, bNorm.length, 1);
          const titleMatch = ex.norm === norm || norm.includes(ex.norm) || ex.norm.includes(norm) || shared / maxLen >= 0.6;
          if (!titleMatch) continue;
          // If both have a date, require them to be within 7 days; if either has no date, title match alone is enough
          if (dateValue && ex.date) {
            const diff = Math.abs(new Date(dateValue).getTime() - new Date(ex.date).getTime());
            if (diff > 7 * 24 * 3600 * 1000) continue;
          }
          return true;
        }
        return false;
      };

      const agendaInserts = agendaDetection.detectedDates
        .filter(d => d.confidence >= 0.5 && !isDuplicate(d.label, d.dateValue))
        .map(d => ({
          runId: run.id,
          assetFileId: leadFileId,
          accountId,
          proposalType: 'agenda_suggestion' as const,
          targetKey: 'agenda_item',
          canonicalCode: d.dateType,
          displayLabel: d.label,
          proposedValueJson: JSON.stringify({
            label: d.label,
            dateValue: d.dateValue ?? null,
            dateType: d.dateType,
            periodicity: d.periodicity ?? null,
            rawText: d.rawText,
          }),
          confidence: String(d.confidence),
          status: 'pending' as const,
          finalValueJson: null,
        }));
      if (agendaInserts.length > 0) {
        await db.insert(documentAnalysisProposals).values(agendaInserts);
      }
    }

    // Mark run as completed and set as current reference for ALL files in group
    // Store full meta extraction (including supplierCoordinates) in rawResponseJson
    const fullMetaPayload = JSON.stringify({
      ...fullResult.parsed as Record<string, unknown>,
      _rawText: fullResult.rawText,
    });

    await db.transaction(async (tx) => {
      for (const fid of allFileIds) {
        await tx.update(documentAnalysisRuns)
          .set({ isCurrentReference: false })
          .where(and(eq(documentAnalysisRuns.assetFileId, fid), eq(documentAnalysisRuns.isCurrentReference, true)));
      }

      await tx.update(documentAnalysisRuns).set({
        status: 'completed',
        isCurrentReference: true,
        model: modelUsed,
        finishedAt: new Date(),
        rawResponseJson: fullMetaPayload,
      }).where(eq(documentAnalysisRuns.id, run.id));

      // [E1] Mettre à jour current_analysis_run_id dans document_lot_items pour chaque fichier
      // du groupe, qu'il s'agisse d'un run de lot ou d'une réanalyse unitaire depuis le drawer.
      // Cela garantit que la synthèse de lot reflète toujours le run le plus récent.
      for (const fid of allFileIds) {
        await tx.update(documentLotItems)
          .set({ currentAnalysisRunId: run.id, analysisStatus: 'completed' })
          .where(eq(documentLotItems.assetFileId, fid));
      }
    });

    // Auto-committer les cilRubricCodes et le texte extrait — pas besoin d'approbation utilisateur
    const autoUpdate: Record<string, unknown> = { lastAnalysisAt: new Date() };
    if (extraction.proposedCilRubricCodes && extraction.proposedCilRubricCodes.length > 0) {
      autoUpdate.cilRubricCodes = extraction.proposedCilRubricCodes;
      // Marquer la proposal cilRubricCodes comme auto-committée
      await db.update(documentAnalysisProposals)
        .set({ status: 'kept', finalValueJson: JSON.stringify(extraction.proposedCilRubricCodes) })
        .where(and(
          eq(documentAnalysisProposals.runId, run.id),
          eq(documentAnalysisProposals.targetKey, 'cilRubricCodes'),
        ));
    }
    if (extraction.rawPageText) {
      autoUpdate.extractedText = extraction.rawPageText;
      // description (champ visible utilisateur) est géré via proposal proposedDescription
      // extractedText contient le texte brut ultra-détaillé pour la recherche interne
    }

    // Apply updates to all files in group (all share the same text/rubrics)
    for (const fid of allFileIds) {
      await db.update(assetFiles).set(autoUpdate).where(eq(assetFiles.id, fid));
    }

    const COST_MICROS_PER_TOKEN: Record<string, { input: number; output: number }> = {
      'gemini-2.5-pro':   { input: 1.25,  output: 10.0 },
      'gemini-2.5-flash': { input: 0.075, output: 0.30 },
    };
    const rates = COST_MICROS_PER_TOKEN[modelUsed] ?? COST_MICROS_PER_TOKEN['gemini-2.5-flash'];
    const totalCostMicros = Math.round(totalInputTokens * rates.input + totalOutputTokens * rates.output);

    return {
      runId: run.id,
      proposals: insertedProposals,
      agendaEffects,
      totalInputTokens,
      totalOutputTokens,
      totalCostMicros,
      modelUsed,
      usedFallback,
      equipmentCandidates: extraction.equipmentCandidates ?? undefined,
    };
  } catch (error) {
    // Mark run as failed
    await db.update(documentAnalysisRuns).set({
      status: 'failed',
      finishedAt: new Date(),
      errorMessage: (error as Error).message,
    }).where(eq(documentAnalysisRuns.id, run.id));
    throw error;
  }
}
