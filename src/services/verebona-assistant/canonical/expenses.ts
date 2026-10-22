/**
 * Dépenses qualifiées par thème — CDC 15 T2-24 (lot 15).
 *
 * « Combien ai-je dépensé en entretien ? » ne se répond pas par la somme de
 * tous les `amount_cents` : un devis, une annonce, une assurance ou l'achat
 * du bien s'y mêleraient. On ne somme que des MONTANTS DOCUMENTAIRES
 * COMPARABLES et QUALIFIÉS dans le thème demandé :
 *
 *   · thème d'un document : type du référentiel V2 (`document_type_code`,
 *     ex. MAINTENANCE_INVOICE → entretien), sinon catalogue documentaire du
 *     registre quand le type n'a qu'un type métier ;
 *   · exclus, jamais sommés : types sans valeur de dépense au catalogue
 *     (autorité WEAK : devis, annonce, photo, autre), bon de commande,
 *     compromis, quittances de loyer et dépôts de garantie (recettes) ;
 *   · non qualifiés : montant sur un type qui ne dit pas le thème (facture
 *     générique, ticket) — comptés à part : ils rendent le total d'un thème
 *     INCOMPLET, ce que la réponse doit dire (jamais les ajouter d'office) ;
 *   · non qualifiés (date absente) : avec une ANNÉE demandée, un document à
 *     montant sans `document_date` ne peut être ni rangé dans l'année ni
 *     écarté : il est compté à part comme non qualifié, et le total devient
 *     INCOMPLET (relecture lot 15 — il était exclu en silence) ;
 *   · doublons signalés « fusion possible » (`analysis_state =
 *     FUSION_SUGGESTED`, critères de `document-ai/fusion-detector` : même
 *     empreinte `sha256_hash`, ou même titre retenu + même bien + même
 *     date) : comptés UNE SEULE FOIS — voir `dedupePossibleMerges`.
 */
import { pgClient } from '@/db';
import { ASSET_LIST_LINK_ROLES_SQL } from '@/services/documents/asset-document-scope';
import {
  EXPENSE_THEME_LABELS, classifyExpenseDocument, dedupePossibleMerges, isCreditNoteTitle, type ExpenseClass, type ExpenseRow, type ExpenseTheme,
} from './expense-classes';
import {
  emptyOperationPart, formatMinorAmount, loadScopeOperationsRead, operationCostLines, operationCountLabel, operationLabel, operationReader,
  readAllOperations, summarizeOperationCosts, type OperationExpensePart,
} from './operations';

// Vocabulaire des thèmes : `expense-classes.ts` (partagé avec les Opérations).
export { EXPENSE_THEME_LABELS, expenseThemeOf, classifyExpenseDocument, isPaymentProofType, isCreditNoteTitle, dedupePossibleMerges, expenseInfoScore } from './expense-classes';
export type { ExpenseTheme, ExpenseClass, ExpenseRow } from './expense-classes';

export interface QualifiedExpenses {
  theme: ExpenseTheme | null;
  byTheme: Array<{
    theme: ExpenseTheme; label: string; sumCents: number;
    /** Éléments comptés : documents + Opérations (lot 45). */
    count: number;
    fileIds: number[];
    /** Lot 45 : Opérations dont le coût consolidé est compté dans ce thème. */
    operationIds?: number[];
    documentCount?: number;
    operationCount?: number;
  }>;
  /** Somme des dépenses qualifiées (du thème demandé, ou de tous les thèmes). */
  qualifiedSumCents: number;
  qualifiedCount: number;
  /**
   * Montants non qualifiés : thème non établi, ou (année demandée) date du
   * document absente — `undatedCount` en est la part « date absente ».
   */
  unqualified: { count: number; sumCents: number; fileIds: number[]; undatedCount: number };
  /** Doublons « fusion possible » écartés du total (comptés une seule fois). */
  duplicates: { count: number; fileIds: number[] };
  /** Documents exclus (devis, annonces, preuves de paiement…), par type. */
  excluded: { count: number; byType: Record<string, number> };
  /**
   * Le total est COMPLET : aucun document non qualifié ne peut en faire
   * partie. Faux : la réponse doit signaler la couverture incomplète.
   */
  complete: boolean;
  /**
   * Lot 45 (C15.1) : coûts CONSOLIDÉS des Opérations du périmètre (comptés
   * en premier). Absent d'un résultat calculé sans lecture des Opérations.
   */
  operations?: OperationExpensePart;
  /** Lot 45 (C15.1, C10) : repli documentaire dédupliqué. */
  documents?: DocumentFallbackPart;
  /**
   * Lot 53D (retour PO D12) : question limitée à des biens — dépenses du
   * COMPTE sans bien identifié et sans lien probable avec ces biens.
   * Incertitude de niveau compte : exposée, jamais imputée aux biens et sans
   * effet sur la complétude de leur total.
   */
  accountUnassigned?: { count: number; sumCents: number; labels: string[] };
  /**
   * Lot 54D (E02, §4.4) : état de LECTURE du calcul, distinct de la
   * complétude métier — `COMPLETE` : tout le périmètre lu ; `PARTIAL` : garde-
   * fou de volume atteint ; `DEGRADED` : lecture des coûts consolidés en échec,
   * le résultat n'est qu'un repli documentaire (jamais présenté comme un
   * total consolidé complet). Absent : forme antérieure (lecture complète).
   */
  readStatus?: 'COMPLETE' | 'PARTIAL' | 'DEGRADED';
  /**
   * Lot 75J (point laissé par 75D) : couverture INCERTAINE, même règle que le
   * TCO (`expenseCoverageSignals`) — dépenses comptées dont le rapprochement
   * est incertain (acompte / solde possiblement déjà compris), justificatifs
   * financiers au montant inconnu. Non vide : total non exhaustif, dit.
   * Absent : signaux non lus (lecture en échec, forme antérieure).
   */
  coverage?: { uncertain: { count: number; fileIds: number[] }; amountUnknown: { count: number; fileIds: number[]; labels: string[] } };
}

/** Repli documentaire (C15.1 §30) : ce qui en a été compté ou écarté. */
export interface DocumentFallbackPart {
  /** Documents comptés (hors Opérations) et leur somme. */
  count: number;
  sumCents: number;
  /** Sources d'une Opération du périmètre : jamais recomptés (F-135). */
  represented: { count: number; fileIds: number[] };
  /**
   * Sources d'une Opération HORS périmètre (bien non confirmé ou autre
   * bien) : ni recomptés ici ni imputés au bien — total incomplet.
   */
  representedElsewhere: { count: number; fileIds: number[] };
  /** Document commun à plusieurs biens dont certains hors périmètre : non réparti (C10). */
  unattributed: { count: number; sumCents: number; fileIds: number[] };
  /** Avoirs (réduction) comptés en négatif. */
  creditNotes: { count: number; sumCents: number };
  /** Lot 78B : justificatifs non comptés par la règle du TCO (même achat décrit plusieurs fois, achat non incorporé au bien). */
  notCounted?: { count: number; fileIds: number[] };
  /**
   * Lot 53D (D12) : parmi `representedElsewhere`, dépenses SANS bien confirmé
   * dont un document est lié au périmètre (lien probable identifié) : non
   * comptées, elles rendent le total du périmètre incomplet — identifiées.
   */
  unconfirmedAsset?: { count: number; sumCents: number; items: Array<{ fileId: number; operationId: number; label: string; amountCents: number | null }> };
  /**
   * Lot 53D (D12) : parmi `representedElsewhere`, dépenses attribuées par T3
   * à d'AUTRES biens seulement : comptées pour ces biens, sans incertitude ici.
   */
  countedForOtherAssets?: { count: number; fileIds: number[] };
  /** Lot 53D (D2) : montants documentaires en devise étrangère ou non établie : jamais sommés en euros. */
  foreign?: Array<{ fileId: number; amountMinor: number; currency: string }>;
}

type DocRow = ExpenseRow & { amountCents: number; linked: number[] | null; retainedTitle: string | null; currency: string | null };

/**
 * Dépenses d'un compte — Opération d'abord, repli documentaire dédupliqué
 * (lot 45, CDC Opérations V1 C15.1, B15 ; T2-24 conservé) :
 *
 *   1. périmètre (biens, année, thème) ;
 *   2. Opérations ACTIVES du périmètre et leurs composantes consolidées
 *      (`operations.ts` : coût réalisé − avoirs, devis « prévu »,
 *      indemnité dans le net, devises à part, multi-biens non ventilé) ;
 *   3. documents sources de ces Opérations (et de toute Opération active)
 *      écartés du repli — jamais recomptés, même si l'Opération n'a pas
 *      encore de montant (C15.1 §31) ;
 *   4. repli documentaire sur les autres documents (règles T2-24, preuve de
 *      paiement exclue, avoir en réduction, document multi-biens non
 *      réparti) ;
 *   5. complétude conservée (non qualifiés, sans montant, non attribués,
 *      devises).
 *
 * Sans Opération, le résultat est celui du lot 15 (même total, même
 * complétude) — seules les preuves de paiement ne sont plus « non
 * qualifiées » mais exclues (P16). `assetIds` : documents liés à ces biens
 * par la relation N-N (repli : colonnes historiques).
 */
export async function sumQualifiedExpenses(accountId: number, opts: {
  assetIds?: number[];
  year?: number;
  theme?: ExpenseTheme | null;
} = {}): Promise<QualifiedExpenses> {
  const ids = opts.assetIds?.length ? opts.assetIds : null;
  const theme = opts.theme ?? null;
  // Lot 54D (E02) : documents lus par pages sur curseur stable (`f.id`), plus
  // de borne silencieuse à 5 000 ; garde-fou mémoire → lecture PARTIELLE signalée.
  const { rows, complete: docsComplets } = await readExpenseDocuments(accountId, { year: opts.year ?? null, assetIds: ids });
  const docs = rows.map((r) => ({ ...r, id: Number(r.id), linked: (r.linked ?? []).map(Number) }));
  let lectureComplete = docsComplets;
  let degradee = false;

  // ── Opérations d'abord (C15.1 §28-29) ────────────────────────────────────
  // Lecture en échec : aucune Opération NI aucune exclusion (comportement du
  // lot 15) — jamais une moitié de lecture qui compterait deux fois. Lot 54D :
  // l'échec est SIGNALÉ (`readStatus = DEGRADED`, total jamais « complet »).
  let part = emptyOperationPart();
  let opEntries: ReturnType<typeof summarizeOperationCosts>['entries'] = [];
  let scopeOps = new Set<number>();
  let represented = new Map<number, number[]>();
  let sansComposante = new Set<number>();
  let nonCouvrants = new Map<number, Set<number>>();
  let horsTotal = new Set<number>();
  try {
    const lu = await loadScopeOperationsRead(accountId, ids ?? []);
    const ops = lu.operations;
    // Lot 78B (TCO-R-14) : mêmes exclusions que le TCO (doublon présumé, justificatif retiré, prix d'un autre bien,
    // achat non incorporé au bien) — décidées par le service TCO, jamais recalculées ici.
    const excl = await (await import('@/services/business-operations/tco/service')).t2CostExclusions(accountId, ops, ids);
    horsTotal = excl.files;
    // Lot 61 (TCO §3.3) : Opérations du périmètre SANS composante financière exploitable (aucune hors prévision).
    sansComposante = new Set(ops.filter((o) => o.status !== 'CANCELLED' && !o.components.some((c) => c.kind !== 'FORECAST_COST')).map((o) => o.id));
    if (!lu.complete) lectureComplete = false;
    const lus = summarizeOperationCosts(operationCostLines(ops, { assetIds: ids ?? [], year: opts.year ?? null, excludedComponentIds: excl.components }), theme);
    const rep = await operationReader().representedDocuments(accountId, docs.map((d) => d.id));
    part = lus.part;
    opEntries = lus.entries;
    scopeOps = new Set(ops.map((o) => o.id));
    represented = rep;
    // Lot 61 / 75D (cohérence T2 / TCO, une seule règle) : justificatif source d'une Opération qui ne reprend PAS son
    // fait (accessoire rattaché à l'achat du bien, facture non consolidée d'une Opération partiellement consolidée)
    // — il fait foi, comme au TCO (`operationCoverage`) ; jamais une comparaison de montants.
    const sources = docs.filter((d) => (rep.get(d.id) ?? []).some((o) => scopeOps.has(o))).map((d) => d.id);
    if (sources.length) nonCouvrants = await (await import('@/services/business-operations/tco/service')).documentsNotCoveredByOperations(accountId, sources);
  } catch (e) {
    degradee = true;
    console.warn('[verebona] dépenses : lecture des coûts consolidés impossible, repli documentaire seul :', (e as Error).message);
  }
  return finishQualifiedExpenses(accountId, { ids, theme, year: opts.year ?? null, docs, part, opEntries, scopeOps, represented, sansComposante, nonCouvrants, horsTotal, lectureComplete, degradee });
}

const EXPENSE_DOCS_PAGE = 2000;
const EXPENSE_DOCS_MAX = 200_000;

/**
 * Lot 54D (E02) : documents à montant du périmètre, pages sur curseur `f.id` jusqu'à épuisement.
 * Lot 68 (68A, cohérence TCO) : même rattachement que le TCO et la liste des documents du bien —
 * colonnes historiques et liens PRIMARY / SECONDARY ; un bien seulement CITÉ (MENTIONED) n'est ni
 * dans le périmètre ni un bien d'attribution (sinon la facture de la Polo citant la maison était
 * « non ventilée » pour la Polo).
 */
async function readExpenseDocuments(accountId: number, o: { year: number | null; assetIds: number[] | null }): Promise<{ rows: DocRow[]; complete: boolean }> {
  const out: DocRow[] = [];
  let curseur = 0;
  for (;;) {
    const lot = (await pgClient.unsafe(
    `SELECT f.id, f.amount_cents AS "amountCents", f.document_type_code AS "v2", f.document_type AS "legacy",
            f.document_date::text AS "date", f.sha256_hash AS "hash", f.retained_title AS "title", f.asset_id AS "assetId",
            f.supplier, f.analysis_state AS "state", f.fusion_ignored_with AS "ignored", f.retained_title AS "retainedTitle",
            -- Lot 53D (D2) : devise du montant lu (extraction) ; montant saisi à la main dans le tiroir (en €) : EUR.
            CASE WHEN COALESCE(f.user_edited_fields->>'amountCents', 'false') = 'true' THEN 'EUR'
                 ELSE (SELECT upper(trim(e.currency)) FROM document_extractions e WHERE e.file_id = f.id AND e.account_id = f.account_id
                        ORDER BY e.id DESC LIMIT 1) END AS "currency",
            ARRAY(SELECT DISTINCT u.x FROM (
                    SELECT l.asset_id AS x FROM document_asset_links l
                     WHERE l.account_id = f.account_id AND l.file_id = f.id AND l.status = 'ACTIVE' AND l.link_role IN ${ASSET_LIST_LINK_ROLES_SQL}
                    UNION SELECT f.asset_id UNION SELECT f.linked_asset_id) u
                   WHERE u.x IS NOT NULL
                     AND EXISTS (SELECT 1 FROM assets a WHERE a.id = u.x AND a.account_id = f.account_id AND a.deleted_at IS NULL)) AS "linked"
       FROM asset_files f
      WHERE f.account_id = $1 AND f.deleted_at IS NULL AND f.amount_cents IS NOT NULL AND f.id > $4
        AND ($2::int IS NULL OR f.document_date IS NULL OR extract(year FROM f.document_date) = $2)
        AND ($3::int[] IS NULL
             OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = f.account_id AND l.file_id = f.id
                         AND l.status = 'ACTIVE' AND l.link_role IN ${ASSET_LIST_LINK_ROLES_SQL} AND l.asset_id = ANY($3::int[]))
             OR f.asset_id = ANY($3::int[]) OR f.linked_asset_id = ANY($3::int[]))
      ORDER BY f.id LIMIT $5`,
      [accountId, o.year, o.assetIds, curseur, EXPENSE_DOCS_PAGE] as never[],
    )) as unknown as DocRow[];
    out.push(...lot);
    if (lot.length < EXPENSE_DOCS_PAGE) return { rows: out, complete: true };
    if (out.length >= EXPENSE_DOCS_MAX) return { rows: out, complete: false };
    curseur = Number(lot[lot.length - 1].id);
  }
}

type DocLine = DocRow & { id: number; linked: number[] };

async function finishQualifiedExpenses(accountId: number, x: {
  ids: number[] | null; theme: ExpenseTheme | null; year: number | null; docs: DocLine[];
  part: OperationExpensePart; opEntries: ReturnType<typeof summarizeOperationCosts>['entries'];
  scopeOps: Set<number>; represented: Map<number, number[]>; sansComposante?: Set<number>;
  /** Lot 75D : par document, Opérations dont il est source qui ne reprennent pas son fait (règle du TCO). */
  nonCouvrants?: Map<number, Set<number>>;
  /** Lot 78B : justificatifs que le TCO du bien ne compte pas (même achat décrit plusieurs fois, achat non incorporé). */
  horsTotal?: Set<number>;
  lectureComplete: boolean; degradee: boolean;
}): Promise<QualifiedExpenses> {
  const { ids, theme, docs, opEntries, scopeOps, represented } = x;
  const sansComposante = x.sansComposante ?? new Set<number>();
  /** Lot 61 : Opérations sans montant dont la facture rattachée porte le coût (elles ne rendent plus le total incomplet). */
  const couvertesParDocument = new Set<number>();
  const opts = { year: x.year ?? undefined };

  // ── Repli documentaire dédupliqué (C15.1 §30-31, C10) ────────────────────
  const fallback: DocumentFallbackPart = {
    count: 0, sumCents: 0, represented: { count: 0, fileIds: [] }, representedElsewhere: { count: 0, fileIds: [] },
    unattributed: { count: 0, sumCents: 0, fileIds: [] }, creditNotes: { count: 0, sumCents: 0 },
    unconfirmedAsset: { count: 0, sumCents: 0, items: [] }, countedForOtherAssets: { count: 0, fileIds: [] }, foreign: [],
  };
  const ailleurs = new Map<number, number[]>();
  const { kept, removed } = dedupePossibleMerges(docs);
  const entries: ExpenseEntry[] = [];
  for (const r of kept) {
    if (x.horsTotal?.has(r.id)) {
      fallback.notCounted = { count: (fallback.notCounted?.count ?? 0) + 1, fileIds: [...(fallback.notCounted?.fileIds ?? []), r.id] };
      continue;
    }
    const ops = represented.get(r.id);
    // Lot 61 (TCO §3.3, cohérence T2 / TCO) : un document rattaché SEULEMENT à des
    // Opérations du périmètre sans composante financière exploitable n'est pas
    // « représenté » : la facture qualifiée fait foi (jamais perdue).
    const nonCouvert = (o: number) => !!x.nonCouvrants?.get(r.id)?.has(o);
    const factureFaitFoi = !!ops?.length && ops.every((o) => scopeOps.has(o) && (sansComposante.has(o) || nonCouvert(o)));
    if (ops?.length && !factureFaitFoi) {
      const cible = ops.some((o) => scopeOps.has(o)) ? fallback.represented : fallback.representedElsewhere;
      cible.count += 1; cible.fileIds.push(r.id);
      if (cible === fallback.representedElsewhere) ailleurs.set(r.id, ops);
      continue;
    }
    const cls = classifyExpenseDocument(r.v2, r.legacy);
    // Lot 53D (D2) : un montant dont la devise n'est pas l'euro (étrangère ou
    // seulement présumée) n'entre jamais dans un total en euros.
    if (r.currency && r.currency !== 'EUR' && cls.kind !== 'excluded') {
      const pertinentDevise = cls.kind === 'unqualified' || (cls.kind === 'theme' && (!theme || cls.theme === theme));
      if (pertinentDevise) fallback.foreign!.push({ fileId: r.id, amountMinor: Number(r.amountCents), currency: r.currency });
      continue;
    }
    const pertinent = cls.kind === 'unqualified' || (cls.kind === 'theme' && (!theme || cls.theme === theme));
    if (ids && r.linked.length > 1 && r.linked.some((a) => !ids.includes(a)) && cls.kind !== 'excluded') {
      // Facture de plusieurs biens : jamais comptée entière pour chacun.
      if (pertinent) { fallback.unattributed.count += 1; fallback.unattributed.sumCents += Number(r.amountCents); fallback.unattributed.fileIds.push(r.id); }
      continue;
    }
    const avoir = cls.kind === 'theme' && isCreditNoteTitle(r.retainedTitle);
    const amount = avoir ? -Math.abs(Number(r.amountCents)) : Number(r.amountCents);
    if (avoir && pertinent) { fallback.creditNotes.count += 1; fallback.creditNotes.sumCents += amount; }
    entries.push({ fileId: r.id, amountCents: amount, cls, undated: opts.year != null && !r.date });
    if (factureFaitFoi && cls.kind !== 'excluded') for (const o of ops!) if (sansComposante.has(o)) couvertesParDocument.add(o);
  }
  const part: OperationExpensePart = couvertesParDocument.size ? {
    ...x.part,
    withoutAmount: (() => {
      const keep = x.part.withoutAmount.operationIds.map((id, i) => ({ id, label: x.part.withoutAmount.labels[i] })).filter((o) => !couvertesParDocument.has(o.id));
      return { count: keep.length, operationIds: keep.map((o) => o.id), labels: keep.map((o) => o.label) };
    })(),
  } : x.part;
  // Lot 53D (D12) : documents du périmètre rattachés à une dépense hors
  // périmètre — dépense sans bien confirmé (lien probable : ce document) ou
  // dépense attribuée à d'autres biens. Lecture en échec : forme du lot 45.
  let accountUnassigned: QualifiedExpenses['accountUnassigned'];
  try {
    if (ailleurs.size) {
      const opIds = [...new Set([...ailleurs.values()].flat())];
      const lues = (await readAllOperations(accountId, { ids: opIds })).operations;
      const parId = new Map(lues.map((o) => [o.id, o]));
      const lignes = new Map(operationCostLines(lues, { assetIds: [], year: opts.year ?? null }).map((l) => [l.operationId, l]));
      for (const [fileId, ops] of ailleurs) {
        const sansBien = ops.map((id) => parId.get(id)).filter((o): o is NonNullable<typeof o> => !!o && o.assetIds.length === 0);
        if (!sansBien.length && ops.every((id) => parId.has(id))) {
          fallback.countedForOtherAssets!.count += 1; fallback.countedForOtherAssets!.fileIds.push(fileId);
          continue;
        }
        const o = sansBien[0] ?? null;
        const l = o ? lignes.get(o.id) : undefined;
        const montant = l && (l.hasCost || l.costCents) ? l.costCents : null;
        fallback.unconfirmedAsset!.count += 1;
        fallback.unconfirmedAsset!.sumCents += montant ?? 0;
        fallback.unconfirmedAsset!.items.push({ fileId, operationId: o?.id ?? ops[0], label: o ? operationLabel(o) : 'dépense', amountCents: montant });
      }
    }
    if (ids) {
      const deja = new Set(fallback.unconfirmedAsset!.items.map((i) => i.operationId));
      const libres = (await readAllOperations(accountId, { untargetedOnly: true })).operations.filter((o) => !deja.has(o.id));
      const lignes = summarizeOperationCosts(operationCostLines(libres, { assetIds: [], year: opts.year ?? null }), theme).part;
      if (lignes.count) accountUnassigned = { count: lignes.count, sumCents: lignes.sumCents, labels: lignes.lines.filter((x) => lignes.operationIds.includes(x.operationId)).map((x) => x.label).slice(0, 3) };
    }
  } catch (e) {
    console.warn('[verebona] dépenses : portée des dépenses hors périmètre non établie :', (e as Error).message);
    fallback.unconfirmedAsset = undefined;
    fallback.countedForOtherAssets = undefined;
  }

  const q = aggregateExpenses(
    entries, theme, removed,
    opEntries.filter((e) => e.theme && !e.undated).map((e) => ({ operationId: e.operationId, amountCents: e.amountCents, theme: e.theme! })),
  );
  for (const t of q.byTheme) {
    fallback.count += t.fileIds.length;
    fallback.sumCents += t.sumCents - (t.operationSumCents ?? 0);
  }
  let readStatus: NonNullable<QualifiedExpenses['readStatus']> = x.degradee ? 'DEGRADED' : x.lectureComplete ? 'COMPLETE' : 'PARTIAL';
  // ── Lot 75J : couverture incertaine — MÊME statut que le TCO (INCOMPLETE), aucune seconde logique ──
  let coverage: QualifiedExpenses['coverage'];
  try {
    const comptes = q.byTheme.flatMap((t) => t.fileIds);
    const { expenseCoverageSignals } = await import('@/services/business-operations/tco/service');
    const sig = await expenseCoverageSignals(accountId, { fileIds: comptes, assetIds: ids, year: x.year });
    const inconnus = sig.amountUnknown.filter((u) => !theme || u.theme == null || u.theme === theme);
    coverage = {
      uncertain: { count: sig.uncertain.length, fileIds: sig.uncertain },
      amountUnknown: { count: inconnus.length, fileIds: inconnus.map((u) => u.fileId), labels: inconnus.map((u) => u.title).slice(0, 3) },
    };
    if (!sig.complete && readStatus === 'COMPLETE') readStatus = 'PARTIAL';
  } catch (e) {
    // Lecture des signaux impossible : forme antérieure (aucune affirmation de couverture ajoutée).
    console.warn('[verebona] dépenses : couverture incertaine non évaluée :', (e as Error).message);
  }
  const couvertureSure = !coverage || (coverage.uncertain.count === 0 && coverage.amountUnknown.count === 0);
  return {
    ...q,
    byTheme: q.byTheme.map(({ operationSumCents: _o, ...t }) => t),
    // Lot 54D (E02) : une lecture partielle ou dégradée n'est JAMAIS un total complet.
    // Lot 75J : une couverture incertaine (rapprochement incertain, montant inconnu) non plus — comme le TCO.
    complete: q.complete && expenseCoverageComplete(part, fallback) && readStatus === 'COMPLETE' && couvertureSure,
    operations: part,
    documents: fallback,
    ...(accountUnassigned ? { accountUnassigned } : {}),
    readStatus,
    ...(coverage ? { coverage } : {}),
  };
}

/** Le repli et les Opérations ne laissent aucune part non comptée (pure). */
export function expenseCoverageComplete(part: OperationExpensePart, docs: DocumentFallbackPart): boolean {
  return part.withoutAmount.count === 0 && part.unattributed.count === 0 && part.foreign.length === 0
    && part.unqualified.count === 0 && part.undated.count === 0
    && docs.unattributed.count === 0
    // Lot 53D (D12) : seule une dépense SANS bien confirmé liée au périmètre le
    // rend incomplet — une dépense attribuée à un autre bien ne le dégrade pas.
    && (docs.unconfirmedAsset ? docs.unconfirmedAsset.count : docs.representedElsewhere.count) === 0
    && (docs.foreign?.length ?? 0) === 0;
}


/** Document à montant classé (entrée de l'agrégat). */
export interface ExpenseEntry { fileId: number; amountCents: number; cls: ExpenseClass; undated?: boolean }

/** Résultat de l'agrégat : thèmes avec la part consolidée (retirée par `sumQualifiedExpenses`). */
export type AggregatedExpenses = Omit<QualifiedExpenses, 'byTheme'> & {
  byTheme: Array<QualifiedExpenses['byTheme'][number] & { operationSumCents?: number }>;
};

/** Coût consolidé d'une Opération, de thème établi (lot 45). */
export interface OperationAggregateEntry { operationId: number; amountCents: number; theme: ExpenseTheme }

/**
 * Agrégation (pure, testée). Lot 45 : `operations` — coûts CONSOLIDÉS des
 * Opérations du périmètre, comptés dans leur thème avant les documents
 * (déjà dédupliqués par l'appelant : aucun document source d'une Opération).
 */
export function aggregateExpenses(
  docs: ExpenseEntry[],
  theme: ExpenseTheme | null,
  duplicateFileIds: number[] = [],
  operations: OperationAggregateEntry[] = [],
): AggregatedExpenses {
  type Cur = { sumCents: number; count: number; fileIds: number[]; operationIds: number[]; documentCount: number; operationCount: number; operationSumCents: number };
  const par = new Map<ExpenseTheme, Cur>();
  const cur = (t: ExpenseTheme): Cur => {
    const c = par.get(t) ?? { sumCents: 0, count: 0, fileIds: [], operationIds: [], documentCount: 0, operationCount: 0, operationSumCents: 0 };
    par.set(t, c);
    return c;
  };
  const unq = { count: 0, sumCents: 0, fileIds: [] as number[], undatedCount: 0 };
  const exc = { count: 0, byType: {} as Record<string, number> };
  for (const o of operations) {
    const c = cur(o.theme);
    c.sumCents += o.amountCents; c.operationSumCents += o.amountCents; c.count += 1; c.operationCount += 1; c.operationIds.push(o.operationId);
  }
  for (const d of docs) {
    if (d.cls.kind === 'excluded') { exc.count += 1; exc.byType[d.cls.reason] = (exc.byType[d.cls.reason] ?? 0) + 1; continue; }
    // Année demandée, date absente : ni dans l'année ni hors d'elle — non
    // qualifié, quel que soit son thème (un devis reste exclu, ci-dessus).
    if (d.undated) { unq.count += 1; unq.undatedCount += 1; unq.sumCents += d.amountCents; unq.fileIds.push(d.fileId); continue; }
    if (d.cls.kind === 'unqualified') { unq.count += 1; unq.sumCents += d.amountCents; unq.fileIds.push(d.fileId); continue; }
    const c = cur(d.cls.theme);
    c.sumCents += d.amountCents; c.count += 1; c.documentCount += 1; c.fileIds.push(d.fileId);
  }
  const byTheme = [...par.entries()]
    .filter(([t]) => !theme || t === theme)
    .map(([t, v]) => ({
      theme: t, label: EXPENSE_THEME_LABELS[t], sumCents: v.sumCents, count: v.count, fileIds: v.fileIds,
      // Champs du lot 45 seulement quand des Opérations sont comptées (forme du lot 15 inchangée sinon).
      ...(v.operationCount ? { operationIds: v.operationIds, documentCount: v.documentCount, operationCount: v.operationCount, operationSumCents: v.operationSumCents } : {}),
    }))
    .sort((a, b) => b.sumCents - a.sumCents);
  return {
    theme,
    byTheme,
    qualifiedSumCents: byTheme.reduce((s, x) => s + x.sumCents, 0),
    qualifiedCount: byTheme.reduce((s, x) => s + x.count, 0),
    unqualified: unq,
    excluded: exc,
    duplicates: { count: duplicateFileIds.length, fileIds: duplicateFileIds },
    complete: unq.count === 0,
  };
}

// ── Libellés du total mixte (lot 45, C15.1 §33 : provenance lisible) ─────

const pl = (n: number, a: string, b: string) => (n > 1 ? b : a);
const eurFr = (c: number) => formatMinorAmount(c, 'EUR');

/** Types d'Opération comptés dans un thème (pure). */
function typesOf(ids: readonly number[] | undefined, part: OperationExpensePart | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids ?? []) {
    const t = part?.lines.find((l) => l.operationId === id)?.typeCode ?? 'OTHER';
    out[t] = (out[t] ?? 0) + 1;
  }
  return out;
}

/**
 * « 2 documents » (forme du lot 15) ; avec des coûts consolidés :
 * « 1 intervention et 1 document » (pure, testée).
 */
export function expenseItemsLabel(t: QualifiedExpenses['byTheme'][number], part?: OperationExpensePart): string {
  if (!t.operationCount) return `${t.count} document${t.count > 1 ? 's' : ''}`;
  const docs = t.documentCount ?? 0;
  const ops = operationCountLabel(typesOf(t.operationIds, part));
  return docs ? `${ops} et ${docs} document${pl(docs, '', 's')}` : ops;
}

/** Libellé des éléments du total, tous thèmes confondus (pure). */
export function expenseTotalItemsLabel(q: QualifiedExpenses): string {
  const ops = q.byTheme.flatMap((t) => t.operationIds ?? []);
  if (!ops.length) return `${q.qualifiedCount} document${q.qualifiedCount > 1 ? 's' : ''}`;
  const docs = q.byTheme.reduce((n, t) => n + t.fileIds.length, 0);
  const lab = operationCountLabel(typesOf(ops, q.operations));
  return docs ? `${lab} et ${docs} document${pl(docs, '', 's')}` : lab;
}

/**
 * Phrases du mode mixte (pure, testée) — vides sans Opération ni document
 * écarté (réponse du lot 15 inchangée). Jamais le mot « Opération » (P09).
 */
export function mixedExpenseNotes(q: QualifiedExpenses, ctx: { scopeLabel: string | null; year?: number | null }): string[] {
  const part = q.operations;
  const docs = q.documents;
  const out: string[] = [];
  const ici = ctx.scopeLabel ? ` pour ${ctx.scopeLabel}` : '';
  // Lot 54D (E02) : lecture dégradée ou partielle dite en premier, jamais un total présenté comme complet.
  if (q.readStatus === 'DEGRADED') out.push('Les coûts consolidés n’ont pas pu être lus : ce total ne repose que sur les documents et peut être incomplet.');
  if (q.readStatus === 'PARTIAL') out.push('Volume exceptionnel : seule une partie des éléments a pu être lue, ce total est partiel.');
  if (part && part.count > 0 && docs && docs.count > 0) {
    const opSum = q.byTheme.reduce((n, t) => n + (t.operationIds?.length ? sumOps(t, part) : 0), 0);
    out.push(`Dont ${eurFr(opSum)} consolidés (${operationCountLabel(typesOf(q.byTheme.flatMap((t) => t.operationIds ?? []), part))}) et ${eurFr(q.qualifiedSumCents - opSum)} lus sur ${docs.count} document${pl(docs.count, '', 's')} non rattaché${pl(docs.count, '', 's')} à une intervention.`);
  }
  if (part?.untargeted.count) out.push(`Dont ${eurFr(part.untargeted.sumCents)} sans bien identifié.`);
  if (part?.indemnity.sumCents) {
    out.push(`Indemnités reçues : ${eurFr(part.indemnity.sumCents)} — coût net après indemnités : ${eurFr(q.qualifiedSumCents - part.indemnity.sumCents)}.`);
  }
  if (part?.indemnity.unallocatedCents) out.push(`Une indemnité commune à plusieurs biens (${eurFr(part.indemnity.unallocatedCents)}) n’est pas répartie : elle n’est pas déduite${ici}.`);
  if (part?.forecast.count) out.push(`Prévu (devis, non réalisé) : ${eurFr(part.forecast.sumCents)} — non compté.`);
  // Lot 53D (D2) : devise étrangère (non convertie) et devise NON ÉTABLIE (à confirmer) distinguées.
  const etrangers = [...(part?.foreign ?? []), ...(docs?.foreign ?? [])].filter((f) => f.currency !== 'XXX');
  const incertains = [...(part?.foreign ?? []), ...(docs?.foreign ?? [])].filter((f) => f.currency === 'XXX');
  if (etrangers.length) out.push(`Montant${pl(etrangers.length, '', 's')} en devise étrangère, non converti${pl(etrangers.length, '', 's')} et non compté${pl(etrangers.length, '', 's')} : ${etrangers.map((f) => formatMinorAmount(f.amountMinor, f.currency)).join(', ')}.`);
  if (incertains.length) out.push(`Montant${pl(incertains.length, '', 's')} dont la devise n’est pas écrite sur le document, à confirmer et non compté${pl(incertains.length, '', 's')} en euros : ${incertains.map((f) => formatMinorAmount(f.amountMinor, f.currency)).join(', ')}.`);
  const nonRepartis = (part?.unattributed.count ?? 0) + (docs?.unattributed.count ?? 0);
  if (nonRepartis) {
    const somme = (part?.unattributed.sumCents ?? 0) + (docs?.unattributed.sumCents ?? 0);
    out.push(`${nonRepartis} dépense${pl(nonRepartis, '', 's')} commune${pl(nonRepartis, '', 's')} à plusieurs biens (${eurFr(somme)}) ${pl(nonRepartis, 'n’est', 'ne sont')} pas répartie${pl(nonRepartis, '', 's')} : non comptée${pl(nonRepartis, '', 's')}${ici}.`);
  }
  if (part?.withoutAmount.count) {
    const n = part.withoutAmount.count;
    out.push(`${n} ${pl(n, 'élément', 'éléments')} sans montant connu (${part.withoutAmount.labels.slice(0, 3).join(', ')}) : le total peut être incomplet.`);
  }
  if (part?.unqualified.count) out.push(`${part.unqualified.count} intervention${pl(part.unqualified.count, '', 's')} dont la nature n’est pas précisée : non comptée${pl(part.unqualified.count, '', 's')}.`);
  if (part?.undated.count) out.push(`${part.undated.count} intervention${pl(part.undated.count, '', 's')} sans date : non comptée${pl(part.undated.count, '', 's')}${ctx.year ? ` pour ${ctx.year}` : ''}.`);
  if (docs?.represented.count) out.push(`${docs.represented.count} document${pl(docs.represented.count, '', 's')} déjà pris en compte dans une intervention, un contrat ou un achat : non recompté${pl(docs.represented.count, '', 's')}.`);
  if (docs?.unconfirmedAsset) {
    // Lot 53D (D12) : portée de l'incertitude explicitée, dépenses identifiées.
    const u = docs.unconfirmedAsset;
    if (u.count) {
      const detail = u.items.slice(0, 3).map((i) => `${i.label}${i.amountCents != null ? ` (${eurFr(i.amountCents)})` : ''}`).join(', ');
      out.push(`${u.count} document${pl(u.count, '', 's')}${ici} ${pl(u.count, 'est', 'sont')} rattaché${pl(u.count, '', 's')} à une dépense dont le bien n’est pas confirmé : ${detail} — non comptée${pl(u.count, '', 's')}${ici}, le total peut être incomplet de ${pl(u.count, 'ce montant', 'ces montants')}.`);
    }
    const a = docs.countedForOtherAssets;
    if (a?.count) out.push(`${a.count} document${pl(a.count, '', 's')} lié${pl(a.count, '', 's')}${ici} ${pl(a.count, 'concerne', 'concernent')} une dépense attribuée à un autre bien : comptée${pl(a.count, '', 's')} pour cet autre bien.`);
  } else if (docs?.representedElsewhere.count) out.push(`${docs.representedElsewhere.count} document${pl(docs.representedElsewhere.count, '', 's')} rattaché${pl(docs.representedElsewhere.count, '', 's')} à une dépense dont le bien n’est pas confirmé : non compté${pl(docs.representedElsewhere.count, '', 's')}${ici}.`);
  if (q.accountUnassigned?.count) {
    const n = q.accountUnassigned.count;
    out.push(`Au niveau du compte, ${n} dépense${pl(n, '', 's')} sans bien identifié (${eurFr(q.accountUnassigned.sumCents)}) ${pl(n, 'n’est imputée', 'ne sont imputées')} à aucun bien${ici ? `, ni${ici.replace(/^ pour/, ' à')}` : ''}.`);
  }
  // Lot 75J (cohérence TCO) : couverture incertaine dite — jamais un total présenté comme exhaustif.
  const inc = q.coverage?.uncertain.count ?? 0;
  if (inc) out.push(`${inc} dépense${pl(inc, '', 's')} (acompte ou solde) ${pl(inc, 'est comptée', 'sont comptées')} sans preuve qu’${pl(inc, 'elle ne soit', 'elles ne soient')} pas déjà comprise${pl(inc, '', 's')} dans une facture totale du même fournisseur : à vérifier, le total peut être incomplet ou surestimé.`);
  const inconnu = q.coverage?.amountUnknown.count ?? 0;
  if (inconnu) out.push(`${inconnu} justificatif${pl(inconnu, '', 's')} de dépense sans montant lisible (${q.coverage!.amountUnknown.labels.join(', ')}) : montant inconnu, non compté — le total peut être incomplet.`);
  if (docs?.creditNotes.count) out.push(`Avoir${pl(docs.creditNotes.count, '', 's')} déduit${pl(docs.creditNotes.count, '', 's')} : ${eurFr(Math.abs(docs.creditNotes.sumCents))}.`);
  const preuves = q.excluded?.byType?.PAYMENT_PROOF ?? 0;
  if (preuves) out.push(`${preuves} preuve${pl(preuves, '', 's')} de paiement : ${pl(preuves, 'elle confirme', 'elles confirment')} un règlement et ne s’ajoute${pl(preuves, '', 'nt')} pas au coût.`);
  return out;
}

function sumOps(t: QualifiedExpenses['byTheme'][number], part: OperationExpensePart): number {
  return (t.operationIds ?? []).reduce((n, id) => {
    const l = part.lines.find((x) => x.operationId === id);
    return n + (l ? l.costCents : 0);
  }, 0);
}

/** Documents des Opérations comptées (sources citées du total). */
export function countedOperationFileIds(q: QualifiedExpenses): number[] {
  const ops = new Set(q.byTheme.flatMap((t) => t.operationIds ?? []));
  return [...new Set((q.operations?.lines ?? []).filter((l) => ops.has(l.operationId)).flatMap((l) => l.fileIds))];
}

/** Motif d'un total incomplet : thème non établi et/ou date absente. */
function incompletLibelle(q: QualifiedExpenses): string {
  const s = (n: number) => (n > 1 ? 's' : '');
  const sansDate = q.unqualified.undatedCount ?? 0;
  const sansTheme = q.unqualified.count - sansDate;
  const parts = [
    sansTheme ? `${sansTheme} document${s(sansTheme)} avec montant sans thème` : null,
    sansDate ? `${sansDate} document${s(sansDate)} non qualifié${s(sansDate)} (date absente)` : null,
  ].filter(Boolean);
  // Lot 45 : la part non comptée peut venir des coûts consolidés (sans
  // montant, non répartis, devise, nature ou date) — détaillée par les notes.
  if (!parts.length) return 'total incomplet : voir les éléments non comptés';
  return `total incomplet : ${parts.join(', ')}, non compté${s(q.unqualified.count)}`;
}

// ── Source vérifiable du total (T2-24 × T2-31, besoin de Z) ────────────────

/**
 * Source d'un total de dépenses qualifiées : elle PORTE ce que la réponse
 * affirme — total(s) par thème, nombre de documents, année, complétude,
 * documents inclus (`doc-<id>`) — pour qu'une reformulation par le modèle
 * soit vérifiable par `claim-support` (données de la phrase présentes dans
 * la source citée). Identifiant `expenses:<thème|all>:<biens|account>[:<année>]`.
 */
export function expenseSumSource(
  q: QualifiedExpenses,
  ctx: { assetIds: number[]; scopeLabel: string | null; year?: number },
): import('../types/sources').RetrievedSource {
  const eur = (c: number) => `${(c / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
  const pour = `${ctx.scopeLabel ? ` pour ${ctx.scopeLabel}` : ''}${ctx.year ? ` en ${ctx.year}` : ''}`;
  const lignes = q.byTheme.map((t) => `${t.label} : ${eur(t.sumCents)} (${expenseItemsLabel(t, q.operations)})`);
  // Lot 45 : documents comptés ET documents des interventions, contrats ou
  // achats consolidés comptés (sources citées : documents et Opérations).
  const inclus = [...new Set([...q.byTheme.flatMap((t) => t.fileIds), ...countedOperationFileIds(q)])].slice(0, 50);
  const notes = mixedExpenseNotes(q, { scopeLabel: ctx.scopeLabel, year: ctx.year ?? null }).map((n) => n.replace(/\.$/, ''));
  const content = [
    `Dépenses qualifiées${q.theme ? ` de ${EXPENSE_THEME_LABELS[q.theme]}` : ''}${pour} : ${eur(q.qualifiedSumCents)} (${expenseTotalItemsLabel(q)})`,
    ...lignes,
    q.complete ? 'total complet' : incompletLibelle(q),
    ...notes,
    q.duplicates?.count ? `doublons (fusion possible) comptés une fois : ${q.duplicates.count} écarté${q.duplicates.count > 1 ? 's' : ''}` : null,
    q.excluded.count ? `exclus (devis, annonces…) : ${q.excluded.count}` : null,
    inclus.length ? `documents inclus : ${inclus.map((id) => `doc-${id}`).join(' ')}` : null,
  ].filter(Boolean).join(' · ');
  return {
    id: `expenses:${q.theme ?? 'all'}:${ctx.assetIds.length ? ctx.assetIds.join('-') : 'account'}${ctx.year ? `:${ctx.year}` : ''}`,
    type: 'document_extraction',
    title: `Dépenses${q.theme ? ` de ${EXPENSE_THEME_LABELS[q.theme]}` : ''}${pour}`,
    content: content.slice(0, 1500),
    relevanceScore: 1,
    meta: {
      theme: q.theme, totalCents: q.qualifiedSumCents, totalEur: q.qualifiedSumCents / 100, documentCount: q.qualifiedCount,
      complete: q.complete, unqualifiedCount: q.unqualified.count, excludedCount: q.excluded.count, year: ctx.year ?? null,
      undatedCount: q.unqualified.undatedCount ?? 0, duplicateCount: q.duplicates?.count ?? 0,
      includedDocuments: inclus.map((id) => `doc-${id}`).join(' '),
      // Lot 45 (C15.1) : part consolidée et repli documentaire.
      ...(q.operations ? {
        operationCount: q.operations.count, consolidatedCents: q.operations.sumCents,
        indemnityCents: q.operations.indemnity.sumCents, netCents: q.qualifiedSumCents - q.operations.indemnity.sumCents,
        forecastCents: q.operations.forecast.sumCents, withoutAmountCount: q.operations.withoutAmount.count,
        unattributedCents: q.operations.unattributed.sumCents + (q.documents?.unattributed.sumCents ?? 0),
        foreignAmounts: q.operations.foreign.map((f) => formatMinorAmount(f.amountMinor, f.currency)).join(', ') || null,
      } : {}),
      ...(q.documents ? { documentFallbackCents: q.documents.sumCents, representedDocumentCount: q.documents.represented.count } : {}),
    },
  };
}
