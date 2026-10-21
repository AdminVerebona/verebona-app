/**
 * Rattachement document ↔ équipement — service COMMUN (lot 71A, BUG P1
 * point B ; ticket P1 « contexte T3 équipements » ; lot 75G : écarts
 * résiduels).
 *
 * Trois parcours, mêmes profils, mêmes règles (`document-equipment-matching`),
 * mêmes écritures :
 *   · DOCUMENT_EQUIPMENT — `syncDocumentEquipmentLinks` : après T1, après un
 *     rattachement tardif à un bien (T3), à la validation, au rattrapage ;
 *   · EQUIPMENT_DOCUMENT — `syncEquipmentDocumentLinks` : équipement créé,
 *     renommé, déplacé ou dont un identifiant (marque, modèle, n° de série)
 *     change — exécuté par la file durable (`equipment-document-queue`) ;
 *   · réexamen LINK-ELT — `continuous/document-element-link` délègue ici
 *     (lot 75G, écart C : plus de moteur ni d'écriture parallèles).
 *
 * Réutilise les relations EXISTANTES, sans nouvelle colonne :
 *   · lien N-N `document_asset_links` (cible équipement, rôle SECONDARY,
 *     origine AI) — un par équipement désigné (associations multiples) ; le
 *     bien porteur est déduit par `linkDocumentToAsset` : le document reste
 *     dans la liste du bien, sans duplication physique ;
 *   · colonne historique `asset_files.equipment_id` posée seulement si elle
 *     est vide, qu'UN seul équipement est désigné et que l'utilisateur n'a
 *     pas choisi lui-même (`user_edited_fields.equipmentId`) ;
 *   · ambiguïtés RÉSIDUELLES (lot 75G, écart A) : même quand d'autres
 *     équipements sont rattachés avec certitude, chaque groupe d'équipements
 *     en concurrence va à T3 (`reconcileLinks`, opération et prompt
 *     existants, contrat de sortie inchangé) si `allowAi`, sinon / en cas
 *     d'abstention à une carte « À traiter » LINK-ELT — sans jamais annuler
 *     les liens certains ni choisir arbitrairement.
 *
 * Sources documentaires (lot 75G, écart B) : faits actifs (`document_facts`,
 * prioritaires), puis — sans nouvel appel T1 — faits non résolus
 * (`document_unresolved_facts` UNRESOLVED / RETAINED) et unités source
 * (`document_source_units` COVERED / UNRESOLVED ; UNCERTAIN et FAILED
 * écartés) : dédoublonnés, provenance conservée, identifiants seulement.
 *
 * Protections : document, biens et équipements lus DANS LE COMPTE ; un choix
 * de l'utilisateur (équipement posé ou retiré dans le tiroir, lien USER
 * retiré / rejeté, carte LINK-ELT déclarée « Non applicable » ou tranchée)
 * n'est jamais contredit ; les liens USER / LEGACY_COLUMN ne sont jamais
 * modifiés (`canRefresh`) ; chaque équipement est REVÉRIFIÉ (compte, bien du
 * document, non archivé) au moment d'écrire. Idempotent : rejoué, rien de plus.
 */
import { pgClient } from '@/db';
import { isExecutionCancelled } from '@/services/ai/queue/execution-control';
import {
  compactCode, formatDocumentSubject, formatEquipmentCandidate, formatEquipmentSubject, formatDocumentCandidate,
  matchDocumentToEquipments, unresolvedGroups,
  type DocumentFactProfile, type DocumentProfile, type EquipmentMatch, type EquipmentProfile, type MatchResult,
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

/** Taille d'une page de lecture (équipements, documents, faits) — lot 75G, écart E : jamais une limite. */
export const LINK_PAGE_SIZE = 500;
/** Documents soumis à T3 par appel (sens EQUIPMENT_DOCUMENT) : tous le sont, par lots. */
export const EQUIPMENT_DOCUMENT_AI_BATCH = 20;
/**
 * Marge supplémentaire exigée par le réexamen LINK-ELT entre les deux
 * meilleurs candidats T3 (règle 54A conservée à l'identique, en plus de la
 * marge du master `LINK_MIN_MARGIN` 0,15 appliquée à tous les parcours).
 */
export const ELEMENT_REQUIRED_MARGIN = 0.2;

// ── Profils (sources canoniques, bornées au compte) ─────────────────────────

const ENERGY_USAGE_LABELS: Record<string, string> = {
  chauffage: 'chauffage', refroidissement: 'refroidissement', ecs: 'eau chaude sanitaire', ventilation: 'ventilation', enr: 'énergie renouvelable', aucun: 'aucun',
};

/**
 * Profils des équipements ACTUELS (non archivés) des biens donnés, ou des
 * équipements donnés, du compte — TOUS, par pages (lot 75G, écart E).
 * Marque, modèle, n° de série et caractéristiques : vue CANONIQUE de la
 * fiche de l'équipement (fiche 0227 prioritaire, colonnes miroirs en
 * repli). Aucune donnée d'achat.
 */
export async function loadEquipmentProfiles(
  accountId: number,
  sel: { assetIds?: readonly number[]; equipmentIds?: readonly number[] },
  sql: Sql = pgClient,
  pageSize = LINK_PAGE_SIZE,
): Promise<EquipmentProfile[]> {
  const assetIds = [...new Set(sel.assetIds ?? [])].filter((x) => Number.isSafeInteger(x) && x > 0);
  const equipmentIds = [...new Set(sel.equipmentIds ?? [])].filter((x) => Number.isSafeInteger(x) && x > 0);
  if (!assetIds.length && !equipmentIds.length) return [];
  const { buildCanonicalEntityState } = await import('@/services/canonical/entity-state/entity-view');
  const out: EquipmentProfile[] = [];
  let apres = 0;
  for (;;) {
    const rows = (await sql.unsafe(
      `SELECT e.id, e.asset_id, a.name AS asset_name, e.name, e.type, e.category, e.energy_usage,
              to_jsonb(e)->'key_characteristics' AS kc, e.purchase_price_cents AS ppc, e.estimated_value_cents AS evc,
              sp.id AS spec_id, sp.brand, sp.model, sp.serial_number AS sn, sp.power_kw AS pkw, sp.energy_label,
              sub.name AS room
         FROM equipments e
         JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
         LEFT JOIN equipment_cil_specs sp ON sp.equipment_id = e.id
         LEFT JOIN substructures sub ON sub.id = e.substructure_id
        WHERE e.archived_at IS NULL AND (e.asset_id = ANY($2::int[]) OR e.id = ANY($3::int[])) AND e.id > $4
        ORDER BY e.id LIMIT ${Math.max(1, pageSize)}`,
      [accountId, assetIds, equipmentIds, apres] as never[],
    )) as unknown as Row[];
    for (const r of rows) {
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
      out.push({
        id: Number(r.id), assetId: Number(r.asset_id), assetName: s(r.asset_name), name: String(r.name ?? ''),
        type: s(r.type), category: s(r.category), brand: v('brand'), model: v('modelName'), serialNumber: v('serialNumber'),
        room: s(r.room), features,
      });
    }
    if (rows.length < pageSize) break;
    apres = Number(rows[rows.length - 1].id);
  }
  return out;
}

export interface DocumentRow {
  profile: DocumentProfile;
  equipmentId: number | null;
  /** Bien principal (carte LINK-ELT) : `asset_id`, sinon `linked_asset_id`. */
  mainAssetId: number | null;
  userChoseEquipment: boolean;
  /** Équipements déjà rattachés (liens N-N ACTIFS toutes origines, colonne historique). */
  linkedEquipmentIds: Set<number>;
}

// Rattrapage des données persistées secondaires (lot 75G, écart B).
const CLE_IDENTIFIANT = /(s[ée]rie|serial|\bs\/?n\b|num[ée]ro de s|mod[eè]le|model|r[ée]f[ée]rence|\bref\b|marque|brand|fabricant|manufacturer|constructeur|d[ée]signation|article|libell[ée]|produit|appareil|[ée]quipement|vin\b|make\b)/i;
/** Bornes de lecture (mêmes ordres de grandeur que les fournisseurs T3 du lot 49B) ; dépassement journalisé. */
const SOURCE_UNITS_READ_MAX = 2000;
const UNRESOLVED_READ_MAX = 500;

async function lireFaits(sql: Sql, accountId: number, fileId: number): Promise<DocumentFactProfile[]> {
  const out: DocumentFactProfile[] = [];
  let apres = 0;
  for (;;) {
    const rows = (await sql.unsafe(
      `SELECT id, COALESCE(canonical_key, raw_key, fact_key) AS key, COALESCE(normalized_value, value_text, value_number::text) AS value,
              label, target_type, target_entity_id, target_entity_label, excerpt
         FROM document_facts WHERE file_id = $1 AND account_id = $2 AND status = 'active' AND id > $3
        ORDER BY id LIMIT ${LINK_PAGE_SIZE}`,
      [fileId, accountId, apres] as never[],
    )) as unknown as Row[];
    for (const x of rows) {
      if (!s(x.value)) continue;
      out.push({
        key: String(x.key ?? ''), value: String(x.value), label: s(x.label), targetType: s(x.target_type),
        targetId: n(x.target_entity_id), targetLabel: s(x.target_entity_label), excerpt: s(x.excerpt), provenance: 'FACT',
      });
    }
    if (rows.length < LINK_PAGE_SIZE) break;
    apres = Number(rows[rows.length - 1].id);
  }
  return out;
}

/**
 * Faits non résolus et unités source du document (lecture seule, aucun T1) :
 * les paires clé / valeur qui portent un IDENTIFIANT (n° de série, modèle,
 * marque, désignation) deviennent des faits de provenance secondaire ; tout
 * autre texte ne sert qu'à la recherche de codes exacts. Unités incertaines
 * ou en échec : jamais utilisées (une mention incertaine ne devient jamais
 * une correspondance).
 */
async function lireSourcesSecondaires(sql: Sql, accountId: number, fileId: number): Promise<{ facts: DocumentFactProfile[]; texts: string[] }> {
  const facts: DocumentFactProfile[] = [];
  const texts: string[] = [];
  const paire = (key: string | null, value: string | null, provenance: 'UNRESOLVED' | 'SOURCE_UNIT', excerpt: string | null) => {
    if (!value) return;
    if (key && CLE_IDENTIFIANT.test(key)) {
      facts.push({ key, value, label: key, targetType: null, targetId: null, targetLabel: null, excerpt, provenance });
    } else {
      texts.push(value);
    }
  };
  try {
    const nr = (await sql.unsafe(
      `SELECT COALESCE(canonical_key, raw_key) AS key, raw_key, raw_value FROM document_unresolved_facts
        WHERE file_id = $1 AND account_id = $2 AND status IN ('UNRESOLVED', 'RETAINED') AND raw_value IS NOT NULL
        ORDER BY id LIMIT ${UNRESOLVED_READ_MAX + 1}`,
      [fileId, accountId] as never[],
    )) as unknown as Row[];
    if (nr.length > UNRESOLVED_READ_MAX) console.warn(`[document-equipment] document ${fileId} : plus de ${UNRESOLVED_READ_MAX} faits non résolus, les suivants ne sont pas lus.`);
    for (const x of nr.slice(0, UNRESOLVED_READ_MAX)) paire(s(x.raw_key) ?? s(x.key), s(x.raw_value), 'UNRESOLVED', null);
    const us = (await sql.unsafe(
      `SELECT kind, label, value_text, content_text FROM document_source_units
        WHERE file_id = $1 AND account_id = $2 AND coverage_status IN ('COVERED', 'UNRESOLVED')
          AND kind NOT IN ('PAGE_GAP', 'DOCUMENT_METADATA')
        ORDER BY ordinal, id LIMIT ${SOURCE_UNITS_READ_MAX + 1}`,
      [fileId, accountId] as never[],
    )) as unknown as Row[];
    if (us.length > SOURCE_UNITS_READ_MAX) console.warn(`[document-equipment] document ${fileId} : plus de ${SOURCE_UNITS_READ_MAX} unités source, les suivantes ne sont pas lues.`);
    for (const u of us.slice(0, SOURCE_UNITS_READ_MAX)) {
      const label = s(u.label);
      const valeur = s(u.value_text);
      if (label && valeur) paire(label, valeur, 'SOURCE_UNIT', s(u.content_text));
      else if (valeur) texts.push(valeur);
      if (s(u.content_text)) texts.push(String(u.content_text));
    }
  } catch (e) {
    // Couche exhaustive absente (déploiement partiel) : faits structurés seuls.
    console.warn(`[document-equipment] sources secondaires du document ${fileId} illisibles :`, (e as Error).message);
  }
  return { facts, texts };
}

/** Faits secondaires dont la valeur est déjà portée par un fait structuré : écartés (priorité au canonique). */
function dedoublonner(primaires: DocumentFactProfile[], secondaires: DocumentFactProfile[]): DocumentFactProfile[] {
  const connus = new Set(primaires.map((f) => compactCode(f.value)).filter(Boolean));
  const vus = new Set<string>();
  return secondaires.filter((f) => {
    const k = compactCode(f.value);
    if (!k || connus.has(k) || vus.has(k)) return false;
    vus.add(k);
    return true;
  });
}

/** Profil d'un document du compte : métadonnées, biens rattachés, faits (structurés puis secondaires), liens existants. */
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
  let faits: DocumentFactProfile[] = [];
  try {
    faits = await lireFaits(sql, accountId, fileId);
  } catch (e) {
    console.warn(`[document-equipment] faits du document ${fileId} illisibles :`, (e as Error).message);
  }
  const sec = await lireSourcesSecondaires(sql, accountId, fileId);
  const liens = (await sql.unsafe(
    `SELECT DISTINCT equipment_id FROM document_asset_links
      WHERE account_id = $1 AND file_id = $2 AND status = 'ACTIVE' AND equipment_id IS NOT NULL`,
    [accountId, fileId] as never[],
  )) as unknown as Row[];
  const lies = new Set(liens.map((r) => Number(r.equipment_id)));
  if (n(f.equipment_id) !== null) lies.add(Number(f.equipment_id));
  return {
    profile: {
      fileId, title: s(f.retained_title) ?? s(f.original_filename), typeCode: s(f.type_code), description: s(f.description),
      supplier: s(f.supplier), documentDate: s(f.document_date), amountCents: n(f.amount_cents),
      assetIds: biens.map((b) => Number(b.id)), assetNames: biens.map((b) => String(b.name ?? '')),
      facts: [...faits, ...dedoublonner(faits, sec.facts)],
      sourceTexts: sec.texts,
    },
    equipmentId: n(f.equipment_id),
    mainAssetId: n(f.asset_id) ?? n(f.linked_asset_id),
    userChoseEquipment: f.user_equipment === true,
    linkedEquipmentIds: lies,
  };
}

// ── Décisions utilisateur ───────────────────────────────────────────────────

/** Règle et relation de la carte « À traiter » document → équipement. */
const LINK_ELT = { rule: 'LINK-ELT', relation: 'elementId' } as const;

const candidatsCarte = (ctx: unknown): number[] => {
  const c = (kcOf(ctx) as { candidates?: unknown }).candidates;
  return Array.isArray(c) ? c.map(Number).filter((x) => Number.isSafeInteger(x) && x > 0) : [];
};

/**
 * Équipements que l'utilisateur a écartés pour ce document — jamais
 * rattachés automatiquement (ni par règle, ni par T3) :
 *   · lien USER retiré ou rejeté ;
 *   · carte LINK-ELT déclarée « Non applicable » : tous ses candidats ;
 *   · carte LINK-ELT tranchée : ses autres candidats.
 */
export async function userRefusedEquipments(accountId: number, fileId: number, sql: Sql = pgClient): Promise<Set<number>> {
  const out = new Set<number>();
  const rows = (await sql.unsafe(
    `SELECT DISTINCT equipment_id FROM document_asset_links
      WHERE account_id = $1 AND file_id = $2 AND equipment_id IS NOT NULL AND origin = 'USER' AND status IN ('REMOVED', 'REJECTED')`,
    [accountId, fileId] as never[],
  )) as unknown as Row[];
  for (const r of rows) out.add(Number(r.equipment_id));
  const cartes = (await sql.unsafe(
    `SELECT a.resolution_reason, a.trigger_context,
            (SELECT array_agg(l.equipment_id) FROM document_asset_links l
              WHERE l.account_id = a.account_id AND l.file_id = a.target_id AND l.status = 'ACTIVE'
                AND l.origin IN ('USER', 'LEGACY_COLUMN') AND l.equipment_id IS NOT NULL) AS choisis
       FROM to_process_actions a
      WHERE a.account_id = $1 AND a.target_type = 'DOCUMENT' AND a.target_id = $2 AND a.rule_code = $3
        AND a.resolved_at IS NOT NULL AND a.resolution_reason IN ('NOT_APPLICABLE', 'USER_ARBITRATED')`,
    [accountId, fileId, LINK_ELT.rule] as never[],
  )) as unknown as Row[];
  for (const c of cartes) {
    const choisis = new Set(((c.choisis as unknown[] | null) ?? []).map(Number));
    for (const id of candidatsCarte(c.trigger_context)) {
      if (c.resolution_reason === 'NOT_APPLICABLE' || !choisis.has(id)) out.add(id);
    }
  }
  return out;
}

// ── Écritures ───────────────────────────────────────────────────────────────

/** Équipements encore valides pour le document AU MOMENT D'ÉCRIRE : compte, bien du document, non archivés. */
async function equipementsValides(accountId: number, assetIds: number[], ids: number[], sql: Sql): Promise<Set<number>> {
  if (!ids.length || !assetIds.length) return new Set();
  const rows = (await sql.unsafe(
    `SELECT e.id FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
      WHERE e.id = ANY($2::int[]) AND e.asset_id = ANY($3::int[]) AND e.archived_at IS NULL`,
    [accountId, ids, assetIds] as never[],
  )) as unknown as Row[];
  return new Set(rows.map((r) => Number(r.id)));
}

async function writeLinks(
  accountId: number, doc: DocumentRow, links: EquipmentMatch[], sql: Sql,
): Promise<{ created: number; linked: number[]; columnSet: boolean; refused: number[] }> {
  const refusees = await userRefusedEquipments(accountId, doc.profile.fileId, sql);
  const valides = await equipementsValides(accountId, doc.profile.assetIds, links.map((l) => l.equipmentId), sql);
  const retenus = links.filter((l) => !refusees.has(l.equipmentId) && valides.has(l.equipmentId));
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

/**
 * Cartes LINK-ELT ouvertes du document dont la question est RÉGLÉE, vérifié
 * en base (lot 75G, écart C) : un de leurs candidats est effectivement
 * rattaché (lien ACTIF ou colonne), ou le document porte un rattachement et
 * aucun de leurs candidats ne reste en concurrence dans l'état courant.
 * Fermées OBSOLETE. Rend les identifiants fermés.
 */
async function settleElementCards(accountId: number, fileId: number, residuels: ReadonlySet<number>, sql: Sql): Promise<number[]> {
  const cartes = (await sql.unsafe(
    `SELECT id, trigger_context FROM to_process_actions
      WHERE account_id = $1 AND target_type = 'DOCUMENT' AND target_id = $2 AND rule_code = $3 AND resolved_at IS NULL`,
    [accountId, fileId, LINK_ELT.rule] as never[],
  )) as unknown as Row[];
  if (cartes.length === 0) return [];
  const relu = await loadDocumentProfile(accountId, fileId, sql);
  if (!relu) return [];
  const fermees: number[] = [];
  const { resolveAction } = await import('@/services/to-process/to-process-action.service');
  for (const c of cartes) {
    const cands = candidatsCarte(c.trigger_context);
    const rattache = cands.some((id) => relu.linkedEquipmentIds.has(id));
    const sansObjet = relu.linkedEquipmentIds.size > 0 && !cands.some((id) => residuels.has(id));
    if ((rattache || sansObjet) && await resolveAction(Number(c.id), 'OBSOLETE')) fermees.push(Number(c.id));
  }
  return fermees;
}

// ── DOCUMENT_EQUIPMENT ──────────────────────────────────────────────────────

/** Arbitrage T3 d'une ambiguïté document → équipement (injectable en test). */
export type DocumentArbitrate = (p: {
  accountId: number; fileId: number; subjectContext: string; equipmentsList: string; candidateIds: number[];
  /** Marge supplémentaire exigée entre les deux meilleurs (réexamen LINK-ELT). */
  requiredMargin?: number;
}) => Promise<{ equipmentId: number | null; score?: number; reason?: string; abstained?: boolean }>;

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
  // Relation DOCUMENT_EQUIPMENT (exclusive) : seuil `documentToEquipment` 0,5.
  const retenus = retainAbove(r.matches, LINK_SCORE_THRESHOLDS.documentToEquipment).filter((m) => p.candidateIds.includes(m.id));
  if (retenus.length > 1 && p.requiredMargin !== undefined && retenus[0].score - retenus[1].score + 1e-9 < p.requiredMargin) {
    return { equipmentId: null, score: 0, reason: 'marge insuffisante (réexamen LINK-ELT)', abstained: true };
  }
  const best = retenus[0];
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
  /** Équipements encore en concurrence (groupes résiduels non arbitrés). */
  ambiguous: number[];
  /** Groupes résiduels (lot 75G). */
  groups: number[][];
  aiCalled: boolean;
  cardProposed: boolean;
  /** Cartes LINK-ELT fermées parce que leur question est réglée (vérifié en base). */
  cardsClosed: number[];
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
  /** Marge supplémentaire exigée de T3 (réexamen LINK-ELT : `ELEMENT_REQUIRED_MARGIN`). */
  requiredMargin?: number;
  /** Équipements déjà chargés (parcours EQUIPMENT_DOCUMENT). */
  equipments?: EquipmentProfile[];
  sql?: Sql;
}

/**
 * Rattache un document aux équipements qu'il désigne parmi ceux de SES
 * biens. Ne lève pas pour une indisponibilité T3 ou un lien refusé (le
 * document reste rattaché au bien) ; une erreur de base se propage
 * (reprise par la file appelante).
 */
export async function syncDocumentEquipmentLinks(o: SyncDocumentOptions): Promise<DocumentEquipmentResult> {
  const sql = o.sql ?? pgClient;
  const out: DocumentEquipmentResult = {
    fileId: o.fileId, status: 'NOT_FOUND', linked: [], created: 0, columnSet: false, ambiguous: [], groups: [],
    aiCalled: false, cardProposed: false, cardsClosed: [], methods: [],
  };
  const doc = await loadDocumentProfile(o.accountId, o.fileId, sql);
  if (!doc) return out;
  if (doc.userChoseEquipment) return { ...out, status: 'USER_PROTECTED' };
  if (doc.profile.assetIds.length === 0) return { ...out, status: 'NO_ASSET' };
  const equipements = (o.equipments ?? await loadEquipmentProfiles(o.accountId, { assetIds: doc.profile.assetIds }, sql))
    .filter((e) => doc.profile.assetIds.includes(e.assetId));
  if (equipements.length === 0) return { ...out, status: 'NO_EQUIPMENT' };

  const m = matchDocumentToEquipments(doc.profile, equipements);
  const refus = await userRefusedEquipments(o.accountId, o.fileId, sql);
  const links = m.links.filter((l) => !refus.has(l.equipmentId));
  const parId = new Map([...m.links, ...m.ambiguous].map((x) => [x.equipmentId, x]));
  // Groupes encore à arbitrer : ni expliqués par un lien (existant ou certain), ni refusés par l'utilisateur.
  let groupes = unresolvedGroups(m.groups, new Set([...doc.linkedEquipmentIds, ...links.map((l) => l.equipmentId)]))
    .map((g) => g.filter((id) => !refus.has(id)))
    .filter((g) => g.length >= 2);

  if (groupes.length > 0 && o.allowAi) {
    const restants: number[][] = [];
    for (const g of groupes) {
      await o.guard?.assertActive('rattachement document → équipement — arbitrage T3');
      const candidats = equipements.filter((e) => g.includes(e.id));
      out.aiCalled = true;
      try {
        const r = await (o.arbitrate ?? defaultDocumentArbitrate)({
          accountId: o.accountId, fileId: o.fileId,
          subjectContext: formatDocumentSubject(doc.profile),
          equipmentsList: candidats.map(formatEquipmentCandidate).join('\n'),
          candidateIds: candidats.map((e) => e.id),
          ...(o.requiredMargin !== undefined ? { requiredMargin: o.requiredMargin } : {}),
        });
        if (r.equipmentId !== null && g.includes(r.equipmentId)) {
          links.push({
            equipmentId: r.equipmentId, method: parId.get(r.equipmentId)?.method ?? 'DESIGNATION',
            score: Math.min(1, Math.max(0, r.score ?? 0.5)), reason: `Arbitrage T3 — ${r.reason ?? ''}`.slice(0, 200),
          });
          out.methods.push('T3');
          continue;
        }
      } catch (e) {
        if (isExecutionCancelled(e)) throw e;
        console.warn(`[document-equipment] arbitrage T3 du document ${o.fileId} indisponible :`, (e as Error).message);
      }
      restants.push(g);
    }
    groupes = restants;
  }
  out.groups = groupes;
  out.ambiguous = [...new Set(groupes.flat())].sort((a, b) => a - b);
  out.status = links.length > 0 ? 'LINKED' : groupes.length > 0 ? 'AMBIGUOUS' : m.status === 'LINKED' ? 'NONE' : m.status;
  out.methods.push(...links.map((l) => l.method));

  if (o.dryRun) {
    // Simulation : liens qui SERAIENT créés (un lien actif existant ou refusé n'est pas compté).
    const ids = links.map((l) => l.equipmentId);
    return { ...out, linked: ids, created: ids.filter((id) => !doc.linkedEquipmentIds.has(id)).length };
  }

  if (links.length > 0) {
    await o.guard?.assertActive('rattachement document → équipement — écriture');
    const w = await writeLinks(o.accountId, doc, links, sql);
    Object.assign(out, { linked: w.linked, created: w.created, columnSet: w.columnSet });
  }
  // Cartes LINK-ELT dont la question est réglée (rattachement vérifié en base).
  out.cardsClosed = await settleElementCards(o.accountId, o.fileId, new Set(out.ambiguous), sql);
  // Ambiguïté restante : l'utilisateur tranche (carte LINK-ELT, idempotente), liens certains conservés.
  if (out.ambiguous.length >= 2 && o.proposeCard !== false && doc.mainAssetId !== null) {
    const duBien = out.ambiguous.filter((id) => equipements.find((e) => e.id === id)?.assetId === doc.mainAssetId);
    if (duBien.length >= 2) {
      try {
        const { proposeDocumentEquipmentLink } = await import('@/services/to-process/document-equipment-link');
        const r = await proposeDocumentEquipmentLink({
          accountId: o.accountId, fileId: o.fileId, assetId: doc.mainAssetId,
          candidates: duBien.map((id) => ({ equipmentId: id, score: parId.get(id)?.score ?? 0.5, reason: parId.get(id)?.reason ?? 'Équipements en concurrence' })),
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
  // Relation EQUIPMENT_DOCUMENT : la section `documents` du master est non
  // exclusive au seuil `equipmentToObjects` 0,4 ; ici chaque document est en
  // concurrence entre équipements semblables — on applique le seuil du
  // rattachement d'un document à UN équipement, `documentToEquipment` 0,5
  // (règle 71A conservée, jamais abaissée).
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
  /** Cartes LINK-ELT proposées (ambiguïtés non tranchées) — `proposeCards`. */
  cardsProposed: number;
  found: boolean;
}

/** Une page de documents (ids) rattachés à un bien du compte : colonnes historiques ou liens PRIMARY / SECONDARY actifs. */
export async function documentsOfAsset(
  accountId: number, assetId: number, sql: Sql = pgClient, limit = LINK_PAGE_SIZE, afterId = 0,
): Promise<number[]> {
  const rows = (await sql.unsafe(
    `SELECT f.id FROM asset_files f
      WHERE f.account_id = $1 AND f.deleted_at IS NULL AND f.id > $3
        AND (f.asset_id = $2 OR f.linked_asset_id = $2
             OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = f.id AND l.account_id = f.account_id
                         AND l.status = 'ACTIVE' AND l.link_role IN ('PRIMARY', 'SECONDARY') AND l.asset_id = $2))
      ORDER BY f.id LIMIT ${Math.max(1, Math.min(5000, limit))}`,
    [accountId, assetId, afterId] as never[],
  )) as unknown as Row[];
  return rows.map((r) => Number(r.id));
}

/** TOUS les documents d'un bien, par pages (lot 75G, écart E : aucun document exclu par une limite). */
export async function* iterateDocumentsOfAsset(accountId: number, assetId: number, sql: Sql = pgClient, pageSize = LINK_PAGE_SIZE): AsyncGenerator<number> {
  let apres = 0;
  for (;;) {
    const page = await documentsOfAsset(accountId, assetId, sql, pageSize, apres);
    for (const id of page) yield id;
    if (page.length < pageSize) return;
    apres = page[page.length - 1];
  }
}

/**
 * Équipement créé (ou modifié) APRÈS ses documents : chaque document de son
 * bien — tous, par pages — est rapproché parmi TOUS les équipements du bien
 * (jamais au détriment d'un équipement similaire) ; les documents où cet
 * équipement reste en concurrence vont à T3 par lots (contexte enrichi,
 * équipements à ne pas confondre) si `allowAi` ; `proposeCards` : ceux qui
 * restent ambigus reçoivent une carte LINK-ELT.
 */
export async function syncEquipmentDocumentLinks(o: {
  accountId: number; equipmentId: number; allowAi?: boolean; proposeCards?: boolean;
  guard?: { assertActive(what: string): Promise<void> };
  arbitrate?: EquipmentArbitrate; sql?: Sql; pageSize?: number;
}): Promise<EquipmentDocumentResult> {
  const sql = o.sql ?? pgClient;
  const out: EquipmentDocumentResult = { equipmentId: o.equipmentId, examined: 0, linkedDocuments: [], created: 0, ambiguousDocuments: [], aiCalls: 0, cardsProposed: 0, found: false };
  const [cible] = await loadEquipmentProfiles(o.accountId, { equipmentIds: [o.equipmentId] }, sql);
  if (!cible) return out;
  out.found = true;
  const equipements = await loadEquipmentProfiles(o.accountId, { assetIds: [cible.assetId] }, sql, o.pageSize);
  const ambigus: number[] = [];
  for await (const fileId of iterateDocumentsOfAsset(o.accountId, cible.assetId, sql, o.pageSize)) {
    await o.guard?.assertActive('rattachement équipement → documents');
    const r = await syncDocumentEquipmentLinks({ accountId: o.accountId, fileId, equipments: equipements, allowAi: false, proposeCard: false, sql });
    out.examined++;
    out.created += r.created;
    if (r.linked.includes(o.equipmentId)) out.linkedDocuments.push(fileId);
    if (r.ambiguous.includes(o.equipmentId)) ambigus.push(fileId);
  }
  const tranches = new Set<number>();
  if (o.allowAi && ambigus.length > 0) {
    const autres = equipements.filter((e) => e.id !== cible.id);
    const sujet = formatEquipmentSubject(cible, autres);
    for (let i = 0; i < ambigus.length; i += EQUIPMENT_DOCUMENT_AI_BATCH) {
      const lot = new Map<number, DocumentRow>();
      for (const fileId of ambigus.slice(i, i + EQUIPMENT_DOCUMENT_AI_BATCH)) {
        const p = await loadDocumentProfile(o.accountId, fileId, sql);
        if (p && !p.userChoseEquipment) lot.set(fileId, p);
      }
      if (lot.size === 0) continue;
      await o.guard?.assertActive('rattachement équipement → documents — arbitrage T3');
      out.aiCalls++;
      try {
        const retenus = await (o.arbitrate ?? defaultEquipmentArbitrate)({
          accountId: o.accountId, equipmentId: cible.id, subjectContext: sujet,
          documentsList: [...lot.values()].map((d) => formatDocumentCandidate(d.profile)).join('\n'),
          candidateIds: [...lot.keys()],
        });
        for (const r of retenus) {
          const doc = lot.get(r.fileId);
          if (!doc) continue;
          await o.guard?.assertActive('rattachement équipement → documents — écriture');
          const w = await writeLinks(o.accountId, doc, [{ equipmentId: cible.id, method: 'DESIGNATION', score: r.score, reason: `Arbitrage T3 — ${r.reason}` }], sql);
          out.created += w.created;
          if (w.linked.includes(cible.id)) {
            out.linkedDocuments.push(r.fileId);
            tranches.add(r.fileId);
            await settleElementCards(o.accountId, r.fileId, new Set(), sql);
          }
        }
      } catch (e) {
        if (isExecutionCancelled(e)) throw e;
        console.warn(`[document-equipment] arbitrage T3 de l'équipement ${o.equipmentId} indisponible :`, (e as Error).message);
      }
    }
  }
  out.ambiguousDocuments = ambigus.filter((id) => !tranches.has(id));
  if (o.proposeCards) {
    // Reste ambigu (abstention, IA non autorisée ou indisponible) : carte LINK-ELT, mêmes règles.
    for (const fileId of out.ambiguousDocuments) {
      await o.guard?.assertActive('rattachement équipement → documents — cartes');
      const r = await syncDocumentEquipmentLinks({ accountId: o.accountId, fileId, equipments: equipements, allowAi: false, proposeCard: true, sql });
      if (r.cardProposed) out.cardsProposed++;
    }
  }
  out.linkedDocuments = [...new Set(out.linkedDocuments)].sort((a, b) => a - b);
  return out;
}
