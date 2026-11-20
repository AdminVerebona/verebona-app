/**
 * Cartes « À traiter » de FUSION entre deux événements de référence (carte
 * Trello #744, CDC « Opérations / Agenda V2.0 » §7, §8, §20 ; AC11, AC12,
 * AC16, AC17, AC18).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LES DEUX QUESTIONS QUE LE CDC §8 EXIGE, ET QUI MANQUAIENT
 *
 * « Questions distinctes : même opération ou deux opérations ? associer ou ne
 * pas associer ? quel fait ou montant est correct ? » La deuxième est livrée
 * (`operation-relation-cards.ts`). Les deux autres sont ici :
 *
 *   1. REFERENCE-EVENT-MERGE — « « A » et « B » : est-ce le même événement de
 *      référence, ou deux ? » Une inférence qui croit avoir trouvé un doublon
 *      que le CDC ne l'autorise PAS à fusionner seule (§7 : preuves
 *      convergentes, aucune contradiction importante, décisions de
 *      l'utilisateur préservées — AC12) ne fusionne pas : elle DEMANDE.
 *        · `MERGE`         — c'est le même : la fusion est appliquée par la
 *                            façade d'écriture (identité canonique, liens,
 *                            sources, faits et coûts transférés sans
 *                            duplicata, ancien identifiant redirigé) ;
 *        · `KEEP_DISTINCT` — ce sont deux : RIEN n'est écrit, et la séparation
 *                            est mémorisée (CDC §7 : « un rejeu T3 n'inverse
 *                            pas cette décision »).
 *
 *   2. REFERENCE-EVENT-FACT — « quel fait est correct ? » entre deux
 *      événements de référence ASSOCIÉS qui portent, pour le MÊME fait daté,
 *      deux valeurs contradictoires. La valeur retenue est posée sur celui
 *      qui ne la portait pas, par la façade. Aucune valeur n'est écrasée avant
 *      la réponse.
 *
 * RÈGLES (mêmes garanties que la carte d'arbitrage d'une association)
 *   · Résolution PAR LA FAÇADE d'écriture, acteur utilisateur, canal
 *     « À traiter » : compte, droit d'écrire, existence, activité et version
 *     y sont revalidés juste avant (CDC §8 : « avant application revalider »).
 *     Ce module n'écrit JAMAIS un événement de référence lui-même.
 *   · Carte posée sur un objet RÉEL : le justificatif cité, sinon un
 *     justificatif de l'un des deux, sinon (AC16 : « sans documents fictifs »)
 *     un ÉVÉNEMENT de l'Agenda de l'un des deux, lu dans le graphe N↔N. Aucun
 *     objet n'est créé ; sans objet réel, aucune carte.
 *   · UNE carte ouverte par paire (et par fait, pour la seconde question).
 *   · NON RÉGÉNÉRÉE APRÈS RÉPONSE : les preuves présentées par une carte à
 *     laquelle l'utilisateur a répondu ne font plus poser la question. Seule
 *     une preuve jamais présentée rouvre un arbitrage (AC14).
 *   · Carte PÉRIMÉE (fusionné, invalidé ou dissocié entre-temps) : fermée sans
 *     rien appliquer (AC18).
 *   · ISOLATION : tout est relu dans le compte.
 *   · Aucun effet dérivé : ni montant, ni événement d'Agenda, ni rappel, ni
 *     appel IA.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { pgClient } from '@/db';
import { toProcessActionEvents, toProcessActions } from '@/db/schema';
import { isPositiveId, normalizeEvidence, pairKey, type GraphEvidence } from '@/services/business-operations/graph/model';
import { CARD_FACT_ARBITRATION_DECLARATION_TEXT } from '@/services/business-operations/graph/reference-event-page';
import { SOURCE_ROLES, type SourceRole } from '@/services/business-operations/model';
import {
  normalizeProvider, semanticRoleOf, SEMANTIC_UNKNOWN_ROLE, SEMANTIC_USER_ROLE,
} from '@/services/business-operations/consolidation/model';
import { normalizeConflictProvider } from '@/services/business-operations/consolidation/attribute-conflicts';
import { canonicalProviderKey, type ProviderEquivalence } from '@/services/business-operations/consolidation/provider-equivalence';
import type { ActionProposal, ResolutionReason } from './action-model';
import { DATES_QUALIFIEES, frDate } from './operation-cards';
import {
  agendaItemOfOperations, evidenceIds, evidenceOfAccount, firstDocumentOfOperations, liveDocuments, referenceEventTitles,
} from './reference-event-card-anchor';
import type { DbClient, ResolveOptions, ResolveResult } from './resolve-action.service';

export const REFERENCE_EVENT_MERGE_RULE = 'REFERENCE-EVENT-MERGE';
export const REFERENCE_EVENT_FACT_RULE = 'REFERENCE-EVENT-FACT';
const MERGE_RELATION = 'referenceEventMerge';
const FACT_RELATION = 'referenceEventFact';

/** À valider par le PO. */
export const MERGE_SAME_LABEL = 'Oui, c’est la même';
/** À valider par le PO. */
export const MERGE_DISTINCT_LABEL = 'Non, ce sont deux opérations différentes';

/** Faits DATÉS comparables entre deux événements de référence (référentiel de la carte #750, repris à l'identique). */
export const FACT_DATE_FIELDS = ['plannedDate', 'startDate', 'realizedDate', 'endDate'] as const;
export type FactDateField = (typeof FACT_DATE_FIELDS)[number];
/**
 * Faits comparables entre deux événements de référence ASSOCIÉS.
 *
 * Lot 115 (#791) — **règle complétée, décision du PO du 16/11/2026** : le
 * PRESTATAIRE en fait partie. Deux événements de référence associés qui
 * désignent deux prestataires différents POUR LE MÊME FAIT posent désormais la
 * même question que deux dates (« laquelle / lequel est le bon ? »). À
 * l'INTÉRIEUR d'un même événement de référence, le prestataire est déjà
 * arbitré par la carte d'attribut (#750) : cette carte-ci ne le refait pas.
 *
 * « Même fait » pour le prestataire = **même rôle sémantique de la partie**
 * (référentiel unique `semanticRoleOf` : celle qui facture ou contracte,
 * l'exécutant d'un rapport, une partie de sinistre, l'émetteur d'un acte,
 * l'intermédiaire de paiement). La banque d'une preuve de paiement et le
 * fournisseur d'une facture ne sont pas le même fait : aucune question (même
 * règle que la qualification des contradictions, lot 113AQ).
 */
export const FACT_FIELDS = [...FACT_DATE_FIELDS, 'provider'] as const;
export type FactField = (typeof FACT_FIELDS)[number];
export const isFactField = (v: unknown): v is FactField => typeof v === 'string' && (FACT_FIELDS as readonly string[]).includes(v);
/** Le fait est-il une DATE (les quatre dates de la carte #750) ? */
export const isFactDateField = (f: FactField): f is FactDateField => f !== 'provider';
/** Colonne qui porte chaque fait (un seul endroit : lecture des faits ET détection des contradictions). */
export const FACT_COLUMNS: Readonly<Record<FactField, string>> = {
  plannedDate: 'planned_date', startDate: 'start_date', realizedDate: 'realized_date', endDate: 'end_date', provider: 'provider',
};
/** Paires examinées au plus par passage et par compte (le passage suivant reprend les autres). */
export const FACT_PAIRS_PER_PASS = 20;

/** Preuves conservées au plus dans une carte (borne de la façade). */
const EVIDENCE_MAX = 20;

/** UNE carte de fusion ouverte par paire d'événements de référence (dans les deux sens d'appel). */
export const referenceEventMergeKey = (a: number, b: number): string => `${MERGE_RELATION}:${pairKey(a, b)}`;
/** UNE carte de fait ouverte par paire ET par fait daté. */
export const referenceEventFactKey = (a: number, b: number, field: FactField): string => `${FACT_RELATION}:${pairKey(a, b)}:${field}`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Borne de la désignation d'un prestataire : celle du champ lui-même (`normalizeOperationPatch`). */
const PROVIDER_MAX = 200;
/**
 * Jeton d'une valeur dans une clé d'idempotence (`isIdempotencyKey` :
 * lettres, chiffres, `. _ : -`). Une date passe telle quelle — la clé des
 * cartes de date ne change donc pas ; une désignation de prestataire (espaces,
 * accents, apostrophes) passe par son empreinte stable. Pure.
 */
export const factIdempotencyToken = (v: string): string =>
  (/^[A-Za-z0-9._:-]{1,40}$/.test(v) ? v : `h${createHash('sha1').update(v).digest('hex').slice(0, 24)}`);

const isSourceRole = (v: unknown): v is SourceRole => typeof v === 'string' && (SOURCE_ROLES as readonly string[]).includes(v);

/**
 * Clé de comparaison d'une désignation de prestataire : la MÊME que celle de
 * la qualification des contradictions (lot 113AQ) — équivalence PROUVÉE du
 * compte (lot 86C) quand elle s'applique, sinon forme normalisée. Pure.
 */
export const providerComparisonKey = (raw: string, eq: ProviderEquivalence | null): string => {
  const brute = normalizeProvider(raw);
  const canonique = brute === null ? null : canonicalProviderKey(brute, eq);
  return normalizeConflictProvider(raw, canonique !== null && canonique !== brute ? canonique : null);
};

// ── Contextes ──────────────────────────────────────────────────────────────

export interface ReferenceEventMergeContext {
  kind: 'reference_event_merge';
  pairKey: string;
  /** Identité CANONIQUE proposée (choix par défaut : le plus ancien — à valider par le PO). */
  canonicalOperationId: number;
  /** Événement ABSORBÉ si l'utilisateur répond « c'est le même ». */
  absorbedOperationId: number;
  /** Version attendue de l'absorbé : périmée à la réponse → rien n'est appliqué. */
  absorbedVersion: number;
  events: Array<{ operationId: number; title: string }>;
  evidence: GraphEvidence[];
  evidenceKeys: string[];
  documents: Array<{ fileId: number; title: string }>;
}

export interface ReferenceEventFactContext {
  kind: 'reference_event_fact';
  pairKey: string;
  field: FactField;
  /** Les deux événements, leur valeur du fait et leur version attendue. */
  sides: Array<{ operationId: number; title: string; value: string; version: number }>;
  evidence: GraphEvidence[];
  evidenceKeys: string[];
  documents: Array<{ fileId: number; title: string }>;
}

export function isReferenceEventMergeContext(c: unknown): c is ReferenceEventMergeContext {
  const x = c as Partial<ReferenceEventMergeContext> | null;
  return !!x && typeof x === 'object' && x.kind === 'reference_event_merge' && typeof x.pairKey === 'string'
    && isPositiveId(x.canonicalOperationId) && isPositiveId(x.absorbedOperationId) && isPositiveId(x.absorbedVersion)
    && x.canonicalOperationId !== x.absorbedOperationId && Array.isArray(x.evidence) && Array.isArray(x.evidenceKeys)
    && x.evidenceKeys.length > 0 && Array.isArray(x.events) && x.events.length === 2;
}

/**
 * Valeur recevable pour un fait : une date civile pour les quatre dates, une
 * désignation de prestataire (bornée comme le champ) pour le prestataire.
 */
export const isFactValue = (field: FactField, v: unknown): v is string =>
  typeof v === 'string' && (isFactDateField(field) ? ISO_DATE.test(v) : v.trim().length > 0 && v.length <= PROVIDER_MAX);

export function isReferenceEventFactContext(c: unknown): c is ReferenceEventFactContext {
  const x = c as Partial<ReferenceEventFactContext> | null;
  if (!x || typeof x !== 'object' || x.kind !== 'reference_event_fact' || typeof x.pairKey !== 'string' || !isFactField(x.field)) return false;
  if (!Array.isArray(x.sides) || x.sides.length !== 2 || !Array.isArray(x.evidence) || !Array.isArray(x.evidenceKeys)) return false;
  const ids = new Set(x.sides.map((s) => s.operationId));
  return ids.size === 2 && x.sides.every((s) => isPositiveId(s.operationId) && isPositiveId(s.version) && isFactValue(x.field!, s.value))
    && new Set(x.sides.map((s) => s.value)).size === 2;
}

// ── Libellés et règles pures ───────────────────────────────────────────────

const borne = (s: string, n = 50) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const g = (s: string) => `« ${borne(s.replace(/\s+/g, ' ').trim())} »`;

/** Question de fusion (pure) — à valider par le PO. Neutre : aucune des deux réponses n'est suggérée. */
export function referenceEventMergeQuestion(titleA: string, titleB: string): string {
  return `${g(titleA)} et ${g(titleB)} : est-ce la même opération, ou deux ?`;
}

/** Propositions de fusion (pures) : fusionner, ou garder deux événements (état actuel). */
export function referenceEventMergeProposals(fileIds: readonly number[]): ActionProposal[] {
  return [
    { value: 'MERGE', label: MERGE_SAME_LABEL, confidence: 0.5, emphasis: 'neutral', evidenceIds: fileIds.map((f) => `file:${f}`) },
    { value: 'KEEP_DISTINCT', label: MERGE_DISTINCT_LABEL, confidence: 1, isCurrentValue: true },
  ];
}

export function parseMergeChoice(value: unknown): 'MERGE' | 'KEEP_DISTINCT' | null {
  return value === 'MERGE' || value === 'KEEP_DISTINCT' ? value : null;
}

/**
 * Question du fait contradictoire (pure) — reprend les libellés déjà posés par
 * la carte #750. Lot 115 (#791) : la forme « prestataire » est NOUVELLE (à
 * valider par le PO) et reprend mot pour mot la carte d'attribut de #750
 * (« indiquent des prestataires différents … : lequel est le bon ? »).
 */
export function referenceEventFactQuestion(field: FactField, titleA: string, titleB: string): string {
  return isFactDateField(field)
    ? `${g(titleA)} et ${g(titleB)} indiquent des ${DATES_QUALIFIEES[field]} différentes : laquelle est la bonne ?`
    : `${g(titleA)} et ${g(titleB)} indiquent des prestataires différents : lequel est le bon ?`;
}

/**
 * Propositions du fait (pures) : une par valeur réellement différente, chacune
 * nommant l'événement de référence qui la porte. Aucune n'est mise en avant :
 * les deux sont des valeurs en place, sur deux objets distincts.
 */
export function referenceEventFactProposals(
  field: FactField, sides: ReadonlyArray<{ operationId: number; title: string; value: string }>,
): ActionProposal[] {
  const vues = new Set<string>();
  const lib = (v: string) => (isFactDateField(field) ? frDate(v) ?? v : borne(v, 60));
  return sides
    .filter((s) => (vues.has(s.value) ? false : (vues.add(s.value), true)))
    .map((s) => ({
      value: `FACT:${s.value}`, label: `${lib(s.value)} — ${g(s.title)}`, confidence: 0.5, emphasis: 'neutral' as const,
    }));
}

/** Valeur retenue (pure) parmi celles présentées ; null : valeur forgée ou absente de la carte. */
export function parseFactChoice(value: unknown, sides: ReadonlyArray<{ value: string }>): string | null {
  if (typeof value !== 'string' || !value.startsWith('FACT:')) return null;
  const v = value.slice('FACT:'.length);
  return sides.some((s) => s.value === v) ? v : null;
}

/** Sources d'un jeu de preuves (`NATURE|identifiant`), dédoublonnées et triées (pure). */
export const mergeSourceKeys = (evidence: readonly GraphEvidence[]): string[] =>
  [...new Set(evidence.map((e) => `${e.kind}|${e.ref}`))].sort();

/** Toutes les preuves ont-elles déjà été présentées à une carte répondue ? (pure) */
export const mergeAlreadyAnswered = (keys: readonly string[], answeredKeys: ReadonlySet<string>): boolean =>
  keys.length === 0 || keys.every((k) => answeredKeys.has(k));

// ── Lectures communes ──────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const json = <T>(v: unknown): T | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v as T;
  try { return JSON.parse(v) as T; } catch { return null; }
};

/** Preuves déjà présentées par une carte RÉPONDUE de cette règle, pour cette clé de relation (ce compte). */
async function answeredKeysOf(accountId: number, ruleCode: string, relationKey: string): Promise<Set<string>> {
  const r = (await pgClient.unsafe(
    `SELECT trigger_context->'evidenceKeys' AS k FROM to_process_actions
      WHERE account_id = $1 AND rule_code = $2 AND resolution_reason = 'USER_ARBITRATED' AND relation_key = $3`,
    [accountId, ruleCode, relationKey] as never[],
  )) as unknown as Row[];
  return new Set(r.flatMap((x) => (json<unknown[]>(x.k) ?? []).filter((k): k is string => typeof k === 'string')));
}

/** Carte OUVERTE de cette règle pour cette clé de relation (ce compte), avec son objet porteur. */
async function openCardOf(accountId: number, ruleCode: string, relationKey: string): Promise<Row | undefined> {
  const [x] = (await pgClient.unsafe(
    `SELECT id, target_type, target_id, trigger_context FROM to_process_actions
      WHERE account_id = $1 AND rule_code = $2 AND resolved_at IS NULL AND relation_key = $3 ORDER BY id LIMIT 1`,
    [accountId, ruleCode, relationKey] as never[],
  )) as unknown as Row[];
  return x;
}

/**
 * Objet RÉEL qui porte la carte : celui de la carte ouverte, sinon un
 * justificatif cité, sinon un justificatif de l'un des deux événements de
 * référence, sinon (AC16) un ÉVÉNEMENT de l'Agenda de l'un des deux. Jamais un
 * objet créé pour l'occasion ; null : aucune carte.
 */
async function realAnchor(
  accountId: number, operationIds: readonly number[], citedFileIds: readonly number[], open: Row | undefined,
  /** Rempli au passage : identifiant → titre des justificatifs VIVANTS rencontrés (liens de la carte). */
  docTitles: Map<number, string>,
): Promise<{ type: 'DOCUMENT' | 'AGENDA_ITEM'; id: number } | null> {
  const docOuvert = open && open.target_type === 'DOCUMENT' ? Number(open.target_id) : null;
  const vivants = await liveDocuments(accountId, [...citedFileIds, ...(docOuvert !== null ? [docOuvert] : [])]);
  for (const [id, titre] of vivants) docTitles.set(id, titre);
  if (docOuvert !== null && vivants.has(docOuvert)) return { type: 'DOCUMENT', id: docOuvert };
  if (open && open.target_type === 'AGENDA_ITEM' && await agendaItemOfOperations(accountId, operationIds, Number(open.target_id))) {
    return { type: 'AGENDA_ITEM', id: Number(open.target_id) };
  }
  const cite = citedFileIds.filter((f) => vivants.has(f)).sort((a, b) => a - b)[0];
  if (cite !== undefined) return { type: 'DOCUMENT', id: cite };
  const d = await firstDocumentOfOperations(accountId, operationIds);
  if (d !== null) {
    for (const [id, titre] of await liveDocuments(accountId, [d])) docTitles.set(id, titre);
    return { type: 'DOCUMENT', id: d };
  }
  const item = await agendaItemOfOperations(accountId, operationIds, null);
  return item !== null ? { type: 'AGENDA_ITEM', id: item } : null;
}

/** Faits d'un événement de référence ACTIF du compte : version et valeur de chaque fait comparable. */
async function factsOf(accountId: number, ids: readonly number[]): Promise<Map<number, { version: number; values: Record<FactField, string | null> }>> {
  const r = (await pgClient.unsafe(
    `SELECT id, version, ${FACT_DATE_FIELDS.map((f) => `to_char(${FACT_COLUMNS[f]}, 'YYYY-MM-DD') AS "${f}"`).join(', ')},
            NULLIF(btrim(provider), '') AS "provider"
       FROM business_operations
      WHERE account_id = $1 AND id = ANY($2::bigint[]) AND invalidated_at IS NULL AND merged_into_operation_id IS NULL`,
    [accountId, `{${[...new Set(ids)].filter((x) => Number.isSafeInteger(x) && x > 0).join(',')}}`] as never[],
  )) as unknown as Row[];
  const out = new Map<number, { version: number; values: Record<FactField, string | null> }>();
  for (const x of r) {
    out.set(Number(x.id), {
      version: Number(x.version),
      values: {
        plannedDate: (x.plannedDate as string | null) ?? null, startDate: (x.startDate as string | null) ?? null,
        realizedDate: (x.realizedDate as string | null) ?? null, endDate: (x.endDate as string | null) ?? null,
        provider: (x.provider as string | null) ?? null,
      },
    });
  }
  return out;
}

/**
 * Rôle sémantique de la PARTIE qui porte le prestataire RETENU de chaque
 * événement de référence (référentiel UNIQUE `semanticRoleOf`, lu par la
 * qualification des contradictions et par le choix du prestataire canonique —
 * aucune énumération locale, aucune règle par enseigne).
 *
 * La provenance persistée (`attribute_provenance.provider.sourceId`, lot 78A)
 * désigne la source qui justifie la valeur en place ; son rôle de document,
 * sa nature et son autorité donnent le rôle de la partie. Sans provenance
 * lisible, le rôle est INCONNU : rien n'est comparable.
 */
async function providerPartyRoles(accountId: number, ids: readonly number[]): Promise<Map<number, string>> {
  const r = (await pgClient.unsafe(
    `SELECT o.id, s.source_kind, s.authority, COALESCE(s.source_role, c.payload->>'sourceRoleHint') AS role
       FROM business_operations o
       LEFT JOIN business_operation_sources s
         ON s.account_id = o.account_id AND s.operation_id = o.id AND s.active
        AND s.id = (o.attribute_provenance->'provider'->>'sourceId')::bigint
       LEFT JOIN document_operation_candidates c
         ON c.account_id = o.account_id AND c.status = 'ACTIVE' AND s.source_kind = 'DOCUMENT'
        AND c.file_id::text = s.source_entity_key AND c.candidate_key = s.locator->>'candidateKey'
      WHERE o.account_id = $1 AND o.id = ANY($2::bigint[])`,
    [accountId, `{${[...new Set(ids)].filter((x) => Number.isSafeInteger(x) && x > 0).join(',')}}`] as never[],
  )) as unknown as Row[];
  const out = new Map<number, string>();
  for (const x of r) {
    if (x.source_kind === null || x.source_kind === undefined) { out.set(Number(x.id), SEMANTIC_UNKNOWN_ROLE); continue; }
    const kind = String(x.source_kind);
    const role = isSourceRole(x.role) ? x.role : null;
    out.set(Number(x.id), semanticRoleOf('provider', {
      role,
      ...(kind === 'AGENDA' ? { agenda: { itemId: 0, realizedDate: null, realizationRecord: false } } : {}),
      ...(kind === 'ASSET_DATA' ? { structured: { nature: 'ASSET_DATA' } } : {}),
      coverageDocument: false,
    }, typeof x.authority === 'string' ? x.authority : null));
  }
  return out;
}

/**
 * Rôles de partie COMPARABLES entre deux événements de référence : le même, et
 * ni inconnu (rien n'est comparable) ni une saisie de l'utilisateur (sa parole
 * n'est pas confrontée à celle d'un document — lot 113AQ). Choix prudent, à
 * valider par le PO. Pure.
 */
export const comparableProviderRoles = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && a === b && a !== SEMANTIC_UNKNOWN_ROLE && a !== SEMANTIC_USER_ROLE;

/**
 * CONTRADICTIONS à arbitrer d'un compte : paires d'événements de référence
 * ACTIFS et ASSOCIÉS (relation active du graphe N↔N) qui portent, pour le MÊME
 * fait daté, deux valeurs différentes. C'est le seul « détecteur » de cette
 * carte : un CONSTAT (deux valeurs en base), jamais une heuristique — aucune
 * valeur n'est jugée, aucune n'est préférée, rien n'est écrit. Une valeur
 * absente d'un côté est un manque, pas une contradiction (comme le producteur).
 * Bornée au compte et à `limit` paires par passage ; ordre stable.
 */
export async function factContradictionCandidates(accountId: number, limit = FACT_PAIRS_PER_PASS): Promise<Array<{ operationAId: number; operationBId: number; field: FactField }>> {
  if (!isPositiveId(accountId)) return [];
  const diff = (f: FactDateField) => `(x.${FACT_COLUMNS[f]} IS NOT NULL AND y.${FACT_COLUMNS[f]} IS NOT NULL `
    + `AND x.${FACT_COLUMNS[f]} <> y.${FACT_COLUMNS[f]}) AS "${f}"`;
  const r = (await pgClient.unsafe(
    `SELECT LEAST(r.from_operation_id, r.to_operation_id) AS a, GREATEST(r.from_operation_id, r.to_operation_id) AS b,
            ${FACT_DATE_FIELDS.map(diff).join(', ')},
            NULLIF(btrim(x.provider), '') AS "providerX", NULLIF(btrim(y.provider), '') AS "providerY",
            r.from_operation_id AS fromid
       FROM business_operation_relations r
       JOIN business_operations x ON x.id = r.from_operation_id AND x.account_id = r.account_id
        AND x.invalidated_at IS NULL AND x.merged_into_operation_id IS NULL
       JOIN business_operations y ON y.id = r.to_operation_id AND y.account_id = r.account_id
        AND y.invalidated_at IS NULL AND y.merged_into_operation_id IS NULL
      WHERE r.account_id = $1 AND r.state = 'ACTIVE'
      ORDER BY a, b
      LIMIT $2`,
    [accountId, Math.max(1, Math.floor(limit))] as never[],
  )) as unknown as Row[];
  const out: Array<{ operationAId: number; operationBId: number; field: FactField }> = [];
  /** Paires dont les deux prestataires sont renseignés et textuellement différents (candidates à vérifier). */
  const tiers: Array<{ a: number; b: number; va: string; vb: string }> = [];
  for (const x of r) {
    for (const f of FACT_DATE_FIELDS) {
      if (x[f] === true) out.push({ operationAId: Number(x.a), operationBId: Number(x.b), field: f });
    }
    // Lot 115 (#791, décision du PO) : le prestataire. L'orientation de la relation n'est pas celle de la paire :
    // les valeurs sont remises dans l'ordre (a, b) avant toute comparaison.
    const depuis = Number(x.fromid) === Number(x.a);
    const va = (depuis ? x.providerX : x.providerY) as string | null;
    const vb = (depuis ? x.providerY : x.providerX) as string | null;
    if (va && vb && va !== vb) tiers.push({ a: Number(x.a), b: Number(x.b), va, vb });
  }
  if (!tiers.length) return out;
  // Désignations ÉQUIVALENTES d'un même prestataire (lot 86C) : jamais une contradiction. Les équivalences du
  // compte ne sont lues que s'il y a au moins une paire à vérifier.
  const ids = [...new Set(tiers.flatMap((t) => [t.a, t.b]))];
  const [eq, roles] = await Promise.all([
    loadProviderEquivalenceForCards(accountId),
    providerPartyRoles(accountId, ids),
  ]);
  // Équivalences illisibles : aucune question de prestataire (deux désignations d'un même tiers paraîtraient
  // contradictoires). Les contradictions de DATES, elles, ne dépendent pas de cette lecture.
  if (eq === null) return out;
  for (const t of tiers) {
    if (providerComparisonKey(t.va, eq) === providerComparisonKey(t.vb, eq)) continue;
    // « Pour le MÊME fait » : même rôle sémantique de la partie des deux côtés (banque ≠ fournisseur).
    if (!comparableProviderRoles(roles.get(t.a), roles.get(t.b))) continue;
    out.push({ operationAId: t.a, operationBId: t.b, field: 'provider' });
  }
  return out;
}

/** Équivalences de désignations du compte (service PARTAGÉ, mêmes preuves que T3) ; `null` si illisibles. */
async function loadProviderEquivalenceForCards(accountId: number): Promise<ProviderEquivalence | null> {
  try {
    const [{ loadAccountProviderEquivalence }, { postgresRunner }] = await Promise.all([
      import('@/services/relations/operation-suppliers'),
      import('@/services/business-operations/grouping/runner'),
    ]);
    const runner = postgresRunner(pgClient as unknown as { unsafe: (t: string, p?: never[]) => Promise<unknown> });
    return await loadAccountProviderEquivalence(runner, accountId);
  } catch (e) {
    // Sans équivalences, deux désignations d'un même tiers pourraient paraître contradictoires : on ne pose
    // alors AUCUNE question de prestataire (prudence — jamais une fausse contradiction).
    console.error(`[to-process] équivalences de désignations illisibles (compte ${accountId}) :`, (e as Error).message);
    return null;
  }
}

export interface MergeCardOutcome {
  /**
   * POSTED / UPDATED : la question est posée (ou mise à jour) ; ALREADY_ANSWERED : l'utilisateur a déjà répondu sur
   * ces preuves ; NO_ANCHOR : aucun objet réel pour porter la carte ; NOT_APPLICABLE : la situation n'appelle pas la
   * question ; SKIPPED : refusée par la file ; FAILED : panne.
   */
  status: 'POSTED' | 'UPDATED' | 'ALREADY_ANSWERED' | 'NO_ANCHOR' | 'NOT_APPLICABLE' | 'SKIPPED' | 'FAILED';
  actionId?: number;
  reason?: string;
}

// ── 1. « Même événement de référence, ou deux ? » ──────────────────────────

export interface MergeArbitrationRequest {
  operationAId: number;
  operationBId: number;
  /** Preuves de la même réalité réunies par l'inférence (au moins une : §7, « un score IA seul est insuffisant »). */
  evidence: readonly GraphEvidence[];
}

/**
 * Pose (ou met à jour) la carte « même événement de référence, ou deux ? ».
 * Appelée par un traitement qui a trouvé un doublon PROBABLE mais que le CDC
 * ne l'autorise pas à fusionner seul (AC12). Ne lève jamais.
 */
export async function requestReferenceEventMergeArbitration(accountId: number, req: MergeArbitrationRequest): Promise<MergeCardOutcome> {
  try {
    const recues = normalizeEvidence(req?.evidence);
    if (!isPositiveId(accountId) || !req || !isPositiveId(req.operationAId) || !isPositiveId(req.operationBId)
        || req.operationAId === req.operationBId || recues === null || recues.length === 0) {
      return { status: 'NOT_APPLICABLE', reason: 'INVALID_REQUEST' };
    }
    const evidence = await evidenceOfAccount(accountId, recues);
    if (!evidence.length) return { status: 'NOT_APPLICABLE', reason: 'NO_EVIDENCE_IN_ACCOUNT' };
    const paire = pairKey(req.operationAId, req.operationBId);
    const cle = referenceEventMergeKey(req.operationAId, req.operationBId);

    // Les deux événements existent-ils encore, actifs, dans CE compte ?
    const titres = await referenceEventTitles(accountId, [req.operationAId, req.operationBId]);
    const faits = await factsOf(accountId, [req.operationAId, req.operationBId]);
    if (titres.size !== 2 || faits.size !== 2) return { status: 'NOT_APPLICABLE', reason: 'REFERENCE_EVENT_WITHDRAWN' };

    const dejaVues = await answeredKeysOf(accountId, REFERENCE_EVENT_MERGE_RULE, cle);
    const ouverte = await openCardOf(accountId, REFERENCE_EVENT_MERGE_RULE, cle);
    const ancien = ouverte ? json<unknown>(ouverte.trigger_context) : null;
    const reunies = normalizeEvidence([...(isReferenceEventMergeContext(ancien) ? ancien.evidence : []), ...evidence].slice(0, EVIDENCE_MAX)) ?? evidence;
    const keys = mergeSourceKeys(reunies);
    if (mergeAlreadyAnswered(keys, dejaVues)) return { status: 'ALREADY_ANSWERED' };

    const cites = evidenceIds(reunies, 'DOCUMENT');
    const titresDocs = new Map<number, string>();
    const ancre = await realAnchor(accountId, [req.operationAId, req.operationBId], cites, ouverte, titresDocs);
    if (ancre === null) return { status: 'NO_ANCHOR', reason: 'NO_REAL_OBJECT' };
    const documents = [...new Set(cites)].filter((f) => titresDocs.has(f)).sort((a, b) => a - b).map((f) => ({ fileId: f, title: titresDocs.get(f)! }));

    // Identité CANONIQUE : le plus ANCIEN des deux (choix par défaut, à valider par le PO ; même règle que la
    // consolidation existante, qui rattache une source au plus ancien).
    const canonique = Math.min(req.operationAId, req.operationBId);
    const absorbe = Math.max(req.operationAId, req.operationBId);
    const ctx: ReferenceEventMergeContext = {
      kind: 'reference_event_merge', pairKey: paire, canonicalOperationId: canonique, absorbedOperationId: absorbe,
      absorbedVersion: faits.get(absorbe)!.version,
      events: [{ operationId: canonique, title: titres.get(canonique)! }, { operationId: absorbe, title: titres.get(absorbe)! }],
      evidence: reunies, evidenceKeys: keys, documents,
    };
    const { upsertAction } = await import('./to-process-action.service');
    const u = await upsertAction({
      accountId, targetType: ancre.type, targetId: ancre.id, relationKey: cle, actionKind: 'ARBITRATE', ruleCode: REFERENCE_EVENT_MERGE_RULE,
      question: referenceEventMergeQuestion(titres.get(canonique)!, titres.get(absorbe)!),
      proposals: referenceEventMergeProposals(documents.map((d) => d.fileId)),
      triggerContext: ctx as unknown as Record<string, unknown>,
    });
    if (u.status === 'CREATED') return { status: 'POSTED', ...(u.actionId !== undefined ? { actionId: u.actionId } : {}) };
    if (u.status === 'UPDATED') return { status: 'UPDATED', ...(u.actionId !== undefined ? { actionId: u.actionId } : {}) };
    return { status: 'SKIPPED', reason: u.code ?? u.reason };
  } catch (e) {
    console.error(`[to-process] arbitrage de fusion (compte ${accountId}) non posé :`, (e as Error).message);
    return { status: 'FAILED', reason: 'TECHNICAL_FAILURE' };
  }
}

/**
 * L'utilisateur a-t-il déjà répondu « ce sont deux événements différents »
 * pour cette paire ? (CDC §7 : « mémoriser la séparation ; un rejeu T3
 * n'inverse pas cette décision »). Lu par la fusion automatique de T3 AVANT
 * toute fusion : une séparation décidée n'est jamais défaite par une
 * inférence. Ne lève jamais : en cas de panne, répond VRAI (prudence — on ne
 * fusionne pas sur une mémoire illisible).
 */
export async function mergeRefusedByUser(accountId: number, operationAId: number, operationBId: number): Promise<boolean> {
  if (!isPositiveId(accountId) || !isPositiveId(operationAId) || !isPositiveId(operationBId) || operationAId === operationBId) return false;
  try {
    const [x] = (await pgClient.unsafe(
      `SELECT 1 FROM to_process_actions a
         JOIN to_process_action_events e ON e.action_id = a.id AND e.account_id = a.account_id
        WHERE a.account_id = $1 AND a.rule_code = $2 AND a.resolution_reason = 'USER_ARBITRATED' AND a.relation_key = $3
          AND e.event = 'RESOLVED_ARBITRATION' AND e.new_value->>'kind' = 'KEEP_DISTINCT' LIMIT 1`,
      [accountId, REFERENCE_EVENT_MERGE_RULE, referenceEventMergeKey(operationAId, operationBId)] as never[],
    )) as unknown as Row[];
    return !!x;
  } catch (e) {
    console.error(`[to-process] mémoire de séparation illisible (compte ${accountId}) :`, (e as Error).message);
    return true;
  }
}

// ── 2. « Quel fait est correct ? » entre deux événements de référence ──────

export interface FactArbitrationRequest {
  operationAId: number;
  operationBId: number;
  field: FactField;
  evidence?: readonly GraphEvidence[];
}

/**
 * Pose (ou met à jour) la carte « quel fait est correct ? » entre deux
 * événements de référence ASSOCIÉS qui portent, pour le MÊME fait daté, deux
 * valeurs contradictoires. Deux événements NON associés ne sont pas comparés :
 * deux dates de nature différente ne se contredisent pas (CDC §11, AC34). Ne
 * lève jamais.
 */
export async function requestReferenceEventFactArbitration(accountId: number, req: FactArbitrationRequest): Promise<MergeCardOutcome> {
  try {
    const recues = normalizeEvidence(req?.evidence ?? []);
    if (!isPositiveId(accountId) || !req || !isPositiveId(req.operationAId) || !isPositiveId(req.operationBId)
        || req.operationAId === req.operationBId || !isFactField(req.field) || recues === null) {
      return { status: 'NOT_APPLICABLE', reason: 'INVALID_REQUEST' };
    }
    const cle = referenceEventFactKey(req.operationAId, req.operationBId, req.field);

    // Les deux événements sont-ils ASSOCIÉS, dans CE compte ? Sans relation active, la question n'a pas de sens.
    const [rel] = (await pgClient.unsafe(
      `SELECT 1 FROM business_operation_relations r
        WHERE r.account_id = $1 AND r.state = 'ACTIVE'
          AND LEAST(r.from_operation_id, r.to_operation_id) = LEAST($2::bigint, $3::bigint)
          AND GREATEST(r.from_operation_id, r.to_operation_id) = GREATEST($2::bigint, $3::bigint) LIMIT 1`,
      [accountId, req.operationAId, req.operationBId] as never[],
    )) as unknown as Row[];
    if (!rel) return { status: 'NOT_APPLICABLE', reason: 'NOT_ASSOCIATED' };

    const titres = await referenceEventTitles(accountId, [req.operationAId, req.operationBId]);
    const faits = await factsOf(accountId, [req.operationAId, req.operationBId]);
    if (titres.size !== 2 || faits.size !== 2) return { status: 'NOT_APPLICABLE', reason: 'REFERENCE_EVENT_WITHDRAWN' };
    const sides = [req.operationAId, req.operationBId].map((id) => ({
      operationId: id, title: titres.get(id)!, value: faits.get(id)!.values[req.field], version: faits.get(id)!.version,
    }));
    // Une valeur absente n'est pas une contradiction : c'est un manque (jamais une carte).
    if (sides.some((s) => s.value === null)) return { status: 'NOT_APPLICABLE', reason: 'FACT_MISSING' };
    if (sides[0]!.value === sides[1]!.value) return { status: 'NOT_APPLICABLE', reason: 'NO_CONTRADICTION' };
    const retenus = sides as Array<{ operationId: number; title: string; value: string; version: number }>;
    if (req.field === 'provider') {
      // Une valeur qu'on ne pourrait pas réécrire (au-delà de la borne du champ) ne fait pas une question.
      if (retenus.some((s) => !isFactValue('provider', s.value))) return { status: 'NOT_APPLICABLE', reason: 'PROVIDER_NOT_WRITABLE' };
      // Mêmes gardes que la détection (jamais une fausse contradiction, même sur un appel direct) :
      // désignations équivalentes prouvées du compte, et MÊME rôle sémantique de la partie des deux côtés.
      const eq = await loadProviderEquivalenceForCards(accountId);
      if (eq === null) return { status: 'NOT_APPLICABLE', reason: 'PROVIDER_EQUIVALENCE_UNREADABLE' };
      if (providerComparisonKey(retenus[0]!.value, eq) === providerComparisonKey(retenus[1]!.value, eq)) {
        return { status: 'NOT_APPLICABLE', reason: 'EQUIVALENT_PROVIDER_DESIGNATIONS' };
      }
      const roles = await providerPartyRoles(accountId, [req.operationAId, req.operationBId]);
      if (!comparableProviderRoles(roles.get(req.operationAId), roles.get(req.operationBId))) {
        return { status: 'NOT_APPLICABLE', reason: 'PROVIDER_ROLES_NOT_COMPARABLE' };
      }
    }

    const evidence = await evidenceOfAccount(accountId, recues);
    const dejaVues = await answeredKeysOf(accountId, REFERENCE_EVENT_FACT_RULE, cle);
    const ouverte = await openCardOf(accountId, REFERENCE_EVENT_FACT_RULE, cle);
    const ancien = ouverte ? json<unknown>(ouverte.trigger_context) : null;
    const reunies = normalizeEvidence([...(isReferenceEventFactContext(ancien) ? ancien.evidence : []), ...evidence].slice(0, EVIDENCE_MAX)) ?? evidence;
    // La contradiction elle-même est le constat : les valeurs en présence font la mémoire, et une preuve citée s'y ajoute.
    const keys = [...new Set([...mergeSourceKeys(reunies), ...retenus.map((s) => `FACT|${s.operationId}:${s.value}`)])].sort();
    if (mergeAlreadyAnswered(keys, dejaVues)) return { status: 'ALREADY_ANSWERED' };

    const cites = evidenceIds(reunies, 'DOCUMENT');
    const titresDocs = new Map<number, string>();
    const ancre = await realAnchor(accountId, [req.operationAId, req.operationBId], cites, ouverte, titresDocs);
    if (ancre === null) return { status: 'NO_ANCHOR', reason: 'NO_REAL_OBJECT' };
    const documents = [...new Set(cites)].filter((f) => titresDocs.has(f)).sort((a, b) => a - b).map((f) => ({ fileId: f, title: titresDocs.get(f)! }));

    const ctx: ReferenceEventFactContext = {
      kind: 'reference_event_fact', pairKey: pairKey(req.operationAId, req.operationBId), field: req.field,
      sides: retenus, evidence: reunies, evidenceKeys: keys, documents,
    };
    const { upsertAction } = await import('./to-process-action.service');
    const u = await upsertAction({
      accountId, targetType: ancre.type, targetId: ancre.id, relationKey: cle, actionKind: 'ARBITRATE', ruleCode: REFERENCE_EVENT_FACT_RULE,
      question: referenceEventFactQuestion(req.field, retenus[0]!.title, retenus[1]!.title),
      proposals: referenceEventFactProposals(req.field, retenus),
      triggerContext: ctx as unknown as Record<string, unknown>,
    });
    if (u.status === 'CREATED') return { status: 'POSTED', ...(u.actionId !== undefined ? { actionId: u.actionId } : {}) };
    if (u.status === 'UPDATED') return { status: 'UPDATED', ...(u.actionId !== undefined ? { actionId: u.actionId } : {}) };
    return { status: 'SKIPPED', reason: u.code ?? u.reason };
  } catch (e) {
    console.error(`[to-process] arbitrage d’un fait (compte ${accountId}) non posé :`, (e as Error).message);
    return { status: 'FAILED', reason: 'TECHNICAL_FAILURE' };
  }
}

// ── Résolution ─────────────────────────────────────────────────────────────

type Action = typeof toProcessActions.$inferSelect;

/** Refus de la façade qui tiennent à l'ACTEUR (la carte reste ouverte) — tout autre refus rend la carte périmée. */
const ACTOR_REFUSALS: ReadonlySet<string> = new Set(['READ_ONLY_ACCOUNT', 'NOT_A_MEMBER']);

/** Cette règle est-elle l'une des deux cartes de fusion ? */
export const isMergeCardRule = (code: string): boolean => code === REFERENCE_EVENT_MERGE_RULE || code === REFERENCE_EVENT_FACT_RULE;

/**
 * Résolution des deux cartes (appelée par `resolveArbitration`, action
 * verrouillée). Le choix est appliqué PAR LA FAÇADE d'écriture, acteur
 * utilisateur, canal « À traiter », avec la version connue de la carte.
 * `KEEP_DISTINCT` n'écrit RIEN : la séparation vit dans la mémoire de la carte
 * (relue par la fusion automatique de T3, `mergeRefusedByUser`).
 */
export async function resolveReferenceEventMergeCard(
  tx: DbClient, action: Action, value: unknown, accountId: number, options: ResolveOptions,
): Promise<ResolveResult & { afterCommit?: () => Promise<void> }> {
  const userId = options.userId ?? null;
  // Une décision d'identité est celle d'un utilisateur identifié : sans lui, rien n'est appliqué.
  if (!isPositiveId(userId)) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  const now = new Date();
  const fermer = async (choix: string, reason: ResolutionReason, event: string, details: Record<string, unknown>) => {
    await tx.update(toProcessActions).set({ resolvedAt: now, resolutionReason: reason, updatedAt: now })
      .where(and(eq(toProcessActions.id, action.id), eq(toProcessActions.accountId, accountId)));
    await tx.insert(toProcessActionEvents).values({
      actionId: action.id, accountId, event, actorUserId: userId, targetType: action.targetType, targetId: action.targetId,
      fieldKey: action.relationKey, newValue: { kind: choix } as never,
      details: { ruleCode: action.ruleCode, cycleNumber: action.cycleNumber, ...details }, createdAt: now,
    });
  };
  const contexte = (choix: string) => ({
    accountId, actor: { kind: 'USER' as const, userId, channel: 'TO_PROCESS' as const },
    idempotencyKey: `to-process:${action.publicId}:${action.cycleNumber}:${choix}`, correlationId: `to-process:${action.publicId}`,
  });

  // ── « Même événement de référence, ou deux ? » ──
  if (action.ruleCode === REFERENCE_EVENT_MERGE_RULE) {
    const ctx = action.triggerContext;
    if (!isReferenceEventMergeContext(ctx)) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
    const choix = parseMergeChoice(value);
    if (!choix) return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
    if (choix === 'KEEP_DISTINCT') {
      // Deux événements distincts : RIEN n'est écrit. La séparation est mémorisée par la carte répondue.
      await fermer(choix, 'USER_ARBITRATED', 'RESOLVED_ARBITRATION', {
        choice: choix, pairKey: ctx.pairKey, evidenceKeys: ctx.evidenceKeys, changed: false,
      });
      return { ok: true, previousValue: null, undoable: false };
    }
    const facade = await import('@/services/business-operations/operation-write.facade');
    const r = await facade.mergeOperations(contexte(choix), {
      absorbedOperationId: ctx.absorbedOperationId, canonicalOperationId: ctx.canonicalOperationId,
      expectedVersion: ctx.absorbedVersion, evidence: ctx.evidence, reasonCode: 'TO_PROCESS_MERGE_ACCEPTED',
    });
    if (r.status === 'FAILED') throw new Error(`[to-process] arbitrage de fusion ${action.publicId} : écriture impossible (${r.code})`);
    if (r.status !== 'APPLIED') {
      if (r.status === 'FORBIDDEN' && ACTOR_REFUSALS.has(r.code)) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
      await fermer(choix, 'OBSOLETE', 'OBSOLETE', { reason: r.code, status: r.status });
      return { ok: false, previousValue: null, error: 'STALE' };
    }
    await options.onAfterFieldWrite?.();
    await fermer(choix, 'USER_ARBITRATED', 'RESOLVED_ARBITRATION', {
      choice: choix, pairKey: ctx.pairKey, canonicalOperationId: ctx.canonicalOperationId, absorbedOperationId: ctx.absorbedOperationId,
      evidenceKeys: ctx.evidenceKeys, changed: r.changed, replayed: r.replayed,
    });
    return { ok: true, previousValue: null, undoable: false };
  }

  // ── « Quel fait est correct ? » ──
  const ctx = action.triggerContext;
  if (!isReferenceEventFactContext(ctx)) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
  const retenue = parseFactChoice(value, ctx.sides);
  if (retenue === null) return { ok: false, previousValue: null, error: 'INVALID_VALUE' };
  const aCorriger = ctx.sides.filter((s) => s.value !== retenue);
  if (!aCorriger.length) {
    await fermer(`FACT:${retenue}`, 'USER_ARBITRATED', 'RESOLVED_ARBITRATION', { choice: retenue, field: ctx.field, evidenceKeys: ctx.evidenceKeys, changed: false });
    return { ok: true, previousValue: null, undoable: false };
  }
  const facade = await import('@/services/business-operations/operation-write.facade');
  for (const side of aCorriger) {
    const cle = contexte(`FACT:${factIdempotencyToken(retenue)}:${side.operationId}`);
    // Une DATE se corrige par `correctOperation` (sans déclaration demandée) ; le PRESTATAIRE ne se corrige pas
    // par cette commande (règle de la carte #744, inchangée) : il est posé par la commande W22 avec une
    // déclaration TECHNIQUE fixe, jamais montrée à l'utilisateur — elle protège la valeur choisie de toute
    // réécriture par T3, exactement comme la source de protection d'une correction de date.
    const r = isFactDateField(ctx.field)
      ? await facade.correctOperation(cle, {
        operationId: side.operationId, expectedVersion: side.version,
        attributes: { [ctx.field]: retenue } as Record<FactDateField, string>, reasonCode: 'TO_PROCESS_FACT_ARBITRATED',
      })
      : await facade.updateOperation(cle, {
        operationId: side.operationId, expectedVersion: side.version, declaration: CARD_FACT_ARBITRATION_DECLARATION_TEXT,
        attributes: { provider: retenue }, reasonCode: 'TO_PROCESS_FACT_ARBITRATED',
      });
    if (r.status === 'FAILED') throw new Error(`[to-process] arbitrage d’un fait ${action.publicId} : écriture impossible (${r.code})`);
    if (r.status !== 'APPLIED') {
      if (r.status === 'FORBIDDEN' && ACTOR_REFUSALS.has(r.code)) return { ok: false, previousValue: null, error: 'FIELD_NOT_RESOLVABLE' };
      // Version périmée, événement retiré : la carte ne vaut plus (rien n'a été écrit sur CET événement).
      await fermer(`FACT:${retenue}`, 'OBSOLETE', 'OBSOLETE', { reason: r.code, status: r.status, operationId: side.operationId });
      return { ok: false, previousValue: null, error: 'STALE' };
    }
  }
  await options.onAfterFieldWrite?.();
  await fermer(`FACT:${retenue}`, 'USER_ARBITRATED', 'RESOLVED_ARBITRATION', {
    choice: retenue, field: ctx.field, pairKey: ctx.pairKey, corrected: aCorriger.map((s) => s.operationId), evidenceKeys: ctx.evidenceKeys, changed: true,
  });
  return { ok: true, previousValue: null, undoable: false };
}
