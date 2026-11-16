/**
 * Carte « À traiter » d'un RATTACHEMENT D'AGENDA SUPPLÉMENTAIRE PROPOSÉ PAR UNE
 * INFÉRENCE (carte Trello #744, CDC « Opérations / Agenda V2.0 » §4, §6, §8,
 * §20 ; AC08, AC17, AC24, AC31 ; décision du PO du 16/11/2026).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉCISION DU PO DU 16/11/2026 — RIEN N'EST PROPOSÉ SANS PIÈCE
 *
 * Pour qu'une inférence (T3, T4, reprise) puisse proposer de rattacher un
 * événement de l'Agenda à un SECOND événement de référence, il faut un
 * JUSTIFICATIF COMMUN : un document vivant du compte, à la fois
 *   · rattaché ACTIVEMENT à l'événement de référence proposé
 *     (`business_operation_documents`), ET
 *   · lié à l'événement de l'Agenda par sa PROPRE provenance
 *     (`agenda_file_links.provenances` : MANUAL_DIRECT ou AI_DIRECT).
 * La provenance OPERATION_PRINCIPAL est volontairement exclue : elle est
 * DÉRIVÉE du rattachement lui-même — s'en servir de preuve serait circulaire.
 *
 * Aucune autre heuristique n'ouvre la question : ni « même bien et dates
 * proches », ni le fournisseur, ni le montant, ni un score. Sans justificatif
 * commun : aucune carte, aucune écriture, aucun faux succès.
 *
 * JAMAIS D'ÉCRITURE DIRECTE : une inférence ne rattache pas. Elle pose la
 * question, UNE fois :
 *
 *   « « E » est déjà rattaché à « A ». Le justificatif « D » le relie aussi à
 *     « B » : faut-il le rattacher à « B » ? »
 *
 *   · `ATTACH` — le rattacher aussi (l'événement est PARTAGÉ : un seul objet
 *     d'Agenda, à sa date, un seul rappel) ;
 *   · `KEEP`   — état actuel : ne pas le rattacher.
 *
 * RÈGLES (mêmes garanties que la carte d'arbitrage d'une association)
 *   · Résolution PAR LA FAÇADE d'écriture, acteur utilisateur, canal
 *     « À traiter » : compte, droit d'écrire, existence de l'événement de
 *     référence et de l'événement d'Agenda y sont revalidés juste avant
 *     (CDC §8 : « avant application revalider »). Ce module n'écrit JAMAIS le
 *     lien lui-même.
 *   · Carte posée sur un objet RÉEL : l'ÉVÉNEMENT DE L'AGENDA visé. Aucun
 *     objet n'est créé pour la porter.
 *   · UNE carte ouverte par couple (événement de référence, événement
 *     d'Agenda) : un justificatif commun de plus met la même carte à jour.
 *   · NON RÉGÉNÉRÉE APRÈS RÉPONSE : les justificatifs présentés par une carte
 *     à laquelle l'utilisateur a répondu ne font plus poser la question pour
 *     ce couple (CDC §8). Seul un justificatif jamais présenté rouvre la
 *     question (AC14 : « simple nouveau passage, non »).
 *   · Un REFUS de l'utilisateur (rattachement déjà refusé) n'est jamais
 *     contourné : aucune carte.
 *   · Carte PÉRIMÉE (rattaché, détaché ou événement retiré entre-temps) :
 *     fermée sans rien appliquer (AC18).
 *   · ISOLATION : tout est relu dans le compte.
 *   · Aucun effet dérivé : ni date, ni montant, ni événement d'Agenda créé,
 *     ni rappel, ni appel IA.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq } from 'drizzle-orm';
import { pgClient } from '@/db';
import { toProcessActionEvents, toProcessActions } from '@/db/schema';
import { isPositiveId, normalizeEvidence, type GraphEvidence } from '@/services/business-operations/graph/model';
import type { ActionProposal, ResolutionReason } from './action-model';
import { evidenceIds, liveDocuments, referenceEventTitles } from './reference-event-card-anchor';
import type { DbClient, ResolveOptions, ResolveResult } from './resolve-action.service';

export const AGENDA_LINK_RULE = 'AGENDA-LINK';
const RELATION = 'operationAgendaLink';
/** À valider par le PO. */
export const AGENDA_LINK_ATTACH_LABEL = 'Oui, le rattacher aussi';
/** À valider par le PO. */
export const AGENDA_LINK_KEEP_LABEL = 'Non, ne pas le rattacher';
/** Provenances d'un lien document ↔ événement de l'Agenda qui VALENT preuve : jamais celle dérivée du rattachement. */
export const SHARED_EVIDENCE_PROVENANCES = ['MANUAL_DIRECT', 'AI_DIRECT'] as const;
/** Justificatifs conservés au plus dans une carte (borne des preuves de la façade). */
const EVIDENCE_MAX = 20;
/** Couples examinés au plus par passage et par compte (le passage suivant reprend les autres). */
export const CANDIDATES_PER_PASS = 20;

/** Clé de relation stable : UNE carte ouverte par couple (événement de référence, événement d'Agenda). */
export const agendaLinkKey = (operationId: number, agendaItemId: number): string => `${RELATION}:${operationId}:${agendaItemId}`;

export interface OperationAgendaLinkContext {
  kind: 'operation_agenda_link';
  /** Événement de référence auquel le rattachement est PROPOSÉ. */
  operationId: number;
  agendaItemId: number;
  /** Événement de référence auquel l'événement d'Agenda est DÉJÀ rattaché (celui nommé dans la question). */
  currentOperationId: number;
  operationTitle: string;
  currentOperationTitle: string;
  itemTitle: string;
  /** Justificatifs communs cités (identifiants seulement, jamais de contenu). */
  evidence: GraphEvidence[];
  /** Sources présentées (`NATURE|identifiant`), triées : mémoire de ce à quoi l'utilisateur a répondu. */
  evidenceKeys: string[];
  /** Justificatifs communs (liens de la carte). */
  documents: Array<{ fileId: number; title: string }>;
}

export function isOperationAgendaLinkContext(c: unknown): c is OperationAgendaLinkContext {
  const x = c as Partial<OperationAgendaLinkContext> | null;
  return !!x && typeof x === 'object' && x.kind === 'operation_agenda_link'
    && isPositiveId(x.operationId) && isPositiveId(x.agendaItemId) && isPositiveId(x.currentOperationId)
    && x.operationId !== x.currentOperationId
    && typeof x.operationTitle === 'string' && typeof x.currentOperationTitle === 'string' && typeof x.itemTitle === 'string'
    && Array.isArray(x.evidence) && Array.isArray(x.evidenceKeys) && x.evidenceKeys.length > 0;
}

// ── Libellés et règles pures ───────────────────────────────────────────────

const borne = (s: string, n = 50) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const g = (s: string) => `« ${borne(s.replace(/\s+/g, ' ').trim())} »`;

/**
 * Question de la carte (pure) — à valider par le PO. Elle nomme l'événement de
 * l'Agenda, son rattachement actuel, le justificatif commun qui fonde la
 * proposition et l'événement de référence visé. Neutre : aucune des deux
 * réponses n'est suggérée.
 */
export function agendaLinkQuestion(itemTitle: string, currentTitle: string, targetTitle: string, documentTitle: string): string {
  return `${g(itemTitle)} est déjà rattaché à ${g(currentTitle)}. Le justificatif ${g(documentTitle)} le relie aussi à `
    + `${g(targetTitle)} : faut-il le rattacher à ${g(targetTitle)} ?`;
}

/** Propositions (pures) : rattacher aussi (jamais mise en avant), ou garder l'état actuel. */
export function agendaLinkProposals(fileIds: readonly number[]): ActionProposal[] {
  return [
    { value: 'ATTACH', label: AGENDA_LINK_ATTACH_LABEL, confidence: 0.5, emphasis: 'neutral', evidenceIds: fileIds.map((f) => `file:${f}`) },
    { value: 'KEEP', label: AGENDA_LINK_KEEP_LABEL, confidence: 1, isCurrentValue: true },
  ];
}

/** Choix reçu (pur) ; null : invalide (une requête forgée ne désigne rien hors de la carte). */
export function parseAgendaLinkChoice(value: unknown): 'ATTACH' | 'KEEP' | null {
  return value === 'ATTACH' || value === 'KEEP' ? value : null;
}

/** Sources d'un jeu de justificatifs (`NATURE|identifiant`), dédoublonnées et triées (pure). */
export const agendaLinkSourceKeys = (evidence: readonly GraphEvidence[]): string[] =>
  [...new Set(evidence.map((e) => `${e.kind}|${e.ref}`))].sort();

/**
 * Faut-il poser (ou reposer) la question ? (pure). Non si TOUS les
 * justificatifs ont déjà été présentés par une carte à laquelle l'utilisateur
 * a répondu pour ce couple : un nouveau passage sur les mêmes pièces ne
 * redemande rien.
 */
export const agendaLinkAlreadyAnswered = (keys: readonly string[], answeredKeys: ReadonlySet<string>): boolean =>
  keys.length === 0 || keys.every((k) => answeredKeys.has(k));

// ── Preuve : le justificatif commun (décision du PO du 16/11/2026) ─────────

type Row = Record<string, unknown>;
const json = <T>(v: unknown): T | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v as T;
  try { return JSON.parse(v) as T; } catch { return null; }
};

/**
 * Justificatifs COMMUNS du compte entre un événement de référence et un
 * événement de l'Agenda : documents vivants, rattachés activement à
 * l'événement de référence, et liés à l'événement de l'Agenda par leur propre
 * provenance (jamais celle dérivée du rattachement). Liste vide : aucune
 * proposition n'est recevable.
 */
export async function sharedJustifications(accountId: number, operationId: number, agendaItemId: number): Promise<number[]> {
  const r = (await pgClient.unsafe(
    `SELECT bd.file_id AS id
       FROM business_operation_documents bd
       JOIN asset_files f ON f.id = bd.file_id AND f.account_id = bd.account_id AND f.deleted_at IS NULL
       JOIN agenda_file_links afl ON afl.asset_file_id = bd.file_id
       JOIN agenda_items i ON i.id = afl.agenda_item_id AND i.account_id = bd.account_id
      WHERE bd.account_id = $1 AND bd.operation_id = $2 AND bd.active AND i.id = $3
        AND afl.provenances && $4::text[]
      ORDER BY bd.file_id`,
    [accountId, operationId, agendaItemId, `{${SHARED_EVIDENCE_PROVENANCES.join(',')}}`] as never[],
  )) as unknown as Row[];
  return r.map((x) => Number(x.id));
}

/**
 * COUPLES à proposer d'un compte — MÊME règle de preuve que
 * `sharedJustifications`, dans l'autre sens : au lieu de vérifier un couple
 * connu, elle ÉNUMÈRE les couples (événement de référence, événement de
 * l'Agenda) qu'un justificatif commun relie, pour que le balayage les propose.
 * C'est le seul « détecteur » de cette carte, et il ne regarde RIEN d'autre que
 * la pièce : l'événement de l'Agenda doit être déjà rattaché à un AUTRE
 * événement de référence actif (rattachement SUPPLÉMENTAIRE) et pas encore à
 * celui-ci. Tout est borné au compte et à `limit` couples par passage ; l'ordre
 * est stable (aucune famine : un couple non servi revient au passage suivant,
 * et la carte déjà posée n'est pas recréée).
 */
export async function agendaLinkCandidates(accountId: number, limit = CANDIDATES_PER_PASS): Promise<Array<{ operationId: number; agendaItemId: number; fileIds: number[] }>> {
  if (!isPositiveId(accountId)) return [];
  const r = (await pgClient.unsafe(
    `SELECT bd.operation_id AS op, i.id AS item, array_agg(DISTINCT bd.file_id ORDER BY bd.file_id) AS files
       FROM business_operation_documents bd
       JOIN asset_files f ON f.id = bd.file_id AND f.account_id = bd.account_id AND f.deleted_at IS NULL
       JOIN agenda_file_links afl ON afl.asset_file_id = bd.file_id AND afl.provenances && $2::text[]
       JOIN agenda_items i ON i.id = afl.agenda_item_id AND i.account_id = bd.account_id
       JOIN business_operations o ON o.id = bd.operation_id AND o.account_id = bd.account_id
        AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
       JOIN business_operation_agenda_links l ON l.account_id = bd.account_id AND l.agenda_item_id = i.id
        AND l.state = 'ACTIVE' AND l.operation_id <> bd.operation_id
       JOIN business_operations c ON c.id = l.operation_id AND c.account_id = bd.account_id
        AND c.invalidated_at IS NULL AND c.merged_into_operation_id IS NULL
      WHERE bd.account_id = $1 AND bd.active
        AND NOT EXISTS (SELECT 1 FROM business_operation_agenda_links x
                         WHERE x.account_id = bd.account_id AND x.agenda_item_id = i.id
                           AND x.operation_id = bd.operation_id AND x.state = 'ACTIVE')
      GROUP BY bd.operation_id, i.id
      ORDER BY bd.operation_id, i.id
      LIMIT $3`,
    [accountId, `{${SHARED_EVIDENCE_PROVENANCES.join(',')}}`, Math.max(1, Math.floor(limit))] as never[],
  )) as unknown as Row[];
  return r.map((x) => ({
    operationId: Number(x.op), agendaItemId: Number(x.item),
    fileIds: ((x.files as unknown[]) ?? []).map(Number).filter((n) => Number.isSafeInteger(n)),
  }));
}

// ── Proposition (producteur) ───────────────────────────────────────────────

export interface AgendaLinkProposalRequest {
  operationId: number;
  agendaItemId: number;
  /** Preuves citées par l'inférence (facultatives : la preuve recevable est relue en base). */
  evidence?: readonly GraphEvidence[];
}

export interface AgendaLinkProposalOutcome {
  /**
   * POSTED : carte créée ; UPDATED : carte ouverte mise à jour ; ALREADY_ANSWERED : l'utilisateur a déjà répondu sur
   * ces justificatifs ; NO_SHARED_EVIDENCE : aucun justificatif commun — RIEN n'est proposé (décision du PO du
   * 16/11/2026) ; NOT_APPLICABLE : la situation n'appelle pas la question (déjà rattaché, pas un rattachement
   * supplémentaire, refus de l'utilisateur, événement retiré, entrée invalide) ; SKIPPED : refusée par la file ;
   * FAILED : panne.
   */
  status: 'POSTED' | 'UPDATED' | 'ALREADY_ANSWERED' | 'NO_SHARED_EVIDENCE' | 'NOT_APPLICABLE' | 'SKIPPED' | 'FAILED';
  actionId?: number;
  reason?: string;
}

/**
 * Pose (ou met à jour) la carte d'un rattachement d'Agenda SUPPLÉMENTAIRE
 * proposé par une inférence. Ne lève jamais : une carte manquée sera
 * redemandée par le passage suivant du traitement.
 */
export async function requestAgendaLinkProposal(accountId: number, req: AgendaLinkProposalRequest): Promise<AgendaLinkProposalOutcome> {
  try {
    if (!isPositiveId(accountId) || !req || !isPositiveId(req.operationId) || !isPositiveId(req.agendaItemId)) {
      return { status: 'NOT_APPLICABLE', reason: 'INVALID_REQUEST' };
    }
    if (normalizeEvidence(req.evidence ?? []) === null) return { status: 'NOT_APPLICABLE', reason: 'INVALID_REQUEST' };

    // 1. LA PREUVE, D'ABORD (décision du PO du 16/11/2026) : sans justificatif commun, rien n'est proposé.
    const communs = await sharedJustifications(accountId, req.operationId, req.agendaItemId);
    if (!communs.length) return { status: 'NO_SHARED_EVIDENCE', reason: 'NO_SHARED_DOCUMENT' };

    // 2. Rattachement SUPPLÉMENTAIRE : l'événement d'Agenda du compte est-il déjà rattaché à un AUTRE événement de
    //    référence actif, et pas encore à celui-ci ? Lu dans le graphe N↔N (jamais le rôle « principal »).
    const liens = (await pgClient.unsafe(
      `SELECT l.operation_id AS op FROM business_operation_agenda_links l
         JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = l.account_id
         JOIN business_operations o ON o.id = l.operation_id AND o.account_id = l.account_id
          AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
        WHERE l.account_id = $1 AND l.agenda_item_id = $2 AND l.state = 'ACTIVE'
        ORDER BY l.operation_id`,
      [accountId, req.agendaItemId] as never[],
    )) as unknown as Row[];
    const rattaches = liens.map((x) => Number(x.op));
    if (rattaches.includes(req.operationId)) return { status: 'NOT_APPLICABLE', reason: 'ALREADY_LINKED' };
    const actuel = rattaches[0];
    if (actuel === undefined) return { status: 'NOT_APPLICABLE', reason: 'NOT_AN_EXTRA_LINK' };

    // 3. Un refus de l'utilisateur n'est jamais contourné par une inférence (mémoire unique des décisions).
    const [refus] = (await pgClient.unsafe(
      `SELECT 1 FROM business_operation_match_decisions
        WHERE account_id = $1 AND candidate_operation_id = $2 AND source_kind = 'AGENDA' AND source_entity_key = $3
          AND decision = 'REJECTED' AND active LIMIT 1`,
      [accountId, req.operationId, String(req.agendaItemId)] as never[],
    )) as unknown as Row[];
    if (refus) return { status: 'NOT_APPLICABLE', reason: 'USER_REJECTED' };

    // 4. Titres : règle unique de la page et de la recherche ; un événement de référence retiré ne pose rien.
    const titres = await referenceEventTitles(accountId, [req.operationId, actuel]);
    const titreCible = titres.get(req.operationId);
    const titreActuel = titres.get(actuel);
    if (titreCible === undefined || titreActuel === undefined) return { status: 'NOT_APPLICABLE', reason: 'REFERENCE_EVENT_WITHDRAWN' };
    const [item] = (await pgClient.unsafe(
      `SELECT title FROM agenda_items WHERE account_id = $1 AND id = $2`, [accountId, req.agendaItemId] as never[],
    )) as unknown as Row[];
    if (!item) return { status: 'NOT_APPLICABLE', reason: 'AGENDA_ITEM_WITHDRAWN' };

    // 5. Mémoire : justificatifs déjà présentés par une carte à laquelle l'utilisateur a répondu (ce couple, ce compte).
    const repondues = (await pgClient.unsafe(
      `SELECT trigger_context->'evidenceKeys' AS k FROM to_process_actions
        WHERE account_id = $1 AND rule_code = $2 AND resolution_reason = 'USER_ARBITRATED' AND relation_key = $3`,
      [accountId, AGENDA_LINK_RULE, agendaLinkKey(req.operationId, req.agendaItemId)] as never[],
    )) as unknown as Row[];
    const dejaVus = new Set(repondues.flatMap((x) => (json<unknown[]>(x.k) ?? []).filter((k): k is string => typeof k === 'string')));

    // 6. Carte déjà ouverte pour le couple : même carte, justificatifs réunis (jamais une seconde carte).
    const [ouverte] = (await pgClient.unsafe(
      `SELECT id, trigger_context FROM to_process_actions
        WHERE account_id = $1 AND rule_code = $2 AND resolved_at IS NULL AND relation_key = $3 ORDER BY id LIMIT 1`,
      [accountId, AGENDA_LINK_RULE, agendaLinkKey(req.operationId, req.agendaItemId)] as never[],
    )) as unknown as Row[];
    const ancien = ouverte ? json<unknown>(ouverte.trigger_context) : null;
    const anciensIds = isOperationAgendaLinkContext(ancien) ? evidenceIds(ancien.evidence, 'DOCUMENT') : [];
    const fileIds = [...new Set([...anciensIds, ...communs])].slice(0, EVIDENCE_MAX);
    const vivants = await liveDocuments(accountId, fileIds);
    const retenus = fileIds.filter((f) => vivants.has(f)).sort((a, b) => a - b);
    if (!retenus.length) return { status: 'NO_SHARED_EVIDENCE', reason: 'NO_SHARED_DOCUMENT' };
    const evidence: GraphEvidence[] = retenus.map((f) => ({ kind: 'DOCUMENT' as const, ref: String(f) }));
    const keys = agendaLinkSourceKeys(evidence);
    if (agendaLinkAlreadyAnswered(keys, dejaVus)) return { status: 'ALREADY_ANSWERED' };

    const ctx: OperationAgendaLinkContext = {
      kind: 'operation_agenda_link', operationId: req.operationId, agendaItemId: req.agendaItemId, currentOperationId: actuel,
      operationTitle: titreCible, currentOperationTitle: titreActuel, itemTitle: String(item.title ?? ''),
      evidence, evidenceKeys: keys, documents: retenus.map((f) => ({ fileId: f, title: vivants.get(f)! })),
    };
    const { upsertAction } = await import('./to-process-action.service');
    const u = await upsertAction({
      accountId, targetType: 'AGENDA_ITEM', targetId: req.agendaItemId, relationKey: agendaLinkKey(req.operationId, req.agendaItemId),
      actionKind: 'ARBITRATE', ruleCode: AGENDA_LINK_RULE,
      question: agendaLinkQuestion(ctx.itemTitle, titreActuel, titreCible, ctx.documents[0]!.title),
      proposals: agendaLinkProposals(retenus),
      triggerContext: ctx as unknown as Record<string, unknown>,
    });
    if (u.status === 'CREATED') return { status: 'POSTED', ...(u.actionId !== undefined ? { actionId: u.actionId } : {}) };
    if (u.status === 'UPDATED') return { status: 'UPDATED', ...(u.actionId !== undefined ? { actionId: u.actionId } : {}) };
    return { status: 'SKIPPED', reason: u.code ?? u.reason };
  } catch (e) {
    console.error(`[to-process] rattachement proposé (compte ${accountId}) non posé :`, (e as Error).message);
    return { status: 'FAILED', reason: 'TECHNICAL_FAILURE' };
  }
}

// ── Résolution ─────────────────────────────────────────────────────────────

type Action = typeof toProcessActions.$inferSelect;

/** Refus de la façade qui tiennent à l'ACTEUR (la carte reste ouverte) — tout autre refus rend la carte périmée. */
const ACTOR_REFUSALS: ReadonlySet<string> = new Set(['READ_ONLY_ACCOUNT', 'NOT_A_MEMBER']);

/**
 * Résolution (appelée par `resolveArbitration`, action verrouillée).
 *
 *   · `ATTACH` : le rattachement est appliqué PAR LA FAÇADE d'écriture
 *     (acteur utilisateur, canal « À traiter ») — compte, droit d'écrire,
 *     existence et état y sont revalidés. L'événement de l'Agenda reste UN
 *     seul objet, à sa date, avec un seul rappel : il est PARTAGÉ.
 *   · `KEEP` : rien n'est écrit (l'état actuel est déjà celui-là). La carte est
 *     fermée et ses justificatifs mémorisés : la question n'est plus posée sur
 *     ces mêmes pièces. Choix à valider par le PO (autre possibilité :
 *     enregistrer aussi un refus durable, qui empêcherait l'utilisateur
 *     lui-même de rattacher plus tard depuis la page).
 */
export async function resolveOperationAgendaLinkCard(
  tx: DbClient, action: Action, value: unknown, accountId: number, options: ResolveOptions,
): Promise<ResolveResult & { afterCommit?: () => Promise<void> }> {
  const ctx = action.triggerContext;
  if (!isOperationAgendaLinkContext(ctx)) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  const choix = parseAgendaLinkChoice(value);
  if (!choix) return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
  const userId = options.userId ?? null;
  // Un rattachement est la décision d'un utilisateur identifié : sans lui, rien n'est appliqué.
  if (!isPositiveId(userId)) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  const now = new Date();
  const fermer = async (reason: ResolutionReason, event: string, details: Record<string, unknown>) => {
    await tx.update(toProcessActions).set({ resolvedAt: now, resolutionReason: reason, updatedAt: now })
      .where(and(eq(toProcessActions.id, action.id), eq(toProcessActions.accountId, accountId)));
    await tx.insert(toProcessActionEvents).values({
      actionId: action.id, accountId, event, actorUserId: userId, targetType: action.targetType, targetId: action.targetId,
      fieldKey: action.relationKey, newValue: { kind: choix } as never,
      details: { ruleCode: AGENDA_LINK_RULE, cycleNumber: action.cycleNumber, ...details }, createdAt: now,
    });
  };

  if (choix === 'KEEP') {
    // L'état actuel est conservé : AUCUNE écriture (ni lien, ni refus durable). Seule la mémoire de la carte
    // empêche de reposer la question sur ces mêmes justificatifs.
    await fermer('USER_ARBITRATED', 'RESOLVED_ARBITRATION', {
      choice: choix, operationId: ctx.operationId, agendaItemId: ctx.agendaItemId, evidenceKeys: ctx.evidenceKeys, changed: false,
    });
    return { ok: true, previousValue: null, undoable: false };
  }

  const facade = await import('@/services/business-operations/operation-write.facade');
  const r = await facade.linkAgendaItem({
    accountId, actor: { kind: 'USER', userId, channel: 'TO_PROCESS' },
    idempotencyKey: `to-process:${action.publicId}:${action.cycleNumber}:${choix}`, correlationId: `to-process:${action.publicId}`,
  }, {
    operationId: ctx.operationId, agendaItemId: ctx.agendaItemId, evidence: ctx.evidence, reasonCode: 'TO_PROCESS_AGENDA_LINK_ACCEPTED',
  });

  if (r.status === 'FAILED') {
    // Panne : rien n'a été écrit par la façade ; la carte reste ouverte (transaction de la file annulée).
    throw new Error(`[to-process] rattachement proposé ${action.publicId} : écriture impossible (${r.code})`);
  }
  if (r.status !== 'APPLIED') {
    if (r.status === 'FORBIDDEN' && ACTOR_REFUSALS.has(r.code)) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
    // Événement de référence retiré, événement d'Agenda disparu, refus posé entre-temps : la carte ne vaut plus.
    await fermer('OBSOLETE', 'OBSOLETE', { reason: r.code, status: r.status });
    return { ok: false, previousValue: null, error: 'STALE' };
  }
  await options.onAfterFieldWrite?.();
  await fermer('USER_ARBITRATED', 'RESOLVED_ARBITRATION', {
    choice: choix, operationId: ctx.operationId, agendaItemId: ctx.agendaItemId, evidenceKeys: ctx.evidenceKeys,
    changed: r.changed, replayed: r.replayed, support: r.data?.support,
  });
  // Pas d'annulation depuis la file : le rattachement se défait par le geste « détacher » de l'événement de référence.
  return { ok: true, previousValue: null, undoable: false };
}
