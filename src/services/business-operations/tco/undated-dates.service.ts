/**
 * Lot 113X (#722) — « Renseigner les dates » : écriture de la date effective
 * des dépenses retenues sans date fiable, DANS LEUR CHAMP MÉTIER CANONIQUE,
 * par les primitives existantes (jamais une date propre au TCO, jamais un
 * second calcul) :
 *   · date d'achat de la fiche du bien → `updateAssetDetails` (écriture de la
 *     fiche : origine USER, journal `canonical_field_writes`, consolidation de
 *     la donnée structurée, cartes « À traiter » de ce champ) ;
 *   · date d'achat de la fiche d'un équipement → `writeCanonicalEntityField`
 *     (origine USER, journal) ;
 *   · date du justificatif qui établit seul le montant → `asset_files.document_date`
 *     marquée correction utilisateur (`userEditedFields.documentDate`, respectée
 *     par toute analyse ultérieure, lot 103F), SEULEMENT si elle est encore
 *     vide (jamais une preuve écrasée), journal d'audit, règles « À traiter »
 *     du document resynchronisées, événement DOCUMENT_UPDATED.
 * La cible est recalculée côté serveur à partir de la trace du moteur
 * (`tcoUndatedExpenses`) : aucune cible ni aucun montant cru sur parole ; une
 * ligne qui n'est plus sans date (ou qui n'existe plus) est refusée.
 * Le TCO est ensuite relu par le MÊME moteur (`readAssetTco`) : ventilation,
 * compteurs, montant non daté et diagnostics à jour, coût total inchangé.
 * Droits : contrôlés par la route (Premium / Premium Duo / essai, écriture
 * autorisée, bien modifiable du compte de la session).
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { readAssetTco } from './service';
import type { TcoResult } from './model';
import { tcoUserView } from './dto';
import { checkTcoExpenseDate, tcoUndatedExpenses, type TcoDateEntryInput, type TcoUndatedExpense } from './undated-expenses';

interface Runner { execute: (q: SQL) => Promise<unknown> }
const rows = async <T = Record<string, unknown>>(r: Runner, q: SQL): Promise<T[]> => (await r.execute(q)) as unknown as T[];

/** Issue d'une saisie (code stable, message utilisateur). */
export type TcoDateEntryOutcome =
  | 'SAVED' | 'SAVED_STILL_UNDATED' | 'UNCHANGED'
  | 'INVALID_DATE' | 'FUTURE_DATE' | 'TOO_OLD' | 'NEEDS_CONFIRMATION'
  | 'NOT_UNDATED' | 'NOT_EDITABLE' | 'CONFLICT' | 'ERROR';

export interface TcoDateEntryResult {
  lineId: string;
  outcome: TcoDateEntryOutcome;
  message: string | null;
}

const MESSAGES: Partial<Record<TcoDateEntryOutcome, string>> = {
  NOT_UNDATED: 'Cette dépense a déjà une date ou n’est plus comptée : la liste a été actualisée.',
  NOT_EDITABLE: 'Cette date ne se saisit pas ici : corrigez-la sur le justificatif ou sur l’événement de référence.',
  CONFLICT: 'Cette date a été renseignée entre-temps : la liste a été actualisée.',
  ERROR: 'La date n’a pas pu être enregistrée. Réessayez.',
  SAVED_STILL_UNDATED: 'La date est enregistrée, mais elle ne suffit pas à dater cette dépense (voir son justificatif).',
};

/** Source journalisée des écritures (champ `source.type` du journal canonique). */
const SOURCE_TYPE = 'tco_undated_dates';

function trouve(items: readonly TcoUndatedExpense[], e: TcoDateEntryInput): TcoUndatedExpense | undefined {
  return items.find((i) => i.lineId === e.lineId) ?? (e.lineKey ? items.find((i) => i.lineKey === e.lineKey) : undefined);
}

async function ecrireDocument(accountId: number, userId: number | null, fileId: number, date: string): Promise<'SAVED' | 'UNCHANGED' | 'CONFLICT'> {
  const [f] = await rows<{ document_date: string | null }>(db, sql`
    SELECT document_date::text AS document_date FROM asset_files WHERE id = ${fileId} AND account_id = ${accountId} AND deleted_at IS NULL`);
  if (!f) return 'CONFLICT';
  if (f.document_date === date) return 'UNCHANGED';
  // Jamais une preuve écrasée : seulement une date de justificatif encore vide.
  const ecrit = await rows(db, sql`
    UPDATE asset_files
       SET document_date = ${date}::date,
           user_edited_fields = COALESCE(user_edited_fields, '{}'::jsonb) || '{"documentDate": true}'::jsonb,
           updated_at = now()
     WHERE id = ${fileId} AND account_id = ${accountId} AND deleted_at IS NULL AND document_date IS NULL
     RETURNING id`);
  if (!ecrit.length) return 'CONFLICT';
  try {
    const { adminAuditLog } = await import('@/db/schema');
    await db.insert(adminAuditLog).values({
      timestamp: new Date(), adminUserId: userId ?? null, adminEmail: 'user', actionType: 'ASSET_UPDATE', targetType: 'document', targetId: fileId,
      details: `Date du document: "non définie" → "${date}" (coût de possession : date effective de la dépense)`,
    });
  } catch (e) {
    console.warn('[tco] journal d’audit de la date du document :', (e as Error).message);
  }
  try {
    const { onDocumentEditedByUser } = await import('@/services/to-process/document-rule-bridge');
    await onDocumentEditedByUser(accountId, fileId);
  } catch (e) {
    console.warn('[tco] règles « À traiter » du document après saisie de la date :', (e as Error).message);
  }
  try {
    const { emitBusinessEvent } = await import('@/services/verebona-assistant/events/business-events');
    await emitBusinessEvent({ type: 'DOCUMENT_UPDATED', accountId, entityId: fileId });
  } catch { /* caches de l'assistant : sans effet sur l'écriture */ }
  return 'SAVED';
}

async function ecrireFicheBien(accountId: number, assetId: number, userId: number | null, lineId: string, date: string): Promise<'SAVED' | 'ERROR'> {
  const { updateAssetDetails } = await import('@/services/asset-details-write.service');
  await updateAssetDetails({
    assetId, accountId, section: 'common', fields: { acquisitionDate: date }, actorUserId: userId, source: { type: SOURCE_TYPE, id: lineId },
  });
  return 'SAVED';
}

async function ecrireEquipement(accountId: number, assetId: number, userId: number | null, equipmentId: number, lineId: string, date: string): Promise<'SAVED' | 'UNCHANGED' | 'CONFLICT'> {
  // Équipement de CE bien et de ce compte (la cible vient de la trace du moteur ; vérifiée de nouveau sous la session).
  const [e] = await rows(db, sql`
    SELECT e.id FROM equipments e JOIN assets a ON a.id = e.asset_id
     WHERE e.id = ${equipmentId} AND e.asset_id = ${assetId} AND a.account_id = ${accountId} AND a.deleted_at IS NULL AND e.archived_at IS NULL`);
  if (!e) return 'CONFLICT';
  const { writeCanonicalEntityField } = await import('@/services/canonical/entity-state');
  const r = await writeCanonicalEntityField({
    target: { type: 'EQUIPMENT', id: equipmentId }, accountId, key: 'acquisitionDate', value: date, origin: 'USER',
    actorUserId: userId, source: { type: SOURCE_TYPE, id: lineId },
  });
  if (r.notFound || r.skipped) return 'CONFLICT';
  return r.field?.outcome === 'written' ? 'SAVED' : 'UNCHANGED';
}

/**
 * Enregistre les dates saisies (une ou plusieurs ; chaque saisie est indépendante : un refus n'annule pas les
 * autres). Rend l'issue de chaque saisie et le TCO recalculé.
 */
export async function saveTcoUndatedDates(
  accountId: number, assetId: number, userId: number | null, entries: readonly TcoDateEntryInput[], opts: { today?: string } = {},
): Promise<{ results: TcoDateEntryResult[]; result: TcoResult }> {
  const avant = await readAssetTco(accountId, assetId, opts.today ? { today: opts.today } : {});
  const vue = tcoUserView(avant.lines).lines;
  const liste = tcoUndatedExpenses({ lines: vue }, vue).items;
  const today = opts.today ?? avant.annual.referenceDate;
  const debut = avant.period.start;
  const cession = avant.disposed && avant.period.endSource !== 'TODAY' ? avant.period.end : null;
  const results: TcoDateEntryResult[] = [];
  const ecrits = new Map<string, string>();
  for (const e of entries) {
    const item = trouve(liste, e);
    if (!item) { results.push({ lineId: e.lineId, outcome: 'NOT_UNDATED', message: MESSAGES.NOT_UNDATED! }); continue; }
    if (item.target.kind === 'NONE') { results.push({ lineId: e.lineId, outcome: 'NOT_EDITABLE', message: MESSAGES.NOT_EDITABLE! }); continue; }
    const c = checkTcoExpenseDate(e.date, { today, possessionStart: debut, disposalDate: cession, target: item.target.kind, confirmed: e.confirm });
    if (!c.ok) { results.push({ lineId: e.lineId, outcome: c.code, message: c.message }); continue; }
    // Deux saisies vers le même champ (ex. date d'achat de la fiche) : la première fait foi, une autre valeur est refusée.
    const cible = item.target.kind === 'ASSET_FIELD' ? 'asset' : item.target.kind === 'EQUIPMENT_FIELD' ? `eq:${item.target.equipmentId}` : `doc:${item.target.fileId}`;
    const deja = ecrits.get(cible);
    if (deja !== undefined) {
      results.push(deja === c.date ? { lineId: e.lineId, outcome: 'UNCHANGED', message: null }
        : { lineId: e.lineId, outcome: 'CONFLICT', message: 'Une autre date vient d’être enregistrée pour ce même champ : vérifiez la saisie.' });
      continue;
    }
    try {
      const t = item.target;
      const issue = t.kind === 'ASSET_FIELD' ? await ecrireFicheBien(accountId, assetId, userId, item.lineId, c.date)
        : t.kind === 'EQUIPMENT_FIELD' ? await ecrireEquipement(accountId, assetId, userId, t.equipmentId, item.lineId, c.date)
          : await ecrireDocument(accountId, userId, t.fileId, c.date);
      ecrits.set(cible, c.date);
      results.push({ lineId: e.lineId, outcome: issue, message: MESSAGES[issue] ?? null });
    } catch (err) {
      const m = (err as { name?: string; message?: string });
      // Refus métier de la fiche (date invalide pour ce champ, bien archivé ou verrouillé) : message de la règle existante.
      const message = m.name === 'AssetDetailsError' && m.message ? m.message : MESSAGES.ERROR!;
      if (m.name !== 'AssetDetailsError') console.error('[tco] saisie de date :', m.message);
      results.push({ lineId: e.lineId, outcome: 'ERROR', message });
    }
  }
  const result = await readAssetTco(accountId, assetId, opts.today ? { today: opts.today } : {});
  // Date enregistrée mais dépense toujours sans année (la date saisie ne suffit pas à l'établir) : dit, jamais masqué.
  const encore = new Set(tcoUndatedExpenses(result).items.map((i) => i.lineId));
  for (const r of results) {
    if (r.outcome === 'SAVED' && encore.has(r.lineId)) { r.outcome = 'SAVED_STILL_UNDATED'; r.message = MESSAGES.SAVED_STILL_UNDATED!; }
  }
  return { results, result };
}

/**
 * Événements de référence ouvrables (élément d'agenda principal de chaque Opération) des dépenses listées —
 * compte de la session seulement.
 */
export async function readTcoUndatedReferences(accountId: number, operationIds: readonly number[]): Promise<Map<number, number>> {
  const ids = [...new Set(operationIds.filter((x) => Number.isSafeInteger(x) && x > 0))];
  if (!ids.length) return new Map();
  const r = await rows<{ id: number; business_operation_id: number }>(db, sql`
    SELECT id, business_operation_id FROM agenda_items
     WHERE account_id = ${accountId} AND business_operation_id = ANY(${`{${ids.join(',')}}`}::bigint[])
     ORDER BY id`);
  const out = new Map<number, number>();
  for (const x of r) if (!out.has(Number(x.business_operation_id))) out.set(Number(x.business_operation_id), Number(x.id));
  return out;
}
