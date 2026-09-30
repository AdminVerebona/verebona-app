/**
 * Contrat du prompt maître T4 — CDC 15 §26, §22.2, T4-10, T4-12 à T4-14.
 *
 * Une seule consigne (`t4_master_v1`), trois branches imposées par le serveur :
 *   - `CLASSIFY_EVENT`     : action / information / unknown (+ type métier) ;
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
export type T4Task = (typeof T4_TASKS)[number];

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

// ── VERIFY_COMPLETION ───────────────────────────────────────────────────────
export const T4_EVIDENCE_STATUSES = ['proves_completed', 'proves_not_completed', 'insufficient', 'conflictual'] as const;
export const T4_OCCURRENCE_MATCHES = ['exact', 'probable', 'ambiguous', 'none'] as const;

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

/** U6 : type métier hors catalogue fourni ⇒ ignoré (null), avec avertissement. */
export function closedWorldBusinessType(
  out: T4ClassifyEventOutput, allowed: ReadonlySet<string>,
): { output: T4ClassifyEventOutput; warning: string | null } {
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
