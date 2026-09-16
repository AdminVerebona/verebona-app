/**
 * Promotion temporelle des actions — CDC V2.0 §9.2, §9.3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE FRANCHISSEMENT EST UN ÉVÉNEMENT QUE PERSONNE NE DÉCLENCHE
 *
 * §9.2 : « Une action liée à une date ou une échéance peut changer de priorité
 * lorsque le seuil temporel défini par sa règle est franchi. »
 *
 * `resolvePriority()` sait décider — mais il n'est appelé qu'à la CRÉATION
 * d'une action. Or le franchissement se produit bien plus tard, sans qu'aucun
 * document n'arrive ni qu'aucune analyse ne tourne : le temps passe, c'est
 * tout. Sans ce balayage, une échéance à trente jours ne serait jamais
 * promue, et la fonction resterait morte.
 *
 * ── ET POURTANT, PAS DE RECALCUL GLOBAL ───────────────────────────────────
 *
 * §9.2, dernier alinéa : « Les autres actions ne sont pas recalculées
 * globalement à chaque passage du traitement d'optimisation. »
 *
 * Ce module ne touche donc QUE les actions qui viennent de franchir leur
 * seuil. Il ne rétrograde rien, ne réordonne rien, ne remplit aucune place
 * libérée. Un tri complet du parc à chaque passage ferait bouger la file sous
 * les yeux de l'utilisateur sans qu'il ait rien fait.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq, isNull, isNotNull, ne, sql } from 'drizzle-orm';
import { db } from '@/db';
import { toProcessActions } from '@/db/schema';
import type { ActionPriority } from './action-model';
import { admitToDoFirst, type PriorityCandidate } from './priority';
import { getRule, priorityForRule } from './rules-catalog';

export interface PromotionReport {
  examined: number;
  promoted: number;
  /** Actions descendues pour faire place, plafond atteint (§9.3). */
  demoted: number;
  /** Franchissements refusés : le plafond était tenu par plus important. */
  refused: number;
}

/**
 * Promeut les actions dont l'échéance vient d'entrer dans la fenêtre.
 *
 * Le plafond de dix est respecté par `admitToDoFirst` : une promotion peut
 * faire descendre une action moins importante, ou être refusée. C'est le même
 * arbitrage qu'à la création, et il est intentionnel qu'une échéance qui
 * approche ne prime pas automatiquement sur un problème plus lourd.
 */
export async function promoteDueActions(accountId: number, now: Date = new Date()): Promise<PromotionReport> {
  const report: PromotionReport = { examined: 0, promoted: 0, demoted: 0, refused: 0 };

  const candidates = await db
    .select({
      id: toProcessActions.id,
      ruleCode: toProcessActions.ruleCode,
      priority: toProcessActions.priority,
      activeSince: toProcessActions.activeSince,
      dueDate: toProcessActions.dueDate,
    })
    .from(toProcessActions)
    .where(
      and(
        eq(toProcessActions.accountId, accountId),
        isNull(toProcessActions.resolvedAt),
        isNotNull(toProcessActions.dueDate),
        // Déjà prioritaires : rien à promouvoir, et les reprendre ferait
        // entrer dans le calcul de plafond des actions qui y sont déjà.
        ne(toProcessActions.priority, 'DO_FIRST'),
      ),
    );

  if (candidates.length === 0) return report;

  const enPlace = await loadDoFirst(accountId);

  for (const candidate of candidates) {
    const rule = getRule(candidate.ruleCode);
    if (!rule?.dueSoonDays || !candidate.dueDate) continue;

    const jours = Math.floor(
      (candidate.dueDate.getTime() - now.getTime()) / 86_400_000,
    );
    if (jours > rule.dueSoonDays) continue; // seuil non franchi

    report.examined += 1;

    const entrant: PriorityCandidate = {
      id: candidate.id,
      ruleCode: candidate.ruleCode,
      priority: 'DO_FIRST',
      activeSince: candidate.activeSince,
      dueDate: candidate.dueDate,
    };

    const admission = admitToDoFirst(entrant, enPlace, now);
    if (!admission.admitted) {
      report.refused += 1;
      continue;
    }

    await db.transaction(async (tx) => {
      if (admission.demoted?.id) {
        await tx
          .update(toProcessActions)
          .set({ priority: 'DO_NEXT' satisfies ActionPriority, updatedAt: now })
          .where(eq(toProcessActions.id, admission.demoted.id));
      }
      await tx
        .update(toProcessActions)
        .set({ priority: 'DO_FIRST' satisfies ActionPriority, updatedAt: now })
        .where(eq(toProcessActions.id, candidate.id));
    });

    report.promoted += 1;
    if (admission.demoted) {
      report.demoted += 1;
      // La liste en place suit les mouvements : sans cela, le candidat suivant
      // verrait encore l'action qu'on vient de faire descendre, et le plafond
      // serait dépassé d'autant.
      const index = enPlace.findIndex((a) => a.id === admission.demoted!.id);
      if (index >= 0) enPlace.splice(index, 1);
    }
    enPlace.push(entrant);
  }

  return report;
}

async function loadDoFirst(accountId: number): Promise<PriorityCandidate[]> {
  const rows = await db
    .select({
      id: toProcessActions.id,
      ruleCode: toProcessActions.ruleCode,
      activeSince: toProcessActions.activeSince,
      dueDate: toProcessActions.dueDate,
    })
    .from(toProcessActions)
    .where(
      and(
        eq(toProcessActions.accountId, accountId),
        eq(toProcessActions.priority, 'DO_FIRST'),
        isNull(toProcessActions.resolvedAt),
      ),
    );

  return rows.map((r) => ({
    id: r.id,
    ruleCode: r.ruleCode,
    priority: 'DO_FIRST' as const,
    activeSince: r.activeSince,
    dueDate: r.dueDate,
  }));
}

/**
 * Aligne la priorité d'une action sur sa règle après modification du
 * catalogue.
 *
 * Utile après une évolution de `rules-catalog` : les actions créées sous
 * l'ancienne priorité gardent la leur, ce qui fait cohabiter deux barèmes pour
 * le même problème. À lancer manuellement, jamais en routine — le §9.2 interdit
 * le recalcul global périodique.
 */
export async function realignPriorities(accountId: number): Promise<number> {
  const actions = await db
    .select({
      id: toProcessActions.id,
      ruleCode: toProcessActions.ruleCode,
      actionKind: toProcessActions.actionKind,
      priority: toProcessActions.priority,
    })
    .from(toProcessActions)
    .where(
      and(eq(toProcessActions.accountId, accountId), isNull(toProcessActions.resolvedAt)),
    );

  let changed = 0;
  for (const action of actions) {
    const rule = getRule(action.ruleCode);
    if (!rule) continue;
    // Les promotions d'échéance ne sont pas défaites : elles reflètent le
    // temps, pas le catalogue.
    if (action.priority === 'DO_FIRST') continue;

    const attendue = priorityForRule(
      rule,
      action.actionKind === 'ARBITRATE' ? 'ARBITRATE' : 'COMPLETE',
    );
    if (attendue === action.priority) continue;

    await db
      .update(toProcessActions)
      .set({ priority: attendue, updatedAt: new Date() })
      .where(eq(toProcessActions.id, action.id));
    changed += 1;
  }

  return changed;
}

/** Nombre d'actions « À faire d'abord » d'un compte — contrôle du plafond. */
export async function countDoFirst(accountId: number): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`COUNT(*)::int` })
    .from(toProcessActions)
    .where(
      and(
        eq(toProcessActions.accountId, accountId),
        eq(toProcessActions.priority, 'DO_FIRST'),
        isNull(toProcessActions.resolvedAt),
      ),
    );
  return row?.total ?? 0;
}
