/**
 * Réconciliation du STATUT des échéances à l'arrivée d'une preuve —
 * CDC 15 T4-12 à T4-14 (lot 14, volet B). Branche `reconcileStatus()` (T4,
 * agent A) sur un déclencheur réel.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉCLENCHEUR
 *
 * Une nouvelle preuve de réalisation liée à une échéance : un document
 * ANALYSÉ ou RATTACHÉ à un bien. Les deux passent déjà par la réconciliation
 * locale du bien (`reconcileAsset`, `triggeredBy` document_analyzed |
 * document_linked, `sourceFileId`) — portée par la file durable T3 pour
 * l'analyse et le cycle de vie des documents, appelée par le rattachement.
 * La réconciliation de statut s'y greffe, APRÈS la réconciliation des
 * champs (les preuves du document sont alors écrites) : aucune file ni
 * déclencheur nouveau, même reprise et même backoff que T3.
 *
 * Gouvernance : AI_T4_EFFECTS=enabled, OU architecture T4 `master` (la
 * condition de `reconcileStatus`). Sinon rien — pas même une lecture.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CORRESPONDANCE PREUVE ↔ ÉCHÉANCE
 *
 *  · échéances OUVERTES du bien (sans statut, datées, non HISTORICAL), avec
 *    leur type métier (colonne 0223, sinon le champ d'origine du registre) ;
 *  · preuves ACTIVES du document pour ce bien (`field_evidence`) : un fait
 *    dont le type métier est celui de l'échéance et qui n'est pas lui-même
 *    une échéance (ex. `lastInspection` pour `nextInspection`) — sa date
 *    est la date de réalisation ; à défaut, le document lui-même si son type
 *    couvre ce type métier au DOCUMENT_CATALOG (confiance `probable` : il
 *    ne peut au mieux que PROPOSER) ;
 *  · fenêtre : `matchOccurrence` (A) ≠ `none` ; une preuve ne vaut que pour
 *    UNE occurrence par type métier (la plus proche).
 *
 * EFFETS (décision de `reconcileStatus`)
 *   mark_done         statut « réalisé » par la primitive (canal T4), lien
 *                     document ↔ élément, trace STATUS_AUTO_COMPLETED ;
 *   propose_done      carte À traiter AGENDA-DONE ;
 *   propose_not_done  carte À traiter AGENDA-NOT-DONE — `not_completed`
 *                     n'est JAMAIS écrit automatiquement ;
 *   keep              rien.
 * Un élément manuel ou modifié à la main n'est jamais modifié (A : `keep`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { t4EffectsMode, type RolloutMode } from '@/services/canonical/rollout';
import { getField, resolveDocumentType } from '@/services/canonical/registry';
import type { ExistingAgendaItem, HomeCategory } from '@/services/ai/agenda/types';
import type { CompletionEvidence, OccurrenceMatch } from '@/services/ai/agenda/status-reconciler';
import type { PromptArchitecture } from '@/services/ai/config/config-types';
import { agendaFunctionalColumnsReady } from './agenda-columns';
import { resolveEventSemantics } from './agenda-functional-key';

type Recurrence = NonNullable<ExistingAgendaItem['recurrence']>;
const FREQUENCES = new Set(['daily', 'weekly', 'monthly', 'yearly']);

/**
 * Récurrence de la série au format de `ExistingAgendaItem` : `recurrence_json`
 * (`{ frequency, interval }`, ou règle `FREQ=…;INTERVAL=…`), sinon la
 * récurrence du registre pour le champ d'origine.
 */
export function parseSeriesRecurrence(json: unknown, originFieldKey?: string | null): Recurrence | null {
  const depuisRegle = (rule: string): Recurrence | null => {
    const f = /FREQ=([A-Z]+)/i.exec(rule)?.[1]?.toLowerCase();
    if (!f || !FREQUENCES.has(f)) return null;
    const i = Number(/INTERVAL=(\d+)/i.exec(rule)?.[1] ?? 1);
    return { frequency: f as Recurrence['frequency'], interval: Math.max(1, i) };
  };
  if (json && typeof json === 'object') {
    const r = json as { frequency?: unknown; interval?: unknown; rule?: unknown };
    const f = typeof r.frequency === 'string' ? r.frequency.toLowerCase() : null;
    if (f && FREQUENCES.has(f)) {
      return { frequency: f as Recurrence['frequency'], interval: Math.max(1, Number(r.interval) || 1) };
    }
    if (typeof r.rule === 'string') {
      const x = depuisRegle(r.rule);
      if (x) return x;
    }
  }
  const effet = originFieldKey ? getField(originFieldKey)?.agendaEffect : undefined;
  return effet?.recurrence ? depuisRegle(effet.recurrence) : null;
}

/** Ligne d'élément d'agenda → `ExistingAgendaItem` enrichi (type métier, récurrence, statut). */
export function toStatusItem(r: {
  id: number; title: string; date: string; homeCategory: string | null; manualStatus: string | null;
  isAutomatic: boolean; isAutomaticModified: boolean; originFieldKey: string | null;
  occurrenceNature: string | null; seriesKey: string | null; recurrence: unknown; businessType: string | null;
}): ExistingAgendaItem {
  const businessType = r.businessType ?? resolveEventSemantics({ originFieldKey: r.originFieldKey }).businessType;
  return {
    id: Number(r.id),
    title: r.title,
    date: r.date,
    category: (r.homeCategory as HomeCategory | null) ?? null,
    status: r.manualStatus && r.manualStatus !== '' ? r.manualStatus : null,
    manual: !r.isAutomatic || r.isAutomaticModified,
    originFieldKey: r.originFieldKey,
    nature: (r.occurrenceNature as 'FORECAST' | 'CONFIRMED' | null) ?? 'CONFIRMED',
    seriesKey: r.seriesKey,
    businessType,
    recurrence: parseSeriesRecurrence(r.recurrence, r.originFieldKey),
  };
}

/** Preuve lue pour un document (fait ou document entier). */
export interface SourceProof {
  businessType: string | null;
  nature: string | null;
  excerpt: string;
  confidence: CompletionEvidence['confidence'];
  documentType: string | null;
  documentDate: Date | null;
  occurrenceDate: Date | null;
}

const ISO = /^\d{4}-\d{2}-\d{2}/;
const asDate = (v: unknown): Date | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' || !ISO.test(v)) return null;
  const d = new Date(`${v.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const RANG_CONFIANCE: Record<string, number> = { certain: 3, probable: 2, ambiguous: 1 };
const RANG_MATCH: Record<OccurrenceMatch, number> = { exact: 3, probable: 2, ambiguous: 1, none: 0 };

/**
 * Preuve de réalisation d'une échéance dans un document (pure, testée) :
 * fait de même type métier, non DEADLINE, le plus sûr ; sinon le document
 * entier si son type couvre ce type métier (confiance `probable`).
 */
export function evidenceForItem(item: ExistingAgendaItem, proofs: SourceProof[]): CompletionEvidence | null {
  if (!item.businessType || proofs.length === 0) return null;
  const faits = proofs
    .filter((p) => p.businessType === item.businessType && p.nature !== 'DEADLINE')
    .sort((a, b) => (RANG_CONFIANCE[b.confidence] ?? 0) - (RANG_CONFIANCE[a.confidence] ?? 0)
      || Number(!!b.occurrenceDate) - Number(!!a.occurrenceDate));
  const f = faits[0];
  if (f) {
    return {
      excerpt: f.excerpt, confidence: f.confidence, documentType: f.documentType,
      documentDate: f.documentDate, occurrenceDate: f.occurrenceDate ?? f.documentDate,
    };
  }
  const doc = proofs.find((p) => p.documentType) ?? proofs[0];
  const entry = resolveDocumentType(doc.documentType);
  if (!entry || !entry.businessTypes.includes(item.businessType as never)) return null;
  return {
    excerpt: '', confidence: 'probable', documentType: doc.documentType,
    documentDate: doc.documentDate, occurrenceDate: doc.documentDate,
  };
}

async function loadOpenItems(accountId: number, assetId: number): Promise<ExistingAgendaItem[]> {
  const col0223 = await agendaFunctionalColumnsReady();
  const rows = (await pgClient.unsafe(
    `SELECT i.id, i.title, i.start_date::text AS date, i.home_category AS "homeCategory", i.manual_status AS "manualStatus",
            i.is_automatic AS "isAutomatic", i.is_automatic_modified AS "isAutomaticModified",
            i.origin_field_key AS "originFieldKey", i.occurrence_nature AS "occurrenceNature", i.series_key AS "seriesKey",
            COALESCE(i.recurrence_json, (
              SELECT s.recurrence_json FROM agenda_items s
               WHERE s.account_id = i.account_id AND s.series_key = i.series_key AND s.recurrence_json IS NOT NULL
               ORDER BY s.id DESC LIMIT 1)) AS recurrence,
            ${col0223 ? 'i.business_type' : 'NULL::text'} AS "businessType",
            ${col0223 ? 'i.event_nature' : 'NULL::text'} AS "eventNature"
       FROM agenda_items i
       JOIN agenda_asset_links l ON l.agenda_item_id = i.id AND l.asset_id = $2
      WHERE i.account_id = $1 AND i.start_date IS NOT NULL AND (i.manual_status IS NULL OR i.manual_status = '')
      ORDER BY i.start_date LIMIT 500`,
    [accountId, assetId] as never[],
  )) as unknown as Array<Parameters<typeof toStatusItem>[0] & { eventNature: string | null }>;
  return rows
    .filter((r) => {
      const nature = r.eventNature ?? resolveEventSemantics({ originFieldKey: r.originFieldKey, businessType: r.businessType }).nature;
      return nature !== 'HISTORICAL';
    })
    .map(toStatusItem);
}

async function loadSourceProofs(accountId: number, assetId: number, sourceFileId: number): Promise<SourceProof[]> {
  const { fieldEvidenceCanonicalReady } = await import('@/services/ai/evidence/canonical-columns');
  const col0219 = await fieldEvidenceCanonicalReady();
  const rows = (await pgClient.unsafe(
    `SELECT e.field_key AS "fieldKey", ${col0219 ? 'e.canonical_key' : 'NULL::text'} AS "canonicalKey",
            e.normalized_value AS "normalizedValue", e.value_json AS "valueJson", e.evidence_excerpt AS excerpt,
            e.confidence, e.document_type AS "documentType", e.document_date AS "documentDate",
            ${col0219 ? 'e.semantic_event_type' : 'NULL::text'} AS "eventType",
            ${col0219 ? 'e.semantic_event_nature' : 'NULL::text'} AS "eventNature"
       FROM field_evidence e
       JOIN asset_files f ON f.id = e.source_id AND f.account_id = e.account_id AND f.deleted_at IS NULL
      WHERE e.account_id = $1 AND e.asset_id = $2 AND e.source_type IN ('document', 'web_link') AND e.source_id = $3
        ${col0219 ? `AND COALESCE(e.lifecycle_status, 'ACTIVE') = 'ACTIVE'
        AND (e.target_type IS NULL OR (e.target_type = 'ASSET' AND e.target_entity_id = $2))` : ''}
      LIMIT 500`,
    [accountId, assetId, sourceFileId] as never[],
  )) as unknown as Array<{
    fieldKey: string; canonicalKey: string | null; normalizedValue: string | null; valueJson: unknown; excerpt: string | null;
    confidence: string; documentType: string | null; documentDate: Date | string | null; eventType: string | null; eventNature: string | null;
  }>;
  return rows.map((r) => {
    const effet = getField(r.canonicalKey ?? r.fieldKey)?.agendaEffect;
    const documentDate = asDate(r.documentDate instanceof Date ? r.documentDate.toISOString() : r.documentDate);
    return {
      businessType: r.eventType ?? effet?.businessType ?? null,
      nature: r.eventNature ?? effet?.nature ?? null,
      excerpt: r.excerpt ?? '',
      confidence: (RANG_CONFIANCE[r.confidence] ? r.confidence : 'ambiguous') as CompletionEvidence['confidence'],
      documentType: r.documentType,
      documentDate,
      occurrenceDate: asDate(r.normalizedValue) ?? asDate(r.valueJson),
    };
  });
}

export interface StatusSyncEntry {
  itemId: number;
  decision: string;
  reasonCode: string;
  occurrenceMatch: OccurrenceMatch;
  applied: 'marked_done' | 'card' | 'none';
}

export interface StatusSyncReport {
  skipped?: 'NOT_ENABLED' | 'NO_PROOF';
  entries: StatusSyncEntry[];
}

/** La réconciliation de statut est-elle active ? (AI_T4_EFFECTS=enabled OU T4 master) */
export async function statusReconciliationActive(
  mode: RolloutMode = t4EffectsMode(),
  architecture?: PromptArchitecture,
): Promise<boolean> {
  if (mode === 'enabled') return true;
  const arch = architecture ?? await (await import('@/services/ai/config/config-resolver')).getPromptArchitecture('T4');
  return arch === 'master';
}

/**
 * Réconcilie le statut des échéances ouvertes d'un bien avec un document
 * (voir l'en-tête). Ne lève pas pour une échéance : chacune est isolée.
 */
export async function reconcileAgendaStatusForSource(p: {
  accountId: number;
  assetId: number;
  sourceFileId: number;
  userId?: number;
  mode?: RolloutMode;
  architecture?: PromptArchitecture;
}): Promise<StatusSyncReport> {
  const mode = p.mode ?? t4EffectsMode();
  if (!(await statusReconciliationActive(mode, p.architecture))) return { skipped: 'NOT_ENABLED', entries: [] };

  const proofs = await loadSourceProofs(p.accountId, p.assetId, p.sourceFileId);
  if (proofs.length === 0) return { skipped: 'NO_PROOF', entries: [] };
  const items = await loadOpenItems(p.accountId, p.assetId);

  const { matchOccurrence } = await import('@/services/ai/agenda/status-reconciler');
  const { reconcileStatus } = await import('@/services/ai/agenda/status-reconciliation.service');

  // Une preuve par type métier ne vaut que pour UNE occurrence : la mieux placée.
  const retenues = new Map<string, { item: ExistingAgendaItem; evidence: CompletionEvidence; rang: number; ecart: number }>();
  for (const item of items) {
    const evidence = evidenceForItem(item, proofs);
    if (!evidence) continue;
    const quand = evidence.occurrenceDate ?? evidence.documentDate;
    const m = matchOccurrence(item.date, quand, item.recurrence);
    if (m === 'none') continue;
    const ecart = quand ? Math.abs(quand.getTime() - Date.parse(`${item.date}T00:00:00Z`)) : Number.MAX_SAFE_INTEGER;
    const cur = retenues.get(item.businessType!);
    if (!cur || RANG_MATCH[m] > cur.rang || (RANG_MATCH[m] === cur.rang && ecart < cur.ecart)) {
      retenues.set(item.businessType!, { item, evidence, rang: RANG_MATCH[m], ecart });
    }
  }

  const entries: StatusSyncEntry[] = [];
  for (const { item, evidence } of retenues.values()) {
    try {
      const r = await reconcileStatus(item, evidence, {
        accountId: p.accountId, userId: p.userId, sourceFileId: p.sourceFileId, mode, architecture: p.architecture,
      });
      if (r.engine !== 'completion_v2') continue;
      const applied = await applyStatusDecision(p.accountId, item, r.decision, {
        sourceFileId: p.sourceFileId, reasonCode: r.reasonCode, occurrenceMatch: r.occurrenceMatch, mode,
      });
      entries.push({ itemId: item.id, decision: r.decision, reasonCode: r.reasonCode, occurrenceMatch: r.occurrenceMatch, applied });
    } catch (e) {
      const { isExecutionCancelled } = await import('@/services/ai/queue/execution-control');
      if (isExecutionCancelled(e)) throw e;
      console.error(`[agenda] réconciliation de statut de l'élément ${item.id} :`, (e as Error).message);
    }
  }
  console.info(JSON.stringify({
    event: 't4.status_sync', accountId: p.accountId, assetId: p.assetId, sourceFileId: p.sourceFileId, mode,
    entries: entries.map((x) => ({ itemId: x.itemId, decision: x.decision, reasonCode: x.reasonCode, applied: x.applied })),
  }));
  return { entries };
}

async function applyStatusDecision(
  accountId: number,
  item: ExistingAgendaItem,
  decision: string,
  ctx: { sourceFileId: number; reasonCode: string; occurrenceMatch: OccurrenceMatch; mode: RolloutMode },
): Promise<StatusSyncEntry['applied']> {
  if (decision === 'mark_done') {
    // Relecture : un statut posé entre-temps (utilisateur) n'est jamais écrasé.
    const [cur] = (await pgClient.unsafe(
      `SELECT manual_status AS s FROM agenda_items WHERE id = $1 AND account_id = $2`, [item.id, accountId] as never[],
    )) as unknown as Array<{ s: string | null }>;
    if (!cur || (cur.s && cur.s !== '')) return 'none';
    // Primitive (T4-09) : statut posé, document lié comme PREUVE (T4-07).
    const { upsertAgendaItem } = await import('./agenda-write-primitive');
    await upsertAgendaItem({
      itemId: item.id, accountId, assetId: null, origin: 'AUTOMATIC',
      sources: [{ fileId: ctx.sourceFileId, role: 'PROOF' }],
      details: { manualStatus: 'realise' },
    }, { mode: ctx.mode });
    const { recordOccurrenceEvent } = await import('./agenda-persistence');
    await recordOccurrenceEvent(item.id, accountId, 'STATUS_AUTO_COMPLETED', {
      manualStatus: 'realise', origin: 'AI', sourceFileId: ctx.sourceFileId,
      reasonCode: ctx.reasonCode, occurrenceMatch: ctx.occurrenceMatch,
    });
    const { closeAgendaStatusCards } = await import('@/services/to-process/agenda-status-cards');
    await closeAgendaStatusCards(accountId, item.id, 'OBSOLETE');
    return 'marked_done';
  }
  if (decision === 'propose_done' || decision === 'propose_not_done') {
    const { proposeAgendaStatus } = await import('@/services/to-process/agenda-status-cards');
    const res = await proposeAgendaStatus({ accountId, itemId: item.id, kind: decision, sourceFileId: ctx.sourceFileId });
    return res.status === 'SKIPPED' ? 'none' : 'card';
  }
  return 'none';
}
