/**
 * T6 — décision d'interpellation et gestion des rappels (lot 60, ticket
 * « [P2] T6 — Améliorer la décision d'interpellation et implémenter la
 * gestion intelligente des rappels »). Partie PURE (aucun accès base).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'IA JUGE, LE CODE GARANTIT
 *
 * Avant : toute prochaine échéance devenait un sujet de la mascotte, qu'elle
 * soit dans 78 jours ou qu'il n'y ait rien à faire (« T6 confond l'existence
 * d'une information avec la pertinence d'interpeller »).
 *
 * Désormais chaque échéance candidate passe par `decideT6Interpellation`,
 * AVANT la composition de la bulle : la phrase et les cartes sont construites
 * sur les MÊMES décisions — un sujet écarté n'apparaît ni dans le texte, ni
 * dans les cartes.
 *
 *   · L'IA évalue chaque candidat — lot 61 : dans un MODE DISTINCT du prompt
 *     maître (`t6_evaluate`, MODE=EVALUATE, contrat `t6-evaluation-v1`,
 *     `t6-contract.ts`) : décision SHOW_NOW / DEFER / SUPPRESS, catégorie,
 *     motif d'un référentiel fermé, justification, action attendue, dates,
 *     priorité INDICATIVE, preuves, incertitudes. Aucune règle par catégorie
 *     d'échéance (assurance, garantie, entretien…) n'existe ici.
 *   · Le code applique le DÉTERMINISTE : sujet clos, refus et reports de
 *     l'utilisateur, seuil indicatif (60 jours, réglable dans le BO) avec
 *     exception MOTIVÉE par l'IA, réévaluation après un report, anti-
 *     répétition, aucun délai inventé, trace de chaque décision.
 *
 * DÉGRADATION PRUDENTE (`aiCapable = false` : T6 coupé dans le BO, ou version
 * active du prompt antérieure au lot 61, sans branche EVALUATE) — lot 61 :
 * aucune échéance NON ÉVALUÉE n'est présentée d'office (ni proche, ni
 * dépassée : l'absence de confirmation n'est pas une action à faire) ; seule
 * l'action métier ÉTABLIE est conservée — échéance dépassée « à préciser »
 * (`requiresQualification`, constatée par T4). L'accueil dit alors que
 * l'examen des échéances est indisponible, jamais que tout va bien.
 * ══════════════════════════════════════════════════════════════════════════
 */

// ── Contrat ─────────────────────────────────────────────────────────────────

export type T6Decision = 'SHOW_NOW' | 'DEFER' | 'SUPPRESS';
/**
 * Conclusion de l'IA : à traiter maintenant, à anticiper, rappel informatif
 * (lot 68 : SHOW_NOW + INFORMATION, aucune action attendue), plus tard, aucune.
 */
export type T6AiInterpellation = 'ACT_NOW' | 'ANTICIPATE' | 'INFORM' | 'LATER' | 'NONE';
export type T6Priority = 'HIGH' | 'MEDIUM' | 'LOW';
export const T6_AI_INTERPELLATIONS: readonly T6AiInterpellation[] = ['ACT_NOW', 'ANTICIPATE', 'INFORM', 'LATER', 'NONE'];
export const T6_PRIORITIES: readonly T6Priority[] = ['HIGH', 'MEDIUM', 'LOW'];

/** Codes de justification (liste fermée, affichée dans le reporting T6). */
export type T6DecisionCode =
  | 'SUBJECT_CLOSED'
  | 'USER_DISMISSED_OCCURRENCE'
  | 'USER_DISMISSED_SERIES'
  | 'USER_SNOOZED'
  | 'SNOOZE_OVERRIDDEN_SIGNIFICANT_CHANGE'
  | 'AWAITING_REEVALUATION_AFTER_SNOOZE'
  | 'AI_ASSESSMENT_PENDING'
  | 'NO_AI_BEYOND_THRESHOLD'
  | 'NO_AI_QUALIFICATION_REQUIRED'
  | 'EVALUATION_UNAVAILABLE'
  | 'AI_NO_INTERPELLATION'
  | 'AI_LATER'
  | 'BEYOND_THRESHOLD'
  | 'THRESHOLD_EXCEPTION'
  | 'INSUFFICIENT_CONTEXT'
  | 'REPEAT_COOLDOWN'
  | 'AI_ACT_NOW'
  | 'AI_ANTICIPATE'
  /** Lot 68 : rappel informatif pertinent (SHOW_NOW + INFORMATION), sans action. */
  | 'AI_INFORM'
  /**
   * Lot 71G (T6-06) : préférences de l'utilisateur ILLISIBLES (panne) — un
   * refus ou un report ne pouvant être vérifié, le sujet n'est pas
   * réintroduit (indisponibilité technique, jamais une conclusion métier).
   */
  | 'PREFERENCES_UNAVAILABLE'
  /**
   * Lot 72A (ATP-FIX-17) : décisions « À traiter » ILLISIBLES (panne) — une
   * échéance portée ou réglée par « À traiter » ne pouvant être vérifiée,
   * elle n'est pas relancée (indisponibilité technique, provisoire).
   */
  | 'TO_PROCESS_UNAVAILABLE'
  /**
   * Lot 75E (C) : exception au seuil demandée par l'IA, mais aucune preuve
   * CONCRÈTE réellement disponible ne la fonde (intitulé de document seul,
   * fait incertain, preuve disparue) — aucune interpellation par défaut.
   */
  | 'THRESHOLD_EXCEPTION_UNPROVEN';

/**
 * Lot 71G — motif d'une (ré)évaluation demandée, tracé au reporting :
 * première évaluation, contexte métier ou documentaire changé, évaluation
 * ancienne ou date de réévaluation atteinte, contrat changé, report arrivé à
 * sa date, renouvellement ciblé du lot 68.
 */
export type T6ReevaluationReason =
  | 'FIRST_ASSESSMENT' | 'CONTEXT_CHANGED' | 'AGED' | 'REVIEW_DATE' | 'CONTRACT_CHANGED' | 'SNOOZE_DUE' | 'LEGACY_FINGERPRINT' | 'REMINDER_RENEWAL'
  /** Lot 72A : version effective du prompt EVALUATE ou configuration déterminante changée (invalidation stricte). */
  | 'CONFIG_CHANGED';

/**
 * Évaluation d'UN candidat, validée. Lot 61 : issue du contrat
 * `t6-evaluation-v1` (champs `decision` … `evidenceRefs`) ; les champs
 * historiques (`interpellation`, `actionNeeded`, `exceptionReason`…) en sont
 * DÉRIVÉS (`assessmentFromDecision`) pour la fonction de décision.
 */
export interface T6Assessment {
  /** Décision de l'IA (indicative : le serveur décide de l'affichage). */
  decision?: T6Decision;
  category?: 'ACTION_NOW' | 'TO_ANTICIPATE' | 'INFORMATION';
  /** Motif du référentiel fermé (`T6_REASON_CODES`). */
  reasonCode?: string | null;
  /** Références justificatives (sous-ensemble de celles transmises). */
  evidenceRefs?: string[];
  uncertainties?: string[];
  interpellation: T6AiInterpellation;
  actionNeeded: boolean;
  /** Démarche attendue, courte (« comparer les offres avant le renouvellement »). */
  action: string | null;
  /** Pourquoi solliciter (ou non) maintenant. Obligatoire. */
  reason: string;
  consequence: string | null;
  /** Date pertinente pour agir (AAAA-MM-JJ), si identifiable. */
  actionDate: string | null;
  priority: T6Priority;
  uncertainty: string | null;
  /** Raison CONCRÈTE d'interpeller au-delà du seuil (obligatoire dans ce cas). */
  exceptionReason: string | null;
  /** Date à laquelle réévaluer (AAAA-MM-JJ), si l'IA en propose une. */
  reevaluateOn: string | null;
}

/** Évaluation conservée (`t6_interpellation_assessments`). */
export interface T6StoredAssessment extends T6Assessment {
  id?: number;
  /** Empreinte du candidat au moment de l'évaluation. */
  fingerprint: string;
  /** Jour (Europe/Paris) de l'évaluation. */
  assessedOn: string;
  promptVersion?: string | null;
  traceId?: string | null;
  /** Contrat de l'évaluation (`t6-evaluation-v1`) ; autre / absent : lot 60, caduque. */
  contractVersion?: string | null;
  /**
   * Lot 68 (migration 0474) : révision du contrat. 1 (ou absent) : évaluée
   * par une version du prompt qui ne connaît pas le rappel informatif ;
   * 2 : version porteuse de la règle (`INFORMATIVE_REMINDER`).
   */
  contractRevision?: number | null;
  /** Lot 71G (0507) : preuves citées et leurs versions (références seules). */
  evidenceSnapshot?: { version?: number; fingerprint?: string; refs?: T6EvidenceVersion[] } | null;
  /** Lot 71G (0507) : motif de la (ré)évaluation qui a produit cette décision. */
  reevaluationReason?: string | null;
  /**
   * Lot 72A (0510) : signature de la configuration EVALUATE qui a décidé —
   * section EVALUATE du prompt effectif, contrats, modèle, seuil. Absente :
   * décision antérieure (comparée par la version du master, `promptVersion`).
   */
  evaluationSignature?: string | null;
}

/**
 * Lot 72A — configuration EVALUATE COURANTE (`t6EvaluationConfig`) :
 * `signature` (section EVALUATE du prompt effectif, contrats, modèle, seuil)
 * et `masterVersion` (version du master, sans la configuration — même forme
 * que le début de `promptVersion` des décisions antérieures).
 */
export interface T6EvaluationConfig {
  signature: string | null;
  masterVersion: string | null;
  /**
   * Lot 76A (AC04) — transition : signature COURANTE calculée comme au lot 72A
   * (`e1:` : section EVALUATE, contrats, modèle principal, seuil), pour relire
   * les décisions qui la portent.
   */
  legacySignature?: string | null;
  /**
   * Lot 76A — signature complète (`e2:`) observée la PREMIÈRE fois avec cette
   * signature `e1:` (référence de transition, migration 0575). Une décision
   * `e1:` égale à `legacySignature` reste valable tant que la configuration
   * complète n'a pas changé depuis cette référence. `null` : inconnue (table
   * absente, lecture en échec) — aucune invalidation (prudence de coût).
   */
  legacyBaseline?: string | null;
}

/** Lot 76A : préfixe des signatures EVALUATE complètes (chaîne de modèles, raisonnement, limite de sortie). */
export const T6_EVALUATION_SIGNATURE_V2 = 'e2:';

/** Version du master d'une décision conservée (`t6_master_v1@pv12:abc|cfg:3` → `t6_master_v1@pv12:abc`). */
export const masterVersionOf = (promptVersion: string | null | undefined): string | null =>
  promptVersion ? promptVersion.split('|')[0] || null : null;

export type T6SubjectState = 'ACTIVE' | 'RESOLVED' | 'OBSOLETE';

/** Échéance candidate à une interpellation, identifiée de façon STABLE. */
export interface T6Candidate {
  /** `agenda:<id>` — jamais dérivé d'un texte IA. */
  subjectKey: string;
  agendaItemId: number;
  /** `agenda:<id>@<date>` : l'occurrence présentée (cycle = date). */
  occurrenceKey: string;
  /** Série (`agenda_items.series_key`) ou null. */
  seriesKey: string | null;
  accountId: number;
  assetId: number | null;
  /** Échéance (AAAA-MM-JJ) ou null. */
  dueDate: string | null;
  state: T6SubjectState;
  /**
   * Empreinte des données SIGNIFICATIVES : titre, date, nature, qualification
   * (lot 60) ; lot 71G (T6-01) : description normalisée, fin, documents liés
   * et faits documentaires pertinents (T1/T3) — préfixe `v2:`.
   */
  fingerprint: string;
  /** Lot 71G : empreinte historique (lot 60, sans préfixe) — relecture des évaluations et reports antérieurs. */
  legacyFingerprint?: string;
  /** Lot 75E : empreinte enrichie du lot 71G (`v2:`) — relecture des évaluations et reports antérieurs. */
  v2Fingerprint?: string;
  /** Lot 76A : empreinte du contenu probant du lot 75E (`v3:`) — relecture des évaluations et reports antérieurs. */
  v3Fingerprint?: string;
  /**
   * Lot 75E (D) : identité PERSISTANTE du cycle de l'occurrence (`t6CycleKey`),
   * cohérente avec T4. Absente (lecture impossible) : préférences appliquées.
   */
  cycleKey?: string | null;
  /** Lot 71G : description, document ou fait documentaire disponibles (au-delà du titre et de la date). */
  hasEvidence?: boolean;
  /** Lot 71G : faits documentaires pertinents (T1/T3) — justifient l'évaluation d'une échéance lointaine. */
  hasDocumentaryEvidence?: boolean;
  /** Lot 71G : les données documentaires n'ont pas pu être lues — empreinte inconnue, aucune évaluation. */
  fingerprintUnavailable?: boolean;
  /** Lot 61 : échéance « à préciser » (T4) — seule action établie sans évaluation IA. */
  requiresQualification?: boolean;
}

export type T6PreferenceScope = 'OCCURRENCE' | 'SERIES';
export type T6PreferenceDecision = 'SNOOZED' | 'DISMISSED';

/** Décision de rappel d'UN utilisateur (Duo : jamais celle de l'autre membre). */
export interface T6ReminderPreference {
  scope: T6PreferenceScope;
  decision: T6PreferenceDecision;
  /** AAAA-MM-JJ (SNOOZED). */
  remindAt: string | null;
  /** Empreinte du sujet au moment du report (modification significative). */
  contextFingerprint: string | null;
  agendaItemId: number | null;
  seriesKey: string | null;
  updatedAt?: string | null;
  /**
   * Lot 71G (T6-07) : date de l'occurrence au moment du choix (portée
   * OCCURRENCE) — lot 75E : conservée pour la traçabilité seulement.
   */
  occurrenceDate?: string | null;
  /**
   * Lot 75E (D, migration 0551) : cycle de l'occurrence au moment du choix
   * (`t6CycleKey`). Absent : préférence antérieure, appliquée (prudence).
   */
  cycleKey?: string | null;
}

export interface T6DecisionInput {
  candidate: T6Candidate;
  /** AAAA-MM-JJ (Europe/Paris). */
  today: string;
  thresholdDays: number;
  /** T6 disponible ET prompt actif porteur de la branche EVALUATE (lot 61). */
  aiCapable: boolean;
  assessment: T6StoredAssessment | null;
  /** Préférences de l'utilisateur courant applicables au candidat (occurrence + série). */
  preferences: T6ReminderPreference[];
  /** Historique des interpellations : jours distincts d'affichage récents (même contexte). */
  history?: { displayedDays: number } | null;
  /**
   * Lot 68 : le prompt effectif connaît le rappel informatif — les évaluations
   * antérieures susceptibles de changer (SHOW_NOW, SUPPRESS « aucune action »)
   * sont alors réévaluées en arrière-plan (renouvellement ciblé), sans être
   * retirées de l'accueil entre-temps.
   */
  reminderCapable?: boolean;
  /** Lot 71G (T6-06) : les préférences de l'utilisateur n'ont pas pu être lues. */
  preferencesUnavailable?: boolean;
  /**
   * Lot 72A (AC02) : configuration EVALUATE courante — une décision prise
   * sous une autre version effective du prompt EVALUATE (ou un autre modèle,
   * un autre seuil) est INVALIDÉE, jamais réutilisée. Absente ou illisible :
   * aucune invalidation (jamais de réévaluation de masse sur une panne).
   */
  evaluationConfig?: T6EvaluationConfig | null;
  /**
   * Lot 72A (ATP-FIX-17) : l'appartenance du candidat à « À traiter » (action
   * ouverte, ou décision qui règle l'échéance) n'a pas pu être vérifiée.
   */
  toProcessUnavailable?: boolean;
  /**
   * Lot 75E (C) : l'évaluation conservée cite-t-elle une preuve CONCRÈTE
   * encore disponible (`exceptionEvidenceGrounded`) ? `false` : aucune
   * exception au seuil ne peut s'appuyer dessus ; absent : non vérifié
   * (appelants antérieurs, règle du lot 71G).
   */
  exceptionGrounded?: boolean;
}

export interface T6DecisionResult {
  decision: T6Decision;
  code: T6DecisionCode;
  /** Explication lisible (aucune donnée personnelle : ni titre, ni bien). */
  explanation: string;
  /** Prochaine réévaluation (AAAA-MM-JJ) si applicable. */
  nextReevaluationAt: string | null;
  priority: T6Priority;
  subjectKey: string;
  occurrenceKey: string;
  /** Report volontaire (USER) ou réévaluation automatique (SYSTEM). */
  deferredBy: 'USER' | 'SYSTEM' | null;
  /** Le seuil a écarté le sujet (true) ou a été franchi par exception motivée. */
  thresholdApplied: boolean;
  thresholdException: boolean;
  daysUntilDue: number | null;
  userPreference: { decision: T6PreferenceDecision; scope: T6PreferenceScope; remindAt: string | null } | null;
  /** Une (nouvelle) évaluation IA est attendue pour ce candidat. */
  needsAssessment: boolean;
  /** Mode d'interpellation retenu (SHOW_NOW seulement) ; `INFORM` : rappel informatif (lot 68). */
  mode: 'ACT_NOW' | 'ANTICIPATE' | 'INFORM' | 'LEGACY' | null;
  /** Démarche attendue (IA), pour la formulation. */
  action: string | null;
  actionDate: string | null;
  /** L'évaluation utilisée était encore valable (même contexte, pas échue). */
  assessmentFresh: boolean;
  /**
   * Lot 61 : décision de l'IA prise en compte (null : aucune évaluation
   * utilisable). Différente de `decision` : écart IA / règles du serveur
   * (seuil, préférence, anti-répétition…), tracé au reporting.
   */
  aiDecision: T6Decision | null;
  /** Lot 71G : motif de la réévaluation demandée (`needsAssessment`), sinon null. */
  reevaluationReason: T6ReevaluationReason | null;
}

// ── Réglages (constantes ; le seuil est réglable dans le BO) ─────────────────

/** Seuil indicatif par défaut (jours) — réglage BO `t6_interpellation_threshold_days`. */
export const DEFAULT_T6_THRESHOLD_DAYS = 60;
/** Une évaluation IA est revue au plus tard après ce délai. */
export const T6_ASSESSMENT_MAX_AGE_DAYS = 14;
/** Candidats évalués par l'IA au-delà du seuil (exception possible) jusqu'à cet horizon au moins. */
export const T6_ASSESSMENT_MIN_HORIZON_DAYS = 180;
/** Candidats transmis à l'IA par appel, au plus. */
export const T6_MAX_ASSESSMENTS_PER_CALL = 8;
/** Anti-répétition : fenêtre, nombre de jours d'affichage, durée de pause. */
export const T6_REPEAT_WINDOW_DAYS = 10;
export const T6_REPEAT_MAX_DAYS = 5;
export const T6_REPEAT_COOLDOWN_DAYS = 7;

/*
 * Lot 75E (D) : l'écart de 183 jours du lot 71G (`T6_NEW_CYCLE_MIN_DAYS`) est
 * SUPPRIMÉ — remplacé par l'identité persistante du cycle (`t6CycleKey`).
 */

/**
 * Horizon des candidats soumis à l'IA : trois fois le seuil, 180 jours au
 * moins. Lot 71G (T6-03) : au-delà, seule une échéance porteuse d'une preuve
 * documentaire (document lié, fait extrait) est évaluée — la date d'action
 * peut précéder de loin l'échéance (préavis, délai contractuel).
 */
export function assessmentHorizonDays(thresholdDays: number): number {
  return Math.max(T6_ASSESSMENT_MIN_HORIZON_DAYS, thresholdDays * 3);
}

// ── Dates ───────────────────────────────────────────────────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Date civile RÉELLE (AAAA-MM-JJ) — lot 71G (T6-08) : « 2027-02-30 » est refusée. */
export const isDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
};

/** Lot 71G (T6-08) : report au plus loin (jours) — même borne côté interface et côté API. */
export const T6_MAX_SNOOZE_DAYS = 730;

/** Jour civil courant en Europe/Paris (AAAA-MM-JJ) — pur, sans base. */
export function parisDayOf(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * Lot 71G (T6-08) — contrôle d'une date de rappel (pure, PARTAGÉE par
 * l'interface et l'API) : date civile réelle, de demain à deux ans, « aujourd'hui »
 * étant celui d'Europe/Paris. Rend le message d'erreur, ou null.
 */
export function snoozeDateError(remindAt: unknown, today: string): string | null {
  if (!isDay(remindAt)) return 'Cette date n’existe pas. Choisissez une date valide.';
  if (remindAt <= today) return 'Choisissez une date à partir de demain.';
  if (remindAt > addDays(today, T6_MAX_SNOOZE_DAYS)) return 'Choisissez une date dans les deux prochaines années.';
  return null;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

export function addDays(day: string, n: number): string {
  const d = new Date(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) + n * 86_400_000);
  return d.toISOString().slice(0, 10);
}

const minDay = (...xs: Array<string | null | undefined>): string | null =>
  xs.filter((x): x is string => !!x).sort()[0] ?? null;

// ── Identifiants stables ────────────────────────────────────────────────────

export const agendaSubjectKey = (agendaItemId: number) => `agenda:${agendaItemId}`;
export const seriesSubjectKey = (seriesKey: string) => `series:${seriesKey}`;
export const agendaOccurrenceKey = (agendaItemId: number, date: string | null) => `agenda:${agendaItemId}@${date ?? 'sans-date'}`;

/**
 * Empreinte des champs SIGNIFICATIFS d'une échéance : un changement de titre,
 * de date, de nature (prévisionnelle / confirmée) ou de qualification
 * provoque une réévaluation — jamais la suppression d'une préférence.
 */
export function agendaFingerprintParts(p: { title: string; date: string | null; forecast: boolean; requiresQualification: boolean }): string {
  return JSON.stringify([p.title.trim().replace(/\s+/g, ' '), p.date ?? null, p.forecast ? 1 : 0, p.requiresQualification ? 1 : 0]);
}

/**
 * Lot 71G (T6-01, T6-04) — faits documentaires PERTINENTS pour décider
 * d'interpeller : préavis, résiliation, renouvellement, échéance, obligation,
 * entretien, contrôle, intervention, garantie, délai, périodicité, durée.
 * Motif appliqué à la clé (canonique et T1) et au libellé du fait — en SQL
 * (`~*`) comme en TypeScript. Les autres faits (puissance, adresse…) ne
 * changent ni l'empreinte ni la décision.
 */
export const T6_RELEVANT_FACT_PATTERN = 'pr[eé]avis|notice|r[eé]sili|terminat|renouvel|renewal|reconduc|[eé]ch[eé]an|expir|deadline|obligat|entretien|maintenance|r[eé]vision|contr[oô]le|inspection|intervention|visite|garantie|warranty|d[eé]lai|p[eé]riodicit|frequen|fr[eé]quence|dur[eé]e|duration|cong[eé]|end_?date|enddate|date_?fin|fin_?contrat';
const FAIT_PERTINENT = new RegExp(T6_RELEVANT_FACT_PATTERN, 'i');
/** Le fait est-il pertinent pour T6 (pure) ? */
export const isT6RelevantFact = (f: { key: string; canonicalKey?: string | null; label?: string | null }) =>
  FAIT_PERTINENT.test(`${f.canonicalKey ?? ''} ${f.key} ${f.label ?? ''}`);

/** Lot 71G : préfixe des empreintes enrichies (données métier et documentaires). */
export const T6_FINGERPRINT_V2 = 'v2:';
/** Lot 75E (C) : préfixe des empreintes du CONTENU PROBANT (extraits, provenance). */
export const T6_FINGERPRINT_V3 = 'v3:';

/**
 * Texte normalisé pour l'empreinte (pure) : casse, accents, ponctuation et
 * espaces sont COSMÉTIQUES — ils ne provoquent aucune réévaluation.
 */
export function normalizeForFingerprint(v: string | null | undefined): string {
  return (v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Fait documentaire retenu dans l'empreinte. Lot 71G : contenu métier (clé,
 * valeur, confiance). Lot 75E (C) : plus le CONTENU PROBANT de l'extrait et la
 * provenance (empreinte `v3:`) — jamais l'identifiant ni la version d'extraction.
 */
export interface T6FingerprintFact {
  fileId: number; key: string; value: string | null; confidence: string | null;
  excerpt?: string | null; provenance?: string | null;
}

/** Mots VIDES d'un extrait (articles, auxiliaires) : leur variation est cosmétique. Négations conservées. */
const MOTS_VIDES_PREUVE = new Set([
  'le', 'la', 'les', 'l', 'un', 'une', 'des', 'de', 'du', 'd', 'et', 'est', 'sont', 'etre', 'a', 'au', 'aux', 'en', 'par', 'pour',
  'que', 'qui', 'qu', 'ce', 'cet', 'cette', 'ces', 'se', 's', 'sa', 'son', 'ses', 'leur', 'leurs', 'il', 'elle', 'on', 'y', 'dans',
  'sur', 'avec', 'ou', 'c', 'j', 'n', 'votre', 'vos', 'notre', 'nos', 'tout', 'toute', 'tous', 'toutes',
]);

/**
 * Lot 75E (C) — représentation STABLE du contenu probant d'un extrait
 * (pure) : texte replié, mots vides retirés, mots significatifs (nombres,
 * durées, négations, verbes de l'obligation) dédoublonnés et triés. Une
 * réextraction reformulée (« Entretien annuel. » / « L'entretien est
 * annuel. ») donne la même représentation ; une clause modifiée (« un mois »
 * → « trois mois », « avant » → « après », « sans » ajouté) la change.
 */
export function probativeContent(excerpt: string | null | undefined): string {
  const mots = normalizeForFingerprint(excerpt).split(' ').filter((w) => w && !MOTS_VIDES_PREUVE.has(w));
  return [...new Set(mots)].sort().join(' ');
}

/** Provenance normalisée (T1, revalidation T2, consolidation T3…) : change la fiabilité de la preuve. */
export const provenanceClass = (p: string | null | undefined): string => (p ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_') || 'INCONNUE';

/**
 * Lot 71G (T6-01) — parties de l'empreinte ENRICHIE (pure) : celles du lot
 * 60, plus la description et la date de fin normalisées, les documents liés
 * (identifiant, intitulé normalisé) et les faits documentaires pertinents
 * (document, clé, valeur normalisée, confiance). Une réextraction T1 qui
 * produit les mêmes faits (nouvelle version, extrait reformulé) ne change
 * rien ; une clause nouvelle, un document ajouté ou supprimé, si.
 */
export function t6FingerprintParts(p: {
  title: string; date: string | null; forecast: boolean; requiresQualification: boolean;
  description?: string | null; endDate?: string | null;
  documents?: ReadonlyArray<{ fileId: number; title: string | null }>;
  facts?: readonly T6FingerprintFact[];
}): string {
  const docs = [...(p.documents ?? [])].map((d) => [d.fileId, normalizeForFingerprint(d.title)] as const).sort((a, b) => a[0] - b[0]);
  const faits = [...new Set((p.facts ?? []).map((f) => JSON.stringify([f.fileId, f.key, normalizeForFingerprint(f.value), f.confidence ?? null])))].sort();
  return JSON.stringify([agendaFingerprintParts(p), normalizeForFingerprint(p.description), p.endDate ?? null, docs, faits]);
}

/**
 * Lot 75E (C) — parties de l'empreinte du CONTENU PROBANT (`v3:`, pure) :
 * celles du lot 71G, chaque fait portant en plus la représentation stable de
 * son extrait (`probativeContent`) et sa provenance (`provenanceClass`). Une
 * clause modifiée sans changement de titre ni de date, un statut de
 * confiance ou une provenance qui change : réévaluation. Une réextraction
 * sémantiquement identique (nouvelle version, extrait reformulé, casse,
 * ponctuation) : aucune.
 */
export function t6ProbativeFingerprintParts(p: Parameters<typeof t6FingerprintParts>[0]): string {
  const docs = [...(p.documents ?? [])].map((d) => [d.fileId, normalizeForFingerprint(d.title)] as const).sort((a, b) => a[0] - b[0]);
  const faits = [...new Set((p.facts ?? []).map((f) => JSON.stringify([
    f.fileId, f.key, normalizeForFingerprint(f.value), f.confidence ?? null, probativeContent(f.excerpt), provenanceClass(f.provenance),
  ])))].sort();
  return JSON.stringify(['v3', agendaFingerprintParts(p), normalizeForFingerprint(p.description), p.endDate ?? null, docs, faits]);
}

/** Lot 76A (P1) : préfixe des empreintes du CONTEXTE TRANSMIS à EVALUATE (représentation commune). */
export const T6_FINGERPRINT_V4 = 'v4:';

/**
 * Lot 76A (P1) — représentation stable d'un extrait qui CONSERVE L'ORDRE des
 * mots significatifs (pure). Casse, accents, ponctuation, espaces et mots
 * vides (articles, auxiliaires) restent cosmétiques ; l'ordre, lui, porte le
 * sens (« à la charge du client et non du prestataire » ≠ l'inverse) — ce que
 * `probativeContent` (lot 75E : mots triés et dédoublonnés) effaçait.
 */
export function probativeSequence(excerpt: string | null | undefined): string {
  return normalizeForFingerprint(excerpt).split(' ').filter((w) => w && !MOTS_VIDES_PREUVE.has(w)).join(' ');
}

/**
 * Lot 76A (P1) — partie SIGNIFICATIVE et stable de ce qui est transmis à
 * EVALUATE pour un candidat (`T6EvaluationCandidate`), construite par
 * `evaluationSubjectOf` (service) — la MÊME construction sert au contexte
 * transmis et à son empreinte. Rien de volatil : ni `daysUntilDue`,
 * `overdue`, `recentlyShownDays` (le franchissement du seuil et de la date
 * sont traités par `assessmentFreshness`), ni identifiant technique.
 */
export interface T6EvaluationSubjectCore {
  title: string;
  description: string | null;
  assetName: string | null;
  assetCategory: string | null;
  dueDate: string | null;
  dateNature: 'confirmée' | 'prévisionnelle';
  dateRole: string | null;
  requiresQualification: boolean;
  recurring: boolean;
  /** Intitulés des documents TRANSMIS (sélection et ordre d'EVALUATE). */
  documents: string[];
  /** Faits TRANSMIS (8 au plus) : document source par sa position dans `documents`. */
  facts: Array<{ document: number | null; label: string; value: string | null; excerpt: string | null; status: string; provenance: string }>;
}

/**
 * Lot 76A (P1) — parties de l'empreinte `v4:` (pure) : normalisation
 * COSMÉTIQUE seulement (casse, accents, ponctuation, mots vides d'un extrait)
 * — jamais une différence de sens (ordre des mots, négation, nombre, durée).
 * Documents et faits sont rangés par leur CONTENU : une réextraction
 * identique (nouveaux identifiants, autre ordre de lecture) ou un document
 * réimporté sous le même intitulé ne change rien ; un document source
 * différent, si (référencé par son intitulé, pas par son identifiant).
 */
export function t6EvaluationSubjectParts(s: T6EvaluationSubjectCore): string {
  const docs = s.documents.map((t) => normalizeForFingerprint(t));
  const faits = s.facts.map((f) => JSON.stringify([
    f.document != null ? docs[f.document] ?? null : null, normalizeForFingerprint(f.label), normalizeForFingerprint(f.value),
    probativeSequence(f.excerpt), f.status, provenanceClass(f.provenance),
  ])).sort();
  return JSON.stringify([
    'v4', normalizeForFingerprint(s.title), normalizeForFingerprint(s.description), normalizeForFingerprint(s.assetName),
    (s.assetCategory ?? '').trim().toUpperCase() || null, s.dueDate, s.dateNature, s.dateRole ?? 'DEADLINE',
    s.requiresQualification ? 1 : 0, s.recurring ? 1 : 0, [...docs].sort(), faits,
  ]);
}

/**
 * Une empreinte conservée (évaluation, report) correspond-elle au candidat ?
 * Empreinte enrichie : comparaison directe ; empreinte historique (lot 60,
 * sans préfixe) : comparée à l'empreinte historique du candidat (pure).
 */
export function sameT6Context(stored: string | null | undefined, c: Pick<T6Candidate, 'fingerprint' | 'legacyFingerprint' | 'v2Fingerprint' | 'v3Fingerprint'>): boolean {
  if (stored == null) return false;
  if (stored.startsWith(T6_FINGERPRINT_V4)) return stored === c.fingerprint;
  // Lot 76A : décision ou report du lot 75E (`v3:`) — comparés à l'empreinte
  // `v3:` COURANTE (aucune réévaluation de masse au déploiement), puis
  // rebasés sur `v4:` par la préparation (`rebaseFingerprints`).
  if (stored.startsWith(T6_FINGERPRINT_V3)) return stored === (c.v3Fingerprint ?? c.fingerprint);
  // Lot 75E : décision ou report antérieurs (empreinte du lot 71G) — comparés
  // à l'empreinte `v2:` COURANTE : aucune réévaluation de masse au déploiement
  // (renouvelées au fil de leur vieillissement, 14 jours au plus).
  if (stored.startsWith(T6_FINGERPRINT_V2)) return stored === (c.v2Fingerprint ?? c.fingerprint);
  return stored === (c.legacyFingerprint ?? c.fingerprint);
}

/**
 * Lot 75E (D) — IDENTITÉ PERSISTANTE DU CYCLE, cohérente avec T4.
 *
 * Dans le modèle d'occurrences de T4, UNE ligne d'agenda = UNE occurrence
 * (un cycle) : une série récurrente (mensuelle, trimestrielle, annuelle,
 * pluriannuelle) a une ligne par occurrence (clé fonctionnelle datée,
 * prévision confirmée « sur place ») ; un renouvellement est une NOUVELLE
 * occurrence (nouvelle clé fonctionnelle ou de projection, donc nouvelle
 * ligne). Une même ligne qui change de date est donc une REPLANIFICATION —
 * quel que soit l'écart. Seul cas où une ligne change de cycle : son
 * occurrence a été RÉALISÉE (trace `agenda_occurrence_events` :
 * `STATUS_CHANGED` « réalisé » ou `STATUS_AUTO_COMPLETED`), puis l'élément a
 * été rouvert pour l'échéance suivante.
 *
 * Cycle = `agenda:<id>#<nombre de réalisations>`. Une préférence d'occurrence
 * retient le cycle du moment du choix ; elle s'applique tant que le cycle
 * est le même — jamais déduit d'un écart de dates (le seuil de 183 jours du
 * lot 71G est supprimé).
 */
export const t6CycleKey = (agendaItemId: number, completions: number): string => `${agendaSubjectKey(agendaItemId)}#${Math.max(0, Math.trunc(completions))}`;

/** Expression SQL du cycle courant d'une échéance (alias `i`) — même valeur que `t6CycleKey`. */
export const t6CycleKeySql = (alias = 'i'): string => `('agenda:' || ${alias}.id || '#' || (
  SELECT count(*) FROM agenda_occurrence_events e
   WHERE e.agenda_item_id = ${alias}.id AND e.account_id = ${alias}.account_id
     AND (e.event_type = 'STATUS_AUTO_COMPLETED'
          OR (e.event_type = 'STATUS_CHANGED' AND e.detail_json ->> 'manualStatus' = 'realise'))))`;

/**
 * Lot 75E (D) — une préférence d'OCCURRENCE s'applique-t-elle au cycle
 * présenté (pure) ? Même cycle (replanification comprise, quel que soit
 * l'écart) : oui ; cycle suivant de la même ligne : non. Préférence de
 * série, préférence antérieure sans cycle, ou cycle courant illisible :
 * appliquée (prudence : un refus non vérifiable n'est jamais levé).
 */
export function preferenceAppliesToCycle(p: Pick<T6ReminderPreference, 'scope' | 'cycleKey'>, cycleKey: string | null | undefined): boolean {
  if (p.scope !== 'OCCURRENCE' || !p.cycleKey || !cycleKey) return true;
  return p.cycleKey === cycleKey;
}

// ── Fraîcheur d'une évaluation ──────────────────────────────────────────────

/**
 * Lot 72A : `CONFIG_CHANGED` — décision prise sous une autre configuration
 * EVALUATE (prompt, modèle, seuil) : inutilisable, comme `CONTEXT_CHANGED`
 * (≠ `AGED`, seulement vieillissante, utilisable pendant son renouvellement).
 */
export type T6AssessmentStatus = 'FRESH' | 'AGED' | 'CONTEXT_CHANGED' | 'CONTRACT_CHANGED' | 'CONFIG_CHANGED' | 'NONE';

/**
 * Lot 72A (AC02) — la décision a-t-elle été prise sous une AUTRE
 * configuration EVALUATE que la courante (pure) ? Signature conservée :
 * comparée telle quelle ; décision antérieure sans signature : version du
 * master comparée ; l'une ou l'autre inconnue : non (prudence de coût).
 */
export function evaluationConfigChanged(a: Pick<T6StoredAssessment, 'evaluationSignature' | 'promptVersion'>, cfg: T6EvaluationConfig | null | undefined): boolean {
  if (!cfg) return false;
  const s = a.evaluationSignature;
  // Lot 76A (AC04, transition) : signature du lot 72A (`e1:`, sans replis,
  // raisonnement ni limite de sortie). Différente du calcul `e1:` courant :
  // prompt EVALUATE, modèle principal ou seuil changés — invalidée comme au
  // lot 72A. Égale : valable tant que la configuration complète n'a pas
  // changé depuis la référence observée au déploiement ; référence inconnue :
  // conservée (jamais d'invalidation de masse sur une panne).
  if (s && !s.startsWith(T6_EVALUATION_SIGNATURE_V2) && cfg.legacySignature !== undefined) {
    if (!cfg.legacySignature) return false;
    if (s !== cfg.legacySignature) return true;
    return !!cfg.legacyBaseline && !!cfg.signature && cfg.legacyBaseline !== cfg.signature;
  }
  if (s) return !!cfg.signature && s !== cfg.signature;
  const avant = masterVersionOf(a.promptVersion);
  return !!avant && !!cfg.masterVersion && avant !== cfg.masterVersion;
}

/**
 * Lot 71G : motif détaillé de la fraîcheur (pure) — même règle que
 * `assessmentStatus`, avec la raison d'une réévaluation (reporting).
 */
export function assessmentFreshness(
  a: T6StoredAssessment | null, c: T6Candidate, today: string, thresholdDays: number,
  opts: { reminderCapable?: boolean; evaluation?: T6EvaluationConfig | null } = {},
): { status: T6AssessmentStatus; reason: T6ReevaluationReason | null } {
  if (!a) return { status: 'NONE', reason: 'FIRST_ASSESSMENT' };
  // Lot 61 : une évaluation d'un autre contrat (R13 du lot 60) n'est jamais
  // réutilisée — le candidat est réévalué par EVALUATE.
  if (a.contractVersion !== T6_ASSESSMENT_CONTRACT) return { status: 'CONTRACT_CHANGED', reason: 'CONTRACT_CHANGED' };
  // Lot 72A (AC02) : nouvelle version effective du prompt EVALUATE, autre
  // modèle ou autre seuil — invalidation STRICTE (jamais réutilisée).
  if (evaluationConfigChanged(a, opts.evaluation)) return { status: 'CONFIG_CHANGED', reason: 'CONFIG_CHANGED' };
  // Lot 71G : données documentaires illisibles — l'évaluation reste utilisable
  // (aucune réévaluation sur un contexte incomplet).
  if (!c.fingerprintUnavailable && !sameT6Context(a.fingerprint, c)) return { status: 'CONTEXT_CHANGED', reason: 'CONTEXT_CHANGED' };
  if (c.dueDate) {
    const avant = daysBetween(a.assessedOn, c.dueDate);
    const maintenant = daysBetween(today, c.dueDate);
    if (avant > thresholdDays && maintenant <= thresholdDays) return { status: 'CONTEXT_CHANGED', reason: 'CONTEXT_CHANGED' };
    if (avant > 0 && maintenant <= 0) return { status: 'CONTEXT_CHANGED', reason: 'CONTEXT_CHANGED' };
  }
  if (daysBetween(a.assessedOn, today) > T6_ASSESSMENT_MAX_AGE_DAYS) return { status: 'AGED', reason: 'AGED' };
  if (a.reevaluateOn && today >= a.reevaluateOn) return { status: 'AGED', reason: 'REVIEW_DATE' };
  // Lot 71G (T6-05) : démarche jugée prématurée, sa date d'action est arrivée.
  if (a.interpellation === 'LATER' && a.actionDate && today >= a.actionDate && a.assessedOn < a.actionDate) return { status: 'AGED', reason: 'REVIEW_DATE' };
  // Lot 71G : évaluation antérieure à l'empreinte enrichie, sur une échéance
  // documentée — utilisable, renouvelée en arrière-plan (une fois).
  // Lot 75E : une empreinte `v3:` (contenu probant) ou `v2:` n'est pas historique.
  if (!c.fingerprintUnavailable && !/^v[234]:/.test(a.fingerprint) && c.hasEvidence) return { status: 'AGED', reason: 'LEGACY_FINGERPRINT' };
  // Lot 68 : renouvellement ciblé (utilisable, réévaluée en arrière-plan).
  if (opts.reminderCapable && assessmentNeedsReminderRenewal(a)) return { status: 'AGED', reason: 'REMINDER_RENEWAL' };
  return { status: 'FRESH', reason: null };
}

/** Contrat des évaluations utilisables (lot 61) — même valeur que `T6_EVALUATION_OUTPUT_SCHEMA_VERSION`. */
export const T6_ASSESSMENT_CONTRACT = 't6-evaluation-v1';
/** Lot 68 : révision du contrat porteuse du rappel informatif (`contract_revision`, 0474). */
export const T6_ASSESSMENT_REVISION_REMINDER = 2;

/**
 * Lot 68 — renouvellement CIBLÉ : une évaluation d'une révision antérieure
 * dont la conclusion pourrait devenir un rappel informatif (SHOW_NOW : action
 * peut-être artificielle ; SUPPRESS « aucune action ») est à revoir quand le
 * prompt effectif connaît la règle. Les autres (DEFER, suppressions motivées
 * autrement) restent valables. Pure.
 */
export function assessmentNeedsReminderRenewal(a: Pick<T6StoredAssessment, 'contractRevision' | 'decision' | 'reasonCode'>): boolean {
  if ((a.contractRevision ?? 1) >= T6_ASSESSMENT_REVISION_REMINDER) return false;
  return a.decision === 'SHOW_NOW' || (a.decision === 'SUPPRESS' && a.reasonCode === 'NO_ACTION_REQUIRED');
}

/**
 * Une évaluation est :
 *   · `CONTEXT_CHANGED` (inutilisable) si le candidat a changé de façon
 *     significative, si l'échéance a franchi le seuil ou est passée depuis ;
 *   · `AGED` (utilisable, à revoir) si elle date de plus de 14 jours ou si
 *     la date de réévaluation proposée par l'IA est atteinte ;
 *   · `FRESH` sinon.
 */
export function assessmentStatus(
  a: T6StoredAssessment | null, c: T6Candidate, today: string, thresholdDays: number,
  opts: { reminderCapable?: boolean; evaluation?: T6EvaluationConfig | null } = {},
): T6AssessmentStatus {
  return assessmentFreshness(a, c, today, thresholdDays, opts).status;
}

// ── Décision ────────────────────────────────────────────────────────────────

const PRIORITY_DEFAULT: T6Priority = 'MEDIUM';

function result(c: T6Candidate, base: Partial<T6DecisionResult> & Pick<T6DecisionResult, 'decision' | 'code' | 'explanation'>, daysUntilDue: number | null): T6DecisionResult {
  return {
    nextReevaluationAt: null, priority: PRIORITY_DEFAULT, deferredBy: null, thresholdApplied: false, thresholdException: false,
    userPreference: null, needsAssessment: false, mode: null, action: null, actionDate: null, assessmentFresh: false, aiDecision: null,
    reevaluationReason: null,
    ...base,
    subjectKey: c.subjectKey, occurrenceKey: c.occurrenceKey, daysUntilDue,
  };
}

const prefOut = (p: T6ReminderPreference) => ({ decision: p.decision, scope: p.scope, remindAt: p.remindAt });

/**
 * Décision CENTRALE d'interpellation T6 (pure, testée T6-INT-xx). Appliquée
 * à chaque échéance candidate avant la composition de l'accueil.
 */
export function decideT6Interpellation(input: T6DecisionInput): T6DecisionResult {
  const { candidate: c, today, thresholdDays, aiCapable } = input;
  const due = c.dueDate;
  const jours = due ? daysBetween(today, due) : null;
  const r = (b: Parameters<typeof result>[1]) => result(c, b, jours);

  // 1. Sujet résolu, supprimé ou obsolète : jamais d'interpellation.
  if (c.state !== 'ACTIVE') {
    return r({ decision: 'SUPPRESS', code: 'SUBJECT_CLOSED', explanation: 'Échéance réalisée, annulée ou devenue sans objet : aucune interpellation.' });
  }
  // 1 bis. Lot 72A (ATP-FIX-17) : « À traiter » illisible — une échéance qu'il
  //    porte ou a réglée ne peut être exclue avec certitude : aucune relance.
  if (input.toProcessUnavailable) {
    return r({
      decision: 'DEFER', code: 'TO_PROCESS_UNAVAILABLE', deferredBy: 'SYSTEM', nextReevaluationAt: today,
      explanation: '« À traiter » illisible (panne) : l’échéance n’est pas relancée tant qu’une action ou une décision « À traiter » ne peut être vérifiée.',
    });
  }

  // 2. Refus explicite de l'utilisateur (occurrence ou série) : durable,
  //    jamais annulé par une nouvelle exécution.
  const refusOcc = input.preferences.find((p) => p.decision === 'DISMISSED' && p.scope === 'OCCURRENCE');
  const refusSerie = input.preferences.find((p) => p.decision === 'DISMISSED' && p.scope === 'SERIES');
  if (refusOcc || refusSerie) {
    const p = (refusOcc ?? refusSerie)!;
    return r({
      decision: 'SUPPRESS', code: refusOcc ? 'USER_DISMISSED_OCCURRENCE' : 'USER_DISMISSED_SERIES',
      explanation: refusOcc
        ? 'L’utilisateur a demandé à ne plus être rappelé pour cette échéance (elle reste dans l’agenda).'
        : 'L’utilisateur a demandé à ne plus être rappelé pour les échéances de cette série (elles restent dans l’agenda).',
      userPreference: prefOut(p),
    });
  }

  const fraicheur = assessmentFreshness(input.assessment, c, today, thresholdDays, { reminderCapable: input.reminderCapable, evaluation: input.evaluationConfig });
  const status = fraicheur.status;
  const a = status === 'FRESH' || status === 'AGED' ? input.assessment : null;
  const fresh = status === 'FRESH';
  const veutEvaluation = aiCapable && status !== 'FRESH';
  const motifEval = veutEvaluation ? fraicheur.reason : null;

  // 2 bis. Lot 71G (T6-06) : préférences illisibles — un refus ou un report
  //    ne peut être vérifié : rien n'est réintroduit (indisponibilité
  //    technique, distincte d'une conclusion SUPPRESS). L'évaluation du
  //    compte reste possible (elle ne dépend d'aucune préférence).
  if (input.preferencesUnavailable) {
    return r({
      decision: 'DEFER', code: 'PREFERENCES_UNAVAILABLE', deferredBy: 'SYSTEM', nextReevaluationAt: today,
      explanation: 'Préférences de rappel illisibles (panne) : le sujet n’est pas présenté tant qu’un refus ou un report ne peut être vérifié.',
      needsAssessment: veutEvaluation, reevaluationReason: motifEval, aiDecision: a?.decision ?? null,
    });
  }

  // 3. Report de l'utilisateur.
  const report = input.preferences
    .filter((p) => p.decision === 'SNOOZED' && p.remindAt)
    .sort((x, y) => (y.remindAt ?? '').localeCompare(x.remindAt ?? ''))[0];
  if (report && today < report.remindAt!) {
    // Élément nouveau ET significatif (empreinte changée depuis le report),
    // jugé prioritaire par une évaluation IA du NOUVEAU contexte : rappel
    // anticipé, explicable et tracé.
    const change = report.contextFingerprint != null && !c.fingerprintUnavailable && !sameT6Context(report.contextFingerprint, c);
    if (change && a && fresh && a.interpellation === 'ACT_NOW' && a.priority === 'HIGH') {
      return r({
        decision: 'SHOW_NOW', code: 'SNOOZE_OVERRIDDEN_SIGNIFICANT_CHANGE',
        explanation: 'Rappel anticipé : l’échéance a changé depuis le report et l’évaluation du nouveau contexte demande une action prioritaire.',
        priority: 'HIGH', mode: 'ACT_NOW', action: a.action, actionDate: a.actionDate, userPreference: prefOut(report), assessmentFresh: true,
        aiDecision: 'SHOW_NOW',
      });
    }
    return r({
      decision: 'DEFER', code: 'USER_SNOOZED', deferredBy: 'USER', nextReevaluationAt: report.remindAt,
      explanation: 'Rappel reporté par l’utilisateur : masqué jusqu’à la date choisie, puis réévalué avant tout affichage.',
      userPreference: prefOut(report), needsAssessment: change && veutEvaluation, aiDecision: a?.decision ?? null,
      reevaluationReason: change && veutEvaluation ? motifEval : null,
    });
  }
  // Report échu : le sujet est RÉÉVALUÉ avant d'être réaffiché — une
  // évaluation antérieure à la date de rappel ne suffit pas.
  if (report && aiCapable && !(a && fresh && a.assessedOn >= report.remindAt!)) {
    return r({
      decision: 'DEFER', code: 'AWAITING_REEVALUATION_AFTER_SNOOZE', deferredBy: 'SYSTEM', nextReevaluationAt: today,
      explanation: 'La date de rappel est atteinte : le sujet est réévalué avant d’être éventuellement réaffiché.',
      userPreference: prefOut(report), needsAssessment: true, reevaluationReason: 'SNOOZE_DUE',
    });
  }
  const userPreference = report ? prefOut(report) : null;
  const auDela = jours != null && jours > thresholdDays;

  // 4. Sans IA : dégradation prudente (lot 61). Aucune échéance non évaluée
  //    n'est réintroduite ; seule l'action métier établie (échéance dépassée
  //    « à préciser », T4) reste présentée.
  if (!aiCapable) {
    if (auDela) {
      return r({
        decision: 'SUPPRESS', code: 'NO_AI_BEYOND_THRESHOLD', thresholdApplied: true, userPreference,
        nextReevaluationAt: due ? addDays(due, -thresholdDays) : null,
        explanation: `Échéance au-delà du seuil de ${thresholdDays} jours et évaluation IA indisponible : aucune interpellation.`,
      });
    }
    if (jours == null) {
      return r({ decision: 'SUPPRESS', code: 'INSUFFICIENT_CONTEXT', userPreference, explanation: 'Échéance sans date et évaluation IA indisponible : aucun délai n’est supposé.' });
    }
    if (jours <= 0 && c.requiresQualification) {
      return r({
        decision: 'SHOW_NOW', code: 'NO_AI_QUALIFICATION_REQUIRED', mode: 'LEGACY', userPreference,
        explanation: 'Échéance dépassée à préciser (action établie par l’agenda) : présentée sans évaluation IA.',
      });
    }
    return r({
      decision: 'DEFER', code: 'EVALUATION_UNAVAILABLE', deferredBy: 'SYSTEM', userPreference, nextReevaluationAt: today,
      explanation: 'Évaluation IA indisponible : l’échéance n’est pas présentée d’office (elle reste dans l’agenda) ; l’accueil le signale.',
    });
  }

  // 5. Pas encore d'évaluation utilisable : rien n'est affiché d'office.
  if (!a) {
    return r({
      decision: 'DEFER', code: 'AI_ASSESSMENT_PENDING', deferredBy: 'SYSTEM', nextReevaluationAt: today, userPreference, needsAssessment: true,
      thresholdApplied: auDela, reevaluationReason: fraicheur.reason ?? 'FIRST_ASSESSMENT',
      explanation: auDela
        ? `Échéance au-delà du seuil de ${thresholdDays} jours : aucune interpellation sans évaluation motivée.`
        : 'Évaluation IA en attente : aucun affichage automatique avant qu’elle ait jugé l’action nécessaire.',
    });
  }

  const base = {
    userPreference, needsAssessment: veutEvaluation, reevaluationReason: motifEval, assessmentFresh: fresh, actionDate: a.actionDate, action: a.action,
    aiDecision: a.decision ?? (a.interpellation === 'NONE' ? 'SUPPRESS' as const : a.interpellation === 'LATER' ? 'DEFER' as const : 'SHOW_NOW' as const),
  };

  // 6. L'IA conclut qu'aucune interpellation n'est nécessaire. Lot 68 : un
  //    rappel informatif VALIDÉ (INFORM) n'a pas d'action, mais n'est pas
  //    supprimé pour autant — son utilité a été explicitement évaluée.
  const informe = a.interpellation === 'INFORM';
  if (a.interpellation === 'NONE' || (!a.actionNeeded && !informe)) {
    return r({
      ...base, decision: 'SUPPRESS', code: 'AI_NO_INTERPELLATION', priority: a.priority, thresholdApplied: auDela,
      nextReevaluationAt: minDay(a.reevaluateOn, due && jours! > thresholdDays ? addDays(due, -thresholdDays) : null),
      explanation: 'Évaluation IA : aucune action ni anticipation nécessaire pour le moment — simple information suivie dans l’agenda.',
    });
  }
  if (a.interpellation === 'LATER') {
    const quand = minDay(a.reevaluateOn, a.actionDate && a.actionDate > today ? a.actionDate : null) ?? addDays(today, 7);
    return r({
      ...base, decision: 'DEFER', code: 'AI_LATER', deferredBy: 'SYSTEM', priority: a.priority, nextReevaluationAt: quand,
      explanation: 'Évaluation IA : une démarche sera utile, mais solliciter maintenant serait prématuré — réévaluation planifiée.',
    });
  }

  // 7. Aucun délai inventé : ni échéance, ni date pour agir.
  if (!due && !a.actionDate) {
    return r({
      ...base, decision: 'SUPPRESS', code: 'INSUFFICIENT_CONTEXT', priority: 'LOW',
      explanation: 'Ni date d’échéance ni date pour agir : aucun délai n’est supposé.',
    });
  }

  // 8. Seuil indicatif : au-delà, seule une exception MOTIVÉE par une raison
  //    concrète et une date d'action dans le seuil justifie d'interpeller.
  let exception = false;
  if (auDela) {
    const motif = (a.exceptionReason ?? '').trim();
    const agirDansSeuil = !!a.actionDate && daysBetween(today, a.actionDate) <= thresholdDays;
    if (!motif || !agirDansSeuil) {
      return r({
        ...base, decision: 'SUPPRESS', code: 'BEYOND_THRESHOLD', thresholdApplied: true, priority: a.priority,
        nextReevaluationAt: minDay(addDays(due!, -thresholdDays), a.reevaluateOn),
        explanation: `Échéance au-delà du seuil de ${thresholdDays} jours sans démarche motivée à engager avant : aucune interpellation par défaut.`,
      });
    }
    // Lot 75E (C) : l'exception exige une preuve CONCRÈTE réellement
    // disponible (clause extraite établie, description) — jamais le seul
    // intitulé d'un document, ni un fait incertain, ni une preuve disparue.
    if (input.exceptionGrounded === false) {
      return r({
        ...base, decision: 'SUPPRESS', code: 'THRESHOLD_EXCEPTION_UNPROVEN', thresholdApplied: true, priority: a.priority,
        nextReevaluationAt: minDay(addDays(due!, -thresholdDays), a.reevaluateOn),
        explanation: `Exception au seuil de ${thresholdDays} jours non retenue : aucune preuve établie et disponible (clause extraite, description) ne la fonde — un intitulé de document ou un fait incertain ne suffit pas.`,
      });
    }
    exception = true;
  }

  // 9. Anti-répétition : même contexte, déjà présenté plusieurs jours
  //    récemment, priorité non haute → pause.
  const vus = input.history?.displayedDays ?? 0;
  if (a.priority !== 'HIGH' && vus >= T6_REPEAT_MAX_DAYS) {
    return r({
      ...base, decision: 'DEFER', code: 'REPEAT_COOLDOWN', deferredBy: 'SYSTEM', priority: a.priority,
      nextReevaluationAt: addDays(today, T6_REPEAT_COOLDOWN_DAYS), thresholdException: exception,
      explanation: `Sujet déjà présenté ${vus} jours récemment sans évolution : pause de ${T6_REPEAT_COOLDOWN_DAYS} jours pour éviter la répétition.`,
    });
  }

  // Lot 68 : rappel informatif — jamais ACT_NOW par défaut, aucune action.
  if (informe) {
    return r({
      ...base, decision: 'SHOW_NOW', code: 'AI_INFORM', priority: a.priority, mode: 'INFORM', action: null, actionDate: null,
      nextReevaluationAt: a.reevaluateOn,
      explanation: 'Évaluation IA : rappel informatif utile maintenant, sans action attendue (ne compte pas comme une action prioritaire).',
    });
  }

  const anticipe = a.interpellation === 'ANTICIPATE';
  return r({
    ...base, decision: 'SHOW_NOW', code: exception ? 'THRESHOLD_EXCEPTION' : anticipe ? 'AI_ANTICIPATE' : 'AI_ACT_NOW',
    priority: a.priority, mode: anticipe ? 'ANTICIPATE' : 'ACT_NOW', thresholdException: exception,
    nextReevaluationAt: a.reevaluateOn,
    explanation: exception
      ? `Exception au seuil de ${thresholdDays} jours motivée par l’évaluation IA : une démarche doit être engagée avant.`
      : anticipe
        ? 'Évaluation IA : une préparation dès maintenant est utile.'
        : 'Évaluation IA : une action ou une décision est nécessaire à court terme.',
  });
}

/**
 * Ordre d'affichage des sujets retenus (pure) : les actions avant les rappels
 * informatifs (lot 68 : une action établie garde sa priorité), puis priorité,
 * puis date.
 */
export function compareShown(a: T6DecisionResult & { dueDate: string | null }, b: T6DecisionResult & { dueDate: string | null }): number {
  const rang = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
  const info = (x: T6DecisionResult) => (x.mode === 'INFORM' ? 1 : 0);
  return info(a) - info(b) || rang[a.priority] - rang[b.priority] || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.subjectKey.localeCompare(b.subjectKey);
}

/**
 * Date de rappel PROPOSÉE pour « Me le rappeler plus tard » (pure) : date
 * pour agir donnée par l'IA si elle est à venir, sinon une semaine avant
 * l'échéance (au plus tard dans un mois), sinon dans une semaine. Toujours
 * entre demain et un an.
 */
export function suggestReminderDate(p: { today: string; dueDate: string | null; assessment?: Pick<T6Assessment, 'actionDate' | 'reevaluateOn'> | null }): string {
  const demain = addDays(p.today, 1);
  const borne = (d: string) => (d < demain ? demain : d > addDays(p.today, 365) ? addDays(p.today, 365) : d);
  const ia = [p.assessment?.actionDate, p.assessment?.reevaluateOn].filter((d): d is string => !!d && d > p.today).sort()[0];
  if (ia) return borne(ia);
  if (p.dueDate && p.dueDate > p.today) {
    const avant = addDays(p.dueDate, -7);
    return borne(avant > addDays(p.today, 30) ? addDays(p.today, 30) : avant);
  }
  return borne(addDays(p.today, 7));
}

// ── Contexte transmis à EVALUATE et conservation des décisions (lot 61) ─────

export interface T6CandidateRef {
  subjectKey: string; agendaItemId: number; fingerprint: string; daysUntilDue: number | null;
  /** Lot 71G : motif de la réévaluation (reporting, `reevaluation_reason`). */
  reevaluationReason?: T6ReevaluationReason | null;
  /** Lot 71G : référence → version de la preuve transmise (document, extraction, fait). */
  evidenceVersions?: ReadonlyMap<string, T6EvidenceVersion>;
}

/** Lot 71G : version d'une preuve transmise à EVALUATE (aucun texte : références seules). */
export interface T6EvidenceVersion {
  ref: string; kind: string; fileId?: number; extractionId?: number; factId?: number; factKey?: string; provenance?: string;
  /** Lot 75E (C) : statut du fait transmis (PROVEN, DEDUCED, UNCERTAIN). */
  status?: 'PROVEN' | 'DEDUCED' | 'UNCERTAIN';
}

/**
 * Lot 75E (C) — preuve CONCRÈTE (pure) : description de l'échéance, ou fait
 * documentaire extrait dont le statut n'est pas incertain. Un intitulé de
 * document (`Cn.docN`), le titre, la date, le bien, la série ou l'historique
 * n'établissent JAMAIS une obligation. Version inconnue d'un fait : non
 * concrète (rien n'est présumé établi).
 */
export function isConcreteEvidence(ref: string, versions?: ReadonlyMap<string, T6EvidenceVersion>): boolean {
  if (/\.description$/.test(ref)) return true;
  if (!/\.fact\d+$/.test(ref)) return false;
  if (!versions) return true; // appelants antérieurs (sans versions) : règle du lot 71G
  const v = versions.get(ref);
  return !!v && v.kind === 'DOCUMENT_FACT' && (v.status === 'PROVEN' || v.status === 'DEDUCED');
}

/**
 * Lot 75E (C) — une évaluation CONSERVÉE peut-elle fonder une exception au
 * seuil avec les preuves RÉELLEMENT disponibles aujourd'hui (pure) ? Une des
 * preuves citées doit être : la description, encore renseignée ; ou un fait
 * de l'instantané (`evidence_snapshot`) encore présent (même fait, ou même
 * clé du même document après réextraction) et établi (certain ou probable).
 * Intitulé de document seul, fait incertain, fait disparu, instantané
 * absent : non.
 */
export function exceptionEvidenceGrounded(
  a: Pick<T6StoredAssessment, 'evidenceRefs' | 'evidenceSnapshot'>,
  current: { description: string | null; facts: ReadonlyArray<{ id: number; fileId: number; key: string; canonicalKey: string | null; confidence: string | null }> },
): boolean {
  const refs = a.evidenceRefs ?? [];
  const snap = new Map((a.evidenceSnapshot?.refs ?? []).map((v) => [v.ref, v]));
  return refs.some((ref) => {
    if (/\.description$/.test(ref)) return !!(current.description ?? '').trim();
    if (!/\.fact\d+$/.test(ref)) return false;
    const v = snap.get(ref);
    if (!v || v.kind !== 'DOCUMENT_FACT' || v.status === 'UNCERTAIN') return false;
    const f = current.facts.find((x) => (v.factId != null && x.id === v.factId)
      || (v.fileId != null && x.fileId === v.fileId && v.factKey != null && (x.canonicalKey ?? x.key) === v.factKey));
    return !!f && (f.confidence === 'certain' || f.confidence === 'probable');
  });
}

/**
 * Lot 71G — instantané des preuves CITÉES par une décision (pure) :
 * référence, nature et version (document, extraction, fait) — conservé avec
 * l'évaluation (`evidence_snapshot`) et l'empreinte du contexte.
 */
export function evidenceSnapshotOf(cited: readonly string[], versions: ReadonlyMap<string, T6EvidenceVersion> | undefined, fingerprint: string): {
  version: 1; fingerprint: string; refs: T6EvidenceVersion[];
} {
  const refs = cited.map((r) => versions?.get(r) ?? { ref: r, kind: 'UNKNOWN' });
  return { version: 1, fingerprint, refs };
}

/**
 * Candidats à évaluer : contrat d'entrée `t6-evaluation-input-v1`
 * (`t6-contract.ts`) ; la correspondance `subjectId` (C1…Cn) → échéance
 * reste côté serveur.
 */
export interface T6InterpellationBundle {
  context: import('./t6-contract').T6EvaluationInput;
  refs: ReadonlyMap<string, T6CandidateRef>;
  /**
   * Persistance des décisions validées (injectée : base, tests). Lot 72A :
   * rend le détail (`T6PersistResult`) — un nombre reste admis (appelants
   * antérieurs). Lève si l'écriture échoue : RIEN n'est alors conservé
   * (transaction du lot accepté).
   */
  persist: (list: import('./t6-contract').T6ValidatedDecision[], meta: { promptVersion: string; traceId: string | null; contractRevision?: number }) => Promise<number | T6PersistResult>;
}

/** Lot 72A (AC05) : issue d'une persistance — décisions réellement enregistrées. */
export interface T6PersistResult {
  persisted: number;
  /** `subjectId` (C1…Cn) effectivement enregistrés ; absent : inconnu (nombre seul). */
  persistedSubjectIds?: string[];
}

const PRIORITE_DEFAUT: Record<T6Decision, T6Priority> = { SHOW_NOW: 'MEDIUM', DEFER: 'LOW', SUPPRESS: 'LOW' };

/**
 * Décision validée (`t6-evaluation-v1`) → évaluation conservée (pure,
 * testée). Les champs historiques en sont DÉRIVÉS, sans rien ajouter :
 *   · `interpellation` : SHOW_NOW + ACTION_NOW → ACT_NOW, SHOW_NOW +
 *     TO_ANTICIPATE → ANTICIPATE, DEFER → LATER, SUPPRESS → NONE ;
 *   · `exceptionReason` (franchissement du seuil) : la justification, SEULEMENT
 *     si une preuve CONCRÈTE est citée (description ou document) — jamais le
 *     titre ou la date seuls ;
 *   · `priority` : la priorité INDICATIVE de l'IA, à défaut selon la décision.
 * `suggestedReviewAt` ne devient qu'une date de RÉÉVALUATION système, jamais
 * un rappel utilisateur (aucune préférence n'est écrite).
 */
export function assessmentFromDecision(
  d: import('./t6-contract').T6ValidatedDecision,
  /** Lot 75E (C) : versions des preuves transmises (statut des faits) — absentes : règle du lot 71G sans les intitulés de document. */
  versions?: ReadonlyMap<string, T6EvidenceVersion>,
): T6Assessment {
  // Lot 68 : SHOW_NOW + INFORMATION (validé : motif dédié, sans action) → INFORM.
  const informe = d.decision === 'SHOW_NOW' && d.category === 'INFORMATION';
  const interpellation: T6AiInterpellation = d.decision === 'SUPPRESS' ? 'NONE'
    : d.decision === 'DEFER' ? 'LATER'
      : informe ? 'INFORM'
        : d.category === 'TO_ANTICIPATE' ? 'ANTICIPATE' : 'ACT_NOW';
  // Lot 71G (T6-04) : un fait documentaire extrait (`Cn.factN`) est une preuve concrète.
  // Lot 75E (C) : l'intitulé d'un document (`Cn.docN`) ne l'est plus ; un fait INCERTAIN non plus.
  const concrete = d.evidenceRefs.some((r) => isConcreteEvidence(r, versions));
  return {
    decision: d.decision, category: d.category, reasonCode: d.reasonCode, evidenceRefs: d.evidenceRefs, uncertainties: d.uncertainties,
    interpellation,
    // DEFER : une démarche sera utile plus tard (réévaluée), jamais « rien à faire ».
    // INFORM : aucune action attendue (le rappel n'est pas une action prioritaire).
    actionNeeded: d.decision !== 'SUPPRESS' && !informe,
    action: informe ? null : d.expectedAction, reason: d.reason, consequence: null,
    actionDate: informe ? null : d.actionDeadline, priority: d.priorityHint ?? (informe ? 'LOW' : PRIORITE_DEFAUT[d.decision]),
    uncertainty: d.uncertainties.length ? d.uncertainties.join(' ; ').slice(0, 400) : null,
    // Un rappel informatif ne franchit jamais le seuil (aucune démarche à engager avant).
    exceptionReason: d.decision === 'SHOW_NOW' && !informe && concrete ? d.reason : null,
    reevaluateOn: d.suggestedReviewAt,
  };
}

const texte = (v: unknown, max = 400): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

const plainA = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’]/g, "'");
/** Verbes de préparation GÉNÉRIQUES : seuls, ils n'apportent aucune information. */
const VERBES_GENERIQUES = new Set(['preparer', 'prevoir', 'anticiper', 'penser', 'noter', 'retenir', 'suivre', 'organiser', 'planifier', 'surveiller', 'garder', 'tete', 'esprit', 'occuper', 'gerer', 'rappeler']);
const MOTS_VIDES = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'et', 'en', 'pour', 'au', 'aux', 'a', 'un', 'une', 'votre', 'vos', 'son', 'sa', 'ses', 'ce', 'cet', 'cette', 'se', 'sur', 'avant', 'date', 'echeance', 'prochain', 'prochaine', 'bien']);

/**
 * Lot 68 — l'action attendue apporte-t-elle une information DISTINCTE du
 * sujet (pure, testée T6-RAP) ? « Préparer la visite expert bois pour la
 * maison » (verbe générique + objet + bien déjà dits) : non. « Prendre
 * rendez-vous pour le ramonage », « Envoyer la demande de résiliation » : oui.
 */
export function actionIsDistinct(action: string | null, subject: { title?: string | null; assetName?: string | null; dateLabel?: string | null }): boolean {
  const t = texte(action, 160);
  if (!t) return false;
  const dejaDits = new Set(plainA(`${subject.title ?? ''} ${subject.assetName ?? ''} ${subject.dateLabel ?? ''}`).split(/[^a-z0-9]+/).filter(Boolean));
  const mots = plainA(t).split(/[^a-z0-9]+/).filter((w) => w && !MOTS_VIDES.has(w));
  return mots.some((w) => !VERBES_GENERIQUES.has(w) && !dejaDits.has(w) && !(w.length > 4 && [...dejaDits].some((d) => d.length > 4 && (d.startsWith(w.slice(0, 5)) || w.startsWith(d.slice(0, 5))))));
}

/**
 * Démarche IA présentable dans un texte déterministe (une ligne, sans emoji).
 * Lot 68 : plus de préfixe « À prévoir : » concaténé — une phrase à
 * l'infinitif, avec sa majuscule (« Prendre rendez-vous pour le ramonage. »).
 * L'appelant ne l'ajoute que si elle apporte une information distincte
 * (`actionIsDistinct`).
 */
export function actionSentence(action: string | null): string | null {
  const t = texte(action, 160);
  if (!t || /\p{Extended_Pictographic}/u.test(t)) return null;
  const s = t.replace(/^(?:à|a)\s+pr[ée]voir\s*:\s*/i, '').replace(/[.!?…]+$/, '');
  if (!s) return null;
  return `${s.charAt(0).toLocaleUpperCase('fr')}${s.slice(1)}.`;
}
