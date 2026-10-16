/**
 * Réévaluation RÉTROACTIVE des cartes « À traiter » documentaires — lot 61
 * (ticket « [P1] Fiabiliser la pertinence des cartes », §6 ; ticket « BUG P1
 * — écarts résiduels du lot 58B », livraison « réévaluation des cartes
 * existantes en préproduction »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE CAMPAGNE, PAR LOTS, AVEC BILAN AVANT / APRÈS
 *
 * Exécutée par la tâche planifiée INTERNE `to-process-relevance-reevaluation`
 * (lot 25 : toutes les heures, premier passage 9 minutes après le démarrage)
 * — aucune commande, aucun SQL pour l'exploitation. Une campagne :
 *   · photographie les cartes documentaires actives par règle (AVANT) ;
 *   · parcourt les cartes actives par identifiant croissant (curseur en
 *     base : reprise après redémarrage), par lots bornés ;
 *   · réévalue chaque document avec la décision centrale du pont
 *     (`syncDocumentRulesFromState`, déclencheur BACKFILL) : résolution
 *     automatique, pertinence, intervention réelle, report ;
 *   · consigne l'issue de CHAQUE carte (conservée, résolue automatiquement,
 *     différée, retirée faute de pertinence, remplacée par l'action réelle,
 *     en erreur) — aucune suppression physique, la décision de l'utilisateur
 *     reste ;
 *   · photographie les cartes actives à la fin (APRÈS).
 * Le BO (File d'attente IA › Pertinence « À traiter ») affiche le bilan et
 * permet de relancer une campagne.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { DOCUMENT_RULE_ENGINE_VERSION } from './document-field-evidence';
import { documentBridgeRules } from './rules-catalog';
import { INTERVENTION_RULE_CODE } from './document-intervention';

export const DEFAULT_RELEVANCE_CAMPAIGN = 'l61-pertinence-1';
/** Cartes examinées par lot. */
const BATCH = 100;

export type CampaignOutcome = 'KEPT' | 'AUTO_RESOLVED' | 'DEFERRED' | 'REMOVED' | 'REPLACED_BY_INTERVENTION' | 'RESOLVED_ELSEWHERE' | 'ERROR';

type Raw = Record<string, unknown>;
const q = async (sql: string, params: unknown[] = []): Promise<Raw[]> => (await pgClient.unsafe(sql, params as never[])) as unknown as Raw[];

/** Règles examinées : règles du pont documentaire et cartes d'intervention. */
export const campaignRuleCodes = () => [...documentBridgeRules().map((r) => r.code), INTERVENTION_RULE_CODE];

export async function campaignTablesReady(): Promise<boolean> {
  try {
    const [r] = await q(`SELECT to_regclass('to_process_relevance_campaigns') IS NOT NULL AND to_regclass('to_process_relevance_campaign_items') IS NOT NULL AS ok`);
    return r?.ok === true;
  } catch { return false; }
}

/** Cartes documentaires actives par règle (tous comptes). */
async function activeCounts(): Promise<Record<string, number>> {
  const rows = await q(
    `SELECT rule_code, count(*)::int AS n FROM to_process_actions
      WHERE target_type = 'DOCUMENT' AND resolved_at IS NULL AND rule_code = ANY($1::text[]) GROUP BY rule_code`,
    [campaignRuleCodes()],
  );
  return Object.fromEntries(rows.map((r) => [String(r.rule_code), Number(r.n)]));
}

/**
 * Issue d'une carte après réévaluation (pure) : à partir de son état et de
 * la trace de sa fermeture.
 */
export function campaignOutcomeOf(card: { open: boolean; resolutionReason: string | null; closeDetailReason: string | null; error: boolean }): CampaignOutcome {
  if (card.error) return 'ERROR';
  if (card.open) return 'KEPT';
  switch (card.closeDetailReason) {
    case 'AUTO_RESOLVED': return 'AUTO_RESOLVED';
    case 'DEFERRED': return 'DEFERRED';
    case 'REPLACED_BY_INTERVENTION': return 'REPLACED_BY_INTERVENTION';
    case 'NO_ACTION_NEEDED': case 'USER_DECISION_RESPECTED': case 'NOT_RELEVANT_ANYMORE': case 'NOT_RELEVANT': case 'DATA_QUESTION':
      return 'REMOVED';
    default:
      return card.resolutionReason === 'OBSOLETE' && !card.closeDetailReason ? 'REMOVED' : 'RESOLVED_ELSEWHERE';
  }
}

export interface CampaignRunResult {
  disabled?: boolean;
  campaignId: number | null;
  code: string | null;
  examined: number;
  done: boolean;
  more: boolean;
  outcomes: Record<string, number>;
  errors: number;
}

/** Démarre (ou retrouve) une campagne ; photographie AVANT. */
export async function startRelevanceCampaign(p: { code?: string; trigger?: string; requestedBy?: number | null } = {}): Promise<{ id: number; code: string } | null> {
  if (!(await campaignTablesReady())) return null;
  const code = p.code ?? DEFAULT_RELEVANCE_CAMPAIGN;
  const avant = await activeCounts();
  await q(
    `INSERT INTO to_process_relevance_campaigns (code, engine_version, trigger_code, requested_by, before_counts)
     VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (code) DO NOTHING`,
    [code, DOCUMENT_RULE_ENGINE_VERSION, p.trigger ?? 'schedule', p.requestedBy ?? null, JSON.stringify(avant)],
  );
  const [r] = await q(`SELECT id FROM to_process_relevance_campaigns WHERE code = $1`, [code]);
  return r ? { id: Number(r.id), code } : null;
}

/**
 * Un passage de la campagne EN COURS (la plus récente non terminée ; à
 * défaut, la campagne par défaut si elle n'a jamais tourné). S'arrête à
 * `deadline` ; `more` : il reste des cartes.
 */
export async function runRelevanceCampaign(p: { deadline: number; trigger?: string }): Promise<CampaignRunResult> {
  const vide: CampaignRunResult = { campaignId: null, code: null, examined: 0, done: false, more: false, outcomes: {}, errors: 0 };
  if (!(await campaignTablesReady())) return { ...vide, disabled: true };
  let [c] = await q(`SELECT id, code, cursor_action_id FROM to_process_relevance_campaigns WHERE status = 'RUNNING' ORDER BY id DESC LIMIT 1`);
  if (!c) {
    const [defaut] = await q(`SELECT id FROM to_process_relevance_campaigns WHERE code = $1`, [DEFAULT_RELEVANCE_CAMPAIGN]);
    if (defaut) return { ...vide, done: true };
    const cree = await startRelevanceCampaign({ trigger: p.trigger });
    if (!cree) return { ...vide, disabled: true };
    [c] = await q(`SELECT id, code, cursor_action_id FROM to_process_relevance_campaigns WHERE id = $1`, [cree.id]);
  }
  const campaignId = Number(c.id);
  const code = String(c.code);
  let cursor = Number(c.cursor_action_id);
  const { syncDocumentRulesFromState } = await import('./document-rule-bridge');
  const outcomes: Record<string, number> = {};
  let examined = 0;
  let errors = 0;
  let errorSample: string | null = null;

  while (Date.now() < p.deadline) {
    const lot = await q(
      `SELECT id, account_id, target_id, rule_code, action_kind FROM to_process_actions
        WHERE target_type = 'DOCUMENT' AND resolved_at IS NULL AND rule_code = ANY($1::text[]) AND id > $2
        ORDER BY id LIMIT $3`,
      [campaignRuleCodes(), cursor, BATCH],
    );
    if (lot.length === 0) {
      await q(
        `UPDATE to_process_relevance_campaigns SET status = 'DONE', finished_at = now(), last_run_at = now(), runs = runs + 1,
                after_counts = $2::jsonb WHERE id = $1`,
        [campaignId, JSON.stringify(await activeCounts())],
      );
      return { campaignId, code, examined, done: true, more: false, outcomes, errors };
    }
    // Un document à la fois (toutes ses règles), isolé par compte.
    const docs = new Map<string, { accountId: number; fileId: number }>();
    for (const a of lot) docs.set(`${a.account_id}:${a.target_id}`, { accountId: Number(a.account_id), fileId: Number(a.target_id) });
    const erreurs = new Map<string, string>();
    for (const d of docs.values()) {
      const r = await syncDocumentRulesFromState(d.accountId, d.fileId, { reason: 'OBSOLETE', create: false, trigger: 'BACKFILL', runRef: `campaign:${code}` });
      for (const e of r.errorDetails) {
        erreurs.set(`${d.accountId}:${d.fileId}:${e.ruleCode}`, `${e.step} — ${e.cause}`);
        errorSample ??= `compte ${d.accountId} · document ${d.fileId} · ${e.ruleCode} · ${e.step} — ${e.cause}`.slice(0, 500);
      }
    }
    const ids = lot.map((a) => Number(a.id));
    const etats = await q(
      `SELECT a.id, a.resolved_at IS NULL AS open, a.resolution_reason,
              (SELECT ev.details ->> 'reason' FROM to_process_action_events ev WHERE ev.action_id = a.id ORDER BY ev.id DESC LIMIT 1) AS detail
         FROM to_process_actions a WHERE a.id = ANY($1::int[])`,
      [ids],
    );
    const parId = new Map(etats.map((e) => [Number(e.id), e]));
    const lignes: unknown[][] = [];
    for (const a of lot) {
      const e = parId.get(Number(a.id));
      const cle = `${a.account_id}:${a.target_id}`;
      const enErreur = [...erreurs.keys()].some((k) => k.startsWith(`${cle}:`) && k.endsWith(`:${a.rule_code}`)) && e?.open === true;
      const issue = campaignOutcomeOf({
        open: e?.open === true, resolutionReason: (e?.resolution_reason as string) ?? null, closeDetailReason: (e?.detail as string) ?? null, error: enErreur,
      });
      outcomes[issue] = (outcomes[issue] ?? 0) + 1;
      if (issue === 'ERROR') errors += 1;
      lignes.push([campaignId, Number(a.id), Number(a.account_id), Number(a.target_id), String(a.rule_code), String(a.action_kind), issue,
        enErreur ? [...erreurs.entries()].find(([k]) => k.startsWith(`${cle}:`))?.[1]?.slice(0, 300) ?? null : ((e?.detail as string) ?? (e?.resolution_reason as string) ?? null)]);
    }
    for (const l of lignes) {
      await q(
        `INSERT INTO to_process_relevance_campaign_items (campaign_id, action_id, account_id, file_id, rule_code, kind_before, outcome, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (campaign_id, action_id) DO NOTHING`,
        l,
      );
    }
    examined += lot.length;
    cursor = Math.max(...ids);
    await q(
      `UPDATE to_process_relevance_campaigns
          SET cursor_action_id = $2, last_run_at = now(), runs = runs + 1, error_sample = COALESCE($4, error_sample),
              outcomes = (SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb) FROM (
                SELECT k, sum(v)::int AS v FROM (
                  SELECT key AS k, value::int AS v FROM jsonb_each_text(outcomes)
                  UNION ALL SELECT key, value::int FROM jsonb_each_text($3::jsonb)) t GROUP BY k) z)
        WHERE id = $1`,
      [campaignId, cursor, JSON.stringify({ examined: lot.length, ...countOf(lignes.map((l) => String(l[6]))) }), errorSample],
    );
  }
  return { campaignId, code, examined, done: false, more: true, outcomes, errors };
}

const countOf = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});

export interface CampaignView {
  id: number; code: string; status: string; trigger: string; engineVersion: string; startedAt: string; finishedAt: string | null;
  lastRunAt: string | null; runs: number; before: Record<string, number>; after: Record<string, number> | null;
  outcomes: Record<string, number>; errorSample: string | null;
}

/** Campagnes récentes et issues d'une campagne (BO). */
export async function listRelevanceCampaigns(limit = 10): Promise<CampaignView[]> {
  if (!(await campaignTablesReady())) return [];
  const rows = await q(`SELECT * FROM to_process_relevance_campaigns ORDER BY id DESC LIMIT $1`, [Math.max(1, Math.min(50, limit))]);
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  const obj = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
  return rows.map((r) => ({
    id: Number(r.id), code: String(r.code), status: String(r.status), trigger: String(r.trigger_code), engineVersion: String(r.engine_version),
    startedAt: iso(r.started_at)!, finishedAt: iso(r.finished_at), lastRunAt: iso(r.last_run_at), runs: Number(r.runs),
    before: obj<Record<string, number>>(r.before_counts) ?? {}, after: r.after_counts ? obj<Record<string, number>>(r.after_counts) : null,
    outcomes: obj<Record<string, number>>(r.outcomes) ?? {}, errorSample: (r.error_sample as string | null) ?? null,
  }));
}

export async function listCampaignItems(campaignId: number, f: { accountId?: number | null; outcome?: string | null; limit?: number } = {}) {
  if (!(await campaignTablesReady())) return [];
  const rows = await q(
    `SELECT action_id, account_id, file_id, rule_code, kind_before, outcome, reason, created_at FROM to_process_relevance_campaign_items
      WHERE campaign_id = $1 AND ($2::int IS NULL OR account_id = $2) AND ($3::text IS NULL OR outcome = $3)
      ORDER BY id DESC LIMIT $4`,
    [campaignId, f.accountId ?? null, f.outcome ?? null, Math.max(1, Math.min(200, f.limit ?? 50))],
  );
  return rows.map((r) => ({
    actionId: Number(r.action_id), accountId: Number(r.account_id), fileId: Number(r.file_id), ruleCode: String(r.rule_code),
    kindBefore: (r.kind_before as string) ?? null, outcome: String(r.outcome), reason: (r.reason as string) ?? null,
    createdAt: new Date(r.created_at as string).toISOString(),
  }));
}
