/**
 * « Annuler » une action EXÉCUTÉE depuis l'assistant — CDC BO IA T2-038
 * (« undo simple : action réversible, commande inverse ») et T2-039 (« undo
 * plan V1 : seulement si toutes les étapes sont proprement réversibles ;
 * aucun bouton si une étape est irréversible ») ; CDC Assistant §5.3
 * (« possibilité d'annulation lorsque le métier le permet »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉCISION PRODUIT (2026-09-28)
 *
 *   · « Annuler » reste proposé 15 minutes après l'exécution (UNDO_WINDOW_MS).
 *   · Seulement pour les actions RÉVERSIBLES :
 *       - CREATE_AGENDA_ITEM  → commande inverse : supprimer l'échéance créée ;
 *       - MARK_AGENDA_DONE    → rétablir le statut précédent de l'échéance ;
 *       - CANCEL_AGENDA_ITEM  → rétablir le statut précédent de l'échéance ;
 *       - UPDATE_ASSET_FIELD  → rétablir la valeur précédente du champ.
 *   · IRRÉVERSIBLES (aucun bouton pour tout le plan) :
 *       - une échéance « achat » rattachée à un bien sans date d'achat (à la
 *         création ou marquée réalisée) : la date est recopiée sur la fiche
 *         du bien (synchronisation échéance → bien) ;
 *       - toute étape dont l'état antérieur n'a pas pu être capturé ;
 *       - toute future commande à effet externe (envoi, partage, paiement…)
 *         tant qu'elle ne fournit pas explicitement sa commande inverse.
 *
 * CYCLE
 *
 *   1. EXÉCUTION (plan.service → executors) : chaque exécuteur réversible
 *      décrit sa commande inverse et l'état ANTÉRIEUR de sa cible, avec
 *      l'empreinte de la cible juste avant et juste après son écriture.
 *      Si toutes les étapes réussies sont réversibles, ces éléments sont
 *      enregistrés (verebona_command_undo_steps) et la fenêtre ouverte
 *      (verebona_command_plans.undo_until).
 *   2. ANNULATION (undoCommandPlan) :
 *      · propriétaire seulement (même compte ET même utilisateur ; un plan
 *        d'autrui est traité comme inexistant) ;
 *      · dans la fenêtre ; droits d'écriture évalués à cet instant
 *        (offre, impayé : mêmes règles que la confirmation) ;
 *      · contrôle optimiste : chaque cible doit porter l'empreinte laissée
 *        par l'exécution — si elle a été modifiée depuis (ou supprimée),
 *        RIEN n'est défait et un message clair l'explique ;
 *      · atomique : une seule transaction, verrous sur le plan et les
 *        cibles, étapes défaites en ordre inverse ;
 *      · idempotente : rejouée, elle rend le même résultat sans nouvelle
 *        écriture, trace ni message ;
 *      · tracée (verebona_command_events) et restituée dans le fil.
 *
 * « Pas de rollback SQL » (T2-038) : on n'annule pas une transaction ni ne
 * restaure une sauvegarde ; on applique une commande inverse métier sur la
 * seule cible, et seulement si personne n'y a touché depuis.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'crypto';
import { pgClient } from '@/db';
import type { ActionResult, PlanStatus, WriteCommandType } from './catalog';

/** Durée pendant laquelle une action exécutée peut être annulée. */
export const UNDO_WINDOW_MS = 15 * 60_000;

export type InverseOp = 'DELETE_AGENDA_ITEM' | 'RESTORE_AGENDA_STATUS' | 'RESTORE_ASSET_FIELDS';

/** Ce que l'exécuteur d'une étape rapporte pour permettre (ou non) son annulation. */
export type UndoCapture =
  | {
      actionId: string;
      reversible: true;
      command: WriteCommandType;
      targetType: 'agenda_item' | 'asset';
      targetId: number;
      inverseOp: InverseOp;
      /** Valeurs antérieures de la cible (vide pour une création). */
      before: Record<string, unknown>;
      versionBefore: string | null;
      versionAfter: string;
      /** Désignation de la cible pour les messages (« l’échéance « Vidange » »). */
      label: string;
    }
  | { actionId: string; reversible: false; reason: string };

/** Exécuteur de requêtes : `pgClient` ou la transaction en cours. */
export interface SqlRunner {
  unsafe: (q: string, p?: never[]) => Promise<unknown>;
}

// ── États et empreintes des cibles ─────────────────────────────────────────

export interface AgendaSnapshot {
  id: number;
  title: string;
  startDate: string | null;
  manualStatus: string | null;
  updatedAt: string;
}

export interface AssetSnapshot {
  id: number;
  name: string;
  status: string | null;
  lockState: string | null;
  keyCharacteristics: string | null;
  registrationNumber: string | null;
  purchaseDate: string | null;
  updatedAt: string;
}

const empreinte = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);

/**
 * `updatedAt` est lu en microsecondes depuis l'époque : indépendant du fuseau
 * de la session (une représentation texte de timestamptz en dépend).
 *
 * Empreinte d'une échéance : champs métier ET date de mise à jour. Une
 * écriture qui oublierait de toucher `updated_at` est tout de même vue si
 * elle change le titre, la date ou le statut.
 */
export const agendaVersion = (s: AgendaSnapshot) => empreinte([s.title, s.startDate, s.manualStatus, s.updatedAt]);
/** Empreinte d'un bien : caractéristiques, colonnes recopiées et date de mise à jour. */
export const assetVersion = (s: AssetSnapshot) =>
  empreinte([s.keyCharacteristics, s.registrationNumber, s.purchaseDate, s.updatedAt]);

export async function readAgendaSnapshot(run: SqlRunner, accountId: number, id: number, lock = false): Promise<AgendaSnapshot | null> {
  const rows = (await run.unsafe(
    `SELECT id, title, to_char(start_date, 'YYYY-MM-DD') AS "startDate", manual_status AS "manualStatus",
            (extract(epoch FROM updated_at) * 1000000)::bigint::text AS "updatedAt"
       FROM agenda_items WHERE id = $1 AND account_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [id, accountId] as never[],
  )) as AgendaSnapshot[];
  return rows[0] ?? null;
}

export async function readAssetSnapshot(run: SqlRunner, accountId: number, id: number, lock = false): Promise<AssetSnapshot | null> {
  const rows = (await run.unsafe(
    `SELECT id, name, status, lock_state AS "lockState", key_characteristics AS "keyCharacteristics",
            registration_number AS "registrationNumber", to_char(purchase_date, 'YYYY-MM-DD') AS "purchaseDate",
            (extract(epoch FROM updated_at) * 1000000)::bigint::text AS "updatedAt"
       FROM assets WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [id, accountId] as never[],
  )) as AssetSnapshot[];
  return rows[0] ?? null;
}

/**
 * La synchronisation échéance → bien (`syncPurchaseDateFromAgenda`) va-t-elle
 * écrire ? Même règle que le service agenda : titre contenant « achat », date
 * renseignée, au moins un bien rattaché sans date d'achat. Évalué AVANT
 * l'exécution (après, la date d'achat est déjà recopiée).
 */
export async function achatSyncWillWrite(
  run: SqlRunner,
  p: { title: string; startDate: string | null; assetIds?: number[]; agendaItemId?: number },
): Promise<boolean> {
  if (!p.title || !p.startDate || !p.title.toLowerCase().includes('achat')) return false;
  if (p.assetIds) {
    if (p.assetIds.length === 0) return false;
    const r = (await run.unsafe(
      `SELECT count(*)::int AS n FROM assets WHERE id = ANY($1::int[]) AND purchase_date IS NULL`,
      [p.assetIds] as never[],
    )) as Array<{ n: number }>;
    return (r[0]?.n ?? 0) > 0;
  }
  const r = (await run.unsafe(
    `SELECT count(*)::int AS n FROM agenda_asset_links l JOIN assets a ON a.id = l.asset_id
      WHERE l.agenda_item_id = $1 AND a.purchase_date IS NULL`,
    [p.agendaItemId] as never[],
  )) as Array<{ n: number }>;
  return (r[0]?.n ?? 0) > 0;
}

export const ACHAT_SYNC_REASON =
  'la date d’achat a été recopiée sur la fiche du bien (synchronisation échéance → bien)';

// ── Ouverture de la fenêtre, à l'exécution ─────────────────────────────────

export interface UndoArming {
  undoUntil: string | null;
  /** Pourquoi le plan n'est pas annulable (trace). */
  reasons: string[];
}

/**
 * Enregistre les commandes inverses et ouvre la fenêtre — seulement si
 * TOUTES les étapes réussies sont réversibles (T2-039). Ne lève jamais : un
 * échec d'enregistrement rend simplement le plan non annulable.
 */
export async function armUndo(
  p: { planId: string; accountId: number; userId: number },
  results: ActionResult[],
  captures: Map<string, UndoCapture>,
): Promise<UndoArming> {
  const reussies = results.filter((r) => r.status === 'SUCCESS');
  if (reussies.length === 0) return { undoUntil: null, reasons: ['aucune étape exécutée'] };
  const reasons: string[] = [];
  const steps: Array<Extract<UndoCapture, { reversible: true }>> = [];
  for (const r of reussies) {
    const c = captures.get(r.actionId);
    if (!c) reasons.push(`${r.actionId} : pas de commande inverse`);
    else if (!c.reversible) reasons.push(`${r.actionId} : ${c.reason}`);
    else steps.push(c);
  }
  if (reasons.length) return { undoUntil: null, reasons };

  try {
    const until = await pgClient.begin(async (tx) => {
      const t = tx as unknown as SqlRunner;
      for (const s of steps) {
        await t.unsafe(
          `INSERT INTO verebona_command_undo_steps
             (plan_id, account_id, user_id, action_id, command, target_type, target_id, inverse_op,
              before_json, version_before, version_after, label)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
           ON CONFLICT (plan_id, action_id) DO NOTHING`,
          [p.planId, p.accountId, p.userId, s.actionId, s.command, s.targetType, s.targetId, s.inverseOp,
            JSON.stringify(s.before), s.versionBefore, s.versionAfter, s.label] as never[],
        );
      }
      const rows = (await t.unsafe(
        `UPDATE verebona_command_plans SET undo_until = now() + make_interval(secs => $2)
          WHERE plan_id = $1 RETURNING undo_until AS "undoUntil"`,
        [p.planId, UNDO_WINDOW_MS / 1000] as never[],
      )) as Array<{ undoUntil: string | Date }>;
      return rows[0]?.undoUntil ?? null;
    });
    return { undoUntil: until ? new Date(until).toISOString() : null, reasons: [] };
  } catch (e) {
    console.error('[verebona] annulation non préparée :', (e as Error).message);
    return { undoUntil: null, reasons: ['enregistrement de la commande inverse impossible'] };
  }
}

// ── Annulation ─────────────────────────────────────────────────────────────

export type UndoOutcome =
  | {
      ok: true;
      status: 'UNDONE';
      /** Déjà annulé (appel rejoué) : rien de nouveau n'a été écrit. */
      alreadyHandled: boolean;
      message: string;
      entities: Array<{ type: 'agenda_item' | 'asset'; id: number }>;
    }
  | {
      ok: false;
      code: 'PLAN_NOT_FOUND' | 'NOT_UNDOABLE' | 'IRREVERSIBLE' | 'UNDO_EXPIRED' | 'UNDO_CONFLICT' | 'WRITE_REFUSED';
      message: string;
      status?: PlanStatus;
    };

export const UNDONE_MESSAGE = 'J’ai annulé cette action.';
export const UNDO_ALREADY_MESSAGE = 'Cette action a déjà été annulée.';
export const UNDO_EXPIRED_MESSAGE =
  'Le délai de 15 minutes pour annuler cette action est dépassé. Vous pouvez faire la correction directement depuis l’écran concerné.';
export const UNDO_IRREVERSIBLE_MESSAGE =
  'Cette action ne peut pas être annulée depuis l’assistant : elle a eu des effets qui ne se défont pas automatiquement. Vous pouvez faire la correction directement depuis l’écran concerné.';
export const UNDO_NOT_EXECUTED_MESSAGE = 'Seule une action exécutée peut être annulée.';
const NOT_FOUND_MESSAGE = 'Cette action n’existe pas ou ne vous appartient pas.';

/** Conflit détecté pendant la transaction : tout est défait, rien n'est écrit. */
class UndoConflict extends Error {
  constructor(public label: string, public gone: boolean) { super('UNDO_CONFLICT'); }
}

export const conflictMessage = (label: string, gone: boolean) => gone
  ? `Annulation impossible : ${label} n’existe plus. Rien n’a été modifié.`
  : `Annulation impossible : ${label} a changé depuis l’exécution de l’action. Rien n’a été modifié ; vous pouvez faire la correction directement depuis l’écran concerné.`;

const statutFr = (s: unknown) => (s === 'realise' ? 'réalisée' : s === 'annule' ? 'annulée' : 'à traiter');

interface StepRow {
  id: number;
  actionId: string;
  command: WriteCommandType;
  targetType: 'agenda_item' | 'asset';
  targetId: number;
  inverseOp: InverseOp;
  before: Record<string, unknown> | string;
  versionBefore: string | null;
  versionAfter: string;
  label: string;
}

interface PlanRow {
  status: PlanStatus;
  reversible: boolean;
  withinWindow: boolean;
  conversationId: number | null;
  messageId: number | null;
}

const PLAN_STATE_SQL =
  `SELECT status, undo_until IS NOT NULL AS "reversible", coalesce(undo_until > now(), false) AS "withinWindow",
          conversation_id AS "conversationId", message_id AS "messageId"
     FROM verebona_command_plans WHERE plan_id = $1 AND account_id = $2 AND user_id = $3`;

/** Refus « hors transaction » selon l'état du plan ; null si l'annulation peut être tentée. */
function refusSelonEtat(etat: PlanRow): UndoOutcome | null {
  if (etat.status === 'UNDONE') {
    return { ok: true, status: 'UNDONE', alreadyHandled: true, message: UNDO_ALREADY_MESSAGE, entities: [] };
  }
  if (etat.status !== 'EXECUTED' && etat.status !== 'PARTIAL') {
    return { ok: false, code: 'NOT_UNDOABLE', message: UNDO_NOT_EXECUTED_MESSAGE, status: etat.status };
  }
  if (!etat.reversible) return { ok: false, code: 'IRREVERSIBLE', message: UNDO_IRREVERSIBLE_MESSAGE, status: etat.status };
  if (!etat.withinWindow) return { ok: false, code: 'UNDO_EXPIRED', message: UNDO_EXPIRED_MESSAGE, status: etat.status };
  return null;
}

/** Applique la commande inverse d'une étape ; lève UndoConflict si la cible a bougé. */
async function defaireEtape(
  t: SqlRunner,
  s: StepRow,
  ctx: { planId: string; accountId: number; userId: number },
  dejaDefaites: Map<string, string | null>,
): Promise<string> {
  const before = typeof s.before === 'string' ? (JSON.parse(s.before) as Record<string, unknown>) : (s.before ?? {});
  const cle = `${s.targetType}:${s.targetId}`;

  // Contrôle optimiste. Une cible déjà défaite dans cette même annulation
  // (deux étapes du plan sur le même objet) : l'étape suivante l'a remise
  // dans l'état « juste avant elle », qui doit être l'état « juste après »
  // celle-ci — sinon quelqu'un est intervenu entre les deux exécutions.
  const verifier = (actuelle: string) => {
    const attendue = dejaDefaites.has(cle) ? dejaDefaites.get(cle) : actuelle;
    if (attendue !== s.versionAfter) throw new UndoConflict(s.label, false);
  };

  if (s.targetType === 'agenda_item') {
    const cur = await readAgendaSnapshot(t, ctx.accountId, s.targetId, true);
    if (!cur) throw new UndoConflict(s.label, true);
    verifier(agendaVersion(cur));

    if (s.inverseOp === 'DELETE_AGENDA_ITEM') {
      // Mêmes étapes que AgendaWriteService.deleteAgendaItem, dans la
      // transaction : liaisons supprimées, traces détachées (chacune isolée
      // par un point de sauvegarde : table optionnelle), puis l'échéance.
      for (const table of ['agenda_asset_links', 'agenda_file_links', 'agenda_room_links', 'agenda_equipment_links']) {
        await t.unsafe(`DELETE FROM ${table} WHERE agenda_item_id = $1`, [s.targetId] as never[]);
      }
      const detachements = [
        `UPDATE agenda_data_conflicts SET agenda_item_id = NULL WHERE agenda_item_id = $1`,
        `UPDATE agenda_data_conflicts SET result_agenda_item_id = NULL WHERE result_agenda_item_id = $1`,
        `UPDATE agenda_item_sources SET agenda_item_id = NULL WHERE agenda_item_id = $1`,
        `UPDATE energy_works SET agenda_item_id = NULL WHERE agenda_item_id = $1`,
        `UPDATE impact_queue SET agenda_item_id = NULL WHERE agenda_item_id = $1`,
        `DELETE FROM agenda_occurrence_events WHERE agenda_item_id = $1`,
      ];
      const sp = (tx: unknown) => (tx as { savepoint?: (fn: (s: SqlRunner) => Promise<unknown>) => Promise<unknown> }).savepoint;
      for (const q of detachements) {
        const savepoint = sp(t);
        try {
          if (savepoint) await savepoint.call(t, (inner) => inner.unsafe(q, [s.targetId] as never[]));
          else await t.unsafe(q, [s.targetId] as never[]);
        } catch (e) {
          console.warn('[verebona] détachement ignoré à l’annulation :', (e as Error).message);
        }
      }
      await t.unsafe(`DELETE FROM agenda_items WHERE id = $1 AND account_id = $2`, [s.targetId, ctx.accountId] as never[]);
      dejaDefaites.set(cle, null);
      return `${s.label} a été supprimée`;
    }

    // RESTORE_AGENDA_STATUS
    const precedent = (before.manualStatus ?? null) as string | null;
    await t.unsafe(
      `UPDATE agenda_items SET manual_status = $3, updated_at = now() WHERE id = $1 AND account_id = $2`,
      [s.targetId, ctx.accountId, precedent] as never[],
    );
    await t.unsafe(
      `INSERT INTO agenda_occurrence_events (agenda_item_id, account_id, event_type, detail_json, actor_user_id)
       VALUES ($1, $2, 'STATUS_CHANGED', $3::jsonb, $4)`,
      [s.targetId, ctx.accountId, JSON.stringify({ manualStatus: precedent, undoOfPlan: ctx.planId }), ctx.userId] as never[],
    );
    dejaDefaites.set(cle, s.versionBefore);
    return `${s.label} a retrouvé son statut précédent (${statutFr(precedent)})`;
  }

  // RESTORE_ASSET_FIELDS
  const cur = await readAssetSnapshot(t, ctx.accountId, s.targetId, true);
  if (!cur) throw new UndoConflict(s.label, true);
  verifier(assetVersion(cur));
  // Même garde que la fiche : un bien archivé ou verrouillé par l'offre
  // n'est pas modifiable, pas même pour défaire.
  if (cur.status === 'ARCHIVED' || (cur.lockState && cur.lockState !== 'NONE')) throw new UndoConflict(s.label, false);
  await t.unsafe(
    `UPDATE assets SET key_characteristics = $3, registration_number = $4, updated_at = now()
      WHERE id = $1 AND account_id = $2`,
    [s.targetId, ctx.accountId, (before.keyCharacteristics ?? null) as string | null,
      (before.registrationNumber ?? null) as string | null] as never[],
  );
  dejaDefaites.set(cle, s.versionBefore);
  const valeur = typeof before.display === 'string' && before.display ? ` (${before.display})` : '';
  return `${s.label} a retrouvé sa valeur précédente${valeur}`;
}

/**
 * Annule un plan exécuté, dans la fenêtre, si rien n'a bougé depuis.
 * Voir l'en-tête du module pour les règles.
 */
export async function undoCommandPlan(
  p: { planId: string; accountId: number; userId: number },
  deps: { canWrite?: (accountId: number) => Promise<{ allowed: boolean; message?: string }> } = {},
): Promise<UndoOutcome> {
  const { tracer, recordPlanOutcome, defaultCanWrite } = await import('./plan.service');
  const args = [p.planId, p.accountId, p.userId] as never[];

  const [etat] = (await pgClient.unsafe(PLAN_STATE_SQL, args)) as unknown as PlanRow[];
  if (!etat) return { ok: false, code: 'PLAN_NOT_FOUND', message: NOT_FOUND_MESSAGE };
  const refus = refusSelonEtat(etat);
  if (refus) return refus;

  // Défaire, c'est écrire : droits évalués maintenant (offre, impayé,
  // lecture seule), comme pour la confirmation.
  const droit = await (deps.canWrite ?? defaultCanWrite)(p.accountId);
  if (!droit.allowed) {
    const message = droit.message ?? 'Écriture non autorisée.';
    await tracer(p.planId, p.accountId, p.userId, 'UNDO_REFUSED', { reason: 'WRITE_REFUSED', message });
    return { ok: false, code: 'WRITE_REFUSED', message, status: etat.status };
  }

  type Tx = { kind: 'done'; lignes: string[]; entities: Array<{ type: 'agenda_item' | 'asset'; id: number }>; supprimees: number[]; conv: PlanRow }
    | { kind: 'refus'; outcome: UndoOutcome };
  let r: Tx;
  try {
    r = await pgClient.begin(async (tx): Promise<Tx> => {
      const t = tx as unknown as SqlRunner;
      // Verrou sur le plan : deux annulations simultanées se sérialisent,
      // la seconde voit UNDONE et rend le résultat déjà acquis.
      const [verrou] = (await t.unsafe(`${PLAN_STATE_SQL} FOR UPDATE`, args)) as PlanRow[];
      if (!verrou) return { kind: 'refus', outcome: { ok: false, code: 'PLAN_NOT_FOUND', message: NOT_FOUND_MESSAGE } };
      const refusTx = refusSelonEtat(verrou);
      if (refusTx) return { kind: 'refus', outcome: refusTx };

      const steps = (await t.unsafe(
        `SELECT id, action_id AS "actionId", command, target_type AS "targetType", target_id AS "targetId",
                inverse_op AS "inverseOp", before_json AS "before", version_before AS "versionBefore",
                version_after AS "versionAfter", label
           FROM verebona_command_undo_steps
          WHERE plan_id = $1 AND account_id = $2 AND undone_at IS NULL
          ORDER BY id DESC`,
        [p.planId, p.accountId] as never[],
      )) as StepRow[];
      if (steps.length === 0) {
        return { kind: 'refus', outcome: { ok: false, code: 'IRREVERSIBLE', message: UNDO_IRREVERSIBLE_MESSAGE, status: verrou.status } };
      }

      // Ordre inverse de l'exécution.
      const dejaDefaites = new Map<string, string | null>();
      const lignes: string[] = [];
      for (const s of steps) lignes.unshift(await defaireEtape(t, s, p, dejaDefaites));

      await t.unsafe(
        `UPDATE verebona_command_undo_steps SET undone_at = now() WHERE plan_id = $1 AND undone_at IS NULL`,
        [p.planId] as never[],
      );
      await t.unsafe(
        `UPDATE verebona_command_plans SET status = 'UNDONE', undone_at = now() WHERE plan_id = $1`,
        [p.planId] as never[],
      );
      const entities = [...new Map(steps.map((s) => [`${s.targetType}:${s.targetId}`, { type: s.targetType, id: s.targetId }])).values()];
      const supprimees = steps.filter((s) => s.inverseOp === 'DELETE_AGENDA_ITEM').map((s) => s.targetId);
      return { kind: 'done', lignes, entities, supprimees, conv: verrou };
    });
  } catch (e) {
    if (e instanceof UndoConflict) {
      const message = conflictMessage(e.label, e.gone);
      await tracer(p.planId, p.accountId, p.userId, 'UNDO_REFUSED', { reason: 'CONFLICT', target: e.label, gone: e.gone });
      await recordPlanOutcome({ ...p, conversationId: etat.conversationId, messageId: etat.messageId }, message);
      return { ok: false, code: 'UNDO_CONFLICT', message, status: etat.status };
    }
    throw e;
  }

  if (r.kind === 'refus') return r.outcome;

  const message = r.lignes.length === 1
    ? `${UNDONE_MESSAGE.replace(/\.$/, '')} : ${r.lignes[0]}.`
    : `${UNDONE_MESSAGE.replace(/\.$/, '')} :\n${r.lignes.map((l) => `• ${l.charAt(0).toUpperCase()}${l.slice(1)}.`).join('\n')}`;
  await tracer(p.planId, p.accountId, p.userId, 'UNDONE', { steps: r.lignes.length, entities: r.entities });
  await recordPlanOutcome({ ...p, conversationId: r.conv.conversationId, messageId: r.conv.messageId }, message);
  apresAnnulation(p.accountId, r.entities, r.supprimees);
  return { ok: true, status: 'UNDONE', alreadyHandled: false, message, entities: r.entities };
}

/**
 * Suites non bloquantes, comme après une écriture de l'interface : caches de
 * l'assistant (§25.7) et recontrôle de cohérence d'un bien modifié (T3).
 */
function apresAnnulation(
  accountId: number,
  entities: Array<{ type: 'agenda_item' | 'asset'; id: number }>,
  supprimees: number[],
): void {
  void (async () => {
    try {
      const { emitBusinessEvent } = await import('@/services/verebona-assistant/events/business-events');
      for (const e of entities) {
        // Une échéance supprimée : événement de suppression (§31.4, ce qui
        // en a été copié disparaît aussi).
        const type = e.type === 'asset' ? 'ASSET_UPDATED'
          : supprimees.includes(e.id) ? 'AGENDA_ITEM_DELETED' : 'AGENDA_ITEM_UPDATED';
        await emitBusinessEvent({ type, accountId, entityId: e.id });
      }
      const biens = entities.filter((e) => e.type === 'asset');
      if (biens.length) {
        const { notifyCoherenceEvent } = await import('@/services/ai/reconciliation/account-reconciliation.service');
        for (const b of biens) notifyCoherenceEvent(accountId, { event: 'asset_updated', objectType: 'asset', objectId: b.id });
      }
    } catch { /* non bloquant */ }
  })();
}

/**
 * Purge des états antérieurs devenus inutiles (fenêtre close depuis plus
 * d'un jour) : minimisation — ils contiennent des valeurs de fiches.
 * Appelée par la purge quotidienne des plans. Ne lève jamais.
 */
export async function purgeExpiredUndoSteps(): Promise<number> {
  try {
    const rows = (await pgClient.unsafe(
      `DELETE FROM verebona_command_undo_steps s
        USING verebona_command_plans p
        WHERE p.plan_id = s.plan_id AND p.undo_until < now() - interval '1 day'
        RETURNING s.id`,
    )) as unknown as unknown[];
    return rows.length;
  } catch (e) {
    console.warn('[verebona] purge des annulations non effectuée :', (e as Error).message);
    return 0;
  }
}
