/**
 * Carte #819 (F) — REPRISE DE L'EXISTANT : factures DÉJÀ rattachées à une
 * opération dont le bien est connu (cas réel : document 395, opération 116,
 * carte 775, bien 18), sans réimport ni rattachement manuel.
 *
 * AUCUNE règle nouvelle, aucune écriture propre : la reprise rejoue les
 * moteurs de production, dans l'ordre —
 *   1. RATTACHEMENT : chaque document sans bien d'une opération active est
 *      réévalué par T3 DOCUMENT_ASSET en déterministe (`attachByOperation`) :
 *      lien et colonne posés par le service canonique, carte LINK-ASSET
 *      ouverte fermée avec le motif « RESOLVED_BY_OPERATION:<opération> » ;
 *   2. OPÉRATION : les documents rattachés sont reconsolidés
 *      (`consolidateDocument`), puis les achats dont la date principale relève
 *      de la règle « commande → facture » (`reconsolidateOperations`) — date
 *      de la facture, provenance, historique (avant / après, motif) ;
 *   3. AGENDA : projection T4 de ces seules opérations
 *      (`projectAccountOperations`) — l'événement d'achat EXISTANT et intact
 *      suit la date ; aucun second événement, aucun rappel.
 * Rien d'autre : aucune opération créée, aucun document ni lien dupliqué,
 * aucune dépense ajoutée, aucun appel à un fournisseur d'IA.
 *
 * JAMAIS : un document que l'utilisateur a rattaché, détaché ou déclaré sans
 * bien (« Aucun ») ; une date corrigée par l'utilisateur (opération portant
 * une saisie : la reconsolidation ne recalcule pas ses dates — rendue dans le
 * rapport, `protectedByUser`) ; une opération à plusieurs factures, un
 * acompte (la règle ne s'y applique pas).
 *
 * À BLANC par défaut (`apply` absent) : rapport seul, aucune écriture.
 * BORNÉE : `limit` documents et `limit` opérations par appel (`remaining`
 * signale un reste ; relancer). IDEMPOTENTE : un second passage ne trouve plus
 * rien et n'écrit rien. DURABLE sans ce service : le réexamen des cartes
 * ouvertes à chaque passage T3, le balayage T3 (contexte modifié) et le
 * contrôle quotidien COH-DOC-PRIMARY-LINK posent le même rattachement ; la
 * source du document change alors de version, ce qui reconsolide son
 * opération — ce service produit le rapport et évite d'attendre.
 */
import { orderDocumentTypeCodes } from '@/services/canonical/registry/order-evidence';

type Row = Record<string, unknown>;

/** Documents et opérations examinés au plus par appel. */
export const ORDER_INVOICE_REPRISE_LIMIT = 200;

export interface OrderInvoiceAttachment {
  fileId: number; title: string | null; documentDate: string | null;
  operationId: number; assetId: number; assetName: string | null;
  /** Cartes « À quel bien rattacher ce document ? » ouvertes (fermées par la reprise). */
  openCardIds: number[];
}
export interface OrderInvoiceDate {
  operationId: number; label: string | null;
  /** Date principale enregistrée. */
  current: string | null;
  /** Date de la facture. */
  expected: string;
  invoiceFileId: number | null;
  /** Dates de commande, conservées. */
  orderDates: string[];
  /** L'opération porte une saisie de l'utilisateur : sa date n'est pas recalculée. */
  protectedByUser: boolean;
}
export interface OrderInvoiceRepriseReport {
  accountId: number; applied: boolean;
  /** Documents sans bien que leur opération rattache à un bien. */
  attachments: OrderInvoiceAttachment[];
  /** Achats dont la date principale relève de la règle « commande → facture » et diffère de la date de la facture. */
  dates: OrderInvoiceDate[];
  /** Un reste existe au-delà de la borne : relancer. */
  remaining: boolean;
  /** Écritures effectives (0 à blanc). */
  attached: number; cardsClosed: number; datesChanged: number; reconsolidationChanges: number;
  agenda: { created: number; updated: number; removed: number };
  skipped?: string;
}

const ORDER_TYPES = orderDocumentTypeCodes();

/**
 * Achats ACTIFS du compte portant une pièce de commande et une facture datée autrement que l'opération (préfiltre ; la
 * règle exacte est rejouée ensuite). `only` : restreint à ces opérations (contrôle de cohérence).
 */
export async function orderInvoiceCandidateOperations(accountId: number, limit: number, only?: readonly number[]): Promise<number[]> {
  const { pgClient } = await import('@/db');
  const r = (await pgClient.unsafe(
    `SELECT o.id FROM business_operations o
      WHERE o.account_id = $1 AND o.type_code = 'ACQUISITION' AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
        AND ($4::bigint[] IS NULL OR o.id = ANY($4::bigint[]))
        AND EXISTS (SELECT 1 FROM business_operation_sources s
                      JOIN asset_files f ON f.id::text = s.source_entity_key AND f.account_id = o.account_id AND f.deleted_at IS NULL
                     WHERE s.operation_id = o.id AND s.account_id = o.account_id AND s.active AND s.source_kind = 'DOCUMENT'
                       AND (s.source_role = 'ORDER' OR upper(COALESCE(f.document_type_code, '')) = ANY($2::text[])))
        AND EXISTS (SELECT 1 FROM business_operation_sources s
                      JOIN asset_files f ON f.id::text = s.source_entity_key AND f.account_id = o.account_id AND f.deleted_at IS NULL
                     WHERE s.operation_id = o.id AND s.account_id = o.account_id AND s.active AND s.source_kind = 'DOCUMENT'
                       AND s.source_role = 'INVOICE' AND NOT (upper(COALESCE(f.document_type_code, '')) = ANY($2::text[]))
                       AND f.document_date IS NOT NULL AND o.realized_date IS DISTINCT FROM f.document_date)
      ORDER BY o.id LIMIT $3`,
    [accountId, ORDER_TYPES, limit, only ? [...only] : null] as never[])) as unknown as Array<{ id: number }>;
  return r.map((x) => Number(x.id));
}

/** Constat (lecture seule, aucune IA) : mêmes règles que T3 DOCUMENT_ASSET et que la consolidation, rejouées à blanc. */
async function constat(accountId: number, limit: number, today?: string): Promise<Pick<OrderInvoiceRepriseReport, 'attachments' | 'dates' | 'remaining'>> {
  const { pgClient } = await import('@/db');
  const [store, st, ctxM, res, dec, idd, opi, noAsset, cons] = await Promise.all([
    import('@/services/ai/reconciliation/document-asset/operation-inheritance.store'),
    import('@/services/ai/reconciliation/document-asset/attachment-state'),
    import('@/services/ai/reconciliation/document-asset/context'),
    import('@/services/ai/reconciliation/document-asset/resolution.repository'),
    import('@/services/ai/reconciliation/document-asset/decision'),
    import('@/services/ai/reconciliation/document-asset/identity/decision'),
    import('@/services/ai/reconciliation/document-asset/operation-inheritance'),
    import('@/services/to-process/no-asset-decision'),
    import('./consolidator'),
  ]);
  const fichiers = await store.listAccountOperationOrphans(accountId, 0, limit + 1);
  let remaining = fichiers.length > limit;
  const attachments: OrderInvoiceAttachment[] = [];
  let index: Awaited<ReturnType<typeof ctxM.computeDocumentAssetContext>>['index'] | undefined;
  for (const fileId of fichiers.slice(0, limit)) {
    const etat = await st.readAttachmentState(accountId, fileId);
    if (!etat.exists || st.hasUserDecision(etat) || st.hasPrimaryAttachment(etat)) continue;
    // « Aucun » choisi par l'utilisateur : sa décision prime, le document n'est pas repris.
    if (await noAsset.readExplicitNoAssetDecision(accountId, fileId)) continue;
    const c = await ctxM.computeDocumentAssetContext({ accountId, fileId, state: etat, resolution: await res.getResolution(fileId), ...(index ? { index } : {}) });
    index = c.index;
    // Graphe d'identité en panne : aucun jugement (les garde-fous de refus en dépendent).
    if (c.identityGraphStatus === 'UNAVAILABLE' || c.identityGraphStatus === 'MIGRATION_MISSING') continue;
    const d = dec.decideDeterministic(c.identification, { multiAssetDeclared: c.multiAssetDeclared })
      ?? dec.decideContextualDeterministic(c.candidates, c.identification, { multiAssetDeclared: c.multiAssetDeclared })
      ?? idd.decideFromIdentity(c.identity ?? null, c.candidates, { multiAssetDeclared: c.multiAssetDeclared, identifiedAssetIds: c.identification.assetIds })
      ?? opi.decideFromOperation(c.operation, c.candidates, {
        multiAssetDeclared: c.multiAssetDeclared, identifiedAssetIds: c.identification.assetIds,
        refusedAssetIds: (c.identity?.memberships ?? []).flatMap((m) => m.group.refusedAssetIds), isLiveAsset: (id) => c.index.byId.has(id),
      });
    const operationId = d && d.kind === 'APPLY' ? opi.operationOfReason(d.reason) : null;
    if (!d || d.kind !== 'APPLY' || operationId === null) continue;
    const [f] = (await pgClient.unsafe(
      `SELECT f.retained_title, to_char(f.document_date, 'YYYY-MM-DD') AS d,
              COALESCE((SELECT array_agg(a.id ORDER BY a.id) FROM to_process_actions a
                         WHERE a.account_id = f.account_id AND a.target_type = 'DOCUMENT' AND a.target_id = f.id
                           AND a.rule_code = 'LINK-ASSET' AND a.resolved_at IS NULL), '{}') AS cards
         FROM asset_files f WHERE f.id = $1 AND f.account_id = $2`, [fileId, accountId] as never[])) as unknown as Row[];
    attachments.push({
      fileId, title: (f?.retained_title as string | null) ?? null, documentDate: (f?.d as string | null) ?? null,
      operationId, assetId: d.assetId, assetName: c.index.byId.get(d.assetId)?.name ?? null,
      openCardIds: Array.isArray(f?.cards) ? (f.cards as unknown[]).map(Number).filter((x) => Number.isSafeInteger(x)) : [],
    });
  }
  const ops = await orderInvoiceCandidateOperations(accountId, limit + 1);
  remaining = remaining || ops.length > limit;
  const apercu = await cons.previewInvoiceAfterOrder(accountId, ops.slice(0, limit), today);
  const dates: OrderInvoiceDate[] = [...apercu.values()].filter((p) => p.stored !== p.expected).map((p) => ({
    operationId: p.operationId, label: p.label, current: p.stored, expected: p.expected, invoiceFileId: p.invoiceFileId,
    orderDates: p.orderDates, protectedByUser: !p.wouldChange,
  }));
  return { attachments, dates, remaining };
}

/**
 * Reprise d'UN compte. `apply` absent ou faux : à blanc (rapport, aucune écriture). Compte non éligible aux
 * traitements : rien n'est écrit (`skipped`), le constat reste rendu.
 */
export async function repriseOrderInvoice(
  accountId: number, o: { apply?: boolean; today?: string; correlationId?: string; limit?: number } = {},
): Promise<OrderInvoiceRepriseReport> {
  const limit = Math.max(1, Math.min(o.limit ?? ORDER_INVOICE_REPRISE_LIMIT, ORDER_INVOICE_REPRISE_LIMIT));
  const vide = { attachments: [] as OrderInvoiceAttachment[], dates: [] as OrderInvoiceDate[], remaining: false };
  const c = Number.isSafeInteger(accountId) && accountId > 0 ? await constat(accountId, limit, o.today) : vide;
  const report: OrderInvoiceRepriseReport = {
    accountId, applied: false, ...c, attached: 0, cardsClosed: 0, datesChanged: 0, reconsolidationChanges: 0,
    agenda: { created: 0, updated: 0, removed: 0 },
  };
  const aDater = c.dates.filter((d) => !d.protectedByUser);
  if (!o.apply || (!c.attachments.length && !aDater.length)) return report;
  const { isAccountProcessingEligible } = await import('@/services/account/processing-eligibility');
  if (!(await isAccountProcessingEligible(accountId))) return { ...report, skipped: 'ACCOUNT_INELIGIBLE' };

  const { pgClient } = await import('@/db');
  const correlationId = o.correlationId ?? `reprise-819:${accountId}`;
  const jour = o.today ? { today: o.today } : {};
  // 1. Rattachement par l'opération (T3 DOCUMENT_ASSET, déterministe) — la carte ouverte est fermée avec son motif.
  const { attachByOperation } = await import('@/services/ai/reconciliation/document-asset/operation-inheritance.store');
  const rattaches: number[] = [];
  for (const a of c.attachments) {
    const r = await attachByOperation(accountId, a.fileId);
    if (r) rattaches.push(r.fileId);
  }
  report.attached = rattaches.length;
  const cartes = c.attachments.flatMap((a) => a.openCardIds);
  if (cartes.length) {
    const [x] = (await pgClient.unsafe(
      `SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = $1 AND id = ANY($2::bigint[]) AND resolved_at IS NOT NULL`,
      [accountId, cartes] as never[])) as unknown as Array<{ n: number }>;
    report.cardsClosed = Number(x?.n ?? 0);
  }
  // 2. Opérations : documents rattachés reconsolidés (leur bien entre dans la version de leur source), puis dates.
  const { consolidateDocument, reconsolidateOperations } = await import('./consolidator');
  for (const fileId of rattaches) report.reconsolidationChanges += (await consolidateDocument(accountId, fileId, { correlationId, ...jour })).changes;
  const ids = [...new Set([...aDater.map((d) => d.operationId), ...c.attachments.filter((a) => rattaches.includes(a.fileId)).map((a) => a.operationId)])].sort((a, b) => a - b);
  report.reconsolidationChanges += await reconsolidateOperations(accountId, ids, { correlationId, ...jour });
  if (aDater.length) {
    const [x] = (await pgClient.unsafe(
      `SELECT count(*)::int AS n FROM business_operations o JOIN unnest($2::bigint[], $3::text[]) AS v(id, d) ON v.id = o.id
        WHERE o.account_id = $1 AND o.realized_date = v.d::date`,
      [accountId, aDater.map((d) => d.operationId), aDater.map((d) => d.expected)] as never[])) as unknown as Array<{ n: number }>;
    report.datesChanged = Number(x?.n ?? 0);
  }
  // 3. Agenda : l'événement d'achat existant et intact suit la date ; aucun second événement.
  if (ids.length) {
    const { projectAccountOperations } = await import('../agenda-projection/service');
    const p = await projectAccountOperations(accountId, { operationIds: ids, correlationId, ...jour });
    report.agenda = { created: p.created, updated: p.updated, removed: p.removed };
  }
  report.applied = true;
  return report;
}
