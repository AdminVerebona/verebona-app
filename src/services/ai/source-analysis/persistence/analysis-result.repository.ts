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
 *
 * Lot 75C (ticket T1 résiduels, F) — « analyse dédupliquée » ≠ « écritures
 * achevées » :
 *   · run, propositions et métadonnées du document sont écrits dans UNE
 *     transaction (plus jamais un run `completed` sans ses propositions) ;
 *   · un run dédupliqué VÉRIFIE ses écritures et rejoue SEULEMENT celles qui
 *     manquent (propositions absentes, métadonnées non posées) — runs
 *     antérieurs incomplets compris ;
 *   · `writes_status` (0545) suit l'achèvement des écritures métier du
 *     pipeline (PENDING → SUCCEEDED / PARTIAL / FAILED) et `master_snapshot`
 *     garde la sortie STRUCTURÉE tant qu'elles ne sont pas achevées : la
 *     reprise la rejoue sans rappeler Gemini (`loadReplayableMaster`).
 */
import { createHash } from 'crypto';
import { db, pgClient } from '@/db';
import { documentAnalysisRuns, documentAnalysisProposals, assetFiles } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import type { SourceAnalysisResult, SourceInput } from '../types';
import { decideT1Description } from '@/services/documents/notes-description/t1-description';
import { notesDescriptionColumnsReady, recordDescriptionT1Status } from '@/services/documents/notes-description/store';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;

interface PersistResultInput {
  input: SourceInput;
  leadSourceId: number;
  groupSourceIds: number[];
  lotId: number | null;
  result: SourceAnalysisResult;
  /**
   * Version RÉELLEMENT résolue du prompt maître T1 (fichier ou version de
   * configuration, avec empreinte). Obligatoire depuis le lot 16b-3 : le
   * master est le seul moteur.
   */
  master: { masterPromptVersion: string };
  /**
   * Lot 75C : sortie structurée rejouable (master T1 + empreintes des
   * fichiers lus), conservée tant que les écritures ne sont pas achevées.
   */
  masterSnapshot?: unknown;
  /**
   * Lot 113Z (#723) : la validation de la sortie T1 a retiré une description
   * produite (constat `REMOVED_AT_VALIDATION`, jamais un échec d'extraction).
   */
  descriptionRemovedAtValidation?: boolean;
}

interface PersistedRun {
  runId: number;
  /** true si un run identique existait déjà : aucun doublon n'a été créé. */
  deduplicated: boolean;
  /**
   * Nombre de propositions écrites pour ce run — CDC §4.2.4, « preuve probable
   * ou ambiguë → proposition ou revue IA ciblée ».
   *
   * Compte réel, jamais estimé (diagnostic). Lot 71B : il ne décide plus
   * d'aucun état « à valider » — plus de validation sur les fiches.
   *
   * Vaut 0 sur un run dédupliqué : les propositions du run d'origine sont
   * toujours en base, aucune n'est réécrite (§4.1.7).
   */
  proposalCount: number;
  /** Lot 75C : écritures manquantes d'un run dédupliqué, rejouées à ce passage (`PROPOSALS`, `METADATA`). */
  repaired?: string[];
}

let colonnes: Promise<boolean> | null = null;
/** Colonnes `writes_status` / `master_snapshot` présentes (migration 0545) ? Mémorisé. */
function runWritesReady(): Promise<boolean> {
  colonnes ??= Promise.resolve().then(() => pgClient.unsafe(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'document_analysis_runs' AND column_name = 'master_snapshot') AS ok`) as unknown as Promise<Array<{ ok: boolean }>>)
    .then((r) => r[0]?.ok === true)
    .catch(() => false);
  return colonnes;
}

/** Écritures du pipeline en cours sur ce run ; sortie structurée conservée pour la reprise. */
async function markWritesPending(x: Exec, runId: number, snapshot: unknown): Promise<void> {
  await x.execute(sql`UPDATE document_analysis_runs
     SET writes_status = 'PENDING', writes_error = NULL, writes_at = NOW(),
         master_snapshot = COALESCE(${snapshot === undefined ? null : JSON.stringify(snapshot)}::jsonb, master_snapshot)
   WHERE id = ${runId}`);
}

export async function persistAnalysisResult(p: PersistResultInput): Promise<PersistedRun> {
  const inputHash = computeInputHash(p);
  const suivi = await runWritesReady();

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
    // Lot 75C (F) : run déjà connu — l'analyse n'est pas refaite, mais ses
    // écritures sont VÉRIFIÉES et seules les manquantes sont rejouées.
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM document_analysis_runs WHERE id = ${existing.id} FOR UPDATE`);
      const repaired: string[] = [];
      let proposalCount = await countProposals(existing.id, tx);
      if (proposalCount === 0 && proposalRows(existing.id, p).length > 0) {
        proposalCount = await insertProposals(existing.id, p, tx);
        repaired.push('PROPOSALS');
      }
      if (await updateSourceMetadata(p, tx, { onlyMissing: true, runId: existing.id })) repaired.push('METADATA');
      if (suivi) await markWritesPending(tx, existing.id, p.masterSnapshot);
      return { runId: existing.id, deduplicated: true, proposalCount, ...(repaired.length ? { repaired } : {}) };
    });
  }

  // Lot 75C (F) : run, propositions et métadonnées dans UNE transaction —
  // jamais un run `completed` (donc dédupliqué plus tard) sans ses écritures.
  return db.transaction(async (tx) => {
    // Un seul run de référence par document : on libère l'ancien avant d'insérer.
    await tx.update(documentAnalysisRuns)
      .set({ isCurrentReference: false })
      .where(and(
        eq(documentAnalysisRuns.assetFileId, p.leadSourceId),
        eq(documentAnalysisRuns.isCurrentReference, true),
      ));

    const [run] = await tx.insert(documentAnalysisRuns).values({
      assetFileId: p.leadSourceId,
      lotId: p.lotId ?? undefined,
      inputFileHash: inputHash,
      promptVersion: p.master.masterPromptVersion,
      provider: 'gemini',
      model: p.result.operationTrace.models[0] ?? 'unknown',
      status: 'completed',
      isCurrentReference: true,
      finishedAt: new Date(),
      accountId: p.input.accountId,
      rawResponseJson: JSON.stringify(p.result),
    }).returning({ id: documentAnalysisRuns.id });

    const proposalCount = await insertProposals(run.id, p, tx);
    await updateSourceMetadata(p, tx, { runId: run.id });
    if (suivi) await markWritesPending(tx, run.id, p.masterSnapshot);

    return { runId: run.id, deduplicated: false, proposalCount };
  });
}

/** Propositions déjà en base pour un run — utilisé sur le chemin dédupliqué. */
async function countProposals(runId: number, x: Exec = db): Promise<number> {
  const rows = await x
    .select({ id: documentAnalysisProposals.id })
    .from(documentAnalysisProposals)
    .where(eq(documentAnalysisProposals.runId, runId));
  return rows.length;
}

/** @returns nombre de propositions écrites. */
async function insertProposals(runId: number, p: PersistResultInput, x: Exec = db): Promise<number> {
  const rows = proposalRows(runId, p);
  if (rows.length > 0) await x.insert(documentAnalysisProposals).values(rows);
  return rows.length;
}

/** Propositions d'un résultat (pure). */
function proposalRows(runId: number, p: PersistResultInput): Array<typeof documentAnalysisProposals.$inferInsert> {
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
      // `suggestedCategory` ajouté le 18/09/2026 : sans lui, un T4 exécuté en
      // différé — depuis la file plutôt que dans la foulée de l'analyse —
      // devrait recalculer une classification que T1 avait déjà établie.
      proposedValueJson: JSON.stringify({
        title: a.title,
        date: a.date,
        excerpt: a.excerpt,
        suggestedCategory: a.suggestedCategory ?? null,
      }),
      confidence: a.confidence,
      accountId: p.input.accountId,
    });
  }

  return rows;
}

/** Colonnes de métadonnées posées par l'analyse (contrôle d'un run dédupliqué). */
const METADATA_KEYS = ['documentType', 'description', 'extractedText', 'supplier', 'amountCents', 'documentDate'] as const;

/**
 * Métadonnées documentaires directement portées par le fichier.
 * Lot 75C : `onlyMissing` (run dédupliqué) — seules les métadonnées que le
 * résultat porte et que le document n'a PAS (colonne vide) sont écrites ;
 * rend `true` si au moins une a dû être rejouée.
 */
async function updateSourceMetadata(p: PersistResultInput, x: Exec = db, opts: { onlyMissing?: boolean; runId?: number } = {}): Promise<boolean> {
  const d = p.result.document;
  const patch: Record<string, unknown> = { lastAnalysisAt: new Date(), updatedAt: new Date() };

  // Lot 33C : le TITRE n'est plus écrit ici. Il l'est par le service commun
  // `DocumentTitleService` (fin d'analyse T1, rattrapage T3), qui contrôle le
  // titre courant, respecte un titre utilisateur (`title_source = USER`) et
  // écrit sous contrôle de concurrence — y compris quand ce run est
  // dédupliqué (ce chemin-ci n'est alors pas exécuté : c'était l'une des
  // causes d'un document resté « <uuid>.pdf »).
  if (d.type?.value) patch.documentType = d.type.value;
  // Lot 113Z : la description T1 est décidée plus bas (provenance établie,
  // description d'origine inconnue conservée) ; jamais la note utilisateur.
  const descriptionT1 = d.description?.value?.trim() ? d.description.value.trim() : null;
  if (descriptionT1) patch.description = descriptionT1;
  if (d.transcription) patch.extractedText = d.transcription;
  // Lot 28 : un fournisseur CONTRADICTOIRE n'est pas écrit — il est soumis à
  // l'utilisateur (DATA-SUPPLIER, pont « À traiter » `document-rule-bridge`).
  if (d.supplier?.value.name && d.supplier.confidence !== 'conflictual') patch.supplier = d.supplier.value.name;
  if (typeof d.amountCents?.value === 'number') patch.amountCents = d.amountCents.value;
  // Lot 103F : une date documentaire CONTRADICTOIRE n'est pas posée comme
  // certaine (même règle que le fournisseur) : le document reste « Sans
  // date » plutôt que de sortir sous une période qu'il ne prouve pas.
  if (d.date?.value && d.date.confidence !== 'conflictual') patch.documentDate = d.date.value;

  // Une valeur modifiée à la main par l'utilisateur n'est jamais écrasée par
  // une nouvelle analyse (le tiroir marque ces champs dans userEditedFields).
  const [current] = await x
    .select({
      userEditedFields: assetFiles.userEditedFields,
      documentType: assetFiles.documentType, description: assetFiles.description, extractedText: assetFiles.extractedText,
      supplier: assetFiles.supplier, amountCents: assetFiles.amountCents, documentDate: assetFiles.documentDate,
    })
    .from(assetFiles)
    .where(and(eq(assetFiles.id, p.leadSourceId), eq(assetFiles.accountId, p.input.accountId)))
    .limit(1);
  for (const [key, edited] of Object.entries(current?.userEditedFields ?? {})) {
    if (edited === true && key in patch && key !== 'lastAnalysisAt' && key !== 'updatedAt') delete patch[key];
  }
  // ── Lot 113Z (#723, §3.B) : description T1 — provenance et constat ──────
  // Une description en place d'origine INCONNUE (saisie historique possible)
  // n'est pas remplacée ; une description T1 établie (ou prouvée égale à une
  // sortie T1 persistée) l'est. Le constat est tracé dans la même transaction.
  const suivi1580 = await notesDescriptionColumnsReady();
  let decision: ReturnType<typeof decideT1Description> | null = null;
  if (suivi1580) {
    const [prec] = (await x.execute(sql`SELECT x.description AS extraction, f.description_source AS source
        FROM asset_files f LEFT JOIN document_extractions x ON x.file_id = f.id AND x.account_id = f.account_id
       WHERE f.id = ${p.leadSourceId} AND f.account_id = ${p.input.accountId}`)) as unknown as Array<{ extraction: string | null; source: string | null }>;
    decision = decideT1Description({
      produced: descriptionT1,
      removedAtValidation: p.descriptionRemovedAtValidation === true,
      current: current?.description ?? null,
      currentSource: prec?.source ?? null,
      previousExtraction: prec?.extraction ?? null,
      userLocked: (current?.userEditedFields as Record<string, boolean> | null | undefined)?.description === true,
    });
    if (!decision.write) delete patch.description;
  }
  if (opts.onlyMissing) {
    // Run dédupliqué : seules les métadonnées ABSENTES du document sont rejouées.
    const manquantes = METADATA_KEYS.filter((k) => k in patch && (current as Record<string, unknown> | undefined)?.[k] == null);
    if (manquantes.length === 0) {
      if (decision) await recordDescriptionT1Status(x, { accountId: p.input.accountId, fileId: p.leadSourceId, status: decision.status, runId: opts.runId ?? null, setSourceT1: decision.setSourceT1 });
      return false;
    }
    for (const k of Object.keys(patch)) if (!(manquantes as readonly string[]).includes(k) && k !== 'updatedAt') delete patch[k];
  }

  await x.update(assetFiles)
    .set(patch as never)
    .where(and(eq(assetFiles.id, p.leadSourceId), eq(assetFiles.accountId, p.input.accountId)));
  if (decision) {
    // Provenance T1 posée seulement quand la description EN PLACE est celle de
    // T1 : écrite à l'instant, déjà établie, ou prouvée égale à une sortie T1.
    await recordDescriptionT1Status(x, {
      accountId: p.input.accountId, fileId: p.leadSourceId, status: decision.status, runId: opts.runId ?? null,
      setSourceT1: decision.setSourceT1,
    });
  }
  return true;
}

// ── Lot 75C (F) : achèvement des écritures, sortie structurée rejouable ─────

/**
 * Sortie structurée REJOUABLE du document : run de référence `completed` dont
 * les écritures ne sont pas achevées (PENDING : exécution interrompue ;
 * FAILED : écriture obligatoire manquante) et qui garde sa sortie. `null`
 * sinon (aucune, ou colonnes 0545 absentes) — l'appelant analyse alors.
 * L'appelant vérifie l'empreinte d'entrée et l'identité du contenu.
 */
export async function loadReplayableRun(accountId: number, leadSourceId: number): Promise<{ runId: number; inputHash: string; snapshot: unknown } | null> {
  if (!(await runWritesReady())) return null;
  const rows = (await pgClient.unsafe(
    `SELECT id, input_file_hash, master_snapshot FROM document_analysis_runs
      WHERE asset_file_id = $1 AND account_id = $2 AND status = 'completed' AND is_current_reference = true
        AND master_snapshot IS NOT NULL AND writes_status IN ('PENDING', 'FAILED')
      ORDER BY id DESC LIMIT 1`,
    [leadSourceId, accountId] as never[],
  )) as unknown as Array<{ id: number; input_file_hash: string; master_snapshot: unknown }>;
  const r = rows[0];
  return r ? { runId: Number(r.id), inputHash: r.input_file_hash, snapshot: r.master_snapshot } : null;
}

/**
 * Fin des écritures du pipeline pour un run : SUCCEEDED / PARTIAL effacent la
 * sortie conservée (plus rien à rejouer) ; FAILED la garde pour la reprise.
 * Ne lève jamais (état de suivi).
 */
export async function finalizeRunWrites(runId: number | null | undefined, status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED', error?: string | null): Promise<void> {
  if (runId == null) return;
  try {
    if (!(await runWritesReady())) return;
    await pgClient.unsafe(
      `UPDATE document_analysis_runs SET writes_status = $2, writes_error = $3, writes_at = NOW(),
         master_snapshot = CASE WHEN $2 IN ('SUCCEEDED', 'PARTIAL') THEN NULL ELSE master_snapshot END
        WHERE id = $1`,
      [runId, status, error ? error.slice(0, 2_000) : null] as never[],
    );
  } catch (e) {
    console.error(`[t1-run] état des écritures du run ${runId} non écrit :`, (e as Error).message);
  }
}

/**
 * Empreinte des entrées : sources, versions et type de source. Deux analyses de
 * la même version d'une même source produisent la même empreinte.
 *
 * La route et la version résolue du master entrent dans l'empreinte : une
 * nouvelle version du master ne retrouve jamais le run d'une autre.
 *
 * Lot 16b-3 : `prompt` garde la valeur figée de l'ancienne constante
 * d'extraction (`HASH_PROMPT_LEGACY_SEED`) — sans rôle depuis la suppression
 * des étapes, mais la changer modifierait l'empreinte de tous les runs master
 * déjà écrits (idempotence d'une reprise sur une même version de source).
 */
export function computeInputHash(p: Pick<PersistResultInput, 'groupSourceIds' | 'input' | 'master'>): string {
  return createHash('sha256').update(JSON.stringify({
    sources: [...p.groupSourceIds].sort((a, b) => a - b),
    type: p.input.sourceType,
    version: p.input.sourceVersion ?? null,
    prompt: HASH_PROMPT_LEGACY_SEED,
    route: 'master',
    masterPrompt: p.master.masterPromptVersion,
  })).digest('hex');
}

/** Graine figée de l'empreinte des runs (voir `computeInputHash`). */
const HASH_PROMPT_LEGACY_SEED = 'extract_source_v5';
