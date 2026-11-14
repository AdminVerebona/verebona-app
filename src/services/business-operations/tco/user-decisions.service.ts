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
 *
 * Lot 113N — `CONFIRM_UNDATED` (« Conserver dans le TCO sans date ») et
 * `REVERT_UNDATED` (annulation) : décision sur la DATE, dans les colonnes
 * propres de la migration 1515 (`date_decision`, `date_decided_at`,
 * `date_decided_by`) de la MÊME ligne de table (même clé stable) — elle ne
 * touche jamais `decision` (INCLUDE / EXCLUDE / arbitrage), et réciproquement
 * un geste d'inclusion / exclusion ou son annulation ne supprime jamais une
 * confirmation « sans date » (la ligne de table n'est supprimée que lorsque
 * plus aucune des deux décisions n'y figure). Même journal.
 *
 * Carte #769 — FIABILITÉ DES DÉCISIONS
 *   · écart A : la confirmation « sans date » est enregistrée sous la clé du
 *     FAIT INDIVIDUEL (`factKey`, `./user-decisions`) : une confirmation, un
 *     fait ; son annulation ne touche que la confirmation de CETTE dépense ;
 *   · écart D : toute décision est validée contre l'état ACTUEL de la dépense.
 *     L'interface envoie la clé stable (`lineKey`) et la version des
 *     propriétés matérielles (`lineVersion`, `tcoLineVersion`) qu'elle
 *     affichait : clé qui ne désigne plus cette ligne, version différente,
 *     ligne introuvable, ou plusieurs lignes pour la clé → 409
 *     `DECISION_STALE`, AUCUNE écriture ni journal, TCO actuel rendu pour
 *     rafraîchir la vue. Une ligne re-clée par consolidation (justificatif
 *     repris par un événement de référence : clé secondaire, une seule ligne,
 *     même version) reste acceptée. Un geste sur la date sans clé ni version
 *     est refusé (jamais la seule égalité de `lineId`) ;
 *   · concurrence : chaque écriture prend un verrou consultatif par bien dans
 *     sa transaction et vérifie que le journal du bien n'a pas avancé depuis
 *     la validation ; sinon la validation est REJOUÉE sur l'état à jour (une
 *     requête identique répétée ou concurrente rend `UNCHANGED`, sans second
 *     journal).
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { readAssetTco } from './service';
import { tcoUserView } from './dto';
import type { TcoCategory, TcoEconomicLine, TcoResult } from './model';
import {
  TCO_ARBITRATION_DECISIONS, TCO_REQUALIFY_CATEGORIES, tcoAddDuplicateRisk, tcoLineAddable, tcoLineDecisionOptions, tcoLineKeys, tcoLineRemovable,
  type TcoDecisionSubmitAction, type TcoUserDecisionValue,
} from './user-decisions';

interface Runner { execute: (q: SQL) => Promise<unknown> }
const rows = async <T = Record<string, unknown>>(r: Runner, q: SQL): Promise<T[]> => (await r.execute(q)) as unknown as T[];

type TcoDecisionErrorCode = 'LINE_NOT_FOUND' | 'NOT_ADDABLE' | 'NOT_REMOVABLE' | 'DUPLICATE_CONFIRMATION_REQUIRED' | 'UNAVAILABLE' | 'NOT_APPLICABLE'
  // Carte #769 : la dépense a changé depuis l'affichage (aucune écriture).
  | 'DECISION_STALE';

/** Carte #769 : message du ticket, repris à l'identique. */
export const TCO_DECISION_STALE_MESSAGE = 'Cette dépense a changé, vérifiez ses nouvelles informations';

export class TcoDecisionError extends Error {
  constructor(
    public readonly code: TcoDecisionErrorCode, message: string, public readonly status: number, public readonly details: Record<string, unknown> = {},
    /** Carte #769 : TCO actuel (rafraîchissement immédiat de la vue après un refus). */
    public readonly fresh: TcoResult | null = null,
  ) {
    super(message);
    this.name = 'TcoDecisionError';
  }
}

/** Geste demandé : décision (lot 80A, arbitrages 111V), annulation explicite d'un arbitrage, ou décision sur la date (113N). */
type TcoDecisionAction = TcoDecisionSubmitAction;

const ACTIONS: ReadonlySet<string> = new Set(['INCLUDE', 'EXCLUDE', 'CONFIRM_EXCLUSION', 'SAME_FACT', 'DISTINCT_FACTS', 'REQUALIFY', 'REVERT', 'CONFIRM_UNDATED', 'REVERT_UNDATED']);
/** Lot 113N : gestes sur la DATE d'une dépense retenue (colonnes 1515). */
const DATE_ACTIONS: ReadonlySet<string> = new Set(['CONFIRM_UNDATED', 'REVERT_UNDATED']);

interface TcoDecisionInput {
  lineId: string;
  /** Clé stable connue de l'interface (repli si l'identifiant technique a changé entre l'affichage et le clic). */
  lineKey?: string | null;
  action: TcoDecisionAction;
  /** L'utilisateur a lu et accepté l'avertissement de doublon présumé. */
  confirmDuplicate?: boolean;
  /** Lot 111V : catégorie choisie (REQUALIFY). */
  category?: TcoCategory | null;
  /** Carte #769 : version des propriétés matérielles de la ligne affichée (`tcoLineVersion`). */
  lineVersion?: string | null;
}

type TcoDecisionOutcome = 'SET' | 'REVERTED' | 'UNCHANGED';

/** Corps de la requête → entrée validée (pure). */
export function parseTcoDecisionBody(body: unknown, categories: readonly string[] = TCO_REQUALIFY_CATEGORIES): { ok: true; value: TcoDecisionInput } | { ok: false; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: 'Corps attendu : un objet.' };
  const b = body as Record<string, unknown>;
  if (typeof b.lineId !== 'string' || !b.lineId.trim() || b.lineId.length > 200) return { ok: false, message: 'Ligne invalide.' };
  if (typeof b.action !== 'string' || !ACTIONS.has(b.action)) return { ok: false, message: 'Geste invalide.' };
  if (b.lineKey != null && (typeof b.lineKey !== 'string' || b.lineKey.length > 400)) return { ok: false, message: 'Clé de ligne invalide.' };
  if (b.lineVersion != null && (typeof b.lineVersion !== 'string' || b.lineVersion.length > 64)) return { ok: false, message: 'Version de ligne invalide.' };
  if (b.category != null && (typeof b.category !== 'string' || !categories.includes(b.category))) return { ok: false, message: 'Catégorie invalide.' };
  return {
    ok: true,
    value: {
      lineId: b.lineId.trim(), lineKey: (b.lineKey as string | null | undefined) ?? null, action: b.action as TcoDecisionAction, confirmDuplicate: b.confirmDuplicate === true,
      ...(b.category ? { category: b.category as TcoCategory } : {}),
      ...(typeof b.lineVersion === 'string' && b.lineVersion ? { lineVersion: b.lineVersion } : {}),
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

/** Lot 113N : colonnes de la décision sur la date présentes (migration 1515 appliquée). */
async function dateDecisionColumnsReady(): Promise<boolean> {
  const [c] = await rows<{ n: number }>(db, sql`
    SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_name = 'asset_cost_line_decisions' AND column_name IN ('date_decision', 'date_decided_at', 'date_decided_by')`);
  return Number(c?.n ?? 0) === 3;
}

/**
 * Lot 113N : retire la décision d'inclusion / exclusion / arbitrage des clés données SANS jamais supprimer une
 * confirmation « sans date » portée par la même ligne de table (la ligne est supprimée seulement si plus rien n'y
 * figure). Avant la migration 1515 : suppression simple (comportement antérieur).
 */
async function clearInclusionDecision(r: Runner, accountId: number, assetId: number, where: SQL, dateColumns: boolean): Promise<void> {
  if (!dateColumns) { await r.execute(sql`DELETE FROM asset_cost_line_decisions WHERE account_id = ${accountId} AND asset_id = ${assetId} AND ${where}`); return; }
  await r.execute(sql`DELETE FROM asset_cost_line_decisions WHERE account_id = ${accountId} AND asset_id = ${assetId} AND ${where} AND date_decision IS NULL`);
  await r.execute(sql`
    UPDATE asset_cost_line_decisions
       SET decision = NULL, related_line_keys = NULL, requalified_category = NULL, automatic_status = NULL, automatic_reason = NULL, updated_at = now()
     WHERE account_id = ${accountId} AND asset_id = ${assetId} AND ${where} AND date_decision IS NOT NULL`);
}

/** Lot 113N : idem pour la confirmation « sans date » (la décision d'inclusion de la même clé est conservée). */
async function clearDateDecision(r: Runner, accountId: number, assetId: number, where: SQL): Promise<void> {
  await r.execute(sql`DELETE FROM asset_cost_line_decisions WHERE account_id = ${accountId} AND asset_id = ${assetId} AND ${where} AND decision IS NULL`);
  await r.execute(sql`
    UPDATE asset_cost_line_decisions SET date_decision = NULL, date_decided_at = NULL, date_decided_by = NULL, updated_at = now()
     WHERE account_id = ${accountId} AND asset_id = ${assetId} AND ${where} AND date_decision IS NOT NULL`);
}

/** Carte #769 : une autre décision a été écrite sur le bien entre la validation et l'écriture — validation à rejouer. */
class ConcurrentDecision extends Error {}

/** Carte #769 : espace du verrou consultatif des décisions du TCO (second argument : le bien). */
const VERROU_DECISIONS_TCO = 769_001;
/** Carte #769 : nombre de validations rejouées avant de rendre la main (409, vue à rafraîchir). */
const ESSAIS_CONCURRENCE = 3;

/** Carte #769 : repère du journal (append-only) des décisions du bien — toute décision écrite le fait avancer. */
async function journalMark(r: Runner, accountId: number, assetId: number): Promise<string> {
  const [m] = await rows<{ n: string }>(r, sql`
    SELECT coalesce(max(id), 0)::text AS n FROM asset_cost_line_decision_events WHERE account_id = ${accountId} AND asset_id = ${assetId}`);
  return String(m?.n ?? '0');
}

/**
 * Carte #769 : à appeler en tête de la transaction d'écriture — sérialise les décisions du bien et refuse d'écrire
 * sur une validation dépassée (le journal a avancé : `ConcurrentDecision`, la transaction est annulée).
 */
async function lockDecisions(r: Runner, accountId: number, assetId: number, mark: string): Promise<void> {
  await r.execute(sql`SELECT pg_advisory_xact_lock(${VERROU_DECISIONS_TCO}::int, ${assetId}::int)`);
  if ((await journalMark(r, accountId, assetId)) !== mark) throw new ConcurrentDecision();
}

/**
 * Carte #769 (écart D) — ligne ACTUELLE visée par le geste (pure). L'identifiant technique ne suffit jamais :
 *   · ligne trouvée par son identifiant : la clé fournie doit encore la désigner (clé de fait, clé stable ou clé
 *     secondaire — justificatif du même fait), et la version fournie doit être la sienne ;
 *   · identifiant disparu (ligne remplacée) : la clé fournie doit désigner UNE SEULE ligne (clé de fait, sinon clé
 *     stable, sinon clé secondaire : re-clé prouvée par consolidation), de même version.
 */
export function resolveTcoDecisionLine(
  lines: readonly TcoEconomicLine[], input: Pick<TcoDecisionInput, 'lineId' | 'lineKey' | 'lineVersion'>,
): { ok: true; line: TcoEconomicLine } | { ok: false; reason: 'NOT_FOUND' | 'STALE' } {
  const cle = input.lineKey ?? null;
  const version = input.lineVersion ?? null;
  const memeVersion = (l: TcoEconomicLine) => !version || !l.version || l.version === version;
  const parId = lines.find((l) => l.id === input.lineId);
  if (parId) {
    const k = tcoLineKeys(parId);
    if (cle && cle !== parId.factKey && cle !== k.primary && !k.secondary.includes(cle)) return { ok: false, reason: 'STALE' };
    return memeVersion(parId) ? { ok: true, line: parId } : { ok: false, reason: 'STALE' };
  }
  if (!cle) return { ok: false, reason: version ? 'STALE' : 'NOT_FOUND' };
  let candidates = lines.filter((l) => l.factKey === cle);
  if (!candidates.length) candidates = lines.filter((l) => tcoLineKeys(l).primary === cle);
  if (!candidates.length) candidates = lines.filter((l) => tcoLineKeys(l).secondary.includes(cle));
  if (candidates.length !== 1 || !memeVersion(candidates[0])) return { ok: false, reason: 'STALE' };
  return { ok: true, line: candidates[0] };
}

/** Enregistre (ou annule) une décision et rend le TCO recalculé. */
export async function decideTcoLine(
  accountId: number, assetId: number, userId: number | null, input: TcoDecisionInput, opts: { today?: string } = {},
): Promise<{ result: TcoResult; outcome: TcoDecisionOutcome; line: TcoEconomicLine | null }> {
  for (let essai = 0; essai < ESSAIS_CONCURRENCE; essai++) {
    try {
      return await decideTcoLineOnce(accountId, assetId, userId, input, opts);
    } catch (e) {
      if (!(e instanceof ConcurrentDecision)) throw e;
    }
  }
  // Décisions concurrentes en rafale sur le même bien : aucune écriture de cette requête, vue à rafraîchir.
  throw new TcoDecisionError('DECISION_STALE', TCO_DECISION_STALE_MESSAGE, 409, {}, await readAssetTco(accountId, assetId, { today: opts.today }));
}

/** Une tentative : validation sur l'état lu, écriture seulement si aucune autre décision n'a été écrite entre-temps. */
async function decideTcoLineOnce(
  accountId: number, assetId: number, userId: number | null, input: TcoDecisionInput, opts: { today?: string },
): Promise<{ result: TcoResult; outcome: TcoDecisionOutcome; line: TcoEconomicLine | null }> {
  const [t] = await rows<{ ok: boolean }>(db, sql`SELECT to_regclass('asset_cost_line_decisions') IS NOT NULL AND to_regclass('asset_cost_line_decision_events') IS NOT NULL AS ok`);
  if (!t?.ok) throw new TcoDecisionError('UNAVAILABLE', 'Cette fonction sera disponible après la mise à jour en cours. Réessayez dans quelques minutes.', 503);
  const arbitrage = TCO_ARBITRATION_DECISIONS.has(input.action as TcoUserDecisionValue) || input.action === 'REVERT';
  if (arbitrage && !(await arbitrationColumnsReady())) {
    throw new TcoDecisionError('UNAVAILABLE', 'Cette fonction sera disponible après la mise à jour en cours. Réessayez dans quelques minutes.', 503);
  }
  const colonnesDate = await dateDecisionColumnsReady();
  if (DATE_ACTIONS.has(input.action) && (!colonnesDate || !(await arbitrationColumnsReady()))) {
    throw new TcoDecisionError('UNAVAILABLE', 'Cette fonction sera disponible après la mise à jour en cours. Réessayez dans quelques minutes.', 503);
  }
  // Carte #769 : repère du journal lu AVANT la validation (vérifié sous verrou au moment d'écrire).
  const mark = await journalMark(db, accountId, assetId);
  const avant = await readAssetTco(accountId, assetId, { today: opts.today });
  const vue = tcoUserView(avant.lines);
  const montrees = vue.lines;
  const perimee = () => new TcoDecisionError('DECISION_STALE', TCO_DECISION_STALE_MESSAGE, 409, {}, avant);
  // Carte #769 : un geste sur la date exige l'identité affichée (clé ou version), jamais le seul identifiant technique.
  if (DATE_ACTIONS.has(input.action) && !input.lineKey && !input.lineVersion) throw perimee();
  const visee = resolveTcoDecisionLine(montrees, input);
  if (!visee.ok) {
    if (visee.reason === 'STALE') throw perimee();
    throw new TcoDecisionError('LINE_NOT_FOUND', 'Cette dépense a changé depuis l’affichage : la liste a été rechargée.', 409, {}, avant);
  }
  const line = visee.line;
  const keys = tcoLineKeys(line);
  const toutes = [keys.primary, ...keys.secondary];
  const decision = line.userDecision;
  if (DATE_ACTIONS.has(input.action)) return decideUndated(accountId, assetId, userId, input, { avant, line, montrees, keys, today: opts.today, mark });

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
    await lockDecisions(r, accountId, assetId, mark);
    if (geste === 'REVERT') {
      // Lot 113N : une confirmation « sans date » de la même clé est conservée.
      await clearInclusionDecision(r, accountId, assetId, sql`line_key = ${decision!.key}`, colonnesDate);
    } else {
      // Une seule décision par fait : les clés secondaires (justificatifs du même fait) sont remplacées.
      await clearInclusionDecision(r, accountId, assetId, sql`line_key = ANY(${keysParam}::text[]) AND line_key <> ${keys.primary}`, colonnesDate);
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

/**
 * Lot 113N — « Conserver dans le TCO sans date » / « Annuler mon choix » sur une dépense RETENUE dont la date
 * économique n'est pas établie. Le geste doit figurer parmi ceux que le serveur propose pour CETTE ligne. Aucune
 * écriture de montant, de date ni de décision d'inclusion : seules les colonnes `date_*` (1515) de la clé stable
 * de la ligne changent ; journal `asset_cost_line_decision_events` (CONFIRM_UNDATED / REVERT_UNDATED).
 */
async function decideUndated(
  accountId: number, assetId: number, userId: number | null, input: TcoDecisionInput,
  ctx: { avant: TcoResult; line: TcoEconomicLine; montrees: readonly TcoEconomicLine[]; keys: { primary: string; secondary: string[] }; today?: string; mark: string },
): Promise<{ result: TcoResult; outcome: TcoDecisionOutcome; line: TcoEconomicLine | null }> {
  const { avant, line, montrees, keys } = ctx;
  const confirmee = line.undatedConfirmation;
  if (input.action === 'CONFIRM_UNDATED' && confirmee) return { result: avant, outcome: 'UNCHANGED', line };
  if (input.action === 'REVERT_UNDATED' && !confirmee) return { result: avant, outcome: 'UNCHANGED', line };
  const proposes = tcoLineDecisionOptions(line, montrees).map((o) => o.action);
  if (!proposes.includes(input.action)) {
    throw new TcoDecisionError('NOT_APPLICABLE', 'Ce choix ne s’applique pas à cette ligne : la liste a été rechargée.', 422, { options: proposes }, avant);
  }
  // Carte #769 (écart A) : la confirmation est portée par la clé du FAIT INDIVIDUEL ; l'annulation ne retire que la
  // confirmation effectivement appliquée à CETTE dépense.
  const cle = input.action === 'REVERT_UNDATED' ? confirmee!.key : (line.factKey ?? keys.primary);
  // Clés du même fait (justificatifs réunis, ancienne clé commune) dont la confirmation est remplacée — jamais une clé
  // qui porte la confirmation ou l'identité d'une AUTRE dépense retenue.
  const autres = avant.lines.filter((l) => l.id !== line.id && RETENUE(l));
  const prises = new Set(autres.flatMap((l) => [l.undatedConfirmation?.key, l.factKey]).filter((k): k is string => !!k));
  const remplacables = [keys.primary, ...keys.secondary].filter((k) => k !== cle && !prises.has(k));
  await db.transaction(async (tx) => {
    const r = tx as unknown as Runner;
    await lockDecisions(r, accountId, assetId, ctx.mark);
    let remplacees: string[] = [];
    if (input.action === 'REVERT_UNDATED') await clearDateDecision(r, accountId, assetId, sql`line_key = ${cle}`);
    else {
      if (remplacables.length) {
        const param = pgArray(remplacables);
        remplacees = (await rows<{ line_key: string }>(r, sql`
          SELECT line_key FROM asset_cost_line_decisions
           WHERE account_id = ${accountId} AND asset_id = ${assetId} AND line_key = ANY(${param}::text[]) AND date_decision IS NOT NULL
           ORDER BY line_key`)).map((x) => String(x.line_key));
        // Une seule confirmation par fait : celles des autres clés du MÊME fait sont remplacées (journal conservé).
        if (remplacees.length) await clearDateDecision(r, accountId, assetId, sql`line_key = ANY(${param}::text[])`);
      }
      const ok = await rows(r, sql`
        INSERT INTO asset_cost_line_decisions (account_id, asset_id, line_key, decision, line_id, amount_minor, currency, label, file_id, decided_by, decided_at, updated_at,
                                               date_decision, date_decided_at, date_decided_by)
        SELECT a.account_id, a.id, ${cle}, NULL, ${line.id}, ${line.amountMinor}, ${line.currency.slice(0, 3)}, ${line.label.slice(0, 300)},
               ${line.fileId}, NULL, now(), now(), 'CONFIRM_UNDATED', now(), ${userId}
          FROM assets a WHERE a.id = ${assetId} AND a.account_id = ${accountId} AND a.deleted_at IS NULL
        ON CONFLICT (account_id, asset_id, line_key) DO UPDATE
          SET date_decision = 'CONFIRM_UNDATED', date_decided_at = now(), date_decided_by = EXCLUDED.date_decided_by, updated_at = now()
        RETURNING id`);
      if (!ok.length) throw new TcoDecisionError('LINE_NOT_FOUND', 'Bien introuvable.', 404);
    }
    await r.execute(sql`
      INSERT INTO asset_cost_line_decision_events
        (account_id, asset_id, line_key, action, previous_decision, line_id, amount_minor, currency, label, file_id,
         automatic_status, automatic_reason, duplicate_warning, user_id, related_line_keys, detail)
      VALUES (${accountId}, ${assetId}, ${cle}, ${input.action}, ${input.action === 'REVERT_UNDATED' ? 'CONFIRM_UNDATED' : null},
              ${line.id}, ${line.amountMinor}, ${line.currency.slice(0, 3)}, ${line.label.slice(0, 300)}, ${line.fileId},
              ${line.status}, ${line.reason}, NULL, ${userId}, '{}'::text[],
              ${JSON.stringify({
                scope: 'ECONOMIC_DATE', includedCents: line.includedCents,
                ...(line.userDecision?.applied ? { inclusionDecision: line.userDecision.decision } : {}),
                // Carte #769 : identité du fait décidé (clé stable, version, période) et clés remplacées.
                stableKey: keys.primary, ...(line.version ? { version: line.version } : {}), ...(line.period ? { period: line.period } : {}),
                ...(remplacees.length ? { supersededKeys: remplacees } : {}),
              })}::jsonb)`);
  });
  const result = await readAssetTco(accountId, assetId, { today: ctx.today });
  return {
    result, outcome: input.action === 'REVERT_UNDATED' ? 'REVERTED' : 'SET',
    line: result.lines.find((l) => l.id === line.id && l.factKey === line.factKey) ?? result.lines.find((l) => l.factKey === cle) ?? result.lines.find((l) => l.decisionKey === keys.primary) ?? null,
  };
}
