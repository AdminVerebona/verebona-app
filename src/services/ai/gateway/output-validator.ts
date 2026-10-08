/**
 * Validation structurée des sorties — CDC §5.3, lot 33D.
 *
 * Règles : validation des enums, dates et montants, vérification des
 * identifiants, normalisation avant persistance, AUCUNE persistance d'une
 * sortie invalide.
 *
 * Lot 33D : la validation passe par la résolution progressive
 * (`output-resolution/resolve-output`) — parsing strict, extraction et
 * réparation JSON déterministes, adaptateurs de compatibilité versionnés,
 * normalisation pilotée par le schéma, validation champ par champ. Une
 * sortie invalide lève `AiOutputInvalidError` (code `INVALID_OUTPUT`,
 * récupérable) avec son diagnostic : sous-type, étape, erreurs par chemin.
 */
import type { ZodType } from 'zod';
import { AiOutputInvalidError, AiOutputTaskMismatchError, type OutputFailureDetail } from './errors';
import { parseModelOutput } from './output-resolution/json-repair';
import { resolveOutput, type Resolution, type ResolveInput } from './output-resolution/resolve-output';

/**
 * Extrait le premier objet ou tableau JSON d'une réponse modèle, y compris
 * lorsqu'il est encadré de balises de code ou précédé d'un préambule.
 */
export function extractJson(raw: string): unknown {
  const p = parseModelOutput(raw);
  if (!p.ok) throw new SyntaxError(p.empty ? 'Aucune structure JSON détectée' : p.error);
  return p.value;
}

/**
 * Format de sortie déclaré par l'opération :
 *   · `json` (défaut) — le JSON est extrait de la réponse puis validé ;
 *   · `text` — la réponse BRUTE est validée telle quelle par le schéma
 *     (typiquement `z.string()` raffiné). Réservé aux modules historiques
 *     migrés, dont l'analyse de la réponse reste chez l'appelant ; le schéma
 *     garde le rôle de filtre : une réponse qu'il refuse est un échec
 *     récupérable, qui passe au modèle suivant.
 */
export type OutputFormat = 'json' | 'text';

/**
 * Options de validation.
 *
 * `expectedTask` — sortie d'un prompt maître (CDC 15 §22.2) : l'objet doit
 * porter `task === expectedTask`. La branche est imposée par le serveur :
 * une sortie d'une AUTRE branche est refusée (`AiOutputTaskMismatchError`) ;
 * un discriminant ABSENT est rétabli (lot 33D, règle `discriminant_imposed`).
 */
export interface ValidateOutputOptions {
  expectedTask?: string;
  /**
   * Champ discriminant de la sortie : `task` (défaut), `mode` (T2 §24, T5
   * §27) ou `none` (T6 §28 : la sortie ne porte pas de discriminant — le
   * contrôle de branche est sauté, le `schemaVersion` strict du contrat joue
   * ce rôle ; la branche reste imposée en entrée par `{{MODE}}`).
   */
  taskField?: 'task' | 'mode' | 'none';
  /** Nom du contrat (adaptateurs de compatibilité versionnés). */
  schemaName?: string | null;
  /** Retrait des champs facultatifs invalides (défaut : oui). */
  allowPruning?: boolean;
  jsonRequested?: boolean;
  provider?: ResolveInput['provider'];
}

/** Diagnostic d'une résolution en échec. */
export function failureDetailOf(r: Extract<Resolution, { ok: false }>): OutputFailureDetail {
  return {
    subtype: r.subtype, stage: r.stage, issues: r.issues, issueCount: r.issueCount, controls: r.controls,
    repairs: r.repairs, extracted: r.extracted, parsed: r.parsed, originalMessage: r.issues[0]?.message ?? r.message,
  };
}

/** Erreur typée d'une résolution en échec. */
export function errorOf(r: Extract<Resolution, { ok: false }>, operationCode: string): AiOutputInvalidError | AiOutputTaskMismatchError {
  const detail = failureDetailOf(r);
  if (r.taskMismatch) {
    return new AiOutputTaskMismatchError(operationCode, r.taskMismatch.expected, r.taskMismatch.received, r.taskMismatch.discriminant, detail);
  }
  return new AiOutputInvalidError(operationCode, r.message, detail);
}

export function validateOutput<T>(
  raw: string,
  schema: ZodType<T>,
  operationCode: string,
  format: OutputFormat = 'json',
  options: ValidateOutputOptions = {},
): T {
  const r = resolveOutput({
    raw, schema, operationCode, format,
    schemaName: options.schemaName ?? null,
    expectedTask: options.taskField === 'none' ? undefined : options.expectedTask,
    taskField: options.taskField,
    jsonRequested: options.jsonRequested,
    provider: options.provider,
    allowPruning: options.allowPruning ?? true,
  });
  if (r.ok) return r.data as T;
  throw errorOf(r, operationCode);
}
