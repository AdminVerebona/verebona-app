/**
 * Plans de commandes de l'assistant — préparation, confirmation, exécution.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUNE ÉCRITURE AVANT CONFIRMATION, ET RIEN QUI CHANGE ENTRE LES DEUX
 *
 *   1. PRÉPARATION : la commande reconnue est résolue dans le compte (bien,
 *      échéance), ses paramètres sont figés et enregistrés tels que
 *      présentés, avec leur empreinte. Aucune donnée métier n'est touchée.
 *   2. PRÉVISUALISATION : l'utilisateur voit l'action et ses effets.
 *   3. CONFIRMATION : explicite, par identifiant de plan seulement. Prise
 *      atomique (un plan ne s'exécute qu'une fois), propriétaire vérifié
 *      (compte + utilisateur : l'autre membre d'un Duo ne confirme pas),
 *      expiration, empreinte, droits d'écriture ÉVALUÉS À CET INSTANT.
 *   4. EXÉCUTION : par les services métier existants (executors.ts).
 *   5. RÉSULTAT : par action, tracé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash, randomUUID } from 'crypto';
import { pgClient } from '@/db';
import { getEntitlements, restrictedRefusal } from '@/services/entitlements.service';
import { formatDateFr } from '../core/deterministic-format';
import type { AssistantRequestInput } from '../types/contracts';
import type {
  ActionResult, CommandPlanPreview, PlannedAction, PlanStatus,
} from './catalog';
import { WRITE_COMMAND_CATALOG } from './catalog';
import { parseCommands, type CommandDraft } from './parser';
import { runAction, EXECUTORS, type Executor, type ExecutionContext } from './executors';
import { armUndo, purgeExpiredUndoSteps, type UndoCapture } from './undo.service';
import { ASSISTANT_ASSET_FIELDS, familyOf, formatFieldValue } from './asset-fields';
import { validateDetailChanges } from '@/lib/asset-detail-rules';

/** Validité d'un plan non confirmé. */
export const PLAN_TTL_MS = 15 * 60_000;

export interface StoredPlan {
  planId: string;
  accountId: number;
  userId: number;
  conversationId: number | null;
  summary: string;
  actions: PlannedAction[];
  expiresAt: string;
}

export type Preparation =
  | { kind: 'plan'; plan: StoredPlan; preview: CommandPlanPreview }
  /** Commande reconnue mais incomplète ou ambiguë : on demande, on n'écrit rien. */
  | { kind: 'need_info'; message: string };

// ── Résolution dans le compte ──────────────────────────────────────────────

export interface CommandLookup {
  today(): string;
  findAssets(accountId: number, words: string[]): Promise<Array<{ id: number; name: string; city?: string | null }>>;
  getAsset(accountId: number, id: number): Promise<{ id: number; name: string; city?: string | null } | null>;
  findAgendaItems(accountId: number, words: string[], opts: { openOnly: boolean }): Promise<Array<{ id: number; title: string; date: string | null }>>;
  getAgendaItem(accountId: number, id: number): Promise<{ id: number; title: string; date: string | null; manualStatus: string | null } | null>;
  /** Échéances ouvertes (non réalisées / annulées), éventuellement passées, d'un bien. */
  listOpenAgendaItems(accountId: number, opts: { pastOnly: boolean; assetIds: number[]; today: string; limit: number }): Promise<Array<{ id: number; title: string; date: string | null }>>;
  /** Bien et ses caractéristiques, pour UPDATE_ASSET_FIELD (ancienne valeur, famille, disponibilité). */
  getAssetState?(accountId: number, id: number): Promise<AssetState | null>;
}

export interface AssetState {
  id: number;
  name: string;
  city?: string | null;
  category: string;
  status: string | null;
  lockState: string | null;
  characteristics: Record<string, unknown>;
}

/** Plafond d'une action en masse : au-delà, on demande de restreindre. */
export const MAX_BULK_TARGETS = 50;


export const sqlLookup: CommandLookup = {
  today: () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
  async findAssets(accountId, words) {
    const w = words.filter((x) => x.length >= 3).slice(0, 4);
    if (w.length === 0) return [];
    const cond = w.map((_, i) => `unaccent(lower(a.name || ' ' || coalesce(a.subtype,'') || ' ' || a.category)) LIKE unaccent(lower($${i + 2}))`).join(' OR ');
    return (await pgClient.unsafe(
      `SELECT a.id, a.name, a.city FROM assets a
        WHERE a.account_id = $1 AND a.deleted_at IS NULL
          AND coalesce(a.status, 'EN_SERVICE') NOT IN ('ARCHIVED', 'TRANSMIS') AND (${cond})
        ORDER BY a.name LIMIT 10`,
      [accountId, ...w.map((x) => `%${x}%`)] as never[],
    )) as unknown as Array<{ id: number; name: string; city: string | null }>;
  },
  async getAsset(accountId, id) {
    const r = (await pgClient.unsafe(
      `SELECT id, name, city FROM assets WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`,
      [id, accountId] as never[],
    )) as unknown as Array<{ id: number; name: string; city: string | null }>;
    return r[0] ?? null;
  },
  async findAgendaItems(accountId, words, { openOnly }) {
    const w = words.filter((x) => x.length >= 3).slice(0, 4);
    if (w.length === 0) return [];
    const cond = w.map((_, i) => `unaccent(lower(i.title)) LIKE unaccent(lower($${i + 2}))`).join(' AND ');
    return (await pgClient.unsafe(
      `SELECT i.id, i.title, to_char(i.start_date, 'YYYY-MM-DD') AS date FROM agenda_items i
        WHERE i.account_id = $1 AND (${cond}) ${openOnly ? 'AND i.manual_status IS NULL' : ''}
        ORDER BY i.start_date NULLS LAST, i.id LIMIT 10`,
      [accountId, ...w.map((x) => `%${x}%`)] as never[],
    )) as unknown as Array<{ id: number; title: string; date: string | null }>;
  },
  async listOpenAgendaItems(accountId, { pastOnly, assetIds, today, limit }) {
    return (await pgClient.unsafe(
      `SELECT i.id, i.title, to_char(i.start_date, 'YYYY-MM-DD') AS date FROM agenda_items i
        WHERE i.account_id = $1 AND i.manual_status IS NULL
          AND ($2::boolean IS FALSE OR i.start_date < $3::date)
          AND ($4::int[] IS NULL OR EXISTS (SELECT 1 FROM agenda_asset_links l WHERE l.agenda_item_id = i.id AND l.asset_id = ANY($4::int[])))
        ORDER BY i.start_date NULLS LAST, i.id LIMIT $5`,
      [accountId, pastOnly, today, assetIds.length ? assetIds : null, limit] as never[],
    )) as unknown as Array<{ id: number; title: string; date: string | null }>;
  },
  async getAssetState(accountId, id) {
    const r = (await pgClient.unsafe(
      `SELECT id, name, city, category, status, lock_state AS "lockState", key_characteristics AS kc,
              purchase_date AS "purchaseDate", purchase_price_cents AS "purchasePriceCents",
              registration_number AS "registrationNumber"
         FROM assets WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`,
      [id, accountId] as never[],
    )) as unknown as Array<{
      id: number; name: string; city: string | null; category: string; status: string | null; lockState: string | null;
      kc: string | null; purchaseDate: string | Date | null; purchasePriceCents: number | null; registrationNumber: string | null;
    }>;
    const a = r[0];
    if (!a) return null;
    let kc: Record<string, unknown> = {};
    try { kc = a.kc ? JSON.parse(a.kc) : {}; } catch { /* caractéristiques illisibles : vides */ }
    // Mêmes replis que la fiche bien (GET /details) : colonnes historiques.
    const jour = (d: string | Date | null) => (d ? (typeof d === 'string' ? d : d.toISOString()).slice(0, 10) : null);
    const characteristics = {
      ...kc,
      acquisitionDate: kc.acquisitionDate ?? jour(a.purchaseDate),
      acquisitionPrice: kc.acquisitionPrice ?? (a.purchasePriceCents != null ? a.purchasePriceCents / 100 : null),
      registrationNumber: kc.registrationNumber ?? a.registrationNumber,
    };
    return { id: a.id, name: a.name, city: a.city, category: a.category, status: a.status, lockState: a.lockState, characteristics };
  },
  async getAgendaItem(accountId, id) {
    const r = (await pgClient.unsafe(
      `SELECT id, title, to_char(start_date, 'YYYY-MM-DD') AS date, manual_status AS "manualStatus"
         FROM agenda_items WHERE id = $1 AND account_id = $2`,
      [id, accountId] as never[],
    )) as unknown as Array<{ id: number; title: string; date: string | null; manualStatus: string | null }>;
    return r[0] ?? null;
  },
};

const nomBien = (a: { name: string; city?: string | null }) => (a.city ? `${a.name} (${a.city})` : a.name);

/** Résout un brouillon en action figée — ou dit ce qui manque. */
export async function resolveDraft(
  draft: CommandDraft,
  input: AssistantRequestInput,
  lookup: CommandLookup,
  actionId = 'a1',
): Promise<PlannedAction | PlannedAction[] | { needInfo: string }> {
  const acc = input.accountId;

  if (draft.command === 'CREATE_AGENDA_ITEM') {
    if (!draft.date) return { needInfo: `Pour quelle date voulez-vous créer l’échéance « ${draft.title} » ?` };
    const targets: PlannedAction['targets'] = [];
    let assetIds: number[] = [];
    if (draft.assetFromContext || (!draft.assetWords.length && input.reference?.type === 'asset')) {
      const id = input.reference?.type === 'asset' ? input.reference.id : Number(input.pageContext?.assetId) || null;
      const a = id ? await lookup.getAsset(acc, id) : null;
      if (!a) return { needInfo: 'Pour quel bien voulez-vous créer cette échéance ?' };
      assetIds = [a.id]; targets.push({ type: 'asset', id: a.id, label: nomBien(a) });
    } else if (draft.assetWords.length) {
      const found = await lookup.findAssets(acc, draft.assetWords);
      if (found.length === 0) return { needInfo: 'Je n’ai pas trouvé ce bien dans votre compte. Pour quel bien voulez-vous créer cette échéance ?' };
      if (found.length > 1) {
        return { needInfo: `Plusieurs biens correspondent : ${found.slice(0, 5).map((a) => nomBien(a)).join(', ')}. Précisez lequel dans votre demande.` };
      }
      assetIds = [found[0].id]; targets.push({ type: 'asset', id: found[0].id, label: nomBien(found[0]) });
    }
    const bien = targets[0] ? `, rattachée à ${targets[0].label}` : '';
    return {
      actionId, command: 'CREATE_AGENDA_ITEM', targets, dependsOn: [],
      params: { title: draft.title, startDate: draft.date, assetIds },
      preview: `Créer l’échéance « ${draft.title} » le ${formatDateFr(draft.date)}${bien}.`,
      effects: [
        `Titre : ${draft.title}`,
        `Date : ${formatDateFr(draft.date)}`,
        targets[0] ? `Bien : ${targets[0].label}` : 'Bien : aucun',
      ],
    };
  }

  if (draft.command === 'UPDATE_ASSET_FIELD') {
    return resolveAssetFieldUpdate(draft, input, lookup, actionId);
  }

  // Action en masse : une action — donc un résultat — par échéance visée.
  if (draft.bulk) {
    return resolveBulk(draft as Extract<CommandDraft, { targetWords: string[] }>, input, lookup, actionId);
  }

  // Marquer réalisée / annuler une échéance existante.
  let item: { id: number; title: string; date: string | null } | null = null;
  if (draft.targetFromContext && input.reference?.type === 'agenda_item') {
    item = await lookup.getAgendaItem(acc, input.reference.id);
  } else if (draft.targetWords.length) {
    const found = await lookup.findAgendaItems(acc, draft.targetWords, { openOnly: true });
    if (found.length > 1) {
      return { needInfo: `Plusieurs échéances correspondent : ${found.slice(0, 5).map((i) => `« ${i.title} »${i.date ? ` (${formatDateFr(i.date)})` : ''}`).join(', ')}. Précisez laquelle.` };
    }
    item = found[0] ?? null;
  }
  if (!item) return { needInfo: 'Je n’ai pas trouvé cette échéance. Précisez son intitulé.' };
  const verbe = draft.command === 'MARK_AGENDA_DONE' ? 'Marquer comme réalisée' : 'Annuler';
  const quand = item.date ? ` du ${formatDateFr(item.date)}` : '';
  return {
    actionId, command: draft.command, dependsOn: [],
    targets: [{ type: 'agenda_item', id: item.id, label: item.title }],
    params: { agendaItemId: item.id },
    preview: `${verbe} l’échéance « ${item.title} »${quand}.`,
    effects: [
      `Échéance : ${item.title}${quand}`,
      `Nouveau statut : ${draft.command === 'MARK_AGENDA_DONE' ? 'réalisée' : 'annulée'}`,
    ],
  };
}

/**
 * Modification d'une caractéristique : bien trouvé dans le compte, champ
 * applicable à sa famille, valeur valide selon les règles de la fiche,
 * ancienne valeur lue — et présentée — avant toute confirmation.
 */
async function resolveAssetFieldUpdate(
  draft: Extract<CommandDraft, { command: 'UPDATE_ASSET_FIELD' }>,
  input: AssistantRequestInput,
  lookup: CommandLookup,
  actionId: string,
): Promise<PlannedAction | { needInfo: string }> {
  const def = ASSISTANT_ASSET_FIELDS.find((f) => f.key === draft.field);
  if (!def || !lookup.getAssetState) return { needInfo: 'Je ne peux pas modifier ce champ depuis l’assistant.' };

  // Le bien : nommé, ou celui du fil / de la page.
  let assetId: number | null = null;
  if (draft.assetWords.length) {
    const found = await lookup.findAssets(input.accountId, draft.assetWords);
    if (found.length === 0) return { needInfo: `Je n’ai pas trouvé ce bien dans votre compte. Pour quel bien voulez-vous modifier « ${def.label} » ?` };
    if (found.length > 1) {
      return { needInfo: `Plusieurs biens correspondent : ${found.slice(0, 5).map((a) => nomBien(a)).join(', ')}. Précisez lequel.` };
    }
    assetId = found[0].id;
  } else if (input.reference?.type === 'asset') {
    assetId = input.reference.id;
  } else if (Number(input.pageContext?.assetId)) {
    assetId = Number(input.pageContext?.assetId);
  }
  if (!assetId) return { needInfo: `Pour quel bien voulez-vous modifier « ${def.label} » ?` };

  const asset = await lookup.getAssetState(input.accountId, assetId);
  if (!asset) return { needInfo: 'Je n’ai pas trouvé ce bien dans votre compte.' };
  if (asset.status === 'ARCHIVED' || (asset.lockState && asset.lockState !== 'NONE')) {
    return { needInfo: `${nomBien(asset)} n’est pas modifiable actuellement (bien archivé ou verrouillé par votre offre).` };
  }
  const section = def.sections[familyOf(asset.category)];
  if (!section) return { needInfo: `« ${def.label} » ne s’applique pas à ${nomBien(asset)}.` };

  if (draft.value === null) {
    const attendu = def.type === 'date' ? 'une date complète, par exemple 25/05/2021' : def.type === 'number' ? 'un nombre' : 'une valeur';
    return { needInfo: `Quelle valeur voulez-vous pour « ${def.label} » de ${nomBien(asset)} ? Indiquez ${attendu}.` };
  }

  const previous = asset.characteristics[def.key] ?? null;
  // Mêmes contrôles que l'enregistrement depuis la fiche.
  const erreurs = validateDetailChanges({ [def.key]: draft.value }, { [def.key]: previous }, lookup.today());
  if (erreurs.length) return { needInfo: erreurs.map((e) => e.message).join(' ') };
  if (previous !== null && String(previous) === String(draft.value)) {
    return { needInfo: `« ${def.label} » de ${nomBien(asset)} vaut déjà ${formatFieldValue(def, draft.value)}.` };
  }

  const avant = formatFieldValue(def, previous);
  const apres = formatFieldValue(def, draft.value);
  return {
    actionId, command: 'UPDATE_ASSET_FIELD', dependsOn: [],
    targets: [{ type: 'asset', id: asset.id, label: nomBien(asset) }],
    params: { assetId: asset.id, section, field: def.key, value: draft.value, previous },
    preview: `Modifier « ${def.label} » de ${nomBien(asset)} : ${avant} → ${apres}.`,
    effects: [
      `Bien : ${nomBien(asset)}`,
      `Champ : ${def.label}`,
      `Valeur actuelle : ${avant}`,
      `Nouvelle valeur : ${apres}`,
    ],
  };
}

async function resolveBulk(
  draft: Extract<CommandDraft, { targetWords: string[] }>,
  input: AssistantRequestInput,
  lookup: CommandLookup,
  prefix: string,
): Promise<PlannedAction[] | { needInfo: string }> {
  const bulk = draft.bulk!;
  let assetIds: number[] = [];
  let bienLibelle = '';
  if (bulk.assetWords.length) {
    const found = await lookup.findAssets(input.accountId, bulk.assetWords);
    if (found.length === 0) return { needInfo: 'Je n’ai pas trouvé ce bien dans votre compte.' };
    if (found.length > 1) return { needInfo: `Plusieurs biens correspondent : ${found.slice(0, 5).map((a) => nomBien(a)).join(', ')}. Précisez lequel.` };
    assetIds = [found[0].id];
    bienLibelle = ` de ${nomBien(found[0])}`;
  }
  const items = await lookup.listOpenAgendaItems(input.accountId, {
    pastOnly: bulk.scope === 'past', assetIds, today: lookup.today(), limit: MAX_BULK_TARGETS + 1,
  });
  if (items.length === 0) return { needInfo: `Aucune échéance${bulk.scope === 'past' ? ' passée' : ''} à traiter${bienLibelle}.` };
  if (items.length > MAX_BULK_TARGETS) {
    return { needInfo: `Plus de ${MAX_BULK_TARGETS} échéances sont concernées : précisez un bien ou une période.` };
  }
  const verbe = draft.command === 'MARK_AGENDA_DONE' ? 'Marquer comme réalisée' : 'Annuler';
  return items.map((item, i) => {
    const quand = item.date ? ` du ${formatDateFr(item.date)}` : '';
    return {
      actionId: `${prefix}.${i + 1}`, command: draft.command, dependsOn: [],
      targets: [{ type: 'agenda_item' as const, id: item.id, label: item.title }],
      params: { agendaItemId: item.id },
      preview: `${verbe} « ${item.title} »${quand}.`,
      effects: [],
    };
  });
}

// ── Empreinte et persistance ───────────────────────────────────────────────

export const hashActions = (payload: string) => createHash('sha256').update(payload).digest('hex');

export function toPreview(plan: StoredPlan): CommandPlanPreview {
  return {
    planId: plan.planId,
    summary: plan.summary,
    expiresAt: plan.expiresAt,
    actions: plan.actions.map((a) => ({
      actionId: a.actionId, label: WRITE_COMMAND_CATALOG[a.command].label,
      preview: a.preview, effects: a.effects, dependsOn: a.dependsOn,
    })),
  };
}

export async function tracer(planId: string, accountId: number, userId: number | null, event: string, detail: Record<string, unknown> = {}) {
  try {
    await pgClient.unsafe(
      `INSERT INTO verebona_command_events (plan_id, account_id, user_id, event_type, detail_json) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [planId, accountId, userId, event, JSON.stringify(detail)] as never[],
    );
  } catch (e) {
    console.error('[verebona] trace de commande non enregistrée :', (e as Error).message);
  }
}

export async function savePlan(plan: StoredPlan, requestId: string | null): Promise<void> {
  const payload = JSON.stringify(plan.actions);
  await pgClient.unsafe(
    `INSERT INTO verebona_command_plans
       (plan_id, account_id, user_id, conversation_id, request_id, status, summary, actions_payload, params_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'PENDING_CONFIRMATION', $6, $7, $8, $9)`,
    [plan.planId, plan.accountId, plan.userId, plan.conversationId, requestId, plan.summary, payload, hashActions(payload), plan.expiresAt] as never[],
  );
  await tracer(plan.planId, plan.accountId, plan.userId, 'PREPARED', { summary: plan.summary, actions: plan.actions });
}

/**
 * Prépare un plan si le message est une commande claire. Rien n'est écrit
 * dans les données métier : seul le plan (en attente) est enregistré.
 */
export async function prepareCommand(
  input: AssistantRequestInput,
  lookup: CommandLookup = sqlLookup,
  now: Date = new Date(),
): Promise<Preparation | null> {
  const segments = parseCommands(input.message, lookup.today());
  if (!segments) return null;

  // Construction du plan : chaque segment résolu dans le compte ; « puis »
  // rend un segment dépendant de TOUTES les actions du précédent.
  const actions: PlannedAction[] = [];
  let precedent: string[] = [];
  for (const [i, seg] of segments.entries()) {
    const r = await resolveDraft(seg.draft, input, lookup, `a${i + 1}`);
    if ('needInfo' in r) {
      // Un plan partiellement compris n'est jamais proposé.
      return { kind: 'need_info', message: segments.length > 1 ? `Action ${i + 1} : ${r.needInfo}` : r.needInfo };
    }
    const lot = Array.isArray(r) ? r : [r];
    if (seg.dependsOnPrevious) for (const a of lot) a.dependsOn = [...precedent];
    actions.push(...lot);
    precedent = lot.map((a) => a.actionId);
  }

  const summary = actions.length === 1
    ? `${actions[0].preview} Confirmez-vous ?`
    : segments.length === 1
      ? `${actions.length} échéances concernées : chacune sera traitée séparément. Confirmez-vous l’ensemble ?`
      : `Je vais effectuer ${actions.length} actions, dans l’ordre indiqué. Confirmez-vous l’ensemble ?`;
  const plan: StoredPlan = {
    planId: randomUUID(),
    accountId: input.accountId,
    userId: input.userId,
    conversationId: input.conversationId ?? null,
    summary,
    actions,
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
  };
  await savePlan(plan, null);
  return { kind: 'plan', plan, preview: toPreview(plan) };
}

// ── Confirmation et exécution ──────────────────────────────────────────────

export type Confirmation =
  | {
      ok: true; status: PlanStatus; results: ActionResult[]; summary: string;
      /** Fin de la fenêtre « Annuler » (undo.service) ; null si le plan n'est pas annulable. */
      undoUntil: string | null;
    }
  | { ok: false; code: 'PLAN_NOT_FOUND' | 'PLAN_EXPIRED' | 'PLAN_ALREADY_HANDLED' | 'PLAN_INTEGRITY' | 'WRITE_REFUSED'; message: string; status?: PlanStatus };

/**
 * Exécution ordonnée d'un plan.
 *
 * Chaque action s'exécute seulement si TOUTES ses dépendances ont réussi ;
 * sinon SKIPPED_DEPENDENCY (et ses propres dépendantes à leur tour). Une
 * action indépendante continue malgré l'échec d'une autre. Aucun retour
 * arrière automatique : ce qui a réussi reste acquis (l'utilisateur peut
 * ensuite « Annuler » un plan réversible, voir undo.service).
 */
export async function executeActions(
  actions: PlannedAction[],
  ctx: ExecutionContext,
  executors: Record<PlannedAction['command'], Executor> = EXECUTORS,
): Promise<ActionResult[]> {
  const byId = new Map<string, ActionResult>();
  const results: ActionResult[] = [];
  for (const a of actions) {
    const bloquante = a.dependsOn.find((d) => byId.get(d)?.status !== 'SUCCESS');
    const r: ActionResult = bloquante
      ? { actionId: a.actionId, status: 'SKIPPED_DEPENDENCY', message: `${a.preview.replace(/\.$/, '')} — non exécutée : l’action ${bloquante} n’a pas réussi.` }
      : await runAction(a, ctx, executors);
    byId.set(a.actionId, r);
    results.push(r);
  }
  return results;
}

export function planStatusFrom(results: ActionResult[]): PlanStatus {
  const ok = results.filter((r) => r.status === 'SUCCESS').length;
  if (ok === results.length) return 'EXECUTED';
  return ok > 0 ? 'PARTIAL' : 'FAILED';
}

export function summarizeResults(results: ActionResult[]): string {
  if (results.length === 1) return results[0].message;
  const n = (s: string) => results.filter((r) => r.status === s).length;
  const parts = [`${n('SUCCESS')} réussie(s)`];
  if (n('FAILED')) parts.push(`${n('FAILED')} en échec`);
  if (n('SKIPPED_DEPENDENCY')) parts.push(`${n('SKIPPED_DEPENDENCY')} non exécutée(s) (dépendance en échec)`);
  if (n('REFUSED')) parts.push(`${n('REFUSED')} refusée(s)`);
  return `Plan exécuté : ${parts.join(', ')}.`;
}

export async function confirmCommandPlan(
  p: { planId: string; accountId: number; userId: number },
  deps: {
    executors?: Record<PlannedAction['command'], Executor>;
    canWrite?: (accountId: number) => Promise<{ allowed: boolean; message?: string }>;
  } = {},
): Promise<Confirmation> {
  // Prise atomique : propriétaire, en attente, non expiré.
  const pris = (await pgClient.unsafe(
    `UPDATE verebona_command_plans
        SET status = 'EXECUTING', confirmed_at = now()
      WHERE plan_id = $1 AND account_id = $2 AND user_id = $3
        AND status = 'PENDING_CONFIRMATION' AND expires_at > now()
      RETURNING actions_payload, params_hash, summary, conversation_id AS "conversationId", message_id AS "messageId"`,
    [p.planId, p.accountId, p.userId] as never[],
  )) as unknown as Array<{ actions_payload: string; params_hash: string; summary: string; conversationId: number | null; messageId: number | null }>;

  if (!pris[0]) {
    const [etat] = (await pgClient.unsafe(
      `SELECT status, expires_at < now() AS expired, conversation_id AS "conversationId", message_id AS "messageId"
         FROM verebona_command_plans
        WHERE plan_id = $1 AND account_id = $2 AND user_id = $3`,
      [p.planId, p.accountId, p.userId] as never[],
    )) as unknown as Array<{ status: PlanStatus; expired: boolean; conversationId?: number | null; messageId?: number | null }>;
    if (!etat) return { ok: false, code: 'PLAN_NOT_FOUND', message: 'Cette action n’existe pas ou ne vous appartient pas.' };
    if (etat.status === 'EXPIRED' || (etat.status === 'PENDING_CONFIRMATION' && etat.expired)) {
      if (etat.status === 'PENDING_CONFIRMATION') {
        await pgClient.unsafe(`UPDATE verebona_command_plans SET status = 'EXPIRED' WHERE plan_id = $1 AND status = 'PENDING_CONFIRMATION'`, [p.planId] as never[]);
        await tracer(p.planId, p.accountId, p.userId, 'EXPIRED');
        await recordPlanOutcome({ ...p, conversationId: etat.conversationId ?? null, messageId: etat.messageId ?? null }, EXPIRED_MESSAGE);
      }
      return { ok: false, code: 'PLAN_EXPIRED', message: EXPIRED_MESSAGE, status: 'EXPIRED' };
    }
    if (etat.status === 'CANCELLED') {
      return { ok: false, code: 'PLAN_ALREADY_HANDLED', message: 'Cette action a été annulée : rien n’a été modifié.', status: 'CANCELLED' };
    }
    return { ok: false, code: 'PLAN_ALREADY_HANDLED', message: 'Cette action a déjà été traitée.', status: etat.status };
  }

  const fin = async (status: PlanStatus, results: ActionResult[]) => {
    await pgClient.unsafe(
      `UPDATE verebona_command_plans SET status = $2, results_json = $3::jsonb, executed_at = now() WHERE plan_id = $1`,
      [p.planId, status, JSON.stringify(results)] as never[],
    );
  };

  await tracer(p.planId, p.accountId, p.userId, 'CONFIRMED');
  const fil = { ...p, conversationId: pris[0].conversationId ?? null, messageId: pris[0].messageId ?? null };

  // Paramètres figés : l'empreinte doit correspondre à ce qui a été présenté.
  if (hashActions(pris[0].actions_payload) !== pris[0].params_hash) {
    await fin('FAILED', []);
    await tracer(p.planId, p.accountId, p.userId, 'INTEGRITY_FAILED');
    const message = 'Cette action ne peut pas être exécutée. Refaites votre demande.';
    await recordPlanOutcome(fil, message);
    return { ok: false, code: 'PLAN_INTEGRITY', message, status: 'FAILED' };
  }
  const actions = JSON.parse(pris[0].actions_payload) as PlannedAction[];

  // Droits évalués À L'EXÉCUTION, comme dans l'interface classique : un
  // compte passé en lecture seule entre-temps ne peut pas écrire en
  // confirmant une proposition antérieure.
  const droit = await (deps.canWrite ?? defaultCanWrite)(p.accountId);
  if (!droit.allowed) {
    const refus = actions.map((a) => ({ actionId: a.actionId, status: 'REFUSED' as const, message: droit.message ?? 'Écriture non autorisée.' }));
    await fin('REFUSED', refus);
    await tracer(p.planId, p.accountId, p.userId, 'REFUSED', { reason: droit.message });
    await recordPlanOutcome(fil, droit.message ?? 'Écriture non autorisée.');
    return { ok: false, code: 'WRITE_REFUSED', message: droit.message ?? 'Écriture non autorisée.', status: 'REFUSED' };
  }

  // Chaque exécuteur réversible décrit sa commande inverse et l'état
  // antérieur de sa cible (undo.service) ; la fenêtre « Annuler » ne s'ouvre
  // que si TOUTES les étapes réussies sont réversibles (T2-039).
  const captures = new Map<string, UndoCapture>();
  const results = await executeActions(
    actions,
    { accountId: p.accountId, userId: p.userId, recordUndo: (c) => { captures.set(c.actionId, c); } },
    deps.executors,
  );
  const status = planStatusFrom(results);
  await fin(status, results);
  const undo = await armUndo(p, results, captures);
  await tracer(p.planId, p.accountId, p.userId, 'EXECUTED', {
    status, results, undo: { reversible: undo.undoUntil !== null, undoUntil: undo.undoUntil, reasons: undo.reasons },
  });
  const summary = summarizeResults(results);
  await recordPlanOutcome(fil, outcomeText(summary, results));
  return { ok: true, status, results, summary, undoUntil: undo.undoUntil };
}

export async function defaultCanWrite(accountId: number): Promise<{ allowed: boolean; message?: string }> {
  const d = await getEntitlements(accountId);
  if (d.canWrite) return { allowed: true };
  const r = await restrictedRefusal(accountId, d.status);
  return { allowed: false, message: r.message };
}

// ── Annulation d'une proposition ───────────────────────────────────────────

export type Cancellation =
  /**
   * Proposition close sans aucune écriture : annulée maintenant, déjà
   * annulée (appel rejoué — idempotence), ou expirée entre-temps.
   */
  | { ok: true; status: 'CANCELLED' | 'EXPIRED'; alreadyHandled: boolean; message: string }
  | { ok: false; code: 'PLAN_NOT_FOUND' | 'PLAN_ALREADY_HANDLED'; message: string; status?: PlanStatus };

export const CANCELLED_MESSAGE = 'D’accord, j’ai annulé cette action : rien n’a été modifié.';
export const EXPIRED_MESSAGE = 'Cette proposition a expiré : rien n’a été modifié. Refaites votre demande si besoin.';

/**
 * Annulation, par l'utilisateur, d'une commande proposée et NON confirmée
 * (CDC §5.3 « possibilité d'annulation », §9.6 états CANCELLED / EXPIRED,
 * §27.5 idempotence).
 *
 *   · prise atomique : seul un plan EN ATTENTE, non expiré, du même compte
 *     ET du même utilisateur passe à CANCELLED — une confirmation
 *     concurrente et une annulation ne peuvent pas réussir toutes les deux ;
 *   · idempotente : rejouée sur un plan déjà annulé, elle rend le même
 *     résultat, sans nouvelle trace ni nouveau message ;
 *   · une proposition expirée est close comme EXPIRED (rien à annuler) ;
 *   · un plan déjà confirmé n'est plus annulable ici (pas de retour arrière
 *     sur des écritures exécutées) ;
 *   · le plan d'un autre utilisateur (autre membre d'un Duo) ou d'un autre
 *     compte est traité comme inexistant ;
 *   · l'issue est enregistrée dans le fil (message de l'assistant) et tracée.
 *
 * Aucune donnée métier n'est touchée.
 */
export async function cancelCommandPlan(p: { planId: string; accountId: number; userId: number }): Promise<Cancellation> {
  const rows = (await pgClient.unsafe(
    `UPDATE verebona_command_plans SET status = 'CANCELLED', cancelled_at = now()
      WHERE plan_id = $1 AND account_id = $2 AND user_id = $3
        AND status = 'PENDING_CONFIRMATION' AND expires_at > now()
      RETURNING conversation_id AS "conversationId", message_id AS "messageId"`,
    [p.planId, p.accountId, p.userId] as never[],
  )) as unknown as Array<{ conversationId: number | null; messageId: number | null }>;
  if (rows[0]) {
    await tracer(p.planId, p.accountId, p.userId, 'CANCELLED');
    await recordPlanOutcome({ ...p, ...rows[0] }, CANCELLED_MESSAGE);
    return { ok: true, status: 'CANCELLED', alreadyHandled: false, message: CANCELLED_MESSAGE };
  }

  const [etat] = (await pgClient.unsafe(
    `SELECT status, expires_at < now() AS expired, conversation_id AS "conversationId", message_id AS "messageId"
       FROM verebona_command_plans WHERE plan_id = $1 AND account_id = $2 AND user_id = $3`,
    [p.planId, p.accountId, p.userId] as never[],
  )) as unknown as Array<{ status: PlanStatus; expired: boolean; conversationId: number | null; messageId: number | null }>;
  if (!etat) return { ok: false, code: 'PLAN_NOT_FOUND', message: 'Cette action n’existe pas ou ne vous appartient pas.' };

  if (etat.status === 'CANCELLED') {
    return { ok: true, status: 'CANCELLED', alreadyHandled: true, message: CANCELLED_MESSAGE };
  }
  if (etat.status === 'EXPIRED' || (etat.status === 'PENDING_CONFIRMATION' && etat.expired)) {
    if (etat.status === 'PENDING_CONFIRMATION') {
      const passe = (await pgClient.unsafe(
        `UPDATE verebona_command_plans SET status = 'EXPIRED' WHERE plan_id = $1 AND status = 'PENDING_CONFIRMATION' RETURNING plan_id`,
        [p.planId] as never[],
      )) as unknown as unknown[];
      if (passe.length) {
        await tracer(p.planId, p.accountId, p.userId, 'EXPIRED');
        await recordPlanOutcome({ ...p, conversationId: etat.conversationId, messageId: etat.messageId }, EXPIRED_MESSAGE);
        return { ok: true, status: 'EXPIRED', alreadyHandled: false, message: EXPIRED_MESSAGE };
      }
    }
    return { ok: true, status: 'EXPIRED', alreadyHandled: true, message: EXPIRED_MESSAGE };
  }
  return {
    ok: false, code: 'PLAN_ALREADY_HANDLED', status: etat.status,
    message: 'Cette action a déjà été confirmée : elle ne peut plus être annulée depuis l’assistant.',
  };
}

/**
 * Passe à EXPIRED les propositions en attente dont la validité est dépassée
 * (purge quotidienne, et avant restitution d'un fil). Rend leur nombre.
 * Aucun message n'est ajouté aux fils : l'état suffit à l'affichage.
 */
export async function expirePendingPlans(scope: { accountId?: number; userId?: number } = {}): Promise<number> {
  const rows = (await pgClient.unsafe(
    `UPDATE verebona_command_plans SET status = 'EXPIRED'
      WHERE status = 'PENDING_CONFIRMATION' AND expires_at <= now()
        AND ($1::int IS NULL OR account_id = $1) AND ($2::int IS NULL OR user_id = $2)
      RETURNING plan_id, account_id, user_id`,
    [scope.accountId ?? null, scope.userId ?? null] as never[],
  )) as unknown as Array<{ plan_id: string; account_id: number; user_id: number }>;
  for (const r of rows) await tracer(r.plan_id, r.account_id, r.user_id, 'EXPIRED', { by: 'expiry' });
  // Purge quotidienne (sans périmètre) : états antérieurs des annulations
  // dont la fenêtre est close.
  if (scope.accountId == null && scope.userId == null) await purgeExpiredUndoSteps();
  return rows.length;
}

/** Plan tel que restitué dans l'historique d'un fil. */
export interface ThreadCommandPlan extends CommandPlanPreview {
  messageId: number;
  status: PlanStatus;
  /**
   * Fin de la fenêtre « Annuler » d'un plan exécuté et réversible ; null
   * sinon (irréversible, non exécuté, déjà annulé). Le serveur fait foi.
   */
  undoUntil: string | null;
}

/**
 * Plans présentés dans un fil de l'utilisateur, par message : l'historique
 * rechargé montre leur état réel (en attente et encore annulable, annulé,
 * expiré, exécuté). Seuls les plans du compte ET de l'utilisateur sortent.
 */
export async function listThreadCommandPlans(
  accountId: number,
  userId: number,
  conversationId: number,
): Promise<ThreadCommandPlan[]> {
  await expirePendingPlans({ accountId, userId });
  const rows = (await pgClient.unsafe(
    `SELECT plan_id AS "planId", account_id AS "accountId", user_id AS "userId", conversation_id AS "conversationId",
            message_id AS "messageId", status, summary, actions_payload AS "actionsPayload", expires_at AS "expiresAt",
            undo_until AS "undoUntil"
       FROM verebona_command_plans
      WHERE account_id = $1 AND user_id = $2 AND conversation_id = $3 AND message_id IS NOT NULL
      ORDER BY created_at ASC`,
    [accountId, userId, conversationId] as never[],
  )) as unknown as Array<{
    planId: string; accountId: number; userId: number; conversationId: number | null; messageId: number;
    status: PlanStatus; summary: string; actionsPayload: string; expiresAt: string | Date; undoUntil?: string | Date | null;
  }>;
  const out: ThreadCommandPlan[] = [];
  for (const r of rows) {
    let actions: PlannedAction[];
    try { actions = JSON.parse(r.actionsPayload) as PlannedAction[]; } catch { continue; }
    const expiresAt = r.expiresAt instanceof Date ? r.expiresAt.toISOString() : String(r.expiresAt);
    const preview = toPreview({ ...r, actions, expiresAt });
    const annulable = (r.status === 'EXECUTED' || r.status === 'PARTIAL') && r.undoUntil;
    out.push({
      ...preview, messageId: r.messageId, status: r.status,
      undoUntil: annulable ? new Date(r.undoUntil as string | Date).toISOString() : null,
    });
  }
  return out;
}

/**
 * Issue d'un plan (annulation, expiration, exécution) enregistrée dans le
 * fil comme message de l'assistant, rattaché au message qui présentait le
 * plan. Seulement si le fil existe toujours et appartient à l'utilisateur.
 * Ne lève jamais : l'issue est déjà rendue et tracée.
 */
export async function recordPlanOutcome(
  p: { planId: string; accountId: number; userId: number; conversationId: number | null; messageId: number | null },
  content: string,
): Promise<void> {
  if (!p.conversationId) return;
  try {
    const { getAssistantConfig } = await import('../config/assistant-config');
    const expires = new Date(Date.now() + getAssistantConfig().historyDays * 86400_000).toISOString();
    const rows = (await pgClient.unsafe(
      `INSERT INTO verebona_messages
         (conversation_id, account_id, author_user_id, role, status, content, intent, mode,
          parent_message_id, response_locale, expires_at)
       SELECT c.id, $2, NULL, 'assistant', 'ready', $4, 'WRITE_COMMAND', 'deterministic', $5, 'fr-FR', $6
         FROM verebona_conversations c
        WHERE c.id = $1 AND c.account_id = $2 AND c.user_id = $3 AND c.status = 'active'
       RETURNING conversation_id`,
      [p.conversationId, p.accountId, p.userId, content, p.messageId, expires] as never[],
    )) as unknown as unknown[];
    if (rows.length) {
      await pgClient.unsafe(
        `UPDATE verebona_conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`,
        [p.conversationId] as never[],
      );
    }
  } catch (e) {
    console.error('[verebona] issue de commande non enregistrée dans le fil :', (e as Error).message);
  }
}

/** Texte de l'issue d'une exécution, tel qu'il est montré et enregistré. */
export function outcomeText(summary: string, results: ActionResult[]): string {
  if (results.length <= 1) return summary;
  const puce = (s: ActionResult['status']) => (s === 'SUCCESS' ? '✓' : s === 'SKIPPED_DEPENDENCY' ? '↷' : '✗');
  return `${summary}\n${results.map((r) => `• ${puce(r.status)} ${r.message}`).join('\n')}`;
}
