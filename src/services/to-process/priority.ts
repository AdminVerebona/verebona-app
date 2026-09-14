/**
 * Règles de priorité — CDC V2.0 §9.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DIX PLACES, ET AUCUN QUOTA À REMPLIR
 *
 * Le §9.3 pose une limite qui se prête mal à l'intuition : « 10 est un
 * maximum, pas un quota à remplir en permanence. Lorsqu'une action "À faire
 * d'abord" est résolue, aucune action existante "À faire ensuite" n'est
 * promue automatiquement pour remplir la place. »
 *
 * L'implémentation naïve — trier toutes les actions et marquer les dix
 * premières — viole cette règle à chaque passage : résoudre une action en
 * promeut aussitôt une autre, et l'utilisateur qui vide sa file la voit se
 * remplir toute seule. Le sentiment produit est celui d'un travail sans fin.
 *
 * `admitToDoFirst` ne raisonne donc que sur un ÉVÉNEMENT : une action
 * nouvelle, ou une promotion temporelle déclenchée par une règle d'échéance
 * (§9.2). En dehors de ces deux cas, rien n'est recalculé. Le §9.2 le dit
 * d'ailleurs explicitement : « Les autres actions ne sont pas recalculées
 * globalement à chaque passage du traitement d'optimisation. »
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { ActionPriority, ToProcessAction } from './action-model';
import { getRule } from './rules-catalog';

/** §9.3 — plafond global au compte, toutes natures et tous objets confondus. */
export const DO_FIRST_CAP = 10;

const PRIORITY_ORDER: Record<ActionPriority, number> = {
  DO_FIRST: 0,
  DO_NEXT: 1,
  CAN_WAIT: 2,
};

export const PRIORITY_LABELS: Record<ActionPriority, string> = {
  DO_FIRST: "À faire d'abord",
  DO_NEXT: 'À faire ensuite',
  CAN_WAIT: 'Peut attendre',
};

/** Action candidate aux dix places, avec ce qui sert à la départager. */
export interface PriorityCandidate {
  id?: number;
  ruleCode: string;
  priority: ActionPriority;
  activeSince: Date;
  dueDate?: Date | null;
}

/**
 * Score de départage (§9.4) : impact métier, puis proximité d'échéance, puis
 * ancienneté. Plus haut = plus prioritaire.
 *
 * Le §9.4 précise que « ce classement interne n'est pas affiché sous forme de
 * score à l'utilisateur ». Il ne sort donc jamais de ce module et n'est pas
 * persisté : le recalculer coûte moins cher que d'entretenir une colonne qui
 * finirait par diverger de la règle qui l'a produite.
 */
export function tiebreakScore(candidate: PriorityCandidate, now: Date): number {
  const rule = getRule(candidate.ruleCode);
  const impact = rule?.businessImpact ?? 50;

  let dueBonus = 0;
  if (candidate.dueDate) {
    const days = Math.floor(
      (candidate.dueDate.getTime() - now.getTime()) / 86_400_000,
    );
    // Une échéance passée ou imminente pèse autant qu'un impact fort ; une
    // échéance lointaine ne pèse rien.
    if (days <= 0) dueBonus = 100;
    else if (days <= 90) dueBonus = Math.round(100 - (days / 90) * 100);
  }

  const ageDays = Math.floor((now.getTime() - candidate.activeSince.getTime()) / 86_400_000);
  const ageBonus = Math.min(ageDays, 365) / 365; // < 1 : ne départage qu'à égalité.

  return impact * 1000 + dueBonus * 10 + ageBonus;
}

export interface AdmissionResult {
  /** L'action entrante prend-elle une place « À faire d'abord » ? */
  admitted: boolean;
  /**
   * Action rétrogradée vers « À faire ensuite » pour lui faire place.
   * `null` si le plafond n'était pas atteint ou si l'entrante n'entre pas.
   */
  demoted: PriorityCandidate | null;
  reason: string;
}

/**
 * Une action peut-elle entrer dans le groupe « À faire d'abord » ? (§9.3)
 *
 * `currentDoFirst` doit contenir les actions ACTIVES déjà classées
 * « À faire d'abord » sur le compte. L'entrante n'en fait pas partie.
 */
export function admitToDoFirst(
  incoming: PriorityCandidate,
  currentDoFirst: readonly PriorityCandidate[],
  now: Date = new Date(),
): AdmissionResult {
  if (currentDoFirst.length < DO_FIRST_CAP) {
    return {
      admitted: true,
      demoted: null,
      reason: `Place disponible (${currentDoFirst.length}/${DO_FIRST_CAP}).`,
    };
  }

  const incomingScore = tiebreakScore(incoming, now);
  const weakest = [...currentDoFirst].sort(
    (a, b) => tiebreakScore(a, now) - tiebreakScore(b, now),
  )[0];

  if (incomingScore <= tiebreakScore(weakest, now)) {
    return {
      admitted: false,
      demoted: null,
      reason:
        'Plafond atteint et aucune action en place n’est moins importante : ' +
        'l’entrante reste « À faire ensuite ».',
    };
  }

  return {
    admitted: true,
    demoted: weakest,
    reason:
      'Plafond atteint : l’action la moins importante descend vers ' +
      '« À faire ensuite » (§9.3).',
  };
}

/**
 * Priorité effective d'une action au moment de sa création ou d'un événement
 * d'échéance.
 *
 * ── LA PROMOTION TEMPORELLE N'EST PAS UN RECALCUL ─────────────────────────
 *
 * §9.2 : « Une action liée à une date ou une échéance peut changer de
 * priorité lorsque le seuil temporel défini par sa règle est franchi. » Le
 * franchissement est un événement ponctuel, pas une réévaluation continue :
 * cette fonction ne rend `DO_FIRST` que si le seuil `dueSoonDays` de la règle
 * est effectivement franchi.
 */
export function resolvePriority(
  ruleCode: string,
  basePriority: ActionPriority,
  dueDate: Date | null | undefined,
  now: Date = new Date(),
): { priority: ActionPriority; promotedByDueDate: boolean } {
  const rule = getRule(ruleCode);
  if (!rule?.dueSoonDays || !dueDate) {
    return { priority: basePriority, promotedByDueDate: false };
  }

  const days = Math.floor((dueDate.getTime() - now.getTime()) / 86_400_000);
  if (days <= rule.dueSoonDays) {
    return { priority: 'DO_FIRST', promotedByDueDate: true };
  }
  return { priority: basePriority, promotedByDueDate: false };
}

// ── Ordres de liste (§9.5) ──────────────────────────────────────────────────

type Orderable = Pick<ToProcessAction, 'priority' | 'actionKind' | 'activeSince'>;

/** « Par priorité » : priorité → ancienneté. Vue par défaut (§8.2). */
export function comparePriorityMode(a: Orderable, b: Orderable): number {
  const byPriority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  if (byPriority !== 0) return byPriority;
  return a.activeSince.getTime() - b.activeSince.getTime();
}

/** « Par action » : nature → priorité → ancienneté (§8.2, §9.5). */
export function compareActionMode(a: Orderable, b: Orderable): number {
  if (a.actionKind !== b.actionKind) return a.actionKind === 'ARBITRATE' ? -1 : 1;
  const byPriority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  if (byPriority !== 0) return byPriority;
  return a.activeSince.getTime() - b.activeSince.getTime();
}

export type OrderMode = 'BY_PRIORITY' | 'BY_ACTION';

export function sortActions<T extends Orderable>(actions: T[], mode: OrderMode): T[] {
  const comparator = mode === 'BY_PRIORITY' ? comparePriorityMode : compareActionMode;
  return [...actions].sort(comparator);
}
