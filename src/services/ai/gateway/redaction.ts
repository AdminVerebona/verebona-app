import { createHash } from 'crypto';

/**
 * Masquage avant transmission au fournisseur — CDC §5.6 (minimisation) et
 * §5.2 (masquage des secrets).
 */
const PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // IBAN (FR et zone SEPA) — §4.2.6 le classe champ critique.
  { re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}[ ]?[A-Z0-9]{1,4}\b/g, replacement: '[IBAN_MASQUE]' },
  // Cartes bancaires.
  { re: /\b(?:\d[ -]?){13,19}\b/g, replacement: '[CARTE_MASQUEE]' },
  // Clés d'API fournisseur.
  { re: /\bAIza[0-9A-Za-z\-_]{35}\b/g, replacement: '[CLE_API_MASQUEE]' },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/g, replacement: '[CLE_API_MASQUEE]' },
  // Numéro de sécurité sociale français.
  { re: /\b[12]\d{2}(?:0[1-9]|1[0-2])\d{2}\d{3}\d{3}(?:\s?\d{2})?\b/g, replacement: '[NIR_MASQUE]' },
];

export function redact(input: string): string {
  return PATTERNS.reduce((acc, p) => acc.replace(p.re, p.replacement), input);
}

/**
 * Masque récursivement les valeurs texte d'un objet de variables de prompt.
 * `exempt` : variables de premier niveau transmises telles quelles (liste
 * d'exemption déclarée par l'opération, jamais par l'appelant).
 */
export function redactVariables(
  vars: Record<string, unknown>,
  exempt: readonly string[] = [],
): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redact(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return Object.fromEntries(
    Object.entries(vars).map(([k, v]) => [k, exempt.includes(k) ? v : walk(v)]),
  );
}

/** Ne jamais journaliser une sortie brute complète : extrait borné et masqué. */
export function previewForLog(raw: string, maxChars = 500): string {
  return redact(raw).slice(0, maxChars);
}

/**
 * Empreinte d'une sortie brute, sans son contenu (CDC Assistant §29.6) :
 * « sha256:<12 premiers caractères> len:<n> ». Suffit à rapprocher deux
 * traces d'une même sortie, ne permet pas de la relire.
 */
export function outputDigestForLog(raw: string): string {
  const text = String(raw ?? '');
  return `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 12)} len:${text.length}`;
}

/** Retire l'extrait de sortie brute d'un message d'erreur de validation. */
export function stripRawExcerpt(message: string): string {
  return String(message ?? '').replace(/\s*Extrait\s*:[\s\S]*?(?=\s+—\s+|$)/g, ' [extrait non conservé]');
}
