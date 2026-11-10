/**
 * Écriture À LA SOURCE de la classification du coût d'un appel (lot 113AF,
 * migration 1610) — appelée par `recordCallTrace` juste après l'écriture de
 * l'événement d'usage, comme les colonnes 0217 / 1150 : en SQL à part,
 * seulement si les colonnes existent ; absentes, la même règle est appliquée
 * à la lecture (`costOriginSql`). Ne lève jamais : la télémétrie ne fait pas
 * échouer un traitement.
 */
import { cachedSchemaProbe } from '../telemetry/trace-schema';
import {
  COST_CLASSIFICATION_VERSION, TECHNICAL_ACCOUNT_KIND, classifyCallCost, type CostClassification, type CostClassificationInput,
} from './cost-classification';

const COST_CLASS_COLUMNS = ['cost_origin', 'cost_imputable', 'cost_class'] as const;

const costClassProbe = cachedSchemaProbe(async () => {
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'ai_usage_event'
        AND column_name IN ('cost_origin', 'cost_imputable', 'cost_class')`,
  )) as unknown as Array<{ n: number }>;
  const found = Number(rows?.[0]?.n ?? 0);
  return { ready: found === COST_CLASS_COLUMNS.length, found };
}, {
  scope: '[ai-trace]', migration: '1610',
  expected: COST_CLASS_COLUMNS.map((c) => `ai_usage_event.${c}`),
  consequence: 'Les traces IA continuent SANS origine du coût écrite (déduite à la lecture par la même règle) ; appliquer src/db/migrations/1610_*.sql.',
});

/** Colonnes 1610 présentes sur `ai_usage_event` ? Ne lève jamais. */
export async function costClassColumnsReady(): Promise<boolean> {
  return costClassProbe();
}

/** Comptes techniques de qualification (marqueur en base), relus au plus toutes les 5 min. */
let technicalAccounts: { ids: ReadonlySet<number>; at: number } | null = null;
const TECHNICAL_TTL_MS = 5 * 60_000;

async function technicalAccountIds(): Promise<ReadonlySet<number>> {
  if (technicalAccounts && Date.now() - technicalAccounts.at < TECHNICAL_TTL_MS) return technicalAccounts.ids;
  try {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT id FROM accounts WHERE technical_kind = $1`, [TECHNICAL_ACCOUNT_KIND] as never[],
    )) as unknown as Array<{ id: number }>;
    technicalAccounts = { ids: new Set((Array.isArray(rows) ? rows : []).map((r) => Number(r.id))), at: Date.now() };
  } catch {
    // Marqueur illisible (migration 0960 absente) : seul le contexte serveur vérifié compte.
    technicalAccounts = { ids: new Set(), at: Date.now() };
  }
  return technicalAccounts.ids;
}

/** Le compte porte-t-il le marqueur technique de qualification ? Ne lève jamais. */
export async function isTechnicalAccountByMarker(accountId: number | null | undefined): Promise<boolean> {
  if (!accountId || accountId <= 0) return false;
  return (await technicalAccountIds()).has(accountId);
}

/**
 * Classe l'appel (contexte serveur fiable) et écrit la classification sur
 * l'événement d'usage. Rend la classification écrite, `null` si rien n'a été
 * écrit (colonnes absentes, identifiant absent, erreur).
 */
export async function writeCostClassification(
  usageEventId: number | null,
  input: Omit<CostClassificationInput, 'technicalAccount'> & { technicalAccountInContext: boolean },
): Promise<CostClassification | null> {
  if (!usageEventId) return null;
  try {
    if (!(await costClassColumnsReady())) return null;
    const { technicalAccountInContext, ...rest } = input;
    const technicalAccount = technicalAccountInContext || await isTechnicalAccountByMarker(input.accountId);
    const cls = classifyCallCost({ ...rest, technicalAccount });
    const proof = {
      rule: COST_CLASSIFICATION_VERSION, reason: cls.reason, source: 'source',
      legacyBillable: input.legacyBillable ?? null,
      ...(input.costCapExempt ? { costCapExempt: true } : {}),
      ...(technicalAccountInContext ? { technicalContext: true } : {}),
    };
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `UPDATE ai_usage_event SET cost_origin = $2, cost_imputable = $3, cost_class = $4::jsonb WHERE id = $1`,
      [usageEventId, cls.origin, cls.imputable, JSON.stringify(proof)] as never[],
    );
    return cls;
  } catch (e) {
    console.error('[ai-trace] origine du coût non écrite (non bloquant) :', (e as Error).message);
    return null;
  }
}

/** Réservé aux tests. */
export function __resetCostClassificationStoreForTests(ready: boolean | null = null): void {
  costClassProbe.reset(ready);
  technicalAccounts = null;
}
