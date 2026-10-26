/**
 * Questions suggérées de l'accueil, produites par T6 — lot 55A (ticket
 * « T6 / T2 — Cohérence des suggestions IA »), contrat FONDÉ au lot 87C
 * (ticket P1 « T6 — fiabiliser la pertinence, le fondement et la
 * répondabilité des questions suggérées »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'IA DÉCIDE DE LA PERTINENCE, LE CODE ORCHESTRE ET VÉRIFIE LES FONDEMENTS
 *
 * Les questions « Ou demandez-moi » sont rédigées par T6 DANS LE MÊME APPEL
 * que la bulle (`t6_formulate`, règle R12 du prompt maître). Trois décisions
 * restent DISTINCTES (lot 87C, §2.2) :
 *   1. signaler une information (décision EVALUATE validée → `signaled`) ;
 *   2. proposer une question complémentaire (`decision.relevant` de T6) ;
 *   3. juger qu'elle peut recevoir une réponse fiable (`decision.answerable`,
 *      appuyée sur des références VÉRIFIABLES : `groundRefs`).
 * Une échéance signalée ne suffit jamais, seule, à publier une question
 * « préparer » : `signaled = true` n'est plus une autorisation.
 *
 * ── CONTEXTE `t6-suggestions-v3` (borné au compte) ──────────────────────
 *
 * Le contexte transmis ne contient que des faits RÉELLEMENT disponibles,
 * chacun sous une référence opaque, avec sa nature et son statut, issus des
 * sources canoniques déjà lues par la mascotte — jamais une collecte
 * parallèle :
 *   · indicateurs du compte (`account`) et leurs références `ACC.*` ;
 *   · biens nommables `A1…A8` (et `An.DOCS` s'ils ont des documents) ;
 *   · prochaines échéances ÉLIGIBLES `D1…D3` (les écartées ne sont jamais
 *     transmises), avec : la décision T6 validée et fraîche (décision,
 *     catégorie, motif, incertitudes) ou « non évaluée » ; la démarche déjà
 *     identifiée par T6 (`Dn.ACTION`) et si elle est ÉTABLIE par une preuve
 *     concrète encore disponible (`exceptionEvidenceGrounded`, lot 75E) ; la
 *     description (`Dn.DESC`) ; les faits documentaires pertinents
 *     (`Dn.F1…`, statut PROVEN / DEDUCED / UNCERTAIN, choisis comme pour
 *     EVALUATE) ; les intitulés des documents liés (`Dn.DOC1…`).
 * Une décision SHOW_NOW, une démarche ou un titre ne valent pas preuve de
 * répondabilité : ils sont transmis comme tels, avec leur nature.
 *
 * ── CONTRAT DE SORTIE (par question) ─────────────────────────────────────
 *
 *   { question, subject, purpose, assetRef, deadlineRef,
 *     decision: { relevant, answerable, preparationUseful },
 *     groundRefs: [...], informationNature: [...] }
 *
 * Le serveur vérifie, question par question (rejet INDIVIDUEL, motif
 * structuré, jamais de correction ni de conversion PREPARE → CONSULT) :
 *   · la structure historique (longueur, « ? », une ligne, ni emoji ni
 *     tutoiement, doublons) et les trois premières questions SEULEMENT (une
 *     question rejetée n'est jamais remplacée par une suivante) ;
 *   · le contrat : sujet, finalité, décision de T6, fondements, natures ;
 *   · les références : connues du contexte (donc du compte), actuelles
 *     (version des fondements à la relecture du cache et au contrôle de
 *     cohérence), cohérentes avec le sujet (aucun fondement d'une autre
 *     échéance ni d'un autre bien), natures déclarées réellement citées ;
 *   · « préparer » : échéance signalée ET démarche identifiée par T6 citée ET
 *     un fondement CONCRET cité (démarche établie, description, fait prouvé
 *     ou déduit) ET intérêt de la préparation déclaré par T6 ;
 *   · les contrôles des lots 72A / 76A sur le TEXTE (libellé de l'échéance
 *     référencée cité, aucune échéance écartée, aucune autre échéance ni
 *     autre bien, incitation déclarée « CONSULT » sur un sujet non signalé).
 * Aucune règle propre à un bien, un contrat ou une catégorie métier, aucun
 * catalogue de formulations : les contrôles portent sur le contrat, les
 * références et les décisions validées.
 *
 * Zéro question est un résultat NORMAL : jamais de complément, de repli sur
 * un catalogue ni de question rejetée réintroduite.
 *
 * Prompt maître effectif (version BO ou fichier du dépôt) qui ne porte pas
 * ce contrat (`promptSupportsSuggestionGrounds`) : AUCUN contexte transmis,
 * aucune question publiée (AC10) — la bulle reste formulée normalement.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { MascotSecondary } from './types';
import { EMOJI, TUTOIEMENT } from './t6-contract';
import type { MascotAgendaRow } from './signals';
import { daysBetween, normalizeForFingerprint } from './t6-interpellation';
import { canonicalJson, sha256 } from './hash';

/** Lot 87C : contrat des questions fondées (contexte ET sortie). */
export const T6_SUGGESTION_CONTRACT = 't6-suggestions-v3';
/** Version du schéma du contexte transmis (`{{SUGGESTION_CONTEXT}}`). */
const T6_SUGGESTION_CONTEXT_SCHEMA = T6_SUGGESTION_CONTRACT;
/** Horizon de l'agrégat « échéance dans les 30 jours ». */
const PROCHES_JOURS = 30;
/** Questions examinées et affichées au plus (« Ou demandez-moi », 3 pastilles). */
const MAX_T6_SUGGESTIONS = 3;
/** Biens transmis au plus (références A1…A8). */
const MAX_SUGGESTION_ASSETS = 8;
/** Prochaines échéances transmises au plus. */
const MAX_SUGGESTION_DEADLINES = 3;
/** Lot 87C : faits documentaires transmis par échéance, au plus (pas de copie documentaire). */
const MAX_SUGGESTION_FACTS = 5;
/** Lot 87C : intitulés de documents transmis par échéance, au plus. */
const MAX_SUGGESTION_DOCUMENTS = 3;
/** Lot 87C : incertitudes recopiées de la décision T6, au plus. */
const MAX_UNCERTAINTIES = 3;
const T6_SUGGESTION_MIN = 8;
const T6_SUGGESTION_MAX = 100;
/**
 * Intention transmise au clic (contexte de page, indicatif) : la question est
 * libre, T2 la comprend lui-même (routage sémantique, lot 54E).
 */
const T6_SUGGESTION_INTENT = 'HOME_T6_SUGGESTION';

/** Sujet déclaré d'une question (référentiel FERMÉ du contrat). */
const T6_SUGGESTION_SUBJECTS = ['DEADLINE', 'ASSET', 'DEADLINES', 'DOCUMENTS', 'TO_PROCESS', 'OPERATIONS', 'EXPORTS'] as const;
export type T6SuggestionSubject = (typeof T6_SUGGESTION_SUBJECTS)[number];
/** Nature d'une information disponible pour répondre (référentiel FERMÉ). */
const T6_SUGGESTION_NATURES = [
  'ACCOUNT_DATA', 'ASSET_DATA', 'DEADLINE_DATA', 'DOCUMENT_TITLE', 'DESCRIPTION', 'DOCUMENT_FACT', 'UNCERTAIN_FACT', 'IDENTIFIED_ACTION',
] as const;
export type T6SuggestionNature = (typeof T6_SUGGESTION_NATURES)[number];
/** Finalité d'une question (CONSULT : retrouver, consulter ; PREPARE : préparer, agir). */
type T6SuggestionPurpose = 'CONSULT' | 'PREPARE';

/**
 * Motifs STRUCTURÉS d'un rejet (traçabilité BO, aucune donnée personnelle).
 * Contrôles techniques seulement : contrat, références, décisions validées.
 */
export const T6_SUGGESTION_REJECTIONS = [
  'malformed_list', 'not_an_object', 'over_limit', 'format', 'duplicate',
  'contract_unsupported', 'contract_missing_subject', 'contract_missing_purpose', 'contract_missing_decision',
  'contract_missing_grounds', 'contract_missing_nature',
  'declared_not_relevant', 'declared_not_answerable',
  'unknown_asset_ref', 'unknown_deadline_ref', 'subject_ref_mismatch',
  'unknown_ground_ref', 'ground_subject_mismatch', 'subject_not_grounded', 'nature_not_grounded',
  'label_not_cited', 'excluded_deadline_cited', 'other_deadline_cited', 'asset_mismatch', 'other_asset_cited',
  'consult_incites_unsignaled', 'deadline_cited_without_ref',
  'prepare_without_deadline', 'prepare_not_signaled', 'prepare_usefulness_not_established',
  'prepare_without_identified_action', 'prepare_without_concrete_ground',
  // Relecture du cache et contrôle de cohérence (fondements devenus invalides).
  'ground_unavailable', 'ground_changed', 'contract_outdated',
] as const;
type T6SuggestionRejectReason = (typeof T6_SUGGESTION_REJECTIONS)[number];

// ── Contexte transmis ────────────────────────────────────────────────────────

interface T6SuggestionAssetRef {
  ref: string;
  name: string;
  hasDocuments: boolean;
  hasDeadlinesNext30Days: boolean;
  /** Lot 87C : référence des documents du bien (`A1.DOCS`), présente s'il en a. */
  documentsRef?: string | null;
}

/** Lot 87C : fondement transmis (référence, nature) — aucun identifiant de base. */
interface T6SuggestionContextGround { ref: string; nature: T6SuggestionNature }

interface T6SuggestionDeadline {
  /** Référence opaque (`D1`…), recopiée dans `deadlineRef`. */
  ref: string;
  /** Libellé naturel (« Contrôle technique »), jamais le titre technique brut. */
  label: string;
  assetRef: string | null;
  dateLabel: string;
  dateNature: 'confirmée' | 'prévisionnelle';
  /** Retenue dans la bulle (décision de SIGNALER — ne vaut pas autorisation de « préparer »). */
  signaled: boolean;
  /** Nature du fondement de l'échéance elle-même (titre, date). */
  nature: 'DEADLINE_DATA';
  /** Lot 87C : décision T6 validée et fraîche, ou « non évaluée ». */
  evaluation:
    | { status: 'EVALUATED'; decision: string; category: string | null; reasonCode: string | null; uncertainties: string[] }
    | { status: 'NOT_EVALUATED' };
  /** Lot 87C : démarche déjà identifiée par T6 et son statut (établie par une preuve concrète disponible, ou non). */
  identifiedAction: (T6SuggestionContextGround & { text: string; basis: 'ESTABLISHED' | 'NOT_ESTABLISHED' }) | null;
  description: (T6SuggestionContextGround & { text: string }) | null;
  facts: Array<T6SuggestionContextGround & { label: string; value: string | null; status: 'PROVEN' | 'DEDUCED' | 'UNCERTAIN' }>;
  documents: Array<T6SuggestionContextGround & { title: string }>;
}

/** Contexte transmis à T6 ({{SUGGESTION_CONTEXT}}). Présences, jamais de compteurs exacts. */
interface T6SuggestionContext {
  schemaVersion: typeof T6_SUGGESTION_CONTEXT_SCHEMA;
  bubble: {
    /** Message affiché tel quel si T6 ne reformule rien (les sujets sont dans `messages`). */
    speech: string;
    /** Des éléments demandent l'attention aujourd'hui (sujets d'attention, « À faire en premier »). */
    attentionToday: boolean;
  };
  account: {
    hasDocuments: boolean;
    hasDocumentsInAnalysis: boolean;
    hasUnlinkedDocuments: boolean;
    hasPendingToProcess: boolean;
    hasOperations: boolean;
    hasUpcomingDeadlines: boolean;
    hasDeadlinesNext30Days: boolean;
    hasExportsReady: boolean;
  };
  /** Lot 87C : références des indicateurs VRAIS du compte, avec le sujet qu'ils fondent. */
  accountRefs: Array<T6SuggestionContextGround & { subject: T6SuggestionSubject }>;
  assets: T6SuggestionAssetRef[];
  nextDeadlines: T6SuggestionDeadline[];
}

// ── Fondements (serveur seulement) ──────────────────────────────────────────

/** Nature technique d'un fondement (serveur). */
type T6GroundKind = 'ACCOUNT' | 'ASSET' | 'ASSET_DOCUMENTS' | 'DEADLINE' | 'DESCRIPTION' | 'DOCUMENT' | 'DOCUMENT_FACT' | 'IDENTIFIED_ACTION';

/**
 * Fondement vérifiable d'une question (serveur seulement, jamais transmis) :
 * référence du contexte, clé STABLE de la source canonique (`agenda:12`,
 * `fact:34:notice_period`, `t6:agenda:12`…), version (empreinte du contenu
 * transmis), portée (échéance ou bien), sujets qu'il fonde, preuve concrète.
 */
interface T6SuggestionGround {
  ref: string;
  kind: T6GroundKind;
  nature: T6SuggestionNature;
  /** Échéance (`D1`) ou bien (`A1`) auquel le fondement appartient ; null : compte. */
  scope: string | null;
  /** Sujets que ce fondement peut fonder (`DEADLINE:D1`, `ASSET:A1`, `DOCUMENTS`…). */
  subjects: string[];
  key: string;
  version: string;
  /** Source propriétaire (`agenda:12`, `asset:3`) ; null : indicateur du compte. */
  owner: string | null;
  /** Preuve CONCRÈTE (démarche établie, description, fait prouvé ou déduit). */
  concrete: boolean;
}

/** Fondement conservé avec une question (cache) : de quoi vérifier qu'il est actuel. */
export interface T6StoredGround { ref: string; key: string; version: string; nature: T6SuggestionNature; owner?: string | null }

/** Question retenue : libellé et bien désigné (revalidé par T2 au clic). */
export interface T6Suggestion {
  question: string;
  assetId: number | null;
  /** Référence transmise par T6 (serveur seulement : cache, revalidée à la relecture). */
  assetRef?: string | null;
  /** Échéance précise visée (`D1`…), revalidée à la relecture du cache. */
  deadlineRef?: string | null;
  purpose?: T6SuggestionPurpose | null;
  /** Lot 87C : sujet déclaré, fondements cités et natures (serveur : cache, trace). */
  subject?: T6SuggestionSubject;
  groundRefs?: string[];
  informationNature?: T6SuggestionNature[];
  decision?: { relevant: true; answerable: true; preparationUseful: boolean | null };
  grounds?: T6StoredGround[];
}

/** Échéance transmise (serveur seulement) : identifiant et statut dans la bulle. */
interface T6SuggestionDeadlineRef {
  agendaItemId: number; signaled: boolean; label: string;
  /** Bien de l'échéance (`null` : aucun) — cohérence avec `assetRef`. */
  assetId?: number | null;
}

/** Échéance transmise ou écartée, telle que le serveur la contrôle (jamais transmise à T6). */
interface T6SuggestionDeadlineCheck { label: string; assetId: number | null; signaled: boolean }

/** Contexte complet : la correspondance référence → source reste côté serveur. */
export interface T6SuggestionBundle {
  context: T6SuggestionContext;
  /** A1 → identifiant du bien (jamais transmis à T6). */
  assetIds: ReadonlyMap<string, number>;
  /** D1 → échéance éligible (jamais transmise à T6). */
  deadlineRefs?: ReadonlyMap<string, T6SuggestionDeadlineRef>;
  /** Libellés normalisés des échéances ÉCARTÉES (serveur seulement). */
  excludedLabels?: readonly string[];
  /** Échéances TRANSMISES, avec leur bien et leur statut dans la bulle. */
  deadlines?: readonly T6SuggestionDeadlineCheck[];
  /** Échéances ÉCARTÉES avec leur bien (libellé naturel et titre). */
  excludedDeadlines?: readonly T6SuggestionDeadlineCheck[];
  /** A1 → nom du bien (serveur seulement), pour le bien cité dans le texte. */
  assetNames?: ReadonlyMap<string, string>;
  /** Lot 87C : référence → fondement vérifiable (serveur seulement). Absent : aucune question vérifiable. */
  grounds?: ReadonlyMap<string, T6SuggestionGround>;
  /** Lot 87C : empreinte de TOUS les fondements transmis (clé de cache). */
  groundsDigest?: string;
  /** Lot 87C : contrat appliqué. */
  contract?: typeof T6_SUGGESTION_CONTRACT;
}

/** Portée de validation des questions (sous-ensemble du `T6SuggestionBundle`). */
type T6SuggestionScope = Pick<T6SuggestionBundle,
  'deadlineRefs' | 'excludedLabels' | 'deadlines' | 'excludedDeadlines' | 'assetNames' | 'grounds' | 'contract'>;

/**
 * Lot 87C — données canoniques d'une échéance utiles aux fondements, déjà
 * lues par la décision T6 du passage (`T6Preparation` : preuves de
 * `loadT6Evidence`, décision conservée) — construites par
 * `t6-suggestion-grounds.ts`, jamais relues ici.
 */
export interface T6DeadlineGroundsInput {
  description?: string | null;
  /** Faits pertinents dans l'ordre d'EVALUATE (`evaluationEvidenceOf`). */
  facts?: ReadonlyArray<{ fileId: number; factKey: string; label: string; value: string | null; status: 'PROVEN' | 'DEDUCED' | 'UNCERTAIN' }>;
  documents?: ReadonlyArray<{ fileId: number; title: string }>;
  /** Décision T6 validée ET fraîche (null : non évaluée ou caduque). */
  decision?: {
    decision: string; category: string | null; reasonCode: string | null; uncertainties: readonly string[];
    /** Démarche attendue retenue par le serveur (null : aucune — rappel informatif, report, suppression). */
    action: string | null;
    /** La démarche repose sur une preuve CONCRÈTE encore disponible (`exceptionEvidenceGrounded`). */
    actionEstablished: boolean;
  } | null;
}

export interface SuggestionSourceData {
  speech: string;
  attentionToday: boolean;
  state: {
    documentsTotal?: number; documentsInAnalysis?: number; documentsUnlinked?: number; toProcessPending?: number;
    deadlinesUpcoming?: number; deadlinesSoon?: number; exportsReady?: number;
  } | null;
  operations: number;
  assets: Array<{ id: number; name: string; documents: number; deadlines?: number }>;
  /** Échéances FUTURES ÉLIGIBLES, dans l'ordre (déjà lues par le collecteur de la mascotte). */
  agenda: MascotAgendaRow[];
  /** Libellé naturel d'une échéance (injecté : `deadlineButtonLabel`). */
  labelOf: (row: MascotAgendaRow) => string;
  formatDate: (day: string) => string;
  /** Jour courant : agrégats « dans les 30 jours » sur les échéances ÉLIGIBLES seulement. */
  today?: string;
  /** Échéances écartées (décision T6, report ou refus) — jamais transmises ni citées. */
  excluded?: readonly MascotAgendaRow[];
  /** Échéances retenues dans la bulle (`T6Preparation.shown`). */
  signaledIds?: ReadonlySet<number>;
  /** Lot 87C : fondements canoniques par échéance (`agendaItemId`). */
  grounds?: ReadonlyMap<number, T6DeadlineGroundsInput>;
}

const pos = (n: number | undefined | null) => typeof n === 'number' && n > 0;
const texte = (v: string | null | undefined, max: number) => (v ? v.replace(/\s+/g, ' ').trim().slice(0, max) || null : null);
const empreinte = (v: unknown) => sha256(canonicalJson(v)).slice(0, 16);

/**
 * Lot 87C — clés et versions des fondements (pures, PARTAGÉES par la
 * génération, la relecture du cache et le contrôle de cohérence) : une seule
 * définition de « fondement inchangé ». La version ne porte que le contenu
 * transmis (une réextraction à l'identique ne change rien) ; la clé est
 * l'identité STABLE de la source (fait : document et clé du fait).
 */
const T6_GROUNDS = {
  deadline: (row: Pick<MascotAgendaRow, 'id' | 'title' | 'date' | 'forecast' | 'requiresQualification' | 'assetId'>) => ({
    key: `agenda:${row.id}`,
    version: empreinte({ t: row.title, d: row.date, f: !!row.forecast, q: !!row.requiresQualification, a: row.assetId ?? null }),
  }),
  description: (agendaItemId: number, text: string) => ({ key: `agenda:${agendaItemId}:description`, version: empreinte(text) }),
  fact: (f: { fileId: number; factKey: string; label: string; value: string | null; status: string }) => ({
    key: `fact:${f.fileId}:${f.factKey}`, version: empreinte({ l: f.label, v: f.value, s: f.status }),
  }),
  document: (d: { fileId: number; title: string }) => ({ key: `file:${d.fileId}`, version: empreinte(d.title) }),
  action: (agendaItemId: number, d: NonNullable<T6DeadlineGroundsInput['decision']>) => ({
    key: `t6:agenda:${agendaItemId}`,
    version: empreinte({ d: d.decision, c: d.category, r: d.reasonCode, a: d.action, e: d.actionEstablished }),
  }),
  asset: (a: { id: number; name: string; documents: number }) => ({ key: `asset:${a.id}`, version: empreinte({ n: a.name, d: a.documents > 0 }) }),
  assetDocuments: (assetId: number) => ({ key: `asset:${assetId}:documents`, version: 'present' }),
  account: (flag: string) => ({ key: `account:${flag}`, version: 'present' }),
} as const;

/** Indicateurs du compte → référence, sujet fondé, clé (référentiel du contrat). */
const ACCOUNT_REFS: ReadonlyArray<{ flag: keyof T6SuggestionContext['account']; ref: string; subject: T6SuggestionSubject }> = [
  { flag: 'hasDocuments', ref: 'ACC.DOCUMENTS', subject: 'DOCUMENTS' },
  { flag: 'hasDocumentsInAnalysis', ref: 'ACC.DOCUMENTS_IN_ANALYSIS', subject: 'DOCUMENTS' },
  { flag: 'hasUnlinkedDocuments', ref: 'ACC.UNLINKED_DOCUMENTS', subject: 'DOCUMENTS' },
  { flag: 'hasPendingToProcess', ref: 'ACC.TO_PROCESS', subject: 'TO_PROCESS' },
  { flag: 'hasOperations', ref: 'ACC.OPERATIONS', subject: 'OPERATIONS' },
  { flag: 'hasUpcomingDeadlines', ref: 'ACC.DEADLINES', subject: 'DEADLINES' },
  { flag: 'hasDeadlinesNext30Days', ref: 'ACC.DEADLINES_30_DAYS', subject: 'DEADLINES' },
  { flag: 'hasExportsReady', ref: 'ACC.EXPORTS', subject: 'EXPORTS' },
];

/** Contexte des questions suggérées et fondements (pur, testé). */
export function buildT6SuggestionContext(d: SuggestionSourceData): T6SuggestionBundle {
  const grounds = new Map<string, T6SuggestionGround>();
  const ajouter = (g: T6SuggestionGround) => { grounds.set(g.ref, g); return g; };
  const assetIds = new Map<string, number>();
  const refOf = new Map<number, string>();
  const assets: T6SuggestionAssetRef[] = d.assets.slice(0, MAX_SUGGESTION_ASSETS).map((a, i) => {
    const ref = `A${i + 1}`;
    assetIds.set(ref, a.id);
    refOf.set(a.id, ref);
    const owner = `asset:${a.id}`;
    ajouter({ ref, kind: 'ASSET', nature: 'ASSET_DATA', scope: ref, subjects: [`ASSET:${ref}`], ...T6_GROUNDS.asset(a), owner, concrete: false });
    let documentsRef: string | null = null;
    if (a.documents > 0) {
      documentsRef = `${ref}.DOCS`;
      ajouter({ ref: documentsRef, kind: 'ASSET_DOCUMENTS', nature: 'DOCUMENT_TITLE', scope: ref, subjects: [`ASSET:${ref}`, 'DOCUMENTS'], ...T6_GROUNDS.assetDocuments(a.id), owner, concrete: false });
    }
    return { ref, name: a.name, hasDocuments: a.documents > 0, hasDeadlinesNext30Days: pos(a.deadlines), documentsRef };
  });
  const deadlineRefs = new Map<string, T6SuggestionDeadlineRef>();
  const deadlines: T6SuggestionDeadlineCheck[] = [];
  const nextDeadlines: T6SuggestionDeadline[] = d.agenda.filter((r) => r.date).slice(0, MAX_SUGGESTION_DEADLINES).map((r, i) => {
    const ref = `D${i + 1}`;
    const label = d.labelOf(r);
    const signaled = d.signaledIds?.has(r.id) ?? false;
    const assetRef = r.assetId != null ? refOf.get(r.assetId) ?? null : null;
    deadlines.push({ label, assetId: r.assetId ?? null, signaled });
    deadlineRefs.set(ref, { agendaItemId: r.id, signaled, label, assetId: r.assetId ?? null });
    const sujets = [`DEADLINE:${ref}`];
    const owner = `agenda:${r.id}`;
    ajouter({ ref, kind: 'DEADLINE', nature: 'DEADLINE_DATA', scope: ref, subjects: [...sujets, 'DEADLINES'], ...T6_GROUNDS.deadline(r), owner, concrete: false });
    const g = d.grounds?.get(r.id);
    const dec = g?.decision ?? null;
    let identifiedAction: T6SuggestionDeadline['identifiedAction'] = null;
    const action = texte(dec?.action, 160);
    if (dec && action) {
      const a = ajouter({
        ref: `${ref}.ACTION`, kind: 'IDENTIFIED_ACTION', nature: 'IDENTIFIED_ACTION', scope: ref, subjects: sujets,
        ...T6_GROUNDS.action(r.id, { ...dec, action }), owner, concrete: dec.actionEstablished,
      });
      identifiedAction = { ref: a.ref, nature: a.nature, text: action, basis: dec.actionEstablished ? 'ESTABLISHED' : 'NOT_ESTABLISHED' };
    }
    let description: T6SuggestionDeadline['description'] = null;
    const desc = texte(g?.description, 300);
    if (desc) {
      const x = ajouter({ ref: `${ref}.DESC`, kind: 'DESCRIPTION', nature: 'DESCRIPTION', scope: ref, subjects: sujets, ...T6_GROUNDS.description(r.id, desc), owner, concrete: true });
      description = { ref: x.ref, nature: x.nature, text: desc };
    }
    const facts = (g?.facts ?? []).slice(0, MAX_SUGGESTION_FACTS).map((f, n) => {
      const nature: T6SuggestionNature = f.status === 'UNCERTAIN' ? 'UNCERTAIN_FACT' : 'DOCUMENT_FACT';
      const value = texte(f.value, 160);
      const label2 = texte(f.label, 120) ?? f.factKey.slice(0, 80);
      const x = ajouter({
        ref: `${ref}.F${n + 1}`, kind: 'DOCUMENT_FACT', nature, scope: ref, subjects: sujets,
        ...T6_GROUNDS.fact({ fileId: f.fileId, factKey: f.factKey, label: label2, value, status: f.status }), owner, concrete: f.status !== 'UNCERTAIN',
      });
      return { ref: x.ref, nature, label: label2, value, status: f.status };
    });
    const documents = (g?.documents ?? []).slice(0, MAX_SUGGESTION_DOCUMENTS).map((doc, n) => {
      const title = texte(doc.title, 120) ?? 'Document';
      const x = ajouter({ ref: `${ref}.DOC${n + 1}`, kind: 'DOCUMENT', nature: 'DOCUMENT_TITLE', scope: ref, subjects: [...sujets, 'DOCUMENTS'], ...T6_GROUNDS.document({ fileId: doc.fileId, title }), owner, concrete: false });
      return { ref: x.ref, nature: x.nature, title };
    });
    return {
      ref, label, assetRef, dateLabel: d.formatDate(r.date!), dateNature: r.forecast ? 'prévisionnelle' as const : 'confirmée' as const, signaled,
      nature: 'DEADLINE_DATA' as const,
      evaluation: dec
        ? { status: 'EVALUATED' as const, decision: dec.decision, category: dec.category, reasonCode: dec.reasonCode, uncertainties: dec.uncertainties.map((u) => texte(u, 200)).filter((u): u is string => !!u).slice(0, MAX_UNCERTAINTIES) }
        : { status: 'NOT_EVALUATED' as const },
      identifiedAction, description, facts, documents,
    };
  });
  const s = d.state;
  // Agrégats « dans les 30 jours » fondés sur les SEULES échéances éligibles (lot 72A).
  const proche = (r: MascotAgendaRow) => !!d.today && !!r.date && r.date > d.today && daysBetween(d.today, r.date) <= PROCHES_JOURS;
  const prochesEligibles = d.today ? d.agenda.filter(proche) : null;
  const excludedLabels = [...new Set((d.excluded ?? []).flatMap((r) => [d.labelOf(r), r.title]).map(normalizeForFingerprint).filter((x) => x.length >= 4))];
  const excludedDeadlines = (d.excluded ?? []).flatMap((r) => [...new Set([d.labelOf(r), r.title])]
    .map((label) => ({ label, assetId: r.assetId ?? null, signaled: false })));
  const account: T6SuggestionContext['account'] = {
    hasDocuments: pos(s?.documentsTotal),
    hasDocumentsInAnalysis: pos(s?.documentsInAnalysis),
    hasUnlinkedDocuments: pos(s?.documentsUnlinked),
    hasPendingToProcess: pos(s?.toProcessPending),
    hasOperations: d.operations > 0,
    // Consultation libre : l'existence d'échéances à venir reste connue.
    hasUpcomingDeadlines: pos(s?.deadlinesUpcoming) || nextDeadlines.length > 0,
    hasDeadlinesNext30Days: prochesEligibles ? prochesEligibles.length > 0 : pos(s?.deadlinesSoon),
    hasExportsReady: pos(s?.exportsReady),
  };
  const accountRefs = ACCOUNT_REFS.filter((x) => account[x.flag]).map((x) => {
    ajouter({ ref: x.ref, kind: 'ACCOUNT', nature: 'ACCOUNT_DATA', scope: null, subjects: [x.subject], ...T6_GROUNDS.account(x.flag), owner: null, concrete: false });
    return { ref: x.ref, nature: 'ACCOUNT_DATA' as const, subject: x.subject };
  });
  const groundsDigest = empreinte([...grounds.values()].map((g) => [g.ref, g.key, g.version]).sort((a, b) => a[0].localeCompare(b[0])));
  return {
    assetIds,
    deadlineRefs,
    excludedLabels,
    deadlines,
    excludedDeadlines,
    assetNames: new Map(assets.map((a) => [a.ref, a.name])),
    grounds,
    groundsDigest,
    contract: T6_SUGGESTION_CONTRACT,
    context: {
      schemaVersion: T6_SUGGESTION_CONTEXT_SCHEMA,
      bubble: { speech: d.speech, attentionToday: d.attentionToday },
      account,
      accountRefs,
      assets: prochesEligibles
        ? assets.map((a) => ({ ...a, hasDeadlinesNext30Days: prochesEligibles.some((r) => r.assetId === assetIds.get(a.ref)) }))
        : assets,
      nextDeadlines,
    },
  };
}

/** Le libellé (normalisé) figure-t-il, en mots entiers, dans la question (normalisée) ? */
const cite = (question: string, label: string) => ` ${question} `.includes(` ${label} `);
/** Question (normalisée) privée des occurrences du libellé — mots entiers. */
const sans = (question: string, label: string) => ` ${question} `.split(` ${label} `).join('  ').replace(/\s+/g, ' ').trim();

/**
 * Lot 76A (AC08) — marqueurs LINGUISTIQUES de la finalité « PREPARE » telle
 * que le contrat R12 la définit (« préparer, agir »), y compris l'obligation
 * (« dois-je », « faut-il »). Ce n'est ni un catalogue de questions ni une
 * classification métier : aucun type d'échéance, aucun bien, aucune
 * formulation complète. Appliqués seulement là où une incitation contredirait
 * une décision T6 : échéance transmise NON signalée dans la bulle, déclarée
 * « CONSULT ».
 */
const INCITATION_RACINES = ['prepar', 'anticip', 'prevoir', 'prevoy', 'organis', 'planifi'];
const INCITATION_MOTS = new Set(['agir', 'dois', 'doit', 'devons', 'devez', 'devrai', 'devrais', 'devrait', 'devrions', 'devriez', 'faut', 'faudra', 'faudrait', 'falloir']);
const incite = (q: string) => q.split(' ').some((w) => INCITATION_MOTS.has(w) || INCITATION_RACINES.some((r) => w.startsWith(r)));

/** Tutoiement en inversion interrogative (« dois-tu », « peux-tu »), propre aux questions. */
const INVERSION_TU = /-(tu|toi)(?=[\s?,.!]|$)/i;

const forme = (t: string) => t.normalize('NFC').toLocaleLowerCase('fr').replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();

interface T6SuggestionRejection {
  /** Rang de la question dans la sortie (0…) ; -1 : liste entière. */
  index: number;
  reason: T6SuggestionRejectReason;
  /** Sujet, finalité et références déclarés (jamais le texte de la question). */
  subject: string | null;
  purpose: string | null;
  groundRefs: string[];
}

export interface T6SuggestionValidation {
  /** Questions produites par T6 (éléments de la liste). */
  produced: number;
  accepted: T6Suggestion[];
  rejected: T6SuggestionRejection[];
}

type Brut = {
  question?: unknown; assetRef?: unknown; deadlineRef?: unknown; purpose?: unknown; subject?: unknown;
  decision?: unknown; groundRefs?: unknown; informationNature?: unknown; grounds?: unknown;
};

/**
 * Lot 87C — fondements conservés encore ACTUELS (pure, PARTAGÉE par la
 * relecture du cache et le contrôle de cohérence) : chaque clé doit exister
 * dans l'état courant avec la même version. Rend le motif, ou null.
 */
export function storedGroundsViolation(
  stored: readonly T6StoredGround[] | null | undefined, current: ReadonlyMap<string, string>,
): 'ground_unavailable' | 'ground_changed' | null {
  if (!stored || stored.length === 0) return 'ground_unavailable';
  for (const g of stored) {
    const v = current.get(g.key);
    if (v === undefined) return 'ground_unavailable';
    if (v !== g.version) return 'ground_changed';
  }
  return null;
}

/** Fondements conservés d'un élément du cache (lecture tolérante : invalide → null). */
export function storedGroundsOf(raw: unknown): T6StoredGround[] | null {
  if (!Array.isArray(raw)) return null;
  const out: T6StoredGround[] = [];
  for (const g of raw) {
    const o = g as Partial<T6StoredGround> | null;
    if (!o || typeof o.ref !== 'string' || typeof o.key !== 'string' || typeof o.version !== 'string' || typeof o.nature !== 'string') return null;
    out.push({ ref: o.ref, key: o.key, version: o.version, nature: o.nature as T6SuggestionNature, owner: typeof o.owner === 'string' ? o.owner : null });
  }
  return out;
}

/**
 * Validation des questions de T6 contre le contrat `t6-suggestions-v3` (pure,
 * testée) — rejet INDIVIDUEL avec motif structuré, jamais de correction.
 *
 * `opts.stored` (relecture du cache) : chaque question porte ses fondements
 * conservés, comparés aux fondements COURANTS du contexte
 * (`storedGroundsViolation`) — un fondement disparu ou modifié l'invalide.
 */
export function validateT6SuggestionsDetailed(raw: unknown, assetIds: ReadonlyMap<string, number>, scope: T6SuggestionScope = {}, opts: { stored?: boolean } = {}): T6SuggestionValidation {
  if (raw == null) return { produced: 0, accepted: [], rejected: [] };
  if (!Array.isArray(raw)) return { produced: 0, accepted: [], rejected: [{ index: -1, reason: 'malformed_list', subject: null, purpose: null, groundRefs: [] }] };
  const accepted: T6Suggestion[] = [];
  const rejected: T6SuggestionRejection[] = [];
  const vues = new Set<string>();
  const refs = scope.deadlineRefs ?? new Map<string, T6SuggestionDeadlineRef>();
  const grounds = scope.grounds ?? null;
  const groundsByKey = new Map([...(grounds?.values() ?? [])].map((g) => [g.key, g.version]));
  const ecartees = scope.excludedLabels ?? [];
  const transmises = [...refs.values()].map((r) => normalizeForFingerprint(r.label)).filter((x) => x.length >= 4);
  // Échéances transmises et écartées, avec leur bien ; biens nommables (nom
  // normalisé) — données DU compte, jamais un catalogue.
  const echeances = (scope.deadlines ?? []).map((x) => ({ ...x, norm: normalizeForFingerprint(x.label) })).filter((x) => x.norm.length >= 4);
  const exclues = [
    ...(scope.excludedDeadlines ?? []).map((x) => ({ norm: normalizeForFingerprint(x.label), assetId: x.assetId })),
    ...ecartees.map((norm) => ({ norm, assetId: undefined as number | null | undefined })),
  ].filter((x) => x.norm.length >= 4);
  const biens = [...(scope.assetNames ?? new Map<string, string>())]
    .map(([ref, name]) => ({ id: assetIds.get(ref), norm: normalizeForFingerprint(name) }))
    .filter((x): x is { id: number; norm: string } => x.id != null && x.norm.length >= 3);

  raw.forEach((item, index) => {
    const o = (item && typeof item === 'object' ? item : null) as Brut | null;
    const subjectDecl = typeof o?.subject === 'string' ? o.subject : null;
    const purposeDecl = typeof o?.purpose === 'string' ? o.purpose : null;
    const groundRefsDecl = Array.isArray(o?.groundRefs) ? (o!.groundRefs as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 20) : [];
    const rejeter = (reason: T6SuggestionRejectReason) => { rejected.push({ index, reason, subject: subjectDecl, purpose: purposeDecl, groundRefs: groundRefsDecl }); };
    // AC05 : jamais de remplacement — seules les trois premières questions sont examinées.
    if (index >= MAX_T6_SUGGESTIONS) return rejeter('over_limit');
    if (!o) return rejeter('not_an_object');
    if (typeof o.question !== 'string' || /[\r\n]/.test(o.question)) return rejeter('format');
    const question = o.question.replace(/\s+/g, ' ').trim();
    if (question.length < T6_SUGGESTION_MIN || question.length > T6_SUGGESTION_MAX) return rejeter('format');
    if (!question.endsWith('?') || EMOJI.test(question) || TUTOIEMENT.test(question) || INVERSION_TU.test(question)) return rejeter('format');
    // AC10 : sans fondements vérifiables (contexte sans contrat v3), rien n'est publiable.
    if (!grounds || scope.contract !== T6_SUGGESTION_CONTRACT) return rejeter('contract_unsupported');
    // ── Contrat ──────────────────────────────────────────────────────────
    if (!subjectDecl || !(T6_SUGGESTION_SUBJECTS as readonly string[]).includes(subjectDecl)) return rejeter('contract_missing_subject');
    const subject = subjectDecl as T6SuggestionSubject;
    if (purposeDecl !== 'CONSULT' && purposeDecl !== 'PREPARE') return rejeter('contract_missing_purpose');
    const purpose = purposeDecl as T6SuggestionPurpose;
    const dec = o.decision as { relevant?: unknown; answerable?: unknown; preparationUseful?: unknown } | null | undefined;
    if (!dec || typeof dec !== 'object' || typeof dec.relevant !== 'boolean' || typeof dec.answerable !== 'boolean') return rejeter('contract_missing_decision');
    if (!Array.isArray(o.groundRefs) || groundRefsDecl.length === 0) return rejeter('contract_missing_grounds');
    const natures = Array.isArray(o.informationNature) ? (o.informationNature as unknown[]) : null;
    if (!natures || natures.length === 0 || natures.some((n) => typeof n !== 'string' || !(T6_SUGGESTION_NATURES as readonly string[]).includes(n))) return rejeter('contract_missing_nature');
    // Décision de T6 : une question jugée non pertinente ou non répondable n'est jamais publiée.
    if (dec.relevant !== true) return rejeter('declared_not_relevant');
    if (dec.answerable !== true) return rejeter('declared_not_answerable');
    // ── Références du sujet ──────────────────────────────────────────────
    let assetId: number | null = null;
    let assetRef: string | null = null;
    if (o.assetRef != null) {
      if (typeof o.assetRef !== 'string' || !assetIds.has(o.assetRef)) return rejeter('unknown_asset_ref');
      assetRef = o.assetRef;
      assetId = assetIds.get(o.assetRef)!;
    }
    let deadlineRef: string | null = null;
    let ref: T6SuggestionDeadlineRef | undefined;
    if (o.deadlineRef != null) {
      ref = typeof o.deadlineRef === 'string' ? refs.get(o.deadlineRef) : undefined;
      if (!ref) return rejeter('unknown_deadline_ref'); // référence inconnue ou échéance devenue inéligible
      deadlineRef = o.deadlineRef as string;
    }
    if ((subject === 'DEADLINE') !== (deadlineRef != null)) return rejeter('subject_ref_mismatch');
    if (subject === 'ASSET' && assetRef == null) return rejeter('subject_ref_mismatch');
    if (subject !== 'ASSET' && subject !== 'DEADLINE' && assetRef != null) return rejeter('subject_ref_mismatch');
    // ── Fondements : connus, du sujet, natures réellement citées ─────────
    const cites: T6SuggestionGround[] = [];
    for (const r of new Set(groundRefsDecl)) {
      const g = grounds.get(r);
      if (!g) return rejeter('unknown_ground_ref');
      cites.push(g);
    }
    const jeton = subject === 'DEADLINE' ? `DEADLINE:${deadlineRef}` : subject === 'ASSET' ? `ASSET:${assetRef}` : subject;
    // Portées admises : l'échéance et son bien (DEADLINE) ; le bien et ses échéances (ASSET) ; tout le compte sinon.
    const bienEcheance = ref?.assetId != null ? [...assetIds].find(([, id]) => id === ref!.assetId)?.[0] ?? null : null;
    const echeancesDuBien = assetRef ? [...refs].filter(([, x]) => x.assetId === assetId).map(([k]) => k) : [];
    const porteeAdmise = (g: T6SuggestionGround) => g.scope == null
      || (subject === 'DEADLINE' ? g.scope === deadlineRef || g.scope === bienEcheance
        : subject === 'ASSET' ? g.scope === assetRef || echeancesDuBien.includes(g.scope) : true);
    if (subject === 'DEADLINE' || subject === 'ASSET') {
      if (cites.some((g) => !porteeAdmise(g) || (g.scope == null && !g.subjects.includes(jeton)))) return rejeter('ground_subject_mismatch');
    }
    if (!cites.some((g) => g.subjects.includes(jeton))) return rejeter('subject_not_grounded');
    const naturesCitees = new Set(cites.map((g) => g.nature));
    if ((natures as string[]).some((n) => !naturesCitees.has(n as T6SuggestionNature))) return rejeter('nature_not_grounded');
    // ── Texte (lots 72A / 76A) ───────────────────────────────────────────
    const q = normalizeForFingerprint(question);
    if (ref) {
      // Une référence valide ne garantit pas le rattachement du TEXTE : il
      // cite le libellé de l'échéance référencée ; hors de ce libellé, ni
      // échéance écartée, ni autre échéance transmise, ni autre bien.
      const libelle = normalizeForFingerprint(ref.label);
      if (libelle.length < 2 || !cite(q, libelle)) return rejeter('label_not_cited');
      const reste = sans(q, libelle);
      if (exclues.some((x) => cite(reste, x.norm))) return rejeter('excluded_deadline_cited');
      if (echeances.some((x) => x.norm !== libelle && cite(reste, x.norm))) return rejeter('other_deadline_cited');
      const idBien = ref.assetId ?? null;
      if (ref.assetId !== undefined && assetRef != null && assetId !== idBien) return rejeter('asset_mismatch');
      if (ref.assetId !== undefined && biens.some((b) => b.id !== idBien && cite(reste, b.norm))) return rejeter('other_asset_cited');
      // Finalité déclarée CONSULT, texte qui incite à agir sur une échéance non signalée.
      if (purpose === 'CONSULT' && !ref.signaled && incite(q)) return rejeter('consult_incites_unsignaled');
    } else {
      if (ecartees.some((l) => cite(q, l)) || exclues.some((x) => cite(q, x.norm))) return rejeter('excluded_deadline_cited');
      if (transmises.some((l) => cite(q, l))) return rejeter('deadline_cited_without_ref');
    }
    // ── Préparation (§4.3) : jamais autorisée par `signaled` seul ────────
    if (purpose === 'PREPARE') {
      if (!ref) return rejeter('prepare_without_deadline');
      if (!ref.signaled) return rejeter('prepare_not_signaled');
      if (dec.preparationUseful !== true) return rejeter('prepare_usefulness_not_established');
      if (!cites.some((g) => g.kind === 'IDENTIFIED_ACTION' && g.scope === deadlineRef)) return rejeter('prepare_without_identified_action');
      if (!cites.some((g) => g.concrete && g.scope === deadlineRef)) return rejeter('prepare_without_concrete_ground');
    }
    // ── Relecture : fondements conservés encore actuels ──────────────────
    if (opts.stored) {
      const conserves = storedGroundsOf(o.grounds);
      if (!conserves) return rejeter('contract_outdated');
      // Les références citées doivent être exactement celles conservées.
      if (conserves.map((g) => g.ref).sort().join('|') !== cites.map((g) => g.ref).sort().join('|')) return rejeter('ground_changed');
      const v = storedGroundsViolation(conserves, groundsByKey);
      if (v) return rejeter(v);
      if (conserves.some((g) => grounds.get(g.ref)?.key !== g.key)) return rejeter('ground_changed');
    }
    const k = forme(question);
    if (vues.has(k)) return rejeter('duplicate');
    vues.add(k);
    accepted.push({
      question, assetId, assetRef, deadlineRef, purpose, subject,
      groundRefs: cites.map((g) => g.ref),
      informationNature: [...new Set(natures as T6SuggestionNature[])],
      decision: { relevant: true, answerable: true, preparationUseful: typeof dec.preparationUseful === 'boolean' ? dec.preparationUseful : null },
      grounds: cites.map((g) => ({ ref: g.ref, key: g.key, version: g.version, nature: g.nature, owner: g.owner })),
    });
  });
  return { produced: raw.length, accepted, rejected };
}

/** Questions acceptées seulement (voir `validateT6SuggestionsDetailed`). */
export function validateT6Suggestions(raw: unknown, assetIds: ReadonlyMap<string, number>, scope: T6SuggestionScope = {}): T6Suggestion[] {
  return validateT6SuggestionsDetailed(raw, assetIds, scope).accepted;
}

/**
 * Lot 87C — trace des questions d'une génération (pure) : contrat, nombres,
 * motifs structurés, fondements acceptés — références et clés seulement,
 * jamais le texte d'une question ni d'un document.
 */
export interface T6SuggestionReport {
  contract: string | null;
  /** Le prompt effectif porte le contrat (false : aucune question publiable). */
  promptSupported: boolean;
  produced: number;
  accepted: number;
  rejected: number;
  reasons: Record<string, number>;
  rejections: Array<{ index: number; reason: string; subject: string | null; purpose: string | null; groundRefs: string[] }>;
  acceptedGrounds: Array<{ subject: string | null; purpose: string | null; groundRefs: string[]; keys: string[] }>;
  invalidations?: Array<{ at: string; source: 'CACHE_READ' | 'COHERENCE'; reasons: Record<string, number>; removed: number }>;
}

export function t6SuggestionReportOf(v: T6SuggestionValidation | null, promptSupported: boolean): T6SuggestionReport {
  const reasons: Record<string, number> = {};
  for (const r of v?.rejected ?? []) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  return {
    contract: promptSupported ? T6_SUGGESTION_CONTRACT : null,
    promptSupported,
    produced: v?.produced ?? 0,
    accepted: v?.accepted.length ?? 0,
    rejected: v?.rejected.length ?? 0,
    reasons,
    rejections: (v?.rejected ?? []).map((r) => ({ index: r.index, reason: r.reason, subject: r.subject, purpose: r.purpose, groundRefs: r.groundRefs })),
    acceptedGrounds: (v?.accepted ?? []).map((s) => ({
      subject: s.subject ?? null, purpose: s.purpose ?? null, groundRefs: s.groundRefs ?? [], keys: (s.grounds ?? []).map((g) => g.key),
    })),
  };
}

/** Élément conservé dans le cache (tout ce qu'il faut pour revalider à la relecture). */
export function storedSuggestionOf(s: T6Suggestion): Record<string, unknown> {
  return {
    question: s.question, subject: s.subject ?? null, purpose: s.purpose ?? null, assetRef: s.assetRef ?? null, deadlineRef: s.deadlineRef ?? null,
    decision: s.decision ?? null, groundRefs: s.groundRefs ?? [], informationNature: s.informationNature ?? [], grounds: s.grounds ?? [],
  };
}

/** Questions retenues → éléments secondaires « question » (cliqués : T2, comme aujourd'hui). */
export function suggestionSecondaries(list: readonly T6Suggestion[]): MascotSecondary[] {
  return list.map((s, i) => ({
    id: `Q:T6:${i + 1}`,
    kind: 'question' as const,
    sourceCode: 'Q:T6',
    occurrenceKey: `Q:T6:${forme(s.question)}${s.assetId ? `:${s.assetId}` : ''}`,
    action: {
      actionId: `Q:T6:${i + 1}`,
      label: s.question,
      target: {
        kind: 'ask' as const, question: s.question,
        context: { intent: T6_SUGGESTION_INTENT, ...(s.assetId ? { assetId: s.assetId } : {}) },
      },
    },
  }));
}

/**
 * Lot 87C (AC10) — le texte master EFFECTIF porte-t-il le contrat des
 * questions fondées ? Il faut l'emplacement `{{SUGGESTION_CONTEXT}}`,
 * l'identifiant du contrat et le champ `"groundRefs"` de la sortie. Le
 * fichier du dépôt est examiné comme une version BO (aucune présomption) :
 * une version antérieure — dépôt compris — ne publie AUCUNE question.
 */
export function promptSupportsSuggestionGrounds(effectiveText: string | null | undefined): boolean {
  return !!effectiveText && effectiveText.includes('{{SUGGESTION_CONTEXT}}')
    && effectiveText.includes(T6_SUGGESTION_CONTRACT) && effectiveText.includes('"groundRefs"');
}

/**
 * Lot 72A (AC06) — échéances du contexte des questions, à partir des
 * décisions T6 du passage (pure) : `agenda` — éligibles (ni écartées après
 * évaluation, ni reportées ou refusées par l'utilisateur) ; `excluded` — les
 * autres, jamais transmises ni citées ; `signaledIds` — retenues dans la bulle.
 */
export function suggestionAgendaOf(
  rows: readonly MascotAgendaRow[],
  prep: { discarded: ReadonlySet<number>; userSilenced: ReadonlySet<number>; shown: ReadonlyArray<{ agendaItemId: number }> },
): { agenda: MascotAgendaRow[]; excluded: MascotAgendaRow[]; signaledIds: Set<number> } {
  const ecartee = (r: MascotAgendaRow) => prep.discarded.has(r.id) || prep.userSilenced.has(r.id);
  return {
    agenda: rows.filter((r) => !ecartee(r)),
    excluded: rows.filter(ecartee),
    signaledIds: new Set(prep.shown.map((x) => x.agendaItemId)),
  };
}

// ── Lecture (serveur) ────────────────────────────────────────────────────────

/** Opérations actives du compte (réalisées ou envisagées), bornées au compte. */
export async function countSuggestionOperations(accountId: number): Promise<number> {
  const { pgClient } = await import('@/db');
  const r = (await pgClient.unsafe(
    `SELECT count(*)::int AS n FROM (SELECT 1 FROM business_operations
      WHERE account_id = $1 AND invalidated_at IS NULL AND status <> 'CANCELLED' LIMIT 1) x`,
    [accountId] as never[],
  )) as unknown as Array<{ n: number }>;
  return Number(r[0]?.n ?? 0);
}

/** Échéances futures transmissibles (ordre de date), comme le contexte. */
export function futureSuggestionAgenda(agenda: readonly MascotAgendaRow[] | null, today: string): MascotAgendaRow[] {
  return (agenda ?? [])
    .filter((r) => r.date && r.date > today && !r.requiresQualification)
    .sort((a, b) => a.date!.localeCompare(b.date!) || a.id - b.id);
}

/**
 * Contexte des questions suggérées d'un compte — lectures canoniques
 * existantes (`account-state`), bornées au compte ; fondements des échéances
 * fournis par l'appelant (décision T6 du passage, sans relecture). Rend
 * `null` si le compte est vide (l'accueil propose alors ses questions
 * d'amorce) ou si une lecture échoue (aucune question plutôt qu'une question
 * trompeuse).
 */
export async function loadT6SuggestionContext(
  accountId: number,
  p: {
    speech: string; attentionToday: boolean; agenda: MascotAgendaRow[] | null; today: string;
    excluded?: readonly MascotAgendaRow[]; signaledIds?: ReadonlySet<number>;
    /** Lot 87C : fondements canoniques des échéances (`suggestionGroundsOf`). */
    grounds?: ReadonlyMap<number, T6DeadlineGroundsInput>;
  },
): Promise<T6SuggestionBundle | null> {
  try {
    const [{ loadAccountSuggestionState, listNameableSuggestionAssets }, { deadlineButtonLabel }, { formatDateFr, roleOf }] = await Promise.all([
      import('@/services/verebona-assistant/core/account-state'),
      import('./deadline-label'),
      import('./signals'),
    ]);
    const [state, assets, operations] = await Promise.all([
      loadAccountSuggestionState(accountId),
      listNameableSuggestionAssets(accountId, MAX_SUGGESTION_ASSETS),
      countSuggestionOperations(accountId).catch(() => 0),
    ]);
    if ((state.assetsTotal ?? 0) === 0 && (state.documentsTotal ?? 0) === 0) return null;
    return buildT6SuggestionContext({
      speech: p.speech, attentionToday: p.attentionToday, state, operations, assets, agenda: futureSuggestionAgenda(p.agenda, p.today),
      labelOf: (r) => deadlineButtonLabel({ ...r, dateRole: roleOf(r) }),
      formatDate: formatDateFr,
      today: p.today, excluded: p.excluded ?? [], signaledIds: p.signaledIds, grounds: p.grounds,
    });
  } catch (e) {
    console.error('[mascotte] contexte des questions suggérées indisponible :', (e as Error).message);
    return null;
  }
}
