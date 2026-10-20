/**
 * Lot 74A (point 1) — e-mail adressé à l'équipe par le formulaire de contact
 * PUBLIC (`POST /api/contact`, visiteur non connecté). Module PUR.
 *
 * Toutes les valeurs sont saisies par un inconnu : elles passent par
 * `variable-safety.ts` (lot 73A) comme les variables d'un gabarit —
 *   · HTML : balises retirées, liens désarmés, caractères échappés ;
 *   · texte et objet : texte inerte (aucune balise, aucun lien, une ligne) ;
 *   · objet : en plus `sanitizeSubjectHeader` (aucune injection d'en-tête).
 * Seule exception voulue : le MESSAGE garde ses retours à la ligne (c'est un
 * texte destiné à l'équipe) — chaque ligne est neutralisée séparément, puis
 * jointe par « \n » (texte) ou « <br> » (HTML). Aucune ligne ne peut donc
 * former une ligne « Libellé : https://… » transformée en bouton par
 * l'enveloppe de la charte (`wrapInHTML`) : les schémas sont désarmés.
 *
 * L'adresse saisie n'est utilisée en « Répondre à » que si c'est une adresse
 * e-mail correcte (une seule, sans nom affiché, sans saut de ligne).
 */
import { safeTemplateValue, type InsertionMode } from './variable-safety';

export interface ContactInput {
  name: string;
  email: string;
  subject: string;
  message: string;
}

export interface ContactEmail {
  subject: string;
  /** Corps pour l'enveloppe de la charte (`wrapInHTML`) : lignes déjà échappées. */
  htmlBody: string;
  text: string;
  /** Adresse de réponse, ou `null` si l'adresse saisie n'est pas valide. */
  replyTo: string | null;
}

export const CONTACT_SUBJECT_PREFIX = '[Contact Verebona]';

/** Une adresse e-mail simple et correcte (RFC 5321 : 254 caractères au plus). */
export function validReplyToAddress(raw: string): string | null {
  const v = String(raw ?? '').trim();
  if (v.length > 254 || /[\s\u0000-\u001f\u007f]/.test(v)) return null;
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/.test(v)
    ? v
    : null;
}

/** Message sur plusieurs lignes : chaque ligne neutralisée, au plus une ligne vide consécutive. */
function messageLines(message: string, mode: InsertionMode): string[] {
  const lines = message.replace(/\r\n?/g, '\n').split(/[\n\u2028\u2029\u0085]/).map((l) => safeTemplateValue('message', l, mode).trim());
  const out: string[] = [];
  for (const l of lines) {
    if (!l && (!out.length || !out[out.length - 1])) continue;
    out.push(l);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

/** Construit l'e-mail à l'équipe (objet, corps HTML pour l'enveloppe, texte, reply-to). */
export function buildContactEmail(input: ContactInput): ContactEmail {
  const field = (name: keyof ContactInput, mode: InsertionMode) => safeTemplateValue(name, input[name], mode).trim();
  const subjectText = field('subject', 'text');
  // Valeur déjà sur une ligne ; `sanitizeSubjectHeader` (lot 70A) est appliqué
  // en plus à l'envoi (`EmailService.sendContactMessage`).
  const subject = `${CONTACT_SUBJECT_PREFIX} ${subjectText}`.trim();

  const intro = 'Nouveau message de contact reçu depuis le site Verebona.';
  const htmlBody = [
    intro,
    '',
    `Nom : ${field('name', 'html')}`,
    `E-mail : ${field('email', 'html')}`,
    `Objet : ${field('subject', 'html')}`,
    '',
    'Message :',
    messageLines(input.message, 'html').join('<br>'),
  ].join('\n');
  const text = [
    intro,
    '',
    `Nom : ${field('name', 'text')}`,
    `E-mail : ${field('email', 'text')}`,
    `Objet : ${subjectText}`,
    '',
    'Message :',
    ...messageLines(input.message, 'text'),
  ].join('\n');

  return { subject, htmlBody, text, replyTo: validReplyToAddress(input.email) };
}
