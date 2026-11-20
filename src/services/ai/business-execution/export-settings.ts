/**
 * Carte #802 — LIMITES TECHNIQUES de l'export diagnostic des exécutions IA
 * (BO › Exécutions & logs › « Exporter le diagnostic complet (ZIP) »). PUR.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUN PLAFOND EN NOMBRE D'EXÉCUTIONS. Les limites ci-dessous sont des
 * grandeurs techniques (octets, durée), lues en UN SEUL point, réglables par
 * variable d'environnement (même convention que `diagJobSettings`,
 * `DIAG_JOB_*`) : un autre choix du PO se règle sans livraison.
 *
 * CE QUI EST MESURÉ / ÉTABLI DANS LE CODE
 *   · le ZIP définitif est écrit par `openRawUpload` (envoi en plusieurs
 *     parties de 8 Mio) : l'objet ne peut pas dépasser 10 000 parties, soit
 *     `ZIP_OBJECT_HARD_MAX_BYTES` (≈ 78 Gio) — borne ABSOLUE du mécanisme
 *     d'envoi, jamais dépassable par réglage ;
 *   · l'archive est assemblée par copie des flux déjà compressés
 *     (`diagnostic-jobs/archive.ts`, ZIP64 si nécessaire) : mémoire bornée
 *     (un morceau + une partie d'envoi), indépendante du volume ;
 *   · la génération tourne en tâche de fond dans le processus qui a reçu la
 *     demande ; son suivi considère interrompue une génération sans signe de
 *     vie (`export-generations.ts`).
 *
 * CE QUI N'EST PAS MESURÉ ICI (préproduction : critère CA12 de la carte)
 *   · débit réel de lecture / d'envoi vers le stockage, durée d'une
 *     génération volumineuse, espace disponible du stockage.
 * Faute de mesure, les DÉFAUTS sont PRUDENTS et « à valider par le PO » :
 *   · `maxZipBytes` 2 Gio : sous la limite de 4 Gio du format ZIP classique
 *     (archive lisible par tout outil, sans ZIP64) ;
 *   · `maxRawBytes` 8 Gio de données avant compression (même grandeur que
 *     l'estimation du précontrôle) ;
 *   · `maxDurationMs` 2 h (durée au-delà de laquelle le suivi des générations
 *     tient déjà une génération pour interrompue) ;
 *   · `precheckBudgetMs` 20 s : le précontrôle répond dans le délai d'une
 *     requête interactive — s'il ne peut pas dénombrer la sélection dans ce
 *     délai, il REFUSE (jamais de lancement à l'aveugle).
 * ══════════════════════════════════════════════════════════════════════════
 */

const GIO = 1024 ** 3;

/** Borne absolue de l'objet ZIP : 10 000 parties d'envoi de 8 Mio (`openRawUpload`). */
export const ZIP_OBJECT_HARD_MAX_BYTES = 10_000 * 8 * 1024 * 1024;

export interface ExecutionsExportLimits {
  /** Taille maximale du ZIP final (octets compressés). */
  maxZipBytes: number;
  /** Volume maximal des données avant compression (octets). */
  maxRawBytes: number;
  /** Durée maximale d'une génération (ms), reprises comprises depuis leur propre départ. */
  maxDurationMs: number;
  /** Délai accordé au précontrôle synchrone (ms). */
  precheckBudgetMs: number;
}

/** Noms des variables d'environnement (jamais leurs valeurs). */
export const EXECUTIONS_EXPORT_ENV = {
  maxZipBytes: 'AI_EXECUTIONS_EXPORT_MAX_ZIP_BYTES',
  maxRawBytes: 'AI_EXECUTIONS_EXPORT_MAX_RAW_BYTES',
  maxDurationMs: 'AI_EXECUTIONS_EXPORT_MAX_DURATION_MS',
  precheckBudgetMs: 'AI_EXECUTIONS_EXPORT_PRECHECK_BUDGET_MS',
} as const;

const DEFAULTS: ExecutionsExportLimits = {
  maxZipBytes: 2 * GIO,
  maxRawBytes: 8 * GIO,
  maxDurationMs: 2 * 60 * 60_000,
  precheckBudgetMs: 20_000,
};

function envInt(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const v = Number(env[name]);
  return Number.isFinite(v) && v >= min ? Math.min(max, Math.floor(v)) : fallback;
}

/** Limites en vigueur (variables facultatives, défauts prudents ; le ZIP ne dépasse jamais la borne absolue de l'envoi). */
export function executionsExportLimits(env: Record<string, string | undefined> = process.env): ExecutionsExportLimits {
  return {
    maxZipBytes: envInt(env, EXECUTIONS_EXPORT_ENV.maxZipBytes, DEFAULTS.maxZipBytes, 1, ZIP_OBJECT_HARD_MAX_BYTES),
    maxRawBytes: envInt(env, EXECUTIONS_EXPORT_ENV.maxRawBytes, DEFAULTS.maxRawBytes, 1, Number.MAX_SAFE_INTEGER),
    maxDurationMs: envInt(env, EXECUTIONS_EXPORT_ENV.maxDurationMs, DEFAULTS.maxDurationMs, 1_000, 24 * 60 * 60_000),
    precheckBudgetMs: envInt(env, EXECUTIONS_EXPORT_ENV.precheckBudgetMs, DEFAULTS.precheckBudgetMs, 100, 10 * 60_000),
  };
}

/** Taille lisible (« 1,5 Gio », « 320 Mio », « 12 Kio »). Pur. */
export function formatBytes(n: number): string {
  const f = (v: number, u: string) => `${v.toLocaleString('fr-FR', { maximumFractionDigits: v >= 100 ? 0 : 1 })} ${u}`;
  if (n >= GIO) return f(n / GIO, 'Gio');
  if (n >= 1024 ** 2) return f(n / 1024 ** 2, 'Mio');
  if (n >= 1024) return f(n / 1024, 'Kio');
  return `${n} octet${n > 1 ? 's' : ''}`;
}

/** Durée lisible (« 2 h », « 20 s », « 1 h 30 min »). Pur. */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
}

/** Message de refus EXACT de la carte #802 (précontrôle et arrêt en cours de génération). */
export const SELECTION_TOO_LARGE_MESSAGE = 'Sélection trop volumineuse. Réduisez la période ou affinez les filtres (traitement, compte, statut)';

/** Cause d'un refus pour volume : grandeur mesurée et limite concrète. */
export type LimitCode = 'RAW_BYTES' | 'ZIP_BYTES' | 'DURATION' | 'PRECHECK_BUDGET' | 'PROJECTION_CAP';

export interface LimitBreach {
  code: LimitCode;
  /** Phrase complète : grandeur constatée, limite, réglage. */
  cause: string;
  measured: number | null;
  limit: number | null;
}

export function limitBreach(code: LimitCode, measured: number | null, limits: ExecutionsExportLimits, detail = ''): LimitBreach {
  switch (code) {
    case 'RAW_BYTES':
      return { code, measured, limit: limits.maxRawBytes, cause: `volume de données ${measured === null ? '' : `${formatBytes(measured)} `}avant compression au-delà de la limite de ${formatBytes(limits.maxRawBytes)} (${EXECUTIONS_EXPORT_ENV.maxRawBytes})${detail}` };
    case 'ZIP_BYTES':
      return { code, measured, limit: limits.maxZipBytes, cause: `archive ZIP ${measured === null ? '' : `de ${formatBytes(measured)} `}au-delà de la limite de ${formatBytes(limits.maxZipBytes)} (${EXECUTIONS_EXPORT_ENV.maxZipBytes})${detail}` };
    case 'DURATION':
      return { code, measured, limit: limits.maxDurationMs, cause: `génération au-delà de la durée maximale de ${formatDuration(limits.maxDurationMs)} (${EXECUTIONS_EXPORT_ENV.maxDurationMs})${detail}` };
    case 'PRECHECK_BUDGET':
      return { code, measured, limit: limits.precheckBudgetMs, cause: `la sélection n’a pas pu être dénombrée dans le délai du précontrôle de ${formatDuration(limits.precheckBudgetMs)} (${EXECUTIONS_EXPORT_ENV.precheckBudgetMs})${detail}` };
    case 'PROJECTION_CAP':
      return { code, measured, limit: null, cause: `plafond de lecture de la projection atteint sur une tranche d’une minute${detail}` };
  }
}
