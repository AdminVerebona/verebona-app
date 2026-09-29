/**
 * Déclencheurs appliqués au runtime — CDC BO IA §15.1, T1-UI-08, T3-UI-04,
 * T3-UI-05, T4-UI-04, T3-003, T3-005, T3-006, T4-016, WF-18.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI MANQUAIT
 *
 * Les déclencheurs étaient sélectionnés, validés et versionnés — et rien ne
 * les lisait. Les événements partaient en dur, la planification T3 venait
 * d'une variable d'environnement. Ce module est le seul endroit où la liste
 * versionnée décide si une exécution automatique part.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LISTE VIDE = DÉFAUTS DU CODE ; LISTE RENSEIGNÉE = ELLE FAIT FOI
 *
 * Toutes les versions antérieures à cette application runtime ont des listes
 * vides (le champ était décoratif). Les lire comme « aucun déclencheur » aurait
 * coupé T1, T3 et T4 en production au déploiement. Une liste vide garde donc
 * le comportement historique (`DEFAULT_TRIGGERS`) ; dès qu'un administrateur
 * renseigne la liste, elle est appliquée telle quelle — y compris « tout
 * inactif », qui signifie « manuel uniquement ». La validation le signale.
 *
 * Aucune version effective (tables absentes, base illisible) : défauts du code,
 * même doctrine que `config-resolver` — une console ne casse pas le produit.
 */
import type { Treatment } from '../config/treatments';
import { SCHEDULE_PERIOD_HOURS, TRIGGER_CATALOG, activeUnlessDeclaredCodes, retiredTriggerCodes } from '../config/catalogs';
import type { TriggerSetting } from '../config/config-types';

/**
 * Déclencheurs du comportement historique, appliqués tant que la version ne
 * renseigne pas les siens. T3 quotidien = ancien `T3_ACCOUNT_RECONCILIATION_
 * INTERVAL_HOURS` (24 h par défaut). T1 n'a pas de planification par défaut :
 * sa reprise périodique reste portée par `analysis-recovery-scheduler`.
 */
export const DEFAULT_TRIGGERS: Readonly<Record<'T1' | 'T3' | 'T4', readonly string[]>> = {
  // CDC 15 CFG-04 : `analysis_recovery` et `coherence_ai_review` gouvernent
  // désormais la reprise T1 toutes les 5 min et la revue IA du cron de
  // cohérence, qui partaient en dur ; actifs par défaut (comportement
  // historique), y compris dans une liste renseignée qui ne les mentionne pas
  // (`activeUnlessDeclared`). `web_link_added` retiré : il n'a jamais rien
  // conditionné.
  T1: ['source_uploaded', 'analysis_recovery'],
  T3: ['source_analyzed', 'document_linked', 'asset_updated', 'arbitration_resolved', 'schedule_daily', 'coherence_ai_review'],
  T4: ['source_analyzed'],
};

/** Codes actifs, d'après une ligne de configuration (pur, testé). */
export function activeTriggerCodes(treatment: Treatment, configured: TriggerSetting[] | null | undefined): Set<string> {
  if (!configured || configured.length === 0) {
    return new Set((DEFAULT_TRIGGERS as Record<string, readonly string[]>)[treatment] ?? []);
  }
  // Un code retiré (CDC 15 CFG-04) n'est jamais actif, même coché dans une
  // version antérieure.
  const retires = retiredTriggerCodes();
  const actifs = new Set(configured.filter((t) => t.active && !retires.has(t.code)).map((t) => t.code));
  // Code introduit après la version (CDC 15 CFG-04) : absent de la liste, il
  // reste actif ; seul un `active: false` explicite le coupe.
  const declares = new Set(configured.map((t) => t.code));
  for (const code of activeUnlessDeclaredCodes(treatment)) {
    if (!declares.has(code)) actifs.add(code);
  }
  return actifs;
}

type ConfigLoader = (treatment: Treatment) => Promise<{ triggers: TriggerSetting[] } | null>;

const defaultLoader: ConfigLoader = async (treatment) => {
  const { resolveTreatmentConfig } = await import('../config/config-resolver');
  return resolveTreatmentConfig(treatment);
};

let loader: ConfigLoader = defaultLoader;

/** Réservé aux tests. */
export function __setTriggerConfigLoader(l: ConfigLoader | null): void {
  loader = l ?? defaultLoader;
}

/**
 * Le déclencheur est-il actif pour ce traitement dans la version effective ?
 *
 * Ne lève jamais. En cas d'erreur de lecture : défauts du code.
 */
export async function isTriggerActive(treatment: Treatment, code: string): Promise<boolean> {
  let configured: TriggerSetting[] | null = null;
  try {
    configured = (await loader(treatment))?.triggers ?? null;
  } catch {
    configured = null;
  }
  return activeTriggerCodes(treatment, configured).has(code);
}

/**
 * Planification active la plus fréquente du traitement, ou `null`.
 *
 * Plusieurs planifications actives (§15.1 : « plusieurs déclencheurs par
 * traitement ») : la plus fréquente les contient toutes, puisque le périmètre
 * planifié est le même — l'ensemble pertinent du traitement.
 */
export function shortestSchedule(codes: Set<string>): { code: string; periodHours: number } | null {
  let best: { code: string; periodHours: number } | null = null;
  for (const code of codes) {
    const h = SCHEDULE_PERIOD_HOURS[code];
    if (h === undefined) continue;
    if (!best || h < best.periodHours) best = { code, periodHours: h };
  }
  return best;
}

/** Une planification est-elle échue ? (pur) */
export function isScheduleDue(lastFiredAt: Date | null, periodHours: number, now: Date = new Date()): boolean {
  if (!lastFiredAt) return true;
  return now.getTime() - lastFiredAt.getTime() >= periodHours * 3_600_000;
}

/** Traitements qui ont un périmètre planifié défini dans le code (catalogs.ts). */
export function schedulableTreatments(): Treatment[] {
  const out = new Set<Treatment>();
  for (const d of TRIGGER_CATALOG) {
    if (d.kind === 'schedule') for (const t of d.treatments ?? []) out.add(t as Treatment);
  }
  return [...out];
}

export interface ScheduleDeps {
  lastScheduledAt(treatment: Treatment): Promise<Date | null>;
  enqueueScheduled(treatment: Treatment, triggerCode: string): Promise<void>;
  loadTriggers(treatment: Treatment): Promise<TriggerSetting[] | null>;
}

const defaultScheduleDeps: ScheduleDeps = {
  async lastScheduledAt(treatment) {
    const { pgClient } = await import('@/db');
    // Dernier passage planifié, qu'il ait réussi ou non : un passage en échec
    // ne doit pas être relancé à chaque tour (le backoff de la file s'en charge).
    const rows = (await pgClient.unsafe(
      `SELECT MAX(created_at) AS at FROM ai_job_queue
        WHERE treatment = $1 AND account_id IS NULL AND target_type IS NULL
          AND trigger_code LIKE 'schedule_%'`,
      [treatment] as never[],
    )) as unknown as Array<{ at: Date | string | null }>;
    return rows[0]?.at ? new Date(String(rows[0].at)) : null;
  },
  async enqueueScheduled(treatment, triggerCode) {
    const { enqueue } = await import('./job-queue.repository');
    // Périmètre global (§15.1 : « l'ensemble pertinent du traitement ») ; la
    // déduplication évite deux balayages en attente simultanés.
    await enqueue({ treatment, scope: {}, triggerCode, payload: { scheduled: true, triggerCode } });
  },
  async loadTriggers(treatment) {
    return (await loader(treatment))?.triggers ?? null;
  },
};

/**
 * Met en file les passages planifiés échus. Appelé à chaque tour du boucleur,
 * sous son bail (une seule instance planifie). Ne lève jamais.
 */
export async function runDueSchedules(
  now: Date = new Date(),
  deps: ScheduleDeps = defaultScheduleDeps,
): Promise<Array<{ treatment: Treatment; triggerCode: string }>> {
  const fired: Array<{ treatment: Treatment; triggerCode: string }> = [];
  for (const treatment of schedulableTreatments()) {
    try {
      const codes = activeTriggerCodes(treatment, await deps.loadTriggers(treatment).catch(() => null));
      const schedule = shortestSchedule(codes);
      if (!schedule) continue;
      if (!isScheduleDue(await deps.lastScheduledAt(treatment), schedule.periodHours, now)) continue;
      await deps.enqueueScheduled(treatment, schedule.code);
      fired.push({ treatment, triggerCode: schedule.code });
    } catch (e) {
      console.error(`[triggers] planification ${treatment} impossible (non bloquant) :`, (e as Error).message);
    }
  }
  return fired;
}
