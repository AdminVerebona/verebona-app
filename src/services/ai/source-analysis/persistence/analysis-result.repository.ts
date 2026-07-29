/**
 * Étape 12 — persistance du résultat d'analyse.
 *
 * CDC §4.1.7 : « La réexécution du pipeline sur la même version d'une source ne
 * doit pas créer de doublons. » L'unicité est portée par
 * `document_analysis_runs.input_file_hash` et par l'index partiel
 * `is_current_reference` déjà présent en base.
 *
 * Ce module N'ÉCRIT PAS dans la fiche du bien : les valeurs deviennent des
 * propositions, et seul le moteur de réconciliation (usage 2) décide.
 */
import { createHash } from 'crypto';
import { db } from '@/db';
import { documentAnalysisRuns, documentAnalysisProposals, assetFiles } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import type { SourceAnalysisResult, SourceInput } from '../types';

export interface PersistResultInput {
  input: SourceInput;
  leadSourceId: number;
  groupSourceIds: number[];
  lotId: number | null;
  result: SourceAnalysisResult;
}

export interface PersistedRun {
  runId: number;
  /** true si un run identique existait déjà : aucun doublon n'a été créé. */
  deduplicated: boolean;
  /**
   * Nombre de propositions écrites pour ce run — CDC §4.2.4, « preuve probable
   * ou ambiguë → proposition ou revue IA ciblée ».
   *
   * Compte réel, jamais estimé : `computeFinalState` s'en sert pour décider si
   * le document doit être présenté à valider. Un document marqué à valider sans
   * proposition serait une impasse pour l'utilisateur — il verrait « décision
   * attendue » sans rien à décider.
   *
   * Vaut 0 sur un run dédupliqué : les propositions du run d'origine sont
   * toujours en base, aucune n'est réécrite (§4.1.7).
   */
  proposalCount: number;
}

export async function persistAnalysisResult(p: PersistResultInput): Promise<PersistedRun> {
  const inputHash = computeInputHash(p);

  // Idempotence : un run identique sur la même version de source est réutilisé.
  const [existing] = await db
    .select({ id: documentAnalysisRuns.id })
    .from(documentAnalysisRuns)
    .where(and(
      eq(documentAnalysisRuns.assetFileId, p.leadSourceId),
      eq(documentAnalysisRuns.inputFileHash, inputHash),
      eq(documentAnalysisRuns.status, 'completed'),
    ))
    .limit(1);

  if (existing) {
    // Run déjà connu : les propositions existantes sont conservées telles
    // quelles. On les recompte pour que l'état du document reste cohérent avec
    // ce qui lui est réellement présenté.
    return {
      runId: existing.id,
      deduplicated: true,
      proposalCount: await countProposals(existing.id),
    };
  }

  // Un seul run de référence par document : on libère l'ancien avant d'insérer.
  await db.update(documentAnalysisRuns)
    .set({ isCurrentReference: false })
    .where(and(
      eq(documentAnalysisRuns.assetFileId, p.leadSourceId),
      eq(documentAnalysisRuns.isCurrentReference, true),
    ));

  const [run] = await db.insert(documentAnalysisRuns).values({
    assetFileId: p.leadSourceId,
    lotId: p.lotId ?? undefined,
    inputFileHash: inputHash,
    promptVersion: 'extract_source_v2',
    provider: 'gemini',
    model: p.result.operationTrace.models[0] ?? 'unknown',
    status: 'completed',
    isCurrentReference: true,
    finishedAt: new Date(),
    accountId: p.input.accountId,
    rawResponseJson: JSON.stringify(p.result),
  }).returning({ id: documentAnalysisRuns.id });

  const proposalCount = await insertProposals(run.id, p);
  await updateSourceMetadata(p);

  return { runId: run.id, deduplicated: false, proposalCount };
}

/** Propositions déjà en base pour un run — utilisé sur le chemin dédupliqué. */
async function countProposals(runId: number): Promise<number> {
  const rows = await db
    .select({ id: documentAnalysisProposals.id })
    .from(documentAnalysisProposals)
    .where(eq(documentAnalysisProposals.runId, runId));
  return rows.length;
}

/** @returns nombre de propositions écrites. */
async function insertProposals(runId: number, p: PersistResultInput): Promise<number> {
  const rows: Array<typeof documentAnalysisProposals.$inferInsert> = [];

  for (const f of p.result.extractedFields) {
    rows.push({
      runId,
      assetFileId: p.leadSourceId,
      proposalType: 'field',
      targetKey: f.fieldKey,
      proposedValueJson: JSON.stringify({ value: f.value, excerpt: f.excerpt }),
      confidence: f.confidence,
      accountId: p.input.accountId,
    });
  }

  // Les candidats de rattachement VÉRIFIÉS deviennent des propositions de lien.
  const links = [
    ...p.result.assetCandidates.map((c) => ({ c, key: 'asset' })),
    ...p.result.roomCandidates.map((c) => ({ c, key: 'room' })),
    ...p.result.equipmentCandidates.map((c) => ({ c, key: 'equipment' })),
  ];

  for (const { c, key } of links) {
    if (!c.verified || c.entityId === null) continue;
    rows.push({
      runId,
      assetFileId: p.leadSourceId,
      proposalType: 'link',
      targetKey: key,
      canonicalCode: String(c.entityId),
      displayLabel: c.rawLabel,
      proposedValueJson: JSON.stringify({ entityId: c.entityId, reason: c.reason, excerpt: c.excerpt }),
      confidence: c.confidence,
      accountId: p.input.accountId,
    });
  }

  for (const a of p.result.agendaCandidates) {
    rows.push({
      runId,
      assetFileId: p.leadSourceId,
      proposalType: 'agenda_suggestion',
      targetKey: a.originFieldKey ?? a.title,
      proposedValueJson: JSON.stringify({ title: a.title, date: a.date, excerpt: a.excerpt }),
      confidence: a.confidence,
      accountId: p.input.accountId,
    });
  }

  if (rows.length > 0) await db.insert(documentAnalysisProposals).values(rows);
  return rows.length;
}

/** Métadonnées documentaires directement portées par le fichier. */
async function updateSourceMetadata(p: PersistResultInput): Promise<void> {
  const d = p.result.document;
  const patch: Record<string, unknown> = { lastAnalysisAt: new Date(), updatedAt: new Date() };

  if (d.title?.value) patch.retainedTitle = d.title.value;
  if (d.type?.value) patch.documentType = d.type.value;
  if (d.description?.value) patch.description = d.description.value;
  if (d.transcription) patch.extractedText = d.transcription;
  if (d.supplier?.value.name) patch.supplier = d.supplier.value.name;
  if (typeof d.amountCents?.value === 'number') patch.amountCents = d.amountCents.value;
  if (d.date?.value) patch.documentDate = d.date.value;

  await db.update(assetFiles)
    .set(patch as never)
    .where(and(eq(assetFiles.id, p.leadSourceId), eq(assetFiles.accountId, p.input.accountId)));
}

/**
 * Empreinte des entrées : sources, versions et type de source. Deux analyses de
 * la même version d'une même source produisent la même empreinte.
 */
function computeInputHash(p: PersistResultInput): string {
  return createHash('sha256').update(JSON.stringify({
    sources: [...p.groupSourceIds].sort((a, b) => a - b),
    type: p.input.sourceType,
    version: p.input.sourceVersion ?? null,
    prompt: 'extract_source_v2',
  })).digest('hex');
}
