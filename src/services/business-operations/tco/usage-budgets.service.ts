/**
 * Lot 108C (ticket TCO-646 §E) — persistance des FORFAITS D'USAGE (table
 * 0380, révisions datées 1050) et des CLASSEMENTS de dépenses réelles en
 * dépenses d'usage (table 1051). Aucune Opération, aucun ticket modifié :
 * seuls les choix de l'utilisateur sont écrits, le TCO les relit à chaque
 * calcul (`./usage-complement`).
 *
 * RÉVISIONS (une modification ne réécrit pas les périodes closes) :
 *   · libellé seul, ou dates : modification sur place (geste explicite) ;
 *   · montant, devise, périodicité ou catégorie modifiés d'un forfait qui a
 *     déjà couvert des jours avant la date d'effet : l'ancienne version se
 *     termine la veille de la date d'effet, une nouvelle version commence à
 *     cette date (`revises_budget_id`). Date d'effet par défaut : début de la
 *     période en cours (les périodes échues gardent l'ancien montant) ; une
 *     date antérieure choisie par l'utilisateur corrige explicitement
 *     l'historique ;
 *   · forfait terminé, ou date d'effet au plus tard à son début : correction
 *     sur place (explicite, annoncée par l'interface).
 * CHEVAUCHEMENTS : refusés à la saisie (409 `USAGE_BUDGET_OVERLAP`) pour une
 * même catégorie (et, pour « Autre », un même libellé).
 * ARRÊT / SUPPRESSION : « Arrêter » termine le forfait à la fin de la dernière
 * période échue (les estimations passées restent) ; « Supprimer » efface la
 * saisie erronée (et, sur demande, toutes ses versions).
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { civilDateParis, isIsoDate } from '../finance/engine';
import type { UsageBudget } from './model';
import { calendarPeriod, usageKeyOf, type UsageLineAssignment } from './usage-complement';
import { USAGE_BUDGET_CATEGORY_LABELS } from './model';

type Row = Record<string, unknown>;
interface Runner { execute: (q: SQL) => Promise<unknown> }
const rows = async <T = Row>(r: Runner, q: SQL): Promise<T[]> => (await r.execute(q)) as unknown as T[];
const txt = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

function addDays(d: string, n: number): string {
  const t = new Date(`${d.slice(0, 10)}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
const dateFr = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/** Erreur métier d'un forfait (statut HTTP, code stable, message à afficher). */
export class UsageBudgetError extends Error {
  constructor(public readonly code: 'USAGE_BUDGET_OVERLAP' | 'VALIDATION', message: string, public readonly status: number) {
    super(message);
    this.name = 'UsageBudgetError';
  }
}

// ── Présence des structures (déploiement avant migration : comportement antérieur) ──

let colonneRevision: boolean | null = null;
async function revisionsDisponibles(r: Runner): Promise<boolean> {
  if (colonneRevision) return true;
  const [x] = await rows<{ ok: boolean }>(r, sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                     AND table_name = 'asset_usage_budgets' AND column_name = 'revises_budget_id') AS ok`);
  colonneRevision = Boolean(x?.ok) || null;
  return Boolean(x?.ok);
}

async function tablePresente(r: Runner, table: string): Promise<boolean> {
  const [t] = await rows<{ ok: boolean }>(r, sql`SELECT to_regclass(${table}) IS NOT NULL AS ok`);
  return Boolean(t?.ok);
}

// ── Lecture ────────────────────────────────────────────────────────────────

/** Forfaits du bien du compte (toutes versions, ordre de création). */
export async function readUsageBudgets(accountId: number, assetId: number, r: Runner = db): Promise<UsageBudget[]> {
  if (!(await tablePresente(r, 'asset_usage_budgets'))) return [];
  const rev = await revisionsDisponibles(r);
  const x = await rows(r, sql`
    SELECT b.id, b.asset_id, b.category, b.label, b.amount_minor, trim(b.currency) AS currency, b.periodicity,
           b.valid_from::text AS valid_from, b.valid_to::text AS valid_to${rev ? sql`, b.revises_budget_id` : sql``}
      FROM asset_usage_budgets b JOIN assets a ON a.id = b.asset_id AND a.account_id = b.account_id
     WHERE b.account_id = ${accountId} AND b.asset_id = ${assetId} ORDER BY b.id`);
  return x.map((b) => ({
    id: Number(b.id), assetId: Number(b.asset_id), category: String(b.category) as UsageBudget['category'], label: txt(b.label),
    amountMinor: Number(b.amount_minor), currency: String(b.currency), periodicity: String(b.periodicity) as UsageBudget['periodicity'],
    validFrom: txt(b.valid_from), validTo: txt(b.valid_to),
    revisesBudgetId: b.revises_budget_id == null ? null : Number(b.revises_budget_id),
  }));
}

/** Classements « dépense d'usage » de l'utilisateur pour ce bien (lecture seule). */
export async function readUsageAssignments(r: Runner, accountId: number, assetId: number): Promise<UsageLineAssignment[]> {
  if (!(await tablePresente(r, 'asset_usage_line_assignments'))) return [];
  const x = await rows(r, sql`
    SELECT u.line_key, u.usage_category, u.other_label, u.decided_by,
           to_char(u.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at
      FROM asset_usage_line_assignments u JOIN assets a ON a.id = u.asset_id AND a.account_id = u.account_id
     WHERE u.account_id = ${accountId} AND u.asset_id = ${assetId}
     ORDER BY u.decided_at DESC, u.id DESC LIMIT 5000`);
  return x.map((u) => ({
    key: String(u.line_key), category: String(u.usage_category) as UsageLineAssignment['category'], otherLabel: txt(u.other_label),
    decidedAt: String(u.decided_at), decidedByUserId: u.decided_by == null ? null : Number(u.decided_by),
  }));
}

// ── Écriture des forfaits ──────────────────────────────────────────────────

export interface UsageBudgetInput {
  category: UsageBudget['category']; label: string | null; amountMinor: number; currency: string;
  periodicity: UsageBudget['periodicity']; validFrom: string | null; validTo: string | null;
}

/** Date d'effet facultative d'une modification (`effectiveFrom`, AAAA-MM-JJ) — null : défaut. */
export function parseEffectiveFrom(body: unknown): { ok: true; value: string | null } | { ok: false; message: string } {
  const v = body && typeof body === 'object' ? (body as Record<string, unknown>).effectiveFrom : null;
  if (v == null || v === '') return { ok: true, value: null };
  return typeof v === 'string' && isIsoDate(v) ? { ok: true, value: v.slice(0, 10) } : { ok: false, message: 'Date d’effet invalide.' };
}

const chevauche = (a: { from: string | null; to: string | null }, b: { from: string | null; to: string | null }) =>
  (a.to == null || b.from == null || b.from <= a.to) && (b.to == null || a.from == null || a.from <= b.to);

/** Refuse un forfait qui couvre les mêmes jours qu'un autre forfait de même catégorie (même libellé pour « Autre »). */
async function verifierChevauchement(
  r: Runner, accountId: number, assetId: number, cible: { category: UsageBudget['category']; label: string | null; from: string | null; to: string | null; currency: string }, exclure: readonly number[],
): Promise<void> {
  const autres = (await readUsageBudgets(accountId, assetId, r)).filter((b) => !exclure.includes(b.id));
  const cle = usageKeyOf(cible.category, cible.label);
  const conflit = autres.find((b) => usageKeyOf(b.category, b.label) === cle && chevauche({ from: b.validFrom, to: b.validTo }, { from: cible.from, to: cible.to }));
  if (!conflit) return;
  const nom = cible.category === 'OTHER' && cible.label ? `« ${cible.label} »` : `« ${USAGE_BUDGET_CATEGORY_LABELS[cible.category]} »`;
  const periode = conflit.validFrom || conflit.validTo
    ? ` (${conflit.validFrom ? `du ${dateFr(conflit.validFrom)}` : 'depuis le début'}${conflit.validTo ? ` au ${dateFr(conflit.validTo)}` : ', sans date de fin'})`
    : ' (sans dates)';
  throw new UsageBudgetError('USAGE_BUDGET_OVERLAP',
    `Un forfait ${nom} couvre déjà cette période${periode}. Modifiez-le, ou terminez-le avant d’en ajouter un autre : deux estimations de la même dépense ne s’additionnent pas.`, 409);
}

/** Crée un forfait (le bien doit être du compte). Rend l'identifiant, ou null (bien absent). */
export async function createUsageBudget(accountId: number, assetId: number, userId: number | null, b: UsageBudgetInput): Promise<number | null> {
  const [bien] = await rows(db, sql`SELECT id FROM assets WHERE id = ${assetId} AND account_id = ${accountId} AND deleted_at IS NULL`);
  if (!bien) return null;
  await verifierChevauchement(db, accountId, assetId, { category: b.category, label: b.label, from: b.validFrom, to: b.validTo, currency: b.currency }, []);
  const [x] = await rows<{ id: string }>(db, sql`
    INSERT INTO asset_usage_budgets (account_id, asset_id, category, label, amount_minor, currency, periodicity, valid_from, valid_to, created_by, updated_by)
    SELECT a.account_id, a.id, ${b.category}, ${b.label}, ${b.amountMinor}, ${b.currency}, ${b.periodicity}, ${b.validFrom}::date, ${b.validTo}::date, ${userId}, ${userId}
      FROM assets a WHERE a.id = ${assetId} AND a.account_id = ${accountId} AND a.deleted_at IS NULL
    RETURNING id`);
  return x ? Number(x.id) : null;
}

/** Résultat d'une modification : sur place, ou nouvelle version datée. */
export interface UsageBudgetUpdate { id: number; revised: boolean; effectiveFrom: string | null }

/**
 * Modifie un forfait du bien du compte (règle des révisions datées, en tête
 * de fichier). Rend null si le forfait n'existe pas pour ce bien et ce compte.
 */
export async function updateUsageBudget(
  accountId: number, assetId: number, id: number, userId: number | null, b: UsageBudgetInput,
  opts: { effectiveFrom?: string | null; today?: string } = {},
): Promise<UsageBudgetUpdate | null> {
  const today = opts.today ?? civilDateParis();
  const actuel = (await readUsageBudgets(accountId, assetId)).find((x) => x.id === id);
  if (!actuel) return null;
  const valeurChangee = actuel.category !== b.category || actuel.amountMinor !== b.amountMinor || actuel.currency !== b.currency
    || actuel.periodicity !== b.periodicity || usageKeyOf(actuel.category, actuel.label) !== usageKeyOf(b.category, b.label);
  const effet = opts.effectiveFrom ?? calendarPeriod(today, actuel.periodicity).start;
  const depuis = actuel.validFrom?.slice(0, 10) ?? null;
  const fin = actuel.validTo?.slice(0, 10) ?? null;
  // Des jours couverts AVANT la date d'effet existent (périodes à préserver) et le forfait court encore à cette date.
  const historique = valeurChangee && (depuis == null || depuis < effet) && (fin == null || fin >= effet);
  if (!historique) {
    await verifierChevauchement(db, accountId, assetId, { category: b.category, label: b.label, from: b.validFrom, to: b.validTo, currency: b.currency }, [id]);
    const x = await rows(db, sql`
      UPDATE asset_usage_budgets SET category = ${b.category}, label = ${b.label}, amount_minor = ${b.amountMinor}, currency = ${b.currency},
             periodicity = ${b.periodicity}, valid_from = ${b.validFrom}::date, valid_to = ${b.validTo}::date, updated_by = ${userId}, updated_at = now()
       WHERE id = ${id} AND asset_id = ${assetId} AND account_id = ${accountId} RETURNING id`);
    return x.length ? { id, revised: false, effectiveFrom: null } : null;
  }
  if (b.validTo && b.validTo.slice(0, 10) < effet) {
    throw new UsageBudgetError('VALIDATION', `La fin de validité précède la date d’effet de la modification (${dateFr(effet)}).`, 422);
  }
  await verifierChevauchement(db, accountId, assetId, { category: b.category, label: b.label, from: effet, to: b.validTo, currency: b.currency }, [id]);
  const rev = await revisionsDisponibles(db);
  const nouvelId = await db.transaction(async (tx) => {
    const r = tx as unknown as Runner;
    const fermes = await rows(r, sql`
      UPDATE asset_usage_budgets SET valid_to = ${addDays(effet, -1)}::date, updated_by = ${userId}, updated_at = now()
       WHERE id = ${id} AND asset_id = ${assetId} AND account_id = ${accountId} RETURNING id`);
    if (!fermes.length) return null;
    const [n] = await rows<{ id: string }>(r, sql`
      INSERT INTO asset_usage_budgets (account_id, asset_id, category, label, amount_minor, currency, periodicity, valid_from, valid_to, created_by, updated_by${rev ? sql`, revises_budget_id` : sql``})
      VALUES (${accountId}, ${assetId}, ${b.category}, ${b.label}, ${b.amountMinor}, ${b.currency}, ${b.periodicity}, ${effet}::date, ${b.validTo}::date, ${userId}, ${userId}${rev ? sql`, ${id}` : sql``})
      RETURNING id`);
    return n ? Number(n.id) : null;
  });
  return nouvelId ? { id: nouvelId, revised: true, effectiveFrom: effet } : null;
}

/** ERASE : supprime cette version ; ERASE_HISTORY : toutes les versions ; STOP : termine à la fin de la dernière période échue. */
export type UsageBudgetDeleteMode = 'ERASE' | 'ERASE_HISTORY' | 'STOP';

export function parseUsageBudgetDeleteMode(v: string | null): UsageBudgetDeleteMode {
  return v === 'STOP' || v === 'ERASE_HISTORY' ? v : 'ERASE';
}

/** Arrête ou supprime un forfait (geste explicite ; jamais au changement d'offre). Rend faux si absent. */
export async function deleteUsageBudget(
  accountId: number, assetId: number, id: number, mode: UsageBudgetDeleteMode = 'ERASE', opts: { today?: string } = {},
): Promise<boolean> {
  const tous = await readUsageBudgets(accountId, assetId);
  const actuel = tous.find((x) => x.id === id);
  if (!actuel) return false;
  if (mode === 'STOP') {
    const finEchue = addDays(calendarPeriod(opts.today ?? civilDateParis(), actuel.periodicity).start, -1);
    const depuis = actuel.validFrom?.slice(0, 10) ?? null;
    if (actuel.validTo && actuel.validTo.slice(0, 10) <= finEchue) return true; // déjà terminé
    if (depuis && depuis > finEchue) mode = 'ERASE'; // aucune période échue : rien à préserver
    else {
      await db.execute(sql`UPDATE asset_usage_budgets SET valid_to = ${finEchue}::date, updated_at = now()
        WHERE id = ${id} AND asset_id = ${assetId} AND account_id = ${accountId}`);
      return true;
    }
  }
  let ids = [id];
  if (mode === 'ERASE_HISTORY') {
    // Versions précédentes et suivantes (chaîne `revisesBudgetId`).
    const chaine = new Set([id]);
    for (let change = true; change;) {
      change = false;
      for (const b of tous) {
        if (b.revisesBudgetId != null && chaine.has(b.revisesBudgetId) && !chaine.has(b.id)) { chaine.add(b.id); change = true; }
        if (chaine.has(b.id) && b.revisesBudgetId != null && !chaine.has(b.revisesBudgetId)) { chaine.add(b.revisesBudgetId); change = true; }
      }
    }
    ids = [...chaine];
  }
  const x = await rows(db, sql`DELETE FROM asset_usage_budgets WHERE id = ANY(${`{${ids.join(',')}}`}::bigint[]) AND asset_id = ${assetId} AND account_id = ${accountId} RETURNING id`);
  return x.length > 0;
}
