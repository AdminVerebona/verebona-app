/**
 * Lot 113AM (Trello #739) — RATTRAPAGE BO des rattachements automatiques
 * ERRONÉS fondés sur une adresse de correspondance (cas du lien #331,
 * document 126 : avis d'assurance du vélo relié à la Maison parce que
 * l'adresse du souscripteur est celle de la Maison).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉTECTION PAR PREUVE (lecture seule) — un lien ACTIF document → bien est
 * candidat s'il est AUTOMATIQUE (origine AI, ou colonne principale posée
 * automatiquement, marque `assetIdAuto`), si AUCUN lien confirmé par
 * l'utilisateur (USER, MIGRATION = proposition acceptée) ne vise le même bien,
 * et si, rejugé par LA garde partagée (`admitDocumentAssetLink`) avec les
 * preuves PERSISTÉES du document (faits T1 et leurs cibles, transcription et
 * couche exhaustive, candidats du modèle T1, décision T3, revue #711), il est
 * refusé pour `ADDRESS_NOT_QUALIFIED` : la seule chose qui relie le document au
 * bien est une adresse dont le rôle n'est pas « lieu du bien ». Tout autre
 * lien (fait ciblé, désignation du modèle, identifiant, référence partagée,
 * nom distinctif, identité de groupe, décision IA appuyée sur autre chose) est
 * laissé tel quel.
 *
 * APPLIQUER (motif obligatoire, BO) : lien AI retiré (REMOVED, jamais de
 * DELETE), colonne automatique remise à vide (le déclencheur 0221 retire le
 * lien LEGACY_COLUMN), journal `document_asset_link_admissions` (REPAIRED,
 * run, motif, état d'avant), puis effets dérivés réévalués par les moteurs
 * existants : `onDocumentAssetChanged` (preuves de ce document sur le bien
 * retirées, bien réconcilié par T3 : fiche, événements de l'agenda,
 * Opérations), et T3 DOCUMENT_ASSET si le document n'a plus de bien principal.
 * Idempotent : relancé, rien n'est retrouvé.
 *
 * RESTAURER (identifiant de l'exécution) : lien réactivé / colonne reposée si
 * rien ne l'empêche (lien actif concurrent, choix de l'utilisateur depuis),
 * bien réconcilié. Aucun appel IA.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { admitDocumentAssetLink, justificationDigest, LINK_ADMISSION_VERSION, type LinkJustification, type LinkProof } from './admission';
import { linkAdmissionJournalReady } from './admission-journal';

type Sql = postgres.Sql | postgres.TransactionSql;
type Row = Record<string, unknown>;
const q = async (s: Sql, text: string, params: unknown[] = []) => (await s.unsafe(text, params as never[])) as unknown as Row[];

const SAMPLE = 50;
const BATCH = 200;
/** Raison posée par le serveur sur un candidat T1 issu d'une correspondance exacte. */
const SERVER_IDENTIFIER_REASON = 'identifiant canonique exact (contrôle serveur)';

export interface AddressLinkCandidate {
  linkId: number;
  accountId: number;
  fileId: number;
  assetId: number;
  origin: string;
  role: string;
  /** La colonne principale vaut ce bien, posée AUTOMATIQUEMENT : elle est remise à vide avec le lien. */
  column: boolean;
  addressRole: string;
  justification: LinkJustification;
}

export interface AddressLinkRepairReport {
  mode: 'simulate' | 'apply';
  runId: string | null;
  disabled: string | null;
  accounts: number;
  examined: number;
  kept: { proven: number; noAddressMatch: number; noKnowledge: number };
  erroneous: number;
  repaired: number;
  derived: { reconciled: number; resolutionRequested: number; failed: number };
  samples: Array<{ accountId: number; fileId: number; assetId: number; linkId: number; origin: string; role: string; addressRole: string; repaired: boolean }>;
  more: boolean;
}

/** Liens automatiques vers un bien, non confirmés par l'utilisateur (lot borné, curseur). */
async function automaticLinks(s: Sql, accountId: number | null, after: number): Promise<Row[]> {
  return q(s, `
    SELECT l.id::float8 AS id, l.account_id, l.file_id, l.asset_id, l.link_role, l.origin,
           (f.asset_id = l.asset_id AND f.asset_id = (f.user_edited_fields ->> 'assetIdAuto')::int
            AND COALESCE((f.user_edited_fields ->> 'assetId')::boolean, false) = false) AS column_auto
      FROM document_asset_links l
      JOIN asset_files f ON f.id = l.file_id AND f.account_id = l.account_id AND f.deleted_at IS NULL
     WHERE l.status = 'ACTIVE' AND l.asset_id IS NOT NULL
       AND l.equipment_id IS NULL AND l.room_id IS NULL AND l.substructure_id IS NULL
       AND ($1::int IS NULL OR l.account_id = $1)
       AND l.id > $2
       AND (l.origin = 'AI'
            OR (l.origin = 'LEGACY_COLUMN' AND f.asset_id = l.asset_id
                AND f.asset_id = (f.user_edited_fields ->> 'assetIdAuto')::int
                AND COALESCE((f.user_edited_fields ->> 'assetId')::boolean, false) = false))
       AND NOT EXISTS (SELECT 1 FROM document_asset_links u
                        WHERE u.file_id = l.file_id AND u.asset_id = l.asset_id AND u.status = 'ACTIVE'
                          AND u.origin IN ('USER', 'MIGRATION'))
     ORDER BY l.id LIMIT ${BATCH}`, [accountId, after]);
}

/** Preuves persistées d'un lien (pure vis-à-vis de la base une fois les entrées lues). */
async function evaluateLink(accountId: number, fileId: number, assetId: number, cache: Map<number, unknown>): Promise<
  { kind: 'NO_ADDRESS' } | { kind: 'NO_KNOWLEDGE' } | { kind: 'EVALUATED'; justification: LinkJustification; admitted: boolean; reason: string; addressRole: string }
> {
  const { loadAccountMatchingIndex } = await import('@/services/ai/reconciliation/document-asset/matching-index');
  const { loadDocumentKnowledgeSources } = await import('@/services/ai/reconciliation/document-asset/document-sources');
  const { resolveAssetByIdentifiers } = await import('@/services/ai/reconciliation/document-asset/identifiers');
  const { qualifyAddressMatches, addressRoleOf } = await import('@/services/ai/reconciliation/document-asset/address-roles');
  const { getResolution } = await import('@/services/ai/reconciliation/document-asset/resolution.repository');
  let index = cache.get(accountId) as Awaited<ReturnType<typeof loadAccountMatchingIndex>> | undefined;
  if (!index) { index = await loadAccountMatchingIndex(accountId); cache.set(accountId, index); }
  const rec = index.records.find((r) => r.assetId === assetId);
  if (!rec?.values.address1) return { kind: 'NO_ADDRESS' };
  const resolution = await getResolution(fileId);
  const sources = await loadDocumentKnowledgeSources({ accountId, fileId, t1Candidates: resolution?.t1Candidates ?? [] });
  if (!sources) return { kind: 'NO_KNOWLEDGE' };
  const facts = sources.facts.map((f) => ({ canonicalKey: f.canonicalKey, value: f.value, label: f.label, subject: f.subject, targetType: f.targetType, targetEntityId: f.targetEntityId }));
  const texts = sources.texts.filter((t) => !t.uncertain).map((t) => t.text);
  const ident = resolveAssetByIdentifiers(index.records, { facts, texts });
  if (!ident.matches.some((m) => m.assetId === assetId && m.kind === 'ADDRESS')) return { kind: 'NO_ADDRESS' };
  const quals = qualifyAddressMatches({ records: index.records, matches: ident.matches, facts, texts });
  const addressRole = addressRoleOf(quals, assetId);

  const proofs: LinkProof[] = ident.matches.filter((m) => m.assetId === assetId).map((m) => ({
    kind: 'IDENTIFIER' as const, identifierKind: m.kind, via: m.via, ...(m.kind === 'ADDRESS' ? { addressRole } : {}),
  }));
  if (facts.some((f) => f.targetType === 'ASSET' && f.targetEntityId === assetId)) proofs.push({ kind: 'FACT_TARGET' });
  const t1 = (resolution?.t1Candidates ?? []).find((c) => c.assetId === assetId);
  if (t1 && t1.reason !== SERVER_IDENTIFIER_REASON) proofs.push({ kind: 'MODEL_DESIGNATION', score: t1.score, detail: t1.confidence });
  const decide = (resolution?.decidedAssetIds ?? []).includes(assetId);
  const motif = String(resolution?.reasonCode ?? '');
  if (decide) {
    if (resolution?.method === 'AI') proofs.push({ kind: 'AI_DECISION', detail: motif, support: [{ kind: 'CONTEXT', detail: 'T3_AI_DECISION' }] });
    else if (motif.startsWith('GROUP_IDENTITY')) proofs.push({ kind: 'IDENTITY_GROUP', detail: motif });
    else if (motif === 'SHARED_REFERENCE') proofs.push({ kind: 'SHARED_REFERENCE' });
    else if (motif === 'DISTINCT_NAME') proofs.push({ kind: 'DISTINCT_NAME' });
  }
  const { pgClient } = await import('@/db');
  const [rv] = (await pgClient.unsafe(`SELECT attachment_review FROM document_asset_resolutions WHERE file_id = $1 AND account_id = $2`, [fileId, accountId] as never[]).catch(() => [])) as unknown as Row[];
  const brut = rv?.attachment_review;
  const revue = (typeof brut === 'string' ? JSON.parse(brut) : brut ?? null) as { secondaryLinked?: number[] } | null;
  if (revue?.secondaryLinked?.includes(assetId)) {
    proofs.push({ kind: 'AI_REVIEW', detail: 'MULTI_ASSET_SECONDARY', support: proofs.filter((p) => p.kind !== 'AI_REVIEW') });
  }
  const justification: LinkJustification = { step: 'REPAIR', rule: 'ADDRESS_LINK_REEVALUATION', proofs };
  const d = admitDocumentAssetLink('AI', justification);
  return { kind: 'EVALUATED', justification, admitted: d.admitted, reason: d.reasonCode, addressRole };
}

/**
 * Recense (simulation) ou retire (application, motif obligatoire) les liens
 * automatiques erronés fondés sur une adresse non qualifiée.
 */
export async function runAddressLinkRepair(o: {
  sql: Sql; apply: boolean; accountId?: number | null; reason?: string | null; deadline?: number; log?: (m: string) => void;
  /** Tests : effets dérivés injectables. */
  derived?: (p: { accountId: number; fileId: number; assetId: number; columnCleared: boolean }) => Promise<{ reconciled: boolean; resolutionRequested: boolean }>;
}): Promise<AddressLinkRepairReport> {
  const rep: AddressLinkRepairReport = {
    mode: o.apply ? 'apply' : 'simulate', runId: null, disabled: null, accounts: 0, examined: 0,
    kept: { proven: 0, noAddressMatch: 0, noKnowledge: 0 }, erroneous: 0, repaired: 0,
    derived: { reconciled: 0, resolutionRequested: 0, failed: 0 }, samples: [], more: false,
  };
  if (!(await linkAdmissionJournalReady(o.sql as never))) { rep.disabled = 'migration 1660 absente (journal de la garde des rattachements)'; return rep; }
  if (o.apply && !(o.reason ?? '').trim()) throw new Error('Motif obligatoire pour appliquer le rattrapage.');
  if (o.apply) rep.runId = randomUUID();
  const comptes = new Set<number>();
  const cache = new Map<number, unknown>();
  let apres = 0;
  for (;;) {
    if (o.deadline && Date.now() > o.deadline) { rep.more = true; break; }
    const lignes = await automaticLinks(o.sql, o.accountId ?? null, apres);
    if (lignes.length === 0) break;
    apres = Number(lignes[lignes.length - 1].id);
    for (const l of lignes) {
      const accountId = Number(l.account_id); const fileId = Number(l.file_id); const assetId = Number(l.asset_id);
      comptes.add(accountId);
      rep.examined++;
      let ev: Awaited<ReturnType<typeof evaluateLink>>;
      try { ev = await evaluateLink(accountId, fileId, assetId, cache); } catch (e) {
        o.log?.(`document ${fileId} → bien ${assetId} : évaluation impossible (${(e as Error).message})`);
        rep.kept.noKnowledge++; continue;
      }
      if (ev.kind === 'NO_ADDRESS') { rep.kept.noAddressMatch++; continue; }
      if (ev.kind === 'NO_KNOWLEDGE') { rep.kept.noKnowledge++; continue; }
      if (ev.admitted || ev.reason !== 'ADDRESS_NOT_QUALIFIED') { rep.kept.proven++; continue; }
      rep.erroneous++;
      const cand: AddressLinkCandidate = {
        linkId: Number(l.id), accountId, fileId, assetId, origin: String(l.origin), role: String(l.link_role),
        column: l.column_auto === true, addressRole: ev.addressRole, justification: ev.justification,
      };
      let fait = false;
      if (o.apply) {
        fait = await repairOne(o.sql, cand, rep.runId!, o.reason!.trim());
        if (fait) {
          rep.repaired++;
          try {
            const d = await (o.derived ?? defaultDerived)({ accountId, fileId, assetId, columnCleared: cand.column });
            if (d.reconciled) rep.derived.reconciled++;
            if (d.resolutionRequested) rep.derived.resolutionRequested++;
          } catch (e) {
            rep.derived.failed++;
            o.log?.(`document ${fileId} → bien ${assetId} : effets dérivés non réévalués (${(e as Error).message})`);
          }
        }
      }
      if (rep.samples.length < SAMPLE) {
        rep.samples.push({ accountId, fileId, assetId, linkId: cand.linkId, origin: cand.origin, role: cand.role, addressRole: cand.addressRole, repaired: fait });
      }
    }
  }
  rep.accounts = comptes.size;
  o.log?.(`${rep.examined} lien(s) automatique(s) examiné(s), ${rep.erroneous} fondé(s) sur une adresse non qualifiée, ${rep.repaired} retiré(s)`);
  return rep;
}

/** Retrait d'UN lien erroné + journal, dans une transaction. */
async function repairOne(s: Sql, c: AddressLinkCandidate, runId: string, motive: string): Promise<boolean> {
  const exec = async (tx: Sql): Promise<boolean> => {
    let ok = false;
    if (c.origin === 'AI') {
      const r = await q(tx, `
        UPDATE document_asset_links SET status = 'REMOVED', removed_at = now(), updated_at = now()
         WHERE id = $1 AND account_id = $2 AND status = 'ACTIVE' AND origin = 'AI' RETURNING id`, [c.linkId, c.accountId]);
      ok = r.length > 0;
    }
    if (c.column) {
      // Colonne automatique : remise à vide (le déclencheur 0221 retire le lien LEGACY_COLUMN s'il existe).
      const r = await q(tx, `
        UPDATE asset_files
           SET asset_id = NULL, user_edited_fields = COALESCE(user_edited_fields, '{}'::jsonb) - 'assetIdAuto', updated_at = now()
         WHERE id = $1 AND account_id = $2 AND asset_id = $3
           AND asset_id = (user_edited_fields ->> 'assetIdAuto')::int
           AND COALESCE((user_edited_fields ->> 'assetId')::boolean, false) = false
         RETURNING id`, [c.fileId, c.accountId, c.assetId]);
      ok = ok || r.length > 0;
    }
    if (!ok) return false;
    await q(tx, `
      INSERT INTO document_asset_link_admissions
        (account_id, file_id, asset_id, link_id, write_kind, step, rule, origin, link_role, decision, reason_code,
         proofs, rejected, digest, guard_version, run_id, motive, detail)
      VALUES ($1, $2, $3, $4, $5, 'REPAIR', 'ADDRESS_LINK_REEVALUATION', $6, $7, 'REPAIRED', 'ADDRESS_NOT_QUALIFIED',
              $8::jsonb, '[]'::jsonb, $9, $10, $11::uuid, $12, $13::jsonb)`,
    [c.accountId, c.fileId, c.assetId, c.linkId, c.origin === 'LEGACY_COLUMN' ? 'PRIMARY_COLUMN' : 'LINK', c.origin, c.role,
      JSON.stringify(c.justification.proofs), justificationDigest(c.justification), LINK_ADMISSION_VERSION, runId, motive.slice(0, 500),
      JSON.stringify({ column: c.column, addressRole: c.addressRole })]);
    return true;
  };
  const begin = (s as postgres.Sql).begin;
  if (typeof begin === 'function') return (await (s as postgres.Sql).begin((tx) => exec(tx as unknown as Sql))) as unknown as boolean;
  return exec(s);
}

/** Effets dérivés par les moteurs existants (preuves, bien réconcilié, agenda, Opérations ; rattachement principal). */
async function defaultDerived(p: { accountId: number; fileId: number; assetId: number; columnCleared: boolean }): Promise<{ reconciled: boolean; resolutionRequested: boolean }> {
  const { pgClient } = await import('@/db');
  const [a] = (await pgClient.unsafe(`SELECT owner_user_id FROM accounts WHERE id = $1`, [p.accountId] as never[])) as unknown as Row[];
  let reconciled = false;
  if (a?.owner_user_id != null) {
    const { onDocumentAssetChanged } = await import('@/services/ai/evidence/document-evidence-lifecycle');
    await onDocumentAssetChanged({ accountId: p.accountId, userId: Number(a.owner_user_id), fileId: p.fileId, fromAssetId: p.assetId, toAssetId: null });
    reconciled = true;
  }
  let resolutionRequested = false;
  const [f] = (await pgClient.unsafe(`SELECT asset_id, linked_asset_id FROM asset_files WHERE id = $1 AND account_id = $2`, [p.fileId, p.accountId] as never[])) as unknown as Row[];
  if (p.columnCleared && f && f.asset_id == null && f.linked_asset_id == null) {
    const { requestDocumentAssetResolution } = await import('@/services/ai/reconciliation/document-asset/queue');
    await requestDocumentAssetResolution({ accountId: p.accountId, userId: null, fileId: p.fileId, triggerCode: 'coherence', reprocessReason: 'ADDRESS_LINK_REPAIR' });
    resolutionRequested = true;
  }
  return { reconciled, resolutionRequested };
}

export interface AddressLinkRestoreReport { runId: string; restored: number; skipped: number }

/** Annule le retrait d'une exécution (objets inchangés depuis seulement). */
export async function restoreAddressLinkRepair(s: postgres.Sql, runId: string, o: {
  reason?: string | null;
  reconcile?: (p: { accountId: number; assetId: number; fileId: number }) => Promise<void>;
} = {}): Promise<AddressLinkRestoreReport> {
  const rep: AddressLinkRestoreReport = { runId, restored: 0, skipped: 0 };
  if (!(await linkAdmissionJournalReady(s as never))) return rep;
  const lignes = await q(s, `
    SELECT id::float8 AS id, account_id, file_id, asset_id, link_id::float8 AS link_id, write_kind, origin, link_role, proofs, digest, detail
      FROM document_asset_link_admissions
     WHERE run_id = $1::uuid AND decision = 'REPAIRED' AND reverted_at IS NULL ORDER BY id`, [runId]);
  for (const l of lignes) {
    try {
      const ok = await s.begin(async (tx) => {
        const t = tx as unknown as Sql;
        let fait = false;
        const detail = (typeof l.detail === 'string' ? JSON.parse(l.detail) : l.detail ?? {}) as { column?: boolean };
        if (l.origin === 'AI') {
          const r = await q(t, `
            UPDATE document_asset_links SET status = 'ACTIVE', removed_at = NULL, updated_at = now()
             WHERE id = $1 AND account_id = $2 AND status = 'REMOVED'
               AND NOT EXISTS (SELECT 1 FROM document_asset_links x
                                WHERE x.file_id = document_asset_links.file_id AND x.status = 'ACTIVE'
                                  AND COALESCE(x.asset_id, 0) = COALESCE(document_asset_links.asset_id, 0)
                                  AND COALESCE(x.equipment_id, 0) = 0 AND COALESCE(x.room_id, 0) = 0 AND COALESCE(x.substructure_id, 0) = 0)
             RETURNING id`, [l.link_id, l.account_id]);
          fait = r.length > 0;
        }
        if (detail.column === true) {
          const r = await q(t, `
            UPDATE asset_files
               SET asset_id = $3, user_edited_fields = COALESCE(user_edited_fields, '{}'::jsonb) || jsonb_build_object('assetIdAuto', $3::int), updated_at = now()
             WHERE id = $1 AND account_id = $2 AND asset_id IS NULL AND linked_asset_id IS NULL AND deleted_at IS NULL
               AND COALESCE((user_edited_fields ->> 'assetId')::boolean, false) = false
             RETURNING id`, [l.file_id, l.account_id, l.asset_id]);
          fait = fait || r.length > 0;
        }
        if (!fait) return false;
        await q(t, `UPDATE document_asset_link_admissions SET reverted_at = now() WHERE id = $1`, [l.id]);
        await q(t, `
          INSERT INTO document_asset_link_admissions
            (account_id, file_id, asset_id, link_id, write_kind, step, rule, origin, link_role, decision, reason_code,
             proofs, digest, guard_version, run_id, motive, detail)
          VALUES ($1, $2, $3, $4, $5, 'REPAIR', 'ADDRESS_LINK_RESTORE', $6, $7, 'RESTORED', 'ADDRESS_NOT_QUALIFIED',
                  $8::jsonb, $9, $10, $11::uuid, $12, '{}'::jsonb)`,
        [l.account_id, l.file_id, l.asset_id, l.link_id, l.write_kind, l.origin, l.link_role,
          typeof l.proofs === 'string' ? l.proofs : JSON.stringify(l.proofs ?? []), l.digest, LINK_ADMISSION_VERSION, runId, (o.reason ?? '').slice(0, 500) || null]);
        return true;
      });
      if (!ok) { rep.skipped++; continue; }
      rep.restored++;
      try {
        await (o.reconcile ?? defaultReconcile)({ accountId: Number(l.account_id), assetId: Number(l.asset_id), fileId: Number(l.file_id) });
      } catch (e) {
        console.warn(`[rattachement] restauration : bien ${String(l.asset_id)} non réconcilié :`, (e as Error).message);
      }
    } catch {
      rep.skipped++;
    }
  }
  return rep;
}

async function defaultReconcile(p: { accountId: number; assetId: number; fileId: number }): Promise<void> {
  const { pgClient } = await import('@/db');
  const [a] = (await pgClient.unsafe(`SELECT owner_user_id FROM accounts WHERE id = $1`, [p.accountId] as never[])) as unknown as Row[];
  if (a?.owner_user_id == null) return;
  const { enqueueT3ForAssets } = await import('@/services/ai/reconciliation/t3-queue');
  await enqueueT3ForAssets({ accountId: p.accountId, userId: Number(a.owner_user_id), assetIds: [p.assetId], sourceFileId: p.fileId, reason: 'ADDRESS_LINK_RESTORE' });
}
