/**
 * FAÇADE MÉTIER D'ÉCRITURE DU GRAPHE DES ÉVÉNEMENTS DE RÉFÉRENCE (lot 114O,
 * carte Trello #744, CDC « Opérations / Agenda V2.0 » §4, §7, §9, §19, §20 ;
 * lot B « identité et graphe canonique »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * À QUOI ELLE SERT
 *
 * CDC §20 : « un service métier central est responsable des mutations ;
 * T1/T2/T3/T4 et UI n'écrivent pas chacun leur propre variante de ces
 * relations ». Cette façade est CE point d'entrée pour les relations du
 * graphe. Elle est destinée à être appelée par :
 *   · les routes de la future fiche (lot D) ;
 *   · les cartes « À traiter » (lot C) ;
 *   · l'Assistant, commandes d'écriture W21 à W26 (carte #753) — après
 *     confirmation de l'utilisateur, acteur `USER` / canal `ASSISTANT` ;
 *   · T3 / T4 (lot C / E), acteur `AI`.
 * Aucune route ne doit réécrire ces règles : elle appelle une commande.
 *
 * COMMANDES LIVRÉES (lot B) — treize fonctions, toutes de la forme
 * `commande(ctx: OperationWriteContext, input) → Promise<OperationWriteResult<…>>`
 *
 *   L'événement de référence lui-même (UTILISATEUR seulement)
 *   createOperation         W21  créer sur DÉCLARATION de l'utilisateur (source
 *                                durable enregistrée ; ni document, ni élément
 *                                d'Agenda, ni bien, ni date exigés ; même
 *                                déclaration rejouée → l'existant est rendu) ;
 *   updateOperation         W22  corriger type, état interne, dates, prestataire,
 *                                intitulé (déclaration enregistrée comme source :
 *                                la correction n'est plus réécrite par T3) ;
 *   invalidateOperation     W23  invalider un événement créé à tort (jamais un
 *                                DELETE ; documents, éléments d'Agenda et faits
 *                                conservés ; T3 ne le réactive pas) ;
 *   restoreOperation             annuler cette invalidation.
 *
 *   Relations entre événements de référence (utilisateur, T3, T4, reprise)
 *   associateOperations     W24  associer deux événements DISTINCTS (financement
 *                                ↔ acquisition, sinistre ↔ réparation,
 *                                association) — jamais une fusion ;
 *   dissociateOperations         dissocier (utilisateur : REFUS durable ;
 *                                inférence : retrait simple).
 *
 *   Éléments d'Agenda (utilisateur, T3, T4, reprise)
 *   linkAgendaItem               rattacher (N↔N, sans rôle « principal ») ;
 *   unlinkAgendaItem             détacher (l'élément, sa date, ses rappels et
 *                                ses documents restent).
 *
 *   Documents (UTILISATEUR seulement — service unique de regroupement)
 *   linkDocument            W25  rattacher ;
 *   unlinkDocument               retirer (refus mémorisé, fichier conservé) ;
 *   moveDocument                 déplacer vers un autre événement de référence.
 *
 *   Fournisseurs (UTILISATEUR seulement — service unique `operation-suppliers`)
 *   linkSupplier            W26  relier un fournisseur du compte, avec son rôle ;
 *   unlinkSupplier               retirer (refus mémorisé, fiche conservée).
 *
 * GARDES DE CHAQUE COMMANDE (dans cet ordre ; la première qui échoue arrête)
 *   1. contexte valide (compte, acteur, canal, clé d'idempotence) → INVALID_INPUT ;
 *   2. acteur utilisateur : membre ACTIF du compte → NOT_A_MEMBER ; compte non
 *      restreint (`getEntitlements(...).canWrite`) → READ_ONLY_ACCOUNT ;
 *   3. verrou des Opérations du compte, puis rejeu par clé d'idempotence
 *      (même clé + même entrée → résultat enregistré ; même clé + autre
 *      commande ou autre entrée → CONFLICT IDEMPOTENCY_KEY_REUSED) ;
 *   4. commande réservée à l'utilisateur appelée par une inférence → USER_ONLY ;
 *   5. entrée valide (identifiants entiers positifs, dates AAAA-MM-JJ réelles,
 *      textes bornés, valeurs des référentiels) → INVALID_INPUT ;
 *   6. chaque identifiant relu DANS le compte → NOT_FOUND_IN_ACCOUNT ;
 *   7. événement de référence actif → OPERATION_INACTIVE ;
 *   8. version attendue (si fournie) → CONFLICT VERSION_MISMATCH ;
 *   9. règles propres à la commande (REFLEXIVE, NATURE_TYPE_MISMATCH,
 *      EVIDENCE_REQUIRED, USER_REJECTED, USER_RELATION_PROTECTED,
 *      NEW_EVIDENCE_AFTER_REFUSAL, NOT_LINKED, TYPE_DETAILS_PRESENT,
 *      STATUS_TRANSITION_REFUSED, NOT_RESTORABLE).
 * `checkOperationWriteAccess(accountId, userId)` (garde 2) est exportée pour
 * les routes du lot D.
 *
 * NON LIVRÉ ICI (lots C et suivants) : recherche SÉMANTIQUE d'un doublon avant
 * création et enrichissement par T2 / T3, fusion décidée par T3, scission,
 * effacement d'un champ (W27), carte « À traiter » née d'un ARBITRATION_REQUIRED,
 * mémoire empêchant T3 de créer un NOUVEL événement à partir des documents d'un
 * événement invalidé par l'utilisateur. La fusion existante reste
 * `BusinessOperationRepository.mergeOperations`.
 *
 * CONTRAT D'UNE COMMANDE (CDC §20)
 *   entrée   contexte (compte, acteur, canal), cible, preuves, version
 *            attendue (facultative), clé d'idempotence (facultative) ;
 *   sortie   `OperationWriteResult` : APPLIED (changed vrai ou faux),
 *            ARBITRATION_REQUIRED (preuve nouvelle après un refus : c'est à
 *            « À traiter » de demander, jamais à la commande de trancher),
 *            CONFLICT (version périmée, clé réutilisée), FORBIDDEN (droit,
 *            intégrité, refus de l'utilisateur), FAILED (panne : rien d'écrit).
 * Une commande ne lève JAMAIS : toute erreur devient FAILED et annule la
 * transaction entière (aucune demi-écriture présentée comme réussie, §19).
 *
 * GARANTIES
 *   · une transaction, sous le verrou des Opérations du compte (39101) — deux
 *     commandes simultanées sont sérialisées ;
 *   · ISOLATION : tout identifiant est relu DANS le compte de l'acteur ; un
 *     objet d'un autre compte est « introuvable », sans distinction (les
 *     identifiants rendus par une IA ne valent pas autorisation, §19) ;
 *   · DROITS (acteur utilisateur) : adhésion ACTIVE au compte et compte non
 *     en lecture seule (`getEntitlements(...).canWrite`) ;
 *   · REFUS de l'utilisateur jamais contourné par une inférence, jamais
 *     recréé sur les mêmes preuves (§4, §5) ;
 *   · IDEMPOTENCE : commande déjà satisfaite → APPLIED sans écriture ; même
 *     clé d'idempotence et même entrée rejouées → résultat enregistré, sans
 *     écriture ;
 *   · AUCUN EFFET DÉRIVÉ : une relation entre événements de référence et un
 *     lien d'Agenda supplémentaire ne créent ni composante financière, ni
 *     date, ni événement d'Agenda, ni rappel, ni notification, ni passage
 *     T3 / T4, ni appel IA (§9, §17, §18). Seul le lien porté par la colonne
 *     historique garde ses effets existants (projection T4), inchangés. Créer,
 *     corriger, invalider ou restaurer un événement de référence publie, APRÈS
 *     validation, les signaux existants du dépôt (`BUSINESS_OPERATION_*`) :
 *     la projection T4 existante réagit comme pour toute autre écriture ;
 *   · JOURNAL : chaque changement appliqué est tracé (avant / après, auteur,
 *     canal, preuves) dans `business_operation_graph_history`.
 *
 * COMPATIBILITÉ (transition, CDC §22) : le PREMIER lien d'un élément d'Agenda
 * est écrit dans la colonne historique par le service unique de regroupement
 * (les écrans existants continuent de le voir ; le déclencheur 1716 le reflète
 * dans le graphe) ; un lien vers un AUTRE événement de référence est un lien
 * supplémentaire du graphe, que seuls les nouveaux lecteurs voient
 * (`graph/read.ts`). Aucun rôle « principal » n'est posé par cette façade.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { isBusinessOperationIntegrityError } from './errors';
import {
  applied, commandInputHash, decideAssociate, decideDissociate, declarationFingerprint, evidenceFingerprint, isIdempotencyKey,
  isOperationRelationNature, isPositiveId, normalizeDeclarationText, normalizeEvidence, normalizeOperationPatch, refused,
  type GraphEvidence, type GraphOrigin, type OperationPatch, type OperationRelationNature, type OperationRelationState,
  type OperationWriteCode, type OperationWriteResult,
} from './graph/model';
import {
  isBusinessOperationStatus, resolveOperationTypeInput, USER_INVALIDATION_REASON,
  type BusinessOperationStatus, type BusinessOperationTypeCode, type OperationTypeInput,
} from './model';
import type { BusinessOperationRepository } from './repository';
import {
  activateExtraAgendaLink, attachDeclaration, findActiveDeclaration, findAgendaLink, findRelation, findReplay, insertDeclaration, insertRelation,
  journalGraph, loadAgendaItemFacts, loadOperationFacts, removeExtraAgendaLink, setRelationState, stampAgendaLinkDecision, updateRelation,
  type GraphJournalEntry,
} from './graph/store';
import type { GroupingContext } from './grouping/service';
import type { RoleOrigin } from './grouping/model';

// ── Contexte ───────────────────────────────────────────────────────────────

export type OperationWriteActor =
  /** Geste de l'utilisateur : depuis un écran, une carte « À traiter », ou confirmé dans l'Assistant. */
  | { kind: 'USER'; userId: number; channel: 'UI' | 'TO_PROCESS' | 'ASSISTANT' }
  /** Inférence d'un traitement IA (consolidation T3, projection T4). */
  | { kind: 'AI'; treatment: 'T3' | 'T4' }
  /** Reprise déterministe (rattrapage, contrôle de cohérence). */
  | { kind: 'SYSTEM'; reason: string };

export interface OperationWriteContext {
  accountId: number;
  actor: OperationWriteActor;
  /** Clé fournie par l'appelant, propre à UNE commande : rejouée, elle rend le résultat enregistré. */
  idempotencyKey?: string;
  correlationId?: string;
}

const originOf = (a: OperationWriteActor): GraphOrigin => (a.kind === 'USER' ? 'USER' : a.kind === 'AI' ? 'AI' : 'SYSTEM');
const roleOriginOf = (a: OperationWriteActor): RoleOrigin => (a.kind === 'USER' ? 'USER' : a.kind === 'AI' ? a.treatment : 'SYSTEM');
const userIdOf = (a: OperationWriteActor): number | null => (a.kind === 'USER' ? a.userId : null);
const channelOf = (a: OperationWriteActor): string => (a.kind === 'USER' ? a.channel : a.kind === 'AI' ? a.treatment : 'SYSTEM');

// ── Droits ─────────────────────────────────────────────────────────────────

/**
 * Droit d'écrire de l'ACTEUR UTILISATEUR sur le compte : adhésion active et
 * compte non restreint (même règle que `refuserSiLectureSeule`). Rend le code
 * du refus, ou null. Exportée pour les routes du lot D (à déclarer alors dans
 * `RECOGNIZED_GUARDS`).
 */
export async function checkOperationWriteAccess(accountId: number, userId: number): Promise<Extract<OperationWriteCode, 'NOT_A_MEMBER' | 'READ_ONLY_ACCOUNT'> | null> {
  const [{ db }, { sql }, { getEntitlements }] = await Promise.all([import('@/db'), import('drizzle-orm'), import('@/services/entitlements.service')]);
  const membre = (await db.execute(sql`
    SELECT 1 FROM account_memberships WHERE account_id = ${accountId} AND user_id = ${userId} AND status = 'active' LIMIT 1`)) as unknown as unknown[];
  if (!membre.length) return 'NOT_A_MEMBER';
  const droits = await getEntitlements(accountId);
  return droits.canWrite ? null : 'READ_ONLY_ACCOUNT';
}

// ── Exécution commune ──────────────────────────────────────────────────────

/** Sortie d'une commande SANS écriture : annule la transaction et rend le résultat tel quel. */
class CommandOutcome extends Error {
  constructor(readonly result: OperationWriteResult<unknown>) { super('operation-write : commande sans écriture'); }
}

const stop = (result: OperationWriteResult<unknown>): never => { throw new CommandOutcome(result); };

interface Journal { push(e: Omit<GraphJournalEntry, 'origin' | 'channel' | 'actorUserId' | 'correlationId' | 'command' | 'idempotencyKey' | 'result'>): void }

function validContext(ctx: OperationWriteContext): boolean {
  if (!ctx || !isPositiveId(ctx.accountId) || !ctx.actor) return false;
  if (ctx.idempotencyKey !== undefined && !isIdempotencyKey(ctx.idempotencyKey)) return false;
  const a = ctx.actor;
  if (a.kind === 'USER') return isPositiveId(a.userId) && ['UI', 'TO_PROCESS', 'ASSISTANT'].includes(a.channel);
  if (a.kind === 'AI') return a.treatment === 'T3' || a.treatment === 'T4';
  return a.kind === 'SYSTEM' && typeof a.reason === 'string' && a.reason.trim().length > 0;
}

/**
 * Exécute UNE commande : contexte et droits contrôlés, transaction sous le
 * verrou du compte, rejeu par clé d'idempotence, journal des changements,
 * erreurs converties en résultat. `body` rend le résultat APPLIED ; toute
 * autre issue passe par `stop(...)` (transaction annulée).
 */
async function runCommand<T>(
  ctx: OperationWriteContext, command: string, input: unknown,
  body: (g: GroupingContext, journal: Journal) => Promise<OperationWriteResult<T>>,
): Promise<OperationWriteResult<T>> {
  if (!validContext(ctx)) return refused('FORBIDDEN', 'INVALID_INPUT');
  const { actor, accountId } = ctx;
  try {
    if (actor.kind === 'USER') {
      const refus = await checkOperationWriteAccess(accountId, actor.userId);
      if (refus) return refused('FORBIDDEN', refus);
    }
    const { withGroupingWrite } = await import('./grouping/service');
    const { lockGroupingAccount } = await import('./grouping/runner');
    return await withGroupingWrite(accountId, async (g) => {
      await lockGroupingAccount(g.runner, accountId);
      const inputHash = commandInputHash(command, input);
      if (ctx.idempotencyKey) {
        const deja = await findReplay(g.runner, accountId, command, ctx.idempotencyKey, inputHash);
        if (deja) {
          if (!deja.sameCommand) stop(refused('CONFLICT', 'IDEMPOTENCY_KEY_REUSED'));
          return { ...(deja.result as OperationWriteResult<T>), changed: false, replayed: true };
        }
      }
      const entries: Array<Parameters<Journal['push']>[0]> = [];
      const result = await body(g, { push: (e) => { entries.push(e); } });
      if (result.status !== 'APPLIED') stop(result);
      if (result.changed) {
        // Une commande appliquée laisse toujours au moins une ligne de journal (support du rejeu).
        for (let i = 0; i < entries.length; i++) {
          await journalGraph(g.runner, accountId, {
            ...entries[i], origin: originOf(actor), channel: channelOf(actor), actorUserId: userIdOf(actor), correlationId: g.correlationId,
            command, ...(i === 0 ? { idempotencyKey: ctx.idempotencyKey ?? null, inputHash, result } : {}),
          });
        }
      }
      return result;
    }, { ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}), actorUserId: userIdOf(actor) });
  } catch (e) {
    if (e instanceof CommandOutcome) return e.result as OperationWriteResult<T>;
    const code = (e as { code?: string }).code;
    // Erreurs d'intégrité des services délégués : refus métier connus, jamais une panne.
    if (code === 'ITEM_NOT_FOUND' || code === 'OPERATION_NOT_FOUND' || code === 'CROSS_ACCOUNT' || code === 'DOCUMENT_NOT_FOUND') return refused('FORBIDDEN', 'NOT_FOUND_IN_ACCOUNT');
    if (code === 'ASSET_NOT_FOUND' || code === 'SOURCE_TARGET_NOT_FOUND') return refused('FORBIDDEN', 'NOT_FOUND_IN_ACCOUNT');
    if (code === 'OPERATION_INACTIVE' || code === 'OPERATION_MERGED') return refused('FORBIDDEN', 'OPERATION_INACTIVE');
    if (code === 'UNKNOWN_TYPE' || code === 'OTHER_AS_FALLBACK' || code === 'INVALID_STATUS' || code === 'INVALID_DATE') return refused('FORBIDDEN', 'INVALID_INPUT');
    if (code === 'DETAILS_TYPE_MISMATCH') return refused('FORBIDDEN', 'TYPE_DETAILS_PRESENT');
    if (code === 'STATUS_TRANSITION_FORBIDDEN') return refused('FORBIDDEN', 'STATUS_TRANSITION_REFUSED');
    console.error(`[operation-write] ${command} en échec (compte ${accountId}) :`, isBusinessOperationIntegrityError(e) ? e.message : e);
    return refused('FAILED', 'TECHNICAL_FAILURE');
  }
}

// ── 1. Relations entre événements de référence ─────────────────────────────

export interface AssociateOperationsInput {
  /** Relation orientée : le financement (FINANCING), le sinistre (CLAIM_REPAIR). Non orientée : l'un des deux. */
  fromOperationId: number;
  toOperationId: number;
  nature: OperationRelationNature;
  evidence?: GraphEvidence[];
  /** Validité métier PROUVÉE (AAAA-MM-JJ) ; jamais une date de traitement. */
  validFrom?: string | null;
  validTo?: string | null;
  /** Version attendue de la relation existante (carte « À traiter », écran) : périmée → CONFLICT. */
  expectedVersion?: number;
  reasonCode?: string;
}

export interface OperationRelationData {
  relationId: number;
  fromOperationId: number;
  toOperationId: number;
  nature: OperationRelationNature;
  state: OperationRelationState;
  version: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const optionalDate = (v: unknown): v is string | null | undefined => v === undefined || v === null || (typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v)));
const reason = (v: unknown, defaut: string): string => (typeof v === 'string' && /^[A-Z0-9_]{3,80}$/.test(v) ? v : defaut);

/**
 * ASSOCIE deux événements de référence distincts du compte. Ne fusionne rien,
 * ne déplace aucun document ni événement, n'ajoute aucun montant (CDC §7, §9).
 * Une relation par paire : la rejouer ne crée pas de doublon.
 */
export function associateOperations(ctx: OperationWriteContext, input: AssociateOperationsInput): Promise<OperationWriteResult<OperationRelationData>> {
  return runCommand<OperationRelationData>(ctx, 'associateOperations', input, async (g, journal) => {
    const evidence = normalizeEvidence(input?.evidence);
    if (!input || !isPositiveId(input.fromOperationId) || !isPositiveId(input.toOperationId) || !isOperationRelationNature(input.nature)
        || evidence === null || !optionalDate(input.validFrom) || !optionalDate(input.validTo)
        || (input.validFrom && input.validTo && input.validTo < input.validFrom)
        || (input.expectedVersion !== undefined && !isPositiveId(input.expectedVersion))) {
      return stop(refused('FORBIDDEN', 'INVALID_INPUT'));
    }
    if (input.fromOperationId === input.toOperationId) return stop(refused('FORBIDDEN', 'REFLEXIVE'));
    // Verrous pris dans l'ordre des identifiants (jamais d'interblocage entre deux commandes croisées).
    const [petit, grand] = input.fromOperationId < input.toOperationId ? [input.fromOperationId, input.toOperationId] : [input.toOperationId, input.fromOperationId];
    const a = await loadOperationFacts(g.runner, g.accountId, petit);
    const b = await loadOperationFacts(g.runner, g.accountId, grand);
    if (!a || !b) return stop(refused('FORBIDDEN', 'NOT_FOUND_IN_ACCOUNT'));
    const from = a.id === input.fromOperationId ? a : b;
    const to = a.id === input.fromOperationId ? b : a;
    const existing = await findRelation(g.runner, g.accountId, from.id, to.id);
    const origin = originOf(ctx.actor);
    const d = decideAssociate({ from, to, nature: input.nature, origin, evidence: evidence!, expectedVersion: input.expectedVersion }, existing);
    const data = (r: { id: number; fromOperationId: number; toOperationId: number; nature: OperationRelationNature; state: OperationRelationState; version: number }): OperationRelationData =>
      ({ relationId: r.id, fromOperationId: r.fromOperationId, toOperationId: r.toOperationId, nature: r.nature, state: r.state, version: r.version });
    switch (d.outcome) {
      case 'FORBIDDEN': return stop(refused('FORBIDDEN', d.code));
      case 'CONFLICT': return stop(refused('CONFLICT', d.code, { currentVersion: d.currentVersion }));
      case 'ARBITRATION_REQUIRED': return stop(refused('ARBITRATION_REQUIRED', d.code, { relationId: d.relationId }));
      case 'NO_CHANGE': return applied(false, data(existing!));
      default: break;
    }
    const write = {
      ends: d.ends, nature: input.nature, state: 'ACTIVE' as const, origin, reasonCode: reason(input.reasonCode, origin === 'USER' ? 'USER_ASSOCIATION' : 'INFERRED_ASSOCIATION'),
      evidence: evidence!, evidenceFingerprint: evidenceFingerprint(evidence!), validFrom: input.validFrom ?? null, validTo: input.validTo ?? null,
      userId: userIdOf(ctx.actor),
    };
    const rel = d.outcome === 'CREATE' ? await insertRelation(g.runner, g.accountId, write) : await updateRelation(g.runner, g.accountId, d.relationId, write);
    journal.push({
      relationKind: 'OPERATION_RELATION', operationId: rel.fromOperationId, otherOperationId: rel.toOperationId,
      action: d.outcome === 'CREATE' ? 'CREATED' : d.outcome === 'REACTIVATE' ? 'REACTIVATED' : 'UPDATED', reasonCode: write.reasonCode, evidence: evidence!,
      before: existing ? { state: existing.state, nature: existing.nature, fromOperationId: existing.fromOperationId, toOperationId: existing.toOperationId, version: existing.version } : null,
      after: { state: rel.state, nature: rel.nature, fromOperationId: rel.fromOperationId, toOperationId: rel.toOperationId, version: rel.version },
    });
    return applied(true, data(rel));
  });
}

export interface DissociateOperationsInput {
  operationAId: number;
  operationBId: number;
  expectedVersion?: number;
  /** Preuves connues au moment du refus (une même preuve ne sera pas reproposée). */
  evidence?: GraphEvidence[];
  reasonCode?: string;
}

/**
 * DISSOCIE deux événements de référence : seul le LIEN change. Par
 * l'utilisateur : refus durable, y compris posé d'avance sur deux événements
 * jamais associés (« ne pas associer »). Par une inférence : retrait simple,
 * jamais d'une relation posée par l'utilisateur.
 */
export function dissociateOperations(ctx: OperationWriteContext, input: DissociateOperationsInput): Promise<OperationWriteResult<OperationRelationData>> {
  return runCommand<OperationRelationData>(ctx, 'dissociateOperations', input, async (g, journal) => {
    const evidence = normalizeEvidence(input?.evidence);
    if (!input || !isPositiveId(input.operationAId) || !isPositiveId(input.operationBId) || evidence === null
        || (input.expectedVersion !== undefined && !isPositiveId(input.expectedVersion))) return stop(refused('FORBIDDEN', 'INVALID_INPUT'));
    if (input.operationAId === input.operationBId) return stop(refused('FORBIDDEN', 'REFLEXIVE'));
    const [petit, grand] = input.operationAId < input.operationBId ? [input.operationAId, input.operationBId] : [input.operationBId, input.operationAId];
    const a = await loadOperationFacts(g.runner, g.accountId, petit);
    const b = await loadOperationFacts(g.runner, g.accountId, grand);
    if (!a || !b) return stop(refused('FORBIDDEN', 'NOT_FOUND_IN_ACCOUNT'));
    const existing = await findRelation(g.runner, g.accountId, a.id, b.id);
    const origin = originOf(ctx.actor);
    const d = decideDissociate({ aId: a.id, bId: b.id, origin, expectedVersion: input.expectedVersion }, existing);
    const data = (r: { id: number; fromOperationId: number; toOperationId: number; nature: OperationRelationNature; state: OperationRelationState; version: number }): OperationRelationData =>
      ({ relationId: r.id, fromOperationId: r.fromOperationId, toOperationId: r.toOperationId, nature: r.nature, state: r.state, version: r.version });
    if (d.outcome === 'FORBIDDEN') return stop(refused('FORBIDDEN', d.code));
    if (d.outcome === 'CONFLICT') return stop(refused('CONFLICT', d.code, { currentVersion: d.currentVersion }));
    if (d.outcome === 'NO_CHANGE') return existing ? applied(false, data(existing)) : applied(false);
    const state: OperationRelationState = d.outcome === 'REJECT' ? 'REJECTED' : 'REMOVED';
    const code = reason(input.reasonCode, d.outcome === 'REJECT' ? 'USER_DISSOCIATION' : 'INFERRED_DISSOCIATION');
    const fp = evidenceFingerprint(evidence!);
    const rel = existing
      ? await setRelationState(g.runner, g.accountId, existing.id, { state, origin, reasonCode: code, userId: userIdOf(ctx.actor), evidenceFingerprint: fp })
      // Refus posé d'avance : la paire est mémorisée refusée (nature non qualifiée), sans jamais avoir été active.
      : await insertRelation(g.runner, g.accountId, {
        ends: { fromOperationId: a.id, toOperationId: b.id }, nature: 'ASSOCIATED', state, origin, reasonCode: code, evidence: evidence!,
        evidenceFingerprint: fp, userId: userIdOf(ctx.actor),
      });
    journal.push({
      relationKind: 'OPERATION_RELATION', operationId: rel.fromOperationId, otherOperationId: rel.toOperationId,
      action: state === 'REJECTED' ? 'REJECTED' : 'REMOVED', reasonCode: code, evidence: evidence!,
      before: existing ? { state: existing.state, nature: existing.nature, version: existing.version } : null,
      after: { state: rel.state, nature: rel.nature, version: rel.version },
    });
    return applied(true, data(rel));
  });
}

// ── 2. Liens événement de référence ↔ élément d'Agenda (N↔N) ───────────────

export interface AgendaLinkInput {
  operationId: number;
  agendaItemId: number;
  evidence?: GraphEvidence[];
  reasonCode?: string;
}

export interface AgendaLinkData {
  operationId: number;
  agendaItemId: number;
  /** LEGACY_COLUMN : lien porté par la colonne historique (vu des écrans existants) ; EXTRA : lien supplémentaire du graphe. */
  support: 'LEGACY_COLUMN' | 'EXTRA';
  version: number;
}

async function agendaRefused(g: GroupingContext, operationId: number, itemId: number): Promise<boolean> {
  const { isRejected } = await import('./grouping/decisions');
  return isRejected(g.runner, g.accountId, operationId, 'AGENDA', itemId);
}

async function agendaConfirmedByUser(g: GroupingContext, operationId: number, itemId: number): Promise<boolean> {
  const [x] = await g.runner.q(
    `SELECT 1 FROM business_operation_match_decisions
      WHERE account_id = $1 AND candidate_operation_id = $2 AND source_kind = 'AGENDA' AND source_entity_key = $3
        AND decision = 'CONFIRMED' AND origin = 'USER_ARBITRATION' AND active LIMIT 1`, [g.accountId, operationId, String(itemId)]);
  return !!x;
}

/**
 * RATTACHE un élément d'Agenda à un événement de référence. L'élément garde
 * son identité, sa date, ses rappels : aucun élément n'est créé ni copié. Un
 * élément déjà rattaché à un AUTRE événement de référence est PARTAGÉ (lien
 * supplémentaire) — il n'est ni déplacé ni dupliqué. Aucun rôle « principal ».
 * Une inférence ne recrée jamais un rattachement refusé par l'utilisateur.
 */
export function linkAgendaItem(ctx: OperationWriteContext, input: AgendaLinkInput): Promise<OperationWriteResult<AgendaLinkData>> {
  return runCommand<AgendaLinkData>(ctx, 'linkAgendaItem', input, async (g, journal) => {
    const evidence = normalizeEvidence(input?.evidence);
    if (!input || !isPositiveId(input.operationId) || !isPositiveId(input.agendaItemId) || evidence === null) return stop(refused('FORBIDDEN', 'INVALID_INPUT'));
    const op = await loadOperationFacts(g.runner, g.accountId, input.operationId);
    const item = op ? await loadAgendaItemFacts(g.runner, g.accountId, input.agendaItemId) : null;
    if (!op || !item) return stop(refused('FORBIDDEN', 'NOT_FOUND_IN_ACCOUNT'));
    if (!op.active) return stop(refused('FORBIDDEN', 'OPERATION_INACTIVE'));
    const user = ctx.actor.kind === 'USER';
    const origin = originOf(ctx.actor);
    if (!user && evidence!.length === 0) return stop(refused('FORBIDDEN', 'EVIDENCE_REQUIRED'));
    if (!user && await agendaRefused(g, op.id, item.id)) return stop(refused('FORBIDDEN', 'USER_REJECTED'));
    const code = reason(input.reasonCode, user ? 'USER_AGENDA_LINK' : 'INFERRED_AGENDA_LINK');
    const { attachAgendaItem } = await import('./grouping/service');
    const { recordGroupingDecision } = await import('./grouping/decisions');
    const dejaColonne = item.legacyOperationId === op.id;
    const colonneLibre = item.legacyOperationId === null || !item.legacyOperationActive;

    if (dejaColonne || colonneLibre) {
      // Premier lien de l'élément (ou lien déjà porté par la colonne) : service unique de regroupement, rôle « lié » seulement.
      const res = await attachAgendaItem(g, { operationId: op.id, itemId: item.id, origin: roleOriginOf(ctx.actor), reasonCode: code });
      if (res.skipped === 'USER_REJECTED') return stop(refused('FORBIDDEN', 'USER_REJECTED'));
      if (res.skipped === 'LINKED_ELSEWHERE') return stop(refused('FORBIDDEN', 'LINKED_ELSEWHERE'));
      if (user) await stampAgendaLinkDecision(g.runner, g.accountId, op.id, item.id, { reasonCode: code, userId: userIdOf(ctx.actor) });
      const lien = await findAgendaLink(g.runner, g.accountId, op.id, item.id);
      if (!lien || lien.state !== 'ACTIVE') throw new Error(`lien du graphe absent après rattachement (opération ${op.id}, élément ${item.id})`);
      const changed = !dejaColonne;
      if (changed) journal.push({ relationKind: 'AGENDA_LINK', operationId: op.id, agendaItemId: item.id, action: 'CREATED', reasonCode: code, evidence: evidence!, before: null, after: { support: 'LEGACY_COLUMN', version: lien.version } });
      return applied(changed, { operationId: op.id, agendaItemId: item.id, support: 'LEGACY_COLUMN', version: lien.version });
    }

    // Élément déjà rattaché à un autre événement de référence actif : lien supplémentaire, élément PARTAGÉ.
    const { link, action } = await activateExtraAgendaLink(g.runner, g.accountId, { operationId: op.id, itemId: item.id, origin, reasonCode: code, evidence: evidence!, userId: userIdOf(ctx.actor) });
    // Le geste de l'utilisateur est mémorisé (il lève son refus antérieur) dans la mémoire unique des décisions.
    if (user) await recordGroupingDecision(g.runner, { accountId: g.accountId, operationId: op.id, subject: 'AGENDA', entityId: item.id, decision: 'CONFIRMED', reasonCode: code });
    if (action !== 'NO_CHANGE') journal.push({ relationKind: 'AGENDA_LINK', operationId: op.id, otherOperationId: item.legacyOperationId, agendaItemId: item.id, action, reasonCode: code, evidence: evidence!, before: null, after: { support: 'EXTRA', version: link.version } });
    return applied(action !== 'NO_CHANGE', { operationId: op.id, agendaItemId: item.id, support: link.legacyColumn ? 'LEGACY_COLUMN' : 'EXTRA', version: link.version });
  });
}

/**
 * DÉTACHE un élément d'Agenda d'un événement de référence : seul CE lien
 * change. L'élément reste dans l'Agenda à sa date, avec ses rappels, ses
 * documents et ses liens vers d'autres événements de référence. Par
 * l'utilisateur : refus mémorisé (jamais recréé par une inférence). Une
 * inférence ne détache pas un lien posé par l'utilisateur.
 */
export function unlinkAgendaItem(ctx: OperationWriteContext, input: AgendaLinkInput): Promise<OperationWriteResult<AgendaLinkData>> {
  return runCommand<AgendaLinkData>(ctx, 'unlinkAgendaItem', input, async (g, journal) => {
    const evidence = normalizeEvidence(input?.evidence);
    if (!input || !isPositiveId(input.operationId) || !isPositiveId(input.agendaItemId) || evidence === null) return stop(refused('FORBIDDEN', 'INVALID_INPUT'));
    const op = await loadOperationFacts(g.runner, g.accountId, input.operationId);
    const item = op ? await loadAgendaItemFacts(g.runner, g.accountId, input.agendaItemId) : null;
    if (!op || !item) return stop(refused('FORBIDDEN', 'NOT_FOUND_IN_ACCOUNT'));
    const user = ctx.actor.kind === 'USER';
    const lien = await findAgendaLink(g.runner, g.accountId, op.id, item.id);
    const surColonne = item.legacyOperationId === op.id;
    if (!surColonne && (!lien || lien.state !== 'ACTIVE')) return applied(false);
    if (!user && (lien?.origin === 'USER' || await agendaConfirmedByUser(g, op.id, item.id))) return stop(refused('FORBIDDEN', 'USER_RELATION_PROTECTED'));
    const code = reason(input.reasonCode, user ? 'USER_AGENDA_UNLINK' : 'INFERRED_AGENDA_UNLINK');
    const { detachAgendaItem } = await import('./grouping/service');
    const { recordGroupingDecision } = await import('./grouping/decisions');
    if (surColonne) {
      // Lien de la colonne historique : service unique de regroupement (refus mémorisé pour l'utilisateur, déclencheur 1716).
      await detachAgendaItem(g, { itemId: item.id, operationId: op.id, origin: roleOriginOf(ctx.actor), reasonCode: code });
      journal.push({ relationKind: 'AGENDA_LINK', operationId: op.id, agendaItemId: item.id, action: user ? 'REJECTED' : 'REMOVED', reasonCode: code, evidence: evidence!, before: { support: 'LEGACY_COLUMN' }, after: null });
      const apres = await findAgendaLink(g.runner, g.accountId, op.id, item.id);
      return applied(true, { operationId: op.id, agendaItemId: item.id, support: 'LEGACY_COLUMN', version: apres?.version ?? (lien?.version ?? 1) });
    }
    const retire = await removeExtraAgendaLink(g.runner, g.accountId, lien!.id, { origin: originOf(ctx.actor), reasonCode: code, userId: userIdOf(ctx.actor) });
    if (!retire) return applied(false);
    if (user) await recordGroupingDecision(g.runner, { accountId: g.accountId, operationId: op.id, subject: 'AGENDA', entityId: item.id, decision: 'REJECTED', reasonCode: code });
    journal.push({ relationKind: 'AGENDA_LINK', operationId: op.id, agendaItemId: item.id, action: user ? 'REJECTED' : 'REMOVED', reasonCode: code, evidence: evidence!, before: { support: 'EXTRA', version: lien!.version }, after: { version: retire.version } });
    return applied(true, { operationId: op.id, agendaItemId: item.id, support: 'EXTRA', version: retire.version });
  });
}

// ── 3. Documents (gestes de l'utilisateur, délégués au regroupement existant) ──

export interface DocumentLinkInput { operationId: number; fileId: number; reasonCode?: string }
export interface DocumentLinkData { operationId: number; fileId: number }

async function documentInAccount(g: GroupingContext, fileId: number): Promise<boolean> {
  const [x] = await g.runner.q(`SELECT 1 FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [fileId, g.accountId]);
  return !!x;
}

/** Appartenance explicite d'un document à un événement de référence (utilisateur seulement). */
export function linkDocument(ctx: OperationWriteContext, input: DocumentLinkInput): Promise<OperationWriteResult<DocumentLinkData>> {
  return runCommand<DocumentLinkData>(ctx, 'linkDocument', input, async (g, journal) => {
    if (ctx.actor.kind !== 'USER') return stop(refused('FORBIDDEN', 'USER_ONLY'));
    if (!input || !isPositiveId(input.operationId) || !isPositiveId(input.fileId)) return stop(refused('FORBIDDEN', 'INVALID_INPUT'));
    const op = await loadOperationFacts(g.runner, g.accountId, input.operationId);
    if (!op || !(await documentInAccount(g, input.fileId))) return stop(refused('FORBIDDEN', 'NOT_FOUND_IN_ACCOUNT'));
    if (!op.active) return stop(refused('FORBIDDEN', 'OPERATION_INACTIVE'));
    const code = reason(input.reasonCode, 'USER_DOCUMENT_LINK');
    const { attachDocument } = await import('./grouping/service');
    const changed = await attachDocument(g, { operationId: op.id, fileId: input.fileId, reasonCode: code });
    if (changed) journal.push({ relationKind: 'DOCUMENT_LINK', operationId: op.id, fileId: input.fileId, action: 'CREATED', reasonCode: code, before: null, after: { membership: 'USER' } });
    return applied(changed, { operationId: op.id, fileId: input.fileId });
  });
}

/**
 * Retire un document d'un événement de référence (utilisateur seulement) :
 * refus mémorisé, preuves de CE document sur CET événement désactivées,
 * événement recalculé par la consolidation existante. Le fichier, ses liens
 * aux éléments d'Agenda et ses autres rattachements restent (CDC §19).
 */
export function unlinkDocument(ctx: OperationWriteContext, input: DocumentLinkInput): Promise<OperationWriteResult<DocumentLinkData>> {
  return runCommand<DocumentLinkData>(ctx, 'unlinkDocument', input, async (g, journal) => {
    if (ctx.actor.kind !== 'USER') return stop(refused('FORBIDDEN', 'USER_ONLY'));
    if (!input || !isPositiveId(input.operationId) || !isPositiveId(input.fileId)) return stop(refused('FORBIDDEN', 'INVALID_INPUT'));
    const op = await loadOperationFacts(g.runner, g.accountId, input.operationId);
    if (!op || !(await documentInAccount(g, input.fileId))) return stop(refused('FORBIDDEN', 'NOT_FOUND_IN_ACCOUNT'));
    const code = reason(input.reasonCode, 'USER_DOCUMENT_UNLINK');
    const { detachDocument } = await import('./grouping/service');
    const changed = await detachDocument(g, { operationId: op.id, fileId: input.fileId, reasonCode: code });
    if (changed) journal.push({ relationKind: 'DOCUMENT_LINK', operationId: op.id, fileId: input.fileId, action: 'REJECTED', reasonCode: code, before: { membership: true }, after: null });
    return applied(changed, { operationId: op.id, fileId: input.fileId });
  });
}

export interface MoveDocumentInput { fileId: number; fromOperationId: number; toOperationId: number; reasonCode?: string }

/**
 * DÉPLACE un document d'un événement de référence vers un autre (utilisateur
 * seulement), en UNE transaction : retrait de l'origine (refus mémorisé,
 * preuves désactivées, origine recalculée) puis appartenance explicite à la
 * cible. Aucun fichier copié ; aucune composante financière copiée — les
 * montants du document quittent l'origine et ne sont portés par la cible
 * qu'après la consolidation T3 de ce document (limite : fiche de recette).
 */
export function moveDocument(ctx: OperationWriteContext, input: MoveDocumentInput): Promise<OperationWriteResult<DocumentLinkData & { fromOperationId: number }>> {
  return runCommand<DocumentLinkData & { fromOperationId: number }>(ctx, 'moveDocument', input, async (g, journal) => {
    if (ctx.actor.kind !== 'USER') return stop(refused('FORBIDDEN', 'USER_ONLY'));
    if (!input || !isPositiveId(input.fileId) || !isPositiveId(input.fromOperationId) || !isPositiveId(input.toOperationId)) return stop(refused('FORBIDDEN', 'INVALID_INPUT'));
    if (input.fromOperationId === input.toOperationId) return stop(refused('FORBIDDEN', 'REFLEXIVE'));
    const [petit, grand] = input.fromOperationId < input.toOperationId ? [input.fromOperationId, input.toOperationId] : [input.toOperationId, input.fromOperationId];
    const a = await loadOperationFacts(g.runner, g.accountId, petit);
    const b = await loadOperationFacts(g.runner, g.accountId, grand);
    if (!a || !b || !(await documentInAccount(g, input.fileId))) return stop(refused('FORBIDDEN', 'NOT_FOUND_IN_ACCOUNT'));
    const cible = a.id === input.toOperationId ? a : b;
    if (!cible.active) return stop(refused('FORBIDDEN', 'OPERATION_INACTIVE'));
    const [membre] = await g.runner.q(
      `SELECT 1 FROM business_operation_documents WHERE account_id = $1 AND operation_id = $2 AND file_id = $3 AND active`, [g.accountId, input.fromOperationId, input.fileId]);
    if (!membre) return stop(refused('FORBIDDEN', 'NOT_LINKED'));
    const code = reason(input.reasonCode, 'USER_DOCUMENT_MOVE');
    const { attachDocument, detachDocument } = await import('./grouping/service');
    await detachDocument(g, { operationId: input.fromOperationId, fileId: input.fileId, reasonCode: code });
    await attachDocument(g, { operationId: input.toOperationId, fileId: input.fileId, reasonCode: code });
    journal.push({ relationKind: 'DOCUMENT_LINK', operationId: input.toOperationId, otherOperationId: input.fromOperationId, fileId: input.fileId, action: 'MOVED', reasonCode: code, before: { operationId: input.fromOperationId }, after: { operationId: input.toOperationId } });
    return applied(true, { operationId: input.toOperationId, fileId: input.fileId, fromOperationId: input.fromOperationId });
  });
}

// ── 4. Fournisseurs (gestes de l'utilisateur, délégués au service unique `operation-suppliers`) ──

/** Rôles qu'un utilisateur peut donner à un fournisseur (référentiel du service `operation-suppliers`). */
export type OperationSupplierRoleInput = 'PROVIDER' | 'DOCUMENT_ISSUER' | 'INTERVENER' | 'BRAND';
export interface SupplierLinkInput { operationId: number; supplierId: number; role?: OperationSupplierRoleInput; reasonCode?: string }
export interface SupplierLinkData { operationId: number; supplierId: number; role: string; status: 'ACTIVE' | 'REMOVED' | 'REJECTED' }

interface SupplierLinkRow { role: string; origin: string; status: string }

async function supplierLink(g: GroupingContext, operationId: number, supplierId: number): Promise<SupplierLinkRow | null> {
  const [x] = await g.runner.q<SupplierLinkRow>(
    `SELECT role, origin, status FROM business_operation_suppliers WHERE account_id = $1 AND operation_id = $2 AND supplier_id = $3`,
    [g.accountId, operationId, supplierId]);
  return x ?? null;
}

async function supplierInAccount(g: GroupingContext, supplierId: number): Promise<boolean> {
  const [x] = await g.runner.q(`SELECT 1 FROM suppliers WHERE id = $1 AND account_id = $2 AND status <> 'deleted'`, [supplierId, g.accountId]);
  return !!x;
}

function supplierCommand(
  ctx: OperationWriteContext, command: 'linkSupplier' | 'unlinkSupplier', input: SupplierLinkInput,
): Promise<OperationWriteResult<SupplierLinkData>> {
  return runCommand<SupplierLinkData>(ctx, command, input, async (g, journal) => {
    if (ctx.actor.kind !== 'USER') return stop(refused('FORBIDDEN', 'USER_ONLY'));
    const { USER_OPERATION_SUPPLIER_ROLES, decideOperationSupplierInTx } = await import('@/services/relations/operation-suppliers');
    if (!input || !isPositiveId(input.operationId) || !isPositiveId(input.supplierId)
        || (input.role !== undefined && !(USER_OPERATION_SUPPLIER_ROLES as readonly string[]).includes(input.role))) return stop(refused('FORBIDDEN', 'INVALID_INPUT'));
    const op = await loadOperationFacts(g.runner, g.accountId, input.operationId);
    if (!op || !(await supplierInAccount(g, input.supplierId))) return stop(refused('FORBIDDEN', 'NOT_FOUND_IN_ACCOUNT'));
    if (!op.active) return stop(refused('FORBIDDEN', 'OPERATION_INACTIVE'));
    const avant = await supplierLink(g, op.id, input.supplierId);
    const lier = command === 'linkSupplier';
    // Retirer un fournisseur jamais relié : rien à faire (aucun refus posé d'avance par cette commande).
    if (!lier && !avant) return applied<SupplierLinkData>(false);
    const ok = await decideOperationSupplierInTx(g.runner, g.accountId, {
      operationId: op.id, supplierId: input.supplierId, decision: lier ? 'LINK' : 'REJECT', ...(input.role ? { role: input.role } : {}),
      userId: userIdOf(ctx.actor), correlationId: g.correlationId,
    });
    // `false` après nos contrôles : la table des liens n'est pas disponible — panne, jamais un faux succès.
    if (!ok) throw new Error(`lien fournisseur non écrit (opération ${op.id}, fournisseur ${input.supplierId})`);
    const apres = await supplierLink(g, op.id, input.supplierId);
    if (!apres) throw new Error(`lien fournisseur absent après écriture (opération ${op.id}, fournisseur ${input.supplierId})`);
    const changed = !avant || avant.role !== apres.role || avant.origin !== apres.origin || avant.status !== apres.status;
    const code = reason(input.reasonCode, lier ? 'USER_SUPPLIER_LINK' : 'USER_SUPPLIER_UNLINK');
    if (changed) journal.push({ relationKind: 'SUPPLIER_LINK', operationId: op.id, supplierId: input.supplierId, action: lier ? (avant ? 'UPDATED' : 'CREATED') : 'REJECTED', reasonCode: code, before: avant, after: apres });
    return applied(changed, { operationId: op.id, supplierId: input.supplierId, role: apres.role, status: apres.status as SupplierLinkData['status'] });
  });
}

/**
 * RELIE un fournisseur du compte à un événement de référence (utilisateur
 * seulement) : lien d'origine USER, rôle choisi (défaut : prestataire), jamais
 * modifié ensuite par T3. Délégué à `decideOperationSupplierInTx` (seul
 * écrivain de `business_operation_suppliers`, historique propre). Aucun
 * document, aucun coût, aucun événement d'Agenda n'est créé.
 */
export function linkSupplier(ctx: OperationWriteContext, input: SupplierLinkInput): Promise<OperationWriteResult<SupplierLinkData>> {
  return supplierCommand(ctx, 'linkSupplier', input);
}

/**
 * RETIRE un fournisseur d'un événement de référence (utilisateur seulement) :
 * refus mémorisé (REJECTED), jamais rétabli automatiquement par T3. La fiche
 * du fournisseur, ses documents et ses autres liens restent.
 */
export function unlinkSupplier(ctx: OperationWriteContext, input: SupplierLinkInput): Promise<OperationWriteResult<SupplierLinkData>> {
  return supplierCommand(ctx, 'unlinkSupplier', input);
}

// ── 5. L'événement de référence lui-même : créer, corriger, invalider, restaurer (utilisateur) ──

function repositoryOf(g: GroupingContext): BusinessOperationRepository {
  if (!g.session) throw new Error('operation-write : écriture Opération non ouverte');
  return g.session.repository(g.accountId);
}

const labelOf = (v: unknown): string | null | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t && t.length <= 200 ? t : null;
};

export interface CreateOperationInput {
  /** Déclaration de l'utilisateur (texte utile, 1 à 2000 caractères) : la source durable de l'événement de référence. */
  declaration: string;
  /** Type métier : `null` si incertain ; jamais OTHER par défaut (OTHER exige sa qualification certaine). */
  type: OperationTypeInput;
  /** État INTERNE (envisagé / réalisé / annulé) : sert au moteur, jamais affiché. */
  status: BusinessOperationStatus;
  /** Faits CERTAINS déclarés (dates AAAA-MM-JJ, prestataire). Absent : non daté — aucune date n'est inventée. */
  attributes?: OperationPatch;
  /** Intitulé court (≤ 200 caractères) ; absent : aucun intitulé n'est inventé. */
  label?: string;
  /** Biens du compte concernés (0 à 20). Absent : aucun bien — jamais attribué par proximité. */
  assetIds?: number[];
  reasonCode?: string;
}

export interface OperationData {
  operationId: number;
  version: number;
  /** Déclaration enregistrée (source durable) ; null : commande sans déclaration nouvelle. */
  declarationId: number | null;
  typeCode: BusinessOperationTypeCode | null;
  status: BusinessOperationStatus;
  /** Déclaration identique déjà enregistrée : l'événement de référence existant est rendu, rien n'est créé. */
  alreadyExisted?: boolean;
}

/**
 * CRÉE un événement de référence fondé sur une DÉCLARATION de l'utilisateur
 * (CDC §5, §6, AC01 ; commande W21 de l'Assistant). Il peut n'avoir ni
 * document, ni élément d'Agenda, ni bien, ni date. En UNE transaction : la
 * déclaration est enregistrée (texte utile, auteur, canal, horodatage), puis
 * l'événement est créé par le dépôt avec cette source (`USER_DECLARATION`,
 * autorité USER) et ses biens éventuels.
 * La MÊME déclaration rejouée (même texte normalisé, événement toujours actif)
 * rend l'événement existant sans rien créer (AC03). La recherche SÉMANTIQUE
 * d'un doublon (autre formulation du même acte) relève de T3 (lot C) : elle
 * n'est pas faite ici.
 */
export function createOperation(ctx: OperationWriteContext, input: CreateOperationInput): Promise<OperationWriteResult<OperationData>> {
  return runCommand<OperationData>(ctx, 'createOperation', input, async (g, journal) => {
    if (ctx.actor.kind !== 'USER') return stop(refused('FORBIDDEN', 'USER_ONLY'));
    const texte = normalizeDeclarationText(input?.declaration);
    const attrs = normalizeOperationPatch(input?.attributes);
    const label = labelOf(input?.label);
    const assetIds = input?.assetIds === undefined ? [] : input.assetIds;
    if (!input || texte === null || attrs === null || label === null || !isBusinessOperationStatus(input.status) || input.type === undefined
        || !Array.isArray(assetIds) || assetIds.length > 20 || !assetIds.every(isPositiveId)) return stop(refused('FORBIDDEN', 'INVALID_INPUT'));
    // Type : validé par le référentiel du dépôt (jamais OTHER par défaut) — une erreur devient INVALID_INPUT.
    const typeCode = resolveOperationTypeInput(input.type);
    const repo = repositoryOf(g);
    // Même déclaration déjà enregistrée pour un événement de référence toujours actif : rien n'est créé.
    const deja = await findActiveDeclaration(g.runner, g.accountId, declarationFingerprint(texte));
    if (deja) {
      return applied(false, {
        operationId: deja.operationId, version: deja.version, declarationId: deja.declarationId,
        typeCode: deja.typeCode, status: deja.status as BusinessOperationStatus, alreadyExisted: true,
      });
    }
    const biens = [...new Set(assetIds)];
    const code = reason(input.reasonCode, 'USER_DECLARATION_CREATE');
    const declarationId = await insertDeclaration(g.runner, g.accountId, { purpose: 'CREATE', channel: channelOf(ctx.actor), userId: userIdOf(ctx.actor), text: texte, fingerprint: declarationFingerprint(texte), operationId: null });
    const cree = await repo.create({
      type: input.type, status: input.status, ...attrs, ...(label ? { technicalLabel: label } : {}),
      source: { kind: 'USER_DECLARATION', entityKey: declarationId, authority: 'USER', locator: { declaration: 'CREATE' } },
      assets: biens.map((assetId) => ({ assetId, authority: 'USER' as const })),
      reasonCode: code,
    });
    await attachDeclaration(g.runner, g.accountId, declarationId, cree.id);
    journal.push({
      relationKind: 'OPERATION', operationId: cree.id, action: 'CREATED', reasonCode: code,
      evidence: [{ kind: 'USER_DECLARATION', ref: String(declarationId) }], before: null,
      after: { typeCode, status: input.status, ...attrs, label: label ?? null, assetIds: biens, declarationId },
    });
    return applied(true, { operationId: cree.id, version: 1, declarationId, typeCode, status: input.status });
  });
}

export interface UpdateOperationInput {
  operationId: number;
  /** Déclaration de l'utilisateur qui justifie la correction (texte utile) : enregistrée comme source durable. */
  declaration: string;
  /** Version attendue de l'événement de référence (écran, carte, préparation de la commande) : périmée → CONFLICT. */
  expectedVersion?: number;
  /** Nouveau type ; absent : inchangé. `null` : qualification retirée (type incertain). */
  type?: OperationTypeInput;
  /** Nouvel état interne ; absent : inchangé. */
  status?: BusinessOperationStatus;
  /** Faits à POSER (jamais effacer : l'effacement d'un champ est une commande distincte). */
  attributes?: OperationPatch;
  label?: string;
  reasonCode?: string;
}

/**
 * CORRIGE un événement de référence (utilisateur seulement ; commande W22) :
 * type, état interne, dates métier, prestataire, intitulé — par les méthodes
 * du dépôt (`setType`, `setStatus`, `updateAttributes` : historique, version).
 * Si quelque chose change, la déclaration est enregistrée et ajoutée comme
 * source (`USER_DECLARATION`, autorité USER) : l'événement n'est plus
 * « entièrement géré » par T3, qui ne réécrit alors plus ses dates ni son
 * prestataire renseignés (protection de la correction, CDC §5).
 * Rien ne change : APPLIED sans écriture (aucune déclaration enregistrée).
 * Tout ou rien : un refus en cours de commande annule toute la transaction.
 */
export function updateOperation(ctx: OperationWriteContext, input: UpdateOperationInput): Promise<OperationWriteResult<OperationData>> {
  return runCommand<OperationData>(ctx, 'updateOperation', input, async (g, journal) => {
    if (ctx.actor.kind !== 'USER') return stop(refused('FORBIDDEN', 'USER_ONLY'));
    const texte = normalizeDeclarationText(input?.declaration);
    const attrs = normalizeOperationPatch(input?.attributes);
    const label = labelOf(input?.label);
    if (!input || !isPositiveId(input.operationId) || texte === null || attrs === null || label === null
        || (input.status !== undefined && !isBusinessOperationStatus(input.status))
        || (input.expectedVersion !== undefined && !isPositiveId(input.expectedVersion))) return stop(refused('FORBIDDEN', 'INVALID_INPUT'));
    const faits = await loadOperationFacts(g.runner, g.accountId, input.operationId);
    if (!faits) return stop(refused('FORBIDDEN', 'NOT_FOUND_IN_ACCOUNT'));
    if (!faits.active) return stop(refused('FORBIDDEN', 'OPERATION_INACTIVE'));
    if (input.expectedVersion !== undefined && input.expectedVersion !== faits.version) return stop(refused('CONFLICT', 'VERSION_MISMATCH', { currentVersion: faits.version }));
    const repo = repositoryOf(g);
    const avant = await repo.load(faits.id);
    const code = reason(input.reasonCode, 'USER_DECLARATION_UPDATE');
    let changed = false;
    if (input.type !== undefined) changed = (await repo.setType(faits.id, input.type, code)) || changed;
    if (input.status !== undefined) changed = (await repo.setStatus(faits.id, input.status, { reasonCode: code })) || changed;
    const champs = { ...attrs, ...(label ? { technicalLabel: label } : {}) };
    if (Object.keys(champs).length) changed = (await repo.updateAttributes(faits.id, champs, code)) || changed;
    if (!changed) return applied(false, { operationId: faits.id, version: avant.version, declarationId: null, typeCode: avant.typeCode, status: avant.status });
    const declarationId = await insertDeclaration(g.runner, g.accountId, { purpose: 'UPDATE', channel: channelOf(ctx.actor), userId: userIdOf(ctx.actor), text: texte, fingerprint: declarationFingerprint(texte), operationId: faits.id });
    await repo.addSource(faits.id, { kind: 'USER_DECLARATION', entityKey: declarationId, authority: 'USER', locator: { declaration: 'UPDATE' } }, code);
    const apres = await repo.load(faits.id);
    const image = (o: typeof avant) => ({
      typeCode: o.typeCode, status: o.status, plannedDate: o.plannedDate, startDate: o.startDate, realizedDate: o.realizedDate, endDate: o.endDate,
      provider: o.provider, label: o.technicalLabel, version: o.version,
    });
    journal.push({
      relationKind: 'OPERATION', operationId: faits.id, action: 'UPDATED', reasonCode: code,
      evidence: [{ kind: 'USER_DECLARATION', ref: String(declarationId) }], before: image(avant), after: image(apres),
    });
    return applied(true, { operationId: faits.id, version: apres.version, declarationId, typeCode: apres.typeCode, status: apres.status });
  });
}

export interface OperationTargetInput { operationId: number; expectedVersion?: number; reasonCode?: string }

/**
 * INVALIDE un événement de référence créé à tort (utilisateur seulement ;
 * commande W23). Invalidation LOGIQUE par le dépôt (jamais un DELETE) : il
 * quitte les surfaces actives ; ses documents, ses éléments d'Agenda saisis
 * (détachés, conservés à leur date avec leurs rappels), ses fournisseurs et
 * ses faits financiers ne sont pas supprimés ; ses relations restent en base
 * (invisibles tant qu'il est invalidé, retrouvées s'il est restauré). Motif
 * `USER_INVALIDATED` : T3 ne le réactive jamais (garde de la consolidation).
 * Déjà invalidé par l'utilisateur : APPLIED sans écriture.
 */
export function invalidateOperation(ctx: OperationWriteContext, input: OperationTargetInput): Promise<OperationWriteResult<OperationData>> {
  return runCommand<OperationData>(ctx, 'invalidateOperation', input, async (g, journal) => {
    if (ctx.actor.kind !== 'USER') return stop(refused('FORBIDDEN', 'USER_ONLY'));
    if (!input || !isPositiveId(input.operationId) || (input.expectedVersion !== undefined && !isPositiveId(input.expectedVersion))) return stop(refused('FORBIDDEN', 'INVALID_INPUT'));
    const faits = await loadOperationFacts(g.runner, g.accountId, input.operationId);
    if (!faits) return stop(refused('FORBIDDEN', 'NOT_FOUND_IN_ACCOUNT'));
    const repo = repositoryOf(g);
    const avant = await repo.load(faits.id, { allowInactive: true, allowMerged: true });
    // Fusionné : l'identité canonique est ailleurs — on n'invalide pas un ancien identifiant.
    if (avant.mergedIntoOperationId !== null) return stop(refused('FORBIDDEN', 'OPERATION_INACTIVE'));
    if (avant.invalidatedAt !== null) {
      if (avant.invalidationReason === USER_INVALIDATION_REASON) return applied(false, { operationId: faits.id, version: avant.version, declarationId: null, typeCode: avant.typeCode, status: avant.status });
      return stop(refused('FORBIDDEN', 'OPERATION_INACTIVE'));
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== avant.version) return stop(refused('CONFLICT', 'VERSION_MISMATCH', { currentVersion: avant.version }));
    const elements = await g.runner.q<{ id: number }>(`SELECT id FROM agenda_items WHERE account_id = $1 AND business_operation_id = $2 ORDER BY id`, [g.accountId, faits.id]);
    const { deleteOrInvalidateOperation } = await import('./grouping/service');
    await deleteOrInvalidateOperation(g, faits.id, USER_INVALIDATION_REASON);
    const apres = await repo.load(faits.id, { allowInactive: true });
    journal.push({
      relationKind: 'OPERATION', operationId: faits.id, action: 'INVALIDATED', reasonCode: reason(input.reasonCode, USER_INVALIDATION_REASON),
      before: { version: avant.version, agendaItemIds: elements.map((e) => Number(e.id)) }, after: { version: apres.version, invalidationReason: apres.invalidationReason },
    });
    return applied(true, { operationId: faits.id, version: apres.version, declarationId: null, typeCode: apres.typeCode, status: apres.status });
  });
}

/**
 * RESTAURE un événement de référence invalidé PAR L'UTILISATEUR (annulation de
 * `invalidateOperation`). Refusé (NOT_RESTORABLE) s'il a été invalidé pour une
 * autre raison (preuves retirées, fusion) ou s'il n'a plus aucune source
 * active. Les éléments d'Agenda détachés à l'invalidation ne sont PAS
 * rattachés de nouveau (leurs identifiants sont dans le journal) ; les
 * relations et les liens supplémentaires, restés en base, redeviennent lisibles.
 */
export function restoreOperation(ctx: OperationWriteContext, input: OperationTargetInput): Promise<OperationWriteResult<OperationData>> {
  return runCommand<OperationData>(ctx, 'restoreOperation', input, async (g, journal) => {
    if (ctx.actor.kind !== 'USER') return stop(refused('FORBIDDEN', 'USER_ONLY'));
    if (!input || !isPositiveId(input.operationId) || (input.expectedVersion !== undefined && !isPositiveId(input.expectedVersion))) return stop(refused('FORBIDDEN', 'INVALID_INPUT'));
    const faits = await loadOperationFacts(g.runner, g.accountId, input.operationId);
    if (!faits) return stop(refused('FORBIDDEN', 'NOT_FOUND_IN_ACCOUNT'));
    const repo = repositoryOf(g);
    const avant = await repo.load(faits.id, { allowInactive: true, allowMerged: true });
    if (avant.mergedIntoOperationId !== null) return stop(refused('FORBIDDEN', 'NOT_RESTORABLE'));
    if (avant.invalidatedAt === null) return applied(false, { operationId: faits.id, version: avant.version, declarationId: null, typeCode: avant.typeCode, status: avant.status });
    if (avant.invalidationReason !== USER_INVALIDATION_REASON) return stop(refused('FORBIDDEN', 'NOT_RESTORABLE'));
    if (input.expectedVersion !== undefined && input.expectedVersion !== avant.version) return stop(refused('CONFLICT', 'VERSION_MISMATCH', { currentVersion: avant.version }));
    const [soutien] = await g.runner.q(
      `SELECT 1 FROM business_operation_sources WHERE operation_id = $1 AND account_id = $2 AND active
          AND NOT (source_kind = 'USER_ARBITRATION' AND locator ? 'decision') LIMIT 1`, [faits.id, g.accountId]);
    if (!soutien) return stop(refused('FORBIDDEN', 'NOT_RESTORABLE'));
    const code = reason(input.reasonCode, 'USER_RESTORED');
    await repo.reactivate(faits.id, code);
    const apres = await repo.load(faits.id);
    journal.push({ relationKind: 'OPERATION', operationId: faits.id, action: 'RESTORED', reasonCode: code, before: { version: avant.version, invalidationReason: avant.invalidationReason }, after: { version: apres.version } });
    return applied(true, { operationId: faits.id, version: apres.version, declarationId: null, typeCode: apres.typeCode, status: apres.status });
  });
}
