/**
 * Rapport du mode observation — CDC §10.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE FICHIER
 *
 * Le mode observation existe déjà : `reconcileAsset` produit ses décisions,
 * les journalise dans `reconciliation_runs` et `reconciliation_decisions`, et
 * n'écrit rien tant que le drapeau n'est pas à `enabled`.
 *
 * Mais le §10.2 ne demande pas seulement de produire des décisions sans les
 * appliquer. Il demande que « les écarts soient mesurés ». Sans lecture
 * agrégée, trois semaines d'observation produisent des milliers de lignes que
 * personne n'ouvre, et la bascule se décide quand même à l'aveugle — ce que
 * l'audit signalait comme le risque principal du lot 3.
 *
 * Ce module transforme ce journal en une réponse à une seule question :
 *
 *     « Que ferait le nouveau moteur si on le laissait écrire ? »
 *
 * L'agrégation est séparée de l'accès base (`summarizeShadowDecisions` est une
 * fonction pure) : elle est testable sans base, et c'est là que se trouvent les
 * règles de lecture.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { isCriticalField } from './decision/critical-fields';
import { reasonLabel } from './decision/reason-codes';

/** Une décision telle que journalisée, réduite à ce que le rapport exploite. */
export interface ShadowDecisionRow {
  fieldKey: string;
  action: string;
  reasonCode: string;
  confidence: string;
  deterministic: boolean;
  assetId: number;
}

export interface FieldBreakdown {
  fieldKey: string;
  critical: boolean;
  total: number;
  wouldWrite: number;
  wouldAsk: number;
  wouldKeep: number;
  /** Motif le plus fréquent — c'est lui qui explique un chiffre surprenant. */
  topReason: string | null;
}

export interface ShadowSummary {
  decisionCount: number;
  assetCount: number;
  /** Décisions qui modifieraient une valeur si l'écriture était autorisée. */
  wouldWrite: number;
  /** Décisions qui solliciteraient l'utilisateur : conflit ou arbitrage. */
  wouldAsk: number;
  /** Décisions sans effet : la valeur en place est déjà la bonne. */
  wouldKeep: number;
  /** Part des décisions tranchées sans appel modèle (§4.2.8). */
  deterministicRate: number;
  /** Sollicitations par bien — le chiffre de la question 6 du métier. */
  asksPerAsset: number;
  byAction: Record<string, number>;
  byField: FieldBreakdown[];
  criticalWouldWrite: number;
}

const WRITE_ACTIONS = new Set(['apply', 'update']);
const ASK_ACTIONS = new Set(['create_conflict', 'request_ai_review']);

/**
 * Agrégation. Fonction pure : aucune lecture base, aucune date, aucun aléa.
 *
 * Le classement en trois familles — écrire, demander, ne rien faire — est
 * volontairement plus grossier que les six actions du moteur. C'est la seule
 * granularité sur laquelle un responsable métier peut se prononcer, et la
 * décision de bascule lui appartient.
 */
export function summarizeShadowDecisions(rows: ShadowDecisionRow[]): ShadowSummary {
  const assets = new Set<number>();
  const byAction: Record<string, number> = {};
  const fields = new Map<string, { total: number; w: number; a: number; k: number; reasons: Map<string, number> }>();

  let wouldWrite = 0;
  let wouldAsk = 0;
  let wouldKeep = 0;
  let deterministic = 0;
  let criticalWouldWrite = 0;

  for (const r of rows) {
    assets.add(r.assetId);
    byAction[r.action] = (byAction[r.action] ?? 0) + 1;
    if (r.deterministic) deterministic++;

    const write = WRITE_ACTIONS.has(r.action);
    const ask = ASK_ACTIONS.has(r.action);
    if (write) wouldWrite++;
    else if (ask) wouldAsk++;
    else wouldKeep++;

    if (write && isCriticalField(r.fieldKey)) criticalWouldWrite++;

    let f = fields.get(r.fieldKey);
    if (!f) {
      f = { total: 0, w: 0, a: 0, k: 0, reasons: new Map() };
      fields.set(r.fieldKey, f);
    }
    f.total++;
    if (write) f.w++; else if (ask) f.a++; else f.k++;
    f.reasons.set(r.reasonCode, (f.reasons.get(r.reasonCode) ?? 0) + 1);
  }

  const byField: FieldBreakdown[] = [...fields.entries()]
    .map(([fieldKey, f]) => ({
      fieldKey,
      critical: isCriticalField(fieldKey),
      total: f.total,
      wouldWrite: f.w,
      wouldAsk: f.a,
      wouldKeep: f.k,
      topReason: topOf(f.reasons),
    }))
    // Les champs les plus sollicitants en tête : c'est là que se décide le
    // réglage de prudence (question 6 du document métier).
    .sort((a, b) => b.wouldAsk - a.wouldAsk || b.total - a.total);

  const assetCount = assets.size;

  return {
    decisionCount: rows.length,
    assetCount,
    wouldWrite,
    wouldAsk,
    wouldKeep,
    deterministicRate: rows.length === 0 ? 1 : round(deterministic / rows.length),
    asksPerAsset: assetCount === 0 ? 0 : round(wouldAsk / assetCount),
    byAction,
    byField,
    criticalWouldWrite,
  };
}

function topOf(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let max = 0;
  for (const [k, v] of counts) if (v > max) { max = v; best = k; }
  return best ? reasonLabel(best) : null;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface ShadowReportInput {
  /** Restreint à un compte. Absent : tous les comptes. */
  accountId?: number;
  /** Fenêtre d'observation, en jours. Le §10.2 en prévoit trois semaines. */
  sinceDays?: number;
}

export interface ShadowReport extends ShadowSummary {
  windowDays: number;
  runCount: number;
  generatedAt: string;
  /** Lecture prête à afficher, en français, sans jargon technique. */
  verdict: string;
}

/**
 * Lit le journal du mode observation et en produit le rapport.
 *
 * Seules les exécutions `shadow` sont retenues : une fois la bascule faite, les
 * exécutions réelles n'ont plus à alimenter ce rapport, dont l'objet est
 * précisément de décider de cette bascule.
 */
export async function getShadowReport(input: ShadowReportInput = {}): Promise<ShadowReport> {
  const windowDays = input.sinceDays ?? 21;

  const params: unknown[] = [windowDays];
  let accountFilter = '';
  if (input.accountId) {
    params.push(input.accountId);
    accountFilter = ' AND r.account_id = $2';
  }

  const rows = await pgClient.unsafe(
    `SELECT d.field_key, d.action, d.reason_code, d.confidence,
            d.deterministic, d.asset_id, d.run_id
       FROM reconciliation_decisions d
       JOIN reconciliation_runs r ON r.id = d.run_id
      WHERE r.shadow = TRUE
        AND r.started_at >= NOW() - ($1 || ' days')::interval${accountFilter}`,
    params as never[],
  ) as unknown as Array<Record<string, unknown>>;

  const decisions: ShadowDecisionRow[] = rows.map((r) => ({
    fieldKey: String(r.field_key),
    action: String(r.action),
    reasonCode: String(r.reason_code),
    confidence: String(r.confidence),
    deterministic: Boolean(r.deterministic),
    assetId: Number(r.asset_id),
  }));

  const summary = summarizeShadowDecisions(decisions);
  const runCount = new Set(rows.map((r) => Number(r.run_id))).size;

  return {
    ...summary,
    windowDays,
    runCount,
    generatedAt: new Date().toISOString(),
    verdict: buildVerdict(summary, windowDays),
  };
}

/**
 * Formulation destinée au responsable métier, pas à un développeur.
 *
 * Les seuils ci-dessous ne sont pas des règles du CDC : ce sont des repères de
 * lecture, à ajuster une fois les premières mesures disponibles. Ils sont
 * explicites plutôt que cachés dans un tableau de bord, pour que leur
 * arbitraire soit visible.
 */
function buildVerdict(s: ShadowSummary, windowDays: number): string {
  if (s.decisionCount === 0) {
    return `Aucune décision observée sur ${windowDays} jours. Vérifiez que ` +
      'AI_RECONCILIATION_ENGINE vaut `shadow` et que des documents sont analysés.';
  }

  const parts = [
    `${s.decisionCount} décisions sur ${s.assetCount} bien(s) en ${windowDays} jours.`,
    `${s.wouldWrite} corrigeraient une valeur, ${s.wouldAsk} solliciteraient l'utilisateur, ` +
    `${s.wouldKeep} ne changeraient rien.`,
    `${Math.round(s.deterministicRate * 100)} % tranchées sans appel modèle.`,
  ];

  if (s.asksPerAsset > 3) {
    parts.push(
      `⚠️ ${s.asksPerAsset} sollicitation(s) par bien : au-dessus de ce qu'un ` +
      'utilisateur absorbe. Regardez les champs en tête du détail avant de basculer.',
    );
  }

  if (s.criticalWouldWrite > 0) {
    parts.push(
      `${s.criticalWouldWrite} écriture(s) automatique(s) sur un champ critique — ` +
      'à relire une par une : ce sont celles qui coûtent le plus cher si elles sont fausses.',
    );
  }

  return parts.join(' ');
}
