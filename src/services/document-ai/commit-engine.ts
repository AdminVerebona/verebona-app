/**
 * Moteur de commit V3.3
 * Gère le commit unitaire et le commit de lot.
 * Conformément au tableau Annexe A3 : proposal_type × target_key × moteur de commit
 */

import { db } from '@/db';
import {
  documentAnalysisProposals,
  documentAnalysisRuns,
  documentLots,
  documentLotItems,
  agendaItemSources,
  agendaItems,
  assetFiles,
  accounts,
} from '@/db/schema';
import { eq, and, inArray, isNull, isNotNull } from 'drizzle-orm';
import type { AgendaEffect, CommitResult, LotItemCommitStatus } from '@/types/document-ai';
import { processSupplierFromExtraction } from '@/services/suppliers/supplier-service';
import { linkDocumentToEquipments } from '@/services/equipment/equipment-auto-link.service';

// ─── Column mapping per target_key ─────────────────────────────────────────

const FIELD_COLUMN_MAP: Record<string, keyof typeof assetFiles.$inferInsert> = {
  retainedTitle: 'retainedTitle',
  retainedFunctionCode: 'retainedFunctionCode',
  cilRubricCodes: 'cilRubricCodes',
  description: 'description',
  notes: 'notes',
  documentDate: 'documentDate',
  supplier: 'supplier',
  amountCents: 'amountCents',
};

const LINK_COLUMN_MAP: Record<string, keyof typeof assetFiles.$inferInsert> = {
  assetId: 'assetId',
  matchedAssetId: 'assetId',   // l'IA retourne matchedAssetId → colonne assetId
  linkedAssetId: 'linkedAssetId',
  linkedRoomId: 'linkedRoomId',
  equipmentId: 'equipmentId',
};

// ─── Apply proposals to asset_files ─────────────────────────────────────────

async function applyProposalsToAssetFile(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  assetFileId: number,
  runId: number,
  accountId: number,
): Promise<{ appliedFields: string[]; agendaEffectsFromRun: AgendaEffect[] }> {
  const appliedFields: string[] = [];
  const agendaEffects: AgendaEffect[] = [];
  // Suivi des items agenda déjà matchés/créés dans ce commit pour éviter les doublons
  const resolvedAgendaItemIds = new Set<number>();
  const createdAgendaLabels: string[] = [];

  // Load all non-rejected proposals for this run
  const proposals = await tx
    .select()
    .from(documentAnalysisProposals)
    .where(and(
      eq(documentAnalysisProposals.runId, runId),
      eq(documentAnalysisProposals.assetFileId, assetFileId),
    ));

  // Update pending → kept, modified stays modified
  const pendingIds = proposals.filter(p => p.status === 'pending').map(p => p.id);
  if (pendingIds.length > 0) {
    await tx.update(documentAnalysisProposals)
      .set({ status: 'kept', finalValueJson: null }) // finalValueJson set below per proposal
      .where(inArray(documentAnalysisProposals.id, pendingIds));
  }

  // Build asset_files update object
  const fileUpdate: Partial<typeof assetFiles.$inferInsert> = {};

  for (const proposal of proposals) {
    if (proposal.status === 'rejected') continue;

    // For pending proposals, use proposed_value_json; for modified, use final_value_json
    const valueJson = proposal.status === 'modified' ? proposal.finalValueJson : proposal.proposedValueJson;
    if (!valueJson) continue;

    const value = JSON.parse(valueJson);

    if (proposal.proposalType === 'field') {
      const col = FIELD_COLUMN_MAP[proposal.targetKey];
      if (col) {
        (fileUpdate as Record<string, unknown>)[col] = value;
        appliedFields.push(proposal.targetKey);
      }
      // Update final_value_json for pending proposals (now kept)
      if (proposal.status === 'pending') {
        await tx.update(documentAnalysisProposals)
          .set({ finalValueJson: proposal.proposedValueJson, status: 'kept' })
          .where(eq(documentAnalysisProposals.id, proposal.id));
      }

    } else if (proposal.proposalType === 'link') {
      const col = LINK_COLUMN_MAP[proposal.targetKey];
      if (col) {
        (fileUpdate as Record<string, unknown>)[col] = typeof value === 'number' ? value : parseInt(value);
        appliedFields.push(proposal.targetKey);
      }
      if (proposal.status === 'pending') {
        await tx.update(documentAnalysisProposals)
          .set({ finalValueJson: proposal.proposedValueJson, status: 'kept' })
          .where(eq(documentAnalysisProposals.id, proposal.id));
      }

    } else if (proposal.proposalType === 'derived_date') {
      // derived_date → Agenda engine (handled separately via agendaEffects)
      const effect: AgendaEffect = {
        effectType: 'created',
        agendaItemId: null,
        assetFileId,
        runId,
        metadata: value,
      };
      agendaEffects.push(effect);
      if (proposal.status === 'pending') {
        await tx.update(documentAnalysisProposals)
          .set({ finalValueJson: proposal.proposedValueJson, status: 'kept' })
          .where(eq(documentAnalysisProposals.id, proposal.id));
      }

    } else if (proposal.proposalType === 'agenda_suggestion') {
      // Chercher un item agenda existant qui correspond à cette suggestion
      const label: string = value?.label ?? proposal.displayLabel ?? '';
      const dateValue: string | null = value?.dateValue ?? null;

      const existingItems = await tx
        .select({ id: agendaItems.id, title: agendaItems.title, startDate: agendaItems.startDate })
        .from(agendaItems)
        .where(eq(agendaItems.accountId, accountId));

      const normalize = (s: string) =>
        s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

      const normLabel = normalize(label);
      const isSimilar = (a: string, b: string): boolean => {
        const na = normalize(a);
        const nb = normalize(b);
        const ta = na.split(' ').filter(t => t.length > 2);
        const tb = nb.split(' ').filter(t => t.length > 2);
        const shared = ta.filter(t => tb.includes(t)).length;
        const maxLen = Math.max(ta.length, tb.length, 1);
        return na === nb || na.includes(nb) || nb.includes(na) || shared / maxLen >= 0.5;
      };

      // Matcher avec les items existants (non encore résolus dans ce commit)
      const matched = existingItems.find(item => {
        if (resolvedAgendaItemIds.has(item.id)) return false; // déjà utilisé
        if (!isSimilar(label, item.title)) return false;
        if (dateValue && item.startDate) {
          const diff = Math.abs(new Date(dateValue).getTime() - new Date(item.startDate).getTime());
          return diff <= 14 * 24 * 3600 * 1000;
        }
        return true;
      });

      if (matched) {
        resolvedAgendaItemIds.add(matched.id);
        // Marquer l'item existant comme réalisé et lier le document
        await tx.update(agendaItems)
          .set({ manualStatus: 'realise', updatedAt: new Date() })
          .where(eq(agendaItems.id, matched.id));

        const existingSource = await tx
          .select({ id: agendaItemSources.id })
          .from(agendaItemSources)
          .where(and(
            eq(agendaItemSources.agendaItemId, matched.id),
            eq(agendaItemSources.assetFileId, assetFileId),
          ))
          .limit(1);

        if (existingSource.length === 0) {
          await tx.insert(agendaItemSources).values({
            agendaItemId: matched.id,
            assetFileId,
            runId,
            effectType: 'resolved_existing',
          });
        }
      } else {
        // Vérifier que le label n'est pas similaire à un item déjà créé dans ce commit
        const isDuplicateOfCreated = createdAgendaLabels.some(l => isSimilar(label, l));
        if (!isDuplicateOfCreated) {
          createdAgendaLabels.push(label);
          const effect: AgendaEffect = {
            effectType: 'created',
            agendaItemId: null,
            assetFileId,
            runId,
            metadata: value,
          };
          agendaEffects.push(effect);
        }
      }

      if (proposal.status === 'pending') {
        await tx.update(documentAnalysisProposals)
          .set({ finalValueJson: proposal.proposedValueJson, status: 'kept' })
          .where(eq(documentAnalysisProposals.id, proposal.id));
      }
    }
  }

  if (Object.keys(fileUpdate).length > 0) {
    await tx.update(assetFiles).set(fileUpdate).where(eq(assetFiles.id, assetFileId));
  }

  return { appliedFields, agendaEffectsFromRun: agendaEffects };
}

// ─── Apply agenda effects ────────────────────────────────────────────────────

async function applyAgendaEffects(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  effects: AgendaEffect[],
  accountId: number,
): Promise<number> {
  let count = 0;

  for (const effect of effects) {
    if (effect.effectType === 'created') {
      // Les items agenda ne sont jamais créés automatiquement lors du commit.
      // L'utilisateur doit les ajouter explicitement depuis l'interface.
      // On enregistre uniquement la source pour la traçabilité (agendaItemId = null).
      const existingLinked = await tx
        .select({ id: agendaItemSources.id })
        .from(agendaItemSources)
        .where(and(
          eq(agendaItemSources.assetFileId, effect.assetFileId),
          eq(agendaItemSources.effectType, 'created'),
          isNull(agendaItemSources.agendaItemId),
        ))
        .limit(1);

      if (existingLinked.length > 0) continue; // already recorded

      await tx.insert(agendaItemSources).values({
        agendaItemId: null,
        assetFileId: effect.assetFileId,
        runId: effect.runId,
        effectType: 'created',
      });
      count++;

    } else if (effect.effectType === 'resolved_existing') {
      // Idempotency: skip if already linked
      const existingResolved = await tx
        .select({ id: agendaItemSources.id })
        .from(agendaItemSources)
        .where(and(
          eq(agendaItemSources.agendaItemId, effect.agendaItemId!),
          eq(agendaItemSources.assetFileId, effect.assetFileId),
          eq(agendaItemSources.effectType, 'resolved_existing'),
        ))
        .limit(1);

      if (existingResolved.length === 0) {
        await tx.insert(agendaItemSources).values({
          agendaItemId: effect.agendaItemId,
          assetFileId: effect.assetFileId,
          runId: effect.runId,
          effectType: 'resolved_existing',
        });
      }
      count++;

    } else if (effect.effectType === 'conflict_pending') {
      // conflict_pending: always recorded with agenda_item_id = null
      await tx.insert(agendaItemSources).values({
        agendaItemId: null,
        assetFileId: effect.assetFileId,
        runId: effect.runId,
        effectType: 'conflict_pending',
      });
      count++;

    } else if (effect.effectType === 'rejected_orphan') {
      await tx.insert(agendaItemSources).values({
        agendaItemId: null,
        assetFileId: effect.assetFileId,
        runId: effect.runId,
        effectType: 'rejected_orphan',
      });
      count++;
    }
  }

  return count;
}

// ─── Commit unitaire ────────────────────────────────────────────────────────

export async function commitDocument(
  assetFileId: number,
  accountId: number,
  agendaEffects: AgendaEffect[] = [],
): Promise<CommitResult> {
  // Find current reference run
  const [currentRun] = await db
    .select()
    .from(documentAnalysisRuns)
    .where(and(
      eq(documentAnalysisRuns.assetFileId, assetFileId),
      eq(documentAnalysisRuns.accountId, accountId),
      eq(documentAnalysisRuns.isCurrentReference, true)
    ))
    .limit(1);

  if (!currentRun) {
    throw new Error(`No current reference run for asset file ${assetFileId}`);
  }

  let appliedFields: string[] = [];
  let agendaEffectsProcessed = 0;

  await db.transaction(async (tx) => {
    const { appliedFields: fields, agendaEffectsFromRun } = await applyProposalsToAssetFile(
      tx, assetFileId, currentRun.id, accountId
    );
    appliedFields = fields;

    // Combine passed effects with run-derived derived_date effects
    const allEffects = [...agendaEffects, ...agendaEffectsFromRun];
    agendaEffectsProcessed = await applyAgendaEffects(tx, allEffects, accountId);

    // NOTE: last_analysis_at is NOT updated at commit (plan §2.1)

    // Mettre à jour analysisState → ANALYZED pour sortir du state VALIDATION_REQUIRED
    await tx.update(assetFiles)
      .set({ analysisState: 'ANALYZED' })
      .where(
        and(
          eq(assetFiles.id, assetFileId),
          eq(assetFiles.analysisState, 'VALIDATION_REQUIRED'),
        )
      );
  });

  // After commit: trigger supplier processing for paid accounts
  if (appliedFields.includes('supplier')) {
    const [account] = await db
      .select({ planType: accounts.planType })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    if (account) {
      const [file] = await db
        .select({ supplier: assetFiles.supplier, userId: assetFiles.userId })
        .from(assetFiles)
        .where(eq(assetFiles.id, assetFileId))
        .limit(1);

      if (file?.supplier) {
        // Try to recover supplier coordinates from the run's stored extraction payload
        let extractedCoordinates: import('@/services/suppliers/supplier-service').ExtractedSupplierData | undefined;
        try {
          if (currentRun.rawResponseJson) {
            const parsed = JSON.parse(currentRun.rawResponseJson) as Record<string, unknown>;
            const coords = parsed.proposedSupplierCoordinates as Record<string, string | null> | null;
            if (coords && typeof coords === 'object') {
              extractedCoordinates = {
                name: file.supplier,
                email: coords.email ?? null,
                phone: coords.phone ?? null,
                website: coords.website ?? null,
                addressLine1: coords.addressLine1 ?? null,
                addressLine2: coords.addressLine2 ?? null,
                postalCode: coords.postalCode ?? null,
                city: coords.city ?? null,
                country: coords.country ?? null,
                siren: coords.siren ?? null,
                siret: coords.siret ?? null,
                vatNumber: coords.vatNumber ?? null,
                iban: coords.iban ?? null,
                ibanHolderName: coords.ibanHolderName ?? null,
              };
            }
          }
        } catch { /* ignore parse errors — coordinates are optional */ }

        processSupplierFromExtraction({
          accountId,
          assetFileId,
          extractedName: file.supplier,
          extractedCoordinates,
          createdByUserId: file.userId,
        }).catch(() => {
          // Non-blocking: supplier processing failure does not break the commit
        });
      }
    }
  }

  // Fire-and-forget: link document to a matching equipment if not already linked
  linkDocumentToEquipments(assetFileId, accountId).catch(() => { /* non-blocking */ });

  return { committed: true, appliedFields, agendaEffectsProcessed };
}

// ─── Commit de lot ───────────────────────────────────────────────────────────

export async function commitLot(
  lotId: number,
  accountId: number,
  agendaEffectsByFile: Map<number, AgendaEffect[]> = new Map(),
): Promise<{ committed: boolean; totalApplied: number; totalFailed: number; mergedGroups: number }> {
  // Set lot status to committing
  await db.update(documentLots).set({ status: 'committing' }).where(eq(documentLots.id, lotId));

  const items = await db
    .select()
    .from(documentLotItems)
    .where(eq(documentLotItems.lotId, lotId))
    .orderBy(documentLotItems.position);

  // Build groups by shared currentAnalysisRunId — files with the same runId were
  // detected as pages of one document and must be merged into the lead file.
  const runIdToItems = new Map<number, typeof items>();
  const ungrouped: typeof items = [];
  for (const item of items) {
    if (item.currentAnalysisRunId) {
      const group = runIdToItems.get(item.currentAnalysisRunId) ?? [];
      group.push(item);
      runIdToItems.set(item.currentAnalysisRunId, group);
    } else {
      ungrouped.push(item);
    }
  }

  // Flatten: lead item per group (lowest position) + ungrouped
  const leadItems: typeof items = [];
  const secondaryFileIds: number[] = [];

  for (const group of runIdToItems.values()) {
    const sorted = [...group].sort((a, b) => a.position - b.position);
    leadItems.push(sorted[0]);
    sorted.slice(1).forEach(item => secondaryFileIds.push(item.assetFileId));
  }
  leadItems.push(...ungrouped);

  let totalApplied = 0;
  let totalFailed = 0;

  for (const item of leadItems) {
    try {
      const [currentRun] = await db
        .select()
        .from(documentAnalysisRuns)
        .where(and(
          eq(documentAnalysisRuns.assetFileId, item.assetFileId),
          eq(documentAnalysisRuns.accountId, accountId),
          eq(documentAnalysisRuns.isCurrentReference, true)
        ))
        .limit(1);

      if (!currentRun) {
        await db.update(documentLotItems)
          .set({ commitStatus: 'failed' })
          .where(eq(documentLotItems.id, item.id));
        totalFailed++;
        continue;
      }

      await db.transaction(async (tx) => {
        const effects = agendaEffectsByFile.get(item.assetFileId) ?? [];
        const { agendaEffectsFromRun } = await applyProposalsToAssetFile(
          tx, item.assetFileId, currentRun.id, accountId
        );
        await applyAgendaEffects(tx, [...effects, ...agendaEffectsFromRun], accountId);
      });

      await db.update(documentLotItems)
        .set({ commitStatus: 'committed' })
        .where(eq(documentLotItems.id, item.id));
      totalApplied++;
    } catch {
      await db.update(documentLotItems)
        .set({ commitStatus: 'failed' })
        .where(eq(documentLotItems.id, item.id));
      totalFailed++;
    }
  }

  // Soft-delete secondary (non-lead) files that were merged into their group lead
  if (secondaryFileIds.length > 0) {
    await db.update(assetFiles)
      .set({ deletedAt: new Date() })
      .where(inArray(assetFiles.id, secondaryFileIds));
    // Mark their lot items as committed too
    await db.update(documentLotItems)
      .set({ commitStatus: 'committed' })
      .where(inArray(documentLotItems.assetFileId, secondaryFileIds));
  }

  const mergedGroups = runIdToItems.size > 0
    ? [...runIdToItems.values()].filter(g => g.length > 1).length
    : 0;

  const finalStatus: string = totalFailed > 0 ? 'partially_failed' : 'committed';
  await db.update(documentLots)
    .set({ status: finalStatus, committedAt: new Date() })
    .where(eq(documentLots.id, lotId));

  return { committed: true, totalApplied, totalFailed, mergedGroups };
}
