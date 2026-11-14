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
 *   · `coverageSettlements` / `dossierPeriodReport` / `dossierPeriodLines`
 *     (113AC, carte #766 E02) : couvertures remplacées ou en conflit, jamais
 *     présentées comme établies (T2, dossiers) — et, carte #766, « aucun
 *     conflit » distingué de « résolution indisponible ou partielle » : une
 *     couverture dont la résolution n'a pas pu être validée n'est PAS publiée
 *     comme établie (fermeture sur l'affirmation, jamais sur le dossier) ;
 *   · `readExpenseLinePeriods` (carte #766, E09) : période propre à chaque
 *     ligne de dépense (composante financière ou montant d'un justificatif) ;
 *   · `readReferenceEvent` : la fiche d'UN événement de référence (libellé
 *     utilisateur, historique de couverture via la fonction publique du lot
 *     113W, justificatifs, élément d'agenda éventuel) ;
 *   · `referenceEventsOfDocument` : événements de référence d'un document.
 *
 * Bornée au compte dans CHAQUE requête (un document ou un événement d'un
 * autre compte n'existe pas). Table absente (migration 1560 non appliquée) :
 * lecture vide, jamais d'erreur.
 *
 * Carte #766 (E03) : la lecture groupée propage la durée indéterminée établie
 * (`end_open`) et passe par le formateur commun `periodLine` — même libellé
 * que la fiche sur la dépense, l'Assistant et les dossiers.
 */
import type postgres from 'postgres';
import { documentTitleColumnsSql, documentTitleOf } from '@/lib/documents/document-title-source';
import { endToken, periodLine, principalLine, type BusinessPeriodKind, type PartialDate, type PeriodBounds } from '@/lib/documents/business-periods';
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
  // Carte #766 (E03) : durée indéterminée ÉTABLIE propagée (jamais rendue comme une fin inconnue).
  const openEnded = r.end_open === true && end === null;
  return {
    id: Number(r.id), kind, segment: Number(r.segment_index), start, end, line: periodLine(kind, { start, end, openEnded }),
    userCorrected: r.user_locked === true, principalHint: r.principal_hint === true, fileId: Number(r.file_id),
    ...(openEnded ? { openEnded: true } : {}),
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
      `SELECT p.id, p.file_id, p.period_kind, p.segment_index, p.start_on, p.end_on, p.end_open, p.principal_hint, p.user_locked
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

// Carte #766 (E10) : la modalité de fin fait partie de la clé (fin inconnue ≠ durée indéterminée).
const cle = (fileId: number, p: PeriodBounds) => `${fileId}|${p.start ?? ''}|${endToken(p)}`;

/**
 * Carte #766 (E02) — état de la résolution des couvertures :
 *   · `RESOLVED`    : résolution lue en entier — l'absence d'une période dans `settlements` signifie
 *                     « aucun remplacement, aucun conflit » ;
 *   · `PARTIAL`     : une borne de lecture a été atteinte — les documents de `unvalidated` n'ont pas été
 *                     résolus (ou seulement en partie) ;
 *   · `UNAVAILABLE` : la résolution n'a pas pu être lue (erreur SQL, délai dépassé, table absente) — AUCUN
 *                     document n'est validé.
 * « Aucun conflit » n'est donc jamais déduit d'une lecture impossible.
 */
export type CoverageResolutionState = 'RESOLVED' | 'PARTIAL' | 'UNAVAILABLE';
export type CoverageResolutionCause = 'READ_FAILED' | 'TABLE_MISSING' | 'DOCUMENT_LIMIT' | 'MEMBERSHIP_LIMIT' | 'EVENT_LIMIT' | 'PERIOD_LIMIT';

export interface CoverageSettlements {
  state: CoverageResolutionState;
  /** Couvertures NON établies (remplacées ou en conflit), clé interne « document|début|fin ». */
  settlements: Map<string, CoverageSettlement>;
  /** Documents dont la résolution des couvertures n'a pas pu être validée (jamais « établie » pour eux). */
  unvalidated: Set<number>;
  cause: CoverageResolutionCause | null;
  /** Message technique de l'échec (journal seulement, jamais affiché). */
  error?: string;
}

/** Appartenances lues par résolution (au-delà : résolution partielle, documents non validés). */
const SURFACE_MAX_MEMBERSHIPS = 2_000;
/** Nouvel essai d'une lecture en échec (erreur transitoire) avant de fermer sur l'affirmation. */
const SETTLEMENT_READ_RETRIES = 1;

/**
 * Lot 113AC, carte #766 (E02) — périodes de COUVERTURE NON ÉTABLIES (remplacées ou en conflit, D11) de
 * plusieurs documents, AVEC l'état de la résolution : une requête d'appartenance puis la résolution groupée
 * des événements de référence (113AA). Un même fait porté par plusieurs justificatifs (`otherSources`)
 * reçoit le statut de sa ligne. Ne lève jamais : un échec est rendu comme `UNAVAILABLE` (après un nouvel
 * essai), une lecture bornée comme `PARTIAL` — l'appelant ne publie alors AUCUNE couverture non validée.
 */
export async function coverageSettlements(accountId: number, fileIds: readonly number[]): Promise<CoverageSettlements> {
  const demandes = ids(fileIds, Number.MAX_SAFE_INTEGER);
  const vide = (): CoverageSettlements => ({ state: 'RESOLVED', settlements: new Map(), unvalidated: new Set(), cause: null });
  if (!demandes.length) return vide();
  let derniere: unknown = null;
  for (let essai = 0; essai <= SETTLEMENT_READ_RETRIES; essai++) {
    try {
      return await readCoverageSettlements(accountId, demandes);
    } catch (e) {
      derniere = e;
    }
  }
  const error = String((derniere as Error)?.message ?? derniere).slice(0, 200);
  console.warn(JSON.stringify({ event: 'business_period.resolution_unavailable', accountId, documents: demandes.length, error }));
  return { state: 'UNAVAILABLE', settlements: new Map(), unvalidated: new Set(demandes), cause: tableMissing(derniere) ? 'TABLE_MISSING' : 'READ_FAILED', error };
}

async function readCoverageSettlements(accountId: number, demandes: readonly number[]): Promise<CoverageSettlements> {
  const out: CoverageSettlements = { state: 'RESOLVED', settlements: new Map(), unvalidated: new Set(), cause: null };
  const partiel = (cause: CoverageResolutionCause, fichiers: Iterable<number>) => {
    out.state = 'PARTIAL';
    out.cause ??= cause;
    for (const f of fichiers) out.unvalidated.add(f);
  };
  // Toute résolution partielle est journalisée avec sa cause, quel que soit le point de sortie.
  const rendre = (): CoverageSettlements => {
    if (out.state !== 'RESOLVED') console.warn(JSON.stringify({ event: 'business_period.resolution_partial', accountId, cause: out.cause, unvalidated: out.unvalidated.size }));
    return out;
  };
  const liste = demandes.slice(0, SURFACE_MAX_DOCUMENTS);
  if (demandes.length > liste.length) partiel('DOCUMENT_LIMIT', demandes.slice(SURFACE_MAX_DOCUMENTS));
  const sql = await sqlClient();
  const liens = (await sql.unsafe(
    `SELECT d.file_id, d.operation_id FROM business_operation_documents d
       JOIN business_operations o ON o.id = d.operation_id AND o.account_id = d.account_id AND o.invalidated_at IS NULL
      WHERE d.account_id = $1 AND d.file_id = ANY($2::int[]) AND d.active ORDER BY d.operation_id, d.file_id LIMIT ${SURFACE_MAX_MEMBERSHIPS + 1}`,
    [accountId, liste] as never[],
  )) as unknown as Row[];
  if (!liens.length) return rendre();
  // Appartenances tronquées : on ne sait plus quels documents sont membres de quoi — aucun n'est validé.
  if (liens.length > SURFACE_MAX_MEMBERSHIPS) partiel('MEMBERSHIP_LIMIT', liste);
  const parOp = new Map<number, number[]>();
  for (const l of liens) { const op = Number(l.operation_id); parOp.set(op, [...(parOp.get(op) ?? []), Number(l.file_id)]); }
  const ops = [...parOp.keys()];
  const resolues = ops.slice(0, SURFACE_MAX_OPERATIONS);
  for (const op of ops.slice(SURFACE_MAX_OPERATIONS)) partiel('EVENT_LIMIT', parOp.get(op) ?? []);
  const { operationsPeriodResolution } = await import('./business-periods/service');
  const res = await operationsPeriodResolution(sql, accountId, resolues);
  const voulus = new Set(liste);
  for (const op of resolues) {
    const r = res.get(op);
    // Événement absent du résultat ou lu en partie : ses documents ne sont pas validés.
    if (!r) { partiel('READ_FAILED', parOp.get(op) ?? []); continue; }
    if (r.truncated) partiel('PERIOD_LIMIT', parOp.get(op) ?? []);
    for (const c of r.coverages) {
      if (!c.resolution) continue;
      const v: CoverageSettlement = { status: c.resolution.status, note: c.resolution.note };
      for (const f of [c.fileId, ...(c.otherSources ?? []).map((o) => o.fileId)]) {
        const k = cle(f, c);
        // Un conflit l'emporte sur un remplacement (jamais présenté comme établi).
        if (voulus.has(f) && (!out.settlements.has(k) || v.status === 'CONFLICT')) out.settlements.set(k, v);
      }
    }
  }
  return rendre();
}

/** Résolution d'une période d'un document (couverture seulement), sinon `undefined` (pure). */
export function settlementOf(fileId: number, p: Pick<PeriodView, 'kind' | 'start' | 'end' | 'openEnded'>, m: ReadonlyMap<string, CoverageSettlement>): CoverageSettlement | undefined {
  return p.kind === 'COVERAGE' ? m.get(cle(fileId, p)) : undefined;
}

/** Motif d'une période principale NON publiée dans un dossier. */
export type DossierOmissionCause = 'REPLACED' | 'CONFLICT' | 'RESOLUTION_UNAVAILABLE' | 'RESOLUTION_PARTIAL';

export interface DossierPeriodReport {
  /** Période principale publiée, par pièce. */
  lines: Map<number, string>;
  /** Pièces dont la période principale n'est PAS publiée, avec le motif (la pièce reste dans le dossier). */
  omitted: Array<{ fileId: number; cause: DossierOmissionCause }>;
  resolution: { state: CoverageResolutionState; cause: CoverageResolutionCause | null };
}

/**
 * Carte #766 (E02) — décision de publication (pure) : la période principale d'une pièce est publiée, SAUF
 * si c'est une couverture remplacée, en conflit, ou dont la résolution n'a pas pu être validée. Les autres
 * natures (facturation, validité…) ne dépendent pas de la résolution des couvertures.
 */
export function dossierPeriodDecision(resumes: ReadonlyMap<number, DocumentPeriodSummary>, res: CoverageSettlements): DossierPeriodReport {
  const out: DossierPeriodReport = { lines: new Map(), omitted: [], resolution: { state: res.state, cause: res.cause } };
  for (const [id, p] of resumes) {
    if (!p.principal) continue;
    if (p.principal.kind === 'COVERAGE') {
      const st = p.principal.segments.map((s) => settlementOf(id, s, res.settlements)).filter((x): x is CoverageSettlement => !!x);
      if (st.length) { out.omitted.push({ fileId: id, cause: st.some((x) => x.status === 'CONFLICT') ? 'CONFLICT' : 'REPLACED' }); continue; }
      // Fermeture sur l'affirmation : « aucun conflit connu » n'est pas « aucun conflit » quand la résolution manque.
      if (res.unvalidated.has(id)) { out.omitted.push({ fileId: id, cause: res.state === 'UNAVAILABLE' ? 'RESOLUTION_UNAVAILABLE' : 'RESOLUTION_PARTIAL' }); continue; }
    }
    out.lines.set(id, p.principal.line);
  }
  return out;
}

/**
 * Lot 113AC, carte #766 (E02) — période principale de chaque pièce d'un DOSSIER utilisateur (V12), avec le
 * compte rendu des omissions : jamais une période non établie présentée comme établie (tableau 113AA :
 * « à exclure »), jamais une couverture dont la résolution est indisponible ou partielle. La pièce reste
 * dans le dossier (règles d'export inchangées) ; l'omission et sa cause sont journalisées.
 */
export async function dossierPeriodReport(accountId: number, fileIds: readonly number[]): Promise<DossierPeriodReport> {
  if (!fileIds.length) return { lines: new Map(), omitted: [], resolution: { state: 'RESOLVED', cause: null } };
  const [resumes, res] = await Promise.all([readDocumentPeriodSummaries(accountId, fileIds), coverageSettlements(accountId, fileIds)]);
  const rapport = dossierPeriodDecision(resumes, res);
  const nonValidees = rapport.omitted.filter((o) => o.cause === 'RESOLUTION_UNAVAILABLE' || o.cause === 'RESOLUTION_PARTIAL');
  if (nonValidees.length) {
    console.warn(JSON.stringify({
      event: 'dossier.period_omitted', accountId, state: res.state, cause: res.cause, count: nonValidees.length,
      fileIds: nonValidees.slice(0, 50).map((o) => o.fileId),
    }));
  }
  return rapport;
}

/** Périodes principales publiées d'un dossier (voir `dossierPeriodReport`). */
export async function dossierPeriodLines(accountId: number, fileIds: readonly number[]): Promise<Map<number, string>> {
  return (await dossierPeriodReport(accountId, fileIds)).lines;
}

// ── Carte #766 (E09) : période propre à une ligne de dépense ────────────────

export interface ExpenseLinePeriod { start: string | null; end: string | null }
export const SURFACE_MAX_EXPENSE_LINES = 300;
const jourIso = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/**
 * Carte #766 (E09) — période FACTURÉE PROPRE à chaque ligne de dépense, lue là où T1 / T3 l'ont
 * établie (aucune règle nouvelle, aucune écriture, TCO non consulté) :
 *   · `c:<composante>`                : `business_operation_financial_components.period_start / period_end` ;
 *   · `doc:<fichier>:<candidat>:<n>`  : le n-ième montant (`financialHints`) du candidat T1 du justificatif.
 * Toute autre ligne (fiche du bien, net d'un achat, montant global) n'a pas de période propre : absente du
 * résultat. Bornée au compte ; une ligne d'un autre compte est absente. Au plus 300 lignes.
 */
export async function readExpenseLinePeriods(accountId: number, lineIds: readonly string[], runner?: Sql): Promise<Map<string, ExpenseLinePeriod>> {
  const out = new Map<string, ExpenseLinePeriod>();
  const lignes = [...new Set(lineIds)].slice(0, SURFACE_MAX_EXPENSE_LINES);
  const composantes = new Map<number, string>();
  const montants: Array<{ lineId: string; fileId: number; candidateId: number; index: number }> = [];
  for (const l of lignes) {
    let m: RegExpExecArray | null;
    if ((m = /^c:(\d{1,15})$/.exec(l))) composantes.set(Number(m[1]), l);
    else if ((m = /^doc:(\d{1,10}):(\d{1,15}):(\d{1,3})$/.exec(l))) montants.push({ lineId: l, fileId: Number(m[1]), candidateId: Number(m[2]), index: Number(m[3]) });
  }
  if (!composantes.size && !montants.length) return out;
  const sql = runner ?? await sqlClient();
  if (composantes.size) {
    const r = (await sql.unsafe(
      `SELECT id, period_start::text AS period_start, period_end::text AS period_end FROM business_operation_financial_components
        WHERE account_id = $1 AND active AND id = ANY($2::bigint[])`,
      [accountId, `{${[...composantes.keys()].join(',')}}`] as never[],
    )) as unknown as Row[];
    for (const x of r) {
      const p = { start: jourIso(x.period_start), end: jourIso(x.period_end) };
      if (p.start || p.end) out.set(composantes.get(Number(x.id))!, p);
    }
  }
  if (montants.length) {
    const r = (await sql.unsafe(
      `SELECT id, file_id, payload FROM document_operation_candidates
        WHERE account_id = $1 AND status = 'ACTIVE' AND id = ANY($2::bigint[])`,
      [accountId, `{${[...new Set(montants.map((x) => x.candidateId))].join(',')}}`] as never[],
    )) as unknown as Row[];
    const parId = new Map(r.map((x) => [Number(x.id), x]));
    for (const mnt of montants) {
      const c = parId.get(mnt.candidateId);
      if (!c || Number(c.file_id) !== mnt.fileId) continue;
      let payload: unknown = c.payload;
      if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = null; } }
      const hints = (payload as { financialHints?: unknown } | null)?.financialHints;
      const h = Array.isArray(hints) ? hints[mnt.index] as { periodStart?: unknown; periodEnd?: unknown } | undefined : undefined;
      const p = { start: jourIso(h?.periodStart), end: jourIso(h?.periodEnd) };
      if (p.start || p.end) out.set(mnt.lineId, p);
    }
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
    const [resumes, res] = await Promise.all([readDocumentPeriodSummaries(accountId, fileIds), coverageSettlements(accountId, fileIds)]);
    const nonEtablies = res.settlements;
    const marquer = (id: number, v: PeriodView) => { const r = settlementOf(id, v, nonEtablies); return r ? { ...v, resolution: r } : v; };
    // Carte #766 (E02) : résolution indisponible ou partielle — une couverture NON VALIDÉE n'est pas dite à
    // l'Assistant (ni établie, ni en conflit : rien) ; les autres natures du document restent fournies.
    const validee = (id: number, kind: BusinessPeriodKind) => kind !== 'COVERAGE' || !res.unvalidated.has(id);
    let omises = 0;
    for (const [id, s] of resumes) {
      const principal = s.principal && validee(id, s.principal.kind) ? s.principal : null;
      const secondary = s.secondary.filter((v) => validee(id, v.kind));
      if (principal !== s.principal || secondary.length !== s.secondary.length) omises++;
      const t = documentPeriodsText({
        principal: principal ? { ...principal, segments: principal.segments.map((v) => marquer(id, v)), resolution: principal.segments.length === 1 ? settlementOf(id, principal.segments[0], nonEtablies) : undefined } : null,
        secondary: secondary.map((v) => marquer(id, v)),
      });
      if (t) out.set(id, t);
    }
    if (omises) console.warn(JSON.stringify({ event: 'assistant.period_omitted', accountId, state: res.state, cause: res.cause, count: omises }));
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
