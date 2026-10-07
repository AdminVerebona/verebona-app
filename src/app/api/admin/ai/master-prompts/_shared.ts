/**
 * Socle des routes « Prompts maîtres » du BO IA — ticket BO-IA-PROMPTS-01.
 *
 * Même garde que la configuration IA (administrateur, migrations appliquées) ;
 * refus fonctionnels rendus avec un code stable et un message en français
 * destiné à l'administrateur, jamais une commande ni une référence interne.
 */
import { NextResponse } from 'next/server';
import { MasterPromptRefused, assertAdministrable } from '@/services/ai/master-prompts/master-prompt.service';
import type { Treatment } from '@/services/ai/config/treatments';

export { requireAdminContext } from '../config-versions/_shared';

/** Traitement de l'URL (T1–T4, T6), ou réponse 404. */
export function parseTreatment(raw: string): { ok: true; treatment: Treatment } | { ok: false; response: NextResponse } {
  try {
    return { ok: true, treatment: assertAdministrable(raw.toUpperCase()) };
  } catch (e) {
    return { ok: false, response: masterPromptError(e, 'master-prompts') };
  }
}

/** Identifiant entier positif, ou `null`. */
export function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function invalidId(raw: string): NextResponse {
  return NextResponse.json({ error: 'INVALID_ID', message: `Identifiant illisible : « ${raw} ».` }, { status: 400 });
}

export function masterPromptError(e: unknown, route: string): NextResponse {
  if (e instanceof MasterPromptRefused) {
    return NextResponse.json({ error: e.code, message: e.message, details: e.details ?? null }, { status: e.httpStatus });
  }
  console.error(`[${route}]`, e);
  return NextResponse.json(
    { error: 'MASTER_PROMPT_OPERATION_FAILED', message: 'L’opération n’a pas abouti. Réessayez dans un instant.' },
    { status: 500 },
  );
}
