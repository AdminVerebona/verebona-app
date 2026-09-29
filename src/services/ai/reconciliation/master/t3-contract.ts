/**
 * Contrat du prompt maître T3 — CDC 15 §25, §22.2, T3-06, T3-07.
 *
 * Une seule consigne (`t3_master_v1`), deux branches imposées par le serveur :
 *   - `VALUE_CONFLICT` : choisir UNE preuve fournie, ou s'abstenir ;
 *   - `LINK_AMBIGUITY` : scorer des candidats fournis, liste vide possible.
 *
 * Sortie : union discriminée par `task`. La gateway vérifie en plus que la
 * branche renvoyée est la branche demandée (validation discriminée). Le
 * monde fermé (U1) — identifiants appartenant aux preuves / candidats
 * FOURNIS — est contrôlé après validation par `closedWorld*` : un identifiant
 * inconnu vaut abstention, avec un avertissement.
 *
 * Ne dépend que de zod.
 */
import { z } from 'zod';

export const T3_MASTER_PROMPT_CODE = 't3_master_v1';
export const T3_TASKS = ['VALUE_CONFLICT', 'LINK_AMBIGUITY'] as const;
export type T3Task = (typeof T3_TASKS)[number];

const confidence = z.enum(['certain', 'probable', 'conflictual']);
export type T3Confidence = z.infer<typeof confidence>;

// ── Branche VALUE_CONFLICT ──────────────────────────────────────────────────
/**
 * `chosenEvidenceId` obligatoire si `decision = choose`, interdit (absent ou
 * null) si `decision = abstain` (§25, V1).
 */
export const T3ValueConflictOutput = z.object({
  task: z.literal('VALUE_CONFLICT'),
  decision: z.enum(['choose', 'abstain']),
  chosenEvidenceId: z.number().int().positive().nullable().optional(),
  confidence,
  reason: z.string().min(1).max(400),
}).superRefine((v, ctx) => {
  if (v.decision === 'choose' && (v.chosenEvidenceId === undefined || v.chosenEvidenceId === null)) {
    ctx.addIssue({ code: 'custom', path: ['chosenEvidenceId'], message: 'obligatoire quand decision = choose' });
  }
  if (v.decision === 'abstain' && v.chosenEvidenceId !== undefined && v.chosenEvidenceId !== null) {
    ctx.addIssue({ code: 'custom', path: ['chosenEvidenceId'], message: 'interdit quand decision = abstain' });
  }
});
export type T3ValueConflictOutput = z.infer<typeof T3ValueConflictOutput>;

// ── Branche LINK_AMBIGUITY ──────────────────────────────────────────────────
export const t3LinkMatch = z.object({
  candidateId: z.number().int().positive(),
  /** Force des signaux fournis (L2), dans [0, 1] — T3-07. */
  score: z.number().min(0).max(1),
  confidence,
  reason: z.string().min(1).max(300),
});
export type T3LinkMatch = z.infer<typeof t3LinkMatch>;

export const T3LinkAmbiguityOutput = z.object({
  task: z.literal('LINK_AMBIGUITY'),
  /** Liste vide = aucun candidat suffisamment justifié (L3). */
  matches: z.array(t3LinkMatch).max(50),
});
export type T3LinkAmbiguityOutput = z.infer<typeof T3LinkAmbiguityOutput>;

/** Union discriminée par `task` (CDC 15 §22.2). */
export const T3MasterOutput = z.discriminatedUnion('task', [T3ValueConflictOutput, T3LinkAmbiguityOutput]);
export type T3MasterOutput = z.infer<typeof T3MasterOutput>;

// ── Monde fermé (U1), contrôlé par le serveur ──────────────────────────────

export interface ClosedWorldWarning {
  code: 'UNKNOWN_EVIDENCE_ID' | 'UNKNOWN_CANDIDATE_ID' | 'DUPLICATE_CANDIDATE_ID';
  id: number;
}

/**
 * VALUE_CONFLICT : une preuve choisie hors des preuves fournies est une
 * hallucination — la sortie devient une abstention, avec avertissement.
 */
export function closedWorldValueConflict(
  out: T3ValueConflictOutput, allowedEvidenceIds: ReadonlySet<number>,
): { output: T3ValueConflictOutput; warnings: ClosedWorldWarning[] } {
  if (out.decision !== 'choose' || allowedEvidenceIds.has(out.chosenEvidenceId as number)) {
    return { output: out, warnings: [] };
  }
  return {
    output: {
      task: 'VALUE_CONFLICT', decision: 'abstain', chosenEvidenceId: null, confidence: 'conflictual',
      reason: `preuve ${out.chosenEvidenceId} hors des preuves fournies — abstention (U1)`,
    },
    warnings: [{ code: 'UNKNOWN_EVIDENCE_ID', id: out.chosenEvidenceId as number }],
  };
}

/**
 * LINK_AMBIGUITY : un candidat hors de la liste fournie rend TOUTE la réponse
 * suspecte — abstention (liste vide), avec avertissement. Un doublon aussi :
 * deux scores pour un même candidat ne sont pas interprétables.
 */
export function closedWorldLinkAmbiguity(
  out: T3LinkAmbiguityOutput, allowedCandidateIds: ReadonlySet<number>,
): { output: T3LinkAmbiguityOutput; warnings: ClosedWorldWarning[] } {
  const warnings: ClosedWorldWarning[] = [];
  const vus = new Set<number>();
  for (const m of out.matches) {
    if (!allowedCandidateIds.has(m.candidateId)) warnings.push({ code: 'UNKNOWN_CANDIDATE_ID', id: m.candidateId });
    else if (vus.has(m.candidateId)) warnings.push({ code: 'DUPLICATE_CANDIDATE_ID', id: m.candidateId });
    vus.add(m.candidateId);
  }
  if (warnings.length === 0) return { output: out, warnings };
  return { output: { task: 'LINK_AMBIGUITY', matches: [] }, warnings };
}
