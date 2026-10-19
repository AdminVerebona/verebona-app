/**
 * Lot 70A — éditeur des modèles d'e-mails transactionnels (BO › Communications ›
 * E-mails transactionnels). Module PUR, partagé par le service, les routes et
 * l'écran (aucun accès base, aucune dépendance).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX FORMATS, DEUX ÉDITIONS
 *
 *   · Gabarit « texte » (paragraphes séparés par des lignes, boutons
 *     « Libellé : URL ») : édité tel quel. La mise en page de la charte est
 *     appliquée à l'envoi par l'enveloppe du code (`EmailService.wrapInHTML`).
 *     Balises admises : <strong> <b> <em> <i> <u> <br>, SANS attribut.
 *
 *   · Gabarit HTML complet (11 gabarits livrés, lot 66C) : édition PAR ZONES
 *     DE TEXTE. Seuls les nœuds texte visibles (paragraphes, titres, libellés de
 *     boutons, pied) sont modifiables, en texte brut ; la structure, les styles
 *     et les liens (href) ne le sont pas. C'est la variante la plus sûre : aucune
 *     balise, aucun attribut, aucun lien ne peut être introduit ou retiré, la
 *     mise en page et le mode sombre restent ceux de la charte, et une variable
 *     de lien obligatoire placée dans un href ne peut pas disparaître. Le HTML
 *     encadré (édition du balisage avec liste blanche) a été écarté : il exige un
 *     assainisseur HTML complet (dépendance ou analyseur maison) pour un gain
 *     faible — changer un texte suffit aux besoins décrits.
 *
 * VARIABLES : chaque gabarit déclare les variables que son code d'envoi FOURNIT
 * (`TEMPLATE_VARIABLES`). Une variable inconnue est refusée à l'enregistrement,
 * une variable obligatoire retirée aussi : aucune variable ne peut rester non
 * remplacée à l'envoi. Gabarit sans déclaration (ancien, hors catalogue) : ne
 * sont admises que les variables qu'il emploie déjà (texte actuel, texte livré).
 * ══════════════════════════════════════════════════════════════════════════
 */

export type TemplateFormat = 'text' | 'html';

/** Même règle que `EmailService.isCompleteHTML` : un document complet n'est pas ré-enveloppé. */
export function templateFormat(body: string): TemplateFormat {
  const t = (body ?? '').trim().toLowerCase();
  return t.startsWith('<!doctype html>') || t.startsWith('<html') || t.includes('<body') ? 'html' : 'text';
}

// ── Variables ─────────────────────────────────────────────────────────────────

export type VariableKind = 'text' | 'url' | 'html';

export interface TemplateVariable {
  name: string;
  label: string;
  kind: VariableKind;
  /** Fournie par le service d'e-mail (logo) : non proposée à l'insertion. */
  system?: boolean;
}

export interface RequiredVariableGroup {
  /** Au moins une de ces variables doit rester présente (objet ou contenu). */
  anyOf: string[];
  label: string;
}

export interface TemplateVariableSpec {
  variables: TemplateVariable[];
  required: RequiredVariableGroup[];
  /** Déclaration issue du code d'envoi (false : déduite du texte du gabarit). */
  declared: boolean;
}

const v = (name: string, label: string, kind: VariableKind = 'text'): TemplateVariable => ({ name, label, kind });
const req = (label: string, ...anyOf: string[]): RequiredVariableGroup => ({ label, anyOf });

const FIRST_NAME = v('firstName', 'Prénom du destinataire');
const YEAR = v('year', 'Année en cours');
const LOGO: TemplateVariable = { name: 'logoUrl', label: 'Logo Verebona (en-tête)', kind: 'url', system: true };
/** Noms repris sous `actionUrl` / `inviteUrl` / `invitationLink` par `withActionLinkAliases`. */
const ACTION_ALIASES = (label: string) => [v('actionUrl', `${label} (nom générique)`, 'url'), v('inviteUrl', `${label} (autre nom)`, 'url'), v('invitationLink', `${label} (autre nom)`, 'url')];

/**
 * Variables FOURNIES par le code d'envoi de chaque gabarit (appelants audités au
 * lot 70A) et variables obligatoires. Clé : type en majuscules.
 */
const DECLARED: Record<string, { variables: TemplateVariable[]; required: RequiredVariableGroup[] }> = {
  WELCOME: {
    variables: [FIRST_NAME, v('loginUrl', 'Lien de connexion', 'url')],
    required: [req('lien de connexion', 'loginUrl')],
  },
  EMAIL_VERIFICATION: {
    variables: [FIRST_NAME, v('verificationUrl', 'Lien de vérification de l’adresse (signé, 24 h)', 'url'), ...ACTION_ALIASES('Lien de vérification')],
    required: [req('lien de vérification', 'verificationUrl', 'actionUrl', 'inviteUrl', 'invitationLink')],
  },
  PASSWORD_RESET: {
    variables: [FIRST_NAME, v('resetUrl', 'Lien de réinitialisation (1 h)', 'url'), v('expiresAt', 'Durée de validité du lien'), ...ACTION_ALIASES('Lien de réinitialisation')],
    required: [req('lien de réinitialisation', 'resetUrl', 'actionUrl', 'inviteUrl', 'invitationLink')],
  },
  ACCOUNT_INVITATION: {
    variables: [v('inviterName', 'Nom de la personne qui invite'), v('accountName', 'Nom du compte'), v('role', 'Rôle proposé'),
      v('invitationLink', 'Lien d’invitation', 'url'), v('actionUrl', 'Lien d’invitation (nom générique)', 'url'), v('inviteUrl', 'Lien d’invitation (autre nom)', 'url')],
    required: [req('lien d’invitation', 'invitationLink', 'actionUrl', 'inviteUrl')],
  },
  DUO_INVITATION: {
    variables: [v('ownerFirstName', 'Prénom du titulaire'), v('ownerLastName', 'Nom du titulaire'), v('ownerFullName', 'Prénom et nom du titulaire'),
      v('inviteUrl', 'Lien d’invitation Duo', 'url'), v('actionUrl', 'Lien d’invitation Duo (nom générique)', 'url'), v('invitationLink', 'Lien d’invitation Duo (autre nom)', 'url'),
      v('expiresIn', 'Durée de validité de l’invitation')],
    required: [req('lien d’invitation', 'inviteUrl', 'actionUrl', 'invitationLink')],
  },
  DUO_MEMBERSHIP_ENDED: {
    variables: [FIRST_NAME, v('ownerFirstName', 'Prénom du titulaire'), v('accountUrl', 'Lien « Mon compte »', 'url'), v('subscriptionUrl', 'Lien vers les offres', 'url')],
    required: [req('lien vers le compte ou les offres', 'accountUrl', 'subscriptionUrl')],
  },
  DUO_MEMBERSHIP_LEFT: {
    variables: [FIRST_NAME, v('ownerFirstName', 'Prénom du titulaire'), v('accountUrl', 'Lien « Mon compte »', 'url'), v('subscriptionUrl', 'Lien vers les offres', 'url')],
    required: [req('lien vers le compte ou les offres', 'accountUrl', 'subscriptionUrl')],
  },
  TRIAL_CONFIRMATION: {
    variables: [FIRST_NAME, v('trialEndsAt', 'Date de fin de l’essai'), v('actionUrl', 'Lien vers Verebona', 'url'), v('loginUrl', 'Lien de connexion', 'url')],
    required: [req('lien vers Verebona', 'actionUrl', 'loginUrl')],
  },
  PREMIUM_CONFIRMATION: {
    variables: [FIRST_NAME, v('planLabel', 'Offre souscrite'), v('amountLabel', 'Montant (TTC)'), v('periodLabel', 'Périodicité'),
      v('nextBillingDate', 'Prochaine échéance'), v('premiumUntil', 'Prochaine échéance (ancien nom)')],
    required: [req('offre', 'planLabel'), req('montant', 'amountLabel'), req('périodicité', 'periodLabel'), req('prochaine échéance', 'nextBillingDate', 'premiumUntil')],
  },
  DOWNGRADE_NOTIFICATION: {
    variables: [FIRST_NAME, v('actionUrl', 'Lien vers les offres', 'url')],
    required: [req('lien vers les offres', 'actionUrl')],
  },
  MEMBER_REMOVED_DUE_TO_DOWNGRADE: {
    variables: [v('memberName', 'Prénom du membre'), v('accountName', 'Nom du compte'), v('reason', 'Motif du retrait')],
    required: [],
  },
  LEGAL_CONFIRMATION: {
    variables: [FIRST_NAME, v('legalVersionCode', 'Version des conditions acceptées'), v('legalPermalinkUrl', 'Permalien de la version acceptée', 'url'),
      v('subscriptionBlockHtml', 'Bloc abonnement (produit par le code)', 'html'), v('withdrawalBlockHtml', 'Bloc rétractation (produit par le code)', 'html'),
      v('contactEmail', 'Adresse de contact')],
    required: [req('version des conditions', 'legalVersionCode'), req('permalien', 'legalPermalinkUrl')],
  },
  WITHDRAWAL_VERIFICATION: {
    variables: [FIRST_NAME, v('verificationUrl', 'Lien de confirmation de la rétractation', 'url'), ...ACTION_ALIASES('Lien de confirmation'), v('contactEmail', 'Adresse de contact')],
    required: [req('lien de confirmation', 'verificationUrl', 'actionUrl', 'inviteUrl', 'invitationLink'), req('adresse de contact', 'contactEmail')],
  },
  WITHDRAWAL_RECEIPT: {
    variables: [FIRST_NAME, v('lastName', 'Nom'), v('publicReference', 'Référence de la rétractation'), v('requestedAtLabel', 'Date de réception'),
      v('contractLabel', 'Contrat'), v('amountLabel', 'Remboursement'), v('legalPermalinkUrl', 'Conditions générales', 'url'), v('contactEmail', 'Adresse de contact')],
    required: [req('référence', 'publicReference'), req('date de réception', 'requestedAtLabel')],
  },
  REFERRAL_INVITATION: {
    variables: [v('senderName', 'Nom du parrain'), v('referralUrl', 'Lien de parrainage', 'url'), v('actionUrl', 'Lien de parrainage (nom générique)', 'url')],
    required: [req('lien de parrainage', 'referralUrl', 'actionUrl')],
  },
  PRICE_CHANGE_NOTICE: {
    variables: [FIRST_NAME, v('planLabel', 'Offre'), v('oldAmount', 'Tarif actuel'), v('newAmount', 'Nouveau tarif'), v('effectiveFrom', 'Date d’effet')],
    required: [req('tarif actuel', 'oldAmount'), req('nouveau tarif', 'newAmount'), req('date d’effet', 'effectiveFrom')],
  },
  SECURITY_SESSIONS_REVOKED: {
    variables: [FIRST_NAME, v('incidentDate', 'Date de la déconnexion'), v('loginUrl', 'Lien de connexion', 'url'), v('forgotPasswordUrl', 'Lien « Mot de passe oublié »', 'url')],
    required: [req('lien « Mot de passe oublié »', 'forgotPasswordUrl')],
  },
  SIGNUP_EXISTING_ACCOUNT: {
    variables: [FIRST_NAME, v('requestDate', 'Date de la demande'), v('loginUrl', 'Lien de connexion', 'url'), v('forgotPasswordUrl', 'Lien « Mot de passe oublié »', 'url')],
    required: [req('lien « Mot de passe oublié »', 'forgotPasswordUrl')],
  },
  SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER: {
    variables: [FIRST_NAME, v('planLabel', 'Offre'), v('renewalDate', 'Date du renouvellement'), v('renewalDelayLabel', 'Délai avant renouvellement (« dans 7 jours »)'),
      v('amountLabel', 'Montant prévu du renouvellement'), v('manageSubscriptionUrl', 'Lien du portail Stripe (gérer l’abonnement)', 'url'), v('accountUrl', 'Lien « Mon compte »', 'url')],
    required: [req('lien du portail de gestion', 'manageSubscriptionUrl'), req('montant du renouvellement', 'amountLabel'), req('date du renouvellement', 'renewalDate')],
  },
  // SUBSCRIPTION_EXPIRING : déclenché par aucun code (ancien modèle) — non déclaré,
  // seules ses variables actuelles sont admises.
  ACCOUNT_DELETION_COMPLETED: {
    variables: [v('requestedAt', 'Date de la demande de suppression'), v('deletedAt', 'Date de la suppression')],
    required: [req('date de la suppression', 'deletedAt')],
  },
};

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Noms des variables `{{…}}` d'un texte (ordre d'apparition, sans doublon). */
export function extractVariables(text: string): string[] {
  return [...new Set([...(text ?? '').matchAll(PLACEHOLDER_RE)].map((m) => m[1]))];
}

export function hasDeclaredVariables(type: string): boolean {
  return !!DECLARED[type.trim().toUpperCase()];
}

/**
 * Variables disponibles et obligatoires d'un gabarit. Sans déclaration :
 * variables déjà employées par le texte actuel, le texte livré et la colonne
 * `placeholders` (aucune n'est alors obligatoire, hormis les liens du texte livré).
 */
export function variableSpecFor(
  type: string,
  known: { format: TemplateFormat; currentTexts?: string[]; shippedTexts?: string[]; placeholders?: string | null } = { format: 'text' },
): TemplateVariableSpec {
  const declared = DECLARED[type.trim().toUpperCase()];
  const common = known.format === 'html' ? [YEAR, LOGO] : [YEAR];
  if (declared) {
    return { variables: [...declared.variables, ...common], required: declared.required, declared: true };
  }
  const names = new Set<string>();
  for (const t of [...(known.currentTexts ?? []), ...(known.shippedTexts ?? [])]) for (const n of extractVariables(t)) names.add(n);
  try {
    const p = known.placeholders ? JSON.parse(known.placeholders) : null;
    if (Array.isArray(p)) for (const n of p) if (typeof n === 'string' && /^[A-Za-z0-9_]+$/.test(n)) names.add(n);
  } catch { /* colonne libre : ignorée */ }
  const variables = [...names]
    .filter((n) => n !== 'year' && n !== 'logoUrl')
    .map((n) => v(n, n, /(url|link)$/i.test(n) ? 'url' : /html$/i.test(n) ? 'html' : 'text'));
  const shippedLinks = new Set<string>();
  for (const t of known.shippedTexts ?? []) for (const n of extractVariables(t)) if (/(url|link)$/i.test(n) && n !== 'logoUrl') shippedLinks.add(n);
  return {
    variables: [...variables, ...common],
    required: shippedLinks.size ? [req('lien d’action', ...shippedLinks)] : [],
    declared: false,
  };
}

// ── Contraintes légales ───────────────────────────────────────────────────────

/**
 * Gabarits dont le contenu n'est PAS modifiable depuis le BO (variante prudente,
 * lot 70A) : contenu imposé et attesté. Distinct du verrou « non désactivable ».
 */
export const CONTENT_LOCKED_TEMPLATES: Readonly<Record<string, string>> = {
  LEGAL_CONFIRMATION:
    'Confirmation légale d’acceptation des conditions générales (CDC 7 §10) : contenu imposé — version acceptée, permalien vers la version figée (empreinte SHA-256), blocs abonnement et rétractation produits par le code — et envoi tracé dans le journal légal. Toute modification passe par une livraison.',
  WITHDRAWAL_RECEIPT:
    'Accusé de réception de la rétractation sur support durable (Code de la consommation, art. L221-21) : il atteste la référence, la date de réception, le contrat et le remboursement. Toute modification passe par une livraison.',
};

/** Gabarits modifiables avec des mentions obligatoires (édition limitée). */
export const LIMITED_TEMPLATES: Readonly<Record<string, string>> = {
  PREMIUM_CONFIRMATION:
    'Confirmation du contrat sur support durable (point de départ du délai de rétractation) : l’offre, le montant, la périodicité et la prochaine échéance doivent rester présents.',
  WITHDRAWAL_VERIFICATION:
    'Parcours légal de rétractation : le lien de confirmation et l’adresse de contact doivent rester présents.',
  PRICE_CHANGE_NOTICE:
    'Information préalable d’une évolution de tarif : le tarif actuel, le nouveau tarif et la date d’effet doivent rester présents.',
};

export function contentLockReason(type: string): string | null {
  return CONTENT_LOCKED_TEMPLATES[type.trim().toUpperCase()] ?? null;
}

export function limitedEditReason(type: string): string | null {
  return LIMITED_TEMPLATES[type.trim().toUpperCase()] ?? null;
}

// ── Bornes ───────────────────────────────────────────────────────────────────

export const EDITOR_LIMITS = {
  subject: 200,
  textBody: 20_000,
  htmlBody: 200_000,
  zone: 2_000,
  note: 300,
} as const;

// ── Zones de texte des gabarits HTML ─────────────────────────────────────────

export interface HtmlZone {
  index: number;
  /** Texte visible, entités décodées, espaces de bord retirés. */
  text: string;
  /** Zone non modifiable (logo, bloc HTML produit par le code). */
  locked: boolean;
  /** Libellé d'un lien ou d'un bouton : ne peut pas être vide. */
  inLink: boolean;
  /** Balise englobante la plus proche (p, h1, a, li, strong…). */
  tag: string;
}

interface Segment { start: number; end: number; raw: string; inLink: boolean; tag: string }

const TOKEN_RE = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g;
const VOID_TAGS = new Set(['br', 'img', 'meta', 'hr', 'input', 'link', 'col', 'area', 'base', 'wbr', 'source']);

function textSegments(html: string): Segment[] {
  const bodyAt = html.search(/<body\b/i);
  const from = bodyAt >= 0 ? bodyAt : 0;
  const out: Segment[] = [];
  const stack: string[] = [];
  let skipUntil: string | null = null;
  let last = from;
  TOKEN_RE.lastIndex = from;
  const push = (start: number, end: number) => {
    if (skipUntil || end <= start) return;
    const raw = html.slice(start, end);
    if (!raw.trim()) return;
    out.push({ start, end, raw, inLink: stack.includes('a'), tag: stack[stack.length - 1] ?? '' });
  };
  for (let m = TOKEN_RE.exec(html); m; m = TOKEN_RE.exec(html)) {
    push(last, m.index);
    last = m.index + m[0].length;
    const tok = m[0];
    if (tok.startsWith('<!--')) continue;
    const name = /^<\/?([A-Za-z][A-Za-z0-9]*)/.exec(tok)![1].toLowerCase();
    const closing = tok.startsWith('</');
    if (skipUntil) {
      if (closing && name === skipUntil) skipUntil = null;
      continue;
    }
    if (!closing && (name === 'style' || name === 'script' || name === 'title' || name === 'head')) {
      skipUntil = name;
      continue;
    }
    if (VOID_TAGS.has(name) || tok.endsWith('/>')) continue;
    if (closing) {
      const i = stack.lastIndexOf(name);
      if (i >= 0) stack.length = i;
    } else {
      stack.push(name);
    }
  }
  push(last, html.length);
  return out;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return NAMED[e.toLowerCase()] ?? all;
  });
}

/** Encode un texte de zone (les `<` `>` sont refusés en amont). */
function encodeZoneText(s: string): string {
  return s
    .replace(/&(?!(?:#x[0-9a-f]+|#\d+|[a-z]+);)/gi, '&amp;')
    .replace(/ /g, '&nbsp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const normalizeZone = (s: string) => decodeEntities(s).replace(/\s+/g, ' ').trim();

function isLockedText(text: string, spec?: TemplateVariableSpec): boolean {
  const stripped = text.replace(PLACEHOLDER_RE, '').trim();
  if (stripped) return false;
  const names = extractVariables(text);
  if (!names.length) return false;
  return names.every((n) => n === 'logoUrl' || /html$/i.test(n) || spec?.variables.find((x) => x.name === n)?.kind === 'html');
}

/** Zones de texte visibles d'un gabarit HTML complet (dans `<body>`). */
export function extractHtmlZones(html: string, spec?: TemplateVariableSpec): HtmlZone[] {
  return textSegments(html).map((s, index) => {
    const text = normalizeZone(s.raw);
    return { index, text, locked: isLockedText(text, spec), inLink: s.inLink, tag: s.tag };
  });
}

export type ZoneApplyResult = { ok: true; body: string; changed: number[] } | { ok: false; issues: ValidationIssue[] };

/**
 * Applique les textes des zones (même nombre, même ordre) au gabarit HTML.
 * Une zone inchangée garde son balisage d'origine à l'octet près ; une zone
 * verrouillée ne peut pas changer.
 */
export function applyHtmlZones(html: string, texts: unknown, spec?: TemplateVariableSpec): ZoneApplyResult {
  const segs = textSegments(html);
  if (!Array.isArray(texts) || texts.length !== segs.length || texts.some((t) => typeof t !== 'string')) {
    return { ok: false, issues: [{ code: 'ZONES_MISMATCH', message: 'Le gabarit a changé depuis l’ouverture de l’éditeur : rechargez la page.' }] };
  }
  const issues: ValidationIssue[] = [];
  const changed: number[] = [];
  let out = '';
  let cursor = 0;
  segs.forEach((s, i) => {
    const original = normalizeZone(s.raw);
    const next = (texts[i] as string).replace(/\s+/g, ' ').trim();
    out += html.slice(cursor, s.start);
    cursor = s.end;
    if (next === original) {
      out += s.raw;
      return;
    }
    const where = `zone ${i + 1}`;
    if (isLockedText(original, spec)) {
      issues.push({ code: 'ZONE_LOCKED', message: `La ${where} est produite par le code et ne peut pas être modifiée.` });
      out += s.raw;
      return;
    }
    if (/[<>]/.test(next)) {
      issues.push({ code: 'FORBIDDEN_TAG', message: `La ${where} contient « < » ou « > » : le HTML n’est pas admis dans les zones de texte.` });
    }
    if (next.length > EDITOR_LIMITS.zone) {
      issues.push({ code: 'ZONE_TOO_LONG', message: `La ${where} dépasse ${EDITOR_LIMITS.zone} caractères.` });
    }
    if (!next && s.inLink) {
      issues.push({ code: 'LINK_LABEL_EMPTY', message: `La ${where} est le libellé d’un bouton ou d’un lien : elle ne peut pas être vide.` });
    }
    changed.push(i);
    const lead = /^\s*/.exec(s.raw)![0];
    const trail = /\s*$/.exec(s.raw)![0];
    out += `${lead}${encodeZoneText(next)}${trail}`;
  });
  out += html.slice(cursor);
  return issues.length ? { ok: false, issues } : { ok: true, body: out, changed };
}

/** Texte comparable d'un corps (zones pour un gabarit HTML, lignes pour un gabarit texte). */
export function comparableText(body: string): string {
  return templateFormat(body) === 'html' ? extractHtmlZones(body).map((z) => z.text).join('\n') : body;
}

// ── Validation ────────────────────────────────────────────────────────────────

export interface ValidationIssue {
  code: string;
  message: string;
}

const ALLOWED_TEXT_TAG = /^<\/?(?:strong|b|em|i|u)>$|^<br\s*\/?>$/i;
const DANGEROUS_SCHEME = /(?:java|vb)script\s*:|data\s*:\s*text\/html/i;

/** Accolades orphelines ou variable mal formée (`{{ prénom }}`, `{{x}`…). */
function malformedPlaceholders(text: string): string[] {
  const rest = text.replace(PLACEHOLDER_RE, '');
  const bad = rest.match(/\{\{[^}]*\}?\}?|\}\}/g) ?? [];
  return [...new Set(bad.map((b) => b.slice(0, 40)))];
}

/** Contrôle de l'objet : une ligne, sans caractère de contrôle ni balise. */
export function validateSubject(subject: unknown): ValidationIssue[] {
  if (typeof subject !== 'string' || !subject.trim()) return [{ code: 'SUBJECT_EMPTY', message: 'L’objet est obligatoire.' }];
  const issues: ValidationIssue[] = [];
  if (/[\r\n\u0000-\u001f\u007f\u2028\u2029]/.test(subject)) {
    issues.push({ code: 'SUBJECT_HEADER_INJECTION', message: 'L’objet doit tenir sur une ligne (aucun retour à la ligne ni caractère de contrôle).' });
  }
  if (subject.length > EDITOR_LIMITS.subject) issues.push({ code: 'SUBJECT_TOO_LONG', message: `L’objet dépasse ${EDITOR_LIMITS.subject} caractères.` });
  if (/<[A-Za-z/!]/.test(subject)) issues.push({ code: 'SUBJECT_HTML', message: 'L’objet ne peut pas contenir de balise.' });
  return issues;
}

/** Contrôles de sûreté d'un gabarit TEXTE (balises, schémas d'URL). */
export function scanTextBody(body: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const m of body.matchAll(/<[^>]*>?/g)) {
    const tag = m[0];
    if (!/^<[A-Za-z/!?]/.test(tag)) continue; // « a < b » : simple texte
    if (ALLOWED_TEXT_TAG.test(tag)) continue;
    const name = (/^<\/?\s*([A-Za-z0-9!?-]+)/.exec(tag)?.[1] ?? '').toLowerCase();
    if (name === 'script') issues.push({ code: 'SCRIPT', message: 'Les scripts sont interdits.' });
    else if (/\son[a-z]+\s*=/i.test(tag)) issues.push({ code: 'FORBIDDEN_ATTRIBUTE', message: `Attribut d’événement interdit (${tag.slice(0, 40)}).` });
    else issues.push({ code: 'FORBIDDEN_TAG', message: `Balise non admise : ${tag.slice(0, 40)} (admises : <strong>, <b>, <em>, <i>, <u>, <br>, sans attribut).` });
  }
  if (DANGEROUS_SCHEME.test(decodeEntities(body))) issues.push({ code: 'JAVASCRIPT_URL', message: 'Les liens « javascript: », « vbscript: » ou « data: » sont interdits.' });
  return dedupe(issues);
}

/** Contrôles de sûreté d'un gabarit HTML complet (filet : script, on*, schémas, href). */
export function scanHtmlBody(body: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (/<script\b/i.test(body)) issues.push({ code: 'SCRIPT', message: 'Les scripts sont interdits.' });
  if (/<(?:iframe|object|embed|form|input|button|textarea|select|base|meta\s+http-equiv\s*=\s*["']?refresh)\b/i.test(body)) {
    issues.push({ code: 'FORBIDDEN_TAG', message: 'Balise interdite dans un e-mail (iframe, object, embed, formulaire, base, redirection).' });
  }
  for (const m of body.matchAll(/<[^>]+>/g)) {
    if (/\son[a-z]+\s*=/i.test(m[0])) {
      issues.push({ code: 'FORBIDDEN_ATTRIBUTE', message: `Attribut d’événement interdit (${m[0].slice(0, 40)}).` });
      break;
    }
  }
  if (DANGEROUS_SCHEME.test(decodeEntities(body))) issues.push({ code: 'JAVASCRIPT_URL', message: 'Les liens « javascript: », « vbscript: » ou « data: » sont interdits.' });
  for (const m of body.matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/gi)) {
    const url = decodeEntities(m[2]).trim();
    if (!isAllowedLink(url)) {
      issues.push({ code: 'INVALID_LINK', message: `Lien non admis : ${url.slice(0, 60)} (admis : http(s), mailto, ou une variable de lien).` });
    }
  }
  return dedupe(issues);
}

/** Lien admis : http(s), mailto, ou une variable `{{…}}` (éventuellement préfixée). */
export function isAllowedLink(url: string): boolean {
  if (!url) return false;
  if (/^\{\{\s*[A-Za-z0-9_]+\s*\}\}/.test(url)) return true;
  if (/^https?:\/\/[^\s"'<>]+$/i.test(url)) return true;
  if (/^mailto:[^\s"'<>]+$/i.test(url)) return true;
  return false;
}

function dedupe(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => (seen.has(i.code + i.message) ? false : (seen.add(i.code + i.message), true)));
}

/**
 * Validation complète d'un brouillon (objet + corps final) contre la
 * déclaration de variables du gabarit. Renvoie la liste des refus (vide = OK).
 */
export function validateDraft(input: {
  subject: unknown;
  body: unknown;
  format: TemplateFormat;
  spec: TemplateVariableSpec;
  /** Variables `html` admises dans le corps (déjà présentes dans le texte livré). */
  htmlVariablesAllowed?: boolean;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [...validateSubject(input.subject)];
  const subject = typeof input.subject === 'string' ? input.subject : '';
  const body = typeof input.body === 'string' ? input.body : '';
  if (!body.trim()) issues.push({ code: 'BODY_EMPTY', message: 'Le contenu est obligatoire.' });
  const max = input.format === 'html' ? EDITOR_LIMITS.htmlBody : EDITOR_LIMITS.textBody;
  if (body.length > max) issues.push({ code: 'BODY_TOO_LONG', message: `Le contenu dépasse ${max} caractères.` });
  if (templateFormat(body) !== input.format && body.trim()) {
    issues.push({ code: 'FORMAT_CHANGED', message: input.format === 'text'
      ? 'Un gabarit texte ne peut pas devenir un document HTML complet.'
      : 'Un gabarit HTML complet doit rester un document HTML.' });
  }
  issues.push(...(input.format === 'html' ? scanHtmlBody(body) : scanTextBody(body)));

  // Feuille de style des gabarits HTML : accolades CSS, hors contrôle des variables.
  const scanned = input.format === 'html' ? body.replace(/<style\b[\s\S]*?<\/style>/gi, '') : body;
  const malformed = malformedPlaceholders(`${subject}\n${scanned}`);
  if (malformed.length) {
    issues.push({ code: 'MALFORMED_VARIABLE', message: `Variable mal formée : ${malformed.join(', ')} (forme attendue : {{nomDeVariable}}).` });
  }

  const byName = new Map(input.spec.variables.map((x) => [x.name, x]));
  const used = extractVariables(`${subject}\n${body}`);
  const unknown = used.filter((n) => !byName.has(n));
  if (unknown.length) {
    issues.push({ code: 'UNKNOWN_VARIABLE', message: `Variable inconnue pour ce modèle : ${unknown.map((n) => `{{${n}}}`).join(', ')}. Elle ne serait pas remplacée à l’envoi.` });
  }
  const subjectBad = extractVariables(subject).filter((n) => byName.get(n) && byName.get(n)!.kind !== 'text');
  if (subjectBad.length) {
    issues.push({ code: 'VARIABLE_NOT_ALLOWED_IN_SUBJECT', message: `Variable non admise dans l’objet (lien ou bloc) : ${subjectBad.map((n) => `{{${n}}}`).join(', ')}.` });
  }
  if (!input.htmlVariablesAllowed) {
    const htmlVars = extractVariables(body).filter((n) => byName.get(n)?.kind === 'html');
    if (htmlVars.length) {
      issues.push({ code: 'HTML_VARIABLE_NOT_ALLOWED', message: `Bloc produit par le code non admis ici : ${htmlVars.map((n) => `{{${n}}}`).join(', ')}.` });
    }
  }
  const present = new Set(used);
  for (const g of input.spec.required) {
    if (!g.anyOf.some((n) => present.has(n))) {
      issues.push({ code: 'REQUIRED_VARIABLE_MISSING', message: `Variable obligatoire retirée : ${g.label} (${g.anyOf.map((n) => `{{${n}}}`).join(' ou ')}).` });
    }
  }
  return dedupe(issues);
}

// ── Comparaison simple (lignes) ──────────────────────────────────────────────

export type DiffOp = { op: 'same' | 'add' | 'del'; text: string };

/** Différence ligne à ligne (plus longue sous-suite commune). Bornée à 2 000 lignes par côté. */
export function diffLines(before: string, after: string): DiffOp[] {
  const a = (before ?? '').split('\n').slice(0, 2000);
  const b = (after ?? '').split('\n').slice(0, 2000);
  const n = a.length;
  const m = b.length;
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: 'same', text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ op: 'del', text: a[i] }); i++; }
    else { out.push({ op: 'add', text: b[j] }); j++; }
  }
  while (i < n) out.push({ op: 'del', text: a[i++] });
  while (j < m) out.push({ op: 'add', text: b[j++] });
  return out;
}

/** Libellés des origines de version (historique du BO). */
export const VERSION_SOURCE_LABELS: Readonly<Record<string, string>> = {
  initial: 'Texte en place à l’ouverture de l’éditeur',
  admin_edit: 'Modification',
  restore: 'Restauration',
  reset_shipped: 'Retour au texte livré',
};
