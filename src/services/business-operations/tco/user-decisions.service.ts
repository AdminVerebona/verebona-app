/**
 * Lot 80A — écriture des décisions « Ajouter au TCO » / « Retirer du TCO ».
 *
 * Décision UTILISATEUR, par compte et par bien, rattachée à la clé STABLE de
 * la ligne (`tcoLineKeys`, documentée dans `./user-decisions`) :
 *   · `asset_cost_line_decisions` — état courant (une décision par clé) ;
 *   · `asset_cost_line_decision_events` — journal append-only (qui, quand,
 *     geste, décision précédente, statut automatique remplacé, avertissement
 *     de doublon présenté).
 * Réversible : sur une ligne dont le résultat vient d'une décision, le geste
 * inverse ANNULE la décision (retour aux règles automatiques) ; sinon il
 * enregistre la décision. Le résultat est relu par le MÊME moteur
 * (`readAssetTco`) : totaux, moyenne annuelle et dépenses de l'année à jour.
 *
 * Garde-fous : ligne relue côté serveur (aucun montant cru sur parole), ligne
 * montrée sur la fiche seulement, ajout impossible sans montant en euros,
 * doublon présumé refusé sans confirmation explicite (`confirmDuplicate`).
 * Droits : contrôlés par la route (Premium / Premium Duo, bien modifiable).
 *
 * Lot 111V — ARBITRAGES (`CONFIRM_EXCLUSION`, `SAME_FACT`, `DISTINCT_FACTS`,
 * `REQUALIFY`) et `REVERT` explicite : même table (colonnes de la migration
 * 1320 : lignes liées, catégorie choisie, statut / motif automatiques au
 * moment du choix), même journal, même relecture par le moteur. Le geste doit
 * figurer parmi les gestes proposés par le serveur pour CETTE ligne
 * (`tcoLineDecisionOptions`) : jamais un arbitrage hors contexte.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { readAssetTco } from './service';
import { tcoUserView } from './dto';
import type { TcoCategory, TcoEconomicLine, TcoResult } from './model';
import {
  TCO_ARBITRATION_DECISIONS, TCO_REQUALIFY_CATEGORIES, tcoAddDuplicateRisk, tcoLineAddable, tcoLineDecisionOptions, tcoLineKeys, tcoLineRemovable, type TcoUserDecisionValue,
} from './user-decisions';

interface Runner { execute: (q: SQL) => Promise<unknown> }
const rows = async <T = Record<string, unknown>>(r: Runner, q: SQL): Promise<T[]> => (await r.execute(q)) as unknown as T[];

type TcoDecisionErrorCode = 'LINE_NOT_FOUND' | 'NOT_ADDABLE' | 'NOT_REMOVABLE' | 'DUPLICATE_CONFIRMATION_REQUIRED' | 'UNAVAILABLE' | 'NOT_APPLICABLE';

export class TcoDecisionError extends Error {
  constructor(public readonly code: TcoDecisionErrorCode, message: string, public readonly status: number, public readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'TcoDecisionError';
  }
}

/** Geste demandé : décision (lot 80A, arbitrages 111V) ou annulation explicite d'un arbitrage. */
type TcoDecisionAction = TcoUserDecisionValue | 'REVERT';

const ACTIONS: ReadonlySet<string> = new Set(['INCLUDE', 'EXCLUDE', 'CONFIRM_EXCLUSION', 'SAME_FACT', 'DISTINCT_FACTS', 'REQUALIFY', 'REVERT']);

interface TcoDecisionInput {
  lineId: string;
  /** Clé stable connue de l'interface (repli si l'identifiant technique a changé entre l'affichage et le clic). */
  lineKey?: string | null;
  action: TcoDecisionAction;
  /** L'utilisateur a lu et accepté l'avertissement de doublon présumé. */
  confirmDuplicate?: boolean;
  /** Lot 111V : catégorie choisie (REQUALIFY). */
  category?: TcoCategory | null;
}

type TcoDecisionOutcome = 'SET' | 'REVERTED' | 'UNCHANGED';

/** Corps de la requête → entrée validée (pure). */
export function parseTcoDecisionBody(body: unknown, categories: readonly string[] = TCO_REQUALIFY_CATEGORIES): { ok: true; value: TcoDecisionInput } | { ok: false; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: 'Corps attendu : un objet.' };
  const b = body as Record<string, unknown>;
  if (typeof b.lineId !== 'string' || !b.lineId.trim() || b.lineId.length > 200) return { ok: false, message: 'Ligne invalide.' };
  if (typeof b.action !== 'string' || !ACTIONS.has(b.action)) return { ok: false, message: 'Geste invalide.' };
  if (b.lineKey != null && (typeof b.lineKey !== 'string' || b.lineKey.length > 200)) return { ok: false, message: 'Clé de ligne invalide.' };
  if (b.category != null && (typeof b.category !== 'string' || !categories.includes(b.category))) return { ok: false, message: 'Catégorie invalide.' };
  return {
    ok: true,
    value: {
      lineId: b.lineId.trim(), lineKey: (b.lineKey as string | null | undefined) ?? null, action: b.action as TcoDecisionAction, confirmDuplicate: b.confirmDuplicate === true,
      ...(b.category ? { category: b.category as TcoCategory } : {}),
    },
  };
}

const RETENUE = (l: Pick<TcoEconomicLine, 'status'>) => l.status === 'RETAINED_DIRECT' || l.status === 'RETAINED_CONSOLIDATED';
const pgArray = (l: readonly string[]) => `{${l.map((k) => `"${k.replace(/["\\]/g, '')}"`).join(',')}}`;

/** Lot 111V : colonnes d'arbitrage présentes (migration 1320 appliquée). */
async function arbitrationColumnsReady(): Promise<boolean> {
  const [c] = await rows<{ n: number }>(db, sql`
    SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_name = 'asset_cost_line_decisions' AND column_name IN ('related_line_keys', 'requalified_category', 'automatic_status', 'automatic_reason')`);
  return Number(c?.n ?? 0) === 4;
}

/** Enregistre (ou annule) une décision et rend le TCO recalculé. */
export async function decideTcoLine(
  accountId: number, assetId: number, userId: number | null, input: TcoDecisionInput, opts: { today?: string } = {},
): Promise<{ result: TcoResult; outcome: TcoDecisionOutcome; line: TcoEconomicLine | null }> {
  const [t] = await rows<{ ok: boolean }>(db, sql`SELECT to_regclass('asset_cost_line_decisions') IS NOT NULL AND to_regclass('asset_cost_line_decision_events') IS NOT NULL AS ok`);
  if (!t?.ok) throw new TcoDecisionError('UNAVAILABLE', 'Cette fonction sera disponible après la mise à jour en cours. Réessayez dans quelques minutes.', 503);
  const arbitrage = TCO_ARBITRATION_DECISIONS.has(input.action as TcoUserDecisionValue) || input.action === 'REVERT';
  if (arbitrage && !(await arbitrationColumnsReady())) {
    throw new TcoDecisionError('UNAVAILABLE', 'Cette fonction sera disponible après la mise à jour en cours. Réessayez dans quelques minutes.', 503);
  }
  const avant = await readAssetTco(accountId, assetId, { today: opts.today });
  const vue = tcoUserView(avant.lines);
  const montrees = vue.lines;
  const line = montrees.find((l) => l.id === input.lineId) ?? (input.lineKey ? montrees.find((l) => l.decisionKey === input.lineKey) : undefined);
  if (!line) throw new TcoDecisionError('LINE_NOT_FOUND', 'Cette dépense a changé depuis l’affichage : la liste a été rechargée.', 409);
  const keys = tcoLineKeys(line);
  const toutes = [keys.primary, ...keys.secondary];
  const decision = line.userDecision;

  let geste: 'SET' | 'REVERT' | null = null;
  let avertissement: string | null = null;
  let lies: string[] = [];
  if (input.action === 'REVERT') {
    if (!decision?.applied && !decision?.contradicted) return { result: avant, outcome: 'UNCHANGED', line };
    geste = 'REVERT';
  } else if (input.action === 'EXCLUDE') {
    if (!RETENUE(line)) return { result: avant, outcome: 'UNCHANGED', line };
    if (!tcoLineRemovable(line)) throw new TcoDecisionError('NOT_REMOVABLE', 'Le prix de cession n’est pas une dépense : il ne peut pas être retiré.', 422);
    geste = decision?.applied && decision.decision === 'INCLUDE' ? 'REVERT' : 'SET';
  } else if (input.action === 'INCLUDE') {
    if (RETENUE(line)) return { result: avant, outcome: 'UNCHANGED', line };
    if (decision?.applied && decision.decision === 'EXCLUDE') geste = 'REVERT';
    else {
      const a = tcoLineAddable(line);
      if (!a.ok) throw new TcoDecisionError('NOT_ADDABLE', a.reason, 422, { blockedCode: a.code });
      avertissement = tcoAddDuplicateRisk(line, montrees);
      if (avertissement && !input.confirmDuplicate) {
        throw new TcoDecisionError('DUPLICATE_CONFIRMATION_REQUIRED', avertissement, 409, { duplicateWarning: avertissement });
      }
      geste = 'SET';
    }
  } else {
    // Lot 111V : arbitrage — seulement s'il figure parmi les gestes proposés pour cette ligne (motif réel, serveur).
    const proposes = tcoLineDecisionOptions(line, montrees).map((o) => o.action);
    if (!proposes.includes(input.action)) {
      if (decision?.applied && decision.decision === input.action && !decision.contradicted) return { result: avant, outcome: 'UNCHANGED', line };
      throw new TcoDecisionError('NOT_APPLICABLE', 'Ce choix ne s’applique pas à cette ligne : la liste a été rechargée.', 422, { options: proposes });
    }
    // Doublon : la ligne comptée à sa place (ou la ligne de même montant) est liée au choix (journal, BO).
    const autre = line.duplicateOf ? avant.lines.find((l) => l.id === line.duplicateOf) : undefined;
    if (autre?.decisionKey) lies = [autre.decisionKey];
    geste = 'SET';
  }

  const keysParam = pgArray(toutes);
  const automatique = { status: decision?.automaticStatus ?? line.status, reason: decision ? decision.automaticReason : line.reason };
  await db.transaction(async (tx) => {
    const r = tx as unknown as Runner;
    if (geste === 'REVERT') {
      await r.execute(sql`DELETE FROM asset_cost_line_decisions WHERE account_id = ${accountId} AND asset_id = ${assetId} AND line_key = ${decision!.key}`);
    } else {
      // Une seule décision par fait : les clés secondaires (justificatifs du même fait) sont remplacées.
      await r.execute(sql`DELETE FROM asset_cost_line_decisions WHERE account_id = ${accountId} AND asset_id = ${assetId}
                            AND line_key = ANY(${keysParam}::text[]) AND line_key <> ${keys.primary}`);
      const ok = arbitrage
        ? await rows(r, sql`
          INSERT INTO asset_cost_line_decisions (account_id, asset_id, line_key, decision, line_id, amount_minor, currency, label, file_id, decided_by, decided_at, updated_at,
                                                 related_line_keys, requalified_category, automatic_status, automatic_reason)
          SELECT a.account_id, a.id, ${keys.primary}, ${input.action}, ${line.id}, ${line.amountMinor}, ${line.currency.slice(0, 3)}, ${line.label.slice(0, 300)},
                 ${line.fileId}, ${userId}, now(), now(), ${pgArray(lies)}::text[], ${input.action === 'REQUALIFY' ? (input.category ?? null) : null},
                 ${automatique.status}, ${automatique.reason}
            FROM assets a WHERE a.id = ${assetId} AND a.account_id = ${accountId} AND a.deleted_at IS NULL
          ON CONFLICT (account_id, asset_id, line_key) DO UPDATE
            SET decision = EXCLUDED.decision, line_id = EXCLUDED.line_id, amount_minor = EXCLUDED.amount_minor, currency = EXCLUDED.currency,
                label = EXCLUDED.label, file_id = EXCLUDED.file_id, decided_by = EXCLUDED.decided_by, decided_at = now(), updated_at = now(),
                related_line_keys = EXCLUDED.related_line_keys, requalified_category = EXCLUDED.requalified_category,
                automatic_status = EXCLUDED.automatic_status, automatic_reason = EXCLUDED.automatic_reason
          RETURNING id`)
        : await rows(r, sql`
          INSERT INTO asset_cost_line_decisions (account_id, asset_id, line_key, decision, line_id, amount_minor, currency, label, file_id, decided_by, decided_at, updated_at)
          SELECT a.account_id, a.id, ${keys.primary}, ${input.action}, ${line.id}, ${line.amountMinor}, ${line.currency.slice(0, 3)}, ${line.label.slice(0, 300)},
                 ${line.fileId}, ${userId}, now(), now()
            FROM assets a WHERE a.id = ${assetId} AND a.account_id = ${accountId} AND a.deleted_at IS NULL
          ON CONFLICT (account_id, asset_id, line_key) DO UPDATE
            SET decision = EXCLUDED.decision, line_id = EXCLUDED.line_id, amount_minor = EXCLUDED.amount_minor, currency = EXCLUDED.currency,
                label = EXCLUDED.label, file_id = EXCLUDED.file_id, decided_by = EXCLUDED.decided_by, decided_at = now(), updated_at = now()
          RETURNING id`);
      if (!ok.length) throw new TcoDecisionError('LINE_NOT_FOUND', 'Bien introuvable.', 404);
    }
    const action = geste === 'REVERT' ? 'REVERT' : input.action;
    if (arbitrage) {
      await r.execute(sql`
        INSERT INTO asset_cost_line_decision_events
          (account_id, asset_id, line_key, action, previous_decision, line_id, amount_minor, currency, label, file_id,
           automatic_status, automatic_reason, duplicate_warning, user_id, related_line_keys, detail)
        VALUES (${accountId}, ${assetId}, ${geste === 'REVERT' ? decision!.key : keys.primary}, ${action},
                ${decision?.decision ?? null}, ${line.id}, ${line.amountMinor}, ${line.currency.slice(0, 3)}, ${line.label.slice(0, 300)}, ${line.fileId},
                ${automatique.status}, ${automatique.reason}, ${avertissement}, ${userId}, ${pgArray(lies)}::text[],
                ${JSON.stringify({ ...(input.category ? { category: input.category } : {}), ...(decision?.contradicted ? { reconfirmed: true } : {}) })}::jsonb)`);
    } else {
      await r.execute(sql`
        INSERT INTO asset_cost_line_decision_events
          (account_id, asset_id, line_key, action, previous_decision, line_id, amount_minor, currency, label, file_id,
           automatic_status, automatic_reason, duplicate_warning, user_id)
        VALUES (${accountId}, ${assetId}, ${geste === 'REVERT' ? decision!.key : keys.primary}, ${action},
                ${decision?.decision ?? null}, ${line.id}, ${line.amountMinor}, ${line.currency.slice(0, 3)}, ${line.label.slice(0, 300)}, ${line.fileId},
                ${automatique.status}, ${automatique.reason}, ${avertissement}, ${userId})`);
    }
  });
  const result = await readAssetTco(accountId, assetId, { today: opts.today });
  return { result, outcome: geste === 'REVERT' ? 'REVERTED' : 'SET', line: result.lines.find((l) => l.decisionKey === keys.primary) ?? null };
}
