/**
 * Rapport d'inventaire des usages IA — CDC §9.7 et §12.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE SERVICE EXISTE
 *
 * L'inventaire est produit par deux chemins : `scripts/ai-inventory.ts`, lancé
 * à la main ou par la CI, et `/api/cron/ai/inventory`, appelé par
 * l'ordonnanceur ou en recette.
 *
 * Le second a été ajouté parce que le premier exige un accès direct à la base :
 * en recette, la preuve du §12 devenait alors impossible à produire pour qui
 * n'a pas la main sur la plateforme — alors que tous les autres contrôles
 * passent par une route protégée par `CRON_SECRET`. Le contrôle qui autorise la
 * bascule réglementaire ne pouvait pas être le seul inaccessible.
 *
 * Deux chemins, un seul calcul : c'est l'objet de ce fichier. Un rapport dont
 * le verdict dépendrait de la manière dont on l'a demandé ne prouverait rien.
 * ══════════════════════════════════════════════════════════════════════════
 */
import {
  listActiveUseCases, listOperationsByUseCase, listLlmOperations,
} from './index';
import { snapshotFlags, type AiFlag, type FlagMode } from '../flags/ai-feature-flags';
import {
  concludeExecutionInventory, knownOperationCodes,
  type InventoryVerdict,
} from './execution-inventory';

/** Fenêtre d'observation par défaut — voir l'en-tête du script pour le choix. */
export const DEFAULT_WINDOW_DAYS = 30;

export interface DeclaredSection {
  activeUseCaseCount: number;
  expectedUseCaseCount: number;
  compliant: boolean;
  useCases: Array<{
    code: string;
    label: string;
    purpose: string;
    replacesLegacyUsages: number[];
    operationCount: number;
    llmOperationCount: number;
    operations: Array<{
      code: string;
      label: string;
      deterministic: boolean;
      model: string | null;
      promptCode: string | null;
      active: boolean;
    }>;
  }>;
  totalLlmOperations: number;
  flags: Record<AiFlag, FlagMode>;
}

export interface ObservedRow {
  operationType: string;
  useCaseCode: string | null;
  events: number;
  firstSeen: string;
  lastSeen: string;
  /** L'opération appartient-elle au référentiel embarqué ? */
  inRegistry: boolean;
}

export interface ObservedSection {
  windowDays: number;
  since: string;
  totalEvents: number;
  rows: ObservedRow[];
  foreignOperations: string[];
  useCasesSeen: string[];
  verdict: InventoryVerdict;
  reason: string;
}

export interface InventoryReport {
  generatedAt: string;
  declare: DeclaredSection;
  observe: ObservedSection | null;
  /** Vrai seulement si les DEUX sections concluent — voir `scope`. */
  compliant: boolean;
  scope: 'declare' | 'declare+observe';
}

/** Section « déclaré » — lue dans le référentiel embarqué, sans base. */
export function buildDeclaredSection(): DeclaredSection {
  const useCases = listActiveUseCases();

  return {
    activeUseCaseCount: useCases.length,
    expectedUseCaseCount: 5,
    compliant: useCases.length === 5,
    useCases: useCases.map((uc) => {
      const ops = listOperationsByUseCase(uc.code);
      return {
        code: uc.code,
        label: uc.label,
        purpose: uc.purpose,
        replacesLegacyUsages: uc.replacesLegacyUsages,
        operationCount: ops.length,
        llmOperationCount: ops.filter((o) => o.provider !== 'none' && o.active).length,
        operations: ops.map((o) => ({
          code: o.operationCode,
          label: o.label,
          deterministic: o.provider === 'none',
          model: o.provider === 'none' ? null : o.primaryModel,
          promptCode: o.promptCode ?? null,
          active: o.active,
        })),
      };
    }),
    totalLlmOperations: listLlmOperations().length,
    flags: snapshotFlags(),
  };
}

/**
 * Section « observé » — agrège `ai_usage_event` sur la fenêtre.
 *
 * La fenêtre est passée en paramètre de requête, jamais interpolée : ce code
 * s'exécute en recette, sur des bases réelles.
 */
export async function buildObservedSection(windowDays: number): Promise<ObservedSection> {
  const { pgClient } = await import('@/db');

  const rows = await pgClient.unsafe(
    `SELECT operation_type,
            use_case_code,
            COUNT(*)::int      AS events,
            MIN(created_at)    AS first_seen,
            MAX(created_at)    AS last_seen
       FROM ai_usage_event
      WHERE created_at >= NOW() - ($1 || ' days')::interval
      GROUP BY operation_type, use_case_code
      ORDER BY events DESC`,
    [String(windowDays)] as never[],
  );

  const connues = knownOperationCodes();

  const lignes: ObservedRow[] = (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    operationType: String(r.operation_type),
    useCaseCode: r.use_case_code == null ? null : String(r.use_case_code),
    events: Number(r.events),
    firstSeen: new Date(String(r.first_seen)).toISOString(),
    lastSeen: new Date(String(r.last_seen)).toISOString(),
    inRegistry: connues.has(String(r.operation_type)),
  }));

  // Le verdict vit dans `execution-inventory.ts`, testé à part : c'est lui qui
  // autorise ou refuse la bascule réglementaire, pas la mise en forme.
  const conclusion = concludeExecutionInventory(lignes);

  return {
    windowDays,
    since: new Date(Date.now() - windowDays * 86_400_000).toISOString(),
    totalEvents: conclusion.totalEvents,
    rows: lignes,
    foreignOperations: conclusion.foreignOperations,
    useCasesSeen: conclusion.useCasesSeen,
    verdict: conclusion.verdict,
    reason: conclusion.reason,
  };
}

export async function buildInventoryReport(
  options: { observed?: boolean; windowDays?: number } = {},
): Promise<InventoryReport> {
  const declare = buildDeclaredSection();
  const observe = options.observed
    ? await buildObservedSection(options.windowDays ?? DEFAULT_WINDOW_DAYS)
    : null;

  return {
    generatedAt: new Date().toISOString(),
    declare,
    observe,
    compliant: declare.compliant && (observe === null || observe.verdict === 'conforme'),
    scope: observe === null ? 'declare' : 'declare+observe',
  };
}

/**
 * Lit une fenêtre exprimée en jours ou en heures (`30d`, `90`, `12h`).
 *
 * Renvoie `null` sur une valeur illisible plutôt qu'un défaut silencieux : une
 * fenêtre mal comprise produirait un verdict sur une période qui n'est pas
 * celle demandée, et personne ne s'en apercevrait.
 */
export function parseWindow(raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === '') return DEFAULT_WINDOW_DAYS;
  const m = /^(\d+)\s*([dhj])?$/i.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const jours = (m[2] ?? 'd').toLowerCase() === 'h' ? n / 24 : n;
  return jours > 0 ? jours : null;
}
