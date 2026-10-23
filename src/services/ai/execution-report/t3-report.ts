/**
 * Rapport d'exécution T3 — lot 58C. Un rapport par réconciliation de bien
 * (`reconcileAsset`) ou d'entité (`reconcileEntity`).
 *
 * ÉCRITURES T3 (inventaire) : `writeCanonicalAssetField` / `writeCanonicalEntityFields`
 * (fiche + colonnes miroirs + journal `canonical_field_writes` DANS la même
 * transaction + `ai_field_updates`), clé hors registre → `assets.key_characteristics`
 * + `ai_field_updates`, retraits (réconciliation négative), conflits
 * (`writeConflict` → « À arbitrer »), journal `reconciliation_runs` /
 * `reconciliation_decisions`, cartes « À traiter » (pont). Phases compte :
 * `t3_open_action_evaluations`, `account_reconciliation_runs.phases_json`.
 *
 * CONFIRMATION : une écriture est `WRITTEN` seulement si la primitive a rendu
 * `written` ET que le journal transactionnel (clé du registre) ou la relecture
 * de la fiche (clé hors registre) le confirme. Une décision `apply`/`update`
 * sans cette confirmation est `DECIDED_NOT_CONFIRMED` ; une exception est
 * `FAILED`. Les compteurs `decisionsApplied` / `objectsModified` reposent sur
 * les mêmes écritures confirmées.
 */
import { pgClient } from '@/db';
import { currentJobContext } from '../queue/job-context';
import {
  errorText, normalizeT3Reason, reportStatus, T3_NOT_WRITTEN_LABEL, T1_PROJECTION_REASON, valueTypeOf,
  type ReportEntry, type ReportStep,
} from './model';
import { latestT1ReportFor, writeExecutionReport } from './repository';
import type { EvidenceCandidate, ReconciliationDecision, CurrentValue } from '../reconciliation/types';
import { checkSummary } from '../reconciliation/information-check/engine-steps';
import type { CrossRecord, InventoryLine } from '../reconciliation/information-check/inventory';

type Row = Record<string, unknown>;

export interface T3FieldRecord {
  fieldKey: string;
  current: CurrentValue | null;
  candidates: EvidenceCandidate[];
  decision: ReconciliationDecision;
  /** Résultat de la primitive d'écriture (décision apply / update / retrait). */
  outcome?: string | null;
  error?: string | null;
  retraction?: boolean;
  /** Clé du registre (journal 0216) ou clé hors registre (key_characteristics). */
  registry?: boolean;
}

export class T3ExecutionRecorder {
  readonly startedAt = new Date();
  readonly fields: T3FieldRecord[] = [];
  readonly steps: ReportStep[] = [];
  failure: string | null = null;
  aiCalls = 0;
  /** Lot 76J : inventaire exhaustif des champs de l'onglet « Informations » (vides compris). */
  inventory: import('../reconciliation/information-check/inventory').InformationInventory | null = null;
  /** Lot 76J : confrontations transversales (agenda, Opérations, colonnes miroirs). */
  readonly cross: import('../reconciliation/information-check/inventory').CrossRecord[] = [];
  constructor(readonly traceId: string) {}
  ok(step: string, detail?: Record<string, unknown>): void { this.steps.push({ step, status: 'OK', error: null, detail: detail ?? null }); }
  fail(step: string, e: unknown): void { this.steps.push({ step, status: 'FAILED', error: errorText(e) }); }
  /** Écritures CONFIRMÉES par la primitive (contrôlées ensuite par relecture). */
  get writtenCount(): number { return this.fields.filter((f) => f.outcome === 'written' && !f.error).length; }
}

const n = (v: unknown) => (v == null ? null : Number(v));

/** Construit les lignes par relecture (exporté pour les tests). */
export async function buildT3Entries(rec: T3ExecutionRecorder, p: {
  accountId: number; assetId: number; target?: { type: 'EQUIPMENT' | 'ROOM'; id: number } | null; sourceFileId?: number | null;
}): Promise<{ entries: ReportEntry[]; readSteps: ReportStep[]; sources: Record<string, unknown>; counters: Record<string, number> }> {
  const readSteps: ReportStep[] = [];
  const entries: ReportEntry[] = [];
  const ac = p.accountId;
  const safe = async (label: string, sql: string, params: unknown[]): Promise<Row[] | null> => {
    try { return (await pgClient.unsafe(sql, params as never[])) as unknown as Row[]; } catch (e) {
      readSteps.push({ step: `RELECTURE_${label}`, status: 'FAILED', error: errorText(e) });
      return null;
    }
  };

  // Journal transactionnel des écritures de ce passage (même trace).
  const journal = await safe('JOURNAL', `SELECT id, canonical_key, old_value, new_value, outcome, mirror_columns, target_type, target_id
      FROM canonical_field_writes WHERE account_id = $1 AND trace_id = $2 ORDER BY id`, [ac, rec.traceId]);
  const byKey = new Map<string, Row>();
  for (const r of journal ?? []) byKey.set(String(r.canonical_key), r);

  // Preuves citées par les décisions (document source, extrait, run T1).
  const evidenceIds = [...new Set(rec.fields.flatMap((f) => f.decision.evidenceIds))];
  const ev = evidenceIds.length ? await safe('EVIDENCE', `SELECT id, source_id, source_type, evidence_excerpt, analysis_run_id, confidence, value_json, lifecycle_status
      FROM field_evidence WHERE account_id = $1 AND id = ANY($2::int[])`, [ac, evidenceIds]) : [];
  const evById = new Map((ev ?? []).map((r) => [Number(r.id), r]));
  const runIds = [...new Set((ev ?? []).map((r) => n(r.analysis_run_id)).filter((x): x is number => x != null))];
  const t1ByRun = new Map<number, number>();
  if (runIds.length) {
    for (const r of (await safe('T1_REPORTS', `SELECT DISTINCT ON (analysis_run_id) analysis_run_id, id FROM ai_execution_reports
        WHERE account_id = $1 AND treatment = 'T1' AND analysis_run_id = ANY($2::int[]) ORDER BY analysis_run_id, id DESC`, [ac, runIds])) ?? []) {
      t1ByRun.set(Number(r.analysis_run_id), Number(r.id));
    }
  }

  // Clé hors registre : la fiche relue confirme la valeur écrite.
  let kc: Record<string, unknown> | null = null;
  if (rec.fields.some((f) => f.registry === false && f.outcome === 'written') && !p.target) {
    const a = await safe('ASSET', `SELECT key_characteristics FROM assets WHERE id = $1 AND account_id = $2`, [p.assetId, ac]);
    try { kc = a?.[0]?.key_characteristics ? JSON.parse(String(a[0].key_characteristics)) as Record<string, unknown> : {}; } catch { kc = {}; }
  }

  const location = (key: string, registry: boolean | undefined, mirrors: unknown): string => {
    const base = p.target ? `${p.target.type === 'EQUIPMENT' ? 'équipement' : 'pièce'} #${p.target.id} · clé ${key}` : `assets.key_characteristics.${key}`;
    const m = mirrors && typeof mirrors === 'object' ? Object.keys(mirrors as object) : [];
    return registry === false || m.length === 0 ? base : `${base} + colonnes ${m.join(', ')}`;
  };

  for (const f of rec.fields) {
    const d = f.decision;
    const best = d.evidenceIds[0] != null ? evById.get(d.evidenceIds[0]) : undefined;
    const runId = best ? n(best.analysis_run_id) : null;
    const links: Record<string, unknown> = {
      decision: d.action, reasonCode: d.reasonCode, deterministic: d.deterministic, confidence: d.confidence,
      currentOrigin: f.current?.origin ?? null, retraction: f.retraction ?? false, outcome: f.outcome ?? null,
      evidence: best ? {
        id: Number(best.id), sourceFileId: n(best.source_id), sourceType: best.source_type, excerpt: best.evidence_excerpt,
        analysisRunId: runId, confidence: best.confidence, lifecycle: best.lifecycle_status,
      } : null,
      t1ReportId: runId != null ? t1ByRun.get(runId) ?? null : null,
      candidates: f.candidates.map((c) => ({ evidenceId: c.evidenceId, value: c.value, confidence: c.confidence, authority: c.authorityScore, sourceId: c.sourceId, documentDate: c.documentDate })),
      // Lot 81A : toutes les valeurs proposées d'un conflit (aucune masquée).
      ...(d.alternatives?.length ? { alternatives: d.alternatives.map((a) => ({ value: a.value, evidenceIds: a.evidenceIds, authority: a.sourcePriority ?? null })) } : {}),
    };
    const isWrite = d.action === 'apply' || d.action === 'update';
    const j = byKey.get(f.fieldKey);
    let writeResult: ReportEntry['writeResult'];
    let value: unknown = d.proposedValue;
    let reasonCode: string | null = d.reasonCode;
    let reason: string | null = null;
    let recordId: string | null = null;
    if (f.error) {
      writeResult = 'FAILED'; reasonCode = 'WRITE_REFUSED_OR_FAILED'; reason = `${T3_NOT_WRITTEN_LABEL.WRITE_REFUSED_OR_FAILED} : ${f.error}`;
    } else if (isWrite && f.outcome === 'written') {
      const confirmed = f.registry === false
        ? kc !== null && JSON.stringify(kc[f.fieldKey] ?? null) === JSON.stringify(f.retraction ? null : d.proposedValue ?? null)
        : j?.outcome === 'written';
      if (confirmed) {
        writeResult = 'WRITTEN';
        value = f.registry === false ? (kc?.[f.fieldKey] ?? null) : j?.new_value ?? null;
        recordId = j ? String(j.id) : null;
      } else {
        writeResult = 'DECIDED_NOT_CONFIRMED';
        reason = 'Écriture annoncée par la primitive, non retrouvée à la relecture (journal / fiche)';
      }
    } else {
      const motif = normalizeT3Reason({ action: d.action, reasonCode: d.reasonCode, outcome: f.outcome, candidateCount: f.candidates.length });
      writeResult = 'NOT_WRITTEN';
      reasonCode = motif;
      reason = `${T3_NOT_WRITTEN_LABEL[motif]} (${d.reasonCode}${f.outcome ? ` · écriture : ${f.outcome}` : ''})`;
    }
    entries.push({
      section: 'FIELD', tableName: j ? 'canonical_field_writes' : (f.registry === false ? (p.target ? null : 'assets') : null),
      recordId, columnPath: location(f.fieldKey, f.registry, j?.mirror_columns), fieldKey: f.fieldKey,
      entityType: p.target?.type ?? 'ASSET', entityId: p.target?.id ?? p.assetId,
      oldValue: f.current?.value ?? d.currentValue ?? null, value, valueType: valueTypeOf(value),
      recordStatus: j ? String(j.outcome) : null, writeResult, reasonCode, reason, links,
    });
  }

  entries.push(...informationEntries(rec, p));

  // Données pertinentes NON examinées : faits canoniques des documents du bien sans preuve projetée.
  const examined = rec.fields.map((f) => f.fieldKey);
  const sources: Record<string, unknown> = {
    fieldEvidence: { consulted: true, evidenceCited: evidenceIds.length },
    currentValues: { consulted: true },
    canonicalFacts: { consulted: 'indirect', note: 'via les preuves projetées par T1 (field_evidence)' },
    aiCalls: rec.aiCalls,
  };
  if (!p.target) {
    const docs = `(SELECT id FROM asset_files WHERE account_id = $1 AND asset_id = $2 AND deleted_at IS NULL
                   UNION SELECT file_id FROM document_asset_links WHERE account_id = $1 AND asset_id = $2 AND removed_at IS NULL)`;
    const pending = await safe('NOT_EXAMINED', `SELECT f.id, f.file_id, f.canonical_key, f.value_text, f.value_number, f.target_type, f.target_entity_id, f.excerpt
        FROM document_facts f
       WHERE f.account_id = $1 AND f.status = 'active' AND f.canonical_key IS NOT NULL AND f.file_id IN ${docs}
         AND NOT (f.canonical_key = ANY($3::text[]))
         AND (f.target_entity_id IS NULL OR f.target_type IS DISTINCT FROM 'ASSET' OR f.target_entity_id = $2)
       ORDER BY f.file_id, f.id`, [ac, p.assetId, examined]);
    // Faits GÉNÉRIQUES du document déclencheur : lus par T1, jamais un champ de fiche —
    // c'est la cause la plus fréquente d'une information « absente de la fiche ».
    const generiques = p.sourceFileId ? await safe('GENERIC_FACTS', `SELECT id, file_id, fact_key, raw_key, label, value_text, value_number, target_type, target_entity_id, excerpt
        FROM document_facts WHERE account_id = $1 AND file_id = $2 AND status = 'active' AND canonical_key IS NULL ORDER BY id`, [ac, p.sourceFileId]) : [];
    const files = [...new Set([...(pending ?? []), ...(generiques ?? [])].map((r) => Number(r.file_id)))];
    const t1Reasons = new Map<string, { code: string | null; reason: string | null; reportId: number }>();
    if (files.length) {
      for (const r of (await safe('T1_PROJECTION', `SELECT DISTINCT ON (r.file_id, e.field_key) r.file_id, r.id AS report_id, e.field_key, e.reason_code, e.reason
          FROM ai_execution_reports r JOIN ai_execution_report_entries e ON e.report_id = r.id AND e.account_id = r.account_id
         WHERE r.account_id = $1 AND r.treatment = 'T1' AND r.file_id = ANY($2::int[]) AND e.section = 'PROJECTION'
         ORDER BY r.file_id, e.field_key, r.id DESC`, [ac, files])) ?? []) {
        t1Reasons.set(`${r.file_id}|${r.field_key}`, { code: (r.reason_code as string | null) ?? null, reason: (r.reason as string | null) ?? null, reportId: Number(r.report_id) });
      }
    }
    for (const r of pending ?? []) {
      const t1 = t1Reasons.get(`${r.file_id}|${r.canonical_key}`);
      entries.push({
        section: 'NOT_EXAMINED', tableName: 'document_facts', recordId: String(r.id), columnPath: 'value_text',
        fieldKey: String(r.canonical_key), entityType: (r.target_type as string | null) ?? null, entityId: n(r.target_entity_id),
        value: r.value_text ?? (r.value_number == null ? null : Number(r.value_number)), writeResult: 'NOT_EXAMINED',
        reasonCode: t1?.code ?? 'NO_ACTIVE_EVIDENCE_ON_ASSET',
        reason: t1 ? `Aucune preuve projetée par T1 : ${t1.reason ?? T1_PROJECTION_REASON[t1.code ?? ''] ?? t1.code}` : 'Fait canonique d’un document du bien sans preuve active sur ce bien : T3 ne l’examine pas (non tracé côté T1)',
        links: { sourceFileId: Number(r.file_id), excerpt: r.excerpt, t1ReportId: t1?.reportId ?? null },
      });
    }
    for (const r of generiques ?? []) {
      const key = String(r.raw_key ?? r.fact_key);
      const t1 = t1Reasons.get(`${r.file_id}|${key}`);
      entries.push({
        section: 'NOT_EXAMINED', tableName: 'document_facts', recordId: String(r.id), columnPath: 'value_text',
        fieldKey: key, label: (r.label as string | null) ?? null, entityType: (r.target_type as string | null) ?? null, entityId: n(r.target_entity_id),
        value: r.value_text ?? (r.value_number == null ? null : Number(r.value_number)), writeResult: 'NOT_EXAMINED',
        reasonCode: 'GENERIC_KNOWLEDGE', reason: `Information lue par T1 sans clé canonique : ${T1_PROJECTION_REASON.GENERIC_KNOWLEDGE}`,
        links: { sourceFileId: Number(r.file_id), excerpt: r.excerpt, factKey: r.fact_key, t1ReportId: t1?.reportId ?? null },
      });
    }
    const counts = await safe('KNOWLEDGE_COUNTS', `SELECT
        (SELECT count(*)::int FROM document_facts f WHERE f.account_id = $1 AND f.status = 'active' AND f.canonical_key IS NULL AND f.file_id IN ${docs}) AS generic,
        (SELECT count(*)::int FROM document_unresolved_facts u WHERE u.account_id = $1 AND u.file_id IN ${docs}) AS unresolved,
        (SELECT count(*)::int FROM document_source_units s WHERE s.account_id = $1 AND s.file_id IN ${docs}) AS units`, [ac, p.assetId]);
    const k = counts?.[0];
    sources.genericFacts = { consulted: false, available: k?.generic ?? null, note: 'hors périmètre du moteur de fiche : repris par la phase « connaissance ouverte » du passage T3 du compte' };
    sources.unresolvedFacts = { consulted: false, available: k?.unresolved ?? null, note: 'phase « connaissance ouverte » du passage T3 du compte' };
    sources.sourceUnits = { consulted: false, available: k?.units ?? null, note: 'T3 ne relit jamais les documents' };
    sources.rawExtractions = { consulted: false, note: 'T3 ne relit jamais les documents' };
    sources.notExaminedFacts = (pending ?? []).length;
  }

  // Lot 76J : synthèse du contrôle exhaustif (champs examinés, non applicables,
  // complétés, corrigés, contradictions, arbitrages, non vérifiables, échecs).
  const synthese = rec.inventory ? checkSummary(rec) : null;
  const counters: Record<string, number> = {
    ...(synthese ?? {}),
    examined: synthese ? synthese.examined : rec.fields.length,
    written: entries.filter((e) => e.section === 'FIELD' && e.writeResult === 'WRITTEN').length,
    notWritten: entries.filter((e) => e.writeResult === 'NOT_WRITTEN').length,
    failed: entries.filter((e) => e.writeResult === 'FAILED').length,
    decidedNotConfirmed: entries.filter((e) => e.writeResult === 'DECIDED_NOT_CONFIRMED').length,
    notExamined: entries.filter((e) => e.writeResult === 'NOT_EXAMINED').length,
    conflicts: rec.fields.filter((f) => f.decision.action === 'create_conflict').length,
    decisionsIntended: rec.fields.filter((f) => f.decision.action === 'apply' || f.decision.action === 'update').length,
  };
  return { entries, readSteps, sources, counters };
}

const INVENTORY_REASON: Record<InventoryLine['status'], { code: string; reason: string } | null> = {
  EVIDENCE: null,
  NO_EVIDENCE_EMPTY: { code: 'NO_EXPLOITABLE_INFO', reason: 'Non vérifiable : champ vide, aucune preuve exploitable (aucune carte « À traiter »)' },
  NO_EVIDENCE_FILLED: { code: 'NO_EXPLOITABLE_INFO', reason: 'Non vérifiable : valeur en place conservée, aucune preuve exploitable' },
  INPUT_ONLY: { code: 'INPUT_ONLY_FIELD', reason: 'Champ de saisie seule : jamais inféré ni modifié par T3' },
  NOT_APPLICABLE: { code: 'FIELD_NOT_APPLICABLE', reason: 'Champ sans objet pour la catégorie de ce bien' },
};

const CROSS_REASON: Record<CrossRecord['verdict'], string> = {
  CONSISTENT: 'Concordant avec la fiche',
  DERIVED_FROM_FIELD: 'Reflet de la fiche (projection) : ni preuve ni contradiction',
  AGENDA_UNCONFIRMED_NOT_RETAINED: 'Événement automatique non confirmé divergent : non retenu (la date de l’agenda n’est pas une preuve)',
  OPERATION_NOT_RETAINED: 'Opération divergente : non retenue sans preuve du champ',
  CONFIRMED_FILL: 'Achat confirmé par l’utilisateur : champ vide complété',
  CONFIRMED_AGENDA_CONTRADICTION: 'Achat confirmé par l’utilisateur contredit par la fiche : arbitrage',
  CONFIRMED_AMBIGUOUS: 'Plusieurs achats confirmés de dates différentes : abstention',
  ALREADY_ARBITRATED: 'Même contradiction déjà tranchée par l’utilisateur : non reproposée',
  MIRROR_DIVERGENCE: 'Colonne historique différente de la fiche (signalée, jamais corrigée d’office)',
};

/** Lot 76J — lignes de l'inventaire exhaustif et des confrontations (pure, exportée pour les tests). */
export function informationEntries(rec: T3ExecutionRecorder, p: { assetId: number; target?: { type: 'EQUIPMENT' | 'ROOM'; id: number } | null }): ReportEntry[] {
  const out: ReportEntry[] = [];
  const entityType = p.target?.type ?? 'ASSET';
  const entityId = p.target?.id ?? p.assetId;
  for (const l of rec.inventory?.lines ?? []) {
    const motif = INVENTORY_REASON[l.status];
    if (!motif) continue;
    out.push({
      section: l.status === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' : 'FIELD', tableName: null, recordId: null,
      columnPath: p.target ? `${p.target.type === 'EQUIPMENT' ? 'équipement' : 'pièce'} #${p.target.id} · clé ${l.key}` : `assets.key_characteristics.${l.key}`,
      fieldKey: l.key, label: l.label, entityType, entityId,
      oldValue: l.current?.value ?? null, value: l.current?.value ?? null, valueType: valueTypeOf(l.current?.value ?? null),
      writeResult: l.status === 'NOT_APPLICABLE' ? 'NOT_EXAMINED' : 'NOT_WRITTEN',
      reasonCode: motif.code, reason: motif.reason,
      links: { inventory: l.status, section: l.section, freeText: l.freeText, currentOrigin: l.current?.origin ?? null },
    });
  }
  for (const i of rec.inventory?.identity ?? []) {
    out.push({
      section: 'IDENTITY', tableName: 'assets', recordId: String(p.assetId), columnPath: `assets.${i.key}`, fieldKey: i.key,
      entityType, entityId, value: i.value, valueType: valueTypeOf(i.value), writeResult: 'OBSERVED',
      reasonCode: 'IDENTITY_COLUMN', reason: 'Colonne d’identité examinée : règle métier séparée, jamais modifiée par T3', links: null,
    });
  }
  for (const c of rec.cross) {
    const ref = c.source === 'AGENDA' ? { agendaItemId: c.refId } : c.source === 'OPERATION' ? { operationId: c.refId } : { column: c.refId };
    out.push({
      section: 'CROSS_SOURCE', tableName: c.source === 'AGENDA' ? 'agenda_items' : c.source === 'OPERATION' ? 'business_operations' : 'assets',
      recordId: c.refId == null ? null : String(c.refId), columnPath: null, fieldKey: c.fieldKey, entityType, entityId,
      value: c.value, valueType: valueTypeOf(c.value), writeResult: 'OBSERVED', reasonCode: c.verdict, reason: CROSS_REASON[c.verdict],
      links: { source: c.source, ...ref, confirmed: c.confirmed, independent: c.independent, sharedSourceFileIds: c.sharedSourceFileIds, contradiction: c.contradiction },
    });
  }
  return out;
}

/** Écrit le rapport T3 d'un bien / d'une entité. Ne lève JAMAIS. */
export async function writeT3Report(rec: T3ExecutionRecorder, p: {
  accountId: number; assetId: number; target?: { type: 'EQUIPMENT' | 'ROOM'; id: number } | null;
  reconciliationRunId?: number | null; accountRunId?: number | null; sourceFileId?: number | null; triggeredBy?: string | null;
}): Promise<number | null> {
  try {
    const ctx = currentJobContext();
    let built: Awaited<ReturnType<typeof buildT3Entries>>;
    try { built = await buildT3Entries(rec, p); } catch (e) {
      built = { entries: [], readSteps: [{ step: 'RELECTURE', status: 'FAILED', error: errorText(e) }], sources: {}, counters: {} };
    }
    const steps = [...rec.steps, ...(rec.failure ? [{ step: 'RECONCILIATION', status: 'FAILED' as const, error: rec.failure }] : []), ...built.readSteps];
    const origin = p.sourceFileId ? await latestT1ReportFor(p.accountId, p.sourceFileId).catch(() => null) : null;
    return await writeExecutionReport({
      accountId: p.accountId, treatment: 'T3', scope: p.target?.type ?? 'ASSET',
      jobId: ctx?.jobId ?? null, jobAttempt: ctx?.jobAttempt ?? null, traceIds: [rec.traceId],
      fileId: p.sourceFileId ?? null, assetId: p.assetId, targetType: p.target?.type ?? 'ASSET', targetId: p.target?.id ?? p.assetId,
      reconciliationRunId: p.reconciliationRunId ?? null, accountRunId: p.accountRunId ?? null,
      triggerCode: ctx?.triggerCode ?? p.triggeredBy ?? null, originT1ReportId: origin,
      status: reportStatus({ failed: rec.failure !== null, entries: built.entries.filter((e) => e.section === 'FIELD'), steps, treatment: 'T3' }),
      counters: built.counters, steps, sources: { ...built.sources, triggeredBy: p.triggeredBy ?? null }, startedAt: rec.startedAt,
    }, built.entries);
  } catch (e) {
    console.error(`[execution-report] rapport T3 du bien ${p.assetId} non écrit :`, errorText(e));
    return null;
  }
}
