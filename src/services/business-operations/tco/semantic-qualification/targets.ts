/**
 * Lot 113AL (Trello #737) — MONTANTS À ARBITRER d'un bien et EMPREINTE du
 * contexte pertinent (lecture seule ; mêmes règles pour le contrôle
 * COH-TCO-EXTRACTED-EXPENSES, qui pose les demandes, et pour la phase du
 * passage T3, qui les traite).
 *
 * Un montant est à arbitrer quand le moteur TCO (`readAssetTco`, aucun second
 * moteur) le connaît sans lui avoir donné de nature :
 *   · LINE — ligne `NOT_QUALIFIED / THEME_UNKNOWN` de montant connu, sans
 *     décision appliquée de l'utilisateur (qui prime : jamais soumise à l'IA) ;
 *   · EXTRACT — document du bien sans AUCUNE ligne dont l'extract porte un
 *     montant (repérage déterministe `significantValues`, celui de la chaîne
 *     C-Q7) ; les documents que la barrière du moteur déclare non financiers
 *     en sont exclus (leur exclusion est motivée par le moteur).
 * Aucun `document_operation_candidate` ni `financialHint` n'est exigé.
 *
 * L'empreinte réunit ce qui rend un examen caduc : montants du document,
 * version de son analyse (dernière extraction, type, montant et champs
 * corrigés), faits déjà comptés du bien. Un contexte inchangé n'est jamais
 * renvoyé à l'IA ; un contexte changé est un réexamen motivé.
 */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { TcoEconomicLine, TcoResult } from '../model';
import { ECONOMIC_QUALIFICATION_CONTRACT_VERSION, type RawCountedFact, type RawQualificationAmount } from './contract';

type Sql = postgres.Sql | postgres.TransactionSql;
type Row = Record<string, unknown>;
const q = async (sql: Sql, text: string, params: unknown[]): Promise<Row[]> => (await sql.unsafe(text, params as never[])) as unknown as Row[];
const intArray = (v: readonly number[]) => `{${[...new Set(v)].filter((x) => Number.isSafeInteger(x)).join(',')}}`;

const RETENUE = (s: TcoEconomicLine['status']) => s === 'RETAINED_DIRECT' || s === 'RETAINED_CONSOLIDATED';
/** Montants repérés au plus par document sans ligne (au-delà : examen suivant). */
const EXTRACT_AMOUNTS_MAX = 10;

/** Devise du montant repéré (symbole ou code écrit) ; euro présumé sinon (règle T2). */
function deviseDe(raw: string): string {
  if (/\$|USD/i.test(raw)) return 'USD';
  if (/£|GBP/i.test(raw)) return 'GBP';
  if (/CHF/i.test(raw)) return 'CHF';
  return 'EUR';
}

/**
 * Documents du bien (mêmes rattachements que le TCO) SANS aucune ligne économique, dont l'extract porte au moins un
 * montant (lecture seule) — montant mineur, devise, passage qui le porte.
 */
export async function silentAmountSources(sql: Sql, accountId: number, assetId: number, withLine: ReadonlySet<number>):
  Promise<Array<{ fileId: number; amounts: Array<{ amountMinor: number; currency: string; quote: string }> }>> {
  const [{ ASSET_LIST_LINK_ROLES_SQL }, { NON_EXPENSE_DOCUMENT_TYPES }, { significantValues }] = await Promise.all([
    import('@/services/documents/asset-document-scope'), import('@/services/business-operations/finance/economic-lines'),
    import('@/services/ai/source-analysis/source-units/text'),
  ]);
  const docs = (await q(sql, `
    SELECT f.id, f.document_type_code FROM asset_files f
     WHERE f.account_id = $1 AND f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL
       AND (f.asset_id = $2 OR f.linked_asset_id = $2
            OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = f.account_id AND l.file_id = f.id AND l.status = 'ACTIVE'
                         AND l.link_role IN ${ASSET_LIST_LINK_ROLES_SQL} AND l.asset_id = $2))
     ORDER BY f.id`, [accountId, assetId]))
    .filter((d) => !withLine.has(Number(d.id)) && !(d.document_type_code && NON_EXPENSE_DOCUMENT_TYPES.has(String(d.document_type_code))));
  if (!docs.length) return [];
  const montants = new Map<number, Map<string, { amountMinor: number; currency: string; quote: string }>>();
  for (const u of await q(sql, `
    SELECT u.file_id, u.content_text, u.label, u.value_text FROM document_source_units u
     WHERE u.account_id = $1 AND u.file_id = ANY($2::int[]) AND u.kind IN ('TEXT_BLOCK', 'LABEL_VALUE', 'FORM_FIELD', 'TABLE_ROW')
     ORDER BY u.file_id, u.ordinal`, [accountId, intArray(docs.map((d) => Number(d.id)))])) {
    const texte = (u.content_text as string | null) ?? (u.label || u.value_text ? `${u.label ?? ''} : ${u.value_text ?? ''}` : null);
    for (const v of significantValues(texte)) {
      if (v.kind !== 'AMOUNT') continue;
      const n = Number(v.normalized);
      if (!Number.isSafeInteger(n) || n <= 0) continue;
      const m = montants.get(Number(u.file_id)) ?? new Map();
      const currency = deviseDe(v.raw);
      const k = `${n}|${currency}`;
      if (!m.has(k)) m.set(k, { amountMinor: n, currency, quote: String(texte ?? '').replace(/\s+/g, ' ').trim().slice(0, 400) });
      montants.set(Number(u.file_id), m);
    }
  }
  return [...montants].map(([fileId, m]) => ({ fileId, amounts: [...m.values()].sort((a, b) => a.amountMinor - b.amountMinor).slice(0, EXTRACT_AMOUNTS_MAX) }))
    .sort((a, b) => a.fileId - b.fileId);
}

/** La ligne attend-elle un arbitrage ? (montant connu, nature non établie, aucune décision appliquée de l'utilisateur). */
export function lineAwaitsQualification(l: TcoEconomicLine): boolean {
  return l.source === 'DOCUMENT' && l.fileId != null && l.status === 'NOT_QUALIFIED' && l.reason === 'THEME_UNKNOWN'
    && !l.amountUnknown && l.amountMinor > 0 && !l.userDecision?.applied;
}

/** Faits déjà COMPTÉS du bien (lignes retenues du moteur) — cibles possibles d'une représentation. */
export function countedFactsOf(tco: Pick<TcoResult, 'lines'>, keyOf: (l: TcoEconomicLine) => string): RawCountedFact[] {
  return tco.lines.filter((l) => RETENUE(l.status) && l.amountMinor > 0).map((l) => ({
    key: keyOf(l), lineId: l.id, source: l.source, label: l.label, kind: l.kind, amountMinor: l.amountMinor, currency: String(l.currency || 'EUR').toUpperCase(),
    date: l.date, fileId: l.fileId, operationId: l.operationId,
  }));
}

export interface QualificationTarget { fileId: number; amounts: RawQualificationAmount[] }

/** Montants à arbitrer du bien, par document (pure, ordre stable). */
export function qualificationTargets(tco: Pick<TcoResult, 'lines'>, silent: ReadonlyArray<{ fileId: number; amounts: ReadonlyArray<{ amountMinor: number; currency: string; quote: string }> }>): QualificationTarget[] {
  const out = new Map<number, RawQualificationAmount[]>();
  for (const l of tco.lines) {
    if (!lineAwaitsQualification(l)) continue;
    // Une ligne issue d'un montant de l'extract (abstention précédente) reste un montant EXTRACT : même empreinte.
    const origin = /:t3:\d+$/.test(l.id) ? 'EXTRACT' as const : 'LINE' as const;
    out.set(l.fileId!, [...(out.get(l.fileId!) ?? []), { fileId: l.fileId!, amountMinor: l.amountMinor, currency: String(l.currency || 'EUR').toUpperCase(), origin, lineId: origin === 'LINE' ? l.id : null, quote: null }]);
  }
  for (const s of silent) {
    if (out.has(s.fileId)) continue;
    out.set(s.fileId, s.amounts.map((a) => ({ fileId: s.fileId, amountMinor: a.amountMinor, currency: a.currency, origin: 'EXTRACT' as const, lineId: null, quote: a.quote })));
  }
  return [...out].map(([fileId, amounts]) => ({ fileId, amounts })).sort((a, b) => a.fileId - b.fileId);
}

/** Version de l'analyse d'un document (dernière extraction, type, montant, champs corrigés) — lecture seule, par lot. */
export async function documentVersions(sql: Sql, accountId: number, fileIds: readonly number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!fileIds.length) return out;
  for (const r of await q(sql, `
    SELECT f.id, concat_ws('|', (SELECT max(x.id) FROM document_extractions x WHERE x.file_id = f.id AND x.account_id = f.account_id),
                           f.document_type_code, f.amount_cents, md5(COALESCE(f.user_edited_fields::text, ''))) AS v
      FROM asset_files f WHERE f.account_id = $1 AND f.id = ANY($2::int[])`, [accountId, intArray(fileIds)])) out.set(Number(r.id), String(r.v ?? ''));
  return out;
}

/** Empreinte STABLE du contexte pertinent d'un document (pure). */
export function qualificationFingerprint(x: { fileId: number; docVersion: string | null; amounts: ReadonlyArray<{ amountMinor: number; currency: string }>; counted: ReadonlyArray<{ key: string; amountMinor: number }> }): string {
  const stable = {
    c: ECONOMIC_QUALIFICATION_CONTRACT_VERSION, f: x.fileId, v: x.docVersion ?? '',
    a: x.amounts.map((a) => `${a.amountMinor}|${String(a.currency || 'EUR').toUpperCase()}`).sort(),
    k: x.counted.map((k) => `${k.key}|${k.amountMinor}`).sort(),
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 32);
}
