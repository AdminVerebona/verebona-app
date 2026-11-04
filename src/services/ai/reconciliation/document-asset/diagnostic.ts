/**
 * T3 DOCUMENT_ASSET — JOURNAL DE RATTACHEMENT pour le diagnostic BO (lot
 * 108E, ticket « T3 DOCUMENT_ASSET — correctif #626 bis », §C, §D).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Le PO fait la recette réelle SANS accès à la base : ce module rend, dans le
 * diagnostic BO durable EXISTANT (lot 107G, `diagnostics-export/collect.ts` —
 * aucun moteur parallèle), deux fichiers :
 *   · `ia/t3-rattachement-documents.json` — CONFIGURATION (version du moteur
 *     et des règles, variables T3_IDENTITY_GROUPS_ENABLED /
 *     T3_CROSS_DOCUMENT_CONTEXT_ENABLED / T3_DOCUMENT_ASSET_AI_MEMORY_ENABLED,
 *     migrations 0995 / 1060, prompt maître T3 actif : version, contrat
 *     `t3-document-asset-cross-v1`, conformité, qualification du couple
 *     `t3_link_ambiguity`), CONTRÔLES (attendu / constaté / OK), COMPTEURS par
 *     compte et par phase, incidents Supervision, et pour CHAQUE document sans
 *     bien (ou rattaché par T3) : sources exploitées / absentes, groupes et
 *     provenance, exclusions, candidats, branche, crossDocumentSent et
 *     contrôle croisé, appel / mémoire, motif d'abstention, panne, job,
 *     COH-DOC-PRIMARY-LINK, cartes avant / après (historique), projection ;
 *   · `ia/t3-rattachement-documents.txt` — même contenu en tableau lisible
 *     (à recopier dans le tableau avant / après de la recette).
 * Diagnostic GLOBAL : configuration, contrôles et compteurs par compte ; le
 * détail par document est dans le diagnostic DU COMPTE (déclaré dans le
 * fichier, jamais une troncature silencieuse).
 *
 * Lecture seule, dans l'instantané du diagnostic pour les données ; l'état du
 * prompt et des variables est lu « en direct » (déclaré). Aucune adresse ni
 * valeur de document : références, codes, compteurs, titres de documents et
 * noms de biens (déjà présents dans l'export).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { DOCUMENT_ASSET_RESOLUTION_VERSION } from './version';
import { IDENTITY_SIGNALS_VERSION } from './identity/signals';
import { IDENTITY_GRAPH_VERSION } from './identity/graph';
import { T3_DOCUMENT_ASSET_CROSS_CONTRACT } from './identity/contract';
import { T3_TECHNICAL_RETRY_MINUTES } from './technical-failure';

type Row = Record<string, unknown>;
type Query = (sql: string, params: unknown[]) => Promise<Row[]>;

export const T3_DIAGNOSTIC_SCHEMA = 'verebona.t3.document-asset-diagnostic/1';
/** Documents relus par requête (pages ; aucune borne de découverte). */
const PAGE = 200;

const N = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const J = <T>(v: unknown, d: T): T => {
  if (v === null || v === undefined) return d;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return d; } }
  return v as T;
};
const iso = (v: unknown): string | null => (v ? new Date(String(v)).toISOString() : null);

/** Variable d'environnement : valeur brute (jamais un secret ici) et effet. */
function envFlag(name: string): { variable: string; raw: string | null; effective: boolean; meaning: string } {
  const raw = process.env[name]?.trim() ?? null;
  return { variable: name, raw: raw === '' ? null : raw, effective: raw !== '0', meaning: raw === '0' ? 'coupé (valeur 0)' : 'actif (absente ou ≠ 0)' };
}

export interface T3PromptState {
  readAt: string;
  operation: string;
  effectiveVersion: string | null;
  source: string | null;
  activeBoVersion: { id: number; versionNumber: number; activatedAt: string | null } | null;
  carriesCrossContract: boolean | null;
  crossContextSent: boolean | null;
  promptArchitecture: string | null;
  configurationSignature: string | null;
  conformity: { status: string | null; updatedAt: string | null } | null;
  qualification: Array<{ rank: number; model: string; state: string; verdictAt: string | null; changed: string[] }> | null;
  errors: string[];
}

/** État RÉEL du prompt maître T3 actif (lu en direct ; jamais une écriture). */
export async function t3PromptState(query: Query | null = null): Promise<T3PromptState> {
  const out: T3PromptState = {
    readAt: new Date().toISOString(), operation: 't3_link_ambiguity', effectiveVersion: null, source: null, activeBoVersion: null,
    carriesCrossContract: null, crossContextSent: null, promptArchitecture: null, configurationSignature: null, conformity: null, qualification: null, errors: [],
  };
  const essai = async (quoi: string, f: () => Promise<void>) => { try { await f(); } catch (e) { out.errors.push(`${quoi} : ${(e as Error).message.slice(0, 200)}`); } };
  await essai('prompt effectif', async () => {
    const { effectivePromptOf } = await import('@/services/ai/master-prompts/effective-prompt');
    const { promptCarriesCrossDocument } = await import('./identity/contract');
    const e = await effectivePromptOf('t3_link_ambiguity');
    out.effectiveVersion = e.version;
    out.source = /@pv\d+/.test(e.version) ? 'version BO' : /@file/.test(e.version) ? 'fichier du dépôt' : 'version de configuration';
    out.carriesCrossContract = promptCarriesCrossDocument(e.text);
  });
  await essai('version BO active', async () => {
    const [{ getAiEnvironment }, repo] = await Promise.all([import('@/services/ai/config/environment'), import('@/services/ai/master-prompts/master-prompt.repository')]);
    const a = await repo.getActive(getAiEnvironment(), 'T3');
    out.activeBoVersion = a ? { id: a.id, versionNumber: a.versionNumber, activatedAt: iso((a as { activatedAt?: unknown }).activatedAt) } : null;
  });
  await essai('configuration de l’opération', async () => {
    const [{ resolveOperationConfig }, { AiGateway }] = await Promise.all([import('@/services/ai/config/config-resolver'), import('../../gateway/ai-gateway')]);
    const cfg = await resolveOperationConfig('t3_link_ambiguity');
    out.promptArchitecture = cfg.promptArchitecture ?? null;
    out.configurationSignature = await AiGateway.effectiveConfigSignature('t3_link_ambiguity').catch(() => null);
  });
  await essai('contrat transmis', async () => {
    const { crossDocumentContractActive } = await import('./identity/contract');
    out.crossContextSent = await crossDocumentContractActive();
  });
  if (query) {
    await essai('conformité', async () => {
      const r = await query(`SELECT status, updated_at FROM ai_prompt_conformity_issues WHERE contract_id = $1 ORDER BY updated_at DESC LIMIT 1`, [T3_DOCUMENT_ASSET_CROSS_CONTRACT]);
      out.conformity = r[0] ? { status: String(r[0].status), updatedAt: iso(r[0].updated_at) } : { status: null, updatedAt: null };
    });
  }
  await essai('qualification', async () => {
    const [cfgRepo, ctx, { getAiEnvironment }] = await Promise.all([
      import('@/services/ai/config/config-version.repository'), import('@/services/ai/qualification/context'), import('@/services/ai/config/environment'),
    ]);
    const active = await cfgRepo.getActiveVersion(getAiEnvironment());
    if (!active) { out.qualification = []; return; }
    const couples = await ctx.couplesWithState(active, { readMasterFile: await ctx.defaultMasterReader(), operationCodes: ['t3_link_ambiguity'] });
    out.qualification = couples.filter((c) => c.operationCode === 't3_link_ambiguity')
      .map((c) => ({ rank: c.rank, model: c.model, state: c.state.state, verdictAt: c.state.verdictAt, changed: c.state.changed }));
  });
  return out;
}

export interface T3DiagnosticCheck { code: string; label: string; expected: string; actual: string; ok: boolean | null }

/** Contrôles de recette (§D) — attendu / constaté (pure). */
export function t3DiagnosticChecks(p: {
  engineVersion: number; migrations: { m0995: boolean; m1060: boolean } | null; env: Record<string, { effective: boolean; raw: string | null }>;
  prompt: Pick<T3PromptState, 'carriesCrossContract' | 'crossContextSent' | 'promptArchitecture' | 'qualification' | 'effectiveVersion'> | null;
}): T3DiagnosticCheck[] {
  const oui = (b: boolean | null | undefined) => (b === null || b === undefined ? 'illisible' : b ? 'oui' : 'non');
  const q = p.prompt?.qualification ?? null;
  const rang0 = q?.find((c) => c.rank === 0) ?? null;
  return [
    { code: 'ENGINE_VERSION', label: 'Version du moteur T3 DOCUMENT_ASSET', expected: '4', actual: String(p.engineVersion), ok: p.engineVersion === 4 },
    { code: 'MIGRATION_0995', label: 'Migration 0995 (groupes d’identité, décisions)', expected: 'présente', actual: p.migrations ? (p.migrations.m0995 ? 'présente' : 'absente') : 'illisible', ok: p.migrations ? p.migrations.m0995 : null },
    { code: 'MIGRATION_1060', label: 'Migration 1060 (groupes d’appareils)', expected: 'présente', actual: p.migrations ? (p.migrations.m1060 ? 'présente' : 'absente') : 'illisible', ok: p.migrations ? p.migrations.m1060 : null },
    ...['T3_IDENTITY_GROUPS_ENABLED', 'T3_CROSS_DOCUMENT_CONTEXT_ENABLED', 'T3_DOCUMENT_ASSET_AI_MEMORY_ENABLED'].map((v) => ({
      code: v, label: `Variable ${v}`, expected: 'actif (absente ou ≠ 0)', actual: p.env[v]?.raw === null || p.env[v]?.raw === undefined ? 'absente (actif)' : `${p.env[v].raw} (${p.env[v].effective ? 'actif' : 'coupé'})`,
      ok: p.env[v]?.effective ?? null,
    })),
    { code: 'PROMPT_ARCHITECTURE', label: 'Opération t3_link_ambiguity : prompt maître', expected: 'master', actual: p.prompt?.promptArchitecture ?? 'illisible', ok: p.prompt?.promptArchitecture ? p.prompt.promptArchitecture === 'master' : null },
    { code: 'PROMPT_CROSS_MARKER', label: `Prompt T3 actif porte le contrat ${T3_DOCUMENT_ASSET_CROSS_CONTRACT} (étape 12 du guide)`, expected: 'oui', actual: `${oui(p.prompt?.carriesCrossContract)}${p.prompt?.effectiveVersion ? ` (${p.prompt.effectiveVersion})` : ''}`, ok: p.prompt?.carriesCrossContract ?? null },
    { code: 'CROSS_CONTEXT_SENT', label: 'Preuves croisées effectivement transmises au modèle', expected: 'oui', actual: oui(p.prompt?.crossContextSent), ok: p.prompt?.crossContextSent ?? null },
    {
      code: 'QUALIFICATION', label: 'Couple t3_link_ambiguity qualifié sur la configuration ACTUELLE (P-T3-24..28, P-T3-03..07)', expected: 'ADMISSIBLE',
      actual: q === null ? 'illisible' : rang0 ? `${rang0.state}${rang0.verdictAt ? ` (${rang0.verdictAt})` : ''}${rang0.changed.length ? ` — modifié : ${rang0.changed.join(', ')}` : ''}` : 'aucun couple',
      ok: q === null ? null : rang0?.state === 'ADMISSIBLE',
    },
  ];
}

/** Ligne par document (sans valeur sensible). */
interface DocLine {
  fileId: number; title: string | null; documentType: string | null; supplier: string | null;
  primaryAssetIds: number[]; userDecided: boolean;
  resolution: Row | null; evaluation: Row | null; job: Row | null; coherence: Row | null;
  cards: Row[]; groups: Row[];
}

const EVAL_KEYS = [
  'at', 'trigger', 'reprocessReason', 'result', 'branch', 'decision', 'reasonCode', 'candidateCount', 'candidateSources', 'promptCandidateCount',
  'documentSources', 'missingSources', 'knowledgeCounts', 'identitySources', 'identityGraph', 'identity', 'crossDocumentSent', 'crossDocument',
  'ai', 'aiReused', 'semanticSearch', 'technicalFailure', 'projection', 'cardBefore', 'toProcessAction', 'linkedAssetId', 'fingerprintChanged', 'matchedSourceUnitIds',
] as const;

/** Sous-ensemble utile du journal T3 (sans empreintes de valeurs). Pure. */
export function evaluationSummary(e: Row | null): Row | null {
  if (!e) return null;
  const out: Row = {};
  for (const k of EVAL_KEYS) if (e[k] !== undefined) out[k] = e[k];
  const m = e.aiMemory as { path?: unknown; reasonCode?: unknown; at?: unknown } | null | undefined;
  if (m) out.aiMemory = { path: m.path ?? null, reasonCode: m.reasonCode ?? null, at: m.at ?? null };
  return out;
}

async function accountDocuments(q: Query, accountId: number, after: number): Promise<DocLine[]> {
  const rows = await q(`
    SELECT f.id, e.title, e.document_type_code, e.supplier_name,
           ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[f.asset_id] || ARRAY(
                   SELECT l.asset_id FROM document_asset_links l WHERE l.file_id = f.id AND l.status = 'ACTIVE' AND l.asset_id IS NOT NULL AND l.link_role = 'PRIMARY')) x
                  WHERE x IS NOT NULL) AS primary_ids,
           COALESCE((f.user_edited_fields ->> 'assetId')::boolean, false) AS user_decided,
           r.status, r.last_outcome, r.method, r.reason_code, r.resolution_version, r.evaluated_at, r.runs, r.decided_asset_ids, r.candidates, r.last_evaluation
      FROM asset_files f
      JOIN document_extractions e ON e.file_id = f.id AND e.account_id = f.account_id
      LEFT JOIN document_asset_resolutions r ON r.file_id = f.id
     WHERE f.account_id = $1 AND f.id > $2 AND f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL
       AND (r.file_id IS NOT NULL OR (f.asset_id IS NULL AND f.linked_asset_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = f.id AND l.status = 'ACTIVE' AND l.asset_id IS NOT NULL AND l.link_role = 'PRIMARY')))
     ORDER BY f.id LIMIT ${PAGE}`, [accountId, after]);
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.id));
  const [jobs, preuves, cartes, groupes] = await Promise.all([
    q(`SELECT DISTINCT ON (target_id) target_id, id, status, attempts, trigger_code, last_error, finished_at, created_at
         FROM ai_job_queue WHERE treatment = 'T3' AND target_type = 'document' AND target_id = ANY($1::text[]) ORDER BY target_id, id DESC`, [ids.map(String)]).catch(() => []),
    q(`SELECT object_id, last_result, finding, last_completed_at AS last_checked_at FROM coherence_object_proofs
        WHERE account_id = $1 AND check_id = 'COH-DOC-PRIMARY-LINK' AND object_id = ANY($2::int[])`, [accountId, ids]).catch(() => []),
    q(`SELECT a.id, a.target_id, a.rule_code, a.action_kind, a.created_at, a.resolved_at, a.resolution_reason, a.trigger_context -> 'memberFileIds' AS members
         FROM to_process_actions a
        WHERE a.account_id = $1 AND a.rule_code IN ('LINK-ASSET', 'LINK-ASSET-GROUP')
          AND ((a.rule_code = 'LINK-ASSET' AND a.target_type = 'DOCUMENT' AND a.target_id = ANY($2::int[]))
               OR (a.rule_code = 'LINK-ASSET-GROUP' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(a.trigger_context -> 'memberFileIds', '[]'::jsonb)) m WHERE m::int = ANY($2::int[]))))
        ORDER BY a.id`, [accountId, ids]).catch(() => []),
    q(`SELECT group_key, identity_family, status, target_asset_id, candidate_asset_ids, refused_asset_ids, member_file_ids, excluded, contradictions, card_action_id, evaluated_at
         FROM document_identity_groups WHERE account_id = $1 AND active
          AND (member_file_ids && $2::int[] OR EXISTS (SELECT 1 FROM jsonb_array_elements(excluded) x WHERE (x ->> 'fileId')::int = ANY($2::int[])))`, [accountId, ids]).catch(() => []),
  ]);
  const parJob = new Map(jobs.map((j) => [Number(j.target_id), j]));
  const parPreuve = new Map(preuves.map((p) => [Number(p.object_id), p]));
  return rows.map((r) => {
    const id = Number(r.id);
    const cards = cartes.filter((c) => (c.rule_code === 'LINK-ASSET' ? Number(c.target_id) === id : J<number[]>(c.members, []).map(Number).includes(id)))
      .map((c) => ({ id: N(c.id), rule: c.rule_code, kind: c.action_kind, createdAt: iso(c.created_at), resolvedAt: iso(c.resolved_at), resolution: c.resolution_reason ?? null }));
    const groups = groupes.filter((g) => ((g.member_file_ids as number[] | null) ?? []).map(Number).includes(id) || J<Array<{ fileId: number }>>(g.excluded, []).some((x) => Number(x.fileId) === id))
      .map((g) => {
        const exclu = J<Array<{ fileId: number; reason: string }>>(g.excluded, []).find((x) => Number(x.fileId) === id);
        return {
          groupKey: g.group_key, family: g.identity_family, status: g.status, role: exclu ? `EXCLUDED:${exclu.reason}` : 'MEMBER',
          targetAssetId: N(g.target_asset_id), candidateAssetIds: g.candidate_asset_ids ?? [], refusedAssetIds: g.refused_asset_ids ?? [],
          contradictions: J<Array<{ code: string }>>(g.contradictions, []).map((c) => c.code), cardActionId: N(g.card_action_id), evaluatedAt: iso(g.evaluated_at),
        };
      });
    const j = parJob.get(id);
    const pr = parPreuve.get(id);
    return {
      fileId: id, title: (r.title as string | null) ?? null, documentType: (r.document_type_code as string | null) ?? null, supplier: (r.supplier_name as string | null) ?? null,
      primaryAssetIds: ((r.primary_ids as number[] | null) ?? []).map(Number), userDecided: r.user_decided === true,
      resolution: r.status ? {
        status: r.status, lastOutcome: r.last_outcome ?? null, method: r.method ?? null, reasonCode: r.reason_code ?? null, version: N(r.resolution_version),
        evaluatedAt: iso(r.evaluated_at), runs: N(r.runs), decidedAssetIds: r.decided_asset_ids ?? [],
        candidates: J<Array<{ assetId: number; label: string; score: number; reason: string }>>(r.candidates, []).slice(0, 10),
      } : null,
      evaluation: evaluationSummary(J<Row | null>(r.last_evaluation, null)),
      job: j ? { id: N(j.id), status: j.status, attempts: N(j.attempts), trigger: j.trigger_code ?? null, lastError: j.last_error ? String(j.last_error).slice(0, 200) : null, finishedAt: iso(j.finished_at) } : null,
      coherence: pr ? { lastResult: pr.last_result, anomaly: (J<Row | null>(pr.finding, null)?.anomaly as string | undefined) ?? null, checkedAt: iso(pr.last_checked_at) } : null,
      cards, groups,
    };
  });
}

/** Compteurs EXHAUSTIFS d'un compte (pure, sur les lignes). */
export function accountCounters(lines: readonly DocLine[]): Row {
  const inc = (o: Record<string, number>, k: unknown) => { const c = String(k ?? '∅'); o[c] = (o[c] ?? 0) + 1; };
  const byStatus: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  const byBranch: Record<string, number> = {};
  const byResult: Record<string, number> = {};
  let sansBien = 0; let croise = 0; let croiseAbsent = 0; let pannes = 0; let carteOuverte = 0; let carteGroupee = 0; let carteNeePanne = 0; let projTech = 0;
  for (const l of lines) {
    if (l.primaryAssetIds.length === 0) sansBien += 1;
    inc(byStatus, (l.resolution as Row | null)?.status);
    inc(byReason, (l.resolution as Row | null)?.reasonCode);
    const e = l.evaluation ?? {};
    inc(byBranch, e.branch);
    inc(byResult, e.result);
    if (e.crossDocumentSent === true) croise += 1;
    if ((e.crossDocument as { reasons?: string[] } | undefined)?.reasons?.includes('CROSS_DOCUMENT_OUTPUT_MISSING')) croiseAbsent += 1;
    if ((l.resolution as Row | null)?.reasonCode === 'TECHNICAL_FAILURE') pannes += 1;
    const ouvertes = l.cards.filter((c) => !c.resolvedAt);
    if (ouvertes.some((c) => c.rule === 'LINK-ASSET')) {
      carteOuverte += 1;
      if ((e.ai as { status?: string } | undefined)?.status === 'ERROR' || (l.resolution as Row | null)?.reasonCode === 'TECHNICAL_FAILURE') carteNeePanne += 1;
    }
    if (ouvertes.some((c) => c.rule === 'LINK-ASSET-GROUP')) carteGroupee += 1;
    if ((e.projection as { actor?: string } | undefined)?.actor === 'TECHNICAL') projTech += 1;
  }
  return {
    documents: lines.length, withoutPrimaryAsset: sansBien, byResolutionStatus: byStatus, byReasonCode: byReason, byBranch, byResult,
    crossDocumentSent: croise, crossDocumentOutputMissing: croiseAbsent, technicalFailures: pannes,
    documentsWithOpenLinkAssetCard: carteOuverte, documentsCoveredByOpenGroupCard: carteGroupee, openCardsBornFromTechnicalFailure: carteNeePanne,
    technicalProjections: projTech,
  };
}

export interface T3DocumentAssetDiagnostic {
  schema: typeof T3_DIAGNOSTIC_SCHEMA;
  generatedAt: string;
  scope: 'GLOBAL' | 'ACCOUNTS';
  configuration: Row;
  checks: T3DiagnosticCheck[];
  accounts: Array<{ accountId: number; counters: Row; lastRun: Row | null; supervision: Row[]; documents?: DocLine[] }>;
  notes: string[];
}

/**
 * Diagnostic T3 DOCUMENT_ASSET (lecture seule). `accounts` null : global
 * (compteurs par compte, sans détail par document).
 */
export async function t3DocumentAssetDiagnostic(q: Query, accounts: readonly number[] | null, opts: { prompt?: T3PromptState | null } = {}): Promise<T3DocumentAssetDiagnostic> {
  const { identityMigrations } = await import('./identity/load');
  const migrations = await identityMigrations({ unsafe: (t: string, p?: never[]) => q(t, (p ?? []) as unknown[]) } as never).catch(() => null);
  const env = Object.fromEntries(['T3_IDENTITY_GROUPS_ENABLED', 'T3_CROSS_DOCUMENT_CONTEXT_ENABLED', 'T3_DOCUMENT_ASSET_AI_MEMORY_ENABLED'].map((v) => [v, envFlag(v)]));
  const prompt = opts.prompt !== undefined ? opts.prompt : await t3PromptState(q).catch(() => null);
  const { getBuildIdentity } = await import('@/lib/runtime-identity');
  const build = getBuildIdentity();
  const configuration: Row = {
    engineVersion: DOCUMENT_ASSET_RESOLUTION_VERSION, identitySignalsVersion: IDENTITY_SIGNALS_VERSION, identityGraphVersion: IDENTITY_GRAPH_VERSION,
    technicalRetryMinutes: T3_TECHNICAL_RETRY_MINUTES, env, migrations, prompt, build: { commit: build.commit, commitSource: build.commitSource },
  };
  const checks = t3DiagnosticChecks({ engineVersion: DOCUMENT_ASSET_RESOLUTION_VERSION, migrations, env, prompt });
  const global = accounts === null;
  const comptes = global
    ? (await q(`SELECT DISTINCT r.account_id FROM document_asset_resolutions r ORDER BY 1`, [])).map((r) => Number(r.account_id))
    : [...accounts];
  const out: T3DocumentAssetDiagnostic = {
    schema: T3_DIAGNOSTIC_SCHEMA, generatedAt: new Date().toISOString(), scope: global ? 'GLOBAL' : 'ACCOUNTS', configuration, checks, accounts: [],
    notes: [
      'Configuration (variables, prompt, qualification) lue EN DIRECT au moment du diagnostic ; données des documents lues dans l’instantané du diagnostic.',
      global ? 'Diagnostic global : compteurs par compte seulement — le détail par document est dans le diagnostic DU COMPTE (même fichier).' : 'Détail par document : tous les documents sans bien principal et tous ceux évalués par T3 DOCUMENT_ASSET (aucune borne).',
      'Cartes : historique complet LINK-ASSET (par document) et LINK-ASSET-GROUP (qui couvrent le document) — « avant / après » = cartes ouvertes à la date de la capture avant correction / après.',
    ],
  };
  for (const accountId of comptes) {
    const lines: DocLine[] = [];
    let after = 0;
    for (;;) {
      const page = await accountDocuments(q, accountId, after);
      lines.push(...page);
      if (page.length < PAGE) break;
      after = page[page.length - 1].fileId;
    }
    const run = (await q(`SELECT id, status, outcome, phases_json, started_at, finished_at FROM account_reconciliation_runs
                           WHERE account_id = $1 AND status <> 'queued' ORDER BY id DESC LIMIT 1`, [accountId]).catch(() => []))[0] ?? null;
    const phases = run ? J<Row>(run.phases_json, {}) : null;
    const supervision = await q(`SELECT id, fingerprint, title, status, occurrence_count, last_seen_at, technical_detail FROM admin_anomalies
                                  WHERE account_id = $1 AND domain = 'ai' AND (fingerprint LIKE 'ai:t3-identity-graph:%' OR fingerprint LIKE 'ai:t3-document-asset-technical:%')
                                  ORDER BY id DESC LIMIT 50`, [accountId]).catch(() => []);
    out.accounts.push({
      accountId, counters: accountCounters(lines),
      lastRun: run ? {
        id: N(run.id), status: run.status, outcome: run.outcome ?? null, startedAt: iso(run.started_at), finishedAt: iso(run.finished_at),
        openKnowledge: phases?.OPEN_KNOWLEDGE ?? null, identityGroups: phases?.IDENTITY_GROUPS ?? null, openActions: phases?.OPEN_ACTIONS ?? null,
      } : null,
      supervision: supervision.map((a) => ({ id: N(a.id), fingerprint: a.fingerprint, title: a.title, status: a.status, occurrences: N(a.occurrence_count), lastSeenAt: iso(a.last_seen_at), detail: a.technical_detail ?? null })),
      ...(global ? {} : { documents: lines }),
    });
  }
  return out;
}

/** Version lisible (tableau) pour le PO (pure). */
export function t3DiagnosticText(d: T3DocumentAssetDiagnostic): string {
  const l: string[] = [];
  l.push('T3 — RATTACHEMENT DES DOCUMENTS AUX BIENS (lot 108E)', `Généré le ${d.generatedAt}`, '');
  l.push('CONTRÔLES DE CONFIGURATION (attendu → constaté)');
  for (const c of d.checks) l.push(`  [${c.ok === null ? '??' : c.ok ? 'OK' : 'KO'}] ${c.label} : attendu ${c.expected} → ${c.actual}`);
  l.push('');
  for (const a of d.accounts) {
    l.push(`COMPTE ${a.accountId}`);
    const c = a.counters as Record<string, unknown>;
    l.push(`  Documents évalués ${c.documents} · sans bien ${c.withoutPrimaryAsset} · cartes « À quel bien » ouvertes ${c.documentsWithOpenLinkAssetCard} · couverts par une carte groupée ${c.documentsCoveredByOpenGroupCard}`);
    l.push(`  Preuves croisées transmises ${c.crossDocumentSent} · sortie croisée absente ${c.crossDocumentOutputMissing} · pannes techniques ${c.technicalFailures} · cartes nées d’une panne encore ouvertes ${c.openCardsBornFromTechnicalFailure}`);
    l.push(`  Branches ${JSON.stringify(c.byBranch)} · motifs ${JSON.stringify(c.byReasonCode)}`);
    const ig = (a.lastRun?.identityGroups ?? null) as { status?: string; state?: string; error?: string | null } | null;
    l.push(`  Dernier passage T3 : ${a.lastRun ? `${a.lastRun.status} / ${a.lastRun.outcome ?? '∅'} (${a.lastRun.finishedAt ?? 'en cours'})` : 'aucun'} · phase identités : ${ig ? `${ig.state ?? ig.status}${ig.error ? ` — ${ig.error}` : ''}` : '∅'}`);
    const sup = a.supervision.filter((s) => s.status === 'open');
    l.push(`  Supervision (incidents ouverts) : ${sup.length ? sup.map((s) => s.title).join(' | ') : 'aucun'}`);
    if (a.documents) {
      l.push('  id | titre | sans bien ? | statut / motif | branche | groupes | candidats | preuves croisées | carte avant → après | projection | cohérence');
      for (const x of a.documents) {
        const e = (x.evaluation ?? {}) as Record<string, unknown>;
        const r = (x.resolution ?? {}) as Record<string, unknown>;
        const groupes = x.groups.map((g) => `${g.family}:${g.status}:${g.role}`).join(', ') || '—';
        const cands = ((r.candidates as Array<{ assetId: number; label: string }> | undefined) ?? []).map((k) => `${k.label}#${k.assetId}`).join(', ') || '—';
        const cr = e.crossDocument as { reasons?: string[]; blocked?: boolean } | null | undefined;
        const ouvertes = x.cards.filter((k) => !k.resolvedAt).map((k) => `${k.rule}#${k.id}`).join(', ') || 'aucune';
        const proj = e.projection as { actor?: string; assets?: Array<{ assetId: number; status: string; evidence: number | null }> } | undefined;
        l.push(`  ${x.fileId} | ${x.title ?? '—'} | ${x.primaryAssetIds.length ? `non (bien ${x.primaryAssetIds.join(', ')})` : 'oui'} | ${r.status ?? '—'} / ${r.reasonCode ?? '—'} | ${e.branch ?? '—'} | ${groupes} | ${cands}`
          + ` | ${e.crossDocumentSent ? `oui${cr?.reasons?.length ? ` (${cr.reasons.join(', ')})` : ''}` : 'non'} | ${e.cardBefore ?? 'aucune'} → ${ouvertes} (${e.toProcessAction ?? '—'})`
          + ` | ${proj ? `${proj.actor} ${proj.assets?.map((p) => `${p.assetId}:${p.status}${p.evidence !== null ? `(${p.evidence})` : ''}`).join(', ')}` : '—'} | ${x.coherence ? `${x.coherence.lastResult}${x.coherence.anomaly ? ` ${x.coherence.anomaly}` : ''}` : '—'}`);
      }
    }
    l.push('');
  }
  for (const n of d.notes) l.push(`Note : ${n}`);
  return `${l.join('\n')}\n`;
}
