/**
 * Diagnostic d'une erreur de base — CDC refonte, principe de traçabilité.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE MODULE EXISTE
 *
 * Trois routes ont produit un « 500 Internal Server Error » nu, sans rien
 * indiquer de leur cause :
 *
 *     GET  /api/legal/cgvu/current   → 500
 *     GET  /cgvu                     → 500
 *     POST /api/users                → 500
 *
 * Les trois échouaient pour la MÊME raison — une table absente — et aucune ne
 * le disait. Il a fallu plusieurs allers-retours pour l'établir, alors que
 * PostgreSQL avait renvoyé un code sans ambiguïté dès la première requête.
 *
 * Une erreur de schéma ne signale jamais une saisie fautive : elle signale que
 * la base ne correspond pas au code déployé. La nommer épargne des heures.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Codes PostgreSQL trahissant un schéma désaligné. */
const SCHEMA_CODES: Record<string, { hint: string; explanation: string }> = {
  '42P01': {
    hint: 'MISSING_TABLE',
    explanation:
      "Une table n'existe pas. Une migration n'a pas été appliquée — " +
      'consultez /api/health, champ checks.migrations.',
  },
  '42703': {
    hint: 'MISSING_COLUMN',
    explanation:
      "Une colonne n'existe pas. Le schéma est plus ancien que le code déployé.",
  },
  '42883': {
    hint: 'MISSING_FUNCTION',
    explanation:
      "Une fonction PostgreSQL est absente. `gen_random_uuid()` par exemple " +
      "n'est native qu'à partir de la version 13 ; en deçà, l'extension " +
      'pgcrypto est nécessaire.',
  },
  '23514': { hint: 'CHECK_CONSTRAINT', explanation: 'Une contrainte refuse la valeur écrite.' },
  '23505': { hint: 'UNIQUE_VIOLATION', explanation: 'Une valeur en double viole un index unique.' },
  '23503': { hint: 'FOREIGN_KEY', explanation: 'La ligne référencée est absente.' },
  '28P01': {
    hint: 'AUTH_FAILED',
    explanation:
      "Authentification refusée. Souvent DATABASE_URL absente : le pilote se " +
      'rabat alors sur le compte système courant.',
  },
};

export interface DatabaseDiagnostic {
  /** Code court, exploitable côté client. */
  schemaHint?: string;
  /** Explication destinée aux journaux, jamais à l'utilisateur final. */
  explanation?: string;
  /** Code PostgreSQL brut. */
  pgCode?: string;
}

/**
 * Extrait le code PostgreSQL d'une erreur, y compris enveloppée par Drizzle.
 *
 * Drizzle enveloppe les erreurs du pilote : le code se trouve dans `cause`,
 * pas sur l'erreur elle-même. C'est ce qui rendait « Failed query » si opaque.
 */
export function extractPgCode(error: unknown): string | undefined {
  const direct = (error as { code?: string })?.code;
  if (typeof direct === 'string' && /^\d{2}[A-Z0-9]{3}$/.test(direct)) return direct;

  const cause = (error as { cause?: { code?: string } })?.cause?.code;
  return typeof cause === 'string' ? cause : undefined;
}

/** Message sous-jacent, en traversant l'enveloppe Drizzle. */
export function extractPgMessage(error: unknown): string {
  const cause = (error as { cause?: { message?: string } })?.cause?.message;
  return cause ?? (error as Error)?.message ?? String(error);
}

/** Qualifie une erreur de base. Objet vide si la cause n'est pas reconnue. */
export function diagnoseDatabaseError(error: unknown): DatabaseDiagnostic {
  const pgCode = extractPgCode(error);
  if (!pgCode) return {};
  const known = SCHEMA_CODES[pgCode];
  return known ? { schemaHint: known.hint, explanation: known.explanation, pgCode } : { pgCode };
}

/**
 * Journalise une erreur de base avec sa cause réelle, et rend une référence.
 *
 * La référence est renvoyée au client : elle permet de retrouver l'incident
 * dans les journaux sans exposer la cause, qui n'a rien à y faire.
 */
export function logDatabaseError(scope: string, error: unknown): {
  reference: string;
  diagnostic: DatabaseDiagnostic;
} {
  const reference = `${scope}-${Date.now().toString(36).toUpperCase()}`;
  const diagnostic = diagnoseDatabaseError(error);
  const message = extractPgMessage(error);

  console.error(
    `[${scope}][${reference}] ${diagnostic.pgCode ?? 'sans code'} : ${message}`,
  );
  if (diagnostic.explanation) {
    console.error(`[${scope}][${reference}] ${diagnostic.explanation}`);
  }

  return { reference, diagnostic };
}
