/**
 * Rattachement document ↔ équipement — service (lot 71A, BUG P1 point B ;
 * ticket P1 « contexte T3 équipements »).
 *
 * Deux parcours, mêmes profils, mêmes règles (`document-equipment-matching`) :
 *   · DOCUMENT_EQUIPMENT — `syncDocumentEquipmentLinks` : après T1, après un
 *     rattachement tardif à un bien (T3), à la validation, au rattrapage ;
 *   · EQUIPMENT_DOCUMENT — `syncEquipmentDocumentLinks` : équipement créé
 *     (ou modifié) APRÈS ses documents.
 *
 * Réutilise les relations EXISTANTES, sans nouvelle colonne :
 *   · lien N-N `document_asset_links` (cible équipement, rôle SECONDARY,
 *     origine AI) — un par équipement désigné (associations multiples) ; le
 *     bien porteur est déduit par `linkDocumentToAsset` : le document reste
 *     dans la liste du bien, sans duplication physique ;
 *   · colonne historique `asset_files.equipment_id` posée seulement si elle
 *     est vide, qu'UN seul équipement est désigné et que l'utilisateur n'a
 *     pas choisi lui-même (`user_edited_fields.equipmentId`) ;
 *   · ambiguïté : T3 (`reconcileLinks`, opération et prompt existants,
 *     contrat de sortie inchangé) seulement pour les VRAIES ambiguïtés, avec
 *     un contexte enrichi ; à défaut carte « À traiter » LINK-ELT. Le
 *     document reste rattaché au bien seul — jamais de choix arbitraire.
 *
 * Protections : document, biens et équipements lus DANS LE COMPTE ; un choix
 * de l'utilisateur (équipement posé ou retiré dans le tiroir, lien USER
 * retiré / rejeté) n'est jamais contredit ; les liens USER / LEGACY_COLUMN ne
 * sont jamais modifiés (`canRefresh`). Idempotent : rejoué, rien de plus.
 */
import { pgClient } from '@/db';
import { isExecutionCancelled } from '@/services/ai/queue/execution-control';
import {
  formatDocumentSubject, formatEquipmentCandidate, formatEquipmentSubject, formatDocumentCandidate,
  matchDocumentToEquipments, type DocumentProfile, type EquipmentMatch, type EquipmentProfile, type MatchResult,
} from './document-equipment-matching';

type Sql = typeof pgClient;
type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === '' ? null : String(v));
const n = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const kcOf = (v: unknown): Record<string, unknown> => {
  if (!v) return {};
  if (typeof v === 'object') return v as Record<string, unknown>;
  try { return JSON.parse(String(v)) as Record<string, unknown>; } catch { return {}; }
};

// ── Profils (sources canoniques, bornées au compte) ─────────────────────────

const ENERGY_USAGE_LABELS: Record<string, string> = {
  chauffage: 'chauffage', refroidissement: 'refroidissement', ecs: 'eau chaude sanitaire', ventilation: 'ventilation', enr: 'énergie renouvelable', aucun: 'aucun',
};

/**
 * Profils des équipements ACTUELS (non archivés) des biens donnés, ou des
 * équipements donnés, du compte. Marque, modèle, n° de série et
 * caractéristiques : vue CANONIQUE de la fiche de l'équipement (fiche 0227
 * prioritaire, colonnes miroirs en repli). Aucune donnée d'achat.
 */
export async function loadEquipmentProfiles(
  accountId: number,
  sel: { assetIds?: readonly number[]; equipmentIds?: readonly number[] },
  sql: Sql = pgClient,
): Promise<EquipmentProfile[]> {
  const assetIds = [...new Set(sel.assetIds ?? [])].filter((x) => Number.isSafeInteger(x) && x > 0);
  const equipmentIds = [...new Set(sel.equipmentIds ?? [])].filter((x) => Number.isSafeInteger(x) && x > 0);
  if (!assetIds.length && !equipmentIds.length) return [];
  const rows = (await sql.unsafe(
    `SELECT e.id, e.asset_id, a.name AS asset_name, e.name, e.type, e.category, e.energy_usage,
            to_jsonb(e)->'key_characteristics' AS kc, e.purchase_price_cents AS ppc, e.estimated_value_cents AS evc,
            sp.id AS spec_id, sp.brand, sp.model, sp.serial_number AS sn, sp.power_kw AS pkw, sp.energy_label,
            sub.name AS room
       FROM equipments e
       JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
       LEFT JOIN equipment_cil_specs sp ON sp.equipment_id = e.id
       LEFT JOIN substructures sub ON sub.id = e.substructure_id
      WHERE e.archived_at IS NULL AND (e.asset_id = ANY($2::int[]) OR e.id = ANY($3::int[]))
      ORDER BY e.id LIMIT 500`,
    [accountId, assetIds, equipmentIds] as never[],
  )) as unknown as Row[];
  const { buildCanonicalEntityState } = await import('@/services/canonical/entity-state/entity-view');
  return rows.map((r) => {
    const st = buildCanonicalEntityState({
      target: { type: 'EQUIPMENT', id: Number(r.id) }, assetId: Number(r.asset_id), accountId, name: s(r.name), archived: false,
      kc: kcOf(r.kc), hasSpecs: r.spec_id != null,
      columns: {
        'equipments.purchase_price_cents': r.ppc ?? null, 'equipments.estimated_value_cents': r.evc ?? null,
        'equipment_cil_specs.brand': r.brand ?? null, 'equipment_cil_specs.model': r.model ?? null,
        'equipment_cil_specs.serial_number': r.sn ?? null, 'equipment_cil_specs.power_kw': r.pkw ?? null,
      },
    });
    const v = (k: string) => s(st.fields[k]?.value);
    const features = [
      v('powerKw') ? `puissance:${v('powerKw')} kW` : null,
      v('cop') ? `COP:${v('cop')}` : null,
      v('refrigerant') ? `fluide:${v('refrigerant')}` : null,
      s(r.energy_label) ? `étiquette énergie:${s(r.energy_label)}` : null,
      s(r.energy_usage) ? `usage:${ENERGY_USAGE_LABELS[String(r.energy_usage)] ?? String(r.energy_usage)}` : null,
    ].filter((x): x is string => !!x);
    return {
      id: Number(r.id), assetId: Number(r.asset_id), assetName: s(r.asset_name), name: String(r.name ?? ''),
      type: s(r.type), category: s(r.category), brand: v('brand'), model: v('modelName'), serialNumber: v('serialNumber'),
      room: s(r.room), features,
    };
  });
}

interface DocumentRow {
  profile: DocumentProfile;
  equipmentId: number | null;
  /** Bien principal (carte LINK-ELT) : `asset_id`, sinon `linked_asset_id`. */
  mainAssetId: number | null;
  userChoseEquipment: boolean;
}

/** Profil d'un document du compte : métadonnées, biens rattachés, faits T1 actifs (cibles, preuves). */
export async function loadDocumentProfile(accountId: number, fileId: number, sql: Sql = pgClient): Promise<DocumentRow | null> {
  const [f] = (await sql.unsafe(
    `SELECT f.id, f.retained_title, f.original_filename, coalesce(f.document_type_code, f.document_type) AS type_code,
            f.description, f.supplier, f.document_date::text AS document_date, f.amount_cents, f.asset_id, f.linked_asset_id,
            f.equipment_id, COALESCE(f.user_edited_fields->>'equipmentId', 'false') = 'true' AS user_equipment
       FROM asset_files f WHERE f.id = $1 AND f.account_id = $2 AND f.deleted_at IS NULL`,
    [fileId, accountId] as never[],
  )) as unknown as Row[];
  if (!f) return null;
  const biens = (await sql.unsafe(
    `SELECT a.id, a.name FROM assets a
      WHERE a.account_id = $2 AND a.deleted_at IS NULL
        AND (a.id = ANY($3::int[]) OR a.id IN (SELECT l.asset_id FROM document_asset_links l
                                                 WHERE l.file_id = $1 AND l.account_id = $2 AND l.status = 'ACTIVE'
                                                   AND l.link_role IN ('PRIMARY', 'SECONDARY') AND l.asset_id IS NOT NULL))
      ORDER BY a.id`,
    [fileId, accountId, [n(f.asset_id), n(f.linked_asset_id)].filter((x): x is number => x !== null)] as never[],
  )) as unknown as Row[];
  let faits: Row[] = [];
  try {
    faits = (await sql.unsafe(
      `SELECT COALESCE(canonical_key, raw_key, fact_key) AS key, COALESCE(normalized_value, value_text, value_number::text) AS value,
              label, target_type, target_entity_id, target_entity_label, excerpt
         FROM document_facts WHERE file_id = $1 AND account_id = $2 AND status = 'active'
        ORDER BY id LIMIT 200`,
      [fileId, accountId] as never[],
    )) as unknown as Row[];
  } catch (e) {
    console.warn(`[document-equipment] faits du document ${fileId} illisibles :`, (e as Error).message);
  }
  return {
    profile: {
      fileId, title: s(f.retained_title) ?? s(f.original_filename), typeCode: s(f.type_code), description: s(f.description),
      supplier: s(f.supplier), documentDate: s(f.document_date), amountCents: n(f.amount_cents),
      assetIds: biens.map((b) => Number(b.id)), assetNames: biens.map((b) => String(b.name ?? '')),
      facts: faits.filter((x) => s(x.value)).map((x) => ({
        key: String(x.key ?? ''), value: String(x.value), label: s(x.label), targetType: s(x.target_type),
        targetId: n(x.target_entity_id), targetLabel: s(x.target_entity_label), excerpt: s(x.excerpt),
      })),
    },
    equipmentId: n(f.equipment_id),
    mainAssetId: n(f.asset_id) ?? n(f.linked_asset_id),
    userChoseEquipment: f.user_equipment === true,
  };
}

// ── Écritures ───────────────────────────────────────────────────────────────

/** Équipements dont l'utilisateur a retiré / rejeté le lien avec ce document. */
async function userRefusedEquipments(accountId: number, fileId: number, sql: Sql): Promise<Set<number>> {
  const rows = (await sql.unsafe(
    `SELECT DISTINCT equipment_id FROM document_asset_links
      WHERE account_id = $1 AND file_id = $2 AND equipment_id IS NOT NULL AND origin = 'USER' AND status IN ('REMOVED', 'REJECTED')`,
    [accountId, fileId] as never[],
  )) as unknown as Row[];
  return new Set(rows.map((r) => Number(r.equipment_id)));
}

async function writeLinks(
  accountId: number, doc: DocumentRow, links: EquipmentMatch[], sql: Sql,
): Promise<{ created: number; linked: number[]; columnSet: boolean; refused: number[] }> {
  const refusees = await userRefusedEquipments(accountId, doc.profile.fileId, sql);
  const retenus = links.filter((l) => !refusees.has(l.equipmentId));
  const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');
  let created = 0;
  const linked: number[] = [];
  for (const l of retenus) {
    try {
      const r = await linkDocumentToAsset({
        accountId, fileId: doc.profile.fileId, target: { equipmentId: l.equipmentId },
        role: 'SECONDARY', origin: 'AI', confidence: l.score,
      });
      linked.push(l.equipmentId);
      if (r.outcome === 'created') created++;
    } catch (e) {
      console.warn(`[document-equipment] lien document ${doc.profile.fileId} → équipement ${l.equipmentId} non posé :`, (e as Error).message);
    }
  }
  let columnSet = false;
  if (linked.length === 1 && doc.equipmentId === null && !doc.userChoseEquipment) {
    const r = (await sql.unsafe(
      `UPDATE asset_files f SET equipment_id = $3, updated_at = now()
        WHERE f.id = $1 AND f.account_id = $2 AND f.deleted_at IS NULL AND f.equipment_id IS NULL
          AND COALESCE(f.user_edited_fields->>'equipmentId', 'false') <> 'true'
          AND EXISTS (SELECT 1 FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL
                       WHERE e.id = $3 AND e.archived_at IS NULL)
        RETURNING f.id`,
      [doc.profile.fileId, accountId, linked[0]] as never[],
    )) as unknown as unknown[];
    columnSet = r.length > 0;
  }
  return { created, linked, columnSet, refused: links.filter((l) => refusees.has(l.equipmentId)).map((l) => l.equipmentId) };
}

// ── DOCUMENT_EQUIPMENT ──────────────────────────────────────────────────────

/** Arbitrage T3 d'une ambiguïté document → équipement (injectable en test). */
export type DocumentArbitrate = (p: {
  accountId: number; fileId: number; subjectContext: string; equipmentsList: string; candidateIds: number[];
}) => Promise<{ equipmentId: number | null; score: number; reason: string; abstained: boolean }>;

export const defaultDocumentArbitrate: DocumentArbitrate = async (p) => {
  const { reconcileLinks, retainAbove, LINK_SCORE_THRESHOLDS } = await import('@/services/ai/reconciliation/link-reconciler');
  const r = await reconcileLinks({
    accountId: p.accountId, sourceIds: [p.fileId],
    variables: {
      SUBJECT_CONTEXT: p.subjectContext, DOCUMENTS_LIST: '(sans objet)', AGENDA_LIST: '(sans objet)',
      SUPPLIERS_LIST: '(sans objet)', EQUIPMENTS_LIST: p.equipmentsList,
    },
  });
  if ((r.ambiguities ?? []).some((a) => a.section === 'matches')) return { equipmentId: null, score: 0, reason: 'abstention T3', abstained: true };
  const best = retainAbove(r.matches, LINK_SCORE_THRESHOLDS.documentToEquipment).filter((m) => p.candidateIds.includes(m.id))[0];
  return best ? { equipmentId: best.id, score: best.score, reason: best.reason, abstained: false } : { equipmentId: null, score: 0, reason: 'aucun candidat retenu', abstained: false };
};

export type DocumentEquipmentStatus = MatchResult['status'] | 'NOT_FOUND' | 'NO_ASSET' | 'NO_EQUIPMENT' | 'USER_PROTECTED';

export interface DocumentEquipmentResult {
  fileId: number;
  status: DocumentEquipmentStatus;
  /** Équipements rattachés (liens actifs posés ou confirmés). */
  linked: number[];
  /** Liens créés par ce passage (0 au second passage : idempotent). */
  created: number;
  columnSet: boolean;
  ambiguous: number[];
  aiCalled: boolean;
  cardProposed: boolean;
  methods: string[];
}

export interface SyncDocumentOptions {
  accountId: number;
  fileId: number;
  /** T3 pour une vraie ambiguïté (défaut : non). */
  allowAi?: boolean;
  /** Carte LINK-ELT pour une ambiguïté non résolue (défaut : oui). */
  proposeCard?: boolean;
  /** Simulation : décision calculée, rien n'est écrit. */
  dryRun?: boolean;
  guard?: { assertActive(what: string): Promise<void> };
  arbitrate?: DocumentArbitrate;
  /** Équipements déjà chargés (parcours EQUIPMENT_DOCUMENT). */
  equipments?: EquipmentProfile[];
  sql?: Sql;
}

/**
 * Rattache un document aux équipements qu'il désigne parmi ceux de SES
 * biens. Ne lève pas (sauf interruption d'exécution) : un échec est
 * journalisé, le document reste rattaché au bien.
 */
export async function syncDocumentEquipmentLinks(o: SyncDocumentOptions): Promise<DocumentEquipmentResult> {
  const sql = o.sql ?? pgClient;
  const out: DocumentEquipmentResult = {
    fileId: o.fileId, status: 'NOT_FOUND', linked: [], created: 0, columnSet: false, ambiguous: [], aiCalled: false, cardProposed: false, methods: [],
  };
  const doc = await loadDocumentProfile(o.accountId, o.fileId, sql);
  if (!doc) return out;
  if (doc.userChoseEquipment) return { ...out, status: 'USER_PROTECTED' };
  if (doc.profile.assetIds.length === 0) return { ...out, status: 'NO_ASSET' };
  const equipements = (o.equipments ?? await loadEquipmentProfiles(o.accountId, { assetIds: doc.profile.assetIds }, sql))
    .filter((e) => doc.profile.assetIds.includes(e.assetId));
  if (equipements.length === 0) return { ...out, status: 'NO_EQUIPMENT' };

  const m = matchDocumentToEquipments(doc.profile, equipements);
  let links = m.links;
  let status: DocumentEquipmentStatus = m.status;
  out.ambiguous = m.ambiguous.map((x) => x.equipmentId);

  if (m.status === 'AMBIGUOUS' && o.allowAi) {
    await o.guard?.assertActive('rattachement document → équipement — arbitrage T3');
    const candidats = equipements.filter((e) => out.ambiguous.includes(e.id));
    out.aiCalled = true;
    try {
      const r = await (o.arbitrate ?? defaultDocumentArbitrate)({
        accountId: o.accountId, fileId: o.fileId,
        subjectContext: formatDocumentSubject(doc.profile),
        equipmentsList: candidats.map(formatEquipmentCandidate).join('\n'),
        candidateIds: candidats.map((e) => e.id),
      });
      if (r.equipmentId !== null && out.ambiguous.includes(r.equipmentId)) {
        links = [{ equipmentId: r.equipmentId, method: 'DESIGNATION', score: Math.min(1, Math.max(0, r.score)), reason: `Arbitrage T3 — ${r.reason}`.slice(0, 200) }];
        status = 'LINKED';
        out.methods.push('T3');
      }
    } catch (e) {
      if (isExecutionCancelled(e)) throw e;
      console.warn(`[document-equipment] arbitrage T3 du document ${o.fileId} indisponible :`, (e as Error).message);
    }
  }
  out.status = status;
  out.methods.push(...links.map((l) => l.method));
  if (o.dryRun) {
    // Simulation : liens qui SERAIENT créés (un lien actif existant n'est pas recompté).
    const ids = links.map((l) => l.equipmentId);
    const existants = ids.length ? (await sql.unsafe(
      `SELECT DISTINCT equipment_id FROM document_asset_links
        WHERE account_id = $1 AND file_id = $2 AND status = 'ACTIVE' AND equipment_id = ANY($3::int[])`,
      [o.accountId, o.fileId, ids] as never[],
    )) as unknown as Row[] : [];
    const deja = new Set(existants.map((r) => Number(r.equipment_id)));
    const refus = await userRefusedEquipments(o.accountId, o.fileId, sql);
    return { ...out, linked: ids, created: ids.filter((id) => !deja.has(id) && !refus.has(id)).length };
  }

  if (links.length > 0) {
    await o.guard?.assertActive('rattachement document → équipement — écriture');
    const w = await writeLinks(o.accountId, doc, links, sql);
    Object.assign(out, { linked: w.linked, created: w.created, columnSet: w.columnSet });
  }
  // Ambiguïté restante : l'utilisateur tranche (carte LINK-ELT, idempotente).
  const enSuspens = status === 'AMBIGUOUS' ? out.ambiguous : [];
  if (enSuspens.length >= 2 && o.proposeCard !== false && doc.mainAssetId !== null) {
    const duBien = m.ambiguous.filter((x) => equipements.find((e) => e.id === x.equipmentId)?.assetId === doc.mainAssetId);
    if (duBien.length >= 2) {
      try {
        const { proposeDocumentEquipmentLink } = await import('@/services/to-process/document-equipment-link');
        const r = await proposeDocumentEquipmentLink({
          accountId: o.accountId, fileId: o.fileId, assetId: doc.mainAssetId,
          candidates: duBien.map((x) => ({ equipmentId: x.equipmentId, score: x.score, reason: x.reason })),
        });
        out.cardProposed = r.status === 'CREATED' || r.status === 'UPDATED';
      } catch (e) {
        console.warn(`[document-equipment] carte LINK-ELT du document ${o.fileId} non créée :`, (e as Error).message);
      }
    }
  }
  return out;
}

// ── EQUIPMENT_DOCUMENT ──────────────────────────────────────────────────────

/** Arbitrage T3 « documents qui concernent cet équipement » (injectable en test). */
export type EquipmentArbitrate = (p: {
  accountId: number; equipmentId: number; subjectContext: string; documentsList: string; candidateIds: number[];
}) => Promise<Array<{ fileId: number; score: number; reason: string }>>;

export const defaultEquipmentArbitrate: EquipmentArbitrate = async (p) => {
  const { reconcileLinks, retainAbove, LINK_SCORE_THRESHOLDS } = await import('@/services/ai/reconciliation/link-reconciler');
  const r = await reconcileLinks({
    accountId: p.accountId, sourceIds: p.candidateIds,
    variables: {
      SUBJECT_CONTEXT: p.subjectContext, DOCUMENTS_LIST: p.documentsList, AGENDA_LIST: '(sans objet)',
      SUPPLIERS_LIST: '(sans objet)', EQUIPMENTS_LIST: '(sans objet)',
    },
  });
  // Seuil du rattachement d'un document à UN équipement (relation départagée entre équipements similaires).
  return retainAbove(r.documents, LINK_SCORE_THRESHOLDS.documentToEquipment)
    .filter((m) => p.candidateIds.includes(m.id)).map((m) => ({ fileId: m.id, score: m.score, reason: m.reason }));
};

export interface EquipmentDocumentResult {
  equipmentId: number;
  examined: number;
  /** Documents rattachés à CET équipement. */
  linkedDocuments: number[];
  created: number;
  ambiguousDocuments: number[];
  aiCalls: number;
  found: boolean;
}

/** Documents (ids) rattachés à un bien du compte : colonnes historiques ou liens PRIMARY / SECONDARY actifs. */
export async function documentsOfAsset(accountId: number, assetId: number, sql: Sql = pgClient, limit = 500): Promise<number[]> {
  const rows = (await sql.unsafe(
    `SELECT f.id FROM asset_files f
      WHERE f.account_id = $1 AND f.deleted_at IS NULL
        AND (f.asset_id = $2 OR f.linked_asset_id = $2
             OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = f.id AND l.account_id = f.account_id
                         AND l.status = 'ACTIVE' AND l.link_role IN ('PRIMARY', 'SECONDARY') AND l.asset_id = $2))
      ORDER BY f.id LIMIT ${Math.max(1, Math.min(5000, limit))}`,
    [accountId, assetId] as never[],
  )) as unknown as Row[];
  return rows.map((r) => Number(r.id));
}

/**
 * Équipement créé (ou modifié) APRÈS ses documents : chaque document de son
 * bien est rapproché parmi TOUS les équipements du bien (jamais au détriment
 * d'un équipement similaire) ; les documents où cet équipement reste en
 * concurrence vont, en un appel, à T3 (contexte enrichi, équipements à ne pas
 * confondre) si `allowAi`.
 */
export async function syncEquipmentDocumentLinks(o: {
  accountId: number; equipmentId: number; allowAi?: boolean; guard?: { assertActive(what: string): Promise<void> };
  arbitrate?: EquipmentArbitrate; sql?: Sql;
}): Promise<EquipmentDocumentResult> {
  const sql = o.sql ?? pgClient;
  const out: EquipmentDocumentResult = { equipmentId: o.equipmentId, examined: 0, linkedDocuments: [], created: 0, ambiguousDocuments: [], aiCalls: 0, found: false };
  const [cible] = await loadEquipmentProfiles(o.accountId, { equipmentIds: [o.equipmentId] }, sql);
  if (!cible) return out;
  out.found = true;
  const equipements = await loadEquipmentProfiles(o.accountId, { assetIds: [cible.assetId] }, sql);
  const docs = await documentsOfAsset(o.accountId, cible.assetId, sql);
  const profils = new Map<number, DocumentProfile>();
  for (const fileId of docs) {
    await o.guard?.assertActive('rattachement équipement → documents');
    const r = await syncDocumentEquipmentLinks({ accountId: o.accountId, fileId, equipments: equipements, allowAi: false, proposeCard: false, sql });
    out.examined++;
    out.created += r.created;
    if (r.linked.includes(o.equipmentId)) out.linkedDocuments.push(fileId);
    if (r.status === 'AMBIGUOUS' && r.ambiguous.includes(o.equipmentId)) {
      out.ambiguousDocuments.push(fileId);
      const p = await loadDocumentProfile(o.accountId, fileId, sql);
      if (p) profils.set(fileId, p.profile);
    }
  }
  if (o.allowAi && profils.size > 0) {
    const autres = equipements.filter((e) => e.id !== cible.id);
    out.aiCalls = 1;
    try {
      const retenus = await (o.arbitrate ?? defaultEquipmentArbitrate)({
        accountId: o.accountId, equipmentId: cible.id,
        subjectContext: formatEquipmentSubject(cible, autres),
        documentsList: [...profils.values()].map(formatDocumentCandidate).join('\n'),
        candidateIds: [...profils.keys()],
      });
      for (const r of retenus) {
        if (!profils.has(r.fileId)) continue;
        const doc = await loadDocumentProfile(o.accountId, r.fileId, sql);
        if (!doc || doc.userChoseEquipment) continue;
        const w = await writeLinks(o.accountId, doc, [{ equipmentId: cible.id, method: 'DESIGNATION', score: r.score, reason: `Arbitrage T3 — ${r.reason}` }], sql);
        out.created += w.created;
        if (w.linked.includes(cible.id)) out.linkedDocuments.push(r.fileId);
      }
    } catch (e) {
      if (isExecutionCancelled(e)) throw e;
      console.warn(`[document-equipment] arbitrage T3 de l'équipement ${o.equipmentId} indisponible :`, (e as Error).message);
    }
  }
  out.linkedDocuments = [...new Set(out.linkedDocuments)].sort((a, b) => a - b);
  return out;
}
