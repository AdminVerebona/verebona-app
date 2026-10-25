/**
 * Lot 77C — traçabilité d'un MONTANT jusqu'à sa source :
 * Document → Extraction IA → Décision → Enregistrement → Rapprochement →
 * Calcul → Affichage.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUNE PROVENANCE INVENTÉE
 *
 * Chaque étape cite les lignes PERSISTÉES qui la fondent :
 *   · ligne TCO (`readAssetTco` : `lines`, `entries`) et affichage
 *     (`tcoUserView`, même règle que la fiche du bien) ;
 *   · composante `business_operation_financial_components` → ses sources
 *     (`business_operation_financial_component_sources` →
 *     `business_operation_sources` : document, rôle, autorité, méthode de
 *     rapprochement) → candidat T1 désigné par `source_version` (`c<id>|…`,
 *     consolidateur T3) → indices financiers du candidat → fait
 *     `document_facts` désigné par `payload.financialHints[].evidence.factId`
 *     (persisté par T1) → extraction (`document_extractions` : modèle,
 *     version de prompt, trace) → rapports d'exécution T1 et appels IA ;
 *   · décision T3 : issue du candidat (`t3_outcome`, `t3_reason`,
 *     `t3_detail`), historique `business_operation_history`, décisions de
 *     rapprochement `business_operation_match_decisions`.
 *
 * Lot 81C : aucune borne sur les lignes citées par une étape (rapports T1,
 * appels IA, historique, décisions, liens, écritures, preuves, faits,
 * cartes, documents sources) — toutes celles conservées sont exportées.
 *
 * Le lien composante → indice T1 n'est pas persisté : les indices du
 * candidat sont TOUS exportés et ceux de même montant et devise sont
 * signalés « correspondance de valeur » (jamais présentés comme le lien
 * réel). Toute étape sans trace est « non disponible », motif à l'appui.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { DiagQuery } from '@/services/business-operations/diagnostics/service';
import type { TcoEconomicLine, TcoResult } from '@/services/business-operations/tco/model';
import {
  candidateIdFromSourceVersion, finalizeTrace, parseLineId, step,
  type AmountTrace, type TraceRef, type TraceStep, type TraceValues,
} from './model';

type Row = Record<string, unknown>;

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

/** Lignes en JSON PostgreSQL (dates ISO, numeric en nombre, BIGINT fidèle). */
export async function jsonRows(q: DiagQuery, sql: string, params: unknown[]): Promise<Row[]> {
  const rows = await q(`SELECT row_to_json(t) AS r FROM (${sql}) t`, params);
  return rows.map((x) => (typeof x.r === 'string' ? JSON.parse(x.r) : x.r) as Row);
}
async function oneRow(q: DiagQuery, sql: string, params: unknown[]): Promise<Row | null> {
  return (await jsonRows(q, sql, params))[0] ?? null;
}

// ── Contexte TCO d'un bien ──────────────────────────────────────────────────

export interface TcoContext {
  assetId: number;
  result: TcoResult | null;
  /** Motif d'indisponibilité du calcul (bien supprimé, erreur). */
  unavailable: string | null;
  /** Lignes visibles sur la fiche et lignes masquées (motif), règle `tcoUserView`. */
  visible: Set<string>;
  hidden: Record<string, string>;
}

/** TCO recalculé en lecture par le moteur existant (aucun second calcul). */
export async function loadTcoContext(accountId: number, assetId: number, today?: string, runner?: { execute: (q: import('drizzle-orm').SQL) => Promise<unknown> }): Promise<TcoContext> {
  const [{ readAssetTco, AssetNotFoundForTcoError }, { tcoUserView, TCO_HIDDEN_REASON_LABELS }] = await Promise.all([
    import('@/services/business-operations/tco/service'),
    import('@/services/business-operations/tco/dto'),
  ]);
  try {
    // Lot 82E : `runner` facultatif — lecture dans l'instantané de l'export (session 81C).
    const result = await readAssetTco(accountId, assetId, { ...(today ? { today } : {}), ...(runner ? { runner } : {}) });
    const view = tcoUserView(result.lines);
    const hidden: Record<string, string> = {};
    for (const [id, r] of Object.entries(view.hidden)) hidden[id] = `${r} — ${TCO_HIDDEN_REASON_LABELS[r as keyof typeof TCO_HIDDEN_REASON_LABELS] ?? r}`;
    return { assetId, result, unavailable: null, visible: new Set(view.lines.map((l) => l.id)), hidden };
  } catch (e) {
    const motif = e instanceof AssetNotFoundForTcoError ? 'bien supprimé ou introuvable : TCO non calculé' : `calcul TCO impossible (${(e as Error)?.message?.slice(0, 120) ?? 'erreur'})`;
    return { assetId, result: null, unavailable: motif, visible: new Set(), hidden: {} };
  }
}

/** Résumé exportable du TCO (sans la trace complète `entries`, rattachée ligne par ligne). */
export function tcoSummary(ctx: TcoContext): Row {
  if (!ctx.result) return { assetId: ctx.assetId, disponible: false, motif: ctx.unavailable };
  const { entries: _e, lines, ...rest } = ctx.result;
  void _e;
  return { disponible: true, ...rest, assetId: ctx.assetId, lignes: lines.length };
}

function calcSteps(ctx: TcoContext | null, line: TcoEconomicLine | null, motifAbsent: string): { calc: TraceStep; display: TraceStep; calculee: unknown; affichee: unknown } {
  if (!ctx || !ctx.result) {
    const m = ctx?.unavailable ?? motifAbsent;
    return { calc: step('CALCUL', 'non_disponible', [], undefined, m), display: step('AFFICHAGE', 'non_disponible', [], undefined, m), calculee: null, affichee: null };
  }
  if (!line) {
    return {
      calc: step('CALCUL', 'non_disponible', [], undefined, motifAbsent),
      display: step('AFFICHAGE', 'sans_objet', [], undefined, 'aucune ligne TCO : rien n’est affiché pour ce montant sur la fiche du bien'),
      calculee: null, affichee: null,
    };
  }
  const entries = ctx.result.entries.filter((e) => (line.id.startsWith('c:') ? `c:${e.componentId}` === line.id : e.lineId === line.id));
  const calc = step('CALCUL', 'disponible', [{ table: 'tco.lines', id: line.id }], {
    moteur: 'readAssetTco / computeTco (recalcul en lecture)',
    categorie: line.category, statut: line.status, motif: line.reason, eurCents: line.eurCents, retenuCents: line.includedCents,
    incertain: line.uncertain ?? false, montantInconnu: line.amountUnknown ?? false, note: line.note, relatedFileId: line.relatedFileId,
    // Lot 78B (§3) : justificatifs qui portent CE montant, ligne comptée à sa place (doublon présumé).
    justificatifsDuMontant: line.sourceFileIds ?? (line.fileId != null ? [line.fileId] : []), doublonDe: line.duplicateOf ?? null,
    // Lot 80A : décision de l'utilisateur « Ajouter / Retirer du TCO » (clé stable, geste, date, auteur, résultat automatique remplacé).
    cleStable: line.decisionKey ?? null,
    decisionUtilisateur: line.userDecision
      ? { ...line.userDecision, effet: line.userDecision.applied ? 'appliquée (prioritaire sur la règle automatique)' : 'sans effet (résultat automatique identique)' }
      : null,
    transformations: entries.map((e) => ({ ...e })),
  });
  const visible = ctx.visible.has(line.id);
  const display = step('AFFICHAGE', 'disponible', [{ table: 'tco.userView', id: line.id }], {
    ecran: 'Fiche du bien › Coût de possession (droit Premium / Premium Duo / essai)',
    visible, motifMasquage: visible ? null : (ctx.hidden[line.id] ?? 'ligne non transmise à l’interface'),
  });
  return { calc, display, calculee: { eurCents: line.eurCents, retenuCents: line.includedCents, statut: line.status }, affichee: visible ? { retenuCents: line.includedCents } : null };
}

// ── Briques de lecture (colonnes listées : liste blanche) ───────────────────

const DOC_COLS = `id, asset_id, linked_asset_id, equipment_id, substructure_id, retained_title, document_type_code, rubric_code, type_origin,
  document_date, amount_cents, supplier, analysis_state, last_analysis_at, uploaded_at, deleted_at, grouped_into_file_id`;
const CAND_COLS = `id, file_id, extraction_id, analysis_run_id, candidate_key, established, confidence, type_hint, status_hint, summary,
  payload->>'provider' AS provider, payload->>'contract' AS contract, payload->'financialHints' AS financial_hints, payload->'targetHints' AS target_hints,
  payload->'evidenceFactIds' AS evidence_fact_ids, status, superseded_at, created_at, trigger_code,
  t3_pending, t3_processed_at, t3_outcome, t3_reason, t3_operation_id, t3_detail`;
const EXTR_COLS = `id, file_id, analysis_run_id, engine, source_version, document_date, supplier_name, amount_cents, currency, document_type_code,
  provider, model, prompt_version, operation_trace_id, fact_count, full_text_chars, extracted_at`;
const FACT_COLS = `id, file_id, extraction_id, fact_key, canonical_key, label, value_number, value_text, value_unit, normalized_value, raw_value,
  confidence, excerpt, location, provider, model, prompt_version, status, created_at`;
export const REPORT_COLS = `id, treatment, scope, status, report_complete, report_error, trigger_code, job_id, job_attempt, trace_ids, file_id, asset_id,
  target_type, target_id, analysis_run_id, extraction_id, reconciliation_run_id, origin_t1_report_id, entry_count, entries_report_id, counters, schema_version, started_at, created_at`;
export const USAGE_COLS = `id, created_at, account_id, user_id, asset_file_id, operation_type, use_case_code, operation_code, task, provider, model, model_rank,
  status, error_code, error_message, is_fallback, is_billable, input_tokens AS entree_jetons, output_tokens AS sortie_jetons,
  cost_micros, duration_ms, environment, pipeline_version, app_version, config_version_id, job_id, master_prompt_code, master_prompt_version,
  metadata->>'traceId' AS trace_id, metadata->>'promptVersion' AS prompt_version, metadata->>'callKind' AS call_kind,
  (metadata->>'repaired')::boolean AS repaired, metadata->'failure' AS failure`;

async function documentRow(q: DiagQuery, A: number, fileId: number): Promise<Row | null> {
  return oneRow(q, `SELECT ${DOC_COLS} FROM asset_files WHERE id = $1 AND account_id = $2`, [fileId, A]);
}

/** Extraction T1 + appels IA corrélés (trace) + rapports T1 du document. */
async function extractionBundle(q: DiagQuery, A: number, fileId: number, extractionId: number | null): Promise<{ extraction: Row | null; reports: Row[]; calls: Row[] }> {
  const extraction = await oneRow(q, `SELECT ${EXTR_COLS} FROM document_extractions WHERE account_id = $1 AND ${extractionId ? 'id = $2' : 'file_id = $2'}`, [A, extractionId ?? fileId]);
  const reports = await jsonRows(q, `SELECT ${REPORT_COLS} FROM ai_execution_reports WHERE account_id = $1 AND treatment = 'T1' AND file_id = $2 ORDER BY id DESC`, [A, fileId]);
  const traces = [...new Set([extraction?.operation_trace_id, ...reports.flatMap((r) => (Array.isArray(r.trace_ids) ? r.trace_ids : []))].filter((t): t is string => typeof t === 'string' && t.length > 0))];
  const calls = traces.length
    ? await jsonRows(q, `SELECT ${USAGE_COLS} FROM ai_usage_event WHERE account_id = $1 AND metadata->>'traceId' = ANY($2::text[]) ORDER BY id`, [A, traces])
    : [];
  return { extraction, reports, calls };
}

function extractionStep(b: { extraction: Row | null; reports: Row[]; calls: Row[] }, facts: Row[], extra: Record<string, unknown> = {}, motifSansFait?: string): TraceStep {
  const refs: TraceRef[] = [];
  if (b.extraction) refs.push({ table: 'document_extractions', id: Number(b.extraction.id) });
  for (const f of facts) refs.push({ table: 'document_facts', id: Number(f.id) });
  for (const r of b.reports) refs.push({ table: 'ai_execution_reports', id: Number(r.id) });
  for (const c of b.calls) refs.push({ table: 'ai_usage_event', id: Number(c.id) });
  const donnees = {
    ...extra,
    extraction: b.extraction,
    faits: facts,
    modele: b.extraction ? { fournisseur: b.extraction.provider ?? null, modele: b.extraction.model ?? null, versionPrompt: b.extraction.prompt_version ?? null, trace: b.extraction.operation_trace_id ?? null } : null,
    rapportsT1: b.reports,
    appelsIA: b.calls,
  };
  if (!b.extraction) return step('EXTRACTION_IA', 'non_disponible', refs, donnees, 'aucune extraction T1 conservée pour ce document');
  const manques = [
    facts.length ? null : (motifSansFait ?? 'fait extrait non disponible'),
    b.extraction.model || b.calls.length ? null : 'modèle non conservé sur l’extraction ni par un appel IA corrélé',
    b.reports.length ? null : 'aucun rapport d’exécution T1 conservé (rétention ou exécution antérieure au lot 58C)',
  ].filter(Boolean) as string[];
  return step('EXTRACTION_IA', manques.length ? 'partiel' : 'disponible', refs, donnees, manques.length ? manques.join(' ; ') : undefined);
}

function documentStep(doc: Row | null, fileId: number | null, motif?: string): TraceStep {
  if (!fileId) return step('DOCUMENT', 'non_disponible', [], undefined, motif ?? 'aucun document source enregistré');
  if (!doc) return step('DOCUMENT', 'non_disponible', [{ table: 'asset_files', id: fileId }], undefined, 'document introuvable dans ce compte (supprimé définitivement ?)');
  return step('DOCUMENT', doc.deleted_at ? 'partiel' : 'disponible', [{ table: 'asset_files', id: fileId }], doc, doc.deleted_at ? 'document supprimé logiquement' : undefined);
}

async function factsByIds(q: DiagQuery, A: number, ids: number[]): Promise<Row[]> {
  if (!ids.length) return [];
  return jsonRows(q, `SELECT ${FACT_COLS} FROM document_facts WHERE account_id = $1 AND id = ANY($2::bigint[]) ORDER BY id`, [A, ids]);
}

interface Hint { role?: unknown; amountMinor?: unknown; currency?: unknown; amountScope?: unknown; economicDate?: unknown; evidence?: { factId?: unknown; fingerprint?: unknown; sourceUnitIds?: unknown } }
const hintsOf = (c: Row | null): Hint[] => (Array.isArray(c?.financial_hints) ? (c!.financial_hints as Hint[]) : []);

// ── Ligne « composante d'Opération » ────────────────────────────────────────

/**
 * Trace d'une COMPOSANTE financière (et de sa ligne TCO dans chaque bien
 * fourni). Une composante absente du compte → trace « non disponible ».
 */
export async function traceComponent(q: DiagQuery, A: number, componentId: number, ctxs: TcoContext[]): Promise<AmountTrace[]> {
  const comp = await oneRow(q, `
    SELECT id, operation_id, kind, amount_minor, currency, amount_eur_cents, economic_date, period_start, period_end, target_asset_id, target_equipment_id,
           label, fingerprint, active, superseded_at, created_at, updated_at
      FROM business_operation_financial_components WHERE id = $1 AND account_id = $2`, [componentId, A]);
  const lineId = `c:${componentId}`;
  const pairs = ctxs.map((ctx) => ({ ctx, line: ctx.result?.lines.find((l) => l.id === lineId) ?? null }));
  if (!comp) {
    return [finalizeTrace({
      ligne: { id: lineId }, assetId: null,
      valeurs: { source: null, proposeeIA: null, enregistree: null, calculee: null, affichee: null },
      chaine: [step('ENREGISTREMENT', 'non_disponible', [{ table: 'business_operation_financial_components', id: componentId }], undefined, 'composante introuvable dans ce compte')],
    })];
  }
  const opId = Number(comp.operation_id);
  const op = await oneRow(q, `SELECT id, type_code, status, provider, technical_label, planned_date, realized_date, invalidated_at, invalidation_reason,
                                     merged_into_operation_id, last_reconciled_at, created_at, updated_at
                                FROM business_operations WHERE id = $1 AND account_id = $2`, [opId, A]);
  const sources = await jsonRows(q, `
    SELECT s.id, cs.evidence_role, cs.is_primary, s.source_kind, s.source_entity_key, s.source_version, s.source_role, s.locator->>'candidateKey' AS candidate_key,
           s.authority, s.confidence, s.match_method, s.match_reason, s.active, s.superseded_at, s.created_at,
           -- Lot 78A (0609) : lien persisté composante → candidat T1 → indices → faits.
           to_jsonb(cs) -> 'evidence' AS evidence,
           CASE WHEN s.match_method = 'M3' THEN 'IA (M3)' WHEN s.match_method = 'M0' THEN 'utilisateur (M0)'
                WHEN s.match_method IN ('M1', 'M2') THEN 'déterministe (' || s.match_method || ')' ELSE 'création' END AS nature_decision
      FROM business_operation_financial_component_sources cs JOIN business_operation_sources s ON s.id = cs.operation_source_id AND s.account_id = $2
     WHERE cs.component_id = $1 ORDER BY cs.is_primary DESC, s.active DESC, s.id`, [componentId, A]);
  const history = await jsonRows(q, `
    SELECT id, event_type, reason_code, source_id, actor_user_id, before_json, after_json, correlation_id, created_at
      FROM business_operation_history
     WHERE account_id = $1 AND operation_id = $2
       AND (event_type IN ('CREATED', 'MERGED', 'INVALIDATED')
            OR (event_type = 'FINANCIAL_CHANGED' AND ((after_json->>'component_id') = $3 OR (before_json->>'component_id') = $3))
            OR source_id = ANY($4::bigint[]))
     ORDER BY created_at, id`, [A, opId, String(componentId), sources.map((s) => Number(s.id))]);
  const matchDecisions = await jsonRows(q, `
    SELECT id, source_kind, source_entity_key, source_version, candidate_operation_id, decision, origin, reason_code, active, created_at, updated_at
      FROM business_operation_match_decisions WHERE account_id = $1 AND candidate_operation_id = $2 ORDER BY id`, [A, opId]);

  // Source documentaire principale (la première DOCUMENT, primaire d'abord).
  const docSource = sources.find((s) => s.source_kind === 'DOCUMENT') ?? null;
  const fileId = docSource ? num(docSource.source_entity_key) : null;
  const doc = fileId ? await documentRow(q, A, fileId) : null;
  // Lot 78A : lien PERSISTÉ par T3 (candidat, indices, faits) — prioritaire sur toute correspondance de valeur.
  const lien = (docSource?.evidence ?? null) as { candidateId?: unknown; hintIndexes?: unknown; factIds?: unknown } | null;
  // Candidat T1 désigné par la source (source_version `c<id>|…`), à défaut par la clé du candidat (actif).
  let candidate: Row | null = null;
  let candidateVia: string | null = null;
  const candId = num(lien?.candidateId) ?? candidateIdFromSourceVersion(docSource?.source_version);
  if (candId && num(lien?.candidateId) !== null) {
    candidate = await oneRow(q, `SELECT ${CAND_COLS} FROM document_operation_candidates WHERE id = $1 AND account_id = $2`, [candId, A]);
    candidateVia = candidate ? 'business_operation_financial_component_sources.evidence (lien persisté par T3)' : null;
  }
  if (!candidate && candId) {
    candidate = await oneRow(q, `SELECT ${CAND_COLS} FROM document_operation_candidates WHERE id = $1 AND account_id = $2`, [candId, A]);
    candidateVia = 'business_operation_sources.source_version';
  }
  if (!candidate && fileId && docSource?.candidate_key) {
    candidate = await oneRow(q, `SELECT ${CAND_COLS} FROM document_operation_candidates WHERE account_id = $1 AND file_id = $2 AND candidate_key = $3
                                 ORDER BY (status = 'ACTIVE') DESC, id DESC LIMIT 1`, [A, fileId, docSource.candidate_key]);
    candidateVia = candidate ? 'business_operation_sources.locator.candidateKey (candidat actif du document)' : null;
  }
  const hints = hintsOf(candidate);
  const indicesPersistes = Array.isArray(lien?.hintIndexes) ? (lien!.hintIndexes as unknown[]).map(Number).filter((x) => Number.isSafeInteger(x)) : [];
  const sameValue = indicesPersistes.length && candidate
    ? indicesPersistes.filter((i) => hints[i]).map((i) => ({ i, h: hints[i] }))
    : hints.map((h, i) => ({ i, h })).filter(({ h }) => Number(h.amountMinor) === Number(comp.amount_minor) && String(h.currency ?? '').toUpperCase() === String(comp.currency).toUpperCase());
  const faitsPersistes = Array.isArray(lien?.factIds) ? (lien!.factIds as unknown[]).map(Number).filter((x) => Number.isSafeInteger(x)) : [];
  const factIds = [...new Set([...faitsPersistes, ...sameValue.map(({ h }) => num(h.evidence?.factId)).filter((x): x is number => x !== null)])];
  const facts = await factsByIds(q, A, factIds);
  const ext = fileId ? await extractionBundle(q, A, fileId, num(candidate?.extraction_id)) : { extraction: null, reports: [], calls: [] };

  const nonDoc = sources.filter((s) => s.source_kind !== 'DOCUMENT');
  const docStep = docSource
    ? documentStep(doc, fileId)
    : step('DOCUMENT', 'non_disponible', [], { sourcesNonDocumentaires: nonDoc },
      sources.length
        ? `aucune source DOCUMENT : composante issue de ${[...new Set(nonDoc.map((s) => String(s.source_kind)))].join(', ')} (saisie, fiche, arbitrage ou migration)`
        : 'aucune source enregistrée pour cette composante (business_operation_financial_component_sources vide)');

  const extStep = !docSource ? step('EXTRACTION_IA', 'sans_objet', [], undefined, 'pas de document source : aucune extraction IA en jeu')
    : extractionStep(ext, facts, {
      candidat: candidate, candidatDesignePar: candidateVia,
      lienPersiste: lien ? { candidat: num(lien.candidateId), indices: indicesPersistes, faits: faitsPersistes } : null,
      indicesFinanciers: hints.map((h, i) => ({
        index: i, ...h,
        ...(indicesPersistes.length && candidate ? { justifieLaComposante: indicesPersistes.includes(i) } : { correspondanceDeValeur: sameValue.some((x) => x.i === i) }),
      })),
    }, !candidate ? 'candidat T1 introuvable (supersédé puis purgé, ou source antérieure au lot 40)'
      : !sameValue.length ? 'aucun indice financier du candidat ne porte ce montant et cette devise : composante transformée ou issue d’une autre source'
        : factIds.length ? 'fait désigné par l’indice introuvable' : 'indice T1 sans fait persisté (evidence.factId nul)');

  const decision = step('DECISION', candidate || history.length || matchDecisions.length ? 'disponible' : 'non_disponible',
    [
      ...(candidate ? [{ table: 'document_operation_candidates', id: Number(candidate.id) }] : []),
      ...history.map((h) => ({ table: 'business_operation_history', id: Number(h.id) })),
      ...matchDecisions.map((m) => ({ table: 'business_operation_match_decisions', id: Number(m.id) })),
    ],
    {
      t3: candidate ? { issue: candidate.t3_outcome, motif: candidate.t3_reason, operationRetenue: candidate.t3_operation_id, traiteLe: candidate.t3_processed_at, enAttente: candidate.t3_pending, detail: candidate.t3_detail } : null,
      historique: history, decisionsRapprochement: matchDecisions,
    },
    candidate || history.length || matchDecisions.length ? undefined : 'aucune décision T3 ni historique conservé pour cette composante');

  const record = step('ENREGISTREMENT', 'disponible', [{ table: 'business_operation_financial_components', id: componentId }, { table: 'business_operations', id: opId }],
    { composante: comp, operation: op, ecritures: history.filter((h) => h.event_type === 'FINANCIAL_CHANGED') });

  const links = await jsonRows(q, `
    SELECT 'asset' AS cible, asset_id AS id, link_role AS role, authority, active, source_operation_source_id FROM business_operation_asset_links WHERE account_id = $1 AND operation_id = $2
    UNION ALL
    SELECT 'equipment', equipment_id, NULL, authority, active, source_operation_source_id FROM business_operation_equipment_links WHERE account_id = $1 AND operation_id = $2`, [A, opId]);
  const rappr = step('RAPPROCHEMENT', sources.length ? 'disponible' : 'non_disponible',
    [...sources.map((s) => ({ table: 'business_operation_sources', id: Number(s.id) }))],
    { sources, liensCibles: links, cibleComposante: { bien: comp.target_asset_id, equipement: comp.target_equipment_id } },
    sources.length ? undefined : 'aucune source rattachée à la composante');

  const proposee = sameValue.length === 1 ? sameValue[0].h : sameValue.length ? sameValue.map((x) => x.h) : null;
  const sourceValue = facts.length ? facts.map((f) => ({ fait: f.id, valeur: f.value_number ?? f.value_text, brute: f.raw_value, unite: f.value_unit }))
    : ext.extraction ? { montantDocument: ext.extraction.amount_cents, devise: ext.extraction.currency, origine: 'document_extractions.amount_cents' } : null;

  const out: AmountTrace[] = [];
  const targets = pairs.length ? pairs : [{ ctx: null as TcoContext | null, line: null as TcoEconomicLine | null }];
  for (const { ctx, line } of targets) {
    const c = calcSteps(ctx, line, comp.active ? 'composante absente du TCO de ce bien (Opération non liée au bien, invalidée ou fusionnée)' : 'composante inactive (supersédée) : hors calcul');
    const valeurs: TraceValues = {
      source: sourceValue, proposeeIA: proposee,
      enregistree: { montantMinor: comp.amount_minor, devise: comp.currency, eurCents: comp.amount_eur_cents, nature: comp.kind },
      calculee: c.calculee, affichee: c.affichee,
    };
    out.push(finalizeTrace({
      ligne: line ? { ...line } : { id: lineId, label: comp.label ?? op?.technical_label ?? null, kind: comp.kind, operationId: opId },
      assetId: ctx?.assetId ?? null, valeurs,
      chaine: [docStep, extStep, decision, record, rappr, c.calc, c.display],
    }));
  }
  return out;
}

// ── Ligne « justificatif compté directement » ───────────────────────────────

async function traceDocumentLine(q: DiagQuery, A: number, ctx: TcoContext, line: TcoEconomicLine, p: { fileId: number; candidateId: number | null; hintIndex: number | null }): Promise<AmountTrace> {
  const doc = await documentRow(q, A, p.fileId);
  const candidate = p.candidateId ? await oneRow(q, `SELECT ${CAND_COLS} FROM document_operation_candidates WHERE id = $1 AND account_id = $2`, [p.candidateId, A]) : null;
  const hint = candidate && p.hintIndex !== null ? hintsOf(candidate)[p.hintIndex] ?? null : null;
  const factId = num(hint?.evidence?.factId);
  const facts = await factsByIds(q, A, factId ? [factId] : []);
  const ext = await extractionBundle(q, A, p.fileId, num(candidate?.extraction_id));
  const extStep = extractionStep(ext, facts, { candidat: candidate, indice: hint ? { index: p.hintIndex, ...hint } : null },
    p.candidateId === null ? 'montant documentaire sans candidat T1 (asset_files.amount_cents / extraction)' : !candidate ? 'candidat T1 introuvable' : !hint ? 'indice désigné introuvable' : 'indice T1 sans fait persisté (evidence.factId nul)');
  const decision = candidate
    ? step('DECISION', 'disponible', [{ table: 'document_operation_candidates', id: Number(candidate.id) }], {
      t3: { issue: candidate.t3_outcome, motif: candidate.t3_reason, operationRetenue: candidate.t3_operation_id, traiteLe: candidate.t3_processed_at, enAttente: candidate.t3_pending, detail: candidate.t3_detail },
    })
    : step('DECISION', 'sans_objet', [], undefined, 'dépense documentaire sans candidat : comptée par la règle documentaire du TCO (lot 61), aucune décision T3');
  const record = step('ENREGISTREMENT', 'sans_objet', [{ table: 'asset_files', id: p.fileId }],
    { montantDocument: doc?.amount_cents ?? null, operationCouvrante: line.operationId },
    line.operationId ? `montant repris par l’Opération #${line.operationId} (statut ${line.status})` : 'dépense comptée directement depuis le document : aucune composante enregistrée');
  const links = await jsonRows(q, `SELECT id, asset_id, equipment_id, substructure_id, link_role, status, origin, removed_at FROM document_asset_links WHERE account_id = $1 AND file_id = $2 ORDER BY id`, [A, p.fileId]);
  const rappr = step('RAPPROCHEMENT', 'disponible', [{ table: 'asset_files', id: p.fileId }, ...links.map((l) => ({ table: 'document_asset_links', id: Number(l.id) }))],
    { rattachement: doc ? { asset_id: doc.asset_id, linked_asset_id: doc.linked_asset_id, equipment_id: doc.equipment_id } : null, liens: links, ciblesIndiceT1: candidate?.target_hints ?? null });
  const c = calcSteps(ctx, line, '');
  return finalizeTrace({
    ligne: { ...line }, assetId: ctx.assetId,
    valeurs: {
      source: facts.length ? facts.map((f) => ({ fait: f.id, valeur: f.value_number ?? f.value_text, brute: f.raw_value })) : (ext.extraction ? { montantDocument: ext.extraction.amount_cents, devise: ext.extraction.currency } : null),
      proposeeIA: hint, enregistree: doc ? { montantDocument: doc.amount_cents } : null, calculee: c.calculee, affichee: c.affichee,
    },
    chaine: [documentStep(doc, p.fileId), extStep, decision, record, rappr, c.calc, c.display],
  });
}

// ── Ligne « prix d'achat de la fiche » (bien ou équipement) ─────────────────

async function tracePriceLine(q: DiagQuery, A: number, ctx: TcoContext, line: TcoEconomicLine, target: { type: 'ASSET' | 'EQUIPMENT'; id: number }): Promise<AmountTrace> {
  const isAsset = target.type === 'ASSET';
  const writes = await jsonRows(q, `
    SELECT id, canonical_key, old_value, new_value, origin, source_type, source_id, outcome, target_type, target_id, created_at
      FROM canonical_field_writes
     WHERE account_id = $1 AND canonical_key = 'acquisitionPrice'
       AND ${isAsset ? `asset_id = $2 AND coalesce(upper(target_type), 'ASSET') = 'ASSET'` : `upper(target_type) = 'EQUIPMENT' AND target_id = $2`}
     ORDER BY created_at DESC, id DESC`, [A, target.id]);
  const evidence = await jsonRows(q, `
    SELECT id, field_key, canonical_key, value_json, normalized_value, raw_value, canonical_unit, source_type, source_id, evidence_origin, confidence,
           status, lifecycle_status, evidence_excerpt, extracted_at
      FROM field_evidence
     WHERE account_id = $1 AND (canonical_key = 'acquisitionPrice' OR field_key = 'acquisitionPrice')
       AND ${isAsset ? `asset_id = $2 AND (target_type IS NULL OR target_type = 'ASSET')` : `target_type = 'EQUIPMENT' AND target_entity_id = $2`}
     ORDER BY extracted_at DESC NULLS LAST, id DESC`, [A, target.id]);
  const last = writes[0] ?? null;
  const docIds = [...new Set([
    ...(last && String(last.source_type ?? '').toLowerCase() === 'document' ? [num(last.source_id)] : []),
    ...evidence.filter((e) => String(e.source_type).toLowerCase() === 'document').map((e) => num(e.source_id)),
  ].filter((x): x is number => x !== null))];
  const fileId = docIds[0] ?? line.fileId ?? null;
  const doc = fileId ? await documentRow(q, A, fileId) : null;
  const facts = docIds.length ? await jsonRows(q, `SELECT ${FACT_COLS} FROM document_facts WHERE account_id = $1 AND file_id = ANY($2::int[]) AND canonical_key = 'acquisitionPrice' ORDER BY id`, [A, docIds]) : [];
  const ext = fileId ? await extractionBundle(q, A, fileId, null) : { extraction: null, reports: [], calls: [] };
  const cards = await jsonRows(q, `SELECT id, rule_code, action_kind, question, proposals_json, resolved_at, resolution_reason, created_at FROM to_process_actions
                                     WHERE account_id = $1 AND field_key = 'acquisitionPrice' AND upper(target_type) = $2 AND target_id = $3 ORDER BY id DESC`, [A, target.type, target.id]);
  const userOrigin = last && ['USER', 'ADMIN'].includes(String(last.origin).toUpperCase());
  const c = calcSteps(ctx, line, '');
  const where = { table: isAsset ? 'assets' : 'equipments', id: target.id };
  return finalizeTrace({
    ligne: { ...line }, assetId: ctx.assetId,
    valeurs: {
      source: facts.map((f) => ({ fait: f.id, valeur: f.value_number, brute: f.raw_value, unite: f.value_unit })),
      proposeeIA: evidence.map((e) => ({ preuve: e.id, valeur: e.value_json, origine: e.evidence_origin, statut: e.lifecycle_status ?? e.status })),
      enregistree: last ? { valeur: last.new_value, origine: last.origin, le: last.created_at } : { montantMinor: line.amountMinor, devise: line.currency, origine: 'fiche (aucune écriture canonique tracée)' },
      calculee: c.calculee, affichee: c.affichee,
    },
    chaine: [
      fileId ? documentStep(doc, fileId) : step('DOCUMENT', userOrigin ? 'sans_objet' : 'non_disponible', [], undefined, userOrigin ? 'valeur saisie (USER / ADMIN) : pas de document source' : 'aucun document source tracé pour ce prix d’achat'),
      fileId ? extractionStep(ext, facts, { preuves: evidence }) : step('EXTRACTION_IA', userOrigin ? 'sans_objet' : 'non_disponible', [], { preuves: evidence }, userOrigin ? 'valeur saisie' : 'aucune preuve documentaire'),
      step('DECISION', last || cards.length ? 'disponible' : 'non_disponible', [...writes.map((w) => ({ table: 'canonical_field_writes', id: Number(w.id) })), ...cards.map((x) => ({ table: 'to_process_actions', id: Number(x.id) }))],
        { derniereEcriture: last, cartesATraiter: cards }, last || cards.length ? undefined : 'aucune écriture canonique ni carte « À traiter » conservée'),
      step('ENREGISTREMENT', 'disponible', [where, ...writes.map((w) => ({ table: 'canonical_field_writes', id: Number(w.id) }))], { cle: 'key_characteristics.acquisitionPrice', ecritures: writes }),
      step('RAPPROCHEMENT', 'sans_objet', [where], undefined, 'valeur de la fiche : rattachée par construction (aucun rapprochement)'),
      c.calc, c.display,
    ],
  });
}

/** Trace d'une ligne TCO quelconque d'un bien. */
export async function traceTcoLine(q: DiagQuery, A: number, ctx: TcoContext, line: TcoEconomicLine): Promise<AmountTrace> {
  const p = parseLineId(line.id);
  switch (p.kind) {
    case 'component': return (await traceComponent(q, A, p.componentId, [ctx]))[0];
    case 'document': return traceDocumentLine(q, A, ctx, line, p);
    case 'asset-price': return tracePriceLine(q, A, ctx, line, { type: 'ASSET', id: p.assetId });
    case 'equipment-price': return tracePriceLine(q, A, ctx, line, { type: 'EQUIPMENT', id: p.equipmentId });
    default: {
      const c = calcSteps(ctx, line, '');
      return finalizeTrace({
        ligne: { ...line }, assetId: ctx.assetId, valeurs: { source: null, proposeeIA: null, enregistree: null, calculee: c.calculee, affichee: c.affichee },
        chaine: [step('DOCUMENT', 'non_disponible', [], undefined, `identifiant de ligne non reconnu (${line.id})`), c.calc, c.display],
      });
    }
  }
}
