/**
 * Carte « À traiter » d'ARBITRAGE D'UNE ASSOCIATION entre deux événements de
 * référence (carte Trello #744, CDC « Opérations / Agenda V2.0 » §4, §5, §8,
 * §20 ; AC13, AC14, AC16 à AC18).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUAND LA FAÇADE RÉPOND « ARBITRAGE REQUIS »
 *
 * L'utilisateur a refusé d'associer deux événements de référence. Plus tard,
 * une inférence (T3, T4, reprise) veut les associer en citant une preuve que
 * ce refus ne connaissait pas. La façade (`associateOperations`) n'écrit rien
 * et répond `ARBITRATION_REQUIRED` : ce n'est ni à elle ni au traitement de
 * trancher. Jusqu'ici, rien ne posait la question : la demande était perdue.
 *
 * Ce module pose la question, UNE fois :
 *
 *   « Vous aviez choisi de ne pas associer « A » et « B ». Un nouveau
 *     justificatif les rapproche : faut-il les associer ? »
 *
 *   · `ASSOCIATE`       — associer (le refus est levé par l'utilisateur) ;
 *   · `KEEP_SEPARATE`   — état actuel : les garder séparés.
 *
 * RÈGLES
 *   · Résolution PAR LA FAÇADE, acteur utilisateur, canal « À traiter » :
 *     compte, droit d'écrire, existence des deux événements, version de la
 *     relation et intégrité y sont revalidés (CDC §8 : « avant application
 *     revalider »). Ce module n'écrit JAMAIS la relation lui-même.
 *   · Carte posée sur un objet RÉEL : le justificatif cité par l'inférence,
 *     sinon un justificatif de l'un des deux événements de référence, sinon
 *     (AC16 : « sans documents fictifs ») un ÉVÉNEMENT de l'Agenda de l'un des
 *     deux, lu dans le graphe N↔N. Aucun objet n'est créé pour porter la
 *     carte ; sans aucun objet réel, aucune carte (rendu `NO_ANCHOR`, jamais
 *     un faux succès).
 *   · UNE carte ouverte par paire d'événements : une preuve supplémentaire met
 *     la même carte à jour.
 *   · NON RÉGÉNÉRÉE APRÈS RÉPONSE : les preuves présentées par une carte à
 *     laquelle l'utilisateur a répondu ne font plus jamais poser la question
 *     pour cette paire (CDC §8 : « même preuve rejetée = pas de carte
 *     répétée »). Seule une source jamais présentée rouvre un arbitrage
 *     (AC14 : « simple nouveau passage, non »).
 *   · Carte PÉRIMÉE (relation modifiée entre-temps, événement supprimé ou
 *     regroupé) : fermée sans rien appliquer (AC18).
 *   · ISOLATION : tout est relu dans le compte ; la façade refuse tout
 *     identifiant d'un autre compte.
 *   · Aucun effet dérivé : ni montant, ni date, ni événement d'Agenda, ni
 *     rappel, ni appel IA.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq } from 'drizzle-orm';
import { pgClient } from '@/db';
import { toProcessActionEvents, toProcessActions } from '@/db/schema';
import {
  isOperationRelationNature, isPositiveId, normalizeEvidence, pairKey, type GraphEvidence, type OperationRelationNature,
} from '@/services/business-operations/graph/model';
import type { ActionProposal, ResolutionReason } from './action-model';
import {
  agendaItemOfOperations, evidenceIds, evidenceOfAccount, firstDocumentOfOperations, liveDocuments, referenceEventTitles,
} from './reference-event-card-anchor';
import type { DbClient, ResolveOptions, ResolveResult } from './resolve-action.service';

export const OPERATION_RELATION_RULE = 'OPERATION-RELATION';
const RELATION = 'operationRelation';
/** À valider par le PO. */
export const OPERATION_RELATION_ASSOCIATE_LABEL = 'Oui, les associer';
/** À valider par le PO. */
export const OPERATION_RELATION_KEEP_LABEL = 'Non, ne pas les associer';
/** Preuves conservées au plus dans une carte (borne de la façade). */
const EVIDENCE_MAX = 20;

/** Clé de relation stable de la carte : UNE carte ouverte par paire d'événements de référence. */
export const operationRelationKey = (a: number, b: number): string => `${RELATION}:${pairKey(a, b)}`;

/** Propositions d'association posées sans refus préalable (lot 116C). */
export type OperationRelationProposalKind = 'CLAIM_INSURANCE';

export interface OperationRelationContext {
  kind: 'operation_relation';
  /** Paire non ordonnée (`petit:grand`). */
  pairKey: string;
  /** Relation refusée que la preuve nouvelle rapproche ; `null` : PROPOSITION d'association (aucune relation n'existe encore). */
  relationId: number | null;
  /** Version de la relation refusée au moment de la question : périmée à la réponse → rien n'est appliqué ; `null` : proposition. */
  relationVersion: number | null;
  /**
   * Lot 116C (carte #806 §3) — PROPOSITION d'association posée sans refus préalable : un sinistre et un contrat
   * d'assurance qui peut le concerner, quand la recherche automatique ne trouve pas UNE correspondance fiable.
   * Absent : arbitrage d'une association refusée (carte #744).
   */
  proposal?: OperationRelationProposalKind;
  fromOperationId: number;
  toOperationId: number;
  nature: OperationRelationNature;
  /** Preuves citées par l'inférence (identifiants seulement, jamais de contenu). */
  evidence: GraphEvidence[];
  /** Sources présentées (`NATURE|identifiant`), triées : mémoire de ce à quoi l'utilisateur a répondu. */
  evidenceKeys: string[];
  /** Les deux événements de référence, avec le titre affiché dans la question. */
  events: Array<{ operationId: number; title: string }>;
  /** Justificatifs cités (liens de la carte). */
  documents: Array<{ fileId: number; title: string }>;
}

export function isOperationRelationContext(c: unknown): c is OperationRelationContext {
  const x = c as Partial<OperationRelationContext> | null;
  return !!x && typeof x === 'object' && x.kind === 'operation_relation' && typeof x.pairKey === 'string'
    && ((isPositiveId(x.relationId) && isPositiveId(x.relationVersion) && x.proposal === undefined)
      || (x.proposal === 'CLAIM_INSURANCE' && x.relationId === null && x.relationVersion === null))
    && isPositiveId(x.fromOperationId) && isPositiveId(x.toOperationId)
    && x.fromOperationId !== x.toOperationId && isOperationRelationNature(x.nature) && Array.isArray(x.evidence) && Array.isArray(x.evidenceKeys);
}

// ── Libellés et règles pures ───────────────────────────────────────────────

const borne = (s: string, n = 50) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const g = (s: string) => `« ${borne(s.replace(/\s+/g, ' ').trim())} »`;

/** Question de la carte (pure) — à valider par le PO. Neutre : aucune des deux réponses n'est suggérée. */
export function operationRelationQuestion(titleA: string, titleB: string): string {
  return `Vous aviez choisi de ne pas associer ${g(titleA)} et ${g(titleB)}. Un nouveau justificatif les rapproche : faut-il les associer ?`;
}

/**
 * Question d'une PROPOSITION sinistre ↔ assurance (pure ; lot 116C, #806 §3) — À VALIDER PAR LE PO. Neutre ; dit
 * explicitement qu'associer n'est pas une prise en charge par l'assureur.
 */
export function claimInsuranceQuestion(claimTitle: string, contractTitle: string): string {
  return `Faut-il associer ${g(claimTitle)} et ${g(contractTitle)} ? Associer ces deux opérations permet de consulter le contrat d’assurance depuis le sinistre ; cela ne dit pas que l’assureur prend le sinistre en charge.`;
}

/** Propositions (pures) : associer (jamais mise en avant), ou garder l'état actuel. */
export function operationRelationProposals(fileIds: readonly number[]): ActionProposal[] {
  return [
    { value: 'ASSOCIATE', label: OPERATION_RELATION_ASSOCIATE_LABEL, confidence: 0.5, emphasis: 'neutral', evidenceIds: fileIds.map((f) => `file:${f}`) },
    { value: 'KEEP_SEPARATE', label: OPERATION_RELATION_KEEP_LABEL, confidence: 1, isCurrentValue: true },
  ];
}

/** Choix reçu (pur) ; null : invalide (une requête forgée ne désigne rien hors de la carte). */
export function parseOperationRelationChoice(value: unknown): 'ASSOCIATE' | 'KEEP_SEPARATE' | null {
  return value === 'ASSOCIATE' || value === 'KEEP_SEPARATE' ? value : null;
}

/** Sources d'un jeu de preuves (`NATURE|identifiant`), dédoublonnées et triées (pure). */
export function evidenceSourceKeys(evidence: readonly GraphEvidence[]): string[] {
  return [...new Set(evidence.map((e) => `${e.kind}|${e.ref}`))].sort();
}

/**
 * Faut-il poser (ou reposer) la question ? (pure). Non si TOUTES les sources
 * citées ont déjà été présentées par une carte à laquelle l'utilisateur a
 * répondu pour cette paire : un nouveau passage sur les mêmes preuves ne
 * redemande rien.
 */
export function alreadyAnswered(keys: readonly string[], answeredKeys: ReadonlySet<string>): boolean {
  return keys.length === 0 || keys.every((k) => answeredKeys.has(k));
}

// ── Demande d'arbitrage (producteur) ───────────────────────────────────────

export interface OperationRelationArbitrationRequest {
  fromOperationId: number;
  toOperationId: number;
  nature: OperationRelationNature;
  evidence: readonly GraphEvidence[];
  /** Relation refusée désignée par la façade (`data.relationId` du résultat « arbitrage requis ») ; `null` avec `proposal`. */
  relationId: number | null;
  /**
   * Lot 116C (#806 §3) : PROPOSITION sans refus préalable — `fromOperationId` est le sinistre, `toOperationId` le
   * contrat d'assurance. La question n'est posée que si AUCUNE relation n'existe entre les deux (déjà associés ou
   * refusés par l'utilisateur : rien n'est demandé).
   */
  proposal?: OperationRelationProposalKind;
}

export interface OperationRelationArbitrationOutcome {
  /**
   * POSTED : carte créée ; UPDATED : carte ouverte mise à jour ; ALREADY_ANSWERED : l'utilisateur a déjà répondu sur
   * ces preuves ; NO_ANCHOR : aucun document réel pour porter la carte ; NOT_APPLICABLE : la situation n'appelle plus
   * d'arbitrage (relation non refusée, événement retiré, entrée invalide) ; SKIPPED : refusée par la file ; FAILED : panne.
   */
  status: 'POSTED' | 'UPDATED' | 'ALREADY_ANSWERED' | 'NO_ANCHOR' | 'NOT_APPLICABLE' | 'SKIPPED' | 'FAILED';
  actionId?: number;
  reason?: string;
}

type Row = Record<string, unknown>;
const json = <T>(v: unknown): T | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v as T;
  try { return JSON.parse(v) as T; } catch { return null; }
};
/**
 * Pose (ou met à jour) la carte d'arbitrage d'une association refusée, à la
 * suite d'un résultat « arbitrage requis » de la façade. Ne lève jamais : une
 * carte manquée sera redemandée par le passage suivant du traitement (la
 * façade répondra de nouveau « arbitrage requis »).
 */
export async function requestOperationRelationArbitration(accountId: number, req: OperationRelationArbitrationRequest): Promise<OperationRelationArbitrationOutcome> {
  try {
    const recues = normalizeEvidence(req?.evidence);
    if (!isPositiveId(accountId) || !req || !isPositiveId(req.fromOperationId) || !isPositiveId(req.toOperationId) || req.fromOperationId === req.toOperationId
        || (req.proposal === undefined ? !isPositiveId(req.relationId) : (req.proposal !== 'CLAIM_INSURANCE' || req.relationId !== null))
        || !isOperationRelationNature(req.nature) || recues === null || recues.length === 0) {
      return { status: 'NOT_APPLICABLE', reason: 'INVALID_REQUEST' };
    }
    // Isolation : un document ou un élément d'Agenda cité qui n'est pas (ou plus) dans CE compte n'est pas une preuve
    // (un identifiant rendu par une inférence ne vaut pas autorisation) — ni présenté, ni conservé.
    const evidence = await evidenceOfAccount(accountId, recues);
    if (!evidence.length) return { status: 'NOT_APPLICABLE', reason: 'NO_EVIDENCE_IN_ACCOUNT' };
    const paire = pairKey(req.fromOperationId, req.toOperationId);

    // 1. Arbitrage : la relation est-elle toujours REFUSÉE, entre ces deux événements, dans CE compte ?
    //    Proposition (lot 116C) : AUCUNE relation ne doit exister entre les deux (associés ou refusés : rien à demander).
    const [rel] = (await pgClient.unsafe(
      `SELECT r.id, r.state, r.version FROM business_operation_relations r
        WHERE ($1::bigint IS NULL OR r.id = $1::bigint) AND r.account_id = $2
          AND LEAST(r.from_operation_id, r.to_operation_id) = LEAST($3::bigint, $4::bigint)
          AND GREATEST(r.from_operation_id, r.to_operation_id) = GREATEST($3::bigint, $4::bigint)`,
      [req.relationId, accountId, req.fromOperationId, req.toOperationId] as never[],
    )) as unknown as Row[];
    if (req.proposal === undefined) {
      if (!rel || rel.state !== 'REJECTED') return { status: 'NOT_APPLICABLE', reason: 'RELATION_NOT_REFUSED' };
    } else if (rel && rel.state !== 'REMOVED') {
      return { status: 'NOT_APPLICABLE', reason: rel.state === 'REJECTED' ? 'USER_REFUSED' : 'ALREADY_ASSOCIATED' };
    }
    const titres = await referenceEventTitles(accountId, [req.fromOperationId, req.toOperationId]);
    const titreA = titres.get(req.fromOperationId);
    const titreB = titres.get(req.toOperationId);
    if (titreA === undefined || titreB === undefined) return { status: 'NOT_APPLICABLE', reason: 'REFERENCE_EVENT_WITHDRAWN' };

    // 2. Mémoire : preuves déjà présentées par une carte à laquelle l'utilisateur a répondu (cette paire, ce compte).
    const repondues = (await pgClient.unsafe(
      `SELECT trigger_context->'evidenceKeys' AS k FROM to_process_actions
        WHERE account_id = $1 AND rule_code = $2 AND resolution_reason = 'USER_ARBITRATED' AND trigger_context->>'pairKey' = $3`,
      [accountId, OPERATION_RELATION_RULE, paire] as never[],
    )) as unknown as Row[];
    const dejaVues = new Set(repondues.flatMap((x) => (json<unknown[]>(x.k) ?? []).filter((k): k is string => typeof k === 'string')));
    if (alreadyAnswered(evidenceSourceKeys(evidence), dejaVues)) return { status: 'ALREADY_ANSWERED' };

    // 3. Carte déjà ouverte pour la paire : même carte, preuves réunies (jamais une seconde carte), quel que soit
    //    l'objet réel qui la porte (justificatif ou événement de l'Agenda).
    const [ouverte] = (await pgClient.unsafe(
      `SELECT id, target_type, target_id, trigger_context FROM to_process_actions
        WHERE account_id = $1 AND rule_code = $2 AND resolved_at IS NULL AND trigger_context->>'pairKey' = $3
        ORDER BY id LIMIT 1`,
      [accountId, OPERATION_RELATION_RULE, paire] as never[],
    )) as unknown as Row[];
    const ancien = ouverte ? json<unknown>(ouverte.trigger_context) : null;
    const reunies = normalizeEvidence([...(isOperationRelationContext(ancien) ? ancien.evidence : []), ...evidence].slice(0, EVIDENCE_MAX)) ?? evidence;

    // 4. Objet RÉEL qui porte la carte : celui de la carte ouverte, sinon un justificatif cité, sinon un
    //    justificatif de l'un des deux événements de référence, sinon (AC16 : « sans documents fictifs ») un
    //    ÉVÉNEMENT de l'Agenda de l'un des deux, lu dans le graphe N↔N. Jamais un objet créé pour l'occasion.
    const cites = evidenceIds(reunies, 'DOCUMENT');
    const docOuvert = ouverte && ouverte.target_type === 'DOCUMENT' ? Number(ouverte.target_id) : null;
    const vivants = await liveDocuments(accountId, [...cites, ...(docOuvert !== null ? [docOuvert] : [])]);
    let ancre: { type: 'DOCUMENT' | 'AGENDA_ITEM'; id: number } | null = null;
    if (docOuvert !== null && vivants.has(docOuvert)) ancre = { type: 'DOCUMENT', id: docOuvert };
    if (ancre === null && ouverte && ouverte.target_type === 'AGENDA_ITEM' && await agendaItemOfOperations(accountId, [req.fromOperationId, req.toOperationId], Number(ouverte.target_id))) {
      ancre = { type: 'AGENDA_ITEM', id: Number(ouverte.target_id) };
    }
    if (ancre === null) {
      const cite = cites.filter((f) => vivants.has(f)).sort((a, b) => a - b)[0];
      if (cite !== undefined) ancre = { type: 'DOCUMENT', id: cite };
    }
    if (ancre === null) {
      const d = await firstDocumentOfOperations(accountId, [req.fromOperationId, req.toOperationId]);
      if (d !== null) {
        ancre = { type: 'DOCUMENT', id: d };
        for (const [id, titre] of await liveDocuments(accountId, [d])) vivants.set(id, titre);
      }
    }
    if (ancre === null) {
      const item = await agendaItemOfOperations(accountId, [req.fromOperationId, req.toOperationId], null);
      if (item !== null) ancre = { type: 'AGENDA_ITEM', id: item };
    }
    if (ancre === null) return { status: 'NO_ANCHOR', reason: 'NO_REAL_OBJECT' };

    const documents = [...new Set(cites)].filter((f) => vivants.has(f)).sort((a, b) => a - b).map((f) => ({ fileId: f, title: vivants.get(f)! }));
    const ctx: OperationRelationContext = {
      kind: 'operation_relation', pairKey: paire,
      ...(req.proposal === undefined
        ? { relationId: Number(rel!.id), relationVersion: Number(rel!.version) }
        : { relationId: null, relationVersion: null, proposal: req.proposal }),
      fromOperationId: req.fromOperationId, toOperationId: req.toOperationId, nature: req.nature,
      evidence: reunies, evidenceKeys: evidenceSourceKeys(reunies),
      events: [{ operationId: req.fromOperationId, title: titreA }, { operationId: req.toOperationId, title: titreB }],
      documents,
    };
    const { upsertAction } = await import('./to-process-action.service');
    const u = await upsertAction({
      accountId, targetType: ancre.type, targetId: ancre.id, relationKey: operationRelationKey(req.fromOperationId, req.toOperationId),
      actionKind: 'ARBITRATE', ruleCode: OPERATION_RELATION_RULE,
      question: req.proposal === 'CLAIM_INSURANCE' ? claimInsuranceQuestion(titreA, titreB) : operationRelationQuestion(titreA, titreB),
      proposals: operationRelationProposals(documents.map((d) => d.fileId)),
      triggerContext: ctx as unknown as Record<string, unknown>,
    });
    if (u.status === 'CREATED') return { status: 'POSTED', ...(u.actionId !== undefined ? { actionId: u.actionId } : {}) };
    if (u.status === 'UPDATED') return { status: 'UPDATED', ...(u.actionId !== undefined ? { actionId: u.actionId } : {}) };
    return { status: 'SKIPPED', reason: u.code ?? u.reason };
  } catch (e) {
    console.error(`[to-process] arbitrage d’association (compte ${accountId}) non posé :`, (e as Error).message);
    return { status: 'FAILED', reason: 'TECHNICAL_FAILURE' };
  }
}

// ── Résolution ─────────────────────────────────────────────────────────────

type Action = typeof toProcessActions.$inferSelect;

/** Refus de la façade qui tiennent à l'ACTEUR (la carte reste ouverte) — tout autre refus rend la carte périmée. */
const ACTOR_REFUSALS: ReadonlySet<string> = new Set(['READ_ONLY_ACCOUNT', 'NOT_A_MEMBER']);

/**
 * Résolution (appelée par `resolveArbitration`, action verrouillée) : le choix
 * est appliqué PAR LA FAÇADE d'écriture du graphe, acteur utilisateur, canal
 * « À traiter », avec la version de la relation connue de la carte.
 *
 * La façade écrit dans SA transaction (verrou des événements de référence du
 * compte) : si la fermeture de la carte échouait ensuite, la carte resterait
 * ouverte et la même réponse, rejouée, rendrait le résultat déjà enregistré
 * (clé d'idempotence propre à la carte) — jamais une double écriture, jamais
 * une carte fermée sans que le choix soit appliqué.
 */
export async function resolveOperationRelationCard(
  tx: DbClient, action: Action, value: unknown, accountId: number, options: ResolveOptions,
): Promise<ResolveResult & { afterCommit?: () => Promise<void> }> {
  const ctx = action.triggerContext;
  if (!isOperationRelationContext(ctx)) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  const choix = parseOperationRelationChoice(value);
  if (!choix) return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
  const userId = options.userId ?? null;
  // Une décision d'association est celle d'un utilisateur identifié : sans lui, rien n'est appliqué.
  if (!isPositiveId(userId)) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  const now = new Date();
  const fermer = async (reason: ResolutionReason, event: string, details: Record<string, unknown>) => {
    await tx.update(toProcessActions).set({ resolvedAt: now, resolutionReason: reason, updatedAt: now })
      .where(and(eq(toProcessActions.id, action.id), eq(toProcessActions.accountId, accountId)));
    await tx.insert(toProcessActionEvents).values({
      actionId: action.id, accountId, event, actorUserId: userId, targetType: action.targetType, targetId: action.targetId,
      fieldKey: action.relationKey, newValue: { kind: choix } as never,
      details: { ruleCode: OPERATION_RELATION_RULE, cycleNumber: action.cycleNumber, ...details }, createdAt: now,
    });
  };

  const facade = await import('@/services/business-operations/operation-write.facade');
  const contexte = {
    accountId, actor: { kind: 'USER' as const, userId, channel: 'TO_PROCESS' as const },
    idempotencyKey: `to-process:${action.publicId}:${action.cycleNumber}:${choix}`, correlationId: `to-process:${action.publicId}`,
  };
  const r = choix === 'ASSOCIATE'
    ? await facade.associateOperations(contexte, {
      fromOperationId: ctx.fromOperationId, toOperationId: ctx.toOperationId, nature: ctx.nature, evidence: ctx.evidence,
      ...(ctx.relationVersion !== null ? { expectedVersion: ctx.relationVersion } : {}), reasonCode: 'TO_PROCESS_ASSOCIATION_ACCEPTED',
    })
    : await facade.dissociateOperations(contexte, {
      // Proposition refusée (lot 116C) : refus durable posé d'avance sur la paire — elle ne sera plus proposée.
      operationAId: ctx.fromOperationId, operationBId: ctx.toOperationId, evidence: ctx.evidence,
      ...(ctx.relationVersion !== null ? { expectedVersion: ctx.relationVersion } : {}), reasonCode: 'TO_PROCESS_ASSOCIATION_REFUSED',
    });

  if (r.status === 'FAILED') {
    // Panne : rien n'a été écrit par la façade ; la carte reste ouverte (transaction de la file annulée).
    throw new Error(`[to-process] arbitrage d’association ${action.publicId} : écriture impossible (${r.code})`);
  }
  if (r.status !== 'APPLIED') {
    if (r.status === 'FORBIDDEN' && ACTOR_REFUSALS.has(r.code)) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
    // Version périmée, événement supprimé ou regroupé, nature devenue incompatible : la carte ne vaut plus.
    await fermer('OBSOLETE', 'OBSOLETE', { reason: r.code, status: r.status });
    return { ok: false, previousValue: null, error: 'STALE' };
  }
  await options.onAfterFieldWrite?.();
  await fermer('USER_ARBITRATED', 'RESOLVED_ARBITRATION', {
    choice: choix, pairKey: ctx.pairKey, relationId: ctx.relationId, evidenceKeys: ctx.evidenceKeys, changed: r.changed, replayed: r.replayed,
  });
  // Pas d'annulation depuis la file : la décision se corrige par les gestes de l'événement de référence (façade).
  return { ok: true, previousValue: null, undoable: false };
}
