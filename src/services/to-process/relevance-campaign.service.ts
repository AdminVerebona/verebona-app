/**
 * Réévaluation RÉTROACTIVE des cartes « À traiter » — lot 61 (ticket « [P1]
 * Fiabiliser la pertinence des cartes », §6 ; ticket « BUG P1 — écarts
 * résiduels du lot 58B »), étendue au lot 72 (ticket « [P1] À traiter —
 * Corriger les écarts résiduels », C6).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE CAMPAGNE, PAR LOTS, AVEC BILAN AVANT / APRÈS
 *
 * Exécutée par la tâche planifiée INTERNE `to-process-relevance-reevaluation`
 * (lot 25 : toutes les heures, premier passage 9 minutes après le démarrage)
 * — aucune commande, aucun SQL pour l'exploitation. Une campagne :
 *   · photographie les cartes actives par règle (AVANT) ;
 *   · PHASE CARTES — parcourt les cartes actives par identifiant croissant
 *     (curseur en base : reprise après redémarrage), par lots bornés, et les
 *     réévalue avec la décision de la PRODUCTION COURANTE :
 *       - documents : `syncDocumentRulesFromState` (pont documentaire,
 *         déclencheur BACKFILL) ;
 *       - lot 72 (C6) — agenda (DATA-AGENDA-DATE), équipements
 *         (LINK-EQUIP-ASSET), fournisseurs (SUPPLIER-IDENTITY) : mêmes
 *         producteurs que le balayage, restreints aux cibles du lot, avec le
 *         contrôle d'admissibilité commun (C4) ;
 *   · PHASE DÉCISIONS (lot 72, C6) — documents SANS carte dont la dernière
 *     décision (aucune intervention, différée, valeur calculée) a été prise
 *     par une version antérieure du moteur : réévalués avec les critères
 *     actuels (ancienneté jamais preuve — C2 ; calculs fiables — C1). Curseur
 *     propre (document), même reprise ;
 *   · consigne l'issue de CHAQUE carte et de chaque décision réévaluée —
 *     aucune suppression physique, la décision de l'utilisateur reste ;
 *   · bilan par issue ET par règle (famille = type de cible de la règle),
 *     erreurs et éléments restants visibles (BO) ;
 *   · photographie les cartes actives à la fin (APRÈS).
 * Isolation : chaque cible est réévaluée dans SON compte (identifiants lus
 * sur la carte / la décision), jamais d'un compte à l'autre.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { DOCUMENT_RULE_ENGINE_VERSION } from './document-field-evidence';
import { documentBridgeRules, getRule } from './rules-catalog';
import { INTERVENTION_RULE_CODE } from './document-intervention';

/** Lot 72 : nouvelle campagne par défaut (démarrée automatiquement au déploiement). */
export const DEFAULT_RELEVANCE_CAMPAIGN = 'l72-pertinence-1';
/** Cartes (ou documents) examinés par lot. */
const BATCH = 100;

export type CampaignOutcome = 'KEPT' | 'AUTO_RESOLVED' | 'DEFERRED' | 'REMOVED' | 'REPLACED_BY_INTERVENTION' | 'RESOLVED_ELSEWHERE' | 'ERROR'
  /** Phase décisions (lot 72) : décision sans carte confirmée, carte devenue justifiée. */
  | 'NO_CARD' | 'CREATED';

type Raw = Record<string, unknown>;
const q = async (sql: string, params: unknown[] = []): Promise<Raw[]> => (await pgClient.unsafe(sql, params as never[])) as unknown as Raw[];

/** Lot 72 (C6) : familles « état de la base » soumises au contrôle d'admissibilité commun. */
export const STATE_SCAN_CAMPAIGN_RULES = ['DATA-AGENDA-DATE', 'LINK-EQUIP-ASSET', 'SUPPLIER-IDENTITY'] as const;

/** Règles examinées : pont documentaire, cartes d'intervention, familles « état » (lot 72). */
export const campaignRuleCodes = (multiFamilles = true) => [
  ...documentBridgeRules().map((r) => r.code), INTERVENTION_RULE_CODE, ...(multiFamilles ? STATE_SCAN_CAMPAIGN_RULES : []),
];

/** Famille d'une règle (type de cible). */
export const familyOfRule = (code: string) => getRule(code)?.targetType ?? 'DOCUMENT';

export async function campaignTablesReady(): Promise<boolean> {
  try {
    const [r] = await q(`SELECT to_regclass('to_process_relevance_campaigns') IS NOT NULL AND to_regclass('to_process_relevance_campaign_items') IS NOT NULL AS ok`);
    return r?.ok === true;
  } catch { return false; }
}

/** Colonnes multi-familles du lot 72 (0517) présentes ? */
export async function campaignMultiFamilyReady(): Promise<boolean> {
  try {
    const [r] = await q(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                                          AND table_name = 'to_process_relevance_campaigns' AND column_name = 'outcomes_by_rule') AS ok`);
    return r?.ok === true;
  } catch { return false; }
}

/** Cartes actives par règle (tous comptes, toutes familles examinées). */
async function activeCounts(multi: boolean): Promise<Record<string, number>> {
  const rows = await q(
    `SELECT rule_code, count(*)::int AS n FROM to_process_actions
      WHERE resolved_at IS NULL AND rule_code = ANY($1::text[]) ${multi ? '' : `AND target_type = 'DOCUMENT'`} GROUP BY rule_code`,
    [campaignRuleCodes(multi)],
  );
  return Object.fromEntries(rows.map((r) => [String(r.rule_code), Number(r.n)]));
}

/** Motifs de fermeture (événement) qui retirent une carte faute de pertinence. */
const RETIREES = ['NO_ACTION_NEEDED', 'USER_DECISION_RESPECTED', 'NOT_RELEVANT_ANYMORE', 'NOT_RELEVANT', 'DATA_QUESTION',
  // Lot 72 (C4) — familles « état » : motifs de l'admissibilité.
  'INFORMATIONAL_EVENT', 'EQUIPMENT_INACTIVE', 'SAME_VALUE_AS_CURRENT', 'NO_EXPLOITABLE_PROPOSAL',
  'NO_REAL_PROBLEM', 'NOT_NEEDED', 'NO_USER_ACTION_NEEDED', 'CONTRACT_TERMINATED'];
const RESOLUES_AILLEURS = ['DATA_PRESENT_OR_EVENT_CLOSED', 'ATTACHED_ELSEWHERE', 'ALREADY_SATISFIED', 'COMPLETED_ELSEWHERE'];

/**
 * Issue d'une carte après réévaluation (pure) : à partir de son état et de
 * la trace de sa fermeture.
 */
export function campaignOutcomeOf(card: { open: boolean; resolutionReason: string | null; closeDetailReason: string | null; error: boolean; closeDetailOutcome?: string | null }): CampaignOutcome {
  if (card.error) return 'ERROR';
  if (card.open) return 'KEPT';
  switch (card.closeDetailReason) {
    case 'AUTO_RESOLVED': return 'AUTO_RESOLVED';
    case 'DEFERRED': case 'NOT_NOW': case 'QUALIFICATION_PENDING': case 'NO_LIVE_ASSET_TO_ATTACH': return 'DEFERRED';
    case 'REPLACED_BY_INTERVENTION': return 'REPLACED_BY_INTERVENTION';
    default:
      if (card.closeDetailReason && RETIREES.includes(card.closeDetailReason)) return 'REMOVED';
      if (card.closeDetailOutcome === 'NO_ACTION') return 'REMOVED';
      if (card.closeDetailOutcome === 'DEFER') return 'DEFERRED';
      if (card.closeDetailReason && RESOLUES_AILLEURS.includes(card.closeDetailReason)) return 'RESOLVED_ELSEWHERE';
      return card.resolutionReason === 'OBSOLETE' && !card.closeDetailReason ? 'REMOVED' : 'RESOLVED_ELSEWHERE';
  }
}

/** Issue d'une décision réévaluée sans carte (phase décisions, pure). */
export function decisionCampaignOutcome(outcome: string | null | undefined): CampaignOutcome {
  switch (outcome) {
    case 'AUTO_RESOLVED': return 'AUTO_RESOLVED';
    case 'DEFER': return 'DEFERRED';
    case 'CREATE_ACTION': return 'CREATED';
    case 'KEEP': return 'KEPT';
    case 'ERROR': return 'ERROR';
    default: return 'NO_CARD';
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
  /** Lot 72 : phase en cours (CARDS, DECISIONS). */
  phase?: string;
}

/** Démarre (ou retrouve) une campagne ; photographie AVANT. */
export async function startRelevanceCampaign(p: { code?: string; trigger?: string; requestedBy?: number | null } = {}): Promise<{ id: number; code: string } | null> {
  if (!(await campaignTablesReady())) return null;
  const code = p.code ?? DEFAULT_RELEVANCE_CAMPAIGN;
  const avant = await activeCounts(await campaignMultiFamilyReady());
  await q(
    `INSERT INTO to_process_relevance_campaigns (code, engine_version, trigger_code, requested_by, before_counts)
     VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (code) DO NOTHING`,
    [code, DOCUMENT_RULE_ENGINE_VERSION, p.trigger ?? 'schedule', p.requestedBy ?? null, JSON.stringify(avant)],
  );
  const [r] = await q(`SELECT id FROM to_process_relevance_campaigns WHERE code = $1`, [code]);
  return r ? { id: Number(r.id), code } : null;
}

const countOf = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});

/** Ligne d'issue (carte ou décision) à consigner. */
interface ItemRow {
  actionId: number | null; accountId: number; targetType: string; targetId: number; ruleCode: string; kindBefore: string | null;
  outcome: CampaignOutcome; reason: string | null; phase: 'CARDS' | 'DECISIONS';
}

async function consigner(campaignId: number, lignes: ItemRow[], multi: boolean, errorSample: string | null, cursor: { action?: number; file?: number; phase?: string }): Promise<void> {
  for (const l of lignes) {
    if (multi) {
      await q(
        `INSERT INTO to_process_relevance_campaign_items (campaign_id, action_id, account_id, file_id, rule_code, kind_before, outcome, reason, target_type, target_id, phase)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING`,
        [campaignId, l.actionId, l.accountId, l.targetType === 'DOCUMENT' ? l.targetId : null, l.ruleCode, l.kindBefore, l.outcome, l.reason?.slice(0, 300) ?? null,
          l.targetType, l.targetId, l.phase],
      );
    } else {
      await q(
        `INSERT INTO to_process_relevance_campaign_items (campaign_id, action_id, account_id, file_id, rule_code, kind_before, outcome, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (campaign_id, action_id) DO NOTHING`,
        [campaignId, l.actionId, l.accountId, l.targetId, l.ruleCode, l.kindBefore, l.outcome, l.reason?.slice(0, 300) ?? null],
      );
    }
  }
  const parRegle: Record<string, Record<string, number>> = {};
  for (const l of lignes) {
    parRegle[l.ruleCode] ??= {};
    parRegle[l.ruleCode][l.outcome] = (parRegle[l.ruleCode][l.outcome] ?? 0) + 1;
  }
  const params: unknown[] = [campaignId, errorSample, JSON.stringify({ examined: lignes.length, ...countOf(lignes.map((l) => l.outcome)) })];
  const sets = [
    'last_run_at = now()', 'runs = runs + 1', 'error_sample = COALESCE($2, error_sample)',
    `outcomes = (SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb) FROM (
       SELECT k, sum(v)::int AS v FROM (
         SELECT key AS k, value::int AS v FROM jsonb_each_text(outcomes)
         UNION ALL SELECT key, value::int FROM jsonb_each_text($3::jsonb)) t GROUP BY k) z)`,
  ];
  const ajouter = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (cursor.action !== undefined) sets.push(`cursor_action_id = ${ajouter(cursor.action)}`);
  if (multi) {
    const pr = ajouter(JSON.stringify(parRegle));
    sets.push(`outcomes_by_rule = (SELECT COALESCE(jsonb_object_agg(r, x), '{}'::jsonb) FROM (
        SELECT r, (SELECT jsonb_object_agg(k, v) FROM (
            SELECT k, sum(v)::int AS v FROM (
              SELECT key AS k, value::int AS v FROM jsonb_each_text(COALESCE(outcomes_by_rule -> r, '{}'::jsonb))
              UNION ALL SELECT key, value::int FROM jsonb_each_text(COALESCE(${pr}::jsonb -> r, '{}'::jsonb))) t GROUP BY k) y) AS x
          FROM (SELECT jsonb_object_keys(outcomes_by_rule) AS r UNION SELECT jsonb_object_keys(${pr}::jsonb)) rr) z)`);
    if (cursor.file !== undefined) sets.push(`cursor_file_id = ${ajouter(cursor.file)}`);
    if (cursor.phase) sets.push(`phase = ${ajouter(cursor.phase === 'DECISIONS' ? 'DECISIONS' : 'CARDS')}`);
  }
  await q(`UPDATE to_process_relevance_campaigns SET ${sets.join(', ')} WHERE id = $1`, params);
}

/**
 * Phase CARTES — un lot de cartes actives (id > curseur), réévaluées par la
 * décision de production de LEUR famille. Rend les issues.
 */
async function lotCartes(campaignId: number, code: string, cursor: number, multi: boolean): Promise<{ lignes: ItemRow[]; next: number | null; errorSample: string | null }> {
  const lot = await q(
    `SELECT id, account_id, target_type, target_id, rule_code, action_kind FROM to_process_actions
      WHERE resolved_at IS NULL AND rule_code = ANY($1::text[]) AND id > $2 ${multi ? '' : `AND target_type = 'DOCUMENT'`}
      ORDER BY id LIMIT $3`,
    [campaignRuleCodes(multi), cursor, BATCH],
  );
  if (lot.length === 0) return { lignes: [], next: null, errorSample: null };
  const { syncDocumentRulesFromState } = await import('./document-rule-bridge');
  const producteurs = await import('./producers.service');
  const erreurs = new Map<string, string>();
  let errorSample: string | null = null;
  const runRef = `campaign:${code}`;

  // Documents : un document à la fois (toutes ses règles), isolé par compte.
  const docs = new Map<string, { accountId: number; fileId: number }>();
  // Familles « état » : par compte et famille, restreintes aux cibles du lot.
  const etats = new Map<string, { accountId: number; family: string; ids: number[] }>();
  for (const a of lot) {
    const accountId = Number(a.account_id);
    if (a.target_type === 'DOCUMENT') docs.set(`${accountId}:${a.target_id}`, { accountId, fileId: Number(a.target_id) });
    else {
      const k = `${accountId}:${a.target_type}`;
      const e = etats.get(k) ?? { accountId, family: String(a.target_type), ids: [] };
      e.ids.push(Number(a.target_id));
      etats.set(k, e);
    }
  }
  for (const d of docs.values()) {
    const r = await syncDocumentRulesFromState(d.accountId, d.fileId, { reason: 'OBSOLETE', create: false, trigger: 'BACKFILL', runRef });
    for (const e of r.errorDetails) {
      erreurs.set(`${d.accountId}:DOCUMENT:${d.fileId}:${e.ruleCode}`, `${e.step} — ${e.cause}`);
      errorSample ??= `compte ${d.accountId} · document ${d.fileId} · ${e.ruleCode} · ${e.step} — ${e.cause}`.slice(0, 500);
    }
  }
  for (const e of etats.values()) {
    const opts = { trigger: 'BACKFILL' as const, runRef, only: e.ids };
    const regle = e.family === 'AGENDA_ITEM' ? 'DATA-AGENDA-DATE' : e.family === 'EQUIPMENT' ? 'LINK-EQUIP-ASSET' : 'SUPPLIER-IDENTITY';
    try {
      if (e.family === 'AGENDA_ITEM') await producteurs.produceAgendaActions(e.accountId, opts);
      else if (e.family === 'EQUIPMENT') await producteurs.produceEquipmentActions(e.accountId, opts);
      else if (e.family === 'SUPPLIER') await producteurs.produceSupplierActions(e.accountId, opts);
    } catch (err) {
      const cause = String((err as Error).message).slice(0, 300);
      for (const id of e.ids) erreurs.set(`${e.accountId}:${e.family}:${id}:${regle}`, `EXECUTE — ${cause}`);
      errorSample ??= `compte ${e.accountId} · ${e.family} · ${regle} — ${cause}`.slice(0, 500);
    }
  }

  const ids = lot.map((a) => Number(a.id));
  const etatsCartes = await q(
    `SELECT a.id, a.resolved_at IS NULL AS open, a.resolution_reason,
            (SELECT ev.details ->> 'reason' FROM to_process_action_events ev WHERE ev.action_id = a.id ORDER BY ev.id DESC LIMIT 1) AS detail,
            (SELECT ev.details ->> 'outcome' FROM to_process_action_events ev WHERE ev.action_id = a.id ORDER BY ev.id DESC LIMIT 1) AS detail_outcome
       FROM to_process_actions a WHERE a.id = ANY($1::int[])`,
    [ids],
  );
  const parId = new Map(etatsCartes.map((e) => [Number(e.id), e]));
  const lignes: ItemRow[] = lot.map((a) => {
    const e = parId.get(Number(a.id));
    const cle = `${a.account_id}:${a.target_type}:${a.target_id}:${a.rule_code}`;
    const erreur = erreurs.get(cle) ?? (a.rule_code === INTERVENTION_RULE_CODE
      ? [...erreurs.entries()].find(([k]) => k.startsWith(`${a.account_id}:DOCUMENT:${a.target_id}:`))?.[1] : undefined);
    const enErreur = !!erreur && e?.open === true;
    const outcome = campaignOutcomeOf({
      open: e?.open === true, resolutionReason: (e?.resolution_reason as string) ?? null, closeDetailReason: (e?.detail as string) ?? null,
      closeDetailOutcome: (e?.detail_outcome as string) ?? null, error: enErreur,
    });
    return {
      actionId: Number(a.id), accountId: Number(a.account_id), targetType: String(a.target_type), targetId: Number(a.target_id), ruleCode: String(a.rule_code),
      kindBefore: (a.action_kind as string) ?? null, outcome, phase: 'CARDS',
      reason: enErreur ? erreur!.slice(0, 300) : ((e?.detail as string) ?? (e?.resolution_reason as string) ?? null),
    };
  });
  return { lignes, next: Math.max(...ids), errorSample };
}

/**
 * Phase DÉCISIONS (lot 72, C6) — documents dont la DERNIÈRE décision d'une
 * règle, sans carte active, a été prise par une version antérieure du
 * moteur (aucune intervention, différée, valeur calculée) : réévalués par la
 * décision courante (création permise : même décision que la production).
 */
async function lotDecisions(code: string, cursorFile: number): Promise<{ lignes: ItemRow[]; next: number | null; errorSample: string | null }> {
  const [t] = await q(`SELECT to_regclass('document_rule_evaluations') IS NOT NULL AS ok,
                              EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                                       AND table_name = 'document_rule_evaluations' AND column_name = 'outcome') AS l61`);
  if (!t?.ok || !t.l61) return { lignes: [], next: null, errorSample: null };
  const regles = documentBridgeRules().filter((r) => r.fieldKey).map((r) => r.code);
  const lot = await q(
    `SELECT e.account_id, e.file_id, e.rule_code, e.outcome, e.reason_code FROM (
       SELECT DISTINCT ON (x.account_id, x.file_id, x.rule_code) x.account_id, x.file_id, x.rule_code, x.outcome, x.reason_code, x.engine_version
         FROM document_rule_evaluations x
        WHERE x.file_id > $1 AND x.rule_code = ANY($2::text[])
          AND x.file_id IN (SELECT DISTINCT y.file_id FROM document_rule_evaluations y
                             WHERE y.file_id > $1 AND y.engine_version IS DISTINCT FROM $3 ORDER BY y.file_id LIMIT $4)
        ORDER BY x.account_id, x.file_id, x.rule_code, x.id DESC) e
      JOIN asset_files f ON f.id = e.file_id AND f.account_id = e.account_id AND f.deleted_at IS NULL
      WHERE e.engine_version IS DISTINCT FROM $3 AND e.outcome IN ('NO_ACTION', 'DEFER', 'AUTO_RESOLVED')
        AND NOT EXISTS (SELECT 1 FROM to_process_actions a WHERE a.account_id = e.account_id AND a.target_type = 'DOCUMENT'
                          AND a.target_id = e.file_id AND a.resolved_at IS NULL AND a.rule_code = e.rule_code)
      ORDER BY e.file_id`,
    [cursorFile, regles, DOCUMENT_RULE_ENGINE_VERSION, BATCH],
  );
  // Fin de phase : plus aucun document au-delà du curseur portant une décision antérieure.
  const [suite] = await q(
    `SELECT max(file_id) AS m FROM (SELECT DISTINCT y.file_id FROM document_rule_evaluations y
                                     WHERE y.file_id > $1 AND y.engine_version IS DISTINCT FROM $2 ORDER BY y.file_id LIMIT $3) z`,
    [cursorFile, DOCUMENT_RULE_ENGINE_VERSION, BATCH],
  );
  const next = suite?.m == null ? null : Number(suite.m);
  if (lot.length === 0) return { lignes: [], next, errorSample: null };
  const { syncDocumentRulesFromState } = await import('./document-rule-bridge');
  const docs = new Map<string, { accountId: number; fileId: number; rules: Array<{ rule: string; before: string }> }>();
  for (const e of lot) {
    const k = `${e.account_id}:${e.file_id}`;
    const d = docs.get(k) ?? { accountId: Number(e.account_id), fileId: Number(e.file_id), rules: [] };
    d.rules.push({ rule: String(e.rule_code), before: `${e.outcome}:${e.reason_code ?? ''}` });
    docs.set(k, d);
  }
  const lignes: ItemRow[] = [];
  let errorSample: string | null = null;
  for (const d of docs.values()) {
    const r = await syncDocumentRulesFromState(d.accountId, d.fileId, { reason: 'OBSOLETE', create: true, trigger: 'BACKFILL', runRef: `campaign:${code}` });
    for (const x of d.rules) {
      const err = r.errorDetails.find((e) => e.ruleCode === x.rule);
      if (err) errorSample ??= `compte ${d.accountId} · document ${d.fileId} · ${x.rule} · ${err.step} — ${err.cause}`.slice(0, 500);
      lignes.push({
        actionId: null, accountId: d.accountId, targetType: 'DOCUMENT', targetId: d.fileId, ruleCode: x.rule, kindBefore: x.before.slice(0, 60),
        outcome: err ? 'ERROR' : decisionCampaignOutcome(r.outcomes[x.rule]), phase: 'DECISIONS',
        reason: err ? `${err.step} — ${err.cause}` : (r.reasons[x.rule] ?? null),
      });
    }
  }
  return { lignes, next, errorSample };
}

/**
 * Un passage de la campagne EN COURS (la plus récente non terminée ; à
 * défaut, la campagne par défaut si elle n'a jamais tourné). S'arrête à
 * `deadline` ; `more` : il reste des cartes ou des décisions.
 */
export async function runRelevanceCampaign(p: { deadline: number; trigger?: string }): Promise<CampaignRunResult> {
  const vide: CampaignRunResult = { campaignId: null, code: null, examined: 0, done: false, more: false, outcomes: {}, errors: 0 };
  if (!(await campaignTablesReady())) return { ...vide, disabled: true };
  const multi = await campaignMultiFamilyReady();
  const cols = `id, code, cursor_action_id${multi ? ', cursor_file_id, phase' : ''}`;
  let [c] = await q(`SELECT ${cols} FROM to_process_relevance_campaigns WHERE status = 'RUNNING' ORDER BY id DESC LIMIT 1`);
  if (!c) {
    const [defaut] = await q(`SELECT id FROM to_process_relevance_campaigns WHERE code = $1`, [DEFAULT_RELEVANCE_CAMPAIGN]);
    if (defaut) return { ...vide, done: true };
    const cree = await startRelevanceCampaign({ trigger: p.trigger });
    if (!cree) return { ...vide, disabled: true };
    [c] = await q(`SELECT ${cols} FROM to_process_relevance_campaigns WHERE id = $1`, [cree.id]);
  }
  const campaignId = Number(c.id);
  const code = String(c.code);
  let cursor = Number(c.cursor_action_id);
  let cursorFile = Number(c.cursor_file_id ?? 0);
  let phase = multi ? String(c.phase ?? 'CARDS') : 'CARDS';
  const outcomes: Record<string, number> = {};
  let examined = 0;
  let errors = 0;

  while (Date.now() < p.deadline) {
    if (phase === 'CARDS') {
      const r = await lotCartes(campaignId, code, cursor, multi);
      if (r.next === null) {
        if (multi) { phase = 'DECISIONS'; await consigner(campaignId, [], multi, null, { phase: 'DECISIONS' }); continue; }
        break;
      }
      for (const l of r.lignes) { outcomes[l.outcome] = (outcomes[l.outcome] ?? 0) + 1; if (l.outcome === 'ERROR') errors += 1; }
      examined += r.lignes.length;
      cursor = r.next;
      await consigner(campaignId, r.lignes, multi, r.errorSample, { action: cursor });
      continue;
    }
    const r = await lotDecisions(code, cursorFile);
    if (r.next === null) break;
    for (const l of r.lignes) { outcomes[l.outcome] = (outcomes[l.outcome] ?? 0) + 1; if (l.outcome === 'ERROR') errors += 1; }
    examined += r.lignes.length;
    cursorFile = r.next;
    await consigner(campaignId, r.lignes, multi, r.errorSample, { file: cursorFile, phase: 'DECISIONS' });
  }
  if (Date.now() >= p.deadline) return { campaignId, code, examined, done: false, more: true, outcomes, errors, phase };
  await q(
    `UPDATE to_process_relevance_campaigns SET status = 'DONE', finished_at = now(), last_run_at = now(), runs = runs + 1,
            after_counts = $2::jsonb WHERE id = $1`,
    [campaignId, JSON.stringify(await activeCounts(multi))],
  );
  return { campaignId, code, examined, done: true, more: false, outcomes, errors, phase };
}

export interface CampaignView {
  id: number; code: string; status: string; trigger: string; engineVersion: string; startedAt: string; finishedAt: string | null;
  lastRunAt: string | null; runs: number; before: Record<string, number>; after: Record<string, number> | null;
  outcomes: Record<string, number>; errorSample: string | null;
  /** Lot 72 (C6) : issues par règle, familles, phase, cartes et documents restant à traiter. */
  outcomesByRule?: Record<string, Record<string, number>>;
  families?: Record<string, string>;
  phase?: string | null;
  remaining?: { cards: number; decisions: number } | null;
  errorItems?: number;
}

/** Campagnes récentes et issues d'une campagne (BO). */
export async function listRelevanceCampaigns(limit = 10): Promise<CampaignView[]> {
  if (!(await campaignTablesReady())) return [];
  const multi = await campaignMultiFamilyReady();
  const rows = await q(`SELECT * FROM to_process_relevance_campaigns ORDER BY id DESC LIMIT $1`, [Math.max(1, Math.min(50, limit))]);
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  const obj = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
  const out: CampaignView[] = [];
  for (const r of rows) {
    const before = obj<Record<string, number>>(r.before_counts) ?? {};
    const byRule = multi ? obj<Record<string, Record<string, number>>>(r.outcomes_by_rule) ?? {} : undefined;
    let remaining: CampaignView['remaining'] = null;
    if (String(r.status) === 'RUNNING') {
      const [n] = await q(
        `SELECT (SELECT count(*)::int FROM to_process_actions WHERE resolved_at IS NULL AND rule_code = ANY($1::text[]) AND id > $2
                   ${multi ? '' : `AND target_type = 'DOCUMENT'`}) AS cards`,
        [campaignRuleCodes(multi), Number(r.cursor_action_id)],
      );
      remaining = { cards: Number(n?.cards ?? 0), decisions: multi && String(r.phase) === 'DECISIONS' ? -1 : 0 };
    }
    const [e] = await q(`SELECT count(*)::int AS n FROM to_process_relevance_campaign_items WHERE campaign_id = $1 AND outcome = 'ERROR'`, [Number(r.id)]);
    const regles = [...new Set([...Object.keys(before), ...Object.keys(byRule ?? {})])];
    out.push({
      id: Number(r.id), code: String(r.code), status: String(r.status), trigger: String(r.trigger_code), engineVersion: String(r.engine_version),
      startedAt: iso(r.started_at)!, finishedAt: iso(r.finished_at), lastRunAt: iso(r.last_run_at), runs: Number(r.runs),
      before, after: r.after_counts ? obj<Record<string, number>>(r.after_counts) : null,
      outcomes: obj<Record<string, number>>(r.outcomes) ?? {}, errorSample: (r.error_sample as string | null) ?? null,
      outcomesByRule: byRule, families: Object.fromEntries(regles.map((x) => [x, familyOfRule(x)])), phase: multi ? (r.phase as string) ?? null : null,
      remaining, errorItems: Number(e?.n ?? 0),
    });
  }
  return out;
}

export async function listCampaignItems(campaignId: number, f: { accountId?: number | null; outcome?: string | null; limit?: number } = {}) {
  if (!(await campaignTablesReady())) return [];
  const multi = await campaignMultiFamilyReady();
  const rows = await q(
    `SELECT action_id, account_id, file_id, rule_code, kind_before, outcome, reason, created_at${multi ? ', target_type, target_id, phase' : ''}
       FROM to_process_relevance_campaign_items
      WHERE campaign_id = $1 AND ($2::int IS NULL OR account_id = $2) AND ($3::text IS NULL OR outcome = $3)
      ORDER BY id DESC LIMIT $4`,
    [campaignId, f.accountId ?? null, f.outcome ?? null, Math.max(1, Math.min(200, f.limit ?? 50))],
  );
  return rows.map((r) => ({
    actionId: r.action_id == null ? null : Number(r.action_id), accountId: Number(r.account_id), fileId: r.file_id == null ? null : Number(r.file_id),
    ruleCode: String(r.rule_code), kindBefore: (r.kind_before as string) ?? null, outcome: String(r.outcome), reason: (r.reason as string) ?? null,
    createdAt: new Date(r.created_at as string).toISOString(),
    targetType: (r.target_type as string) ?? 'DOCUMENT', targetId: r.target_id == null ? Number(r.file_id) : Number(r.target_id), phase: (r.phase as string) ?? 'CARDS',
  }));
}
