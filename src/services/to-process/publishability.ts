/**
 * Lot 98B (ticket P0 « À traiter — ne publier une carte que si son utilité
 * est démontrée », P0-E) — « carte OUVERTE » ≠ « carte PUBLIABLE ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉFINITION UNIQUE
 *
 * Une carte OUVERTE (`resolved_at IS NULL`) n'est PUBLIABLE que si la
 * dernière décision de son moteur démontre qu'une intervention de
 * l'utilisateur est utile. Une carte gardée seulement parce que Verebona n'a
 * pas pu statuer — c'est-à-dire, pour une carte documentaire, quand la
 * DERNIÈRE décision tracée (`document_rule_evaluations`, même document, même
 * règle) est :
 *   · KEPT_T4_INCOMPATIBLE          contrat T4 actif incompatible ;
 *   · KEPT_INTERPRETATION_PENDING   interprétation T3 de la connaissance en attente ;
 *   · KEPT_INTERPRETATION_INCOMPLETE  interprétation T3 incomplète (contexte borné) ;
 *   · KEPT_ON_TECHNICAL_FAILURE     panne IA ou configuration illisible ;
 *   · issue ERROR                   évaluation impossible (lecture, écriture non confirmée…)
 * est « RETENUE » : elle reste ouverte (jamais fermée sur une panne), mais
 * elle relève de la SUPERVISION technique (BO › Supervision, cause et
 * nouvelle tentative), pas de « À traiter ». Une incapacité technique de
 * Verebona ne transfère jamais du travail à l'utilisateur.
 *
 * Les cartes sans décision documentaire tracée (agenda, équipements,
 * fournisseurs, Opérations…) sont publiables comme avant : leur moteur ne
 * produit pas de maintien « technique ».
 *
 * Utilisée par : la page « À traiter » et son compteur (`getToProcessPage`),
 * la pastille (`countActiveActions`), l'accueil et la mascotte (qui lisent
 * `getToProcessPage`), les notifications (création, récapitulatif), les
 * lectures de l'assistant ; la Supervision lit le complément
 * (`heldCardsOverview`). Lecture SQL seule — aucun appel T3 / T4 au
 * chargement d'une page. Aucun état persistant supplémentaire : la décision
 * tracée EST l'état ; le stock est donc rattrapé de lui-même (aucune
 * migration, aucune reprise à lancer), et une nouvelle décision du moteur
 * (campagne de cohérence, réanalyse, nouvelle tentative) republie ou retient
 * la carte immédiatement.
 *
 * Coût : une recherche par carte ouverte dans l'index
 * `document_rule_evaluations_file_rule_idx` (compte, document, règle, id DESC).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql, type SQL } from 'drizzle-orm';

/** Motifs de maintien TECHNIQUE (décision documentaire) → cause affichée en Supervision. */
export const TECHNICAL_HOLD_REASONS = {
  KEPT_T4_INCOMPATIBLE: 'T4_INCOMPATIBLE',
  KEPT_INTERPRETATION_PENDING: 'INTERPRETATION_PENDING',
  KEPT_INTERPRETATION_INCOMPLETE: 'INTERPRETATION_INCOMPLETE',
  KEPT_ON_TECHNICAL_FAILURE: 'AI_UNAVAILABLE',
} as const;

export type TechnicalHoldCause = (typeof TECHNICAL_HOLD_REASONS)[keyof typeof TECHNICAL_HOLD_REASONS] | 'EVALUATION_ERROR';

/** Libellés simples des causes (Supervision, BO). */
export const HOLD_CAUSE_LABELS: Readonly<Record<TechnicalHoldCause, string>> = {
  T4_INCOMPATIBLE: 'configuration T4 active incompatible (contrat t4_output_v3 attendu)',
  INTERPRETATION_PENDING: 'interprétation T3 de la connaissance en attente (capacité, budget ou nouvelle tentative)',
  INTERPRETATION_INCOMPLETE: 'interprétation T3 incomplète (connaissance au-delà des bornes)',
  AI_UNAVAILABLE: 'IA ou configuration indisponible (panne, délai dépassé)',
  EVALUATION_ERROR: 'évaluation de la règle en erreur',
};

const HOLD_REASON_CODES = Object.keys(TECHNICAL_HOLD_REASONS);

export type CardStanding =
  /** Aucune décision documentaire tracée (autres familles, cartes antérieures au diagnostic) : publiable. */
  | { kind: 'NO_DECISION' }
  /** La dernière décision maintient ou crée la carte pour une raison démontrée (donnée utile, intervention, arbitrage…). */
  | { kind: 'JUSTIFIED'; reasonCode: string | null; ambiguity: boolean }
  /** Maintien par incapacité technique de statuer : supervision, jamais « À traiter ». */
  | { kind: 'TECHNICAL_HOLD'; reasonCode: string | null; cause: TechnicalHoldCause };

/**
 * Statut de publication d'une carte d'après la DERNIÈRE décision de son
 * moteur (pure) — même règle que `publishableCardSql`.
 */
export function cardStanding(last: { outcome: string | null; reasonCode: string | null } | null): CardStanding {
  if (!last) return { kind: 'NO_DECISION' };
  if (last.outcome === 'ERROR') return { kind: 'TECHNICAL_HOLD', reasonCode: last.reasonCode, cause: 'EVALUATION_ERROR' };
  const cause = last.reasonCode ? (TECHNICAL_HOLD_REASONS as Record<string, TechnicalHoldCause>)[last.reasonCode] : undefined;
  if (cause) return { kind: 'TECHNICAL_HOLD', reasonCode: last.reasonCode, cause };
  return { kind: 'JUSTIFIED', reasonCode: last.reasonCode, ambiguity: last.reasonCode === 'AMBIGUOUS' };
}

export const isPublishable = (s: CardStanding): boolean => s.kind !== 'TECHNICAL_HOLD';

/** Sous-requête : dernière décision documentaire de la carte `a` (alias SQL de `to_process_actions`). */
const derniereDecision = (a: string) => `
  SELECT d.outcome, d.reason_code FROM document_rule_evaluations d
   WHERE d.account_id = ${a}.account_id AND d.file_id = ${a}.target_id AND d.rule_code = ${a}.rule_code
   ORDER BY d.id DESC LIMIT 1`;

/** Condition SQL « carte retenue pour blocage technique » (`a` : alias ou nom qualifié de `to_process_actions`). */
export function heldCardSql(a = 'a'): string {
  return `(${a}.target_type = 'DOCUMENT' AND EXISTS (
    SELECT 1 FROM (${derniereDecision(a)}) h
     WHERE h.outcome = 'ERROR' OR h.reason_code IN (${HOLD_REASON_CODES.map((c) => `'${c}'`).join(', ')})))`;
}

/**
 * Condition SQL « carte PUBLIABLE » — à combiner avec `resolved_at IS NULL`
 * (la carte ouverte). `a` : alias ou nom qualifié de `to_process_actions`.
 */
export function publishableCardSql(a = 'a'): string {
  return `NOT ${heldCardSql(a)}`;
}

/** Même condition pour les requêtes Drizzle sur `toProcessActions` (table non aliasée). */
export function publishableCardCondition(): SQL {
  return sql.raw(publishableCardSql('"to_process_actions"'));
}

/** Cause SQL d'une carte retenue (Supervision, BO) — même table de correspondance que `cardStanding`. */
const causeSql = (h: string) => `CASE WHEN ${h}.outcome = 'ERROR' THEN 'EVALUATION_ERROR' ${Object.entries(TECHNICAL_HOLD_REASONS)
  .map(([r, c]) => `WHEN ${h}.reason_code = '${r}' THEN '${c}'`).join(' ')} END`;

export interface HeldCardsGroup { cause: TechnicalHoldCause; count: number; accountIds: number[] }

/**
 * Cartes OUVERTES retenues (non publiables), regroupées par cause — tous
 * comptes, ou un seul compte. Lecture seule ; ne lève pas (0 en cas d'échec).
 */
export async function heldCardsOverview(o: { accountId?: number | null; sql?: { unsafe: (q: string, p?: never[]) => Promise<unknown> } } = {}): Promise<HeldCardsGroup[]> {
  try {
    const client = o.sql ?? (await import('@/db')).pgClient;
    const r = (await client.unsafe(`
      SELECT ${causeSql('h')} AS cause, count(*)::int AS n, (array_agg(DISTINCT a.account_id))[1:20] AS accounts
        FROM to_process_actions a
        CROSS JOIN LATERAL (${derniereDecision('a')}) h
       WHERE a.resolved_at IS NULL AND a.target_type = 'DOCUMENT' ${o.accountId ? 'AND a.account_id = $1' : ''}
         AND (h.outcome = 'ERROR' OR h.reason_code IN (${HOLD_REASON_CODES.map((c) => `'${c}'`).join(', ')}))
       GROUP BY 1 ORDER BY 2 DESC`, (o.accountId ? [o.accountId] : []) as never[])) as Array<{ cause: TechnicalHoldCause; n: number; accounts: number[] | null }>;
    return r.map((x) => ({ cause: x.cause, count: Number(x.n), accountIds: (x.accounts ?? []).map(Number) }));
  } catch (e) {
    console.error('[to-process] lecture des cartes retenues impossible :', (e as Error).message);
    return [];
  }
}

/** Cartes retenues d'une cause (identifiants : compte, carte, document, règle), bornées — nouvelle tentative BO. */
export async function heldCards(o: { limit: number; accountId?: number | null }): Promise<Array<{ accountId: number; actionId: number; fileId: number; ruleCode: string; cause: TechnicalHoldCause }>> {
  const { pgClient } = await import('@/db');
  const r = (await pgClient.unsafe(`
    SELECT a.account_id, a.id, a.target_id, a.rule_code, ${causeSql('h')} AS cause
      FROM to_process_actions a
      CROSS JOIN LATERAL (${derniereDecision('a')}) h
     WHERE a.resolved_at IS NULL AND a.target_type = 'DOCUMENT' ${o.accountId ? 'AND a.account_id = $2' : ''}
       AND (h.outcome = 'ERROR' OR h.reason_code IN (${HOLD_REASON_CODES.map((c) => `'${c}'`).join(', ')}))
     ORDER BY a.id LIMIT $1`, (o.accountId ? [o.limit, o.accountId] : [o.limit]) as never[])) as unknown as Array<Record<string, unknown>>;
  return r.map((x) => ({ accountId: Number(x.account_id), actionId: Number(x.id), fileId: Number(x.target_id), ruleCode: String(x.rule_code), cause: x.cause as TechnicalHoldCause }));
}

/**
 * Nouvelle tentative (BO › IA › File d'attente, bouton) : réévaluation par
 * la DÉCISION CENTRALE existante (`resolveDocumentRuleFromKnowledge`) des
 * cartes retenues — dans le budget IA du compte et sous l'anti-boucle des
 * mémoires T3 / T4. Une carte dont l'utilité est démontrée redevient
 * publiable, une carte inutile est fermée, une cause qui persiste la laisse
 * retenue. Bornée (`limit`, `deadline`).
 */
export async function retryHeldCards(o: { limit?: number; deadline?: number; accountId?: number | null } = {}): Promise<{ examined: number; outcomes: Record<string, number>; errors: number }> {
  const { resolveDocumentRuleFromKnowledge, syncDocumentRulesFromState } = await import('./document-rule-bridge');
  const lot = await heldCards({ limit: Math.min(200, Math.max(1, o.limit ?? 50)), accountId: o.accountId ?? null });
  const outcomes: Record<string, number> = {};
  let errors = 0;
  let examined = 0;
  const vus = new Set<string>();
  for (const c of lot) {
    if (o.deadline && Date.now() >= o.deadline) break;
    const k = `${c.accountId}:${c.fileId}:${c.ruleCode}`;
    if (vus.has(k)) continue;
    vus.add(k);
    examined += 1;
    try {
      const r = await resolveDocumentRuleFromKnowledge(c.accountId, c.fileId, c.ruleCode, { runRef: 'bo:retry-held-cards', trigger: 'BACKFILL' });
      if (r.status === 'NOT_A_FIELD') {
        // Règle de relation (évaluation en erreur) : réévaluation d'état de la même règle, sans création.
        const s = await syncDocumentRulesFromState(c.accountId, c.fileId, { reason: 'OBSOLETE', create: false, trigger: 'BACKFILL', runRef: 'bo:retry-held-cards' });
        const o2 = String(s.outcomes[c.ruleCode] ?? 'NONE');
        outcomes[o2] = (outcomes[o2] ?? 0) + 1;
        continue;
      }
      outcomes[r.status] = (outcomes[r.status] ?? 0) + 1;
    } catch (e) {
      errors += 1;
      console.error('[to-process] nouvelle tentative impossible :', (e as Error).message);
    }
  }
  return { examined, outcomes, errors };
}
