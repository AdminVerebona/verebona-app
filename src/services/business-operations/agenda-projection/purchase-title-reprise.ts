/**
 * Carte #821 (§3, critères 1, 3, 4) — REPRISE DU STOCK : achats et événements
 * d'achat encore nommés par le seul type (« Achat ») alors que leurs sources
 * permettent d'identifier l'objet acheté (cas réel : ticket de carburant
 * rattaché à la Cupra → « Achat de carburant »).
 *
 * CORRECTION DE LIBELLÉ UNIQUEMENT. La reprise ne décide rien elle-même :
 *   1. INTITULÉ DE L'OPÉRATION : celui que la consolidation T3 retient
 *      (`previewAcquisitionNames` à blanc, `applyAcquisitionNames` en réel —
 *      même décision `acquisitionLabelDecision`). Seul l'intitulé est écrit :
 *      ni statut, ni dates, ni montants, ni sources, ni liens.
 *   2. TITRE DES ÉVÉNEMENTS : celui que la projection T4 existante planifie
 *      une fois l'intitulé corrigé (`projectAccountOperations`, simulée puis
 *      appliquée) — projection intacte : titre synchronisé ; événement
 *      automatique intact produit depuis le justificatif : renommage journalisé
 *      et restaurable (`retitleAgendaItem`). TOUJOURS sur l'événement existant.
 * La projection d'une opération n'est appliquée ici que si son plan simulé ne
 * contient QUE des changements de titre : une opération qui porte un autre
 * écart (événement à créer, à retirer, à relier, date à poser…) est signalée
 * (`otherPendingActions`) et son Agenda n'est pas touché par la reprise — ces
 * écarts relèvent des moteurs habituels, pas d'une correction de libellé.
 *
 * JAMAIS : un intitulé saisi ou corrigé par l'utilisateur (opération), un
 * événement saisi ou modifié par l'utilisateur, un titre explicite ; aucune
 * création, aucune suppression, aucune date, aucun statut, aucun montant,
 * aucune relation, aucune notification, aucun appel à un fournisseur d'IA.
 *
 * À BLANC par défaut (`apply` absent) : rapport avant / après, aucune écriture.
 * BORNÉE : `limit` opérations par appel, par curseur (`afterOperationId` →
 * `nextAfterOperationId`). IDEMPOTENTE : un second passage ne trouve plus rien.
 * DURABLE sans ce service : toute reconsolidation T3 d'un achat applique le
 * même intitulé, et le contrôle quotidien COH-AGENDA-OPERATION-PROJECTION
 * répare le titre de l'événement (SYNC, RETITLE).
 */
import type { AcquisitionNameBasis } from '@/lib/reference-events/operation-title';
import { isTitleOnlyAction, type ProjectionAction } from './model';

type Row = Record<string, unknown>;

/** Opérations examinées au plus par appel. */
export const PURCHASE_TITLE_REPRISE_LIMIT = 200;

export interface PurchaseTitleRepriseEvent {
  itemId: number;
  date: string | null;
  /** Titre enregistré, et titre après la reprise (égaux : inchangé). */
  before: string;
  after: string;
  /**
   * RENAME : titre automatique remplacé par l'intitulé de l'opération ;
   * KEEP_USER_TITLE : événement saisi ou modifié par l'utilisateur — jamais touché ;
   * KEEP_NO_PRECISE_NAME : titre automatique « Achat », mais rien de fiable ne dit ce qui a été acheté.
   */
  action: 'RENAME' | 'KEEP_USER_TITLE' | 'KEEP_NO_PRECISE_NAME';
  /** Chemin de création de l'événement : projection de l'opération, décision T4 du justificatif, saisie. */
  origin: 'OPERATION_PROJECTION' | 'DOCUMENT' | 'USER';
}

export interface PurchaseTitleRepriseOperation {
  operationId: number;
  label: {
    before: string | null;
    after: string | null;
    /** Fondement du nouvel intitulé (désignation, catégorie de dépense, acquisition du bien) ; null : inchangé ou repli existant. */
    basis: AcquisitionNameBasis | null;
    /**
     * RENAME : intitulé du système remplacé ; KEEP_USER_LABEL : intitulé saisi ou corrigé par l'utilisateur, conservé ;
     * KEEP_USER_INPUT : l'opération porte une saisie de l'utilisateur (date ou type corrigés, déclaration, formulaire) —
     * la consolidation ne recalcule jamais ses attributs, intitulé compris ; UP_TO_DATE : rien à faire.
     */
    action: 'RENAME' | 'KEEP_USER_LABEL' | 'KEEP_USER_INPUT' | 'UP_TO_DATE';
  };
  events: PurchaseTitleRepriseEvent[];
  /** Autres écarts de projection de cette opération (aucun rapport avec le titre) : son Agenda n'est pas touché par la reprise. */
  otherPendingActions: string[];
}

export interface PurchaseTitleRepriseReport {
  accountId: number;
  applied: boolean;
  /** Achats examinés dans cet appel, et achats rendus (un intitulé ou un titre à corriger, ou conservé avec son motif). */
  examined: number;
  operations: PurchaseTitleRepriseOperation[];
  /** Totaux du constat (à blanc comme en réel). */
  labelsToRename: number;
  eventsToRename: number;
  keptUser: number;
  /** Un reste existe au-delà de la borne : relancer avec `afterOperationId = nextAfterOperationId`. */
  remaining: boolean;
  nextAfterOperationId: number | null;
  /** Écritures effectives (0 à blanc). */
  labelsRenamed: number;
  eventsRenamed: number;
  /** Identifiant de l'exécution (journal des renommages restaurables). */
  runId?: string;
  skipped?: string;
}

/** Le plan ne contient-il QUE des changements de titre ? Rend les autres actions (vide : oui). Pure. */
export function nonTitleActions(actions: readonly ProjectionAction[]): string[] {
  const autres: string[] = [];
  for (const a of actions) {
    // Carte #832 (§ 3.C) : UNE seule règle pour « cette action ne change qu'un titre »,
    // partagée avec le passage « titre seulement » de la projection (`isTitleOnlyAction`).
    if (isTitleOnlyAction(a)) continue;
    if (a.kind === 'SUPPRESSED') continue;
    if (a.kind === 'ABSTAIN' && !a.candidates?.length) continue;
    autres.push(a.kind);
  }
  return [...new Set(autres)].sort();
}

const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((x) => Number.isSafeInteger(x)) : []);

/** Constat (lecture seule, aucune IA) : mêmes règles que la consolidation T3 et la projection T4, rejouées à blanc. */
async function constat(accountId: number, afterId: number, limit: number, today?: string): Promise<Pick<PurchaseTitleRepriseReport, 'examined' | 'operations' | 'remaining' | 'nextAfterOperationId'>> {
  const { pgClient } = await import('@/db');
  const page = nums((await pgClient.unsafe(
    `SELECT o.id FROM business_operations o
      WHERE o.account_id = $1 AND o.id > $2 AND o.type_code = 'ACQUISITION' AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
      ORDER BY o.id LIMIT $3`, [accountId, afterId, limit + 1] as never[]) as unknown as Row[]).map((x) => x.id));
  const ids = page.slice(0, limit);
  const remaining = page.length > limit;
  if (!ids.length) return { examined: 0, operations: [], remaining: false, nextAfterOperationId: null };
  const { previewAcquisitionNames } = await import('../consolidation/consolidator');
  const noms = await previewAcquisitionNames(accountId, ids, today);
  const { projectAccountOperations } = await import('./service');
  const { isUninformativePurchaseTitle } = await import('./model');
  const sim = await projectAccountOperations(accountId, {
    operationIds: ids, dryRun: true, ...(today ? { today } : {}),
    labelOverrides: new Map([...noms.values()].filter((n) => n.wouldChange).map((n) => [n.operationId, n.expected])),
  });
  const plans = new Map((sim.plans ?? []).map((p) => [p.operationId, p.actions]));
  const items = (await pgClient.unsafe(
    `SELECT i.id, i.business_operation_id AS op, i.title, i.start_date::text AS date, i.is_automatic,
            COALESCE(i.is_automatic_modified, false) AS modified, (i.projection_origin IS NOT DISTINCT FROM 'OPERATION') AS projected
       FROM agenda_items i
      WHERE i.account_id = $1 AND i.business_operation_id = ANY($2::bigint[])
      ORDER BY i.id`, [accountId, `{${ids.join(',')}}`] as never[])) as unknown as Row[];
  const contexte = (await pgClient.unsafe(
    `SELECT o.id, o.provider,
            COALESCE((SELECT array_agg(a.name ORDER BY a.id) FROM business_operation_asset_links l
                        JOIN assets a ON a.id = l.asset_id AND a.account_id = o.account_id AND a.deleted_at IS NULL
                       WHERE l.operation_id = o.id AND l.active), '{}') AS asset_names,
            COALESCE((SELECT array_agg(DISTINCT t.titre) FROM business_operation_sources s
                        JOIN asset_files f ON f.id::text = s.source_entity_key AND f.account_id = o.account_id AND f.deleted_at IS NULL
                        LEFT JOIN document_extractions e ON e.file_id = f.id AND e.account_id = o.account_id
                        CROSS JOIN LATERAL (VALUES (f.retained_title), (e.title)) AS t(titre)
                       WHERE s.operation_id = o.id AND s.active AND s.source_kind = 'DOCUMENT' AND NULLIF(btrim(t.titre), '') IS NOT NULL), '{}') AS document_titles
       FROM business_operations o WHERE o.account_id = $1 AND o.id = ANY($2::bigint[])`, [accountId, `{${ids.join(',')}}`] as never[])) as unknown as Row[];
  const textes = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []);
  const ctx = new Map(contexte.map((c) => [Number(c.id), { provider: (c.provider as string | null) ?? null, assetNames: textes(c.asset_names), documentTitles: textes(c.document_titles) }]));

  const operations: PurchaseTitleRepriseOperation[] = [];
  for (const id of ids) {
    const nom = noms.get(id);
    const actions = plans.get(id) ?? [];
    const titres = new Map<number, string>();
    for (const a of actions) {
      if (a.kind === 'RETITLE') titres.set(a.itemId, a.title);
      if (a.kind === 'SYNC' && a.changes.title !== undefined) titres.set(a.itemId, a.changes.title);
    }
    const autres = nonTitleActions(actions);
    const c = ctx.get(id) ?? { provider: null, assetNames: [], documentTitles: [] };
    const events: PurchaseTitleRepriseEvent[] = [];
    for (const i of items.filter((x) => Number(x.op) === id)) {
      const itemId = Number(i.id);
      const before = String(i.title ?? '');
      const touche = i.is_automatic !== true || i.modified === true;
      const origin: PurchaseTitleRepriseEvent['origin'] = i.is_automatic !== true ? 'USER' : i.projected === true ? 'OPERATION_PROJECTION' : 'DOCUMENT';
      const base = { itemId, date: (i.date as string | null) ?? null, before, origin };
      const voulu = titres.get(itemId);
      if (voulu !== undefined && voulu !== before && !touche) events.push({ ...base, after: voulu, action: 'RENAME' });
      else if (isUninformativePurchaseTitle(before, c)) events.push({ ...base, after: before, action: touche ? 'KEEP_USER_TITLE' : 'KEEP_NO_PRECISE_NAME' });
    }
    const renomme = !!nom?.wouldChange;
    const label: PurchaseTitleRepriseOperation['label'] = {
      before: nom?.stored ?? null, after: nom?.expected ?? null, basis: renomme ? nom?.basis ?? null : null,
      action: renomme ? 'RENAME' : nom && !nom.systemLabel ? 'KEEP_USER_LABEL' : nom && !nom.fullyManaged ? 'KEEP_USER_INPUT' : 'UP_TO_DATE',
    };
    if (renomme || events.length) operations.push({ operationId: id, label, events, otherPendingActions: events.some((e) => e.action === 'RENAME') ? autres : [] });
  }
  return { examined: ids.length, operations, remaining, nextAfterOperationId: remaining ? ids[ids.length - 1] : null };
}

/**
 * Reprise d'UN compte. `apply` absent ou faux : à blanc (rapport avant / après, aucune écriture). Compte non éligible
 * aux traitements : rien n'est écrit (`skipped`), le constat reste rendu.
 */
export async function reprisePurchaseTitles(
  accountId: number, o: { apply?: boolean; today?: string; correlationId?: string; limit?: number; afterOperationId?: number } = {},
): Promise<PurchaseTitleRepriseReport> {
  const limit = Math.max(1, Math.min(o.limit ?? PURCHASE_TITLE_REPRISE_LIMIT, PURCHASE_TITLE_REPRISE_LIMIT));
  const apres = Number.isSafeInteger(o.afterOperationId) && (o.afterOperationId as number) > 0 ? (o.afterOperationId as number) : 0;
  const c = Number.isSafeInteger(accountId) && accountId > 0
    ? await constat(accountId, apres, limit, o.today)
    : { examined: 0, operations: [] as PurchaseTitleRepriseOperation[], remaining: false, nextAfterOperationId: null };
  const tous = c.operations.flatMap((x) => x.events);
  const report: PurchaseTitleRepriseReport = {
    accountId, applied: false, ...c,
    labelsToRename: c.operations.filter((x) => x.label.action === 'RENAME').length,
    eventsToRename: tous.filter((e) => e.action === 'RENAME').length,
    keptUser: tous.filter((e) => e.action === 'KEEP_USER_TITLE').length + c.operations.filter((x) => x.label.action === 'KEEP_USER_LABEL' || x.label.action === 'KEEP_USER_INPUT').length,
    labelsRenamed: 0, eventsRenamed: 0,
  };
  if (!o.apply || (!report.labelsToRename && !report.eventsToRename)) return report;
  const { isAccountProcessingEligible } = await import('@/services/account/processing-eligibility');
  if (!(await isAccountProcessingEligible(accountId))) return { ...report, skipped: 'ACCOUNT_INELIGIBLE' };

  const { randomUUID } = await import('node:crypto');
  const runId = randomUUID();
  const correlationId = o.correlationId ?? `reprise-821:${accountId}`;
  const jour = o.today ? { today: o.today } : {};
  // 1. Intitulé des opérations : écriture du SEUL intitulé (historique : avant, après, motif).
  const { applyAcquisitionNames } = await import('../consolidation/consolidator');
  const ecrits = await applyAcquisitionNames(accountId, c.operations.filter((x) => x.label.action === 'RENAME').map((x) => x.operationId), { correlationId, ...jour });
  report.labelsRenamed = ecrits.length;
  // 2. Titre des événements : projection T4 en passage « TITRE SEULEMENT ».
  //
  // Carte #832 (§ 3.C) — avant, les opérations dont le plan simulé contenait une AUTRE action
  // (`otherPendingActions` : un événement à créer, une date à poser, une représentation à décider)
  // étaient écartées : leur titre trompeur restait tel quel, alors que le corriger est sûr et
  // indépendant. Désormais toutes les opérations à renommer sont projetées, avec `titleOnly` :
  // seules les actions qui ne changent qu'un intitulé sont appliquées, les autres écarts restent
  // entiers pour la projection ordinaire. `otherPendingActions` reste au rapport, comme
  // information — il ne bloque plus la correction.
  const aProjeter = c.operations.filter((x) => x.events.some((e) => e.action === 'RENAME')).map((x) => x.operationId);
  if (aProjeter.length) {
    const { projectAccountOperations } = await import('./service');
    await projectAccountOperations(accountId, { operationIds: aProjeter, correlationId, runId, titleOnly: true, ...jour });
    const voulus = new Map(c.operations.filter((x) => aProjeter.includes(x.operationId)).flatMap((x) => x.events.filter((e) => e.action === 'RENAME').map((e) => [e.itemId, e.after] as const)));
    const { pgClient } = await import('@/db');
    const lus = (await pgClient.unsafe(
      `SELECT id, title FROM agenda_items WHERE account_id = $1 AND id = ANY($2::bigint[])`, [accountId, `{${[...voulus.keys()].join(',')}}`] as never[])) as unknown as Row[];
    report.eventsRenamed = lus.filter((r) => voulus.get(Number(r.id)) === String(r.title ?? '')).length;
  }
  report.applied = true;
  report.runId = runId;
  return report;
}
