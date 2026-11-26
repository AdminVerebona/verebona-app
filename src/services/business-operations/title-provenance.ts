/**
 * Carte #859 — PROVENANCE DU TITRE AU NIVEAU DU CHAMP (brique unique).
 *
 * Deux champs, chacun avec SA provenance, indépendante de l'autre :
 *   · `business_operations.technical_label` (intitulé de l'Opération, T3) ;
 *   · `agenda_items.title` (titre de l'événement d'Agenda, T4).
 *
 * Trois états logiques (`TitleAuthority`) :
 *   · SYSTEM  : titre généré automatiquement, origine établie, aucune décision
 *               ultérieure de l'utilisateur sur CE champ — une amélioration
 *               fiable (règle de nommage existante) est permise, même si
 *               d'autres champs (date, statut, liens…) ont été corrigés ;
 *   · USER    : titre choisi ou édité explicitement par l'utilisateur —
 *               jamais réécrit automatiquement, même s'il est égal à un résumé
 *               documentaire ou à une ancienne valeur générée ;
 *   · UNKNOWN : preuves absentes, contradictoires ou insuffisantes — rien
 *               n'est écrit, l'abstention est motivée (`reason`).
 * JAMAIS déduit d'une égalité de chaînes (SYSTEM) ni de l'indicateur GLOBAL
 * de modification seul (USER).
 *
 * Preuves lues, dans l'ordre :
 *   1. `title_provenance` (migrations 2010 / 2011) : dernier geste sur le titre, tenu
 *      par déclencheur dans la même instruction que l'écriture, d'après la
 *      DÉCLARATION de la transaction (`declareTitleWrite`). Valable seulement
 *      si sa valeur est encore celle du champ ;
 *   2. à défaut (stock, ou écriture non déclarée) :
 *      - Opération : DERNIÈRE ligne de `business_operation_history` qui écrit
 *        `technical_label` (champ, valeur, ordre, acteur, motif) — motif d'un
 *        moteur connu → SYSTEM, geste d'un utilisateur → USER, sinon INCONNU ;
 *      - Agenda : élément saisi → USER ; élément automatique jamais modifié
 *        (`is_automatic_modified` faux : convention §14.6) → SYSTEM ; élément
 *        modifié dont une trace USER_MODIFIED change le titre → USER ; sinon
 *        INCONNU (modification ancienne sans trace du champ).
 *
 * Exposé pour être RÉUTILISÉ tel quel (décision T3 `acquisitionLabelDecision`,
 * aperçu et reprise des achats, projection T4 SYNC / RETITLE, garde SQL
 * d'écriture) : `operationTitleAuthority`, `agendaTitleAuthority`,
 * `AGENDA_TITLE_SYSTEM_SQL`, `loadOperationTitleAuthority`, `declareTitleWrite`.
 */
import { sql, type SQL } from 'drizzle-orm';

export type TitleAuthority = 'SYSTEM' | 'USER' | 'UNKNOWN';

/** Décision d'autorité sur UN champ titre : état, motif (code stable) et référence probante. */
export interface TitleAuthorityDecision {
  authority: TitleAuthority;
  /** Motif stable (diagnostic, rapport de reprise). */
  reason: TitleAuthorityReason;
  /** Référence de la preuve lue (« title_provenance », « history:<id> », « occurrence_event ») ; null : aucune. */
  evidence: string | null;
}

export type TitleAuthorityReason =
  // Provenance par champ (migrations 2010 / 2011)
  | 'SYSTEM_TITLE_RECORDED' | 'USER_TITLE_RECORDED' | 'UNKNOWN_TITLE_RECORDED'
  // Opération, repli sur l'historique
  | 'NO_TITLE' | 'NO_TITLE_TRACE' | 'TITLE_DIFFERS_FROM_LAST_TRACE'
  | 'HISTORY_SYSTEM_TITLE_WRITE' | 'HISTORY_USER_TITLE_WRITE' | 'HISTORY_TITLE_WRITE_UNCLASSIFIED'
  // Agenda, repli sur les indicateurs et le journal
  | 'MANUAL_ITEM' | 'AUTOMATIC_UNTOUCHED' | 'STOCK_USER_TITLE_EDIT_TRACED' | 'MODIFIED_WITHOUT_TITLE_TRACE';

/** Provenance persistée (`title_provenance`), telle que le déclencheur l'écrit. */
export interface TitleProvenanceRecord {
  origin: TitleAuthority;
  value: string | null;
  previous?: string | null;
  at?: string | null;
  reason?: string | null;
  actorUserId?: number | null;
  channel?: string | null;
  evidence?: string | null;
}

/** Lecture tolérante d'une provenance persistée (null : absente ou illisible). Pure. */
export function parseTitleProvenance(v: unknown): TitleProvenanceRecord | null {
  const o = typeof v === 'string' ? (() => { try { return JSON.parse(v) as unknown; } catch { return null; } })() : v;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (r.origin !== 'SYSTEM' && r.origin !== 'USER' && r.origin !== 'UNKNOWN') return null;
  if (!('value' in r) || (r.value !== null && typeof r.value !== 'string')) return null;
  return {
    origin: r.origin, value: (r.value as string | null) ?? null,
    previous: typeof r.previous === 'string' ? r.previous : null,
    at: typeof r.at === 'string' ? r.at : null,
    reason: typeof r.reason === 'string' ? r.reason : null,
    actorUserId: typeof r.actorUserId === 'number' ? r.actorUserId : null,
    channel: typeof r.channel === 'string' ? r.channel : null,
    evidence: typeof r.evidence === 'string' ? r.evidence : null,
  };
}

const RECORDED: Record<TitleAuthority, TitleAuthorityReason> = {
  SYSTEM: 'SYSTEM_TITLE_RECORDED', USER: 'USER_TITLE_RECORDED', UNKNOWN: 'UNKNOWN_TITLE_RECORDED',
};

// ── Opération ───────────────────────────────────────────────────────────────

/**
 * Motifs d'historique des moteurs qui POSENT un intitulé généré (création et consolidation T3, élément d'Agenda,
 * donnée structurée du bien, reprise des noms d'achat). Liste fermée : un motif inconnu n'est jamais « du système ».
 */
export const SYSTEM_TITLE_REASONS: ReadonlySet<string> = new Set([
  'T3_CREATE_NEW', 'AGENDA_CREATE', 'ASSET_DATA_CREATE', 'ASSET_DATA_MIGRATION_CREATE',
  'T3_ATTRIBUTES_CONSOLIDATED', 'T3_SOURCE_WITHDRAWN_REEVALUATED', 'T3_ACQUISITION_NAME_APPLIED',
]);

/** Motifs des commandes de l'utilisateur qui écrivent l'intitulé (façade d'écriture des Opérations). */
export const USER_TITLE_REASONS: ReadonlySet<string> = new Set([
  'USER_DECLARATION_CREATE', 'USER_DECLARATION_UPDATE', 'USER_PAGE_CORRECTION',
]);

/** Dernière écriture de `technical_label` relevée dans `business_operation_history`. */
export interface LabelHistoryTrace {
  id: number;
  eventType: string;
  reasonCode: string;
  actorUserId: number | null;
  /** Valeur écrite (`after_json.technical_label`). */
  value: string | null;
}

/**
 * Autorité sur l'intitulé d'une Opération (pure). La provenance par champ prime si elle décrit la valeur actuelle ;
 * sinon la dernière écriture historisée du champ ; sinon INCONNU (un intitulé absent n'a rien à protéger).
 */
export function operationTitleAuthority(p: {
  technicalLabel: string | null; provenance?: unknown; lastLabelWrite?: LabelHistoryTrace | null;
}): TitleAuthorityDecision {
  const prov = parseTitleProvenance(p.provenance);
  if (prov && prov.value === p.technicalLabel) return { authority: prov.origin, reason: RECORDED[prov.origin], evidence: 'title_provenance' };
  const h = p.lastLabelWrite ?? null;
  if (!h) {
    return p.technicalLabel === null
      ? { authority: 'SYSTEM', reason: 'NO_TITLE', evidence: null }
      : { authority: 'UNKNOWN', reason: 'NO_TITLE_TRACE', evidence: null };
  }
  const evidence = `history:${h.id}`;
  if (h.value !== p.technicalLabel) return { authority: 'UNKNOWN', reason: 'TITLE_DIFFERS_FROM_LAST_TRACE', evidence };
  if (SYSTEM_TITLE_REASONS.has(h.reasonCode)) return { authority: 'SYSTEM', reason: 'HISTORY_SYSTEM_TITLE_WRITE', evidence };
  if (h.actorUserId !== null || USER_TITLE_REASONS.has(h.reasonCode) || h.reasonCode.startsWith('USER_')) {
    return { authority: 'USER', reason: 'HISTORY_USER_TITLE_WRITE', evidence };
  }
  return { authority: 'UNKNOWN', reason: 'HISTORY_TITLE_WRITE_UNCLASSIFIED', evidence };
}

/** Exécuteur minimal (transaction Drizzle). */
interface SqlTx { execute(q: SQL): Promise<unknown> }

const rowsOf = (r: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(r) ? r : ((r as { rows?: unknown[] })?.rows ?? [])) as Array<Record<string, unknown>>;

/**
 * Autorité sur l'intitulé d'UNE Opération, relue dans la transaction de l'appelant (sous son verrou : la décision et
 * l'écriture voient le même état). Colonne absente (migration 2010 non jouée) : lue comme « aucune provenance ».
 */
export async function loadOperationTitleAuthority(tx: SqlTx, accountId: number, operationId: number): Promise<TitleAuthorityDecision & { technicalLabel: string | null }> {
  const [r] = rowsOf(await tx.execute(sql`
    SELECT o.technical_label, to_jsonb(o) -> 'title_provenance' AS prov,
           (SELECT jsonb_build_object('id', h.id, 'eventType', h.event_type, 'reasonCode', h.reason_code,
                                      'actorUserId', h.actor_user_id, 'value', h.after_json -> 'technical_label')
              FROM business_operation_history h
             WHERE h.operation_id = o.id AND h.account_id = o.account_id AND h.after_json ? 'technical_label'
             ORDER BY h.id DESC LIMIT 1) AS last
      FROM business_operations o WHERE o.id = ${operationId} AND o.account_id = ${accountId}`));
  if (!r) return { authority: 'UNKNOWN', reason: 'NO_TITLE_TRACE', evidence: null, technicalLabel: null };
  const technicalLabel = (r.technical_label as string | null) ?? null;
  const l = (typeof r.last === 'string' ? JSON.parse(r.last) : r.last) as Record<string, unknown> | null;
  const lastLabelWrite: LabelHistoryTrace | null = l ? {
    id: Number(l.id), eventType: String(l.eventType), reasonCode: String(l.reasonCode),
    actorUserId: l.actorUserId === null || l.actorUserId === undefined ? null : Number(l.actorUserId),
    value: typeof l.value === 'string' ? l.value : null,
  } : null;
  return { ...operationTitleAuthority({ technicalLabel, provenance: r.prov, lastLabelWrite }), technicalLabel };
}

// ── Agenda ──────────────────────────────────────────────────────────────────

/**
 * Autorité sur le titre d'un élément d'Agenda (pure). Un élément saisi par l'utilisateur n'est JAMAIS éligible.
 * `stockUserTitleTrace` : une trace USER_MODIFIED / USER_CONFIRMED change le titre (stock sans provenance).
 */
export function agendaTitleAuthority(i: {
  title: string; isAutomatic: boolean; isAutomaticModified: boolean; provenance?: unknown; stockUserTitleTrace?: boolean;
}): TitleAuthorityDecision {
  if (!i.isAutomatic) return { authority: 'USER', reason: 'MANUAL_ITEM', evidence: null };
  const prov = parseTitleProvenance(i.provenance);
  if (prov && prov.value === i.title) return { authority: prov.origin, reason: RECORDED[prov.origin], evidence: 'title_provenance' };
  if (!i.isAutomaticModified) return { authority: 'SYSTEM', reason: 'AUTOMATIC_UNTOUCHED', evidence: null };
  if (i.stockUserTitleTrace) return { authority: 'USER', reason: 'STOCK_USER_TITLE_EDIT_TRACED', evidence: 'occurrence_event' };
  return { authority: 'UNKNOWN', reason: 'MODIFIED_WITHOUT_TITLE_TRACE', evidence: null };
}

/**
 * Garde SQL « titre SYSTEM prouvé » d'un élément d'Agenda (alias donné), STRICTEMENT équivalente à
 * `agendaTitleAuthority(...).authority === 'SYSTEM'` — écrite dans le WHERE de l'écriture elle-même (aucune course).
 * Colonne lue par `to_jsonb` : absente, elle vaut « aucune provenance ».
 */
export const AGENDA_TITLE_SYSTEM_SQL = (a = 'i'): string => `(
  ${a}.is_automatic AND CASE
    WHEN jsonb_typeof(to_jsonb(${a}) -> 'title_provenance') = 'object'
         AND (to_jsonb(${a}) -> 'title_provenance' ->> 'origin') IN ('SYSTEM', 'USER', 'UNKNOWN')
         AND (to_jsonb(${a}) -> 'title_provenance' ->> 'value') IS NOT DISTINCT FROM ${a}.title
      THEN (to_jsonb(${a}) -> 'title_provenance' ->> 'origin') = 'SYSTEM'
    ELSE NOT COALESCE(${a}.is_automatic_modified, false) END)`;

/** Colonnes de lecture des preuves du titre d'un élément (alias donné) : `title_provenance`, `stock_user_title_trace`. */
export const AGENDA_TITLE_EVIDENCE_COLUMNS_SQL = (a = 'i'): string => `
  (to_jsonb(${a}) -> 'title_provenance') AS title_provenance,
  EXISTS (SELECT 1 FROM agenda_occurrence_events te WHERE te.agenda_item_id = ${a}.id
           AND te.event_type IN ('USER_MODIFIED', 'USER_CONFIRMED')
           AND (te.detail_json -> 'before' ->> 'title') IS DISTINCT FROM (te.detail_json -> 'after' ->> 'title')) AS stock_user_title_trace`;

/** Autorité d'un élément lu avec `AGENDA_TITLE_EVIDENCE_COLUMNS_SQL` (ligne brute). */
export function agendaTitleAuthorityOfRow(r: Record<string, unknown>): TitleAuthorityDecision {
  return agendaTitleAuthority({
    title: String(r.title ?? ''), isAutomatic: r.is_automatic === true,
    isAutomaticModified: r.is_automatic_modified === true || r.modified === true,
    provenance: r.title_provenance, stockUserTitleTrace: r.stock_user_title_trace === true,
  });
}

// ── Déclaration d'une écriture de titre ─────────────────────────────────────

/** Déclaration d'un geste sur le titre, lue par le déclencheurs 2010 / 2011 dans la même transaction. */
export interface TitleWriteDeclaration {
  origin: 'SYSTEM' | 'USER';
  /** Motif (code stable : `T3_ACQUISITION_NAME_APPLIED`, `USER_PAGE_CORRECTION`, `T4_PURCHASE_TITLE`…). */
  reason: string;
  actorUserId?: number | null;
  /** Canal (UI, ASSISTANT, T3, T4, REPRISE…). */
  channel?: string | null;
  /** Référence probante (source, document, journal). */
  evidence?: string | null;
  /** Geste explicite de choix du titre : tracé même si la valeur est identique (USER seulement). */
  explicit?: boolean;
}

export const TITLE_DECLARATION_SETTING = 'verebona.title_declaration';

/** Valeur de la déclaration (JSON) ; null : retrait. Pure. */
export function titleDeclarationValue(d: TitleWriteDeclaration | null): string {
  if (!d) return '';
  return JSON.stringify({
    origin: d.origin, reason: d.reason, actorUserId: d.actorUserId ?? null, channel: d.channel ?? null,
    evidence: d.evidence ?? null, ...(d.explicit && d.origin === 'USER' ? { explicit: true } : {}),
  });
}

/**
 * Pose la déclaration (Drizzle), exécute l'écriture, puis la RETIRE — même si l'écriture échoue : la déclaration ne
 * vaut jamais pour une autre instruction de la transaction.
 */
export async function declareTitleWrite<T>(tx: SqlTx, d: TitleWriteDeclaration, write: () => Promise<T>): Promise<T> {
  await tx.execute(sql`SELECT set_config(${TITLE_DECLARATION_SETTING}, ${titleDeclarationValue(d)}, true)`);
  try {
    return await write();
  } finally {
    await tx.execute(sql`SELECT set_config(${TITLE_DECLARATION_SETTING}, '', true)`).catch(() => undefined);
  }
}

/** Même chose pour une transaction `postgres` (gabarits). */
export async function declareTitleWritePg<T>(
  tx: (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown>, d: TitleWriteDeclaration, write: () => Promise<T>,
): Promise<T> {
  await tx`SELECT set_config(${TITLE_DECLARATION_SETTING}, ${titleDeclarationValue(d)}, true)`;
  try {
    return await write();
  } finally {
    await Promise.resolve(tx`SELECT set_config(${TITLE_DECLARATION_SETTING}, '', true)`).catch(() => undefined);
  }
}
