/**
 * Contrat du prompt maître T4 — CDC 15 §26, §22.2, T4-10, T4-12 à T4-14.
 *
 * Une seule consigne (`t4_master_v1`), trois branches imposées par le serveur :
 *   - `CLASSIFY_EVENT`     : action / information / unknown (+ type métier) ;
 *                            v2 (lot 54) : décision d'existence Agenda et de
 *                            récurrence (`T4ClassifyEventV2Output`) ;
 *   - `VERIFY_COMPLETION`  : ce que la preuve dit de la réalisation d'UNE
 *                            occurrence (quatre états, `insufficient` distinct) ;
 *   - `TEMPORAL_AMBIGUITY` : choisir un candidat temporel fourni ou s'abstenir.
 *
 * Sortie : union discriminée par `task` ; la gateway vérifie la branche.
 * Monde fermé (U1, U6) contrôlé ensuite par le serveur : `businessType` ∈
 * EVENT_CATALOG fourni, `candidateId` ∈ candidats fournis.
 *
 * Ne dépend que de zod.
 */
import { z } from 'zod';

export const T4_MASTER_PROMPT_CODE = 't4_master_v1';
export const T4_TASKS = ['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY'] as const;

const confidence = z.enum(['certain', 'probable', 'ambiguous']);

// ── CLASSIFY_EVENT ──────────────────────────────────────────────────────────
export const T4ClassifyEventOutput = z.object({
  task: z.literal('CLASSIFY_EVENT'),
  /** Type métier de l'EVENT_CATALOG fourni (U6), ou null. */
  businessType: z.string().min(1).max(60).nullable().optional(),
  homeCategory: z.enum(['action', 'information', 'unknown']),
  confidence,
  reason: z.string().min(1).max(300),
}).superRefine((v, ctx) => {
  // C5 : `unknown` ⇔ confiance `ambiguous`.
  if (v.homeCategory === 'unknown' && v.confidence !== 'ambiguous') {
    ctx.addIssue({ code: 'custom', path: ['confidence'], message: 'homeCategory=unknown exige confidence=ambiguous' });
  }
});
export type T4ClassifyEventOutput = z.infer<typeof T4ClassifyEventOutput>;

// ── CLASSIFY_EVENT v2 (lot 54, ticket « T4 décisionnaire ») ─────────────────
// `t4_output_v2` : T4 décide de l'EXISTENCE de l'événement Agenda
// (`agendaDecision`) et de la validité de la RÉCURRENCE envisagée par le
// serveur (`recurrenceDecision`). v1 n'est pas modifié (versions historiques).
export const T4_AGENDA_DECISIONS = ['accept', 'reject', 'abstain'] as const;
export const T4_RECURRENCE_DECISIONS = ['accept', 'reject', 'abstain', 'not_applicable'] as const;
export type T4AgendaDecisionValue = (typeof T4_AGENDA_DECISIONS)[number];
export type T4RecurrenceDecisionValue = (typeof T4_RECURRENCE_DECISIONS)[number];

export const T4ClassifyEventV2Output = z.object({
  task: z.literal('CLASSIFY_EVENT'),
  /** L'événement doit-il exister dans l'Agenda ? */
  agendaDecision: z.enum(T4_AGENDA_DECISIONS),
  /** La récurrence envisagée par le serveur est-elle réellement métier ? */
  recurrenceDecision: z.enum(T4_RECURRENCE_DECISIONS),
  homeCategory: z.enum(['action', 'information', 'unknown']),
  /** Type métier de l'EVENT_CATALOG fourni (U6), ou null. */
  businessType: z.string().min(1).max(60).nullable().optional(),
  confidence,
  reason: z.string().min(1).max(300),
  /** Motif de la décision de récurrence (null sans candidat). */
  recurrenceReason: z.string().min(1).max(300).nullable().optional(),
}).superRefine((v, ctx) => {
  // Invariants du contrat (ticket §2). La cohérence avec l'ENTRÉE réelle
  // (candidat de récurrence présent ou non) est vérifiée par le serveur.
  if (v.agendaDecision === 'accept' && v.homeCategory === 'unknown') {
    ctx.addIssue({ code: 'custom', path: ['homeCategory'], message: 'agendaDecision=accept exige homeCategory=action|information' });
  }
  if (v.agendaDecision !== 'accept' && v.homeCategory !== 'unknown') {
    ctx.addIssue({ code: 'custom', path: ['homeCategory'], message: 'agendaDecision=reject|abstain exige homeCategory=unknown' });
  }
  if (v.agendaDecision !== 'accept' && v.businessType != null) {
    ctx.addIssue({ code: 'custom', path: ['businessType'], message: 'agendaDecision=reject|abstain exige businessType=null' });
  }
  if (v.agendaDecision === 'abstain' && v.confidence !== 'ambiguous') {
    ctx.addIssue({ code: 'custom', path: ['confidence'], message: 'agendaDecision=abstain exige confidence=ambiguous' });
  }
});
export type T4ClassifyEventV2Output = z.infer<typeof T4ClassifyEventV2Output>;

// ── CLASSIFY_EVENT v3 (lot 61, tickets « À traiter » : écarts 58B et pertinence) ─
// `t4_output_v3` = v2 + bloc `intervention`, rempli UNIQUEMENT quand le
// serveur demande l'évaluation d'une intervention « À traiter »
// (`event_context.toProcessAssessment`). T4 y identifie l'intervention
// CONCRÈTE de l'utilisateur (résilier, décider d'une reconduction, payer,
// exécuter une obligation, fournir une information…), sa justification, ses
// preuves, sa conséquence et sa temporalité — jamais une « date à compléter »
// par défaut. Le code CONTRÔLE ensuite la sortie (`checkInterventionCoherence`)
// sans se fier au texte libre. v1 et v2 sont inchangés (versions actives
// antérieures toujours lues : intervention absente).
const T4_INTERVENTION_NEEDS = ['yes', 'no', 'uncertain'] as const;
const T4_INTERVENTION_KINDS = [
  'TERMINATE', 'RENEW_OR_DECIDE', 'PAY', 'PERFORM_OBLIGATION', 'RETURN_OR_RESTITUTE', 'PROVIDE_INFORMATION', 'VERIFY', 'OTHER',
] as const;
const T4_INTERVENTION_TIMINGS = ['NOW', 'LATER', 'NONE'] as const;

export const T4InterventionAssessment = z.object({
  /** Une intervention de l'utilisateur est-elle réellement nécessaire ? */
  needed: z.enum(T4_INTERVENTION_NEEDS),
  /** Nature de l'intervention (liste fermée), null si aucune. */
  kind: z.enum(T4_INTERVENTION_KINDS).nullable(),
  /** Intervention concrète, formulée pour l'utilisateur (≤ 160), null si aucune. */
  action: z.string().min(1).max(160).nullable(),
  /** Pourquoi (ou pourquoi pas) solliciter l'utilisateur. */
  justification: z.string().min(1).max(300),
  /** Conséquence probable de l'absence d'intervention, null si aucune. */
  consequence: z.string().max(300).nullable(),
  /** Passage de la preuve FOURNIE qui fonde la décision, null si aucun. */
  evidence: z.string().max(300).nullable(),
  /** Faut-il intervenir maintenant, plus tard, ou jamais ? */
  timing: z.enum(T4_INTERVENTION_TIMINGS),
  /** Date limite d'action lue dans la preuve (AAAA-MM-JJ), null si aucune. */
  actBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  /** La donnée demandée (ex. date de fin) est-elle nécessaire à un besoin réel ? */
  dataNeeded: z.boolean().nullable(),
}).superRefine((v, ctx) => {
  if (v.needed === 'yes') {
    if (!v.kind) ctx.addIssue({ code: 'custom', path: ['kind'], message: 'needed=yes exige kind' });
    if (!v.action) ctx.addIssue({ code: 'custom', path: ['action'], message: 'needed=yes exige action' });
    if (v.timing === 'NONE') ctx.addIssue({ code: 'custom', path: ['timing'], message: 'needed=yes exige timing=NOW|LATER' });
  }
  if (v.needed === 'no') {
    if (v.kind !== null || v.action !== null) ctx.addIssue({ code: 'custom', path: ['kind'], message: 'needed=no exige kind=null et action=null' });
    if (v.timing !== 'NONE') ctx.addIssue({ code: 'custom', path: ['timing'], message: 'needed=no exige timing=NONE' });
  }
});
export type T4InterventionAssessment = z.infer<typeof T4InterventionAssessment>;

export const T4ClassifyEventV3Output = z.object({
  task: z.literal('CLASSIFY_EVENT'),
  agendaDecision: z.enum(T4_AGENDA_DECISIONS),
  recurrenceDecision: z.enum(T4_RECURRENCE_DECISIONS),
  homeCategory: z.enum(['action', 'information', 'unknown']),
  businessType: z.string().min(1).max(60).nullable().optional(),
  confidence,
  reason: z.string().min(1).max(300),
  recurrenceReason: z.string().min(1).max(300).nullable().optional(),
  /** Lot 61 : évaluation d'une intervention « À traiter » (null hors demande). */
  intervention: T4InterventionAssessment.nullable().optional(),
}).superRefine((v, ctx) => {
  // Mêmes invariants que v2 (la décision Agenda reste celle de v2).
  if (v.agendaDecision === 'accept' && v.homeCategory === 'unknown') {
    ctx.addIssue({ code: 'custom', path: ['homeCategory'], message: 'agendaDecision=accept exige homeCategory=action|information' });
  }
  if (v.agendaDecision !== 'accept' && v.homeCategory !== 'unknown') {
    ctx.addIssue({ code: 'custom', path: ['homeCategory'], message: 'agendaDecision=reject|abstain exige homeCategory=unknown' });
  }
  if (v.agendaDecision !== 'accept' && v.businessType != null) {
    ctx.addIssue({ code: 'custom', path: ['businessType'], message: 'agendaDecision=reject|abstain exige businessType=null' });
  }
  if (v.agendaDecision === 'abstain' && v.confidence !== 'ambiguous') {
    ctx.addIssue({ code: 'custom', path: ['confidence'], message: 'agendaDecision=abstain exige confidence=ambiguous' });
  }
});
export type T4ClassifyEventV3Output = z.infer<typeof T4ClassifyEventV3Output>;

// ── VERIFY_COMPLETION ───────────────────────────────────────────────────────
const T4_EVIDENCE_STATUSES = ['proves_completed', 'proves_not_completed', 'insufficient', 'conflictual'] as const;
const T4_OCCURRENCE_MATCHES = ['exact', 'probable', 'ambiguous', 'none'] as const;

export const T4VerifyCompletionOutput = z.object({
  task: z.literal('VERIFY_COMPLETION'),
  evidenceStatus: z.enum(T4_EVIDENCE_STATUSES),
  occurrenceMatch: z.enum(T4_OCCURRENCE_MATCHES),
  confidence,
  evidence: z.object({
    excerpt: z.string().max(1000).optional(),
    page: z.number().int().positive().optional(),
  }).default({}),
  reason: z.string().min(1).max(300),
});
export type T4VerifyCompletionOutput = z.infer<typeof T4VerifyCompletionOutput>;

// ── TEMPORAL_AMBIGUITY ──────────────────────────────────────────────────────
export const T4TemporalAmbiguityOutput = z.object({
  task: z.literal('TEMPORAL_AMBIGUITY'),
  decision: z.enum(['choose', 'abstain']),
  candidateId: z.number().int().positive().nullable().optional(),
  confidence: z.enum(['probable', 'ambiguous']),
  reason: z.string().min(1).max(300),
}).superRefine((v, ctx) => {
  if (v.decision === 'choose' && (v.candidateId === undefined || v.candidateId === null)) {
    ctx.addIssue({ code: 'custom', path: ['candidateId'], message: 'obligatoire quand decision = choose' });
  }
  if (v.decision === 'abstain' && v.candidateId !== undefined && v.candidateId !== null) {
    ctx.addIssue({ code: 'custom', path: ['candidateId'], message: 'interdit quand decision = abstain' });
  }
});
export type T4TemporalAmbiguityOutput = z.infer<typeof T4TemporalAmbiguityOutput>;

/** Union discriminée par `task` (CDC 15 §22.2). */
export const T4MasterOutput = z.discriminatedUnion('task', [
  T4ClassifyEventOutput, T4VerifyCompletionOutput, T4TemporalAmbiguityOutput,
]);
export type T4MasterOutput = z.infer<typeof T4MasterOutput>;

// ── Monde fermé ─────────────────────────────────────────────────────────────

/** U6 (v1, v2, v3) : type métier hors catalogue fourni ⇒ ignoré (null), avec avertissement. */
export function closedWorldBusinessType<O extends T4ClassifyEventOutput | T4ClassifyEventV2Output | T4ClassifyEventV3Output>(
  out: O, allowed: ReadonlySet<string>,
): { output: O; warning: string | null } {
  const bt = out.businessType ?? null;
  if (bt === null || allowed.has(bt)) return { output: out, warning: null };
  return { output: { ...out, businessType: null }, warning: `UNKNOWN_BUSINESS_TYPE:${bt}` };
}

/** U1 : candidat temporel hors liste ⇒ abstention, avec avertissement. */
export function closedWorldTemporal(
  out: T4TemporalAmbiguityOutput, allowed: ReadonlySet<number>,
): { output: T4TemporalAmbiguityOutput; warning: string | null } {
  if (out.decision !== 'choose' || allowed.has(out.candidateId as number)) return { output: out, warning: null };
  return {
    output: { task: 'TEMPORAL_AMBIGUITY', decision: 'abstain', candidateId: null, confidence: 'ambiguous',
      reason: `candidat ${out.candidateId} hors des candidats fournis — abstention (U1)` },
    warning: `UNKNOWN_CANDIDATE_ID:${out.candidateId}`,
  };
}
