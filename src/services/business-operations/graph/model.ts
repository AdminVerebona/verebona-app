/**
 * GRAPHE CANONIQUE des événements de référence — vocabulaire fermé et règles
 * PURES (lot 114O, carte Trello #744, CDC « Opérations / Agenda V2.0 » §4, §5,
 * §7, §9, §19, §20 ; lot B « identité et graphe canonique »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS RELATIONS, TROIS GESTES QUI NE SE CONFONDENT PAS (CDC §2, §7)
 *
 *   ASSOCIATION  lien entre deux réalités DISTINCTES — ce module ;
 *   FUSION       deux identités reconnues comme une seule — dépôt existant
 *                (`BusinessOperationRepository.mergeOperations`), inchangé ;
 *   SCISSION     correction d'un regroupement erroné — lot C, non livré ici.
 *
 * Relations du graphe :
 *   · Opération ↔ Opération   `business_operation_relations` (1715) ;
 *   · Opération ↔ élément d'Agenda, N↔N, SANS « principal »
 *                             `business_operation_agenda_links` (1716) ;
 *   · Opération ↔ document    `business_operation_documents` (lot 82D,
 *                             inchangée : origines SOURCE / USER, refus dans
 *                             `business_operation_match_decisions`).
 *
 * Vocabulaire : celui des contraintes CHECK des migrations 1715 à 1717 (test
 * `l114o-graphe-modele.test.ts`) — le code refuse avant la base, la base
 * refuse ce que le code aurait laissé passer.
 *
 * AUCUN EFFET DÉRIVÉ : une relation du graphe ne crée ni composante
 * financière, ni date, ni événement d'Agenda, ni rappel, ni notification
 * (CDC §9, §17, §18). Les fonctions de ce fichier n'accèdent à rien.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import type { BusinessOperationTypeCode } from '../model';

// ── Vocabulaire ────────────────────────────────────────────────────────────

/**
 * Nature d'une relation entre deux Opérations.
 *   FINANCING     orientée : `from` = le financement, `to` = ce qu'il finance ;
 *   CLAIM_REPAIR  orientée : `from` = le sinistre, `to` = la réparation ;
 *   ASSOCIATED    non orientée : lien établi, nature non prouvée.
 * Le lien Sinistre → contrat d'assurance reste porté par la relation
 * spécialisée existante (`business_operation_claim_details.insurance_contract_operation_id`) :
 * il est LU dans le graphe (`graph/read.ts`), jamais dupliqué ici (CDC §4 :
 * pas deux sources concurrentes de vérité).
 */
export const OPERATION_RELATION_NATURES = ['FINANCING', 'CLAIM_REPAIR', 'ASSOCIATED'] as const;
export type OperationRelationNature = (typeof OPERATION_RELATION_NATURES)[number];

export const OPERATION_RELATION_STATES = ['ACTIVE', 'REMOVED', 'REJECTED'] as const;
export type OperationRelationState = (typeof OPERATION_RELATION_STATES)[number];

export const AGENDA_LINK_STATES = ['ACTIVE', 'REMOVED'] as const;
export type AgendaLinkState = (typeof AGENDA_LINK_STATES)[number];

/** Origine d'une relation (CDC §4 : IA / utilisateur / migration ; SYSTEM = reprise déterministe). */
export const GRAPH_ORIGINS = ['USER', 'AI', 'MIGRATION', 'SYSTEM'] as const;
export type GraphOrigin = (typeof GRAPH_ORIGINS)[number];

/** Objet d'une ligne du journal : relation du graphe, ou l'événement de référence lui-même (OPERATION). */
export const GRAPH_RELATION_KINDS = ['OPERATION_RELATION', 'AGENDA_LINK', 'DOCUMENT_LINK', 'SUPPLIER_LINK', 'OPERATION'] as const;
export type GraphRelationKind = (typeof GRAPH_RELATION_KINDS)[number];

export const GRAPH_HISTORY_ACTIONS = [
  'CREATED', 'REACTIVATED', 'UPDATED', 'REMOVED', 'REJECTED', 'MOVED', 'REASSIGNED_ON_MERGE', 'ACCOUNT_TRANSFER', 'NO_CHANGE', 'INVALIDATED', 'RESTORED',
] as const;
export type GraphHistoryAction = (typeof GRAPH_HISTORY_ACTIONS)[number];

/**
 * Type exigé de l'Opération d'ORIGINE d'une relation orientée — contrôle
 * d'INTÉGRITÉ structurelle (CDC §9 : la relation de financement part d'un
 * FINANCING ; §24 SC-09 : sinistre → réparation), pas une règle sémantique :
 * la décision d'associer reste à l'utilisateur ou à T3. Aucune contrainte sur
 * l'Opération visée (un financement peut concerner plusieurs acquisitions).
 */
export const RELATION_SOURCE_TYPE: Readonly<Record<OperationRelationNature, BusinessOperationTypeCode | null>> = {
  FINANCING: 'FINANCING',
  CLAIM_REPAIR: 'CLAIM',
  ASSOCIATED: null,
};

export function isOperationRelationNature(v: unknown): v is OperationRelationNature {
  return typeof v === 'string' && (OPERATION_RELATION_NATURES as readonly string[]).includes(v);
}

export function isGraphOrigin(v: unknown): v is GraphOrigin {
  return typeof v === 'string' && (GRAPH_ORIGINS as readonly string[]).includes(v);
}

// ── Preuves ────────────────────────────────────────────────────────────────

/**
 * Preuve citée d'une relation (CDC §5) : nature de la preuve et élément
 * précis. Jamais de contenu de document : identifiants et extrait court.
 */
export interface GraphEvidence {
  /** DOCUMENT (asset_files.id), AGENDA (agenda_items.id), USER_DECLARATION (texte de l'utilisateur), TO_PROCESS (carte), STRUCTURED (champ). */
  kind: 'DOCUMENT' | 'AGENDA' | 'USER_DECLARATION' | 'TO_PROCESS' | 'STRUCTURED';
  /** Identifiant stable de la source (texte). */
  ref: string;
  /** Élément précis : page, extrait court, champ. */
  locator?: string;
}

const EVIDENCE_KINDS: ReadonlySet<string> = new Set(['DOCUMENT', 'AGENDA', 'USER_DECLARATION', 'TO_PROCESS', 'STRUCTURED']);
export const GRAPH_EVIDENCE_MAX = 20;
const EVIDENCE_TEXT_MAX = 300;

/** Preuves normalisées : bornées, dédoublonnées, triées (ordre stable). `null` : entrée invalide. */
export function normalizeEvidence(input: unknown): GraphEvidence[] | null {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > GRAPH_EVIDENCE_MAX) return null;
  const vus = new Map<string, GraphEvidence>();
  for (const e of input) {
    if (!e || typeof e !== 'object') return null;
    const { kind, ref, locator } = e as Record<string, unknown>;
    if (typeof kind !== 'string' || !EVIDENCE_KINDS.has(kind)) return null;
    if (typeof ref !== 'string' || !ref.trim() || ref.length > EVIDENCE_TEXT_MAX) return null;
    if (locator !== undefined && (typeof locator !== 'string' || locator.length > EVIDENCE_TEXT_MAX)) return null;
    const propre: GraphEvidence = { kind: kind as GraphEvidence['kind'], ref: ref.trim(), ...(locator && locator.trim() ? { locator: locator.trim() } : {}) };
    vus.set(`${propre.kind}|${propre.ref}|${propre.locator ?? ''}`, propre);
  }
  return [...vus.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}

/** Empreinte stable des preuves (sources seulement : l'extrait cité ne change pas l'identité de la preuve). */
export function evidenceFingerprint(evidence: readonly GraphEvidence[]): string | null {
  if (!evidence.length) return null;
  const cles = [...new Set(evidence.map((e) => `${e.kind}|${e.ref}`))].sort();
  return createHash('sha256').update(cles.join('\n')).digest('hex').slice(0, 32);
}

// ── Paire d'Opérations ─────────────────────────────────────────────────────

export interface RelationEnds { fromOperationId: number; toOperationId: number }

/** Clé de la paire NON ordonnée (une seule relation par paire : index unique 1715). */
export function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Extrémités à stocker. Une relation orientée garde son sens ; une relation
 * non orientée est rangée dans l'ordre des identifiants (lecture stable).
 */
export function orientRelation(nature: OperationRelationNature, fromOperationId: number, toOperationId: number): RelationEnds {
  if (RELATION_SOURCE_TYPE[nature] !== null) return { fromOperationId, toOperationId };
  return fromOperationId < toOperationId ? { fromOperationId, toOperationId } : { fromOperationId: toOperationId, toOperationId: fromOperationId };
}

// ── Décision d'écriture d'une relation entre Opérations (pure) ─────────────

export interface RelationSnapshot {
  id: number;
  fromOperationId: number;
  toOperationId: number;
  nature: OperationRelationNature;
  state: OperationRelationState;
  origin: GraphOrigin;
  version: number;
  evidenceFingerprint: string | null;
}

export interface OperationFacts {
  id: number;
  typeCode: BusinessOperationTypeCode | null;
  /** Ni invalidée, ni fusionnée. */
  active: boolean;
}

export interface AssociateRequest {
  from: OperationFacts;
  to: OperationFacts;
  nature: OperationRelationNature;
  origin: GraphOrigin;
  evidence: readonly GraphEvidence[];
  /** Version attendue de la relation existante (verrou optimiste) ; absente : non contrôlée. */
  expectedVersion?: number;
}

export type AssociateDecision =
  | { outcome: 'CREATE'; ends: RelationEnds }
  | { outcome: 'REACTIVATE'; ends: RelationEnds; relationId: number; liftsRefusal: boolean }
  | { outcome: 'UPDATE_NATURE'; ends: RelationEnds; relationId: number }
  | { outcome: 'NO_CHANGE'; relationId: number }
  | { outcome: 'CONFLICT'; code: 'VERSION_MISMATCH'; currentVersion: number }
  | { outcome: 'ARBITRATION_REQUIRED'; code: 'NEW_EVIDENCE_AFTER_REFUSAL'; relationId: number }
  | { outcome: 'FORBIDDEN'; code: 'REFLEXIVE' | 'OPERATION_INACTIVE' | 'NATURE_TYPE_MISMATCH' | 'USER_REJECTED' | 'EVIDENCE_REQUIRED' | 'USER_RELATION_PROTECTED' };

/**
 * Décide l'écriture d'une ASSOCIATION entre deux Opérations.
 *   · jamais réflexive, jamais sur une Opération invalidée ou fusionnée ;
 *   · une relation orientée part du bon type (intégrité) ;
 *   · une inférence (AI, MIGRATION, SYSTEM) cite au moins une preuve (CDC §5 :
 *     aucun lien sans fondement) ; le geste de l'utilisateur est sa propre preuve ;
 *   · REFUS de l'utilisateur (CDC §4, §5, AC13, AC14) : seul l'utilisateur le
 *     lève. Une inférence sur les MÊMES preuves (ou sans preuve nouvelle) est
 *     refusée sans bruit ; sur des preuves NOUVELLES elle rend « arbitrage
 *     requis » — jamais une réactivation silencieuse ;
 *   · une inférence ne requalifie pas une relation posée par l'utilisateur ;
 *   · version attendue périmée → conflit (aucune écriture).
 */
export function decideAssociate(req: AssociateRequest, existing: RelationSnapshot | null): AssociateDecision {
  if (req.from.id === req.to.id) return { outcome: 'FORBIDDEN', code: 'REFLEXIVE' };
  if (!req.from.active || !req.to.active) return { outcome: 'FORBIDDEN', code: 'OPERATION_INACTIVE' };
  const exige = RELATION_SOURCE_TYPE[req.nature];
  if (exige !== null && req.from.typeCode !== exige) return { outcome: 'FORBIDDEN', code: 'NATURE_TYPE_MISMATCH' };
  const user = req.origin === 'USER';
  if (!user && req.evidence.length === 0) return { outcome: 'FORBIDDEN', code: 'EVIDENCE_REQUIRED' };
  const ends = orientRelation(req.nature, req.from.id, req.to.id);
  if (!existing) return { outcome: 'CREATE', ends };
  if (req.expectedVersion !== undefined && req.expectedVersion !== existing.version) {
    return { outcome: 'CONFLICT', code: 'VERSION_MISMATCH', currentVersion: existing.version };
  }
  if (existing.state === 'REJECTED') {
    if (user) return { outcome: 'REACTIVATE', ends, relationId: existing.id, liftsRefusal: true };
    const fp = evidenceFingerprint(req.evidence);
    if (fp !== null && fp !== existing.evidenceFingerprint) return { outcome: 'ARBITRATION_REQUIRED', code: 'NEW_EVIDENCE_AFTER_REFUSAL', relationId: existing.id };
    return { outcome: 'FORBIDDEN', code: 'USER_REJECTED' };
  }
  if (existing.state === 'REMOVED') return { outcome: 'REACTIVATE', ends, relationId: existing.id, liftsRefusal: false };
  const meme = existing.nature === req.nature && existing.fromOperationId === ends.fromOperationId && existing.toOperationId === ends.toOperationId;
  if (meme) return { outcome: 'NO_CHANGE', relationId: existing.id };
  if (!user && existing.origin === 'USER') return { outcome: 'FORBIDDEN', code: 'USER_RELATION_PROTECTED' };
  return { outcome: 'UPDATE_NATURE', ends, relationId: existing.id };
}

export type DissociateDecision =
  | { outcome: 'REJECT'; relationId: number | null }
  | { outcome: 'REMOVE'; relationId: number }
  | { outcome: 'NO_CHANGE'; relationId: number | null }
  | { outcome: 'CONFLICT'; code: 'VERSION_MISMATCH'; currentVersion: number }
  | { outcome: 'FORBIDDEN'; code: 'REFLEXIVE' | 'USER_RELATION_PROTECTED' };

/**
 * Décide la DISSOCIATION de deux Opérations (le lien seulement : aucune des
 * deux Opérations, aucun document, aucun événement n'est touché — CDC §19).
 *   · utilisateur : REFUS durable (REJECTED), y compris sans relation
 *     existante (« ne pas associer » posé d'avance : la paire ne sera pas
 *     proposée de nouveau sur les mêmes preuves) ;
 *   · inférence : retrait simple (REMOVED), jamais d'une relation posée ou
 *     refusée par l'utilisateur.
 */
export function decideDissociate(
  req: { aId: number; bId: number; origin: GraphOrigin; expectedVersion?: number },
  existing: RelationSnapshot | null,
): DissociateDecision {
  if (req.aId === req.bId) return { outcome: 'FORBIDDEN', code: 'REFLEXIVE' };
  if (existing && req.expectedVersion !== undefined && req.expectedVersion !== existing.version) {
    return { outcome: 'CONFLICT', code: 'VERSION_MISMATCH', currentVersion: existing.version };
  }
  if (req.origin === 'USER') {
    if (existing?.state === 'REJECTED') return { outcome: 'NO_CHANGE', relationId: existing.id };
    return { outcome: 'REJECT', relationId: existing?.id ?? null };
  }
  if (!existing || existing.state !== 'ACTIVE') return { outcome: 'NO_CHANGE', relationId: existing?.id ?? null };
  if (existing.origin === 'USER') return { outcome: 'FORBIDDEN', code: 'USER_RELATION_PROTECTED' };
  return { outcome: 'REMOVE', relationId: existing.id };
}

// ── Fusion : report des relations de l'absorbée (pur) ──────────────────────

const FORCE: Readonly<Record<OperationRelationState, number>> = { REJECTED: 2, ACTIVE: 1, REMOVED: 0 };

/**
 * À la fusion de deux Opérations, une relation de l'absorbée vers X rencontre
 * éventuellement la relation de la canonique vers X. État à garder sur la
 * canonique : le REFUS de l'utilisateur l'emporte (jamais contourné par une
 * fusion, CDC §7), puis la relation active, puis le retrait.
 */
export function mergedRelationState(canonical: OperationRelationState, absorbed: OperationRelationState): OperationRelationState {
  return FORCE[absorbed] > FORCE[canonical] ? absorbed : canonical;
}

// ── Résultat des commandes (CDC §20) ───────────────────────────────────────

/**
 * Statut d'une commande d'écriture (CDC §20 : appliqué / arbitrage / conflit /
 * interdit / échec). `APPLIED` avec `changed: false` : commande déjà
 * satisfaite (idempotence), rien n'a été écrit.
 */
export type OperationWriteStatus = 'APPLIED' | 'ARBITRATION_REQUIRED' | 'CONFLICT' | 'FORBIDDEN' | 'FAILED';

export type OperationWriteCode =
  | 'OK' | 'NO_CHANGE'
  | 'NEW_EVIDENCE_AFTER_REFUSAL'
  | 'VERSION_MISMATCH' | 'IDEMPOTENCY_KEY_REUSED'
  | 'INVALID_INPUT' | 'READ_ONLY_ACCOUNT' | 'NOT_A_MEMBER' | 'NOT_FOUND_IN_ACCOUNT' | 'OPERATION_INACTIVE' | 'REFLEXIVE'
  | 'NATURE_TYPE_MISMATCH' | 'EVIDENCE_REQUIRED' | 'USER_REJECTED' | 'USER_RELATION_PROTECTED' | 'LINKED_ELSEWHERE' | 'NOT_LINKED'
  | 'USER_ONLY' | 'TYPE_DETAILS_PRESENT' | 'STATUS_TRANSITION_REFUSED' | 'NOT_RESTORABLE' | 'DUPLICATE_DECLARATION'
  | 'TECHNICAL_FAILURE';

export interface OperationWriteResult<T = Record<string, never>> {
  status: OperationWriteStatus;
  code: OperationWriteCode;
  /** Une écriture a réellement eu lieu. */
  changed: boolean;
  /** Résultat rendu depuis le journal (même clé d'idempotence déjà appliquée). */
  replayed: boolean;
  data?: T;
}

export const applied = <T>(changed: boolean, data?: T): OperationWriteResult<T> =>
  ({ status: 'APPLIED', code: changed ? 'OK' : 'NO_CHANGE', changed, replayed: false, ...(data !== undefined ? { data } : {}) });

export const refused = <T = never>(status: Exclude<OperationWriteStatus, 'APPLIED'>, code: OperationWriteCode, data?: T): OperationWriteResult<T> =>
  ({ status, code, changed: false, replayed: false, ...(data !== undefined ? { data } : {}) });

/** Clé d'idempotence acceptée : texte court sans espace (fournie par l'appelant, par commande). */
export function isIdempotencyKey(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9._:\-]{8,120}$/.test(v);
}

export const isPositiveId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

// ── Empreinte de l'entrée d'une commande (rejeu par clé d'idempotence) ─────

/** Sérialisation stable (clés triées) : deux entrées égales ont la même empreinte, quel que soit l'ordre des champs. */
function stableJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Empreinte de l'entrée d'une commande : la même clé d'idempotence avec une AUTRE entrée est un conflit, jamais un rejeu. */
export function commandInputHash(command: string, input: unknown): string {
  return createHash('sha256').update(`${command}\n${stableJson(input)}`).digest('hex').slice(0, 32);
}

// ── Déclaration de l'utilisateur (source durable, CDC §5, §6, AC01, AC03) ──

export const DECLARATION_TEXT_MAX = 2000;

/** Texte utile d'une déclaration : espaces normalisés, borné. null : vide ou trop long (jamais tronqué en silence). */
export function normalizeDeclarationText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t.length >= 1 && t.length <= DECLARATION_TEXT_MAX ? t : null;
}

/**
 * Empreinte d'une déclaration (texte normalisé, casse et accents ignorés) : la
 * MÊME déclaration rejouée ne fonde pas un second événement de référence
 * (AC03). Contrôle d'intégrité, pas un rapprochement sémantique : deux
 * formulations différentes du même acte relèvent de T3 (lot C).
 */
export function declarationFingerprint(text: string): string {
  const cle = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return createHash('sha256').update(cle).digest('hex').slice(0, 32);
}

// ── Correction d'un événement de référence par l'utilisateur (pure) ────────

/** Champs qu'une correction de l'utilisateur peut POSER (jamais effacer : l'effacement est une commande distincte, W27). */
export const OPERATION_PATCH_DATE_FIELDS = ['plannedDate', 'startDate', 'realizedDate', 'endDate'] as const;
export type OperationPatchDateField = (typeof OPERATION_PATCH_DATE_FIELDS)[number];

export interface OperationPatch {
  plannedDate?: string;
  startDate?: string;
  realizedDate?: string;
  endDate?: string;
  provider?: string;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Date civile AAAA-MM-JJ RÉELLE (le 30 février est refusé) ; aucune heure, aucun fuseau. */
export function isIsoDay(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = ISO_DAY.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return y >= 1900 && y <= 2200 && date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/**
 * Valide une correction : seuls les champs connus, chacun avec une valeur
 * (une date réelle, un prestataire non vide borné). null : entrée invalide
 * (champ inconnu, valeur nulle ou vide, date impossible). Un objet vide est
 * valide (rien à corriger dans ces champs).
 */
export function normalizeOperationPatch(input: unknown): OperationPatch | null {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: OperationPatch = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === undefined) continue;
    if ((OPERATION_PATCH_DATE_FIELDS as readonly string[]).includes(k)) {
      if (!isIsoDay(v)) return null;
      out[k as OperationPatchDateField] = v;
    } else if (k === 'provider') {
      if (typeof v !== 'string') return null;
      const t = v.replace(/\s+/g, ' ').trim();
      if (!t || t.length > 200) return null;
      out.provider = t;
    } else return null;
  }
  return out;
}
