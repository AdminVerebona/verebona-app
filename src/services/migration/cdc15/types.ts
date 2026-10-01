/**
 * Rattrapages de données du CDC 15 §14 — types communs (lot 17, volet B).
 * Voir `runner.ts` pour l'orchestration et la règle migration (MIG-09).
 */
import type postgres from 'postgres';
import type { AssetRowJson } from '@/services/canonical/asset-state';

/** Étapes exécutables. MIG-09 n'est pas une étape : c'est la règle appliquée par toutes. */
export const MIG_STEPS = ['MIG-01', 'MIG-02', 'MIG-03', 'MIG-04', 'MIG-05', 'MIG-06', 'MIG-07', 'MIG-08'] as const;
export type MigStep = (typeof MIG_STEPS)[number];

/**
 * Ordre d'exécution de `--step all` (documenté) : les alias d'abord (MIG-01,
 * clés canoniques), puis les origines (MIG-03 : MIG-02 ne corrige qu'une
 * valeur d'origine automatique PROUVÉE), puis les montants, les preuves, les
 * colonnes miroirs (sur des clés et des origines à jour), enfin la relation
 * N-N et l'agenda (scripts existants).
 */
export const ALL_ORDER: readonly MigStep[] = ['MIG-01', 'MIG-03', 'MIG-02', 'MIG-04', 'MIG-07', 'MIG-08', 'MIG-05', 'MIG-06'];

export type Decision = 'APPLIED' | 'SKIPPED_USER' | 'AMBIGUOUS' | 'NO_CHANGE';
export const DECISIONS: readonly Decision[] = ['APPLIED', 'SKIPPED_USER', 'AMBIGUOUS', 'NO_CHANGE'];

export type EntityType = 'asset' | 'document_fact' | 'field_evidence' | 'asset_file' | 'agenda_item' | 'summary';

/** Une décision sur une entité (valeurs EN CLAIR : masquées à l'écriture du rapport). */
export interface ReportEntry {
  step: MigStep;
  accountId: number | null;
  assetId?: number | null;
  entityType: EntityType;
  entityId?: string | number | null;
  fieldKey?: string | null;
  before?: unknown;
  after?: unknown;
  decision: Decision;
  reason?: string | null;
  details?: Record<string, unknown>;
}

/** Carte « À traiter » demandée par une étape pour un cas ambigu exploitable. */
export interface ReviewCardRequest {
  step: MigStep;
  accountId: number;
  assetId: number;
  /** Clé canonique concernée. */
  key: string;
  reason: string;
  /** Valeur canonique en place (proposée comme « valeur actuelle »). */
  current: unknown;
  /** Valeurs candidates (dans l'unité canonique), hors valeur actuelle. */
  candidates: Array<{ value: unknown; label?: string; source?: string }>;
}

export interface StepContext {
  sql: postgres.Sql;
  runId: string;
  apply: boolean;
  accountId: number | null;
  batchSize: number;
  pauseMs: number;
  /** Nombre maximal d'entités parcourues PAR PARTIE de l'étape (null : sans limite). */
  limit: number | null;
  /** Reprise : dernier identifiant traité de la partie principale. */
  fromCursor: number;
  /** Reprise : curseur d'une partie (`MIG-01:facts`…) ; 0 si aucun. */
  cursorOf: (part: string) => number;
  report: (e: ReportEntry) => Promise<void>;
  card: (c: ReviewCardRequest) => Promise<'CREATED' | 'UPDATED' | 'SKIPPED'>;
  /** Curseur atteint (persisté pour la reprise) ; `part` : partie de l'étape (défaut : l'étape). */
  checkpoint: (cursor: number, part?: string) => Promise<void>;
  /**
   * Simulation seulement : lignes de biens telles que les étapes précédentes
   * de l'exécution les auraient laissées (MIG-01, MIG-03 en mémoire), pour
   * que le rapport de simulation reflète l'application.
   */
  preview?: <R extends AssetRowJson & { id: number }>(rows: R[]) => Promise<R[]>;
  log: (msg: string) => void;
}

export interface StepResult {
  step: MigStep;
  scanned: number;
  counts: Record<Decision, number>;
  cursor: number;
  /** Étape non exécutée (motif). */
  skipped?: string;
  cards: number;
  /** Toutes les parties parcourues jusqu'au bout (faux : `--limit` atteint). */
  complete: boolean;
}

export const emptyCounts = (): Record<Decision, number> => ({ APPLIED: 0, SKIPPED_USER: 0, AMBIGUOUS: 0, NO_CHANGE: 0 });

export const pause = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
