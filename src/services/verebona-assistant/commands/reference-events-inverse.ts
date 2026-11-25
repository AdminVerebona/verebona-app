/**
 * GESTES INVERSES sur les ÉVÉNEMENTS DE RÉFÉRENCE — passage 114AB (Trello #753).
 *
 * Le point d'écriture unique de la carte #744 (`operation-write.facade`) sait déjà les faire ; ils n'étaient
 * pas exposés à l'Assistant. Ce ne sont pas des capacités W du CDC : ce sont les INVERSES de W23 à W26.
 *
 *   RESTORE_REFERENCE_EVENT          rétablir un événement supprimé   (inverse de W23) ;
 *   DISSOCIATE_REFERENCE_EVENTS      dissocier deux événements        (inverse de W24) ;
 *   UNLINK_DOCUMENT_REFERENCE_EVENT  retirer un document              (inverse de W25) ;
 *   UNLINK_SUPPLIER_REFERENCE_EVENT  retirer un fournisseur           (inverse de W26) ;
 *   LINK_AGENDA_REFERENCE_EVENT      rattacher une échéance de l'Agenda.
 *
 * Mêmes règles que les gestes directs, sans exception : plan figé, annonce avant écriture, confirmation,
 * état RELU avant d'écrire, écriture par la façade métier seule (acteur « utilisateur », canal
 * « Assistant », clé d'idempotence du plan), chaque résultat traduit en phrase claire — jamais un code,
 * jamais le mot interdit. AUCUN fichier de `src/services/business-operations/` n'est modifié.
 *
 * Lecture : la façade reste le seul écrivain ; les lectures passent par le lecteur canonique de l'Assistant,
 * SAUF celle des événements SUPPRIMÉS (le lecteur canonique ne rend que les actifs) : elle est faite ici,
 * bornée au compte, en lecture seule, et limitée aux suppressions faites PAR L'UTILISATEUR — les seules que
 * la façade accepte de rétablir.
 */
import { pgClient } from '@/db';
import { USER_INVALIDATION_REASON } from '@/services/business-operations/model';
import type { BusinessOperationStatus, BusinessOperationTypeCode } from '@/services/business-operations/model';
import { referenceEventLabel } from '@/services/documents/business-period-surfaces';
import { formatDateFr } from '../core/deterministic-format';
import type { AssistantRequestInput } from '../types/contracts';
import type { ActionResult, CommandParams, PlannedAction } from './catalog';
import type { ExecutionContext } from './executors';
import { documentDesigne, fournisseurDesigne, type CommandLookup } from './plan.service';
import type { ReferenceEventDraft } from './reference-event-parser';
import {
  REFERENCE_EVENT_CHANGED_SINCE_PREVIEW, REFERENCE_EVENT_NOT_FOUND, matchReferenceEvents, relationBetween,
  translateWriteResult, type ReferenceEventParams, type ReferenceEventQuery, type ReferenceEventState,
} from './reference-event-model';

type Resolution = PlannedAction | { needInfo: string };
const IMPOSSIBLE = 'Je ne peux pas faire cette modification depuis l’assistant.';

// ── Lecture des événements SUPPRIMÉS (compte borné, lecture seule) ──────────

interface LigneSupprimee {
  id: number; typeCode: string | null; status: string; technicalLabel: string | null; provider: string | null;
  plannedDate: string | null; startDate: string | null; realizedDate: string | null; endDate: string | null;
  version: number; assetIds: number[] | null; assetNames: string[] | null;
}

const PAGE_SUPPRIMES = 500;

/**
 * Événements de référence SUPPRIMÉS PAR L'UTILISATEUR dans ce compte, qui répondent à la désignation.
 *
 * Seuls ceux-là sont lus : une suppression faite pour une autre raison (preuves retirées, regroupement)
 * n'est pas rétablissable par la façade, et un événement d'un autre compte n'est jamais atteint.
 *
 * Carte #807 (E06) — règle remplacée (carte #807) : « les 500 derniers au plus ». Toutes les suppressions de
 * l'utilisateur sont parcourues, par curseur (identifiant décroissant), page après page ; seules celles qui
 * répondent sont gardées. Temps borné : au-delà, échec EXPLICITE (`ReferenceEventSearchIncomplete`), jamais
 * une liste tronquée. `onlyId` : lecture directe d'UNE opération supprimée (recontrôle avant écriture).
 */
export async function sqlFindInvalidatedReferenceEvents(
  accountId: number, q: ReferenceEventQuery, opts: { budgetMs?: number; now?: () => number; onlyId?: number } = {},
): Promise<ReferenceEventState[]> {
  const { REFERENCE_EVENT_SEARCH_BUDGET_MS, ReferenceEventSearchIncomplete } = await import('./reference-events');
  const now = opts.now ?? Date.now;
  const fin = now() + (opts.budgetMs ?? REFERENCE_EVENT_SEARCH_BUDGET_MS);
  const trouves: ReferenceEventState[] = [];
  let avant: number | null = null;
  for (;;) {
    const lignes = (await pgClient.unsafe(
      `SELECT o.id, o.type_code AS "typeCode", o.status, o.technical_label AS "technicalLabel", o.provider,
              o.planned_date::text AS "plannedDate", o.start_date::text AS "startDate",
              o.realized_date::text AS "realizedDate", o.end_date::text AS "endDate", o.version,
              (SELECT array_agg(l.asset_id ORDER BY l.asset_id) FROM business_operation_asset_links l
                WHERE l.operation_id = o.id AND l.active) AS "assetIds",
              (SELECT array_agg(a.name ORDER BY a.id) FROM business_operation_asset_links l
                 JOIN assets a ON a.id = l.asset_id AND a.account_id = o.account_id AND a.deleted_at IS NULL
                WHERE l.operation_id = o.id AND l.active) AS "assetNames"
         FROM business_operations o
        WHERE o.account_id = $1 AND o.invalidated_at IS NOT NULL AND o.invalidation_reason = $2
          AND o.merged_into_operation_id IS NULL
          AND ($3::bigint IS NULL OR o.id < $3::bigint) AND ($4::bigint IS NULL OR o.id = $4::bigint)
        ORDER BY o.id DESC LIMIT ${PAGE_SUPPRIMES}`,
      [accountId, USER_INVALIDATION_REASON, avant, opts.onlyId ?? null] as never[],
    )) as unknown as LigneSupprimee[];
    trouves.push(...matchReferenceEvents(lignes.map(toState), q));
    if (lignes.length < PAGE_SUPPRIMES) return trouves;
    avant = Number(lignes[lignes.length - 1].id);
    if (now() > fin) throw new ReferenceEventSearchIncomplete();
  }
}

/** UN événement de référence supprimé par l'utilisateur, dans ce compte ; `null` sinon (lecture directe, sans plafond). */
export async function sqlGetInvalidatedReferenceEventState(accountId: number, operationId: number): Promise<ReferenceEventState | null> {
  const [etat] = await sqlFindInvalidatedReferenceEvents(accountId, { typeCode: null, words: [], date: null }, { onlyId: operationId });
  return etat ?? null;
}

function toState(r: LigneSupprimee): ReferenceEventState {
  const noms = r.assetNames ?? [];
  return {
    id: Number(r.id), typeCode: (r.typeCode as BusinessOperationTypeCode | null) ?? null, status: r.status as BusinessOperationStatus,
    label: referenceEventLabel({ typeCode: r.typeCode as BusinessOperationTypeCode | null, technicalLabel: r.technicalLabel, provider: r.provider, firstDocumentTitle: null }),
    technicalLabel: r.technicalLabel, provider: r.provider,
    plannedDate: r.plannedDate, startDate: r.startDate, realizedDate: r.realizedDate, endDate: r.endDate,
    assets: (r.assetIds ?? []).map((id, i) => ({ id: Number(id), name: noms[i] ?? '' })).filter((a) => a.name !== ''),
    documentTitles: [], version: Number(r.version), invalidated: true,
  };
}

// ── Désignation ────────────────────────────────────────────────────────────

const cibleDe = (s: ReferenceEventState): PlannedAction['targets'][number] => ({ type: 'reference_event', id: s.id, label: s.label });

/** Événement SUPPRIMÉ unique désigné par la demande, ou la précision à demander. Jamais un choix au hasard. */
async function evenementSupprime(
  lookup: CommandLookup, input: AssistantRequestInput, cible: { typeCode: BusinessOperationTypeCode | null; words: string[]; date: string | null },
): Promise<{ state: ReferenceEventState } | { needInfo: string }> {
  if (!lookup.findInvalidatedReferenceEvents) return { needInfo: IMPOSSIBLE };
  const { designer } = await import('./reference-events');
  if (!cible.typeCode && cible.words.length === 0 && !cible.date) {
    return { needInfo: 'Quelle opération voulez-vous rétablir ? Donnez son intitulé, sa date complète ou son bien.' };
  }
  const trouves = await lookup.findInvalidatedReferenceEvents(input.accountId, cible);
  if (trouves.length === 0) {
    return { needInfo: 'Je n’ai pas trouvé d’opération supprimée qui corresponde dans votre compte. Laquelle voulez-vous rétablir ?' };
  }
  if (trouves.length > 1) {
    return { needInfo: `Plusieurs opérations supprimées correspondent : ${trouves.slice(0, 5).map(designer).join(' ; ')}. Précisez laquelle dans votre demande (intitulé, date complète ou bien).` };
  }
  return { state: trouves[0] };
}

// ── Préparation ────────────────────────────────────────────────────────────

/**
 * Rétablir un événement de référence supprimé. La façade refuse (et l'aperçu le dit) un événement qui n'a
 * plus aucune source active : rien n'est inventé pour le faire revenir.
 */
async function resolveRestore(
  draft: Extract<ReferenceEventDraft, { command: 'RESTORE_REFERENCE_EVENT' }>, input: AssistantRequestInput, lookup: CommandLookup, actionId: string,
): Promise<Resolution> {
  const cible = await evenementSupprime(lookup, input, draft.target);
  if ('needInfo' in cible) return cible;
  const s = cible.state;
  const { designer } = await import('./reference-events');
  return {
    actionId, command: 'RESTORE_REFERENCE_EVENT', dependsOn: [], targets: [cibleDe(s)],
    params: { kind: 'reference_event_restore', operationId: s.id, expectedVersion: s.version },
    preview: `Rétablir l’opération ${designer(s)}.`,
    effects: [
      `Opération : ${s.label}`,
      'Elle est de nouveau prise en compte (dépenses, réponses de l’assistant), avec ses documents et ses fournisseurs.',
      'Ses échéances détachées à la suppression ne lui sont PAS rattachées de nouveau : elles sont restées dans l’Agenda, à leur date.',
      'Pour la supprimer de nouveau, refaites une demande de suppression.',
    ],
  };
}

/** Dissocier deux événements de référence : seul le LIEN change, les deux événements restent. */
async function resolveDissociation(
  draft: Extract<ReferenceEventDraft, { command: 'DISSOCIATE_REFERENCE_EVENTS' }>, input: AssistantRequestInput, lookup: CommandLookup, actionId: string,
): Promise<Resolution> {
  const { designer, evenementDesignePublic } = await import('./reference-events');
  const premier = await evenementDesignePublic(lookup, input, draft.first, 'dissocier');
  if ('needInfo' in premier) return premier;
  const second = await evenementDesignePublic(lookup, input, draft.second, 'dissocier');
  if ('needInfo' in second) return second;
  const a = premier.state;
  const b = second.state;
  if (a.id === b.id) return { needInfo: 'Ces deux désignations correspondent à la même opération : précisez les deux opérations à dissocier.' };
  // Le sens de la relation est celui que l'association aurait posé : la façade retire le lien de la paire.
  const r = relationBetween(a, b);
  const from = r.fromOperationId === a.id ? a : b;
  const to = r.fromOperationId === a.id ? b : a;
  return {
    actionId, command: 'DISSOCIATE_REFERENCE_EVENTS', dependsOn: [], targets: [cibleDe(from), cibleDe(to)],
    params: { kind: 'reference_events_dissociate', fromOperationId: from.id, toOperationId: to.id, expectedVersions: [from.version, to.version] },
    preview: `Dissocier les opérations ${designer(a)} et ${designer(b)}.`,
    effects: [
      'Seul le lien entre ces deux opérations est retiré.',
      'Les deux opérations restent dans votre compte, avec leurs documents, leurs échéances et leurs fournisseurs.',
      'Ce retrait est votre décision : une analyse ne les associera plus d’elle-même.',
    ],
  };
}

/** Retirer un document d'un événement de référence : le document reste dans vos documents. */
async function resolveDocumentUnlink(
  draft: Extract<ReferenceEventDraft, { command: 'UNLINK_DOCUMENT_REFERENCE_EVENT' }>, input: AssistantRequestInput, lookup: CommandLookup, actionId: string,
): Promise<Resolution> {
  const { designer, evenementDesignePublic } = await import('./reference-events');
  const doc = await documentDesigne(lookup, input, draft, 'retirer');
  if ('needInfo' in doc) return doc;
  const cible = await evenementDesignePublic(lookup, input, draft.target, 'compléter');
  if ('needInfo' in cible) return cible;
  const s = cible.state;
  const d = doc.state;
  return {
    actionId, command: 'UNLINK_DOCUMENT_REFERENCE_EVENT', dependsOn: [],
    targets: [{ type: 'document', id: d.id, label: d.title }, cibleDe(s)],
    params: { kind: 'reference_event_document_unlink', operationId: s.id, linkedDocumentId: d.id, expectedVersion: s.version, documentVersion: d.version },
    preview: `Retirer le document « ${d.title} » de l’opération ${designer(s)}.`,
    effects: [
      `Document : ${d.title}${d.documentDate ? ` du ${formatDateFr(d.documentDate)}` : ''}`,
      `Opération : ${s.label}`,
      'Le document reste dans vos documents et garde ses autres rattachements : il n’est pas supprimé.',
      'Ce qu’il justifiait sur cette opération n’est plus pris en compte ; les montants de l’opération sont recalculés.',
      'Ce retrait est votre décision : une analyse ne le rattachera plus d’elle-même.',
    ],
  };
}

/** Retirer un fournisseur d'un événement de référence : sa fiche et ses autres liens restent. */
async function resolveSupplierUnlink(
  draft: Extract<ReferenceEventDraft, { command: 'UNLINK_SUPPLIER_REFERENCE_EVENT' }>, input: AssistantRequestInput, lookup: CommandLookup, actionId: string,
): Promise<Resolution> {
  const { designer, evenementDesignePublic } = await import('./reference-events');
  const fournisseur = await fournisseurDesigne(lookup, input.accountId, draft.supplierWords, 'retirer');
  if ('needInfo' in fournisseur) return fournisseur;
  const cible = await evenementDesignePublic(lookup, input, draft.target, 'compléter');
  if ('needInfo' in cible) return cible;
  const s = cible.state;
  const f = fournisseur.state;
  return {
    actionId, command: 'UNLINK_SUPPLIER_REFERENCE_EVENT', dependsOn: [],
    targets: [{ type: 'supplier', id: f.id, label: f.name }, cibleDe(s)],
    params: { kind: 'reference_event_supplier_unlink', operationId: s.id, linkedSupplierId: f.id, expectedVersion: s.version, supplierVersion: f.version },
    preview: `Retirer le fournisseur « ${f.name} » de l’opération ${designer(s)}.`,
    effects: [
      `Fournisseur : ${f.name}`,
      `Opération : ${s.label}`,
      'La fiche du fournisseur, ses documents et ses autres liens sont conservés : rien n’est supprimé.',
      'Ce retrait est votre décision : une analyse ne le reliera plus d’elle-même.',
    ],
  };
}

/** Rattacher une échéance de l'Agenda à un événement de référence : elle garde sa date et ses rappels. */
async function resolveAgendaLink(
  draft: Extract<ReferenceEventDraft, { command: 'LINK_AGENDA_REFERENCE_EVENT' }>, input: AssistantRequestInput, lookup: CommandLookup, actionId: string,
): Promise<Resolution> {
  const { designer, evenementDesignePublic } = await import('./reference-events');
  if (!lookup.findAgendaItems) return { needInfo: IMPOSSIBLE };
  const trouves = await lookup.findAgendaItems(input.accountId, { words: draft.itemWords, date: draft.itemDate, assetIds: [] });
  if (trouves.length === 0) return { needInfo: 'Je n’ai pas trouvé cette échéance dans votre compte. Laquelle voulez-vous rattacher ?' };
  if (trouves.length > 1) {
    const liste = trouves.slice(0, 5).map((c) => `« ${c.title} »${c.startDate ? ` du ${formatDateFr(c.startDate)}` : ''}`).join(', ');
    return { needInfo: `Plusieurs échéances correspondent : ${liste}. Précisez laquelle dans votre demande (titre ou date complète).` };
  }
  const item = trouves[0];
  const cible = await evenementDesignePublic(lookup, input, draft.target, 'compléter');
  if ('needInfo' in cible) return cible;
  const s = cible.state;
  return {
    actionId, command: 'LINK_AGENDA_REFERENCE_EVENT', dependsOn: [],
    targets: [{ type: 'agenda_item', id: item.id, label: item.title }, cibleDe(s)],
    params: { kind: 'reference_event_agenda', operationId: s.id, agendaItemId: item.id, expectedVersion: s.version, agendaItemVersion: item.version },
    preview: `Rattacher l’échéance « ${item.title} »${item.startDate ? ` du ${formatDateFr(item.startDate)}` : ''} à l’opération ${designer(s)}.`,
    effects: [
      `Échéance : ${item.title}${item.startDate ? ` du ${formatDateFr(item.startDate)}` : ''}`,
      `Opération : ${s.label}`,
      'L’échéance garde son identité, sa date et ses rappels : aucune échéance n’est créée ni copiée.',
      'Si elle est déjà rattachée à une autre opération, elle est partagée : elle n’est ni déplacée ni dupliquée.',
      'Ce rattachement est votre décision : il ne sera pas défait par une analyse.',
    ],
  };
}

/**
 * Carte #807 (E09, décision du PO du 17/11, carte #806) — « Déplace le document X de l'opération A vers
 * l'opération B ». Il n'existe PAS de geste « déplacer » : l'Assistant propose les DEUX gestes du catalogue,
 * dans l'ordre et confirmés ensemble — « Retirer de A », puis « Rattacher à B » (exécuté seulement si le
 * retrait a réussi). Un seul fichier, jamais une copie ; ses autres rattachements ne sont pas touchés.
 * Sans opération d'origine nommée, la demande est AMBIGUË (déplacer ou ajouter ?) : une question, aucun plan.
 */
async function resolveDocumentTransferRequest(
  draft: Extract<ReferenceEventDraft, { command: 'DOCUMENT_REFERENCE_EVENT_TRANSFER_REQUEST' }>, input: AssistantRequestInput, lookup: CommandLookup, actionId: string,
): Promise<PlannedAction[] | { needInfo: string }> {
  if (!draft.from) {
    return { needInfo: 'Voulez-vous déplacer ce document (le retirer de son opération actuelle, puis le rattacher à l’autre) ou seulement l’ajouter à cette opération en le laissant aussi dans la première ? Pour le déplacer, écrivez « Déplace le document … de l’opération … vers l’opération … » ; pour l’ajouter, « Rattache le document … à l’opération … ».' };
  }
  const retrait = await resolveDocumentUnlink({ command: 'UNLINK_DOCUMENT_REFERENCE_EVENT', documentWords: draft.documentWords, documentFromContext: draft.documentFromContext, target: draft.from }, input, lookup, actionId);
  if ('needInfo' in retrait) return retrait;
  const { resolveReferenceEventCommand } = await import('./reference-events');
  const ajout = await resolveReferenceEventCommand({ command: 'LINK_DOCUMENT_REFERENCE_EVENT', documentWords: draft.documentWords, documentFromContext: draft.documentFromContext, target: draft.to }, input, lookup, `${actionId}b`);
  if ('needInfo' in ajout) return ajout;
  const de = (retrait.params as Params<'reference_event_document_unlink'>).operationId;
  const vers = (ajout.params as Params<'reference_event_document'>).operationId;
  if (de === vers) return { needInfo: 'Ces deux désignations correspondent à la même opération : précisez l’opération d’origine et l’opération de destination.' };
  return [
    { ...retrait, effects: [...retrait.effects, 'Premier des deux gestes de ce déplacement : « Retirer », puis « Rattacher ». Il n’existe pas de geste unique « déplacer ».'] },
    // Carte #843 (E09) : les deux gestes sont exécutés ensemble, dans une seule écriture (texte à valider par le PO).
    { ...ajout, dependsOn: [retrait.actionId], effects: [...ajout.effects, DOCUMENT_TRANSFER_ATOMIC_EFFECT] },
  ];
}

/** Carte #843 (E09) — conséquence annoncée du second geste d'un déplacement (texte à valider par le PO). */
export const DOCUMENT_TRANSFER_ATOMIC_EFFECT = 'Second geste : les deux gestes sont faits ensemble. Si le rattachement à cette opération échoue, le retrait est annulé et le document reste rattaché à la première. C’est le même document : aucun fichier n’est copié.';

/** Résout un brouillon de geste inverse en action figée — ou dit ce qui manque. */
export async function resolveInverseReferenceEventCommand(
  draft: Extract<ReferenceEventDraft, {
    command: 'RESTORE_REFERENCE_EVENT' | 'DISSOCIATE_REFERENCE_EVENTS' | 'UNLINK_DOCUMENT_REFERENCE_EVENT'
      | 'UNLINK_SUPPLIER_REFERENCE_EVENT' | 'LINK_AGENDA_REFERENCE_EVENT' | 'DOCUMENT_REFERENCE_EVENT_TRANSFER_REQUEST';
  }>,
  input: AssistantRequestInput, lookup: CommandLookup, actionId: string,
): Promise<Resolution | PlannedAction[]> {
  switch (draft.command) {
    case 'DOCUMENT_REFERENCE_EVENT_TRANSFER_REQUEST': return resolveDocumentTransferRequest(draft, input, lookup, actionId);
    case 'RESTORE_REFERENCE_EVENT': return resolveRestore(draft, input, lookup, actionId);
    case 'DISSOCIATE_REFERENCE_EVENTS': return resolveDissociation(draft, input, lookup, actionId);
    case 'UNLINK_DOCUMENT_REFERENCE_EVENT': return resolveDocumentUnlink(draft, input, lookup, actionId);
    case 'UNLINK_SUPPLIER_REFERENCE_EVENT': return resolveSupplierUnlink(draft, input, lookup, actionId);
    case 'LINK_AGENDA_REFERENCE_EVENT': return resolveAgendaLink(draft, input, lookup, actionId);
    default: { const jamais: never = draft; return jamais; }
  }
}

// ── Exécution : par la façade métier, état relu avant d'écrire ─────────────

type Params<K extends ReferenceEventParams['kind']> = Extract<CommandParams, { kind: K }>;
const refuse = (a: PlannedAction, message: string): ActionResult => ({ actionId: a.actionId, status: 'REFUSED', message });
const ko = (a: PlannedAction, message: string): ActionResult => ({ actionId: a.actionId, status: 'FAILED', message });

export const INVERSE_REFERENCE_EVENT_EXECUTORS = {
  /** Rétablir : `restoreOperation`. L'état relu est celui des événements SUPPRIMÉS (le seul où il peut être). */
  async RESTORE_REFERENCE_EVENT(action: PlannedAction, ctx: ExecutionContext): Promise<ActionResult> {
    const p = action.params as Params<'reference_event_restore'>;
    const etat = await sqlGetInvalidatedReferenceEventState(ctx.accountId, p.operationId);
    if (!etat) return refuse(action, REFERENCE_EVENT_NOT_FOUND);
    if (etat.version !== p.expectedVersion) return ko(action, REFERENCE_EVENT_CHANGED_SINCE_PREVIEW);
    const { writeContext } = await import('./reference-events');
    const { restoreOperation } = await import('@/services/business-operations/operation-write.facade');
    const r = await restoreOperation(writeContext(ctx, action), { operationId: p.operationId, expectedVersion: etat.version });
    return terminer(ctx, action, translateWriteResult(action, r, {
      done: `Opération « ${etat.label} » rétablie. Ses documents et ses fournisseurs sont de nouveau pris en compte.`,
      alreadyDone: `L’opération « ${etat.label} » n’était pas supprimée : rien n’a été modifié.`,
    }, p.operationId), 'rétablissement d’une opération : elle se supprime par une nouvelle demande');
  },

  /** Dissocier : `dissociateOperations`. Les deux événements sont relus tels que présentés. */
  async DISSOCIATE_REFERENCE_EVENTS(action: PlannedAction, ctx: ExecutionContext): Promise<ActionResult> {
    const p = action.params as Params<'reference_events_dissociate'>;
    const from = await relu(ctx, action, p.fromOperationId, p.expectedVersions[0]);
    if ('actionId' in from) return from;
    const to = await relu(ctx, action, p.toOperationId, p.expectedVersions[1]);
    if ('actionId' in to) return to;
    const { writeContext } = await import('./reference-events');
    const { dissociateOperations } = await import('@/services/business-operations/operation-write.facade');
    const r = await dissociateOperations(writeContext(ctx, action), {
      operationAId: p.fromOperationId, operationBId: p.toOperationId,
      // Carte #843 (E07) : versions relues exigées par la façade DANS sa transaction.
      expectedOperationVersions: { [p.fromOperationId]: from.version, [p.toOperationId]: to.version },
    });
    return terminer(ctx, action, translateWriteResult(action, r, {
      done: `Opérations « ${from.label} » et « ${to.label} » dissociées. Elles restent toutes les deux dans votre compte.`,
      alreadyDone: `Les opérations « ${from.label} » et « ${to.label} » n’étaient pas associées : rien n’a été modifié.`,
    }, p.fromOperationId), 'dissociation de deux opérations', [{ operationId: p.fromOperationId }, { operationId: p.toOperationId }]);
  },

  /** Retirer un document : `unlinkDocument`. Événement ET document relus tels que présentés. */
  async UNLINK_DOCUMENT_REFERENCE_EVENT(action: PlannedAction, ctx: ExecutionContext): Promise<ActionResult> {
    const p = action.params as Params<'reference_event_document_unlink'>;
    const etat = await relu(ctx, action, p.operationId, p.expectedVersion);
    if ('actionId' in etat) return etat;
    const { sqlLookup } = await import('./plan.service');
    const doc = await sqlLookup.getDocumentState!(ctx.accountId, p.linkedDocumentId);
    if (!doc) return refuse(action, 'Document introuvable ou hors de votre compte.');
    if (doc.version !== p.documentVersion) return ko(action, 'Ce document a été modifié depuis l’aperçu : rien n’a été fait. Refaites votre demande.');
    const { writeContext } = await import('./reference-events');
    const { unlinkDocument } = await import('@/services/business-operations/operation-write.facade');
    const r = await unlinkDocument(writeContext(ctx, action), { operationId: p.operationId, fileId: p.linkedDocumentId, expectedOperationVersions: { [p.operationId]: etat.version } });
    return terminer(ctx, action, translateWriteResult(action, r, {
      done: `Document « ${doc.title} » retiré de l’opération « ${etat.label} ». Il reste dans vos documents.`,
      alreadyDone: `Le document « ${doc.title} » n’était pas rattaché à l’opération « ${etat.label} » : rien n’a été modifié.`,
    }, p.operationId), 'retrait d’un document d’une opération', [{ operationId: p.operationId }]);
  },

  /** Retirer un fournisseur : `unlinkSupplier`. Événement ET fournisseur relus tels que présentés. */
  async UNLINK_SUPPLIER_REFERENCE_EVENT(action: PlannedAction, ctx: ExecutionContext): Promise<ActionResult> {
    const p = action.params as Params<'reference_event_supplier_unlink'>;
    const etat = await relu(ctx, action, p.operationId, p.expectedVersion);
    if ('actionId' in etat) return etat;
    const { sqlLookup } = await import('./plan.service');
    const f = await sqlLookup.getSupplierState!(ctx.accountId, p.linkedSupplierId);
    if (!f) return refuse(action, 'Fournisseur introuvable ou hors de votre compte.');
    if (f.version !== p.supplierVersion) return ko(action, 'Ce fournisseur a été modifié depuis l’aperçu : rien n’a été fait. Refaites votre demande.');
    const { writeContext } = await import('./reference-events');
    const { unlinkSupplier } = await import('@/services/business-operations/operation-write.facade');
    const r = await unlinkSupplier(writeContext(ctx, action), { operationId: p.operationId, supplierId: p.linkedSupplierId, expectedOperationVersions: { [p.operationId]: etat.version } });
    return terminer(ctx, action, translateWriteResult(action, r, {
      done: `Fournisseur « ${f.name} » retiré de l’opération « ${etat.label} ». Sa fiche est conservée.`,
      alreadyDone: `Le fournisseur « ${f.name} » n’était pas relié à l’opération « ${etat.label} » : rien n’a été modifié.`,
    }, p.operationId), 'retrait d’un fournisseur d’une opération', [{ operationId: p.operationId }]);
  },

  /** Rattacher une échéance : `linkAgendaItem`. Événement ET échéance relus tels que présentés. */
  async LINK_AGENDA_REFERENCE_EVENT(action: PlannedAction, ctx: ExecutionContext): Promise<ActionResult> {
    const p = action.params as Params<'reference_event_agenda'>;
    const etat = await relu(ctx, action, p.operationId, p.expectedVersion);
    if ('actionId' in etat) return etat;
    const { agendaVersion, readAgendaSnapshot } = await import('./undo.service');
    const item = await readAgendaSnapshot(pgClient, ctx.accountId, p.agendaItemId);
    if (!item) return refuse(action, 'Échéance introuvable ou hors de votre compte.');
    if (agendaVersion(item) !== p.agendaItemVersion) return ko(action, 'Cette échéance a été modifiée depuis l’aperçu : rien n’a été fait. Refaites votre demande.');
    const { writeContext } = await import('./reference-events');
    const { linkAgendaItem } = await import('@/services/business-operations/operation-write.facade');
    const r = await linkAgendaItem(writeContext(ctx, action), { operationId: p.operationId, agendaItemId: p.agendaItemId, expectedOperationVersions: { [p.operationId]: etat.version } });
    return terminer(ctx, action, translateWriteResult(action, r, {
      done: `Échéance « ${item.title} » rattachée à l’opération « ${etat.label} ». Elle garde sa date et ses rappels.`,
      alreadyDone: `L’échéance « ${item.title} » était déjà rattachée à l’opération « ${etat.label} » : rien n’a été modifié.`,
    }, p.operationId), 'rattachement d’une échéance à une opération', [{ operationId: p.operationId }]);
  },
};

/**
 * Carte #843 (E09) — les deux gestes d'un DÉPLACEMENT confirmés ensemble (« Retirer de A », puis « Rattacher à B »,
 * même document, le second dépendant du premier) sont exécutés ATOMIQUEMENT par la façade (`unlinkThenLinkDocument`,
 * une transaction) : si le rattachement à B échoue — B supprimée, d'un autre compte, version périmée, panne —, le
 * retrait de A est annulé avec lui : le document reste rattaché à A. Règle remplacée (#807) : « le second geste
 * s'exécute seulement si le premier a réussi » — sans retour arrière, une panne du second perdait le lien à A.
 *
 * Rend les DEUX résultats, dans l'ordre des actions.
 */
export function isDocumentTransferPair(first: PlannedAction, second: PlannedAction | undefined): boolean {
  if (!second || first.command !== 'UNLINK_DOCUMENT_REFERENCE_EVENT' || second.command !== 'LINK_DOCUMENT_REFERENCE_EVENT') return false;
  const a = first.params as Params<'reference_event_document_unlink'>;
  const b = second.params as Params<'reference_event_document'>;
  return second.dependsOn.includes(first.actionId) && a.linkedDocumentId === b.linkedDocumentId && a.operationId !== b.operationId
    && !(b as { operationFromAction?: string }).operationFromAction;
}

export async function executeDocumentTransfer(unlink: PlannedAction, link: PlannedAction, ctx: ExecutionContext): Promise<[ActionResult, ActionResult]> {
  const pa = unlink.params as Params<'reference_event_document_unlink'>;
  const pb = link.params as Params<'reference_event_document'>;
  const sauté = (r: ActionResult): ActionResult => ({
    actionId: link.actionId, status: 'SKIPPED_DEPENDENCY',
    message: `${link.preview.replace(/\.$/, '')} — non exécutée : l’action ${unlink.actionId} n’a pas réussi (${r.status === 'REFUSED' ? 'refusée' : 'échec'}).`,
  });
  const de = await relu(ctx, unlink, pa.operationId, pa.expectedVersion);
  if ('actionId' in de) return [de, sauté(de)];
  const vers = await relu(ctx, link, pb.operationId, pb.expectedVersion);
  if ('actionId' in vers) return [{ ...vers, actionId: unlink.actionId }, sauté(vers)];
  const { sqlLookup } = await import('./plan.service');
  const doc = await sqlLookup.getDocumentState!(ctx.accountId, pa.linkedDocumentId);
  if (!doc) { const r = refuse(unlink, 'Document introuvable ou hors de votre compte.'); return [r, sauté(r)]; }
  if (doc.version !== pa.documentVersion || doc.version !== pb.documentVersion) {
    const r: ActionResult = { ...ko(unlink, 'Ce document a été modifié depuis l’aperçu : rien n’a été fait. Refaites votre demande.'), conflict: true };
    return [r, sauté(r)];
  }
  const { writeContext } = await import('./reference-events');
  const { unlinkThenLinkDocument } = await import('@/services/business-operations/operation-write.facade');
  const r = await unlinkThenLinkDocument(writeContext(ctx, unlink), {
    fileId: pa.linkedDocumentId, fromOperationId: pa.operationId, toOperationId: pb.operationId,
    expectedOperationVersions: { [pa.operationId]: de.version, [pb.operationId]: vers.version },
  });
  if (r.status !== 'APPLIED') {
    const echec = translateWriteResult(unlink, r, { done: '', alreadyDone: '' });
    const message = `${echec.message.replace(/\.$/, '')}. Le document « ${doc.title} » reste rattaché à l’opération « ${de.label} » : le déplacement n’a pas eu lieu.`;
    const premier: ActionResult = { ...echec, message };
    return [premier, sauté(premier)];
  }
  const premier = await terminer(ctx, unlink, { actionId: unlink.actionId, status: 'SUCCESS', entity: { type: 'reference_event', id: pa.operationId },
    message: `Document « ${doc.title} » retiré de l’opération « ${de.label} ». Il reste dans vos documents.` },
  'retrait d’un document d’une opération', [{ operationId: pa.operationId }]);
  const second = await terminer(ctx, link, { actionId: link.actionId, status: 'SUCCESS', entity: { type: 'reference_event', id: pb.operationId },
    message: `Document « ${doc.title} » rattaché à l’opération « ${vers.label} ».` },
  'rattachement d’un document à une opération', [{ operationId: pb.operationId }]);
  return [premier, second];
}

/** État relu d'un événement ACTIF (même règle que les gestes directs) — réutilisé ici. */
async function relu(ctx: ExecutionContext, action: PlannedAction, operationId: number, expectedVersion: number): Promise<ReferenceEventState | ActionResult> {
  const { sqlLookup } = await import('./plan.service');
  const etat = await sqlLookup.getReferenceEventState!(ctx.accountId, operationId);
  if (!etat) return refuse(action, REFERENCE_EVENT_NOT_FOUND);
  // Carte #843 (E07) : conflit EXPLICITE — les données sont relues et l'action reproposée (nouvelle confirmation).
  if (etat.version !== expectedVersion && etat.version !== ctx.referenceEventVersions?.get(operationId)) return { ...ko(action, REFERENCE_EVENT_CHANGED_SINCE_PREVIEW), conflict: true };
  return etat;
}

/** Fin d'une action : aucun « Annuler » promis, et la version écrite par CE plan est retenue. */
async function terminer(
  ctx: ExecutionContext, action: PlannedAction, r: ActionResult, reason: string, ecrits: Array<{ operationId: number; version?: number }> = [],
): Promise<ActionResult> {
  if (r.status !== 'SUCCESS') return r;
  ctx.recordUndo?.({ actionId: action.actionId, reversible: false, reason });
  if (ctx.referenceEventVersions) {
    const { sqlLookup } = await import('./plan.service');
    for (const e of ecrits) {
      const version = e.version ?? (await sqlLookup.getReferenceEventState!(ctx.accountId, e.operationId).catch(() => null))?.version;
      if (version !== undefined) ctx.referenceEventVersions.set(e.operationId, version);
    }
  }
  return r;
}
