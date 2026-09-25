/**
 * Persistance de la file « À traiter » — CDC V2.0 §7.3, §7.4, §9.3, §13.4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS OPÉRATIONS, ET UNE SEULE PORTE D'ENTRÉE
 *
 * `upsertAction` est la seule façon de créer ou d'entretenir une action. Le
 * §7.3 l'exige : « Si le traitement d'optimisation retrouve le même problème,
 * il met à jour l'action existante et ses propositions/sources. Une nouvelle
 * action est créée uniquement pour un problème distinct. »
 *
 * Laisser le pipeline insérer directement rendrait P-07 — « une action active
 * représente un problème métier unique » — dépendant de la discipline de
 * chaque appelant. L'index partiel du §13.4 rattraperait le doublon par une
 * erreur SQL, ce qui est un filet, pas une conception.
 *
 * ── LE PLAFOND EST APPLIQUÉ ICI, PAS DANS LE PIPELINE ─────────────────────
 *
 * Le §9.3 veut qu'une action très importante puisse entrer dans les dix
 * places en faisant descendre la moins prioritaire. Ce mouvement touche DEUX
 * lignes et doit être atomique : une entrante admise sans que la sortante
 * descende laisserait onze actions « À faire d'abord », et l'inverse en
 * laisserait neuf plus une action perdue.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db } from '@/db';
import { toProcessActionEvents, toProcessActions } from '@/db/schema';
import type {
  ActionKind,
  ActionPriority,
  ActionProposal,
  ResolutionReason,
  TargetType,
  ToProcessAction,
} from './action-model';
import { isDisplayableArbitration, selectDisplayedProposals } from './action-model';
import { getRule, priorityForRule } from './rules-catalog';
import { admitToDoFirst, resolvePriority, type PriorityCandidate } from './priority';

export interface UpsertActionInput {
  accountId: number;
  targetType: TargetType;
  targetId: number;
  fieldKey?: string | null;
  relationKey?: string | null;
  actionKind: ActionKind;
  ruleCode: string;
  proposals?: ActionProposal[];
  dueDate?: Date | null;
  /** Question personnalisée ; à défaut, celle de la règle. */
  question?: string;
  /**
   * Éléments déclencheurs propres au producteur (identifiant / version de la
   * preuve source, date de la donnée métier…). Entre dans l'empreinte qui
   * décide si une action « Non applicable » peut revenir (§7.4).
   */
  triggerContext?: Record<string, unknown> | null;
}

export interface UpsertActionResult {
  status: 'CREATED' | 'UPDATED' | 'SKIPPED';
  /** Motif machine d'un SKIPPED, quand il y en a un. */
  code?: 'NOT_APPLICABLE_UNCHANGED';
  actionId?: number;
  priority?: ActionPriority;
  /** Action rétrogradée pour faire place à l'entrante (§9.3). */
  demotedActionId?: number;
  /** Action d'une autre nature fermée (OBSOLETE) : le problème a changé de forme. */
  replacedActionId?: number;
  reason: string;
}

/** Sérialisation canonique : clés triées, pour une empreinte stable. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v instanceof Date ? v.toISOString().slice(0, 10) : v;
}

/**
 * Empreinte des éléments déclencheurs d'une action (§7.4).
 *
 * Ce qui compte : la règle, la nature, les VALEURS proposées et leurs
 * PREUVES, l'échéance (au jour), et le contexte fourni par le producteur.
 * Libellés et confiance en sont exclus : ils varient d'un passage à l'autre
 * sans que la situation change, et rouvriraient une action refusée pour rien.
 */
export function computeTriggerContextHash(p: {
  ruleCode: string;
  actionKind: ActionKind;
  proposals: Array<Pick<ActionProposal, 'value' | 'evidenceIds'>>;
  dueDate?: Date | null;
  triggerContext?: Record<string, unknown> | null;
}): string {
  const proposals = p.proposals
    .map((x) => ({ value: x.value ?? null, evidence: [...(x.evidenceIds ?? [])].sort() }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const payload = canonical({
    rule: p.ruleCode,
    kind: p.actionKind,
    proposals,
    due: p.dueDate ?? null,
    ctx: p.triggerContext ?? null,
  });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Crée ou met à jour l'action correspondant à un problème.
 *
 * Retourne `SKIPPED` sans rien écrire lorsque l'action ne serait pas
 * affichable — un arbitrage sans proposition (ATP-05) ou une règle inconnue.
 * Écrire quand même produirait une carte vide, que l'utilisateur ne pourrait
 * ni résoudre ni faire disparaître.
 */
export async function upsertAction(input: UpsertActionInput): Promise<UpsertActionResult> {
  const rule = getRule(input.ruleCode);
  if (!rule) {
    return { status: 'SKIPPED', reason: `Règle inconnue : ${input.ruleCode}.` };
  }

  const proposals = input.proposals ?? [];
  if (input.actionKind === 'ARBITRATE' && !isDisplayableArbitration(proposals)) {
    return {
      status: 'SKIPPED',
      reason:
        'Arbitrage sans proposition affichable : l’action n’est pas créée (ATP-05).',
    };
  }

  const fieldKey = input.fieldKey ?? null;
  const relationKey = input.relationKey ?? null;
  if ((fieldKey === null) === (relationKey === null)) {
    return {
      status: 'SKIPPED',
      reason: 'Exactement l’une des clés fieldKey / relationKey doit être fournie.',
    };
  }

  const dataKey = fieldKey ?? relationKey!;
  const now = new Date();
  const displayed = selectDisplayedProposals(proposals);
  const contextHash = computeTriggerContextHash({
    ruleCode: input.ruleCode,
    actionKind: input.actionKind,
    proposals: displayed,
    dueDate: input.dueDate ?? null,
    triggerContext: input.triggerContext ?? null,
  });

  // ══════════════════════════════════════════════════════════════════════
  // UNE SEULE ACTION ACTIVE PAR PROBLÈME MÉTIER, QUELLE QUE SOIT SA NATURE
  //
  // La recherche portait sur problème + nature : une action COMPLETE ouverte
  // n'était pas retrouvée quand une analyse produisait un ARBITRATE sur la
  // même donnée, et les deux restaient actives (compteur à 2 pour une seule
  // réponse attendue). La recherche porte désormais sur compte + objet +
  // champ / relation ; une nature différente est fermée (OBSOLETE) dans la
  // même transaction que la création de la nouvelle.
  // ══════════════════════════════════════════════════════════════════════
  const actives = await db
    .select()
    .from(toProcessActions)
    .where(
      and(
        eq(toProcessActions.accountId, input.accountId),
        eq(toProcessActions.targetType, input.targetType),
        eq(toProcessActions.targetId, input.targetId),
        sql`COALESCE(${toProcessActions.fieldKey}, ${toProcessActions.relationKey}) = ${dataKey}`,
        isNull(toProcessActions.resolvedAt),
      ),
    );
  const existing = actives.find((a) => a.actionKind === input.actionKind);
  const otherKind = actives.filter((a) => a.actionKind !== input.actionKind);

  // ── Problème déjà connu : mise à jour, jamais duplication (§7.3, AI-04) ──
  if (existing) {
    // Doublon historique d'une autre nature (antérieur à cette règle) :
    // fermé au passage.
    for (const old of otherKind) {
      await db
        .update(toProcessActions)
        .set({ resolvedAt: now, resolutionReason: 'OBSOLETE' satisfies ResolutionReason, updatedAt: now })
        .where(and(eq(toProcessActions.id, old.id), isNull(toProcessActions.resolvedAt)));
    }
    await db
      .update(toProcessActions)
      .set({
        proposalsJson: displayed,
        dueDate: input.dueDate ?? existing.dueDate,
        triggerContextHash: contextHash,
        triggerContext: (input.triggerContext ?? null) as never,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(toProcessActions.id, existing.id));

    return {
      status: 'UPDATED',
      actionId: existing.id,
      priority: existing.priority as ActionPriority,
      reason: 'Action active existante mise à jour avec les nouvelles propositions.',
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // « NON APPLICABLE » : PAS DE NOUVEAU CYCLE SANS ÉLÉMENT NOUVEAU (§7.4)
  //
  // La dernière action RÉSOLUE du même problème est relue. Si l'utilisateur
  // l'a déclarée « Non applicable » et que les éléments déclencheurs n'ont
  // pas changé (même empreinte), rien n'est recréé : NOT_APPLICABLE_UNCHANGED.
  // Une nouvelle preuve, une nouvelle valeur, une nouvelle échéance ou un
  // nouveau contexte producteur changent l'empreinte et ouvrent un nouveau
  // cycle ; la décision précédente reste conservée pour l'audit.
  // ══════════════════════════════════════════════════════════════════════
  const [lastResolved] = await db
    .select()
    .from(toProcessActions)
    .where(
      and(
        eq(toProcessActions.accountId, input.accountId),
        eq(toProcessActions.targetType, input.targetType),
        eq(toProcessActions.targetId, input.targetId),
        sql`COALESCE(${toProcessActions.fieldKey}, ${toProcessActions.relationKey}) = ${dataKey}`,
        isNotNull(toProcessActions.resolvedAt),
      ),
    )
    .orderBy(desc(toProcessActions.resolvedAt))
    .limit(1);

  if (lastResolved?.resolutionReason === 'NOT_APPLICABLE') {
    // Ligne antérieure à l'empreinte : recalculée depuis ce qu'elle a conservé.
    const previousHash = lastResolved.triggerContextHash ?? computeTriggerContextHash({
      ruleCode: lastResolved.ruleCode,
      actionKind: lastResolved.actionKind as ActionKind,
      proposals: (lastResolved.proposalsJson as ActionProposal[] | null) ?? [],
      dueDate: lastResolved.dueDate ?? null,
      triggerContext: (lastResolved.triggerContext as Record<string, unknown> | null) ?? null,
    });
    if (previousHash === contextHash) {
      return {
        status: 'SKIPPED',
        code: 'NOT_APPLICABLE_UNCHANGED',
        actionId: lastResolved.id,
        reason: 'Déclarée « Non applicable » par l’utilisateur, sans élément nouveau depuis : pas de nouvelle action (§7.4).',
      };
    }
  }

  // ── Nouvelle action : priorité, puis plafond (§9.2, §9.3) ───────────────
  const basePriority = priorityForRule(rule, input.actionKind);
  const { priority: wantedPriority } = resolvePriority(
    input.ruleCode,
    basePriority,
    input.dueDate,
    now,
  );

  let finalPriority: ActionPriority = wantedPriority;
  let demotedActionId: number | undefined;

  if (wantedPriority === 'DO_FIRST') {
    // L'action remplacée libère sa place : elle ne compte pas dans le plafond.
    const replacedIds = new Set(otherKind.map((a) => a.id));
    const currentDoFirst = (await loadDoFirstCandidates(input.accountId)).filter((c) => !replacedIds.has(c.id ?? -1));
    const admission = admitToDoFirst(
      { ruleCode: input.ruleCode, priority: 'DO_FIRST', activeSince: now, dueDate: input.dueDate },
      currentDoFirst,
      now,
    );
    if (!admission.admitted) {
      finalPriority = 'DO_NEXT';
    } else if (admission.demoted?.id) {
      demotedActionId = admission.demoted.id;
    }
  }

  // ── Cycle : un problème résolu puis réapparu repart à N+1 (§7.3) ────────
  const [{ maxCycle }] = await db
    .select({ maxCycle: sql<number>`COALESCE(MAX(${toProcessActions.cycleNumber}), 0)` })
    .from(toProcessActions)
    .where(
      and(
        eq(toProcessActions.accountId, input.accountId),
        eq(toProcessActions.targetType, input.targetType),
        eq(toProcessActions.targetId, input.targetId),
        sql`COALESCE(${toProcessActions.fieldKey}, ${toProcessActions.relationKey}) = ${dataKey}`,
        eq(toProcessActions.actionKind, input.actionKind),
      ),
    );

  const inserted = await db.transaction(async (tx) => {
    // Changement de nature : l'ancienne action est fermée, historisée, dans
    // la même transaction — jamais deux cartes actives sur la même donnée.
    for (const old of otherKind) {
      await tx
        .update(toProcessActions)
        .set({ resolvedAt: now, resolutionReason: 'OBSOLETE' satisfies ResolutionReason, updatedAt: now })
        .where(and(eq(toProcessActions.id, old.id), isNull(toProcessActions.resolvedAt)));
      await tx.insert(toProcessActionEvents).values({
        actionId: old.id,
        accountId: input.accountId,
        event: 'OBSOLETE',
        targetType: old.targetType,
        targetId: old.targetId,
        fieldKey: old.fieldKey ?? old.relationKey,
        details: { reason: 'NATURE_CHANGED', from: old.actionKind, to: input.actionKind, ruleCode: input.ruleCode },
        createdAt: now,
      });
    }

    if (demotedActionId) {
      await tx
        .update(toProcessActions)
        .set({ priority: 'DO_NEXT', updatedAt: now })
        .where(eq(toProcessActions.id, demotedActionId));
    }

    const [row] = await tx
      .insert(toProcessActions)
      .values({
        accountId: input.accountId,
        targetType: input.targetType,
        targetId: input.targetId,
        fieldKey,
        relationKey,
        actionKind: input.actionKind,
        ruleCode: input.ruleCode,
        priority: finalPriority,
        question: input.question ?? rule.question,
        proposalsJson: displayed,
        dueDate: input.dueDate ?? null,
        activeSince: now,
        lastSeenAt: now,
        cycleNumber: Number(maxCycle) + 1,
        triggerContextHash: contextHash,
        triggerContext: (input.triggerContext ?? null) as never,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: toProcessActions.id });

    return row;
  });

  return {
    status: 'CREATED',
    actionId: inserted.id,
    priority: finalPriority,
    demotedActionId,
    replacedActionId: otherKind[0]?.id,
    reason:
      finalPriority === wantedPriority
        ? 'Action créée.'
        : 'Action créée en « À faire ensuite » : plafond de dix atteint (§9.3).',
  };
}

async function loadDoFirstCandidates(accountId: number): Promise<PriorityCandidate[]> {
  const rows = await db
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
 * Ferme une action.
 *
 * Le §9.3 interdit explicitement de promouvoir une action existante pour
 * remplir la place libérée (critère PRI-03) : aucune réévaluation n'est donc
 * déclenchée ici. C'est une omission volontaire, et la seule qui respecte la
 * règle — une file qui se remplit toute seule à mesure qu'on la vide
 * décourage de la vider.
 */
export async function resolveAction(
  actionId: number,
  reason: ResolutionReason,
): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(toProcessActions)
    .set({ resolvedAt: now, resolutionReason: reason, updatedAt: now })
    .where(and(eq(toProcessActions.id, actionId), isNull(toProcessActions.resolvedAt)))
    .returning({ id: toProcessActions.id });

  return updated.length > 0;
}

/**
 * Ferme les actions portant sur une donnée que l'utilisateur vient de
 * corriger ailleurs (§5.3).
 *
 * Les deux natures sont fermées d'un coup : une donnée renseignée ne laisse
 * subsister ni l'arbitrage qui proposait des valeurs, ni la complétion qui en
 * réclamait une.
 */
export async function resolveActionsForData(
  accountId: number,
  targetType: TargetType,
  targetId: number,
  dataKey: string,
  reason: ResolutionReason = 'USER_COMPLETED',
): Promise<number> {
  const now = new Date();
  const updated = await db
    .update(toProcessActions)
    .set({ resolvedAt: now, resolutionReason: reason, updatedAt: now })
    .where(
      and(
        eq(toProcessActions.accountId, accountId),
        eq(toProcessActions.targetType, targetType),
        eq(toProcessActions.targetId, targetId),
        sql`COALESCE(${toProcessActions.fieldKey}, ${toProcessActions.relationKey}) = ${dataKey}`,
        isNull(toProcessActions.resolvedAt),
      ),
    )
    .returning({ id: toProcessActions.id });

  return updated.length;
}

/**
 * Rouvre une action fermée par erreur, après un « Annuler » (§8.5).
 *
 * « Une annulation restaure la valeur précédente et réactive le même problème
 * sans créer un nouveau cycle. » D'où la réouverture de la MÊME ligne plutôt
 * qu'une nouvelle : un nouveau cycle ferait apparaître l'action comme un
 * problème inédit, alors que l'utilisateur vient seulement de se raviser.
 */
export async function reopenAction(actionId: number): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(toProcessActions)
    .set({ resolvedAt: null, resolutionReason: null, lastSeenAt: now, updatedAt: now })
    .where(eq(toProcessActions.id, actionId))
    .returning({ id: toProcessActions.id });

  return updated.length > 0;
}

export interface ListActionsFilters {
  targetType?: TargetType;
  actionKind?: ActionKind;
  priority?: ActionPriority;
}

/** Actions actives d'un compte. L'ordre est appliqué par `sortActions`. */
export async function listActiveActions(
  accountId: number,
  filters: ListActionsFilters = {},
): Promise<ToProcessAction[]> {
  const conditions = [
    eq(toProcessActions.accountId, accountId),
    isNull(toProcessActions.resolvedAt),
  ];
  if (filters.targetType) conditions.push(eq(toProcessActions.targetType, filters.targetType));
  if (filters.actionKind) conditions.push(eq(toProcessActions.actionKind, filters.actionKind));
  if (filters.priority) conditions.push(eq(toProcessActions.priority, filters.priority));

  const rows = await db
    .select()
    .from(toProcessActions)
    .where(and(...conditions));

  return rows.map((row) => ({
    id: row.id,
    publicId: row.publicId,
    accountId: row.accountId,
    targetType: row.targetType as TargetType,
    targetId: row.targetId,
    fieldKey: row.fieldKey,
    relationKey: row.relationKey,
    actionKind: row.actionKind as ActionKind,
    ruleCode: row.ruleCode,
    priority: row.priority as ActionPriority,
    question: row.question,
    proposals: (row.proposalsJson as ActionProposal[] | null) ?? [],
    activeSince: row.activeSince,
    lastSeenAt: row.lastSeenAt,
    resolvedAt: row.resolvedAt,
    resolutionReason: row.resolutionReason as ResolutionReason | null,
    cycleNumber: row.cycleNumber,
    dueDate: row.dueDate,
  }));
}

/** Compteur de la pastille de navigation, reflétant les mêmes actions (§8.1). */
export async function countActiveActions(accountId: number): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`COUNT(*)::int` })
    .from(toProcessActions)
    .where(
      and(eq(toProcessActions.accountId, accountId), isNull(toProcessActions.resolvedAt)),
    );

  return row?.total ?? 0;
}
