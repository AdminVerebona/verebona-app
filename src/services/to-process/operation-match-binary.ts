/**
 * Lot 110D — arbitrage « même réalité » en question BINAIRE par Opération
 * candidate (ticket P1 « Arbitrage Opération : Oui / Non au lieu de
 * « A ou B ? » »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CAUSE CORRIGÉE
 *
 * Jusqu'au lot 109, la carte OPERATION-MATCH présentait chaque Opération
 * candidate par UN SEUL document (le plus récent de ses sources) et en
 * faisait un bouton exclusif « Oui, « titre » » ; la carte ajoutait « Autre ».
 * Deux Opérations candidates (conflit de rapprochements CERTAINS, ou
 * ambiguïté M3) devenaient donc « même achat que « A » ou que « B » ? » : un
 * choix entre DOCUMENTS alors que la question porte sur une IDENTITÉ
 * d'Opération, et une Opération documentée par plusieurs pièces n'en
 * montrait qu'une.
 *
 * NOUVEAU MODÈLE (ce module, pur + lectures bornées au compte)
 *
 *   · UNE question par Opération candidate, la première de l'ordre de
 *     préférence de T3 (`MatchCardNeed.operationIds`, identifiants
 *     canoniques : une Opération absorbée est suivie jusqu'à la canonique,
 *     deux identifiants de la même réalité n'en font qu'un) :
 *       « Ce document concerne-t-il le même achat que les documents
 *         suivants ? »  + les RÉFÉRENCES de cette Opération (documents
 *         membres actifs, événements de l'Agenda qui la représentent), en
 *         contexte cliquable, jamais en réponse ;
 *     deux boutons : « Oui » / « Non » (valeurs `YES:<id>` / `NO:<id>` : la
 *     réponse désigne l'Opération affichée — une carte mise à jour entre la
 *     lecture et le clic est refusée « STALE », jamais réinterprétée).
 *   · Le groupe de références est l'APPARTENANCE persistée à l'Opération
 *     (`business_operation_documents` actif, `agenda_items.business_operation_id`),
 *     jamais une ressemblance de titre, le même bien, le même fournisseur ou
 *     des montants / dates proches. Les autres Opérations candidates ne sont
 *     ni affichées ni mêlées : elles restent dans le contexte
 *     (`otherCandidateOperationIds`) et seront examinées si l'utilisateur
 *     répond « Non » (décision REJECTED sur l'Opération entière, puis T3).
 *   · Libellé métier depuis le TYPE persisté de l'Opération (achat,
 *     intervention, contrat, sinistre, financement, vente) ; sinon « le même
 *     événement de référence » — jamais « Opération » à l'écran (règle
 *     permanente du produit ; « événement » seul désigne une entrée de
 *     l'Agenda depuis le lot 109I).
 *   · Empreinte de contexte (`contextFingerprint`) : Opération, type et
 *     références présentées — tracée avec la réponse (provenance).
 *
 * Les références sont relues À LA LECTURE de la file (mêmes règles de
 * visibilité que le contrat de lecture 109A : document du compte, non
 * supprimé, déposé ; Opération active) : un document ajouté à l'Opération
 * apparaît sans dupliquer la carte ni changer le sens du choix.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { pgClient } from '@/db';
import { documentTitleColumnsSql, documentTitleOf, type DocumentTitleColumns } from '@/lib/documents/document-title-source';
import { documentTypeLabelOrNull } from '@/lib/referential/user-facing-labels';
import type { ActionProposal } from './action-model';

// ── Paramètres (centralisés) ────────────────────────────────────────────────

/** Forme de la carte OPERATION-MATCH portée par `trigger_context.form` (absente : ancienne carte « A ou B »). */
export const OPERATION_MATCH_BINARY_FORM = 'BINARY';
/** Version du contexte de la carte binaire. */
export const OPERATION_MATCH_CONTEXT_VERSION = 2;
/** Références listées au plus sur une carte (au-delà : compteur « et N autres »). */
export const OPERATION_MATCH_MAX_REFERENCES = 20;
/** Motif de la décision REJECTED « Non » : refus de CETTE Opération, sans autoriser une création. */
export const USER_NOT_SAME_OPERATION_REASON = 'USER_NOT_SAME_OPERATION';
/** Motif de la décision CONFIRMED « Oui ». */
export const USER_SAME_OPERATION_REASON = 'USER_SAME_OPERATION';

// ── Modèle ──────────────────────────────────────────────────────────────────

export type OperationReferenceKind = 'document' | 'event';

/** Une preuve de l'Opération présentée en contexte (jamais une réponse). */
export interface OperationReference {
  kind: OperationReferenceKind;
  /** `asset_files.id` (document) ou `agenda_items.id` (événement de l'Agenda). */
  id: number;
  title: string;
  /** Type lisible (« Facture », « Compromis de vente »…, « Événement »), sinon null. */
  typeLabel: string | null;
  /** Date utile ISO (date du document, date de l'événement), sinon null. */
  date: string | null;
}

/** Contexte persisté d'une carte binaire (`trigger_context`). */
export interface BinaryMatchContext {
  kind: 'operation_match';
  form: typeof OPERATION_MATCH_BINARY_FORM;
  version: typeof OPERATION_MATCH_CONTEXT_VERSION;
  candidateKey: string;
  basis: 'CERTAIN' | 'M3';
  /** Opération sur laquelle porte la question (canonique). */
  operationId: number;
  /** Synonyme explicite (contrat du ticket) : l'Opération candidate. */
  candidateOperationId: number;
  /** Compatibilité des lecteurs existants (cohérence, liens directs) : la seule Opération proposée. */
  operationIds: number[];
  /** Autres Opérations candidates de T3, NON présentées (examinées après un « Non »). */
  otherCandidateOperationIds: number[];
  operationType: string | null;
  references: OperationReference[];
  referenceCount: number;
  contextFingerprint: string;
}

/** Vue « références » d'une carte (lecture de la file). */
export interface OperationReferencesView {
  items: Array<OperationReference & { meta: string }>;
  /** Références non listées (au-delà du plafond). */
  hidden: number;
}

export function isBinaryMatchContext(ctx: unknown): ctx is BinaryMatchContext {
  const c = ctx as Partial<BinaryMatchContext> | null;
  return !!c && typeof c === 'object' && c.kind === 'operation_match' && c.form === OPERATION_MATCH_BINARY_FORM
    && Number.isSafeInteger(c.operationId) && (c.operationId as number) > 0;
}

// ── Libellés (purs) ─────────────────────────────────────────────────────────

/** Nom métier d'une Opération selon son type persisté — jamais « Opération » (P09, 109I). */
const NOMS: Readonly<Record<string, string>> = {
  ACQUISITION: 'le même achat',
  INTERVENTION: 'la même intervention',
  CONTRACT: 'le même contrat',
  CLAIM: 'le même sinistre',
  FINANCING: 'le même financement',
  DISPOSAL: 'la même vente',
};
/** Repli : la règle permanente interdit « opération » à l'écran ; « événement » seul désigne l'Agenda (109I). */
export const BINARY_MATCH_DEFAULT_NOUN = 'le même événement de référence';

export function binaryMatchNoun(type: string | null | undefined): string {
  return (type && NOMS[type]) || BINARY_MATCH_DEFAULT_NOUN;
}

const frDate = (iso: string | null | undefined): string | null =>
  iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10).split('-').reverse().join('/') : null;

/** Désignation des références dans la question (pure) : documents, événements, ou les deux. */
function referencesPhrase(refs: readonly Pick<OperationReference, 'kind'>[]): string {
  const docs = refs.filter((r) => r.kind === 'document').length;
  const evts = refs.length - docs;
  if (docs && evts) return 'les documents et événements suivants';
  if (evts) return evts > 1 ? 'les événements suivants' : 'l’événement suivant';
  return docs > 1 ? 'les documents suivants' : 'le document suivant';
}

/**
 * Question (pure). Sans aucune référence consultable (cas limite : Opération
 * sans membre visible), la question s'appuie sur la désignation persistée de
 * l'Opération (prestataire, date) plutôt que d'inventer une preuve.
 */
export function binaryMatchQuestion(
  type: string | null | undefined, refs: readonly Pick<OperationReference, 'kind'>[],
  fallback: { provider?: string | null; date?: string | null } = {},
): string {
  const nom = binaryMatchNoun(type);
  if (refs.length) return `Ce document concerne-t-il ${nom} que ${referencesPhrase(refs)} ?`;
  const quoi = [fallback.provider?.trim() ? `« ${fallback.provider.trim().slice(0, 60)} »` : null, frDate(fallback.date ?? null) ? `du ${frDate(fallback.date ?? null)}` : null]
    .filter(Boolean).join(' ');
  return quoi ? `Ce document concerne-t-il ${nom} (${quoi}) ?` : `Ce document concerne-t-il ${nom} déjà connu ?`;
}

/** Deux propositions, jamais une par référence ni « Autre » (pure). Aucune n'est présélectionnée. */
export function binaryMatchProposals(operationId: number): ActionProposal[] {
  return [
    { value: `YES:${operationId}`, label: 'Oui', confidence: 0.6 },
    { value: `NO:${operationId}`, label: 'Non', confidence: 0.5 },
  ];
}

/** Ligne de contexte d'une référence : type · date (pure). */
export function referenceMeta(r: Pick<OperationReference, 'kind' | 'typeLabel' | 'date'>): string {
  const type = r.typeLabel ?? (r.kind === 'event' ? 'Événement' : 'Document');
  const d = frDate(r.date);
  return d ? `${type} · ${d}` : type;
}

/** Empreinte du contexte présenté (pure, stable : ordre des références indifférent). */
export function binaryMatchFingerprint(operationId: number, type: string | null, refs: readonly Pick<OperationReference, 'kind' | 'id'>[]): string {
  const cles = [...new Set(refs.map((r) => `${r.kind}:${r.id}`))].sort();
  return createHash('sha256').update(JSON.stringify({ o: operationId, t: type ?? null, r: cles })).digest('hex').slice(0, 32);
}

/** Ordre de présentation : chronologique (date utile), puis documents avant événements, puis identifiant (pur). */
export function sortReferences<T extends Pick<OperationReference, 'kind' | 'id' | 'date'>>(refs: readonly T[]): T[] {
  return [...refs].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999')
    || (a.kind === b.kind ? 0 : a.kind === 'document' ? -1 : 1) || a.id - b.id);
}

/** Vue des références pour la carte (pure) : bornée, lisible. */
export function referencesView(refs: readonly OperationReference[]): OperationReferencesView {
  const tri = sortReferences(refs);
  return {
    items: tri.slice(0, OPERATION_MATCH_MAX_REFERENCES).map((r) => ({ ...r, meta: referenceMeta(r) })),
    hidden: Math.max(0, tri.length - OPERATION_MATCH_MAX_REFERENCES),
  };
}

/** Contexte persisté d'une carte binaire (pur). */
export function buildBinaryMatchContext(input: {
  candidateKey: string; basis: 'CERTAIN' | 'M3'; operationId: number; others: readonly number[];
  operationType: string | null; references: readonly OperationReference[];
}): BinaryMatchContext {
  const refs = sortReferences(input.references);
  return {
    kind: 'operation_match', form: OPERATION_MATCH_BINARY_FORM, version: OPERATION_MATCH_CONTEXT_VERSION,
    candidateKey: input.candidateKey, basis: input.basis,
    operationId: input.operationId, candidateOperationId: input.operationId, operationIds: [input.operationId],
    otherCandidateOperationIds: input.others.filter((x) => x !== input.operationId),
    operationType: input.operationType,
    references: refs.slice(0, OPERATION_MATCH_MAX_REFERENCES),
    referenceCount: refs.length,
    contextFingerprint: binaryMatchFingerprint(input.operationId, input.operationType, refs),
  };
}

/**
 * Réponse reçue sur une carte binaire (pure). `CHANGED` : la réponse vise une
 * autre Opération que celle de la carte actuelle (carte mise à jour entre la
 * lecture et le clic, ancien onglet) — refusée, jamais réinterprétée.
 * Une valeur de l'ancienne forme (`SAME:<id>`) sur l'Opération affichée vaut
 * « Oui » (même sens) ; `DISTINCT` (ancien « Non, c'est un autre … » portant
 * sur PLUSIEURS réalités) n'a pas d'équivalent exact : `CHANGED`.
 */
export function parseBinaryMatchChoice(value: unknown, ctx: BinaryMatchContext):
  | { kind: 'SAME'; operationId: number } | { kind: 'NOT_SAME'; operationId: number } | { kind: 'CHANGED' } | null {
  if (typeof value !== 'string') return null;
  const m = /^(YES|NO|SAME):(\d{1,18})$/.exec(value);
  if (!m) return value === 'DISTINCT' ? { kind: 'CHANGED' } : null;
  const id = Number(m[2]);
  if (id !== ctx.operationId) return { kind: 'CHANGED' };
  return m[1] === 'NO' ? { kind: 'NOT_SAME', operationId: id } : { kind: 'SAME', operationId: id };
}

// ── Lectures (compte de la session, bornées) ────────────────────────────────

type Row = Record<string, unknown>;
const intArray = (xs: Iterable<number>) => `{${[...new Set(xs)].filter((x) => Number.isSafeInteger(x)).join(',')}}`;
const jour = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/** Document consultable du compte $1 — même règle que le contrat de lecture 109A. */
const DOC_VISIBLE = (f: string) => `${f}.account_id = $1 AND ${f}.deleted_at IS NULL AND (${f}.upload_status = 'COMPLETED' OR ${f}.upload_status IS NULL)`;

/**
 * Opérations proposées par T3, dans l'ordre de préférence, ramenées à leur
 * canonique (fusion suivie) et dédoublonnées, avec type et désignation.
 */
export async function canonicalCandidateOperations(accountId: number, ids: readonly number[]): Promise<Array<{ id: number; type: string | null; provider: string | null; date: string | null }>> {
  if (!ids.length) return [];
  const r = (await pgClient.unsafe(
    `WITH RECURSIVE ch(origin, id, m, n) AS (
       SELECT o.id, o.id, o.merged_into_operation_id, 1 FROM business_operations o WHERE o.account_id = $1 AND o.id = ANY($2::bigint[])
       UNION ALL
       SELECT ch.origin, o.id, o.merged_into_operation_id, ch.n + 1 FROM business_operations o JOIN ch ON o.id = ch.m
        WHERE o.account_id = $1 AND ch.n < 10)
     SELECT ch.origin, o.id, o.type_code, o.provider, COALESCE(o.realized_date, o.start_date, o.planned_date)::text AS d
       FROM ch JOIN business_operations o ON o.id = ch.id AND o.account_id = $1
      WHERE ch.m IS NULL`,
    [accountId, intArray(ids)] as never[],
  )) as unknown as Row[];
  const parOrigine = new Map(r.map((x) => [Number(x.origin), x]));
  const out: Array<{ id: number; type: string | null; provider: string | null; date: string | null }> = [];
  for (const id of ids) {
    const x = parOrigine.get(id);
    if (!x || out.some((o) => o.id === Number(x.id))) continue;
    out.push({ id: Number(x.id), type: (x.type_code as string | null) ?? null, provider: (x.provider as string | null) ?? null, date: jour(x.d) });
  }
  return out;
}

/**
 * Références ACTUELLES d'Opérations du compte : documents membres actifs et
 * événements de l'Agenda qui les représentent. Opération absorbée ou
 * invalidée : aucune référence (la carte sera réévaluée par T3).
 */
export async function loadOperationReferences(accountId: number, operationIds: readonly number[]): Promise<Map<number, OperationReference[]>> {
  const out = new Map<number, OperationReference[]>();
  const ids = [...new Set(operationIds)].filter((x) => Number.isSafeInteger(x) && x > 0);
  if (!ids.length) return out;
  const [docs, evts] = await Promise.all([
    pgClient.unsafe(
      `SELECT d.operation_id, f.id, ${documentTitleColumnsSql('f')}, f.document_type_code, f.document_date::text AS document_date
         FROM business_operation_documents d
         JOIN business_operations o ON o.id = d.operation_id AND o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
         JOIN asset_files f ON f.id = d.file_id AND ${DOC_VISIBLE('f')}
        WHERE d.account_id = $1 AND d.active AND d.operation_id = ANY($2::bigint[])
        ORDER BY d.operation_id, f.id
        LIMIT 2000`,
      [accountId, intArray(ids)] as never[],
    ) as unknown as Promise<Array<Row & DocumentTitleColumns>>,
    pgClient.unsafe(
      `SELECT i.business_operation_id AS operation_id, i.id, i.title, i.start_date::text AS start_date
         FROM agenda_items i
         JOIN business_operations o ON o.id = i.business_operation_id AND o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
        WHERE i.account_id = $1 AND i.business_operation_id = ANY($2::bigint[])
        ORDER BY i.business_operation_id, i.id
        LIMIT 2000`,
      [accountId, intArray(ids)] as never[],
    ) as unknown as Promise<Row[]>,
  ]);
  const push = (op: number, r: OperationReference) => out.set(op, [...(out.get(op) ?? []), r]);
  for (const x of docs) {
    push(Number(x.operation_id), {
      kind: 'document', id: Number(x.id), title: documentTitleOf(x, 'Document').slice(0, 200),
      typeLabel: documentTypeLabelOrNull(x.document_type_code as string | null), date: jour(x.document_date),
    });
  }
  for (const x of evts) {
    push(Number(x.operation_id), {
      kind: 'event', id: Number(x.id), title: String(x.title ?? '').trim().slice(0, 200) || 'Événement',
      typeLabel: 'Événement', date: jour(x.start_date),
    });
  }
  for (const [k, v] of out) out.set(k, sortReferences(v));
  return out;
}

/** Références présentées d'une carte : celles de son Opération, hors document de la carte. */
export function referencesForCard(all: ReadonlyMap<number, OperationReference[]>, operationId: number, targetFileId: number): OperationReference[] {
  return (all.get(operationId) ?? []).filter((r) => !(r.kind === 'document' && r.id === targetFileId));
}

/**
 * Revalidation au clic (lien direct d'une référence) : la destination est une
 * référence ACTUELLE de l'Opération de la carte binaire ouverte.
 */
export async function binaryMatchReferenceOffered(
  accountId: number, card: { ruleCode: string; targetType: string; targetId: number; triggerContext: unknown },
  t: { kind: string; id: number },
): Promise<boolean> {
  if (card.ruleCode !== 'OPERATION-MATCH' || card.targetType !== 'DOCUMENT' || !isBinaryMatchContext(card.triggerContext)) return false;
  if (t.kind !== 'document' && t.kind !== 'echeance') return false;
  const refs = referencesForCard(await loadOperationReferences(accountId, [card.triggerContext.operationId]), card.triggerContext.operationId, card.targetId);
  const kind: OperationReferenceKind = t.kind === 'document' ? 'document' : 'event';
  return refs.some((r) => r.kind === kind && r.id === t.id);
}
