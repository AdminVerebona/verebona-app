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
import { resolveDocumentType, type EventBusinessType } from '@/services/canonical/registry';

export type ExpenseTheme =
  | 'maintenance' | 'repair' | 'works' | 'insurance' | 'purchase' | 'inspection' | 'subscription' | 'charges';

export const EXPENSE_THEME_LABELS: Readonly<Record<ExpenseTheme, string>> = {
  maintenance: 'entretien', repair: 'réparations', works: 'travaux', insurance: 'assurance',
  purchase: 'achat', inspection: 'contrôles et diagnostics', subscription: 'abonnements', charges: 'charges',
};

/** Thème désigné par une question (sans accents, minuscules) ; null : aucun. */
export function expenseThemeOf(message: string): ExpenseTheme | null {
  const m = message.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const table: Array<[RegExp, ExpenseTheme]> = [
    [/\b(entretien|entretenir|revision|maintenance|vidange)\b/, 'maintenance'],
    [/\b(reparation|reparations|depannage|panne)\b/, 'repair'],
    [/\b(travaux|renovation|chantier)\b/, 'works'],
    [/\b(assurance|assurances|assureur|cotisation)\b/, 'insurance'],
    [/\b(controle technique|controles?|diagnostics?)\b/, 'inspection'],
    [/\b(abonnements?)\b/, 'subscription'],
    [/\b(charges|copropriete|syndic)\b/, 'charges'],
    [/\b(achat|acquisition)\b/, 'purchase'],
  ];
  return table.find(([re]) => re.test(m))?.[1] ?? null;
}

/** Thème par type du référentiel V2 (le plus précis). */
const THEME_BY_V2_CODE: Readonly<Record<string, ExpenseTheme>> = {
  MAINTENANCE_INVOICE: 'maintenance', REPAIR_INVOICE: 'repair', WORKS_INVOICE: 'works',
  ACQUISITION_INVOICE: 'purchase', SUBSCRIPTION_INVOICE: 'subscription', CHARGE_RECEIPT: 'charges',
  INSURANCE_DUE_NOTICE: 'insurance', INSURANCE_POLICY: 'insurance', INSURANCE_CERTIFICATE: 'insurance',
  VEHICLE_TECHNICAL_INSPECTION: 'inspection',
};

/** Types jamais sommés comme dépense. */
const EXCLUDED_V2 = new Set(['MAINTENANCE_QUOTE', 'REPAIR_QUOTE', 'WORKS_QUOTE', 'RENT_RECEIPT', 'SECURITY_DEPOSIT_RECEIPT']);
const EXCLUDED_CATALOG = new Set(['BON_COMMANDE', 'COMPROMIS_VENTE']);

const THEME_BY_BUSINESS: Partial<Record<EventBusinessType, ExpenseTheme>> = {
  maintenance: 'maintenance', repair: 'repair', insurance: 'insurance', purchase: 'purchase', inspection: 'inspection',
};

export type ExpenseClass =
  | { kind: 'theme'; theme: ExpenseTheme }
  | { kind: 'excluded'; reason: string }
  | { kind: 'unqualified' };

/** Classe d'un document à montant (pure, testée). */
export function classifyExpenseDocument(documentTypeCode: string | null, legacyType: string | null): ExpenseClass {
  if (documentTypeCode && EXCLUDED_V2.has(documentTypeCode)) return { kind: 'excluded', reason: documentTypeCode };
  if (documentTypeCode && THEME_BY_V2_CODE[documentTypeCode]) return { kind: 'theme', theme: THEME_BY_V2_CODE[documentTypeCode] };
  const entry = resolveDocumentType(documentTypeCode) ?? resolveDocumentType(legacyType);
  if (!entry) return { kind: 'unqualified' };
  if (entry.authority === 'WEAK' || EXCLUDED_CATALOG.has(entry.code)) return { kind: 'excluded', reason: entry.code };
  if (entry.businessTypes.length === 1) {
    const t = THEME_BY_BUSINESS[entry.businessTypes[0]];
    if (t) return { kind: 'theme', theme: t };
  }
  return { kind: 'unqualified' };
}

export interface QualifiedExpenses {
  theme: ExpenseTheme | null;
  byTheme: Array<{ theme: ExpenseTheme; label: string; sumCents: number; count: number; fileIds: number[] }>;
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
  /** Documents exclus (devis, annonces…), par type. */
  excluded: { count: number; byType: Record<string, number> };
  /**
   * Le total est COMPLET : aucun document non qualifié ne peut en faire
   * partie. Faux : la réponse doit signaler la couverture incomplète.
   */
  complete: boolean;
}

/**
 * Dépenses qualifiées d'un compte (voir l'en-tête). `assetIds` : documents
 * liés à ces biens par la relation N-N (repli : colonnes historiques).
 */
export async function sumQualifiedExpenses(accountId: number, opts: {
  assetIds?: number[];
  year?: number;
  theme?: ExpenseTheme | null;
} = {}): Promise<QualifiedExpenses> {
  const ids = opts.assetIds?.length ? opts.assetIds : null;
  const rows = (await pgClient.unsafe(
    `SELECT f.id, f.amount_cents AS "amountCents", f.document_type_code AS "v2", f.document_type AS "legacy",
            f.document_date::text AS "date", f.sha256_hash AS "hash", f.retained_title AS "title", f.asset_id AS "assetId",
            f.supplier, f.analysis_state AS "state", f.fusion_ignored_with AS "ignored"
       FROM asset_files f
      WHERE f.account_id = $1 AND f.deleted_at IS NULL AND f.amount_cents IS NOT NULL
        AND ($2::int IS NULL OR f.document_date IS NULL OR extract(year FROM f.document_date) = $2)
        AND ($3::int[] IS NULL
             OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = f.account_id AND l.file_id = f.id
                         AND l.status = 'ACTIVE' AND l.asset_id = ANY($3::int[]))
             OR f.asset_id = ANY($3::int[]) OR f.linked_asset_id = ANY($3::int[]))
      ORDER BY f.id LIMIT 5000`,
    [accountId, opts.year ?? null, ids] as never[],
  )) as unknown as Array<ExpenseRow & { amountCents: number }>;
  const { kept, removed } = dedupePossibleMerges(rows.map((r) => ({ ...r, id: Number(r.id) })));
  return aggregateExpenses(
    kept.map((r) => ({
      fileId: r.id, amountCents: Number(r.amountCents), ...classify(r),
      undated: opts.year != null && !r.date,
    })),
    opts.theme ?? null,
    removed,
  );
}

const classify = (r: { v2: string | null; legacy: string | null }) => ({ cls: classifyExpenseDocument(r.v2, r.legacy) });

/** Ligne de document utile au dédoublonnage. */
export interface ExpenseRow {
  id: number;
  v2: string | null;
  legacy: string | null;
  date: string | null;
  hash: string | null;
  title: string | null;
  assetId: number | null;
  supplier: string | null;
  state: string | null;
  ignored: number[] | null;
}

/** Nombre d'informations qualifiantes d'un document (départage des doublons). */
export function expenseInfoScore(r: ExpenseRow): number {
  return [r.v2, r.legacy, r.date, r.supplier, r.title].filter((x) => x != null && String(x).trim() !== '').length;
}

/**
 * Doublons « fusion possible » comptés une seule fois (pure, testée).
 *
 * Deux documents du résultat forment un doublon si l'un au moins est signalé
 * `FUSION_SUGGESTED`, si la fusion n'a pas été IGNORÉE entre eux
 * (`fusion_ignored_with`, choix de l'utilisateur) et s'ils répondent aux
 * critères du détecteur : même empreinte `sha256_hash` (doublon exact), ou
 * même titre retenu + même bien + même date (doublon probable). Les
 * groupes sont transitifs.
 *
 * Règle de conservation (documentée, CDC 15 T2-24) : dans chaque groupe, on
 * garde le document qui porte le PLUS D'INFORMATIONS (type V2, type
 * historique, date, fournisseur, titre retenu — `expenseInfoScore`) ; à
 * égalité, le PLUS ANCIEN (plus petit identifiant, antérieur au
 * téléversement du doublon). Les autres sont écartés du total et déclarés.
 */
export function dedupePossibleMerges<R extends ExpenseRow>(rows: R[]): { kept: R[]; removed: number[] } {
  const parent = new Map<number, number>(rows.map((r) => [r.id, r.id]));
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const ignores = (a: R, b: R) => (a.ignored ?? []).map(Number).includes(b.id) || (b.ignored ?? []).map(Number).includes(a.id);
  const signales = rows.filter((r) => r.state === 'FUSION_SUGGESTED');
  for (const a of signales) {
    for (const b of rows) {
      if (a.id === b.id || ignores(a, b)) continue;
      const exact = !!a.hash && a.hash === b.hash;
      const probable = !!a.title && a.title === b.title && a.assetId != null && a.assetId === b.assetId
        && (a.date ?? null) === (b.date ?? null);
      if (exact || probable) parent.set(find(a.id), find(b.id));
    }
  }
  const groupes = new Map<number, R[]>();
  for (const r of rows) {
    const g = find(r.id);
    groupes.set(g, [...(groupes.get(g) ?? []), r]);
  }
  const garde = new Set<number>();
  const removed: number[] = [];
  for (const g of groupes.values()) {
    const [meilleur] = [...g].sort((x, y) => expenseInfoScore(y) - expenseInfoScore(x) || x.id - y.id);
    garde.add(meilleur.id);
    for (const r of g) if (r.id !== meilleur.id) removed.push(r.id);
  }
  return { kept: rows.filter((r) => garde.has(r.id)), removed: removed.sort((a, b) => a - b) };
}

/** Agrégation (pure, testée). */
export function aggregateExpenses(
  docs: Array<{ fileId: number; amountCents: number; cls: ExpenseClass; undated?: boolean }>,
  theme: ExpenseTheme | null,
  duplicateFileIds: number[] = [],
): QualifiedExpenses {
  const par = new Map<ExpenseTheme, { sumCents: number; count: number; fileIds: number[] }>();
  const unq = { count: 0, sumCents: 0, fileIds: [] as number[], undatedCount: 0 };
  const exc = { count: 0, byType: {} as Record<string, number> };
  for (const d of docs) {
    if (d.cls.kind === 'excluded') { exc.count += 1; exc.byType[d.cls.reason] = (exc.byType[d.cls.reason] ?? 0) + 1; continue; }
    // Année demandée, date absente : ni dans l'année ni hors d'elle — non
    // qualifié, quel que soit son thème (un devis reste exclu, ci-dessus).
    if (d.undated) { unq.count += 1; unq.undatedCount += 1; unq.sumCents += d.amountCents; unq.fileIds.push(d.fileId); continue; }
    if (d.cls.kind === 'unqualified') { unq.count += 1; unq.sumCents += d.amountCents; unq.fileIds.push(d.fileId); continue; }
    const cur = par.get(d.cls.theme) ?? { sumCents: 0, count: 0, fileIds: [] };
    cur.sumCents += d.amountCents; cur.count += 1; cur.fileIds.push(d.fileId);
    par.set(d.cls.theme, cur);
  }
  const byTheme = [...par.entries()]
    .filter(([t]) => !theme || t === theme)
    .map(([t, v]) => ({ theme: t, label: EXPENSE_THEME_LABELS[t], ...v }))
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

/** Motif d'un total incomplet : thème non établi et/ou date absente. */
function incompletLibelle(q: QualifiedExpenses): string {
  const s = (n: number) => (n > 1 ? 's' : '');
  const sansDate = q.unqualified.undatedCount ?? 0;
  const sansTheme = q.unqualified.count - sansDate;
  const parts = [
    sansTheme ? `${sansTheme} document${s(sansTheme)} avec montant sans thème` : null,
    sansDate ? `${sansDate} document${s(sansDate)} non qualifié${s(sansDate)} (date absente)` : null,
  ].filter(Boolean);
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
  const lignes = q.byTheme.map((t) => `${t.label} : ${eur(t.sumCents)} (${t.count} document${t.count > 1 ? 's' : ''})`);
  const inclus = q.byTheme.flatMap((t) => t.fileIds).slice(0, 50);
  const content = [
    `Dépenses qualifiées${q.theme ? ` de ${EXPENSE_THEME_LABELS[q.theme]}` : ''}${pour} : ${eur(q.qualifiedSumCents)} (${q.qualifiedCount} document${q.qualifiedCount > 1 ? 's' : ''})`,
    ...lignes,
    q.complete ? 'total complet' : incompletLibelle(q),
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
    },
  };
}
