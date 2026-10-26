/**
 * Contrat du prompt maître T3 — CDC 15 §25, §22.2, T3-06, T3-07.
 *
 * Une seule consigne (`t3_master_v1`), branches imposées par le serveur
 * (lot 61 : quatrième branche FACULTATIVE `DOCUMENT_NAMING`, harmonisation
 * du nommage documentaire, voir plus bas) :
 *   - `VALUE_CONFLICT` : choisir UNE preuve fournie, ou s'abstenir ;
 *   - `LINK_AMBIGUITY` : scorer des candidats fournis, liste vide possible ;
 *   - `OPERATION_MATCH` (lot 42, CDC Opérations V1 C6.1 niveau M3, C6.2) :
 *     la source décrit-elle la MÊME réalité métier qu'une des Opérations
 *     candidates fournies ? Sortie fermée SAME_OPERATION / DISTINCT_OPERATION
 *     / AMBIGUOUS, confiance, signaux concordants et contradictions.
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

export const T3_TASKS = ['VALUE_CONFLICT', 'LINK_AMBIGUITY', 'OPERATION_MATCH', 'DOCUMENT_NAMING'] as const;

const confidence = z.enum(['certain', 'probable', 'conflictual']);

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
  /**
   * Relation DOCUMENT_ASSET (lot 31B, D1 à D6 du master) : le document
   * concerne-t-il UN bien (`SINGLE` : plusieurs candidats = A OU B, ambiguïté)
   * ou RÉELLEMENT plusieurs (`MULTIPLE` : A ET B) ? Facultatif : absent pour
   * les autres relations, et lu `SINGLE` par défaut.
   */
  documentScope: z.enum(['SINGLE', 'MULTIPLE']).nullable().optional(),
});
export type T3LinkAmbiguityOutput = z.infer<typeof T3LinkAmbiguityOutput>;

// ── Branche OPERATION_MATCH (lot 42, CDC Opérations V1 C6.1 M3, C6.2) ──────
/**
 * Comparaison sémantique d'une source (candidat T1 persisté) avec un jeu
 * FERMÉ d'Opérations candidates (au plus `OPERATION_MATCH_MAX_CANDIDATES`).
 *   · `SAME_OPERATION` : `matchedCandidateId` obligatoire (un candidat fourni) ;
 *   · `DISTINCT_OPERATION` / `AMBIGUOUS` : `matchedCandidateId` absent ou null.
 * Seul SAME_OPERATION + `certain` (+ absence de hard negative, contrôlée par le
 * serveur) autorise un rattachement automatique (C6.2) ; DISTINCT_OPERATION +
 * `certain` autorise une création seulement si la source peut créer seule (C5).
 */
export const T3OperationMatchOutput = z.object({
  task: z.literal('OPERATION_MATCH'),
  decision: z.enum(['SAME_OPERATION', 'DISTINCT_OPERATION', 'AMBIGUOUS']),
  matchedCandidateId: z.number().int().positive().nullable().optional(),
  confidence,
  concordantSignals: z.array(z.string().min(1).max(200)).max(10),
  contradictions: z.array(z.string().min(1).max(200)).max(10),
  reason: z.string().min(1).max(400),
  /**
   * Lot 56A : issue EXPLICITE décidée par le modèle — ATTACH (rattacher sans
   * solliciter l'utilisateur), ARBITRATE (ambiguïté réelle : question
   * « À traiter »), DISTINCT (éléments qui écartent le rapprochement).
   * Facultative : une version BO du prompt maître antérieure au lot 56A n'en
   * produit pas — le serveur applique alors la règle historique (seul
   * SAME_OPERATION + certain rattache). Validée par le serveur
   * (`translateOperationMatch`) : jamais un rattachement sans signal positif.
   */
  resolution: z.enum(['ATTACH', 'ARBITRATE', 'DISTINCT']).optional(),
}).superRefine((v, ctx) => {
  if (v.decision === 'SAME_OPERATION' && (v.matchedCandidateId === undefined || v.matchedCandidateId === null)) {
    ctx.addIssue({ code: 'custom', path: ['matchedCandidateId'], message: 'obligatoire quand decision = SAME_OPERATION' });
  }
  if (v.decision !== 'SAME_OPERATION' && v.matchedCandidateId !== undefined && v.matchedCandidateId !== null) {
    ctx.addIssue({ code: 'custom', path: ['matchedCandidateId'], message: 'interdit hors SAME_OPERATION' });
  }
});
export type T3OperationMatchOutput = z.infer<typeof T3OperationMatchOutput>;

// ── Branche DOCUMENT_NAMING (lot 61, ticket « T3 — Harmonisation intelligente du nommage documentaire ») ──
/**
 * Une proposition de renommage (section `document_renames`). Noms de champs
 * imposés par le ticket (snake_case). Le serveur ne fait JAMAIS confiance à
 * la proposition : monde fermé (document et références fournis), nom attendu
 * comparé au nom envoyé, garde-fous déterministes, puis écriture en
 * compare-and-swap (`document-naming/`).
 */
const t3DocumentRename = z.object({
  document_id: z.number().int().positive(),
  /** Nom actuel tel que le modèle l'a lu : sert au compare-and-swap (nom attendu). */
  expected_current_name: z.string().min(1).max(500),
  proposed_name: z.string().min(1).max(500),
  /** Documents de la famille sur lesquels la convention s'appuie (fournis dans l'appel). */
  reference_document_ids: z.array(z.number().int().positive()).max(50).optional(),
  reason: z.string().min(1).max(400),
  confidence,
});

/** Famille identifiée par le modèle dans le lot de comparaison (facultatif : reporting, mémoire de convention). */
const t3NamingFamily = z.object({
  label: z.string().min(1).max(200),
  document_ids: z.array(z.number().int().positive()).max(200),
  /** Convention retenue, décrite librement par le modèle (jamais un gabarit appliqué par le code). */
  convention: z.string().max(400).nullable().optional(),
  /** Le modèle a-t-il constaté des intitulés incohérents dans cette famille ? */
  inconsistent: z.boolean().optional(),
});

/**
 * Sortie de la branche DOCUMENT_NAMING. `document_renames` reste FACULTATIVE
 * DANS LE SCHÉMA (rétrocompatibilité : versions anciennes du prompt, autres
 * branches T3, union discriminée) — mais lot 72B (E9) : son ABSENCE n'est
 * plus « aucune proposition ». `document_renames: []` = examen fait, aucun
 * renommage nécessaire (lot terminé) ; section ABSENTE = réponse INCOMPLÈTE
 * (anomalie journalisée, lot jamais clôturé, reprise bornée — voir
 * `namingOutputComplete` et `document-naming/phase.ts`). Plusieurs
 * renommages possibles dans une même exécution.
 */
export const T3DocumentNamingOutput = z.object({
  task: z.literal('DOCUMENT_NAMING'),
  families: z.array(t3NamingFamily).max(100).optional(),
  document_renames: z.array(t3DocumentRename).max(200).optional(),
});
export type T3DocumentNamingOutput = z.infer<typeof T3DocumentNamingOutput>;

/**
 * Sortie DOCUMENT_NAMING COMPLÈTE ? (pure, lot 72B — E9) : la section
 * `document_renames` est présente (éventuellement vide). Absente : réponse
 * incomplète, jamais assimilée à « rien à renommer ».
 */
export function namingOutputComplete(out: Pick<T3DocumentNamingOutput, 'document_renames'> | null | undefined): boolean {
  return !!out && Array.isArray(out.document_renames);
}

/** Union discriminée par `task` (CDC 15 §22.2). */
export const T3MasterOutput = z.discriminatedUnion('task', [T3ValueConflictOutput, T3LinkAmbiguityOutput, T3OperationMatchOutput, T3DocumentNamingOutput]);
export type T3MasterOutput = z.infer<typeof T3MasterOutput>;

// ── Monde fermé (U1), contrôlé par le serveur ──────────────────────────────

export interface ClosedWorldWarning {
  code: 'UNKNOWN_EVIDENCE_ID' | 'UNKNOWN_CANDIDATE_ID' | 'DUPLICATE_CANDIDATE_ID' | 'UNKNOWN_OPERATION_ID';
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

/**
 * OPERATION_MATCH : une Opération désignée hors du jeu fourni est une
 * hallucination — la sortie devient AMBIGUOUS (jamais un rattachement), avec
 * avertissement (U1).
 */
export function closedWorldOperationMatch(
  out: T3OperationMatchOutput, allowedCandidateIds: ReadonlySet<number>,
): { output: T3OperationMatchOutput; warnings: ClosedWorldWarning[] } {
  if (out.decision !== 'SAME_OPERATION' || allowedCandidateIds.has(out.matchedCandidateId as number)) {
    return { output: out, warnings: [] };
  }
  return {
    output: {
      task: 'OPERATION_MATCH', decision: 'AMBIGUOUS', matchedCandidateId: null, confidence: 'conflictual',
      concordantSignals: [], contradictions: [],
      reason: `candidat ${out.matchedCandidateId} hors des candidats fournis — ambiguïté (U1)`,
    },
    warnings: [{ code: 'UNKNOWN_OPERATION_ID', id: out.matchedCandidateId as number }],
  };
}
