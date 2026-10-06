/**
 * Filet de sécurité des réponses de la page BO « Exploitation » (lot 25,
 * chantier B) : aucune réponse `/api/admin/ops/**` ne doit porter de secret
 * ni d'URL signée.
 *
 * Les données affichées sont déjà construites SANS valeur de variable (noms
 * seuls) ; ce module retire en plus, de toute chaîne d'un objet JSON :
 *   · les identifiants d'une URL (`postgres://user:motdepasse@hôte` →
 *     `postgres://***@hôte`) ;
 *   · les paramètres de signature d'une URL présignée S3 / AWS
 *     (`X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`,
 *     `Signature`, `AWSAccessKeyId`) : l'URL entière est remplacée ;
 *   · les en-têtes d'autorisation (`Bearer xxx`).
 * Pur et testé (`__tests__/ops-security.test.ts`).
 */

const URL_IDENTIFIANTS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;
const URL_SIGNEE = /\bhttps?:\/\/[^\s"']*[?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|Signature|AWSAccessKeyId)=[^\s"']*/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g;

export function redactString(s: string): string {
  return s
    .replace(URL_SIGNEE, '[URL signée masquée]')
    .replace(URL_IDENTIFIANTS, '$1***@')
    .replace(BEARER, 'Bearer ***');
}

/** Copie profonde d'une valeur JSON, chaînes filtrées par `redactString`. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}
