/**
 * Lot 113AB (Trello #725, §2 D et §3) — LECTURE des périodes métier pour les
 * SURFACES : fiche de l'événement de référence (y compris sans élément
 * d'agenda), détail d'une dépense (TCO), Assistant (T2) et dossiers V12.
 *
 * Nouveau fichier de LECTURE seule : le fait de période reste celui du lot
 * 113W (`document_business_periods`, service `business-periods/service`,
 * propriété 113AA) ; aucune écriture ici. Une correction passe toujours par
 * `PUT /api/documents/:id/periodes` (`correctDocumentPeriod`) : c'est le
 * MÊME fait, donc la même valeur partout (synchronisation par construction).
 *
 *   · `readDocumentPeriodSummaries` : périodes de PLUSIEURS documents en une
 *     requête (lignes de dépense, extraits T2, pièces d'un dossier) — même
 *     choix de période principale que la fiche (`principalKind`, public) ;
 *   · `readOperationsCoverage` : historiques de couverture de PLUSIEURS
 *     événements de référence (T2) — lot 113AC : délègue à la lecture groupée
 *     publique `readOperationsCoverageHistories` (113AA), donc la MÊME
 *     résolution D11 que la fiche ; parité vérifiée en e2e ;
 *   · `unsettledCoverages` / `dossierPeriodLines` (113AC) : couvertures
 *     remplacées ou en conflit, jamais présentées comme établies (T2, dossiers) ;
 *   · `readReferenceEvent` : la fiche d'UN événement de référence (libellé
 *     utilisateur, historique de couverture via la fonction publique du lot
 *     113W, justificatifs, élément d'agenda éventuel) ;
 *   · `referenceEventsOfDocument` : événements de référence d'un document.
 *
 * Bornée au compte dans CHAQUE requête (un document ou un événement d'un
 * autre compte n'existe pas). Table absente (migration 1560 non appliquée) :
 * lecture vide, jamais d'erreur.
 */
import type postgres from 'postgres';
import { documentTitleColumnsSql, documentTitleOf } from '@/lib/documents/document-title-source';
import { periodLine, principalLine, type BusinessPeriodKind, type PartialDate } from '@/lib/documents/business-periods';
import { principalKind } from './business-periods/model';
import type { CoverageEntry, PeriodView } from './business-periods/service';

type Sql = postgres.Sql;
type Row = Record<string, unknown>;
const sqlClient = async (): Promise<Sql> => (await import('@/db')).pgClient;
const tableMissing = (e: unknown) => (e as { code?: string })?.code === '42P01';
/** Bornes (latence maîtrisée). */
export const SURFACE_MAX_DOCUMENTS = 300;
export const SURFACE_MAX_OPERATIONS = 200;

const ids = (xs: readonly number[], max: number) => [...new Set(xs.filter((x) => Number.isSafeInteger(x) && x > 0))].slice(0, max);

function toView(r: Row): PeriodView & { principalHint: boolean; fileId: number } {
  const kind = r.period_kind as BusinessPeriodKind;
  const start = (r.start_on as PartialDate | null) ?? null;
  const end = (r.end_on as PartialDate | null) ?? null;
  return {
    id: Number(r.id), kind, segment: Number(r.segment_index), start, end, line: periodLine(kind, { start, end }),
    userCorrected: r.user_locked === true, principalHint: r.principal_hint === true, fileId: Number(r.file_id),
  };
}
const strip = ({ principalHint: _p, fileId: _f, ...v }: ReturnType<typeof toView>): PeriodView => v;

export interface DocumentPeriodSummary {
  fileId: number;
  /** Période principale (même règle que la fiche du document). */
  principal: { kind: BusinessPeriodKind; line: string; segments: PeriodView[] } | null;
  /** Autres natures (détail). */
  secondary: PeriodView[];
  /** Périodes FACTURÉES du document (détail d'une dépense), quelle que soit la principale. */
  billing: PeriodView[];
}

/** Périodes de plusieurs documents du compte (une requête). Documents sans période : absents de la table rendue. */
export async function readDocumentPeriodSummaries(accountId: number, fileIds: readonly number[], runner?: Sql): Promise<Map<number, DocumentPeriodSummary>> {
  const out = new Map<number, DocumentPeriodSummary>();
  const liste = ids(fileIds, SURFACE_MAX_DOCUMENTS);
  if (!liste.length) return out;
  const sql = runner ?? await sqlClient();
  let rows: Row[] = [];
  try {
    rows = (await sql.unsafe(
      `SELECT p.id, p.file_id, p.period_kind, p.segment_index, p.start_on, p.end_on, p.principal_hint, p.user_locked
         FROM document_business_periods p
         JOIN asset_files f ON f.id = p.file_id AND f.account_id = p.account_id AND f.deleted_at IS NULL
        WHERE p.account_id = $1 AND p.file_id = ANY($2::int[]) AND p.status = 'ACTIVE'
        ORDER BY p.file_id, p.period_kind, p.segment_index`,
      [accountId, liste] as never[],
    )) as unknown as Row[];
  } catch (e) {
    if (tableMissing(e)) return out;
    throw e;
  }
  const parFichier = new Map<number, Array<ReturnType<typeof toView>>>();
  for (const r of rows) {
    const v = toView(r);
    parFichier.set(v.fileId, [...(parFichier.get(v.fileId) ?? []), v]);
  }
  for (const [fileId, vs] of parFichier) {
    const kind = principalKind(vs);
    const segments = kind ? vs.filter((s) => s.kind === kind).sort((a, b) => a.segment - b.segment).map(strip) : [];
    out.set(fileId, {
      fileId,
      principal: kind ? { kind, line: principalLine(kind, segments), segments } : null,
      secondary: vs.filter((s) => s.kind !== kind).sort((a, b) => a.kind.localeCompare(b.kind) || a.segment - b.segment).map(strip),
      billing: vs.filter((s) => s.kind === 'BILLING').sort((a, b) => a.segment - b.segment).map(strip),
    });
  }
  return out;
}

/**
 * Historiques de couverture de plusieurs événements de référence ACTIFS du
 * compte : couvertures actives des documents membres, chronologiques, chacune
 * reliée à son justificatif. Un événement sans couverture est absent de la
 * table rendue.
 *
 * Lot 113AC (fusion D11 → surfaces) : repose sur la lecture groupée PUBLIQUE
 * `readOperationsCoverageHistories` (113AA) — la MÊME résolution contextuelle
 * que la fiche (REPLACED / CONFLICT, note, document remplaçant, autres
 * justificatifs du même fait) ; plus aucune requête parallèle. `runner` est
 * conservé pour la compatibilité des appelants (ignoré : lecture du pool).
 */
export async function readOperationsCoverage(accountId: number, operationIds: readonly number[], _runner?: Sql): Promise<Map<number, CoverageEntry[]>> {
  const out = new Map<number, CoverageEntry[]>();
  const liste = ids(operationIds, SURFACE_MAX_OPERATIONS);
  if (!liste.length) return out;
  const { readOperationsCoverageHistories } = await import('./business-periods/service');
  for (const [op, h] of await readOperationsCoverageHistories(accountId, liste, { max: SURFACE_MAX_OPERATIONS })) {
    if (h.coverages.length) out.set(op, h.coverages);
  }
  return out;
}

/** Résolution D11 d'une période de couverture d'un document (statut et note seulement : `basis` reste interne). */
export interface CoverageSettlement {
  status: 'REPLACED' | 'CONFLICT';
  note: string;
}

const cle = (fileId: number, start: PartialDate | null, end: PartialDate | null) => `${fileId}|${start ?? ''}|${end ?? ''}`;

/**
 * Lot 113AC — périodes de COUVERTURE NON ÉTABLIES (remplacées ou en conflit, D11) de plusieurs documents,
 * clé « document|début|fin » : une requête d'appartenance puis la lecture groupée des historiques (113AA).
 * Un même fait porté par plusieurs justificatifs (`otherSources`) reçoit le statut de sa ligne. Ne lève pas
 * (lecture impossible : table vide — l'appelant garde son comportement d'avant, prudent).
 */
export async function unsettledCoverages(accountId: number, fileIds: readonly number[]): Promise<Map<string, CoverageSettlement>> {
  const out = new Map<string, CoverageSettlement>();
  const liste = ids(fileIds, SURFACE_MAX_DOCUMENTS);
  if (!liste.length) return out;
  try {
    const sql = await sqlClient();
    const ops = (await sql.unsafe(
      `SELECT DISTINCT d.operation_id FROM business_operation_documents d
         JOIN business_operations o ON o.id = d.operation_id AND o.account_id = d.account_id AND o.invalidated_at IS NULL
        WHERE d.account_id = $1 AND d.file_id = ANY($2::int[]) AND d.active ORDER BY 1 LIMIT ${SURFACE_MAX_OPERATIONS}`,
      [accountId, liste] as never[],
    )) as unknown as Row[];
    if (!ops.length) return out;
    const voulus = new Set(liste);
    for (const h of (await readOperationsCoverage(accountId, ops.map((o) => Number(o.operation_id)))).values()) {
      for (const c of h) {
        if (!c.resolution) continue;
        const v: CoverageSettlement = { status: c.resolution.status, note: c.resolution.note };
        for (const f of [c.fileId, ...(c.otherSources ?? []).map((o) => o.fileId)]) {
          const k = cle(f, c.start, c.end);
          // Un conflit l'emporte sur un remplacement (jamais présenté comme établi).
          if (voulus.has(f) && (!out.has(k) || v.status === 'CONFLICT')) out.set(k, v);
        }
      }
    }
  } catch (e) {
    if (!tableMissing(e)) console.warn('[business-period-surfaces] résolution des couvertures illisible', (e as Error)?.message);
  }
  return out;
}

/** Résolution d'une période d'un document (couverture seulement), sinon `undefined` (pure). */
export function settlementOf(fileId: number, p: Pick<PeriodView, 'kind' | 'start' | 'end'>, m: ReadonlyMap<string, CoverageSettlement>): CoverageSettlement | undefined {
  return p.kind === 'COVERAGE' ? m.get(cle(fileId, p.start, p.end)) : undefined;
}

/**
 * Lot 113AC — période principale de chaque pièce d'un DOSSIER utilisateur (V12) : la ligne de la fiche,
 * SAUF quand l'une de ses périodes de couverture est remplacée (avenant, rectificatif, choix de
 * l'utilisateur) ou en conflit entre justificatifs — jamais une période non établie présentée comme
 * établie (tableau 113AA : « à exclure »). Lecture sûre (vide en cas d'échec).
 */
export async function dossierPeriodLines(accountId: number, fileIds: readonly number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!fileIds.length) return out;
  const [resumes, nonEtablies] = await Promise.all([readDocumentPeriodSummaries(accountId, fileIds), unsettledCoverages(accountId, fileIds)]);
  for (const [id, p] of resumes) {
    if (!p.principal) continue;
    if (p.principal.segments.some((s) => settlementOf(id, s, nonEtablies))) continue;
    out.set(id, p.principal.line);
  }
  return out;
}

// ── Fiche de l'événement de référence ───────────────────────────────────────

/** Nom utilisateur d'un type d'événement de référence (jamais « Opération », P09) — même vocabulaire que le TCO. */
const NOMS: Record<string, string> = {
  ACQUISITION: 'Achat', INTERVENTION: 'Intervention', CONTRACT: 'Contrat', FINANCING: 'Financement', CLAIM: 'Sinistre', DISPOSAL: 'Cession', OTHER: 'Dépense',
};

/** Libellé utilisateur (pure) : « Contrat — Assurance habitation ». */
export function referenceEventLabel(o: { typeCode: string | null; technicalLabel: string | null; provider?: string | null; firstDocumentTitle?: string | null }): string {
  const base = NOMS[o.typeCode ?? 'OTHER'] ?? 'Dépense';
  const t = o.technicalLabel?.trim() || o.firstDocumentTitle?.trim() || o.provider?.trim() || null;
  return t ? `${base} — ${t.slice(0, 80)}` : base;
}

export interface ReferenceEventView {
  /** Identifiant technique (ouverture de la fiche) ; jamais affiché. */
  id: number;
  label: string;
  /** Nature technique (CONTRACT, INTERVENTION…) : la rubrique de couverture n'a de sens que pour un contrat ou si une couverture existe. */
  typeCode: string | null;
  provider: string | null;
  /** Toutes les couvertures établies, chronologiques, chacune reliée à son justificatif (lot 113W, même lecture). */
  coverages: CoverageEntry[];
  /** Justificatifs membres (titre, date du document). */
  documents: Array<{ fileId: number; title: string; date: string | null }>;
  /** Élément d'agenda relié (le plus ancien), s'il existe — la fiche reste consultable sans lui. */
  agendaItemId: number | null;
}

/** Fiche d'un événement de référence ACTIF du compte (redirection des regroupements) ; null sinon. */
export async function readReferenceEvent(accountId: number, operationId: number): Promise<ReferenceEventView | null> {
  const { readOperationCoverageHistory, publicCoverage } = await import('./business-periods/service');
  const h = await readOperationCoverageHistory(accountId, operationId);
  if (!h) return null;
  const sql = await sqlClient();
  const id = h.operationId;
  const [op] = (await sql.unsafe(
    `SELECT type_code, technical_label, provider FROM business_operations WHERE id = $1 AND account_id = $2 AND invalidated_at IS NULL`,
    [id, accountId] as never[],
  )) as unknown as Row[];
  if (!op) return null;
  const docs = (await sql.unsafe(
    `SELECT f.id, to_char(f.document_date, 'YYYY-MM-DD') AS document_date, ${documentTitleColumnsSql('f')}
       FROM business_operation_documents d
       JOIN asset_files f ON f.id = d.file_id AND f.account_id = d.account_id AND f.deleted_at IS NULL
      WHERE d.account_id = $1 AND d.operation_id = $2 AND d.active
      ORDER BY f.document_date NULLS LAST, f.id LIMIT 200`,
    [accountId, id] as never[],
  )) as unknown as Row[];
  const agenda = (await sql.unsafe(
    `SELECT id FROM agenda_items WHERE account_id = $1 AND business_operation_id = $2 ORDER BY id LIMIT 1`,
    [accountId, id] as never[],
  ).catch(() => [])) as unknown as Row[];
  const documents = docs.map((d) => ({ fileId: Number(d.id), title: documentTitleOf(d), date: (d.document_date as string | null) ?? null }));
  return {
    id,
    label: referenceEventLabel({
      typeCode: (op.type_code as string | null) ?? null, technicalLabel: (op.technical_label as string | null) ?? null,
      provider: (op.provider as string | null) ?? null, firstDocumentTitle: documents[0]?.title ?? null,
    }),
    typeCode: (op.type_code as string | null) ?? null,
    provider: (op.provider as string | null) ?? null,
    // Lot 113AC : `resolution.basis` est interne (jamais transmis à l'écran).
    coverages: h.coverages.map(publicCoverage),
    documents,
    agendaItemId: agenda[0] ? Number(agenda[0].id) : null,
  };
}

/** Événements de référence ACTIFS dont un document du compte est membre (au plus 10). */
export async function referenceEventsOfDocument(accountId: number, fileId: number): Promise<Array<{ id: number; label: string; hasAgenda: boolean; coverageCount: number }> | null> {
  const sql = await sqlClient();
  const [doc] = (await sql.unsafe(
    `SELECT 1 FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [fileId, accountId] as never[],
  )) as unknown as Row[];
  if (!doc) return null;
  const rows = (await sql.unsafe(
    `SELECT o.id, o.type_code, o.technical_label, o.provider,
            EXISTS (SELECT 1 FROM agenda_items a WHERE a.account_id = o.account_id AND a.business_operation_id = o.id) AS has_agenda
       FROM business_operation_documents d
       JOIN business_operations o ON o.id = d.operation_id AND o.account_id = d.account_id AND o.invalidated_at IS NULL
      WHERE d.account_id = $1 AND d.file_id = $2 AND d.active
      ORDER BY o.id LIMIT 10`,
    [accountId, fileId] as never[],
  )) as unknown as Row[];
  const cov = await readOperationsCoverage(accountId, rows.map((r) => Number(r.id)), sql);
  return rows.map((r) => ({
    id: Number(r.id),
    label: referenceEventLabel({ typeCode: (r.type_code as string | null) ?? null, technicalLabel: (r.technical_label as string | null) ?? null, provider: (r.provider as string | null) ?? null }),
    hasAgenda: r.has_agenda === true,
    coverageCount: cov.get(Number(r.id))?.length ?? 0,
  }));
}

// ── Faits pour T2 (Assistant) ───────────────────────────────────────────────

/**
 * Texte des périodes de plusieurs documents (mêmes libellés que la fiche),
 * pour l'extrait de leur source T2. Ne lève JAMAIS : une lecture impossible
 * laisse l'extrait existant inchangé (la recherche documentaire reste servie).
 */
export async function documentPeriodTexts(accountId: number, fileIds: readonly number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!fileIds.length) return out;
  try {
    const { documentPeriodsText } = await import('@/lib/documents/business-period-surfaces');
    // Lot 113AC (D11) : une couverture remplacée ou en conflit est dite comme telle, jamais comme établie.
    const [resumes, nonEtablies] = await Promise.all([readDocumentPeriodSummaries(accountId, fileIds), unsettledCoverages(accountId, fileIds)]);
    const marquer = (id: number, v: PeriodView) => { const r = settlementOf(id, v, nonEtablies); return r ? { ...v, resolution: r } : v; };
    for (const [id, s] of resumes) {
      const t = documentPeriodsText({
        principal: s.principal ? { ...s.principal, segments: s.principal.segments.map((v) => marquer(id, v)), resolution: s.principal.segments.length === 1 ? settlementOf(id, s.principal.segments[0], nonEtablies) : undefined } : null,
        secondary: s.secondary.map((v) => marquer(id, v)),
      });
      if (t) out.set(id, t);
    }
  } catch (e) {
    console.warn('[business-period-surfaces] lecture des périodes pour T2 impossible', (e as Error)?.message);
  }
  return out;
}

/** Historiques de couverture pour T2 — ne lève JAMAIS (table vide rendue en cas d'échec). */
export async function operationsCoverageSafe(accountId: number, operationIds: readonly number[]): Promise<Map<number, CoverageEntry[]>> {
  if (!operationIds.length) return new Map();
  try {
    return await readOperationsCoverage(accountId, operationIds);
  } catch (e) {
    console.warn('[business-period-surfaces] lecture des couvertures pour T2 impossible', (e as Error)?.message);
    return new Map();
  }
}
