/**
 * T6 EVALUATE — reprise BORNÉE des décisions à empreinte antérieure (lot 109E,
 * ticket « [P1] T6 EVALUATE — Corriger la perte de sens dans l'empreinte des
 * preuves »).
 *
 * Les empreintes `v4:` (et antérieures) effaçaient des mots porteurs de sens
 * (« et », « ou », « pour », « votre »…), les accents et la ponctuation : une
 * décision qui les porte est AMBIGUË — rien ne prouve que ses preuves avaient
 * le sens des preuves actuelles. Elle n'est donc jamais réutilisée
 * (`FINGERPRINT_UPGRADE`, `assessmentFreshness`), et sa réévaluation est
 * ÉCHELONNÉE pour éviter un pic d'appels IA au déploiement :
 *
 *   · budget glissant PAR INSTANCE de candidats « à reprendre » transmis à
 *     EVALUATE (`MASCOT_T6_UPGRADE_PER_MINUTE`, défaut 60 par minute, 1 à
 *     1 000) — les autres réévaluations (contexte changé, première
 *     évaluation, report échu…) n'y sont jamais soumises ;
 *   · au-delà : candidat laissé en attente (« examen en cours », jamais
 *     présenté) et pré-génération DIFFÉRÉE du compte à la libération du
 *     budget — aucune boucle (aucune reprise immédiate sans budget) ;
 *   · une fois réévaluée, la décision porte l'empreinte `v5:` : plus aucune
 *     reprise (aucune réévaluation répétitive) ; l'anti-boucle durable des
 *     exécutions (`t6_evaluation_runs`) reste appliqué.
 */
import { envNumber } from '@/lib/env-number';

/** Fenêtre du budget glissant. */
export const T6_UPGRADE_WINDOW_MS = 60_000;
/** Délai minimal avant une nouvelle tentative différée. */
const T6_UPGRADE_MIN_RETRY_MS = 5_000;

/** Candidats « à reprendre » transmis au plus par minute et par instance (`MASCOT_T6_UPGRADE_PER_MINUTE`). */
export function t6UpgradePerMinute(env: Record<string, string | undefined> = process.env): number {
  return Math.min(1000, Math.floor(envNumber('MASCOT_T6_UPGRADE_PER_MINUTE', 60, { min: 1 }, env)));
}

export interface T6UpgradeBudget {
  /** Réserve au plus `wanted` places ; rend le nombre accordé (0 : budget épuisé). */
  take: (wanted: number) => number;
  /** Délai avant la libération d'une place (ms ; 0 si une place est libre). */
  retryInMs: () => number;
}

/** Budget glissant (pur hors horloge injectée ; testé). */
export function createT6UpgradeBudget(o: { perWindow: number | (() => number); windowMs?: number; now?: () => number }): T6UpgradeBudget {
  const fenetre = o.windowMs ?? T6_UPGRADE_WINDOW_MS;
  const maintenant = o.now ?? (() => Date.now());
  const limite = () => Math.max(1, Math.floor(typeof o.perWindow === 'function' ? o.perWindow() : o.perWindow));
  let prises: Array<{ at: number; n: number }> = [];
  const purger = (t: number) => { prises = prises.filter((x) => t - x.at < fenetre); };
  const utilise = () => prises.reduce((s, x) => s + x.n, 0);
  return {
    take(wanted) {
      const t = maintenant();
      purger(t);
      const n = Math.max(0, Math.min(Math.floor(wanted), limite() - utilise()));
      if (n > 0) prises.push({ at: t, n });
      return n;
    },
    retryInMs() {
      const t = maintenant();
      purger(t);
      if (utilise() < limite()) return 0;
      return Math.max(T6_UPGRADE_MIN_RETRY_MS, prises[0].at + fenetre - t);
    },
  };
}

let defaut = createT6UpgradeBudget({ perWindow: () => t6UpgradePerMinute() });
/** Budget de l'instance (préparation T6). */
export const t6UpgradeBudget: T6UpgradeBudget = {
  take: (n) => defaut.take(n),
  retryInMs: () => defaut.retryInMs(),
};
/** Réservé aux tests. */
export function resetT6UpgradeBudget(): void {
  defaut = createT6UpgradeBudget({ perWindow: () => t6UpgradePerMinute() });
}
