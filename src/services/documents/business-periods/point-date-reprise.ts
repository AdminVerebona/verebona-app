/**
 * Carte #812 (lot 116F, reprise après la recette KO du 21/11/2026) — REPRISE IMMÉDIATE du stock des
 * périodes de validité qui ne sont que la date du document, pour l'exploitant
 * (`scripts/reprise-812-validites-artificielles.ts`).
 *
 * Pourquoi : le contrôle de cohérence `COH-DOC-BUSINESS-PERIODS` (version 2) retire ces périodes, mais une
 * version nouvelle d'un contrôle ne corrige qu'APRÈS une campagne quotidienne à blanc allée à son terme
 * (règle A6 du moteur, lot 100E) : au mieux le surlendemain du déploiement. La lecture ne les restitue plus
 * dès le déploiement (`service#pointDateCopyIds`) ; cette reprise retire en plus les lignes du stock, sans
 * attendre aucune campagne.
 *
 * Ce module ne porte AUCUNE règle : il passe par le MÊME service que le contrôle de cohérence —
 * `previewDocumentBusinessPeriods` (inspection, lecture seule) puis `refreshDocumentBusinessPeriods`
 * (réparation) — donc la même règle (`./point-date`), le même retrait (statut SUPERSEDED, jamais une
 * suppression, motif `POINT_DATE_COPY`, motif précis, corrélation), la même protection des corrections de
 * l'utilisateur. Aucune IA, aucune relance d'analyse, aucune écriture hors `document_business_periods`.
 *
 *   · CIBLÉE : seuls les documents du compte qui portent une période active d'une nature gardée, non
 *     corrigée par l'utilisateur, réduite à un seul jour ; `fileId` : un seul document ;
 *   · À BLANC par défaut : rapport « avant » (ce que la fiche restituait, pourquoi c'est une copie) et
 *     « après » prévu, rien n'est écrit ;
 *   · IDEMPOTENTE : un second passage ne trouve plus rien ;
 *   · BORNÉE : par pages (`limit`, 200 documents au plus), reprise au document suivant (`afterFileId`) ;
 *   · TRAÇABLE : corrélation `reprise-812:…` portée par chaque ligne retirée et par le journal.
 */
import type postgres from 'postgres';
import type { BusinessPeriodKind, PartialDate } from '@/lib/documents/business-periods';
import { POINT_DATE_GUARDED_KINDS } from './point-date';

type Sql = postgres.Sql;
type Row = Record<string, unknown>;

/** Taille maximale d'une page de documents. */
export const POINT_DATE_REPRISE_PAGE = 200;

export interface PointDateRepriseLine {
  periodId: number; kind: BusinessPeriodKind; start: PartialDate | null; end: PartialDate | null;
  /** Jour recopié, rôle(s) de cette date dans le document, motif précis. */
  date: string; roles: string[]; reason: string;
}

export interface PointDateRepriseDocument {
  fileId: number;
  /** AVANT : périodes actives qui ne sont que la date du document (la reprise les retire). */
  before: PointDateRepriseLine[];
  /** Périodes conservées « à réexaminer » (fin seule le jour du document, mention propre) : jamais retirées ici. */
  toReview: Array<Omit<PointDateRepriseLine, 'reason'>>;
  /** APRÈS (mode réel seulement) : lignes retirées, lignes artificielles restantes (attendu : aucune). */
  after: { outcome: string; retired: number[]; remaining: number[] } | null;
}

export interface PointDateRepriseReport {
  accountId: number;
  apply: boolean;
  correlationId: string;
  /** Documents examinés dans cette page. */
  examined: number;
  /** Documents qui portent au moins une période à retirer ou à réexaminer. */
  documents: PointDateRepriseDocument[];
  /** Périodes à retirer (avant) et réellement retirées (après ; 0 à blanc). */
  toRetire: number;
  retired: number;
  toReview: number;
  /** Page suivante : dernier document examiné, s'il en reste. */
  nextAfterFileId: number | null;
  remaining: boolean;
}

/**
 * Une page de la reprise d'un compte. `apply` faux (défaut) : à blanc, AUCUNE écriture.
 * Un document d'un autre compte n'existe pas (aucune ligne lue ni écrite hors du compte).
 */
export async function reprisePointDateValidities(accountId: number, opts: {
  apply?: boolean; fileId?: number | null; afterFileId?: number; limit?: number; correlationId?: string; sql?: Sql;
} = {}): Promise<PointDateRepriseReport> {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error('identifiant de compte invalide');
  if (opts.fileId != null && (!Number.isSafeInteger(opts.fileId) || opts.fileId <= 0)) throw new Error('identifiant de document invalide');
  const sql = opts.sql ?? (await import('@/db')).pgClient;
  const apply = opts.apply === true;
  const limit = Math.min(Math.max(1, opts.limit ?? POINT_DATE_REPRISE_PAGE), POINT_DATE_REPRISE_PAGE);
  const correlationId = opts.correlationId ?? `reprise-812:${accountId}:${new Date().toISOString()}`;
  const { previewDocumentBusinessPeriods, refreshDocumentBusinessPeriods } = await import('./service');
  // Documents candidats (filtre large, en lecture) : la décision appartient à la règle, pas à cette requête.
  const candidats = (await sql.unsafe(
    `SELECT DISTINCT p.file_id FROM document_business_periods p
       JOIN asset_files f ON f.id = p.file_id AND f.account_id = p.account_id AND f.deleted_at IS NULL
      WHERE p.account_id = $1 AND p.status = 'ACTIVE' AND p.period_kind = ANY($2::text[]) AND NOT p.user_locked AND p.origin <> 'USER'
        AND NOT p.end_open AND (p.start_on IS NULL OR p.end_on IS NULL OR p.start_on = p.end_on)
        AND (p.start_on IS NOT NULL OR p.end_on IS NOT NULL)
        AND p.file_id > $3 AND ($4::int IS NULL OR p.file_id = $4::int)
      ORDER BY p.file_id LIMIT $5`,
    [accountId, `{${POINT_DATE_GUARDED_KINDS.join(',')}}`, opts.afterFileId ?? 0, opts.fileId ?? null, limit + 1] as never[],
  )) as unknown as Row[];
  const page = candidats.slice(0, limit).map((r) => Number(r.file_id));
  const out: PointDateRepriseReport = {
    accountId, apply, correlationId, examined: page.length, documents: [], toRetire: 0, retired: 0, toReview: 0,
    nextAfterFileId: candidats.length > limit ? page[page.length - 1] : null, remaining: candidats.length > limit,
  };
  for (const fileId of page) {
    const avant = await previewDocumentBusinessPeriods(accountId, fileId, sql);
    const copies = avant.pointDate?.copies ?? [];
    const aRevoir = avant.pointDate?.toReview ?? [];
    if (avant.gone || (!copies.length && !aRevoir.length)) continue;
    const doc: PointDateRepriseDocument = {
      fileId,
      before: copies.map((c) => ({ periodId: c.periodId, kind: c.kind, start: c.start, end: c.end, date: c.date, roles: c.roles, reason: c.reason })),
      toReview: aRevoir.map((c) => ({ periodId: c.periodId, kind: c.kind, start: c.start, end: c.end, date: c.date, roles: c.roles })),
      after: null,
    };
    out.toRetire += copies.length;
    out.toReview += aRevoir.length;
    if (apply && copies.length) {
      // MÊME réparation que le contrôle de cohérence (service unique, transaction par document).
      const r = await refreshDocumentBusinessPeriods(accountId, fileId, { correlationId });
      const apres = await previewDocumentBusinessPeriods(accountId, fileId, sql);
      doc.after = { outcome: r.outcome, retired: r.pointDateCopies ?? [], remaining: (apres.pointDate?.copies ?? []).map((c) => c.periodId) };
      out.retired += doc.after.retired.length;
    }
    out.documents.push(doc);
  }
  if (out.documents.length) {
    console.info(JSON.stringify({
      event: 'business_period.point_date_reprise', accountId, apply, correlationId, examined: out.examined,
      toRetire: out.toRetire, retired: out.retired, toReview: out.toReview, fileIds: out.documents.slice(0, 50).map((d) => d.fileId),
    }));
  }
  return out;
}

/** Comptes qui portent au moins une période candidate (lecture seule) — option `--all` du script. */
export async function pointDateRepriseAccounts(sql?: Sql): Promise<number[]> {
  const db = sql ?? (await import('@/db')).pgClient;
  const r = (await db.unsafe(
    `SELECT DISTINCT account_id FROM document_business_periods
      WHERE status = 'ACTIVE' AND period_kind = ANY($1::text[]) AND NOT user_locked AND origin <> 'USER' ORDER BY 1`,
    [`{${POINT_DATE_GUARDED_KINDS.join(',')}}`] as never[],
  )) as unknown as Row[];
  return r.map((x) => Number(x.account_id));
}
