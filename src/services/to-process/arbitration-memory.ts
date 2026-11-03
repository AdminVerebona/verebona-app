/**
 * Lot 107D — MÉMOIRE DES ARBITRAGES TRANCHÉS PAR L'UTILISATEUR, par CONTENU
 * des preuves (ticket P1 « Draisienne : carte réapparue alors que
 * l'utilisateur avait déjà répondu »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CAUSE DÉMONTRÉE PAR LE CODE (reproduite en e2e L107D-E2E-02)
 *
 *   1. `upsertAction` ne retenait une décision passée que si elle était
 *      « Non applicable » (§7.4) : une carte tranchée (USER_ARBITRATED) ou
 *      complétée ailleurs (USER_COMPLETED) n'empêchait pas un nouveau cycle ;
 *   2. la mémoire T3 du lot 76J (`loadConflictMemory`) compare une signature
 *      qui contient les IDENTIFIANTS des preuves (`field_evidence.id`) — or
 *      une réanalyse T1, une reprojection ou une rematérialisation (prix
 *      ancré 76J, analyse avec un nouvel `analysis_run_id`) recréent la même
 *      preuve sous un nouvel identifiant (empreinte de preuve incluant
 *      l'analyse) : signature différente → même conflit → `create_conflict`
 *      MANUAL_VALUE_CONTRADICTED → nouvelle carte, cycle N+1.
 *
 * CE QUE FAIT CE MODULE
 *
 *   · clé de CONTENU d'une preuve : source (type + identifiant du document),
 *     champ canonique, valeur normalisée, cible — stable d'une réanalyse à
 *     l'autre ;
 *   · décision de l'utilisateur relue sur TOUTES les cartes tranchées du même
 *     problème (cible + propriété) : clés examinées (colonne 1025, sinon
 *     recalculées depuis `proposals_json.evidenceIds` — les preuves ne sont
 *     jamais supprimées : le stock est couvert sans migration de données) ;
 *   · verdict : mêmes preuves → aucune carte (SAME_EVIDENCE) ; même document
 *     réextrait → aucune carte (SAME_SOURCE_REEXTRACTED) ; nouvelle preuve
 *     d'un AUTRE document mais non fiable → aucune carte
 *     (NEW_EVIDENCE_NOT_RELIABLE) ; nouvelle preuve indépendante, ciblée,
 *     fiable (`certain`) → nouvel arbitrage avec motif expliqué (sources,
 *     valeurs, carte tranchée précédente) — la valeur USER n'est jamais
 *     écrasée (matrice §4.2.5 inchangée).
 * Une seule porte : `upsertAction` (toutes familles de champ) et la décision
 * T3 du bien (`guardDecisionAgainstUser`, même règle) — aucun second moteur.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { resolveAlias } from '@/services/canonical/registry';
import { normalize } from '@/services/ai/reconciliation/decision/normalizers';
import type { ReconciliationDecision } from '@/services/ai/reconciliation/types';
import type { ActionProposal } from './action-model';

/** Résolutions qui portent une DÉCISION de l'utilisateur sur la donnée. */
export const USER_DECISION_REASONS = ['USER_ARBITRATED', 'USER_COMPLETED'] as const;

export interface EvidenceKeyInfo {
  /** Clé de contenu stable. */
  key: string;
  /** Source (`document:12`, `web_link:3`, `ref:<id>`). */
  source: string;
  evidenceId: string;
  value: unknown;
  confidence: string | null;
  projectionRule: string | null;
}

export type MemoryVerdict =
  | { reopen: false; code: 'NO_USER_DECISION' }
  | { reopen: false; code: 'SAME_EVIDENCE' | 'SAME_SOURCE_REEXTRACTED' | 'NEW_EVIDENCE_NOT_RELIABLE'; decidedActionId: number; fresh: EvidenceKeyInfo[] }
  | { reopen: true; code: 'NEW_INDEPENDENT_EVIDENCE'; decidedActionId: number; sources: Array<{ source: string; evidenceId: string; value: unknown }> };

type Row = Record<string, unknown>;
type Client = { unsafe: (q: string, p?: never[]) => Promise<unknown> };
const client = async (c?: Client): Promise<Client> => c ?? ((await import('@/db')).pgClient as unknown as Client);

/** Clé de contenu d'une preuve (pure). */
export function contentKeyOf(r: { sourceType: string | null; sourceId: number | string | null; fieldKey: string; value: unknown; targetType?: string | null; targetId?: number | string | null }): string {
  const champ = resolveAlias(r.fieldKey) ?? r.fieldKey;
  const n = normalize(champ, r.value) ?? (r.value === null || r.value === undefined ? '' : JSON.stringify(r.value));
  return `${r.sourceType ?? '?'}:${r.sourceId ?? '?'}|${champ}|${n}|${r.targetType ?? 'ASSET'}:${r.targetId ?? ''}`;
}

/** Identifiants de preuve des propositions NON courantes (celles que la carte soumet). */
export const proposalEvidenceIds = (proposals: ReadonlyArray<Pick<ActionProposal, 'evidenceIds' | 'isCurrentValue'>>): string[] =>
  [...new Set(proposals.filter((p) => !p.isCurrentValue).flatMap((p) => p.evidenceIds ?? []).map(String))];

/** Clés de contenu d'un ensemble de preuves (compte vérifié). Identifiant non numérique : clé opaque. */
export async function evidenceKeyInfos(accountId: number, evidenceIds: readonly string[], c?: Client): Promise<EvidenceKeyInfo[]> {
  const ids = [...new Set(evidenceIds.map(String))];
  if (ids.length === 0) return [];
  const numeriques = ids.filter((i) => /^\d{1,12}$/.test(i)).map(Number);
  const rows = numeriques.length ? ((await (await client(c)).unsafe(
    `SELECT id, source_type, source_id, field_key, COALESCE(to_jsonb(fe) ->> 'canonical_key', field_key) AS canonical_key, value_json,
            to_jsonb(fe) ->> 'target_type' AS target_type, COALESCE((to_jsonb(fe) ->> 'target_entity_id')::bigint, asset_id) AS target_id,
            confidence, to_jsonb(fe) ->> 'projection_rule' AS projection_rule
       FROM field_evidence fe WHERE account_id = $1 AND id = ANY($2::int[])`,
    [accountId, numeriques] as never[],
  )) as Row[]) : [];
  const parId = new Map(rows.map((r) => [String(r.id), r]));
  return ids.map((id) => {
    const r = parId.get(id);
    if (!r) return { key: `ref:${id}`, source: `ref:${id}`, evidenceId: id, value: null, confidence: null, projectionRule: null };
    const fieldKey = String(r.canonical_key ?? r.field_key);
    const targetType = (r.target_type as string | null) ?? 'ASSET';
    return {
      key: contentKeyOf({ sourceType: r.source_type as string, sourceId: r.source_id as number, fieldKey, value: r.value_json, targetType, targetId: r.target_id as number }),
      source: `${String(r.source_type)}:${String(r.source_id)}`, evidenceId: id, value: r.value_json,
      confidence: (r.confidence as string | null) ?? null, projectionRule: (r.projection_rule as string | null) ?? null,
    };
  });
}

export interface UserDecisionMemory {
  /** Dernière carte tranchée par l'utilisateur. */
  actionId: number;
  resolvedAt: string;
  reason: string;
  /** Clés de contenu examinées sur TOUTES les cartes tranchées du problème. */
  keys: Set<string>;
  /** Sources (documents) examinées. */
  sources: Set<string>;
}

/** Variantes de clé d'une donnée de bien (clé canonique et alias). */
function variantes(dataKey: string): string[] {
  const canonique = resolveAlias(dataKey) ?? dataKey;
  return [...new Set([dataKey, canonique])];
}

/**
 * Décision de l'utilisateur sur un problème (cible + propriété) : cartes
 * résolues USER_ARBITRATED / USER_COMPLETED, clés examinées (colonne 1025,
 * sinon recalculées). `null` : aucune décision.
 */
export async function loadUserDecisionMemory(accountId: number, targetType: string, targetId: number, dataKey: string, c?: Client): Promise<UserDecisionMemory | null> {
  const sql = await client(c);
  const rows = (await sql.unsafe(
    `SELECT id, resolution_reason, resolved_at, proposals_json, to_jsonb(a) -> 'evidence_keys' AS evidence_keys
       FROM to_process_actions a
      WHERE account_id = $1 AND target_type = $2 AND target_id = $3 AND COALESCE(field_key, relation_key) = ANY($4::text[])
        AND action_kind = 'ARBITRATE' AND resolved_at IS NOT NULL AND resolution_reason = ANY($5::text[])
      ORDER BY resolved_at DESC, id DESC LIMIT 20`,
    [accountId, targetType, targetId, variantes(dataKey), [...USER_DECISION_REASONS]] as never[],
  )) as Row[];
  if (rows.length === 0) return null;
  const keys = new Set<string>();
  const sources = new Set<string>();
  for (const r of rows) {
    const stockees = Array.isArray(r.evidence_keys) ? (r.evidence_keys as Array<{ key?: string; source?: string }>) : null;
    if (stockees?.length) {
      for (const k of stockees) { if (k.key) keys.add(k.key); if (k.source) sources.add(k.source); }
      continue;
    }
    const proposals = (typeof r.proposals_json === 'string' ? JSON.parse(r.proposals_json) : r.proposals_json ?? []) as ActionProposal[];
    for (const k of await evidenceKeyInfos(accountId, proposalEvidenceIds(proposals), sql)) { keys.add(k.key); sources.add(k.source); }
  }
  const last = rows[0];
  return { actionId: Number(last.id), resolvedAt: new Date(String(last.resolved_at)).toISOString(), reason: String(last.resolution_reason), keys, sources };
}

/** Verdict (pur) : la carte proposée apporte-t-elle une contradiction NOUVELLE à la décision de l'utilisateur ? */
export function judgeAgainstUserDecision(memory: UserDecisionMemory | null, infos: readonly EvidenceKeyInfo[]): MemoryVerdict {
  if (!memory) return { reopen: false, code: 'NO_USER_DECISION' };
  const fresh = infos.filter((k) => !memory.keys.has(k.key));
  if (fresh.length === 0) return { reopen: false, code: 'SAME_EVIDENCE', decidedActionId: memory.actionId, fresh: [] };
  const independantes = fresh.filter((k) => !memory.sources.has(k.source) && !k.source.startsWith('ref:'));
  if (independantes.length === 0) return { reopen: false, code: 'SAME_SOURCE_REEXTRACTED', decidedActionId: memory.actionId, fresh };
  const fiables = independantes.filter((k) => k.confidence === 'certain');
  if (fiables.length === 0) return { reopen: false, code: 'NEW_EVIDENCE_NOT_RELIABLE', decidedActionId: memory.actionId, fresh };
  return {
    reopen: true, code: 'NEW_INDEPENDENT_EVIDENCE', decidedActionId: memory.actionId,
    sources: fiables.map((k) => ({ source: k.source, evidenceId: k.evidenceId, value: k.value })),
  };
}

/** Libellés simples des verdicts (diagnostics, recette PO). */
export const MEMORY_VERDICT_LABELS: Readonly<Record<MemoryVerdict['code'], string>> = {
  NO_USER_DECISION: 'aucune décision de l’utilisateur sur cette question',
  SAME_EVIDENCE: 'mêmes preuves que celles déjà tranchées par l’utilisateur : aucune nouvelle carte',
  SAME_SOURCE_REEXTRACTED: 'même document réanalysé : ce n’est pas une nouvelle contradiction',
  NEW_EVIDENCE_NOT_RELIABLE: 'nouvelle preuve d’un autre document mais non certaine : aucune nouvelle carte',
  NEW_INDEPENDENT_EVIDENCE: 'nouvelle preuve indépendante et fiable d’un autre document : nouvel arbitrage motivé',
};

/** Clés de contenu stockées sur une carte (colonne 1025). */
export const storedKeys = (infos: readonly EvidenceKeyInfo[]) => infos.map((k) => ({ key: k.key, source: k.source, evidenceId: k.evidenceId }));

/**
 * Lot 107D — même règle pour la DÉCISION T3 d'un champ de bien : un conflit
 * déjà tranché par l'utilisateur sur les mêmes preuves (contenu) devient
 * `keep` USER_DECISION_SAME_EVIDENCE (aucune carte, aucun conflit rouvert au
 * registre). Ne lève jamais (lecture impossible : décision inchangée).
 */
export async function guardDecisionAgainstUser(accountId: number, targetType: 'ASSET' | 'EQUIPMENT' | 'ROOM', targetId: number, decision: ReconciliationDecision): Promise<ReconciliationDecision> {
  if (decision.action !== 'create_conflict') return decision;
  try {
    const { arbitrationProposals } = await import('./reconciliation-bridge');
    const proposals = arbitrationProposals(decision);
    if (!proposals) return decision;
    const memory = await loadUserDecisionMemory(accountId, targetType, targetId, decision.fieldKey);
    if (!memory) return decision;
    const verdict = judgeAgainstUserDecision(memory, await evidenceKeyInfos(accountId, proposalEvidenceIds(proposals)));
    if (verdict.reopen || verdict.code === 'NO_USER_DECISION') return decision;
    return { ...decision, action: 'keep', proposedValue: decision.currentValue, reasonCode: 'USER_DECISION_SAME_EVIDENCE', alternatives: undefined };
  } catch (e) {
    console.error('[to-process] mémoire des arbitrages illisible (décision inchangée) :', (e as Error).message);
    return decision;
  }
}
