/**
 * Redaction des données sensibles — CDC §29.3 / §29.4.
 *
 * Avant d'envoyer un extrait au modèle, masque les données non nécessaires à la tâche
 * (IBAN, numéros de carte, identifiants nationaux, e-mails/téléphones si non pertinents).
 * Minimisation : on n'envoie que ce qui est utile à l'intention (§16.2).
 */
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?\w{4}){2,7}\b/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const PHONE_FR = /\b(?:0|\+33)\s?[1-9](?:[ .-]?\d{2}){4}\b/g;

export interface RedactionOptions {
  keepEmails?: boolean;
  keepPhones?: boolean;
}

export function redact(text: string, opts: RedactionOptions = {}): string {
  let out = text.replace(IBAN, '[IBAN masqué]').replace(CARD, '[numéro masqué]');
  if (!opts.keepEmails) out = out.replace(EMAIL, '[email masqué]');
  if (!opts.keepPhones) out = out.replace(PHONE_FR, '[téléphone masqué]');
  return out;
}
