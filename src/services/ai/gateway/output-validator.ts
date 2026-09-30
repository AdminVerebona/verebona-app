/**
 * Validation structurée des sorties — CDC §5.3.
 *
 * Règles : rejet des champs inconnus à risque, validation des enums, dates et
 * montants, vérification des identifiants, normalisation avant persistance,
 * AUCUNE persistance d'une sortie brute invalide.
 */
import type { ZodType } from 'zod';
import { AiGatewayError, AiOutputTaskMismatchError } from './errors';
import { previewForLog } from './redaction';

/**
 * Extrait le premier objet ou tableau JSON d'une réponse modèle, y compris
 * lorsqu'il est encadré de balises de code ou précédé d'un préambule.
 */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();

  try {
    return JSON.parse(candidate);
  } catch {
    // Repli : première structure équilibrée rencontrée.
    const start = candidate.search(/[[{]/);
    if (start === -1) throw new SyntaxError('Aucune structure JSON détectée');
    const opening = candidate[start];
    const closing = opening === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const c = candidate[i];
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === opening) depth++;
      else if (c === closing) {
        depth--;
        if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
      }
    }
    throw new SyntaxError('Structure JSON incomplète');
  }
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
 * porter `task === expectedTask`. Contrôlé AVANT le schéma, même si celui-ci
 * est l'union discriminée complète (`T1MasterOutput`) qui accepterait l'autre
 * branche : le modèle ne choisit pas sa branche.
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
}

export function validateOutput<T>(
  raw: string,
  schema: ZodType<T>,
  operationCode: string,
  format: OutputFormat = 'json',
  options: ValidateOutputOptions = {},
): T {
  let parsed: unknown;
  try {
    parsed = format === 'text' ? raw : extractJson(raw);
  } catch (e) {
    throw new AiGatewayError('INVALID_OUTPUT', operationCode,
      `Sortie non parsable : ${(e as Error).message}. Extrait : ${previewForLog(raw, 200)}`,
      { recoverable: true, cause: e });
  }

  if (options.expectedTask !== undefined && options.taskField !== 'none') {
    const task = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)[options.taskField ?? 'task']
      : undefined;
    if (task !== options.expectedTask) {
      throw new AiOutputTaskMismatchError(operationCode, options.expectedTask, task, options.taskField === 'mode' ? 'MODE' : 'TASK');
    }
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`)
      .join(' | ');
    throw new AiGatewayError('INVALID_OUTPUT', operationCode,
      `Sortie non conforme au schéma. ${issues}`, { recoverable: true });
  }
  return result.data;
}
