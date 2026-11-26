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
 * titre d'événement choisi par l'utilisateur ou un événement saisi, un titre
 * de provenance INCONNUE, un titre explicite ; aucune
 * création, aucune suppression, aucune date, aucun statut, aucun montant,
 * aucune relation, aucune notification, aucun appel à un fournisseur d'IA.
 *
 * À BLANC par défaut (`apply` absent) : rapport avant / après, aucune écriture.
 * BORNÉE : `limit` opérations par appel, par curseur (`afterOperationId` →
 * `nextAfterOperationId`). IDEMPOTENTE : un second passage ne trouve plus rien.
 * Carte #859 — PROVENANCE DU TITRE PAR CHAMP (`title-provenance.ts`) : la même
 * décision d'autorité que la consolidation et la projection. Une correction de
 * date (ou d'un autre champ) ne bloque plus l'amélioration d'un titre SYSTEM ;
 * chaque titre conservé porte son ÉTAT (USER confirmé, provenance INCONNUE,
 * SYSTEM sans meilleur nom) et le MOTIF précis — aucune carte « À traiter »
 * n'est créée pour la seule incertitude de provenance.
 *
 * Carte #860 — PARITÉ SIMULATION / APPLICATION : le constat et l'application
 * passent par la MÊME sélection des titres exécutables (`selectTitleOnlyActions`,
 * via `projectAccountOperations({ titleOnly })`, simulée puis réelle). Le titre
 * d'une SYNC mixte (titre + date…) est annoncé puis écrit s'il est indépendant et
 * éligible ; sinon l'événement est rendu `KEEP_TITLE_NOT_ISOLABLE` avec son motif.
 * Les compteurs écrits (`eventsRenamed`) sont ceux du RÉSULTAT RÉEL des écritures
 * (`titleWrites`) : un titre refusé par une garde ou en échec n'est jamais compté.
 *
 * DURABLE sans ce service : toute reconsolidation T3 d'un achat applique le
 * même intitulé, et le contrôle quotidien COH-AGENDA-OPERATION-PROJECTION
 * répare le titre de l'événement (SYNC, RETITLE).
 */
import type { AcquisitionNameBasis } from '@/lib/reference-events/operation-title';
import { isTitleOnlyAction, type ProjectionAction } from './model';
import type { TitleOnlyOutcome } from './service';
import { AGENDA_TITLE_EVIDENCE_COLUMNS_SQL, agendaTitleAuthorityOfRow, type TitleAuthorityDecision } from '../title-provenance';

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
   * KEEP_USER_TITLE : titre choisi par l'utilisateur, ou événement saisi — jamais touché ;
   * KEEP_UNKNOWN_PROVENANCE : provenance du titre inconnue ou contradictoire (carte #859) — rien n'est écrit ;
   * KEEP_NO_PRECISE_NAME : titre SYSTEM « Achat », mais rien de fiable ne dit ce qui a été acheté ;
   * KEEP_TITLE_NOT_ISOLABLE (carte #860) : un meilleur titre est prévu par la projection, mais il n'est pas
   *   indépendant (rattachement à venir, représentation à décider, requalification…) — motif `titleOnlyReason`.
   */
  action: 'RENAME' | 'KEEP_USER_TITLE' | 'KEEP_UNKNOWN_PROVENANCE' | 'KEEP_NO_PRECISE_NAME' | 'KEEP_TITLE_NOT_ISOLABLE';
  /** Carte #860 : motif de non-isolement du titre prévu (`selectTitleOnlyActions`) ; absent : sans objet. */
  titleOnlyReason?: string;
  /** Carte #859 : provenance du CHAMP titre (état, motif précis, preuve lue). */
  titleAuthority: TitleAuthorityDecision;
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
     * KEEP_UNKNOWN_PROVENANCE : provenance de l'intitulé inconnue ou contradictoire — conservé, motif au rapport ;
     * UP_TO_DATE : intitulé SYSTEM déjà à jour, ou aucun meilleur nom.
     * Carte #859 : l'ancien KEEP_USER_INPUT (opération portant une correction de DATE ou de type) n'existe plus — une
     * saisie d'un autre champ ne protège plus l'intitulé.
     */
    action: 'RENAME' | 'KEEP_USER_LABEL' | 'KEEP_UNKNOWN_PROVENANCE' | 'UP_TO_DATE';
    /** Carte #859 : provenance du CHAMP intitulé (null : opération sans preuve active, non recalculée). */
    titleAuthority: TitleAuthorityDecision | null;
    /** Carte #859 : nom que la règle retiendrait si l'intitulé était SYSTEM — bloqué par sa seule provenance ; null : rien de bloqué. */
    blockedExpected: string | null;
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
  /** Carte #859 : intitulés et titres conservés faute de provenance établie (aucune écriture, aucune carte). */
  keptUnknown: number;
  /** Un reste existe au-delà de la borne : relancer avec `afterOperationId = nextAfterOperationId`. */
  remaining: boolean;
  nextAfterOperationId: number | null;
  /** Écritures effectives (0 à blanc). */
  labelsRenamed: number;
  /** Carte #860 : titres d'événement RÉELLEMENT écrits (résultat relu, jamais le seul plan). */
  eventsRenamed: number;
  /**
   * Carte #860 : résultat réel de chaque titre tenté par l'application (identifiant, titre avant / après effectif,
   * titre prévu, statut RENAMED / REFUSED / FAILED / NOT_ISOLABLE, motif). Absent à blanc.
   */
  titleWrites?: TitleOnlyOutcome[];
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
  // Carte #860 : simulation du passage « titre seulement » — même sélection des titres exécutables que l'application.
  const sim = await projectAccountOperations(accountId, {
    operationIds: ids, dryRun: true, titleOnly: true, ...(today ? { today } : {}),
    labelOverrides: new Map([...noms.values()].filter((n) => n.wouldChange).map((n) => [n.operationId, n.expected])),
  });
  const plans = new Map((sim.plans ?? []).map((p) => [p.operationId, p.actions]));
  const selection = sim.titleOnly ?? [];
  const items = (await pgClient.unsafe(
    `SELECT i.id, i.business_operation_id AS op, i.title, i.start_date::text AS date, i.is_automatic,
            COALESCE(i.is_automatic_modified, false) AS modified, (i.projection_origin IS NOT DISTINCT FROM 'OPERATION') AS projected,
            ${AGENDA_TITLE_EVIDENCE_COLUMNS_SQL('i')}
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
    // Carte #860 : seuls les titres EXÉCUTABLES de la sélection unique sont annoncés (plus « tout SYNC contenant un
    // titre ») ; les titres prévus mais non isolables sont rendus avec leur motif.
    const titres = new Map<number, string>();
    const nonIsoles = new Map<number, string>();
    for (const t of selection.filter((x) => x.operationId === id)) {
      if (t.status === 'PLANNED') titres.set(t.itemId, t.plannedTitle);
      else if (t.status === 'NOT_ISOLABLE' && t.reason) nonIsoles.set(t.itemId, t.reason);
    }
    const autres = nonTitleActions(actions);
    const c = ctx.get(id) ?? { provider: null, assetNames: [], documentTitles: [] };
    const events: PurchaseTitleRepriseEvent[] = [];
    for (const i of items.filter((x) => Number(x.op) === id)) {
      const itemId = Number(i.id);
      const before = String(i.title ?? '');
      // Carte #859 : même décision d'autorité que la projection (provenance du CHAMP titre).
      const titleAuthority = agendaTitleAuthorityOfRow(i);
      const origin: PurchaseTitleRepriseEvent['origin'] = i.is_automatic !== true ? 'USER' : i.projected === true ? 'OPERATION_PROJECTION' : 'DOCUMENT';
      const base = { itemId, date: (i.date as string | null) ?? null, before, origin, titleAuthority };
      const voulu = titres.get(itemId);
      const garde = titleAuthority.authority === 'USER' ? 'KEEP_USER_TITLE' as const
        : titleAuthority.authority === 'UNKNOWN' ? 'KEEP_UNKNOWN_PROVENANCE' as const : 'KEEP_NO_PRECISE_NAME' as const;
      const motif = nonIsoles.get(itemId);
      if (voulu !== undefined && voulu !== before && titleAuthority.authority === 'SYSTEM') events.push({ ...base, after: voulu, action: 'RENAME' });
      else if (motif !== undefined && titleAuthority.authority === 'SYSTEM') events.push({ ...base, after: before, action: 'KEEP_TITLE_NOT_ISOLABLE', titleOnlyReason: motif });
      else if (motif !== undefined || isUninformativePurchaseTitle(before, c)) events.push({ ...base, after: before, action: garde, ...(motif !== undefined ? { titleOnlyReason: motif } : {}) });
    }
    const renomme = !!nom?.wouldChange;
    const autorite = nom?.titleAuthority ?? null;
    const label: PurchaseTitleRepriseOperation['label'] = {
      before: nom?.stored ?? null, after: nom?.expected ?? null, basis: renomme ? nom?.basis ?? null : null,
      action: renomme ? 'RENAME' : autorite?.authority === 'USER' ? 'KEEP_USER_LABEL' : autorite?.authority === 'UNKNOWN' ? 'KEEP_UNKNOWN_PROVENANCE' : 'UP_TO_DATE',
      titleAuthority: autorite, blockedExpected: nom?.blockedExpected ?? null,
    };
    // Carte #859 : un intitulé dont SEULE la provenance (USER, INCONNUE) empêche l'amélioration est rendu, avec son motif.
    if (renomme || events.length || !!nom?.blockedExpected) operations.push({ operationId: id, label, events, otherPendingActions: events.some((e) => e.action === 'RENAME' || e.action === 'KEEP_TITLE_NOT_ISOLABLE') ? autres : [] });
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
    keptUser: tous.filter((e) => e.action === 'KEEP_USER_TITLE').length + c.operations.filter((x) => x.label.action === 'KEEP_USER_LABEL').length,
    keptUnknown: tous.filter((e) => e.action === 'KEEP_UNKNOWN_PROVENANCE').length + c.operations.filter((x) => x.label.action === 'KEEP_UNKNOWN_PROVENANCE').length,
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
    const r = await projectAccountOperations(accountId, { operationIds: aProjeter, correlationId, runId, titleOnly: true, ...jour });
    // Carte #860 : résultat RÉEL des écritures (titre relu) — jamais un titre seulement prévu, refusé ou en échec.
    report.titleWrites = r.titleOnly ?? [];
    report.eventsRenamed = report.titleWrites.filter((t) => t.status === 'RENAMED').length;
    if (r.skipped) report.skipped = r.skipped;
  }
  report.applied = true;
  report.runId = runId;
  return report;
}
