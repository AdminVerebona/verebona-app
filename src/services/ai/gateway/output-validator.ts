/**
 * Validation structurée des sorties — CDC §5.3.
 *
 * Règles : rejet des champs inconnus à risque, validation des enums, dates et
 * montants, vérification des identifiants, normalisation avant persistance,
 * AUCUNE persistance d'une sortie brute invalide.
 */
import type { ZodType } from 'zod';
import { AiGatewayError } from './errors';
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

export function validateOutput<T>(raw: string, schema: ZodType<T>, operationCode: string): T {
  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch (e) {
    throw new AiGatewayError('INVALID_OUTPUT', operationCode,
      `Sortie non parsable : ${(e as Error).message}. Extrait : ${previewForLog(raw, 200)}`,
      { recoverable: true, cause: e });
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
