/**
 * Rattrapage « Séparation bien / équipement » (lot 71A — BUG P1, §4) — BO ›
 * Exploitation › Rattrapages (« Simuler » puis « Appliquer », motif
 * obligatoire). Jamais lancé automatiquement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PROVENANCE VÉRIFIÉE AVANT TOUTE CORRECTION — une date identique ne prouve rien
 *
 * Une valeur n'est corrigée que si sa PROVENANCE démontre l'erreur :
 *
 *   A. Preuve du BIEN déduite par règle (« justificatif d'achat du bien » :
 *      date / montant du document) d'un document qui établit l'achat d'un
 *      ÉQUIPEMENT (preuve d'acquisition ACTIVE ciblant un équipement, même
 *      document) → la preuve du bien est retirée (WITHDRAWN). Cause racine :
 *      `applyPurposeRules`, corrigée au lot 71A.
 *   B. Même preuve (même document, même clé, même valeur ET même extrait)
 *      pour le bien et un équipement :
 *        · acte authentique → la preuve de l'ÉQUIPEMENT est retirée ;
 *        · autre justificatif → la preuve du BIEN est retirée.
 *   C. Date d'achat du bien recopiée par la règle agenda D-13 depuis un
 *      événement « achat » lié à un ÉQUIPEMENT de ce bien (journal 0216 :
 *      dernière écriture du champ = cette recopie, valeur inchangée depuis)
 *      → la date passe sur l'équipement (si sa date est vide) et le champ du
 *      bien est vidé (valeur attendue = la recopie, origine ADMIN).
 *   D. Documents : rapprochement rétroactif document → équipements
 *      (`syncDocumentEquipmentLinks`, déterministe seul ; ambiguïté → carte
 *      LINK-ELT à l'application, rien en simulation).
 *
 * Après un retrait de preuve, la réconciliation T3 du bien / de l'équipement
 * est rejouée (moteur existant) : la valeur AUTOMATIQUE qui n'a plus de
 * preuve est retirée, ou remplacée par la meilleure preuve restante
 * (« restaurée » quand la bonne valeur est connue) ; une valeur saisie ou
 * validée par l'utilisateur (USER / ADMIN) n'est JAMAIS modifiée
 * (préséance de la primitive) — elle est comptée « préservée ».
 *
 * LOT 75G (ticket « écarts résiduels 71A », E) — un document peut couvrir
 * PLUSIEURS acquisitions légitimes : A et B ne sont plus corrigés que si la
 * provenance est DÉMONTRÉE (équipement du MÊME bien, même valeur, aucune
 * acquisition du bien lue dans le document ; pour un justificatif, seule une
 * même ligne de PRIX d'un document rattaché à l'équipement) ; le reste est
 * SUSPECT (rapporté, jamais modifié). Diagnostic étendu aux autres attributs
 * propres (marque, modèle, n° de série, garanties, valeur estimée) : suspects
 * seulement. Documents : TOUS, par pages. Chaque retrait de preuve et sa
 * ligne de journal sont écrits dans UNE transaction ; une exécution
 * interrompue avant la réconciliation des fiches est REPRISE au passage
 * suivant (retraits journalisés sans `reconciledAt`).
 *
 * Traçable : chaque correction appliquée → `data_separation_corrections`
 * (0489 : exécution, motif, avant / après), plus le journal 0216 et le cycle
 * de vie des preuves. Idempotent : une preuve retirée n'est plus candidate,
 * une recopie corrigée n'est plus la dernière écriture, un lien posé n'est
 * pas recréé — rejoué, le rattrapage ne change rien.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';
import { pgClient } from '@/db';
import { resolveDocumentType } from '@/services/canonical/registry';

type Sql = typeof pgClient;
type TxSql = { unsafe: Sql['unsafe'] };
type Row = Record<string, unknown>;

/** Règles de projection « justificatif d'achat du bien » (preuve déduite du document). */
export const ASSET_PURCHASE_RULES = [
  'PURCHASE_RECEIPT_ACQUISITION_DATE', 'PURCHASE_RECEIPT_ACQUISITION_PRICE',
  'PURCHASE_DELIVERY_ACQUISITION_DATE', 'PURCHASE_LINE_ACQUISITION_PRICE',
] as const;
const ACQ = ['acquisitionDate', 'acquisitionPrice'];

export interface SeparationCase {
  kind: 'ASSET_EVIDENCE_WITHDRAWN' | 'EQUIPMENT_EVIDENCE_WITHDRAWN' | 'AGENDA_PURCHASE_MOVED';
  accountId: number;
  assetId: number;
  equipmentId: number | null;
  evidenceId: number | null;
  fieldKey: string;
  value: unknown;
  sourceFileId: number | null;
  motive: string;
}

export interface DataSeparationReport {
  mode: 'simulate' | 'apply';
  runId: string;
  accountsScanned: number;
  cases: SeparationCase[];
  /** Lot 75G : situations insuffisamment démontrées — signalées, jamais modifiées. */
  suspects: SuspectCase[];
  /** Lot 75G : réconciliations reprises d'une exécution interrompue (preuve retirée, fiche pas encore réconciliée). */
  resumed: number;
  /** Valeurs corrigées sur les fiches (retirées ou remplacées par T3). */
  fieldsCorrected: Array<{ type: 'ASSET' | 'EQUIPMENT'; id: number; fieldKey: string; outcome: 'retracted' | 'replaced' | 'moved' | 'cleared' }>;
  /** Valeurs USER / ADMIN laissées en place malgré une preuve retirée. */
  preserved: Array<{ type: 'ASSET' | 'EQUIPMENT'; id: number; fieldKey: string }>;
  documents: { examined: number; linked: number; linksCreated: number; ambiguous: number; samples: string[] };
  failed: Array<{ ref: string; error: string }>;
}

const valeur = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};

/** Comptes visés (filtre BO, sinon tous les comptes ayant au moins un équipement). */
async function comptes(sql: Sql, accountId: number | null): Promise<number[]> {
  if (accountId) return [accountId];
  const r = (await sql.unsafe(
    `SELECT DISTINCT a.account_id FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.deleted_at IS NULL ORDER BY 1`,
  )) as unknown as Row[];
  return r.map((x) => Number(x.account_id));
}

/**
 * Situation INSUFFISAMMENT démontrée (lot 75G, E) : signalée dans le
 * rapport, JAMAIS modifiée automatiquement.
 */
export interface SuspectCase {
  kind:
    | 'ACQUISITION_EVIDENCE_UNPROVEN'   // A : le document porte aussi une acquisition du bien, ou valeurs différentes
    | 'SAME_EVIDENCE_UNPROVEN'          // B : même preuve, plusieurs acquisitions possibles (date, justificatif non rattaché)
    | 'EQUIPMENT_OUTSIDE_ASSET'         // A / B : équipement d'un autre bien (ou d'un autre compte)
    | 'OTHER_ATTRIBUTE_SAME_EVIDENCE'   // marque, modèle, n° de série, garanties… : même preuve bien / équipement
    | 'OTHER_ATTRIBUTE_IDENTICAL';      // même valeur sur le bien et l'équipement, sans preuve propre de l'équipement
  accountId: number;
  assetId: number;
  equipmentId: number | null;
  evidenceId: number | null;
  fieldKey: string;
  value: unknown;
  sourceFileId: number | null;
  motive: string;
}

/** Attributs propres à chaque entité, diagnostiqués (jamais corrigés automatiquement) — lot 75G, E. */
export const OTHER_SEPARATED_KEYS = ['brand', 'modelName', 'serialNumber', 'warrantyStartDate', 'warrantyEndDate', 'estimatedValue'] as const;

/**
 * Cas A et B — preuves dont la provenance DÉMONTRE une confusion bien /
 * équipement (lecture seule). Lot 75G (E) : un document peut couvrir
 * PLUSIEURS acquisitions légitimes ; une valeur identique ne prouve rien.
 *   A. preuve du bien DÉDUITE PAR RÈGLE d'un justificatif ; démontrée
 *      seulement si un équipement DE CE BIEN porte, sur le même document,
 *      la MÊME valeur pour la même clé, et qu'aucune preuve non déduite ne
 *      vise l'acquisition du BIEN dans ce document ;
 *   B. même preuve (document, clé, valeur, extrait) sur le bien et un
 *      équipement DE CE BIEN : acte authentique → la preuve de l'équipement
 *      est la recopie ; autre justificatif → démontrée seulement pour un
 *      PRIX (une même ligne ne chiffre pas deux acquisitions) d'un document
 *      rattaché à cet équipement ; une date partagée peut être légitime.
 * Le reste est SUSPECT : rapporté, jamais modifié.
 */
export async function findEvidenceCases(sql: Sql, accountId: number): Promise<{ cases: SeparationCase[]; suspects: SuspectCase[] }> {
  const out: SeparationCase[] = [];
  const suspects: SuspectCase[] = [];
  const meme = (a: string, b: string) => `COALESCE(${a}.normalized_value, ${a}.value_json::text) = COALESCE(${b}.normalized_value, ${b}.value_json::text)`;
  // A. Preuve du bien déduite par règle d'un justificatif qui porte aussi un achat d'ÉQUIPEMENT.
  const a = (await sql.unsafe(
    `SELECT fe.id, fe.asset_id, fe.field_key, fe.value_json, fe.source_id, fe.projection_rule,
            (SELECT eq.target_entity_id FROM field_evidence eq
              WHERE eq.account_id = fe.account_id AND eq.source_type = fe.source_type AND eq.source_id = fe.source_id
                AND eq.target_type = 'EQUIPMENT' AND eq.field_key = ANY($3::text[])
                AND COALESCE(eq.lifecycle_status, 'ACTIVE') = 'ACTIVE' AND eq.status = 'active'
              ORDER BY eq.id LIMIT 1) AS equipment_any,
            (SELECT eq.target_entity_id FROM field_evidence eq
               JOIN equipments e ON e.id = eq.target_entity_id AND e.asset_id = fe.asset_id
               JOIN assets ea ON ea.id = e.asset_id AND ea.account_id = fe.account_id
              WHERE eq.account_id = fe.account_id AND eq.source_type = fe.source_type AND eq.source_id = fe.source_id
                AND eq.target_type = 'EQUIPMENT' AND eq.field_key = fe.field_key AND ${meme('eq', 'fe')}
                AND COALESCE(eq.lifecycle_status, 'ACTIVE') = 'ACTIVE' AND eq.status = 'active'
              ORDER BY eq.id LIMIT 1) AS equipment_same,
            EXISTS (SELECT 1 FROM field_evidence o
                     WHERE o.account_id = fe.account_id AND o.source_type = fe.source_type AND o.source_id = fe.source_id
                       AND o.id <> fe.id AND o.field_key = ANY($3::text[]) AND o.status = 'active'
                       AND COALESCE(o.lifecycle_status, 'ACTIVE') = 'ACTIVE'
                       AND (o.target_type IS NULL OR o.target_type = 'ASSET')
                       AND (o.projection_rule IS NULL OR NOT (o.projection_rule = ANY($2::text[])))) AS asset_own
       FROM field_evidence fe
      WHERE fe.account_id = $1 AND fe.status = 'active' AND COALESCE(fe.lifecycle_status, 'ACTIVE') = 'ACTIVE'
        AND fe.source_type IN ('document', 'web_link') AND fe.field_key = ANY($3::text[])
        AND (fe.target_type IS NULL OR (fe.target_type = 'ASSET' AND (fe.target_entity_id IS NULL OR fe.target_entity_id = fe.asset_id)))
        AND fe.projection_rule = ANY($2::text[])
        AND EXISTS (SELECT 1 FROM field_evidence eq
                     WHERE eq.account_id = fe.account_id AND eq.source_type = fe.source_type AND eq.source_id = fe.source_id
                       AND eq.target_type = 'EQUIPMENT' AND eq.field_key = ANY($3::text[])
                       AND COALESCE(eq.lifecycle_status, 'ACTIVE') = 'ACTIVE' AND eq.status = 'active')
      ORDER BY fe.id`,
    [accountId, [...ASSET_PURCHASE_RULES], ACQ] as never[],
  )) as unknown as Row[];
  for (const r of a) {
    const commun = { accountId, assetId: Number(r.asset_id), evidenceId: Number(r.id), fieldKey: String(r.field_key), value: valeur(r.value_json), sourceFileId: Number(r.source_id) };
    if (r.equipment_same != null && r.asset_own !== true) {
      out.push({
        kind: 'ASSET_EVIDENCE_WITHDRAWN', ...commun, equipmentId: Number(r.equipment_same),
        motive: `Déduite par la règle ${String(r.projection_rule)} d’un justificatif d’achat de l’équipement #${r.equipment_same} (même valeur, aucune acquisition du bien lue dans ce document)`,
      });
    } else {
      suspects.push({
        kind: 'ACQUISITION_EVIDENCE_UNPROVEN',
        ...commun, equipmentId: r.equipment_same != null ? Number(r.equipment_same) : r.equipment_any == null ? null : Number(r.equipment_any),
        motive: r.asset_own === true
          ? 'Le document porte aussi une acquisition du bien : plusieurs acquisitions possibles, aucune correction'
          : 'Aucun équipement de ce bien ne porte la même valeur dans ce document : provenance non démontrée',
      });
    }
  }
  // B. Même preuve (document, clé, valeur, extrait) pour le bien et un équipement.
  const b = (await sql.unsafe(
    `SELECT fa.id AS asset_ev, fa.asset_id, fq.id AS equipment_ev, fq.target_entity_id AS equipment_id, fa.field_key,
            fa.value_json, fa.source_id, COALESCE(fa.document_type, fq.document_type) AS document_type,
            (e.id IS NOT NULL) AS in_asset,
            (EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = fa.account_id AND l.file_id = fa.source_id
                      AND l.equipment_id = fq.target_entity_id AND l.status = 'ACTIVE')
             OR EXISTS (SELECT 1 FROM asset_files f WHERE f.id = fa.source_id AND f.account_id = fa.account_id
                         AND f.equipment_id = fq.target_entity_id)) AS doc_linked
       FROM field_evidence fa
       JOIN field_evidence fq ON fq.account_id = fa.account_id AND fq.source_type = fa.source_type AND fq.source_id = fa.source_id
                             AND fq.field_key = fa.field_key AND fq.target_type = 'EQUIPMENT'
                             AND COALESCE(fq.lifecycle_status, 'ACTIVE') = 'ACTIVE' AND fq.status = 'active'
                             AND ${meme('fq', 'fa')}
                             AND btrim(lower(regexp_replace(COALESCE(fq.evidence_excerpt, ''), '\\s+', ' ', 'g')))
                               = btrim(lower(regexp_replace(COALESCE(fa.evidence_excerpt, ''), '\\s+', ' ', 'g')))
       LEFT JOIN equipments e ON e.id = fq.target_entity_id AND e.asset_id = fa.asset_id
                             AND EXISTS (SELECT 1 FROM assets ea WHERE ea.id = e.asset_id AND ea.account_id = fa.account_id)
      WHERE fa.account_id = $1 AND fa.status = 'active' AND COALESCE(fa.lifecycle_status, 'ACTIVE') = 'ACTIVE'
        AND fa.source_type IN ('document', 'web_link') AND fa.field_key = ANY($2::text[])
        AND (fa.target_type IS NULL OR (fa.target_type = 'ASSET' AND (fa.target_entity_id IS NULL OR fa.target_entity_id = fa.asset_id)))
        AND COALESCE(fa.evidence_excerpt, '') <> ''
        AND (fa.projection_rule IS NULL OR NOT (fa.projection_rule = ANY($3::text[])))
      ORDER BY fa.id, fq.id`,
    [accountId, ACQ, [...ASSET_PURCHASE_RULES]] as never[],
  )) as unknown as Row[];
  const vus = new Set(out.map((c) => c.evidenceId));
  for (const r of b) {
    const base = { accountId, assetId: Number(r.asset_id), equipmentId: Number(r.equipment_id), fieldKey: String(r.field_key), value: valeur(r.value_json), sourceFileId: Number(r.source_id) };
    if (r.in_asset !== true) {
      suspects.push({ kind: 'EQUIPMENT_OUTSIDE_ASSET', ...base, evidenceId: Number(r.equipment_ev), motive: 'Équipement hors du bien de la preuve : aucune correction' });
      continue;
    }
    const acte = resolveDocumentType(r.document_type == null ? null : String(r.document_type))?.authority === 'AUTHORITATIVE';
    let c: SeparationCase | null = null;
    if (acte) {
      c = { kind: 'EQUIPMENT_EVIDENCE_WITHDRAWN', ...base, evidenceId: Number(r.equipment_ev),
        motive: 'Même preuve que l’acquisition du bien sur un acte authentique : valeur du bien recopiée sur l’équipement' };
    } else if (r.field_key === 'acquisitionPrice' && r.doc_linked === true) {
      c = { kind: 'ASSET_EVIDENCE_WITHDRAWN', ...base, evidenceId: Number(r.asset_ev),
        motive: `Même ligne de prix que l’acquisition de l’équipement #${r.equipment_id} (justificatif rattaché à l’équipement) : valeur de l’équipement reportée sur le bien` };
    }
    if (!c) {
      if (!vus.has(Number(r.asset_ev))) {
        suspects.push({ kind: 'SAME_EVIDENCE_UNPROVEN', ...base, evidenceId: Number(r.asset_ev),
          motive: r.field_key === 'acquisitionPrice'
            ? 'Même preuve de prix, justificatif non rattaché à l’équipement : provenance non démontrée'
            : 'Même date sur un justificatif : plusieurs acquisitions légitimes possibles, aucune correction' });
      }
      continue;
    }
    if (vus.has(c.evidenceId)) continue;
    vus.add(c.evidenceId);
    out.push(c);
  }
  return { cases: out, suspects };
}

/**
 * Autres attributs propres à chaque entité (marque, modèle, n° de série,
 * garanties, valeur estimée) : DIAGNOSTIC seulement (lot 75G, E) — même
 * preuve attribuée au bien et à un de ses équipements, ou même valeur sans
 * preuve propre de l'équipement (valeur automatique). La provenance erronée
 * n'est pas démontrable automatiquement : aucune correction, signalement.
 */
export async function findOtherAttributeSuspects(sql: Sql, accountId: number): Promise<SuspectCase[]> {
  const out: SuspectCase[] = [];
  const cles = [...OTHER_SEPARATED_KEYS];
  const memes = (await sql.unsafe(
    `SELECT fa.id, fa.asset_id, fq.target_entity_id AS equipment_id, fa.field_key, fa.value_json, fa.source_id
       FROM field_evidence fa
       JOIN field_evidence fq ON fq.account_id = fa.account_id AND fq.source_type = fa.source_type AND fq.source_id = fa.source_id
                             AND fq.field_key = fa.field_key AND fq.target_type = 'EQUIPMENT' AND fq.status = 'active'
                             AND COALESCE(fq.lifecycle_status, 'ACTIVE') = 'ACTIVE'
                             AND COALESCE(fq.normalized_value, fq.value_json::text) = COALESCE(fa.normalized_value, fa.value_json::text)
                             AND COALESCE(fq.evidence_excerpt, '') = COALESCE(fa.evidence_excerpt, '')
       JOIN equipments e ON e.id = fq.target_entity_id AND e.asset_id = fa.asset_id
      WHERE fa.account_id = $1 AND fa.status = 'active' AND COALESCE(fa.lifecycle_status, 'ACTIVE') = 'ACTIVE'
        AND fa.field_key = ANY($2::text[]) AND (fa.target_type IS NULL OR fa.target_type = 'ASSET')
      ORDER BY fa.id, fq.id`,
    [accountId, cles] as never[],
  )) as unknown as Row[];
  for (const r of memes) {
    out.push({ kind: 'OTHER_ATTRIBUTE_SAME_EVIDENCE', accountId, assetId: Number(r.asset_id), equipmentId: Number(r.equipment_id), evidenceId: Number(r.id),
      fieldKey: String(r.field_key), value: valeur(r.value_json), sourceFileId: Number(r.source_id), motive: 'Même preuve attribuée au bien et à l’équipement' });
  }
  const { getCanonicalAssetState } = await import('@/services/canonical/asset-state');
  const { getCanonicalEntityState } = await import('@/services/canonical/entity-state');
  let apres = 0;
  const etatsBiens = new Map<number, Record<string, { value?: unknown } | undefined> | null>();
  for (;;) {
    const eqs = (await sql.unsafe(
      `SELECT e.id, e.asset_id,
              ARRAY(SELECT DISTINCT fq.field_key FROM field_evidence fq WHERE fq.account_id = $1 AND fq.target_type = 'EQUIPMENT'
                     AND fq.target_entity_id = e.id AND fq.status = 'active' AND COALESCE(fq.lifecycle_status, 'ACTIVE') = 'ACTIVE') AS prouvees
         FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
        WHERE e.archived_at IS NULL AND e.id > $2 ORDER BY e.id LIMIT 200`,
      [accountId, apres] as never[],
    )) as unknown as Row[];
    for (const e of eqs) {
      const assetId = Number(e.asset_id);
      if (!etatsBiens.has(assetId)) etatsBiens.set(assetId, (await getCanonicalAssetState(assetId, accountId))?.fields ?? null);
      const bien = etatsBiens.get(assetId);
      if (!bien) continue;
      const st = await getCanonicalEntityState({ type: 'EQUIPMENT', id: Number(e.id) }, accountId);
      const prouvees = new Set(((e.prouvees as string[] | null) ?? []));
      for (const k of cles) {
        const fe = st?.fields?.[k];
        const fb = bien[k];
        if (!fe || fe.value == null || fb?.value == null || prouvees.has(k)) continue;
        if (fe.origin === 'USER' || fe.origin === 'ADMIN') continue;
        if (JSON.stringify(fe.value) !== JSON.stringify(fb.value)) continue;
        out.push({ kind: 'OTHER_ATTRIBUTE_IDENTICAL', accountId, assetId, equipmentId: Number(e.id), evidenceId: null, fieldKey: k, value: fe.value,
          sourceFileId: null, motive: 'Même valeur que le bien, sans preuve propre de l’équipement : héritage possible, à vérifier' });
      }
    }
    if (eqs.length < 200) break;
    apres = Number(eqs[eqs.length - 1].id);
  }
  return out;
}

/** Cas C — recopies « achat » (D-13) vers le BIEN depuis un événement lié à un de ses équipements (lecture seule). */
export async function findAgendaPurchaseCases(sql: Sql, accountId: number): Promise<SeparationCase[]> {
  const r = (await sql.unsafe(
    `WITH derniere AS (
       SELECT DISTINCT ON (w.asset_id) w.id, w.asset_id, w.new_value, w.source_id
         FROM canonical_field_writes w
        WHERE w.account_id = $1 AND w.canonical_key = 'acquisitionDate' AND w.outcome = 'written' AND w.dry_run = false
          AND (to_jsonb(w)->>'target_type') IS NULL
        ORDER BY w.asset_id, w.created_at DESC, w.id DESC)
     SELECT d.id, d.asset_id, d.new_value, d.source_id::int AS item_id, e.id AS equipment_id
       FROM derniere d
       JOIN assets a ON a.id = d.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
       JOIN canonical_field_writes w ON w.id = d.id AND w.source_type = 'agenda_item' AND w.source_id ~ '^[0-9]+$'
       JOIN agenda_equipment_links l ON l.agenda_item_id = w.source_id::int
       JOIN equipments e ON e.id = l.equipment_id AND e.asset_id = d.asset_id
      ORDER BY d.asset_id, e.id`,
    [accountId] as never[],
  )) as unknown as Row[];
  const out: SeparationCase[] = [];
  const parBien = new Map<number, Row[]>();
  for (const x of r) parBien.set(Number(x.asset_id), [...(parBien.get(Number(x.asset_id)) ?? []), x]);
  for (const [assetId, xs] of parBien) {
    const v = valeur(xs[0].new_value);
    // Valeur modifiée depuis la recopie (saisie, autre source) : provenance non démontrée, rien.
    const { getCanonicalAssetState } = await import('@/services/canonical/asset-state');
    const actuelle = (await getCanonicalAssetState(assetId, accountId, sql as never))?.fields?.acquisitionDate?.value ?? null;
    if (JSON.stringify(actuelle) !== JSON.stringify(v)) continue;
    for (const x of xs) {
      out.push({
        kind: 'AGENDA_PURCHASE_MOVED', accountId, assetId, equipmentId: Number(x.equipment_id), evidenceId: null,
        fieldKey: 'acquisitionDate', value: v, sourceFileId: null,
        motive: `Date recopiée depuis l’événement « achat » #${x.item_id} lié à l’équipement #${x.equipment_id}`,
      });
    }
  }
  return out;
}

async function journaliser(sql: Sql | TxSql, runId: string, reason: string | null, c: {
  accountId: number; kind: string; subjectType: string; subjectId: number; fieldKey?: string | null; before?: unknown; after?: unknown; detail?: unknown;
}): Promise<void> {
  await sql.unsafe(
    `INSERT INTO data_separation_corrections (run_id, account_id, kind, subject_type, subject_id, field_key, before_value, after_value, detail, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)`,
    [runId, c.accountId, c.kind, c.subjectType, c.subjectId, c.fieldKey ?? null,
      c.before === undefined ? null : JSON.stringify(c.before), c.after === undefined ? null : JSON.stringify(c.after),
      JSON.stringify(c.detail ?? {}), reason] as never[],
  );
}

async function proprietaire(sql: Sql, accountId: number): Promise<number | undefined> {
  const [r] = (await sql.unsafe(`SELECT owner_user_id FROM accounts WHERE id = $1`, [accountId] as never[])) as unknown as Row[];
  return r?.owner_user_id == null ? undefined : Number(r.owner_user_id);
}

/** Exécution (simulation : lecture seule ; application : corrections tracées). */
export async function runDataSeparationBackfill(o: {
  apply: boolean; accountId?: number | null; reason?: string | null; log?: (m: string) => void; sql?: Sql;
  /** Tests de reprise : interruption simulée entre le retrait des preuves et la réconciliation des fiches. */
  simulateInterruption?: 'before_reconcile';
  /**
   * Lot 83B (contrôle de cohérence `COH-ASSET-EQUIPMENT-SEPARATION`) : biens
   * visés seulement (cas A / B / C et suspects de CES biens) ; absent : tous.
   */
  assetIds?: readonly number[] | null;
  /**
   * Lot 83B : partie D (documents → équipements) ; `false` quand l'appelant
   * est le contrôle de cohérence — elle y relève de `COH-DOC-LINKS` (même
   * service commun), jamais de deux chaînes. Défaut : incluse (BO).
   */
  documents?: boolean;
}): Promise<DataSeparationReport> {
  const sql = o.sql ?? pgClient;
  const log = o.log ?? (() => undefined);
  const report: DataSeparationReport = {
    mode: o.apply ? 'apply' : 'simulate', runId: randomUUID(), accountsScanned: 0, cases: [], suspects: [], resumed: 0, fieldsCorrected: [], preserved: [],
    documents: { examined: 0, linked: 0, linksCreated: 0, ambiguous: 0, samples: [] }, failed: [],
  };
  const { getCanonicalAssetState } = await import('@/services/canonical/asset-state');
  const { getCanonicalEntityState } = await import('@/services/canonical/entity-state');
  const humain = (origin: string | null | undefined) => origin === 'USER' || origin === 'ADMIN';

  for (const accountId of await comptes(sql, o.accountId ?? null)) {
    report.accountsScanned++;
    try {
      const preuves = await findEvidenceCases(sql, accountId);
      const vise = (x: { assetId: number }) => !o.assetIds || o.assetIds.includes(x.assetId);
      const cas = [...preuves.cases, ...await findAgendaPurchaseCases(sql, accountId)].filter(vise);
      report.cases.push(...cas);
      report.suspects.push(...[...preuves.suspects, ...await findOtherAttributeSuspects(sql, accountId)].filter(vise));
      const userId = await proprietaire(sql, accountId);

      // ── A / B : retrait des preuves, puis réconciliation des fiches touchées ──
      const biens = new Set<number>();
      const equipements = new Set<number>();
      const avant = new Map<string, unknown>();
      for (const c of cas.filter((x) => x.evidenceId !== null)) {
        const cible = c.kind === 'EQUIPMENT_EVIDENCE_WITHDRAWN' ? { type: 'EQUIPMENT' as const, id: c.equipmentId! } : { type: 'ASSET' as const, id: c.assetId };
        const etat = cible.type === 'ASSET'
          ? (await getCanonicalAssetState(c.assetId, accountId))?.fields?.[c.fieldKey]
          : (await getCanonicalEntityState({ type: 'EQUIPMENT', id: cible.id }, accountId))?.fields?.[c.fieldKey];
        if (etat && humain(etat.origin)) report.preserved.push({ type: cible.type, id: cible.id, fieldKey: c.fieldKey });
        if (!o.apply) continue;
        // Lot 75G : retrait et journal dans UNE transaction (jamais l'un sans l'autre).
        const fait = await sql.begin(async (t) => {
          const r = (await t.unsafe(
            `UPDATE field_evidence SET lifecycle_status = 'WITHDRAWN', superseded_at = now()
              WHERE id = $1 AND account_id = $2 AND COALESCE(lifecycle_status, 'ACTIVE') = 'ACTIVE' RETURNING id`,
            [c.evidenceId, accountId] as never[],
          )) as unknown as unknown[];
          if (r.length === 0) return false;
          await journaliser(t, report.runId, o.reason ?? null, {
            accountId, kind: c.kind, subjectType: 'FIELD_EVIDENCE', subjectId: c.evidenceId!, fieldKey: c.fieldKey,
            before: { lifecycle: 'ACTIVE', value: c.value }, after: { lifecycle: 'WITHDRAWN' },
            detail: { motive: c.motive, sourceFileId: c.sourceFileId, assetId: c.assetId, equipmentId: c.equipmentId },
          });
          return true;
        });
        if (!fait) continue;
        avant.set(`${cible.type}:${cible.id}:${c.fieldKey}`, etat?.value ?? null);
        if (cible.type === 'ASSET') biens.add(cible.id); else equipements.add(cible.id);
      }
      if (o.apply && o.simulateInterruption === 'before_reconcile') throw new Error('interruption simulée avant réconciliation');
      // Lot 75G (reprise) : preuves retirées par une exécution INTERROMPUE avant
      // la réconciliation de leur fiche → réconciliées maintenant.
      const enSuspens = (await sql.unsafe(
        `SELECT id, kind, detail FROM data_separation_corrections
          WHERE account_id = $1 AND kind IN ('ASSET_EVIDENCE_WITHDRAWN', 'EQUIPMENT_EVIDENCE_WITHDRAWN')
            AND NOT (detail ? 'reconciledAt') AND run_id <> $2::uuid`,
        [accountId, report.runId] as never[],
      )) as unknown as Row[];
      if (o.apply) {
        for (const j of enSuspens) {
          const d = (typeof j.detail === 'string' ? JSON.parse(j.detail) : j.detail) as { assetId?: number; equipmentId?: number };
          if (j.kind === 'ASSET_EVIDENCE_WITHDRAWN' && d.assetId) biens.add(Number(d.assetId));
          if (j.kind === 'EQUIPMENT_EVIDENCE_WITHDRAWN' && d.equipmentId) equipements.add(Number(d.equipmentId));
        }
      }
      report.resumed += enSuspens.length;
      if (o.apply) {
        const { reconcileAsset } = await import('@/services/ai/reconciliation');
        const { reconcileEntity } = await import('@/services/ai/reconciliation/entity-reconciliation');
        for (const assetId of biens) {
          await reconcileAsset({ accountId, assetId, userId, triggeredBy: 'manual' });
          const st = await getCanonicalAssetState(assetId, accountId);
          for (const [k, v] of avant) {
            const [t, id, key] = k.split(':');
            if (t !== 'ASSET' || Number(id) !== assetId) continue;
            const apres = st?.fields?.[key]?.value ?? null;
            if (JSON.stringify(apres) !== JSON.stringify(v)) report.fieldsCorrected.push({ type: 'ASSET', id: assetId, fieldKey: key, outcome: apres == null ? 'retracted' : 'replaced' });
          }
        }
        for (const id of equipements) {
          await reconcileEntity({ accountId, target: { type: 'EQUIPMENT', id }, userId, triggeredBy: 'manual' });
          const st = await getCanonicalEntityState({ type: 'EQUIPMENT', id }, accountId);
          for (const [k, v] of avant) {
            const [t, eid, key] = k.split(':');
            if (t !== 'EQUIPMENT' || Number(eid) !== id) continue;
            const apres = st?.fields?.[key]?.value ?? null;
            if (JSON.stringify(apres) !== JSON.stringify(v)) report.fieldsCorrected.push({ type: 'EQUIPMENT', id, fieldKey: key, outcome: apres == null ? 'retracted' : 'replaced' });
          }
        }
        // Fiches réconciliées : les retraits (de ce passage et repris) sont marqués, la reprise ne les rejoue plus.
        await sql.unsafe(
          `UPDATE data_separation_corrections SET detail = detail || jsonb_build_object('reconciledAt', now())
            WHERE account_id = $1 AND kind IN ('ASSET_EVIDENCE_WITHDRAWN', 'EQUIPMENT_EVIDENCE_WITHDRAWN') AND NOT (detail ? 'reconciledAt')`,
          [accountId] as never[],
        );
      }

      // ── C : recopie « achat » D-13 vers le bien → équipement ──────────────
      if (o.apply) {
        const { writeCanonicalAssetField } = await import('@/services/canonical/asset-state');
        const { writeCanonicalEntityField } = await import('@/services/canonical/entity-state');
        const parBien = new Map<number, SeparationCase[]>();
        for (const c of cas.filter((x) => x.kind === 'AGENDA_PURCHASE_MOVED')) parBien.set(c.assetId, [...(parBien.get(c.assetId) ?? []), c]);
        for (const [assetId, cs] of parBien) {
          for (const c of cs) {
            // Origine de la recopie D-13 conservée (geste « réalisé » de l'utilisateur) ; jamais par-dessus une valeur existante.
            const e = await writeCanonicalEntityField({
              target: { type: 'EQUIPMENT', id: c.equipmentId! }, accountId, key: 'acquisitionDate', value: c.value, origin: 'USER',
              expectedCurrent: null, source: { type: 'data_separation_backfill', id: report.runId },
            });
            if (e.fields[0]?.outcome === 'written') {
              report.fieldsCorrected.push({ type: 'EQUIPMENT', id: c.equipmentId!, fieldKey: 'acquisitionDate', outcome: 'moved' });
              await journaliser(sql, report.runId, o.reason ?? null, {
                accountId, kind: 'AGENDA_PURCHASE_MOVED', subjectType: 'EQUIPMENT', subjectId: c.equipmentId!, fieldKey: 'acquisitionDate',
                before: null, after: c.value, detail: { motive: c.motive, assetId },
              });
            }
          }
          const r = await writeCanonicalAssetField({
            assetId, accountId, key: 'acquisitionDate', value: null, origin: 'ADMIN', expectedCurrent: cs[0].value,
            source: { type: 'data_separation_backfill', id: report.runId },
          });
          if (r.field?.outcome === 'written') {
            report.fieldsCorrected.push({ type: 'ASSET', id: assetId, fieldKey: 'acquisitionDate', outcome: 'cleared' });
            await journaliser(sql, report.runId, o.reason ?? null, {
              accountId, kind: 'AGENDA_PURCHASE_MOVED', subjectType: 'ASSET', subjectId: assetId, fieldKey: 'acquisitionDate',
              before: cs[0].value, after: null, detail: { motive: cs[0].motive, equipmentIds: cs.map((x) => x.equipmentId) },
            });
            // Une preuve documentaire du bien écartée par la recopie peut maintenant s'appliquer.
            const { reconcileAsset } = await import('@/services/ai/reconciliation');
            await reconcileAsset({ accountId, assetId, userId, triggeredBy: 'manual' });
          }
        }
      }

      // ── D : documents → équipements (rétroactif, déterministe seul ; TOUS les documents, par pages) ──
      const { syncDocumentEquipmentLinks, iterateDocumentsOfAsset } = await import('./document-equipment-link.service');
      const biensAvecEquipements = o.documents === false ? [] : (await sql.unsafe(
        `SELECT DISTINCT a.id FROM assets a JOIN equipments e ON e.asset_id = a.id AND e.archived_at IS NULL
          WHERE a.account_id = $1 AND a.deleted_at IS NULL ORDER BY a.id`,
        [accountId] as never[],
      )) as unknown as Row[];
      const vus = new Set<number>();
      for (const b of biensAvecEquipements) {
        for await (const fileId of iterateDocumentsOfAsset(accountId, Number(b.id), sql)) {
          if (vus.has(fileId)) continue;
          vus.add(fileId);
          const r = await syncDocumentEquipmentLinks({ accountId, fileId, allowAi: false, proposeCard: o.apply, dryRun: !o.apply, sql });
          report.documents.examined++;
          if (r.status === 'AMBIGUOUS') report.documents.ambiguous++;
          if (r.created > 0 || r.columnSet) {
            report.documents.linked++;
            if (report.documents.samples.length < 20) report.documents.samples.push(`document ${fileId} → équipement(s) ${r.linked.join(', ')} (${r.methods.join(', ')})`);
          }
          report.documents.linksCreated += r.created;
          if (o.apply && r.created > 0) {
            await journaliser(sql, report.runId, o.reason ?? null, {
              accountId, kind: 'DOCUMENT_EQUIPMENT_LINKED', subjectType: 'DOCUMENT', subjectId: fileId,
              after: { equipmentIds: r.linked, columnSet: r.columnSet }, detail: { methods: r.methods },
            });
          }
        }
      }
      log(`compte ${accountId} : ${cas.length} cas démontré(s), ${report.suspects.filter((x) => x.accountId === accountId).length} suspect(s), ${report.documents.examined} document(s) examiné(s) au total`);
    } catch (e) {
      report.failed.push({ ref: `compte ${accountId}`, error: (e as Error).message });
      log(`compte ${accountId} : échec — ${(e as Error).message}`);
    }
  }
  return report;
}
