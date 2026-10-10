/**
 * Réconciliation CONTINUE des FAITS sans cible (lot 34E — ticket « T3 :
 * rendre la réconciliation globale réellement continue », §« Réévaluer les
 * facts », cas 2).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *   Fait : serialNumber = ABC123, cible = null
 *   puis équipement « Chaudière » : serialNumber = ABC123
 *   → T3 identifie l'équipement, précise la cible du fait, relie le document
 *     à l'équipement (lien SECONDARY d'origine IA), demande la réconciliation
 *     ciblée de l'équipement — SANS relancer T1.
 *
 * Même principe pour un fait rattaché au BIEN qui peut être PRÉCISÉ vers un
 * équipement de ce bien, et pour un fait d'identifiant sans cible qui désigne
 * un bien (immatriculation, VIN, série, cadastre).
 *
 * Déterministe seulement (identifiant exact, normalisé, UNIQUE dans le
 * compte) — jamais d'IA. Autorité utilisateur : un document dont l'utilisateur
 * a choisi ou retiré le bien n'est jamais relié par T3 à un équipement d'un
 * AUTRE bien (comptabilisé `userProtected`).
 *
 * Pas de boucle : le passage n'a lieu que si la révision de connaissance du
 * compte a avancé depuis le dernier (état `t3_reconciliation_states`), et
 * l'empreinte du contexte (faits ouverts × identifiants indexés) inchangée
 * ne produit aucune écriture métier.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { pgClient } from '@/db';
import type { ExecutionGuard } from '../../queue/execution-control';
import { normalizeCode } from '../document-asset/identifiers';
import { normalizePlate, normalizeVin } from '@/lib/vehicle-identifiers';
import type { AccountMatchingIndex } from '../document-asset/matching-index';
import { getReconciliationState, recordReconciliationState } from './reconciliation-state.repository';

export const FACT_TARGET_RELATION = 'FACT_TARGET';
/** Version du moteur de rapprochement des faits (entre dans l'état). */
export const FACT_TARGET_ENGINE_VERSION = 1;
/** Faits ouverts lus au plus par passage (borné ; le suivant reprend). */
export const FACT_TARGET_MAX_FACTS = 2000;

/** Clés d'identifiant exploitées, et leur normalisation. */
const KEYS: Readonly<Record<string, (v: unknown) => string>> = {
  serialNumber: normalizeCode,
  registrationNumber: (v) => normalizePlate(v as string),
  vin: (v) => normalizeVin(v as string),
  cadastralRef: normalizeCode,
};

export interface OpenFact {
  id: number;
  fileId: number;
  canonicalKey: string;
  value: string;
  targetType: string | null;
  targetEntityId: number | null;
}

export type FactTargetMatch =
  | { factId: number; fileId: number; kind: 'EQUIPMENT'; equipmentId: number; assetId: number; label: string; previous: { type: string | null; id: number | null } }
  | { factId: number; fileId: number; kind: 'ASSET'; assetId: number; label: string; previous: { type: string | null; id: number | null } };

/**
 * Rapprochements CERTAINS (pure) : valeur normalisée identique à UN SEUL
 * équipement (numéro de série) ou à UN SEUL bien. Un fait déjà ciblé sur un
 * bien n'est précisé que vers un équipement DE CE bien.
 */
export function matchOpenFacts(facts: readonly OpenFact[], index: Pick<AccountMatchingIndex, 'entities' | 'records' | 'byId'>): FactTargetMatch[] {
  const equipBySerial = new Map<string, Array<{ id: number; assetId: number; name: string }>>();
  for (const e of index.entities) {
    if (e.type !== 'EQUIPMENT' || !e.serial) continue;
    equipBySerial.set(e.serial, [...(equipBySerial.get(e.serial) ?? []), { id: e.id, assetId: e.assetId, name: e.name }]);
  }
  const assetByValue = new Map<string, number[]>();
  for (const r of index.records) {
    for (const [k, norm] of Object.entries(KEYS)) {
      const v = r.values[k];
      if (!v) continue;
      const n = norm(v);
      if (n.length < 5 || !/\d/.test(n)) continue;
      const key = `${k}:${n}`;
      assetByValue.set(key, [...new Set([...(assetByValue.get(key) ?? []), r.assetId])]);
    }
  }
  const out: FactTargetMatch[] = [];
  for (const f of facts) {
    const norm = KEYS[f.canonicalKey];
    if (!norm) continue;
    const n = norm(f.value);
    if (n.length < 5 || !/\d/.test(n)) continue;
    const previous = { type: f.targetType, id: f.targetEntityId };
    const cibleBien = f.targetType === 'ASSET' && f.targetEntityId != null ? f.targetEntityId : null;
    if (f.canonicalKey === 'serialNumber') {
      const eqs = equipBySerial.get(n) ?? [];
      if (eqs.length === 1 && (cibleBien === null || cibleBien === eqs[0].assetId)) {
        out.push({ factId: f.id, fileId: f.fileId, kind: 'EQUIPMENT', equipmentId: eqs[0].id, assetId: eqs[0].assetId, label: eqs[0].name, previous });
        continue;
      }
      if (eqs.length > 0) continue;
    }
    if (f.targetEntityId != null) continue;
    const biens = assetByValue.get(`${f.canonicalKey}:${n}`) ?? [];
    if (biens.length === 1) {
      out.push({ factId: f.id, fileId: f.fileId, kind: 'ASSET', assetId: biens[0], label: index.byId.get(biens[0])?.name ?? `Bien ${biens[0]}`, previous });
    }
  }
  return out;
}

/** Empreinte du contexte (pure) : faits ouverts × identifiants indexés. */
export function factTargetFingerprint(facts: readonly OpenFact[], index: Pick<AccountMatchingIndex, 'entities' | 'records'>): string {
  return createHash('sha256').update(JSON.stringify({
    v: FACT_TARGET_ENGINE_VERSION,
    f: [...facts].sort((a, b) => a.id - b.id).map((f) => [f.id, f.canonicalKey, f.value, f.targetType, f.targetEntityId]),
    e: index.entities.filter((e) => e.serial).map((e) => [e.id, e.assetId, e.serial]).sort(),
    a: index.records.map((r) => [r.assetId, Object.keys(KEYS).map((k) => r.values[k] ?? null)]),
  })).digest('hex');
}

async function loadOpenFacts(accountId: number): Promise<OpenFact[]> {
  const rows = (await pgClient.unsafe(
    `SELECT d.id::float8 AS id, d.file_id, COALESCE(d.canonical_key, d.raw_key) AS canonical_key,
            COALESCE(d.normalized_value, d.value_text) AS v, d.target_type, d.target_entity_id
       FROM document_facts d
       JOIN asset_files f ON f.id = d.file_id AND f.account_id = d.account_id AND f.deleted_at IS NULL
      -- Clé canonique, ou clé brute quand la projection l'a écartée (n° de
      -- série lu sur le document d'un bien immobilier : champ d'objet).
      WHERE d.account_id = $1 AND d.status = 'active' AND COALESCE(d.canonical_key, d.raw_key) = ANY($2::text[])
        AND (d.target_entity_id IS NULL OR d.target_type = 'ASSET')
      ORDER BY d.id LIMIT ${FACT_TARGET_MAX_FACTS}`,
    [accountId, Object.keys(KEYS)] as never[],
  )) as unknown as Array<{ id: number; file_id: number; canonical_key: string; v: string | null; target_type: string | null; target_entity_id: number | null }>;
  return rows.filter((r) => r.v).map((r) => ({
    id: Number(r.id), fileId: Number(r.file_id), canonicalKey: r.canonical_key, value: String(r.v),
    targetType: r.target_type, targetEntityId: r.target_entity_id == null ? null : Number(r.target_entity_id),
  }));
}

export interface FactTargetResult {
  skipped: boolean;
  examined: number;
  matched: number;
  retargeted: number;
  linkedEquipments: number;
  userProtected: number;
  fingerprintChanged: boolean;
}

/**
 * Passage sur un compte. `revision` : révision de connaissance lue par
 * l'appelant AVANT les lectures. Ne lève que sur interruption.
 */
export async function reconcileFactTargets(p: {
  accountId: number; revision: number; index: AccountMatchingIndex; guard?: ExecutionGuard;
}): Promise<FactTargetResult> {
  const vide: FactTargetResult = { skipped: true, examined: 0, matched: 0, retargeted: 0, linkedEquipments: 0, userProtected: 0, fingerprintChanged: false };
  const prev = await getReconciliationState(FACT_TARGET_RELATION, 'ACCOUNT', p.accountId);
  if (prev && prev.engineVersion === FACT_TARGET_ENGINE_VERSION && prev.knowledgeRevision != null && prev.knowledgeRevision >= p.revision) {
    return vide;
  }
  const facts = await loadOpenFacts(p.accountId);
  const fingerprint = factTargetFingerprint(facts, p.index);
  const res: FactTargetResult = { ...vide, skipped: false, examined: facts.length, fingerprintChanged: prev?.contextFingerprint !== fingerprint };
  if (!res.fingerprintChanged && prev?.engineVersion === FACT_TARGET_ENGINE_VERSION) {
    await recordReconciliationState({
      relation: FACT_TARGET_RELATION, subjectType: 'ACCOUNT', subjectId: p.accountId, accountId: p.accountId,
      engineVersion: FACT_TARGET_ENGINE_VERSION, knowledgeRevision: p.revision, contextFingerprint: fingerprint,
      result: 'CONFIRMED_NO_CHANGE', reason: 'CONTEXT_UNCHANGED', detail: { examined: facts.length, aiCalled: false },
    });
    return res;
  }

  const matches = matchOpenFacts(facts, p.index);
  res.matched = matches.length;
  const { readAttachmentState, hasUserDecision } = await import('../document-asset/attachment-state');
  const equipementsTouches = new Map<number, { fileId: number; userId: number | null }>();
  const documentsRelies = new Set<string>();
  for (const m of matches) {
    const state = await readAttachmentState(p.accountId, m.fileId);
    if (!state.exists) continue;
    // Autorité utilisateur : bien choisi (ou retiré) par l'utilisateur, et
    // différent du bien porteur de la cible → aucune écriture automatique.
    const userAsset = state.userEdited ? state.columnAssetId : state.userLinkAssetIds[0] ?? null;
    if (hasUserDecision(state) && userAsset !== m.assetId) { res.userProtected += 1; continue; }
    await p.guard?.assertActive('T3 faits sans cible — précision de la cible');
    const ok = (await pgClient.unsafe(
      `UPDATE document_facts
          SET target_type = $2, target_entity_id = $3, target_entity_label = $4, target_confidence = 'certain',
              projection_rule = 'T3_IDENTIFIER_MATCH'
        WHERE id = $1 AND status = 'active'
          AND target_type IS NOT DISTINCT FROM $5 AND target_entity_id IS NOT DISTINCT FROM $6::int
        RETURNING id`,
      [m.factId, m.kind, m.kind === 'EQUIPMENT' ? m.equipmentId : m.assetId, m.label.slice(0, 200),
       m.previous.type, m.previous.id] as never[],
    )) as unknown as unknown[];
    if (ok.length === 0) continue;
    res.retargeted += 1;
    if (m.kind === 'EQUIPMENT' && !documentsRelies.has(`${m.fileId}:${m.equipmentId}`)) {
      documentsRelies.add(`${m.fileId}:${m.equipmentId}`);
      await p.guard?.assertActive('T3 faits sans cible — relation document ↔ équipement');
      const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');
      // Lien SECONDARY = document rattaché (listes du bien porteur) : la
      // question « À quel bien… ? » est close par le SYSTÈME (sinon le
      // déclencheur 0257 la fermerait avec un motif utilisateur).
      const { closeAssetLinkQuestion } = await import('../document-asset/automatic-attachment');
      await closeAssetLinkQuestion(p.accountId, m.fileId);
      const r = await linkDocumentToAsset({
        accountId: p.accountId, fileId: m.fileId, target: { equipmentId: m.equipmentId }, role: 'SECONDARY', origin: 'AI', confidence: 1,
      });
      if (r.outcome !== 'unchanged') res.linkedEquipments += 1;
      equipementsTouches.set(m.equipmentId, { fileId: m.fileId, userId: state.userId });
    }
  }

  // Réconciliation ciblée des équipements identifiés, puis titre des documents.
  for (const [equipmentId, t] of equipementsTouches) {
    if (!t.userId) continue;
    try {
      const { enqueueT3ForEntities } = await import('../t3-queue');
      await enqueueT3ForEntities({
        accountId: p.accountId, userId: t.userId, targets: [{ type: 'EQUIPMENT', id: equipmentId }],
        sourceFileId: t.fileId, triggeredBy: 'document_linked', reason: 'fact_target_identified',
      });
    } catch (e) {
      console.error(`[t3-fact-target] réconciliation de l'équipement ${equipmentId} non demandée :`, (e as Error).message);
    }
  }
  if (equipementsTouches.size > 0) {
    const { refreshDocumentTitle } = await import('../document-asset/resolve-document-asset.service');
    for (const fileId of new Set([...equipementsTouches.values()].map((t) => t.fileId))) await refreshDocumentTitle(p.accountId, fileId);
  }

  await recordReconciliationState({
    relation: FACT_TARGET_RELATION, subjectType: 'ACCOUNT', subjectId: p.accountId, accountId: p.accountId,
    engineVersion: FACT_TARGET_ENGINE_VERSION, knowledgeRevision: p.revision,
    // Après écriture, l'empreinte des faits ouverts a changé : relue pour ne pas rejouer.
    contextFingerprint: res.retargeted > 0 ? factTargetFingerprint(await loadOpenFacts(p.accountId), p.index) : fingerprint,
    result: res.retargeted > 0 ? 'APPLIED' : 'NO_CHANGE',
    reason: res.retargeted > 0 ? 'IDENTIFIER_MATCH' : res.userProtected > 0 ? 'USER_DECISION' : 'NO_MATCH',
    detail: { ...res, aiCalled: false },
  });
  if (res.retargeted > 0) {
    console.info(`[t3-fact-target] compte ${p.accountId} : ${res.retargeted} fait(s) précisé(s), ${res.linkedEquipments} relation(s) document ↔ équipement.`);
  }
  return res;
}
