/**
 * Tableau de bord IA — CDC BO IA SCR-01 (VER-01, DRF-01, PER-01, GST-01).
 *
 * Fonctions pures partagées par la route `GET /api/admin/ai/dashboard` et
 * l'écran : fenêtre de supervision, UID abrégé, état global.
 */

/** PER-01 : fenêtres proposées (jours). 1 = 24 h. */
export const DASHBOARD_WINDOWS = [1, 7, 30] as const;
export type DashboardWindow = (typeof DASHBOARD_WINDOWS)[number];

export const DEFAULT_DASHBOARD_WINDOW: DashboardWindow = 7;

export const DASHBOARD_WINDOW_LABELS: Record<DashboardWindow, string> = {
  1: '24 h',
  7: '7 j',
  30: '30 j',
};

/**
 * Lit le paramètre `days` : seules 1, 7 et 30 sont acceptées, sinon la
 * fenêtre par défaut (7 j). La fenêtre ne change que la LECTURE des métriques
 * (PER-01), jamais les données.
 */
export function parseDashboardWindow(raw: string | null | undefined): DashboardWindow {
  const n = Number(raw);
  return (DASHBOARD_WINDOWS as readonly number[]).includes(n) ? (n as DashboardWindow) : DEFAULT_DASHBOARD_WINDOW;
}

/** VER-01 : UID abrégé (8 premiers caractères, sans tirets). */
export function shortUid(uid: string | null | undefined): string {
  if (!uid) return '';
  return uid.replace(/-/g, '').slice(0, 8);
}

/**
 * GST-01 : état global. Deux valeurs seulement — « Opérationnel » ou « Arrêt
 * d'urgence » — le CDC interdit d'inventer un état « dégradé » : un
 * traitement suspendu se lit sur sa carte et dans les alertes.
 */
export function globalAiStatus(emergencyStopActive: boolean): {
  key: 'operational' | 'emergency_stop';
  label: string;
} {
  return emergencyStopActive
    ? { key: 'emergency_stop', label: 'Arrêt d’urgence' }
    : { key: 'operational', label: 'Opérationnel' };
}

/** Activité d'un traitement (sous-ensemble utile au choix de fenêtre). */
export interface WindowedActivity {
  calls24h: number;
  calls7d: number;
  calls30d: number;
  failed24h?: number;
  failed7d?: number;
  failed30d?: number;
  successRate24h?: number | null;
  successRate7d: number | null;
  successRate30d?: number | null;
}

/** PER-01 / VOL-01 : volumes, échecs et taux de succès de la fenêtre choisie. Pur. */
export function activityForWindow(
  a: WindowedActivity,
  days: DashboardWindow,
): { calls: number; failed: number; successRate: number | null } {
  if (days === 1) return { calls: a.calls24h, failed: a.failed24h ?? 0, successRate: a.successRate24h ?? null };
  if (days === 30) return { calls: a.calls30d, failed: a.failed30d ?? 0, successRate: a.successRate30d ?? null };
  return { calls: a.calls7d, failed: a.failed7d ?? 0, successRate: a.successRate7d };
}
