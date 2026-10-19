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
  // Lot 69 : générique. 42883 dit seulement qu'une fonction ou un opérateur
  // attendu est introuvable pour ces types d'arguments ; l'objet n'est cité
  // que s'il est lu de façon fiable dans le message (`undefinedObject`).
  '42883': {
    hint: 'MISSING_FUNCTION',
    explanation:
      'Une fonction ou un opérateur PostgreSQL requis est introuvable ou ' +
      'incompatible avec les arguments transmis.',
  },
  '23514': { hint: 'CHECK_CONSTRAINT', explanation: 'Une contrainte refuse la valeur écrite.' },
  '23505': { hint: 'UNIQUE_VIOLATION', explanation: 'Une valeur en double viole un index unique.' },
  '23503': { hint: 'FOREIGN_KEY', explanation: 'La ligne référencée est absente.' },
  '28P01': {
    hint: 'AUTH_FAILED',
    explanation:
      'Authentification refusée par PostgreSQL (identifiant ou mot de passe).',
  },
};

export interface DatabaseDiagnostic {
  /** Code court, exploitable côté client. */
  schemaHint?: string;
  /** Explication destinée aux journaux, jamais à l'utilisateur final. */
  explanation?: string;
  /** Code PostgreSQL brut. */
  pgCode?: string;
  /**
   * Objet précis mis en cause : contrainte, table, colonne.
   *
   * ══════════════════════════════════════════════════════════════════════
   * PostgreSQL NOMME CE QUI A ÉCHOUÉ. IL FAUT LE LIRE.
   *
   * Un `23514` seul dit « une contrainte refuse la valeur » — ce qui
   * n'aide personne : une table peut en porter dix. L'erreur du pilote
   * contient pourtant `constraint`, `table` et parfois `column`.
   *
   * Sans ces champs, on cherche la contrainte fautive à la main dans les
   * migrations. Avec eux, on la lit.
   * ══════════════════════════════════════════════════════════════════════
   */
  constraint?: string;
  table?: string;
  column?: string;
  /** Ligne de détail du pilote, souvent la valeur refusée. */
  detail?: string;
  /**
   * 42883 : fonction ou opérateur introuvable, LU dans le message de
   * PostgreSQL (`function foo(integer) does not exist`, `operator does not
   * exist: integer = text`). Absent si le message ne le dit pas clairement.
   */
  undefinedObject?: { kind: 'function' | 'operator'; signature: string };
}

/**
 * Objet introuvable d'une erreur 42883, extrait du message SEULEMENT s'il
 * suit l'un des formats exacts de PostgreSQL (anglais ou français) ; sinon
 * `undefined` — jamais de nom supposé (lot 69).
 */
export function extractUndefinedObject(message: string | null | undefined): DatabaseDiagnostic['undefinedObject'] {
  const m = String(message ?? '').trim();
  const fn = /^(?:function|la fonction)\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?\([^()]*\))\s+(?:does not exist|n'existe pas)/i.exec(m);
  if (fn) return { kind: 'function', signature: fn[1] };
  const op = /^(?:operator does not exist|l'opérateur n'existe pas)\s*:\s*(.{1,120}?)\s*$/i.exec(m.split('\n')[0]);
  if (op) return { kind: 'operator', signature: op[1] };
  return undefined;
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
/** Champs de localisation portés par l'erreur, sur elle ou sur sa cause. */
function extractLocation(error: unknown): Pick<DatabaseDiagnostic, 'constraint' | 'table' | 'column' | 'detail'> {
  const source =
    (error as { constraint_name?: string; constraint?: string })?.constraint ??
    (error as { cause?: unknown })?.cause;
  const e = (typeof source === 'object' && source !== null ? source : error) as {
    constraint_name?: string; constraint?: string;
    table_name?: string; table?: string;
    column_name?: string; column?: string;
    detail?: string;
  };
  return {
    constraint: e?.constraint_name ?? e?.constraint,
    table: e?.table_name ?? e?.table,
    column: e?.column_name ?? e?.column,
    detail: e?.detail,
  };
}

export function diagnoseDatabaseError(error: unknown): DatabaseDiagnostic {
  const pgCode = extractPgCode(error);
  if (!pgCode) return {};
  const known = SCHEMA_CODES[pgCode];
  const lieu = extractLocation(error);
  // Les champs vides sont retirés : un diagnostic clairsemé de `undefined`
  // se lit moins bien qu'un diagnostic court.
  const localisation = Object.fromEntries(
    Object.entries(lieu).filter(([, v]) => v !== undefined && v !== null),
  );
  if (known && pgCode === '42883') {
    const undefinedObject = extractUndefinedObject(extractPgMessage(error));
    const explanation = undefinedObject
      ? `${undefinedObject.kind === 'function' ? 'Fonction' : 'Opérateur'} PostgreSQL introuvable ou incompatible avec les arguments transmis : ${undefinedObject.signature}.`
      : known.explanation;
    return { schemaHint: known.hint, explanation, pgCode, ...localisation, ...(undefinedObject ? { undefinedObject } : {}) };
  }
  if (known && pgCode === '28P01') {
    // DATABASE_URL absente : cité seulement si c'est CONSTATÉ (lot 69), jamais présumé.
    const explanation = process.env.DATABASE_URL ? known.explanation
      : `${known.explanation} DATABASE_URL n'est pas définie : le pilote se rabat sur le compte système courant.`;
    return { schemaHint: known.hint, explanation, pgCode, ...localisation };
  }
  return known
    ? { schemaHint: known.hint, explanation: known.explanation, pgCode, ...localisation }
    : { pgCode, ...localisation };
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
  if (diagnostic.constraint || diagnostic.table || diagnostic.column) {
    console.error(
      `[${scope}][${reference}] objet : ` +
      [
        diagnostic.table ? `table ${diagnostic.table}` : null,
        diagnostic.column ? `colonne ${diagnostic.column}` : null,
        diagnostic.constraint ? `contrainte ${diagnostic.constraint}` : null,
      ].filter(Boolean).join(', '),
    );
  }
  if (diagnostic.detail) {
    console.error(`[${scope}][${reference}] détail : ${diagnostic.detail}`);
  }
  if (diagnostic.explanation) {
    console.error(`[${scope}][${reference}] ${diagnostic.explanation}`);
  }

  return { reference, diagnostic };
}
