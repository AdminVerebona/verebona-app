/**
 * Lot 113AA (Trello #725, §2 B — D11, R14) — carte « À traiter »
 * PERIOD-CONFLICT : la SEULE sollicitation de l'utilisateur sur les périodes
 * métier, réservée à une divergence importante que les preuves n'expliquent
 * pas (`resolution.ts` : CONTRADICTION — deux documents qualifiés par T1,
 * aucune relation d'avenant ni de rectificatif déclarée, aucune décision déjà
 * prise sur CETTE divergence).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *   · cible : un document de la divergence (identifiant le plus élevé —
 *     simple placement de la carte, jamais une préférence) ; relation
 *     `periodConflict:<événement>:<empreinte>` (une carte par divergence) ;
 *   · justificatifs : les deux documents (`documents` du contexte, liens
 *     « Voir les justificatifs ») ; chaque proposition cite SON document
 *     (`evidenceIds: file:<id>`) ;
 *   · choix : la période de l'un, la période de l'autre, ou « les deux sont
 *     justes » — décision DURABLE (`business_period_decisions`), relue par la
 *     résolution : jamais redemandée ; aucune période de document modifiée
 *     (la période écartée reste dans l'historique, « remplacée ») ;
 *   · fermeture automatique (OBSOLETE) quand la divergence disparaît
 *     (correction, réanalyse, avenant reçu) — balayage par le contrôle
 *     COH-OPS-PERIOD-RESOLUTION et après chaque passage T3.
 * Desktop et mobile : composants génériques de la file. Jamais « Opération ».
 *
 * CARTE #766 (E06, E07) :
 *   · une carte n'est JAMAIS posée parce que l'IA n'a pas pu travailler : réexamen T3 en attente (quel
 *     que soit son âge), en échec technique (essais épuisés) ou capacité T3 illisible (incident) → pas
 *     de carte ; la divergence reste affichée comme telle sur les fiches ;
 *   · un échec technique épuisé est réarmé ici, de façon bornée (`rearmFailedRelationReviews`) ;
 *   · une paire dont l'ordre n'est pas prouvé (borne manquante) fait l'objet d'une DEMANDE de réexamen
 *     T3 quand la branche est disponible — jamais d'une carte ;
 *   · sans la branche T3 (bloc 29 absent ou coupure volontaire : configuration, pas incident), le
 *     comportement 113AA est conservé : question pour deux documents qualifiés par T1.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { toProcessActionEvents, toProcessActions } from '@/db/schema';
import { periodLine } from '@/lib/documents/business-periods';
import type { ResolutionReason } from '@/services/to-process/action-model';
import type { DbClient, ResolveOptions, ResolveResult } from '@/services/to-process/resolve-action.service';

export const PERIOD_CONFLICT_RULE = 'PERIOD-CONFLICT';
/** À valider par le PO (même forme que la carte OPERATION-AMOUNT). */
export const PERIOD_CONFLICT_QUESTION = 'Ces documents indiquent des périodes différentes : laquelle est la bonne ?';
/** À valider par le PO. */
export const PERIOD_CONFLICT_BOTH_LABEL = 'Les deux sont justes';
const RELATION = 'periodConflict';

export interface PeriodConflictContext {
  kind: 'period_conflict';
  operationId: number;
  fingerprint: string;
  periodKind: string;
  fileIds: [number, number];
  periodIds: [number, number];
  /** Justificatifs (liens de la carte). */
  documents: Array<{ fileId: number; title: string; line: string }>;
}

export const isPeriodConflictContext = (c: unknown): c is PeriodConflictContext => {
  const x = c as Partial<PeriodConflictContext> | null;
  return !!x && x.kind === 'period_conflict' && Number.isSafeInteger(x.operationId) && typeof x.fingerprint === 'string'
    && Array.isArray(x.fileIds) && x.fileIds.length === 2;
};

/** Clé de relation stable d'une divergence (empreinte abrégée, sans donnée personnelle). */
export function periodConflictRelationKey(operationId: number, fingerprint: string): string {
  let h = 0;
  for (let i = 0; i < fingerprint.length; i++) h = (Math.imul(31, h) + fingerprint.charCodeAt(i)) | 0;
  return `${RELATION}:${operationId}:${(h >>> 0).toString(16)}`;
}

const borne = (s: string, n = 50) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Propositions (pures) : la période de chaque document, puis « les deux sont justes ». */
export function periodConflictProposals(docs: PeriodConflictContext['documents']) {
  return [
    ...docs.map((d, i) => ({ value: `KEEP:${d.fileId}`, label: `${d.line} — « ${borne(d.title)} »`, confidence: 0.5 - i * 0.05, evidenceIds: [`file:${d.fileId}`] })),
    // État actuel (les deux périodes restent affichées) : présenté comme la valeur actuelle — même forme que « Non, c’est une autre… »
    // de OPERATION-MATCH (deux propositions au plus, plus la valeur actuelle, §8.5).
    { value: 'BOTH', label: PERIOD_CONFLICT_BOTH_LABEL, confidence: 1, isCurrentValue: true },
  ];
}

/** Choix reçu (pur) ; null : invalide (une requête forgée ne désigne rien hors de la carte). */
export function parsePeriodConflictChoice(value: unknown, ctx: PeriodConflictContext): { choice: 'KEEP'; fileId: number } | { choice: 'BOTH' } | null {
  if (value === 'BOTH') return { choice: 'BOTH' };
  const m = typeof value === 'string' ? /^KEEP:(\d{1,10})$/.exec(value) : null;
  return m && ctx.fileIds.includes(Number(m[1])) ? { choice: 'KEEP', fileId: Number(m[1]) } : null;
}

interface SyncReport {
  operations: number; created: number; updated: number; closed: number; skipped: number; error?: string;
  /** Lot 113AD : réexamens T3 demandés (divergences jamais examinées, bloc 29 actif). */
  reviewsRequested?: number;
  /** Carte #766 (E07) : réexamens en échec technique réarmés pour un nouveau cycle borné. */
  reviewsRearmed?: number;
  /** Carte #766 (E07) : questions NON posées parce que la capacité T3 est illisible (incident technique). */
  deferredByIncident?: number;
}

/**
 * Lot 113AD, carte #766 (E07) — la branche PERIOD_RELATION est-elle exécutable ? Trois états, jamais
 * confondus : `AVAILABLE` ; `ABSENT` (configuration : bloc 29 non collé, marqueur manquant, coupure
 * volontaire) → comportement 113AA ; `UNKNOWN` (INCIDENT : version du prompt illisible, erreur) → aucune
 * question n'est posée de ce seul fait. Ne lève jamais.
 */
export type RelationCapabilityState = 'AVAILABLE' | 'ABSENT' | 'UNKNOWN';
export async function relationCapabilityState(): Promise<RelationCapabilityState> {
  try {
    const { relationDecider } = await import('./relation-decider');
    const cap = await relationDecider().capability();
    if (cap.available) return 'AVAILABLE';
    return cap.contractState === 'UNREADABLE' ? 'UNKNOWN' : 'ABSENT';
  } catch {
    return 'UNKNOWN';
  }
}

/** Événements de référence actifs concernés (documents membres ou identifiants donnés), bornés au compte. */
async function operationsOf(accountId: number, scope: { fileIds?: readonly number[]; operationIds?: readonly number[] }): Promise<number[]> {
  const files = `{${(scope.fileIds ?? []).filter(Number.isSafeInteger).join(',')}}`;
  const ops = `{${(scope.operationIds ?? []).filter(Number.isSafeInteger).join(',')}}`;
  const r = (await pgClient.unsafe(
    `SELECT DISTINCT o.id FROM business_operations o
      WHERE o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
        AND (o.id = ANY($3::bigint[]) OR EXISTS (SELECT 1 FROM business_operation_documents d WHERE d.operation_id = o.id AND d.account_id = o.account_id AND d.active AND d.file_id = ANY($2::int[])))
      ORDER BY o.id LIMIT 200`,
    [accountId, files, ops] as never[],
  )) as unknown as Array<{ id: string }>;
  return r.map((x) => Number(x.id));
}

/**
 * Pose, met à jour ou ferme les cartes PERIOD-CONFLICT des événements de
 * référence concernés (après un passage T3, après une correction, contrôle de
 * cohérence). Ne lève jamais (une carte manquée est reprise au passage suivant).
 */
export async function syncPeriodConflictCards(accountId: number, scope: { fileIds?: readonly number[]; operationIds?: readonly number[] }): Promise<SyncReport> {
  const rep: SyncReport = { operations: 0, created: 0, updated: 0, closed: 0, skipped: 0 };
  try {
    const ops = await operationsOf(accountId, scope);
    rep.operations = ops.length;
    if (!ops.length) return rep;
    const [{ operationPeriodResolution }, { upsertAction }] = await Promise.all([
      import('./service'), import('@/services/to-process/to-process-action.service'),
    ]);
    const gardees = new Set<string>();
    let capacite: RelationCapabilityState | null = null;
    for (const opId of ops) {
      const r = await operationPeriodResolution(pgClient, accountId, opId);
      const parId = new Map(r.coverages.map((c) => [c.id, c]));
      // Lot 113AD : divergence jamais examinée et prompt T3 porteur de la branche PERIOD_RELATION (bloc 29) →
      // réexamen T3 DEMANDÉ (aucun appel ici : passage T3 du compte), question différée. Sans le bloc : rien.
      // Carte #766 (E06) : les paires dont l'ordre n'est pas prouvé sont demandées de la même façon (jamais de carte).
      let differees = new Set<string>();
      const aExaminer = [...r.conflicts, ...r.uncertain];
      if (aExaminer.some((x) => x.review === 'NONE' || (x.review === 'FAILED' && x.rearmable))) {
        capacite ??= await relationCapabilityState();
        if (capacite === 'AVAILABLE') {
          const { requestRelationReviews, rearmFailedRelationReviews } = await import('./relation-review');
          differees = new Set(await requestRelationReviews(pgClient, accountId, opId, aExaminer));
          rep.reviewsRequested = (rep.reviewsRequested ?? 0) + differees.size;
          // Carte #766 (E07) : nouvel essai BORNÉ d'un réexamen en échec technique (aucun appel ici).
          const rearmes = await rearmFailedRelationReviews(pgClient, accountId, opId, aExaminer.filter((x) => x.review === 'FAILED' && x.rearmable).map((x) => x.fingerprint));
          if (rearmes.length) rep.reviewsRearmed = (rep.reviewsRearmed ?? 0) + rearmes.length;
        } else if (capacite === 'UNKNOWN') {
          // Carte #766 (E07) : capacité T3 illisible = incident — aucune question posée de ce seul fait ; une
          // carte déjà ouverte est conservée (ni posée ni fermée par une panne).
          for (const c of r.conflicts.filter((x) => x.needsUser && x.review === 'NONE')) {
            differees.add(c.fingerprint);
            gardees.add(periodConflictRelationKey(opId, c.fingerprint));
            rep.deferredByIncident = (rep.deferredByIncident ?? 0) + 1;
          }
        }
      }
      for (const c of r.conflicts.filter((x) => x.needsUser && !differees.has(x.fingerprint))) {
        const docs = c.periodIds.map((id) => parId.get(id)).filter((x): x is NonNullable<typeof x> => !!x)
          .map((e) => ({ fileId: e.fileId, title: e.documentTitle, line: periodLine(e.kind, e) }));
        if (docs.length !== 2) { rep.skipped++; continue; }
        const ctx: PeriodConflictContext = {
          kind: 'period_conflict', operationId: opId, fingerprint: c.fingerprint, periodKind: c.kind,
          fileIds: c.fileIds, periodIds: c.periodIds, documents: docs,
        };
        const relationKey = periodConflictRelationKey(opId, c.fingerprint);
        const u = await upsertAction({
          accountId, targetType: 'DOCUMENT', targetId: Math.max(...c.fileIds), relationKey, actionKind: 'ARBITRATE', ruleCode: PERIOD_CONFLICT_RULE,
          question: PERIOD_CONFLICT_QUESTION, proposals: periodConflictProposals(docs), triggerContext: ctx as unknown as Record<string, unknown>,
        });
        if (u.status === 'CREATED') rep.created++; else if (u.status === 'UPDATED') rep.updated++; else rep.skipped++;
        gardees.add(relationKey);
      }
    }
    // Fermeture : cartes ouvertes de ces événements que la résolution ne reconduit pas.
    const ouvertes = (await pgClient.unsafe(
      `SELECT id, relation_key FROM to_process_actions
        WHERE account_id = $1 AND rule_code = $2 AND resolved_at IS NULL AND (trigger_context->>'operationId')::bigint = ANY($3::bigint[])`,
      [accountId, PERIOD_CONFLICT_RULE, `{${ops.join(',')}}`] as never[],
    )) as unknown as Array<{ id: number; relation_key: string }>;
    const fermer = ouvertes.filter((o) => !gardees.has(o.relation_key)).map((o) => Number(o.id));
    rep.closed = await closePeriodConflictCards(fermer, 'PERIOD_CONFLICT_RESOLVED');
  } catch (e) {
    console.error(`[periodes-metier] cartes de divergence du compte ${accountId} non synchronisées :`, (e as Error).message);
    rep.error = (e as Error).message || 'PERIOD_CARDS_SYNC_FAILED';
  }
  return rep;
}

async function closePeriodConflictCards(ids: number[], reason: string): Promise<number> {
  if (!ids.length) return 0;
  const now = new Date();
  const closed = (await pgClient.unsafe(
    `UPDATE to_process_actions SET resolved_at = now(), resolution_reason = 'OBSOLETE', updated_at = now()
      WHERE id = ANY($1::int[]) AND resolved_at IS NULL
      RETURNING id, account_id, target_type, target_id, relation_key, rule_code`,
    [`{${ids.join(',')}}`] as never[],
  )) as unknown as Array<{ id: number; account_id: number; target_type: string; target_id: number; relation_key: string; rule_code: string }>;
  if (closed.length) {
    await db.insert(toProcessActionEvents).values(closed.map((a) => ({
      actionId: Number(a.id), accountId: Number(a.account_id), event: 'OBSOLETE', actorUserId: null, targetType: a.target_type, targetId: Number(a.target_id),
      fieldKey: a.relation_key, details: { ruleCode: a.rule_code, reason }, createdAt: now,
    })));
  }
  return closed.length;
}

type Action = typeof toProcessActions.$inferSelect;

/**
 * Résolution (appelée par `resolveArbitration`, dans SA transaction, action
 * verrouillée) : décision durable de l'utilisateur sur CETTE divergence — la
 * décision précédente de la même empreinte passe SUPERSEDED (historique).
 * Aucune période de document n'est modifiée.
 */
export async function resolvePeriodConflictCard(
  tx: DbClient, action: Action, value: unknown, accountId: number, options: ResolveOptions,
): Promise<ResolveResult & { afterCommit?: () => Promise<void> }> {
  const ctx = action.triggerContext;
  if (!isPeriodConflictContext(ctx)) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  const choix = parsePeriodConflictChoice(value, ctx);
  if (!choix) return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
  const t = tx as unknown as { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };
  const now = new Date();
  const userId = options.userId ?? null;
  const vivante = (await t.execute(sql`
    SELECT 1 FROM business_operations WHERE id = ${ctx.operationId} AND account_id = ${accountId} AND invalidated_at IS NULL AND merged_into_operation_id IS NULL`)) as unknown as unknown[];
  const fermer = async (reason: ResolutionReason, event: string, details: Record<string, unknown>) => {
    await tx.update(toProcessActions).set({ resolvedAt: now, resolutionReason: reason, updatedAt: now })
      .where(and(eq(toProcessActions.id, action.id), eq(toProcessActions.accountId, accountId)));
    await tx.insert(toProcessActionEvents).values({
      actionId: action.id, accountId, event, actorUserId: userId, targetType: action.targetType, targetId: action.targetId,
      fieldKey: action.relationKey, newValue: value as never, details: { ruleCode: PERIOD_CONFLICT_RULE, cycleNumber: action.cycleNumber, ...details }, createdAt: now,
    });
  };
  if (!vivante.length) {
    await fermer('OBSOLETE', 'OBSOLETE', { reason: 'REFERENCE_EVENT_GONE' });
    return { ok: false, previousValue: null, error: 'STALE' };
  }
  await t.execute(sql`
    UPDATE business_period_decisions SET status = 'SUPERSEDED', superseded_at = now(), updated_at = now()
     WHERE account_id = ${accountId} AND operation_id = ${ctx.operationId} AND fingerprint = ${ctx.fingerprint} AND status = 'ACTIVE'`);
  await t.execute(sql`
    INSERT INTO business_period_decisions (account_id, operation_id, period_kind, fingerprint, choice, retained_file_id, file_ids, evidence, action_id, decided_by_user_id)
    VALUES (${accountId}, ${ctx.operationId}, ${ctx.periodKind}, ${ctx.fingerprint}, ${choix.choice}, ${choix.choice === 'KEEP' ? choix.fileId : null},
            ${`{${ctx.fileIds.join(',')}}`}::int[], ${JSON.stringify({ documents: ctx.documents, periodIds: ctx.periodIds })}::jsonb, ${action.id}, ${userId})`);
  await options.onAfterFieldWrite?.();
  await fermer('USER_ARBITRATED', 'RESOLVED_ARBITRATION', { decision: choix, operationId: ctx.operationId, fingerprint: ctx.fingerprint });
  return { ok: true, previousValue: null, undoable: false };
}
