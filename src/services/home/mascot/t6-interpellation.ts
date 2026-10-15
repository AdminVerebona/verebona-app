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
 *   · L'IA (T6, R13 du prompt maître, `{{INTERPELLATION_CONTEXT}}`) évalue
 *     chaque candidat : action réellement nécessaire, nature, pourquoi
 *     maintenant, conséquence, date pertinente pour agir, priorité,
 *     incertitudes — ou « aucune interpellation nécessaire ». Aucune règle
 *     par catégorie d'échéance (assurance, garantie, entretien…) n'existe ici.
 *   · Le code applique le DÉTERMINISTE : sujet clos, refus et reports de
 *     l'utilisateur, seuil indicatif (60 jours, réglable dans le BO) avec
 *     exception MOTIVÉE par l'IA, réévaluation après un report, anti-
 *     répétition, aucun délai inventé, trace de chaque décision.
 *
 * DÉGRADATION PRUDENTE (`aiCapable = false` : T6 coupé dans le BO, ou version
 * active du prompt antérieure au lot 60, sans `{{INTERPELLATION_CONTEXT}}`) :
 * jamais d'interpellation au-delà du seuil ; en deçà, le comportement
 * historique (échéance proche, échéance arrivée à date) est conservé.
 * ══════════════════════════════════════════════════════════════════════════
 */

// ── Contrat ─────────────────────────────────────────────────────────────────

export type T6Decision = 'SHOW_NOW' | 'DEFER' | 'SUPPRESS';
/** Conclusion de l'IA : à traiter maintenant, à anticiper, plus tard, aucune. */
export type T6AiInterpellation = 'ACT_NOW' | 'ANTICIPATE' | 'LATER' | 'NONE';
export type T6Priority = 'HIGH' | 'MEDIUM' | 'LOW';
export const T6_AI_INTERPELLATIONS: readonly T6AiInterpellation[] = ['ACT_NOW', 'ANTICIPATE', 'LATER', 'NONE'];
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
  | 'NO_AI_WITHIN_THRESHOLD'
  | 'NO_AI_OVERDUE'
  | 'AI_NO_INTERPELLATION'
  | 'AI_LATER'
  | 'BEYOND_THRESHOLD'
  | 'THRESHOLD_EXCEPTION'
  | 'INSUFFICIENT_CONTEXT'
  | 'REPEAT_COOLDOWN'
  | 'AI_ACT_NOW'
  | 'AI_ANTICIPATE';

/** Évaluation structurée rendue par l'IA pour UN candidat (validée). */
export interface T6Assessment {
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
}

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
  /** Empreinte des champs significatifs (titre, date, nature, qualification). */
  fingerprint: string;
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
}

export interface T6DecisionInput {
  candidate: T6Candidate;
  /** AAAA-MM-JJ (Europe/Paris). */
  today: string;
  thresholdDays: number;
  /** T6 disponible ET prompt actif porteur de `{{INTERPELLATION_CONTEXT}}`. */
  aiCapable: boolean;
  assessment: T6StoredAssessment | null;
  /** Préférences de l'utilisateur courant applicables au candidat (occurrence + série). */
  preferences: T6ReminderPreference[];
  /** Historique des interpellations : jours distincts d'affichage récents (même contexte). */
  history?: { displayedDays: number } | null;
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
  /** Mode d'interpellation retenu (SHOW_NOW seulement). */
  mode: 'ACT_NOW' | 'ANTICIPATE' | 'LEGACY' | null;
  /** Démarche attendue (IA), pour la formulation. */
  action: string | null;
  actionDate: string | null;
  /** L'évaluation utilisée était encore valable (même contexte, pas échue). */
  assessmentFresh: boolean;
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

/** Horizon des candidats soumis à l'IA : trois fois le seuil, 180 jours au moins. */
export function assessmentHorizonDays(thresholdDays: number): number {
  return Math.max(T6_ASSESSMENT_MIN_HORIZON_DAYS, thresholdDays * 3);
}

// ── Dates ───────────────────────────────────────────────────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (v: unknown): v is string => typeof v === 'string' && DAY_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

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

// ── Fraîcheur d'une évaluation ──────────────────────────────────────────────

export type T6AssessmentStatus = 'FRESH' | 'AGED' | 'CONTEXT_CHANGED' | 'NONE';

/**
 * Une évaluation est :
 *   · `CONTEXT_CHANGED` (inutilisable) si le candidat a changé de façon
 *     significative, si l'échéance a franchi le seuil ou est passée depuis ;
 *   · `AGED` (utilisable, à revoir) si elle date de plus de 14 jours ou si
 *     la date de réévaluation proposée par l'IA est atteinte ;
 *   · `FRESH` sinon.
 */
export function assessmentStatus(a: T6StoredAssessment | null, c: T6Candidate, today: string, thresholdDays: number): T6AssessmentStatus {
  if (!a) return 'NONE';
  if (a.fingerprint !== c.fingerprint) return 'CONTEXT_CHANGED';
  if (c.dueDate) {
    const avant = daysBetween(a.assessedOn, c.dueDate);
    const maintenant = daysBetween(today, c.dueDate);
    if (avant > thresholdDays && maintenant <= thresholdDays) return 'CONTEXT_CHANGED';
    if (avant > 0 && maintenant <= 0) return 'CONTEXT_CHANGED';
  }
  if (daysBetween(a.assessedOn, today) > T6_ASSESSMENT_MAX_AGE_DAYS) return 'AGED';
  if (a.reevaluateOn && today >= a.reevaluateOn) return 'AGED';
  return 'FRESH';
}

// ── Décision ────────────────────────────────────────────────────────────────

const PRIORITY_DEFAULT: T6Priority = 'MEDIUM';

function result(c: T6Candidate, base: Partial<T6DecisionResult> & Pick<T6DecisionResult, 'decision' | 'code' | 'explanation'>, daysUntilDue: number | null): T6DecisionResult {
  return {
    nextReevaluationAt: null, priority: PRIORITY_DEFAULT, deferredBy: null, thresholdApplied: false, thresholdException: false,
    userPreference: null, needsAssessment: false, mode: null, action: null, actionDate: null, assessmentFresh: false,
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

  const status = assessmentStatus(input.assessment, c, today, thresholdDays);
  const a = status === 'FRESH' || status === 'AGED' ? input.assessment : null;
  const fresh = status === 'FRESH';
  const veutEvaluation = aiCapable && status !== 'FRESH';

  // 3. Report de l'utilisateur.
  const report = input.preferences
    .filter((p) => p.decision === 'SNOOZED' && p.remindAt)
    .sort((x, y) => (y.remindAt ?? '').localeCompare(x.remindAt ?? ''))[0];
  if (report && today < report.remindAt!) {
    // Élément nouveau ET significatif (empreinte changée depuis le report),
    // jugé prioritaire par une évaluation IA du NOUVEAU contexte : rappel
    // anticipé, explicable et tracé.
    const change = report.contextFingerprint != null && report.contextFingerprint !== c.fingerprint;
    if (change && a && fresh && a.interpellation === 'ACT_NOW' && a.priority === 'HIGH') {
      return r({
        decision: 'SHOW_NOW', code: 'SNOOZE_OVERRIDDEN_SIGNIFICANT_CHANGE',
        explanation: 'Rappel anticipé : l’échéance a changé depuis le report et l’évaluation du nouveau contexte demande une action prioritaire.',
        priority: 'HIGH', mode: 'ACT_NOW', action: a.action, actionDate: a.actionDate, userPreference: prefOut(report), assessmentFresh: true,
      });
    }
    return r({
      decision: 'DEFER', code: 'USER_SNOOZED', deferredBy: 'USER', nextReevaluationAt: report.remindAt,
      explanation: 'Rappel reporté par l’utilisateur : masqué jusqu’à la date choisie, puis réévalué avant tout affichage.',
      userPreference: prefOut(report), needsAssessment: change && veutEvaluation,
    });
  }
  // Report échu : le sujet est RÉÉVALUÉ avant d'être réaffiché — une
  // évaluation antérieure à la date de rappel ne suffit pas.
  if (report && aiCapable && !(a && fresh && a.assessedOn >= report.remindAt!)) {
    return r({
      decision: 'DEFER', code: 'AWAITING_REEVALUATION_AFTER_SNOOZE', deferredBy: 'SYSTEM', nextReevaluationAt: today,
      explanation: 'La date de rappel est atteinte : le sujet est réévalué avant d’être éventuellement réaffiché.',
      userPreference: prefOut(report), needsAssessment: true,
    });
  }
  const userPreference = report ? prefOut(report) : null;
  const auDela = jours != null && jours > thresholdDays;

  // 4. Sans IA : dégradation prudente.
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
    return r({
      decision: 'SHOW_NOW', code: jours <= 0 ? 'NO_AI_OVERDUE' : 'NO_AI_WITHIN_THRESHOLD', mode: 'LEGACY', userPreference,
      explanation: jours <= 0
        ? 'Échéance arrivée à date, évaluation IA indisponible : rappel historique conservé (à confirmer).'
        : `Échéance dans le seuil de ${thresholdDays} jours, évaluation IA indisponible : rappel historique conservé.`,
    });
  }

  // 5. Pas encore d'évaluation utilisable : rien n'est affiché d'office.
  if (!a) {
    return r({
      decision: 'DEFER', code: 'AI_ASSESSMENT_PENDING', deferredBy: 'SYSTEM', nextReevaluationAt: today, userPreference, needsAssessment: true,
      thresholdApplied: auDela,
      explanation: auDela
        ? `Échéance au-delà du seuil de ${thresholdDays} jours : aucune interpellation sans évaluation motivée.`
        : 'Évaluation IA en attente : aucun affichage automatique avant qu’elle ait jugé l’action nécessaire.',
    });
  }

  const base = { userPreference, needsAssessment: veutEvaluation, assessmentFresh: fresh, actionDate: a.actionDate, action: a.action };

  // 6. L'IA conclut qu'aucune interpellation n'est nécessaire.
  if (a.interpellation === 'NONE' || !a.actionNeeded) {
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

/** Ordre d'affichage des sujets retenus : priorité, puis date (pure). */
export function compareShown(a: T6DecisionResult & { dueDate: string | null }, b: T6DecisionResult & { dueDate: string | null }): number {
  const rang = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
  return rang[a.priority] - rang[b.priority] || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.subjectKey.localeCompare(b.subjectKey);
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

// ── Contexte transmis à l'IA (R13) et validation de sa sortie ────────────────

export const T6_INTERPELLATION_CONTEXT_SCHEMA = 't6-interpellation-v1';
const TEXT_MAX = 400;

export interface T6InterpellationCandidateContext {
  /** Référence opaque (C1…Cn) : aucun identifiant de base transmis. */
  ref: string;
  title: string;
  description: string | null;
  assetName: string | null;
  assetCategory: string | null;
  dueDate: string | null;
  dateLabel: string | null;
  daysUntilDue: number | null;
  dateNature: 'confirmée' | 'prévisionnelle';
  dateRole: string | null;
  overdue: boolean;
  requiresQualification: boolean;
  recurring: boolean;
  /** Titres des documents liés (3 au plus). */
  documents: string[];
  /** Jours où ce sujet a déjà été présenté récemment. */
  recentlyShownDays: number;
}

export interface T6InterpellationContext {
  schemaVersion: typeof T6_INTERPELLATION_CONTEXT_SCHEMA;
  today: string;
  thresholdDays: number;
  candidates: T6InterpellationCandidateContext[];
}

/** Contexte complet : la correspondance référence → candidat reste côté serveur. */
export interface T6InterpellationBundle {
  context: T6InterpellationContext;
  refs: ReadonlyMap<string, { subjectKey: string; agendaItemId: number; fingerprint: string }>;
  /** Persistance des évaluations validées (injectée : base, tests). */
  persist: (list: Array<T6Assessment & { ref: string }>, meta: { promptVersion: string; traceId: string | null }) => Promise<number>;
}

const texte = (v: unknown, max = TEXT_MAX): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};
const enumOf = <T extends string>(v: unknown, list: readonly T[]): T | null =>
  typeof v === 'string' && (list as readonly string[]).includes(v.trim().toUpperCase()) ? (v.trim().toUpperCase() as T) : null;

/**
 * Validation STRUCTURELLE des évaluations rendues par T6 (pure, testée) : un
 * élément douteux est abandonné (le candidat reste « en attente »), jamais
 * corrigé. Une date pour agir ou de réévaluation mal formée est ignorée ;
 * une réévaluation dans le passé aussi.
 */
export function validateT6Assessments(raw: unknown, refs: ReadonlySet<string>, today: string): Array<T6Assessment & { ref: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<T6Assessment & { ref: string }> = [];
  const vus = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const ref = typeof o.ref === 'string' ? o.ref.trim() : '';
    if (!refs.has(ref) || vus.has(ref)) continue;
    const interpellation = enumOf(o.interpellation, T6_AI_INTERPELLATIONS);
    const priority = enumOf(o.priority, T6_PRIORITIES) ?? 'MEDIUM';
    const reason = texte(o.reason);
    if (!interpellation || !reason) continue;
    const actionNeeded = typeof o.actionNeeded === 'boolean' ? o.actionNeeded : interpellation !== 'NONE';
    const reevaluateOn = isDay(o.reevaluateOn) && o.reevaluateOn > today ? o.reevaluateOn : null;
    vus.add(ref);
    out.push({
      ref, interpellation, actionNeeded, priority, reason,
      action: texte(o.action, 160), consequence: texte(o.consequence), uncertainty: texte(o.uncertainty),
      exceptionReason: texte(o.exceptionReason),
      actionDate: isDay(o.actionDate) ? o.actionDate : null,
      reevaluateOn,
    });
  }
  return out;
}

/** Le texte master effectif porte-t-il l'emplacement R13 ? `null` : fichier du dépôt. */
export function promptSupportsInterpellation(effectiveText: string | null | undefined): boolean {
  return effectiveText == null || effectiveText.includes('{{INTERPELLATION_CONTEXT}}');
}

/** Démarche IA présentable dans un texte déterministe (une ligne, sans emoji). */
export function actionSentence(action: string | null): string | null {
  const t = texte(action, 160);
  if (!t || /\p{Extended_Pictographic}/u.test(t)) return null;
  const s = t.replace(/[.!?…]+$/, '');
  // Minuscule initiale seulement devant un mot courant (« Comparer »), jamais un sigle (« EDF »).
  const debut = /^[A-ZÀ-Ý][a-zà-ÿ]/.test(s) ? s.charAt(0).toLocaleLowerCase('fr') + s.slice(1) : s;
  return `À prévoir : ${debut}.`;
}
