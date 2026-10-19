import { Resend } from 'resend';
import { db } from '@/db';
import { emailTemplates, emailSettings, emailLogs } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { isTransactionalEmailActive } from '@/lib/notifications/channel-activation';
import { EMAIL_COLORS, EMAIL_STYLES, emailButton, emailDocument, emailLogoHtml } from './email-layout';

/**
 * Logo de repli des emails (APP-PERF-38) : ressource MAÎTRISÉE servie par
 * l'application (`public/brand`, PNG 480×120 — les clients de messagerie
 * n'affichent pas le SVG). Remplace une image hébergée sur un stockage
 * Supabase hérité de l'outil de génération du projet.
 */
export const EMAIL_LOGO_FALLBACK_PATH = '/brand/verebona-logo-email.png';

/** URL du logo d'en-tête : la candidate, sauf absente ou SVG → repli. */
export function resolveEmailLogoUrl(candidate: string | null | undefined, fallback: string): string {
  const url = (candidate ?? '').trim();
  if (!url) return fallback;
  const chemin = url.split(/[?#]/)[0].toLowerCase();
  if (chemin.endsWith('.svg') || url.toLowerCase().startsWith('data:image/svg')) return fallback;
  return url;
}

type LogoResult = {
  content: string;
  type: 'url' | 'html' | 'none';
};

/** Emplacements `{{nom}}` encore présents après remplacement. */
export function unresolvedPlaceholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]))];
}

/**
 * Lot 53 — liens d'action : noms équivalents entre gabarits et appelants.
 *
 * Les gabarits en base (migration 0125, retouches BO) attendent souvent
 * `{{actionUrl}}`, quand les gabarits par défaut du code et certains
 * appelants parlent d'`inviteUrl`, `verificationUrl`… Un nom différent
 * laissait « Accepter : {{actionUrl}} » dans l'e-mail (invitation Duo,
 * 12 et 13/10/2026). Le lien fourni sous l'un de ces noms est repris sous
 * les autres, sans jamais écraser une valeur fournie.
 */
const ACTION_LINK_ALIASES = ['actionUrl', 'inviteUrl', 'invitationLink', 'verificationUrl', 'resetUrl', 'activationUrl', 'confirmUrl'] as const;

export function withActionLinkAliases(variables: Record<string, string>): Record<string, string> {
  const fourni = ACTION_LINK_ALIASES.map((k) => variables[k]).find((v) => typeof v === 'string' && /^https?:\/\//.test(v));
  if (!fourni) return variables;
  const out = { ...variables };
  if (!out.actionUrl) out.actionUrl = fourni;
  if (!out.inviteUrl) out.inviteUrl = fourni;
  if (!out.invitationLink) out.invitationLink = fourni;
  return out;
}

/**
 * Gabarits dont le lien est la raison d'être : une invitation sans lien
 * utilisable n'est pas envoyée (lot 53). Liste fermée et volontairement
 * courte : pour les autres gabarits, une variable manquante reste signalée
 * dans le journal (lot 49) sans bloquer l'envoi — un e-mail de sécurité ou
 * de facturation ne doit jamais être retenu.
 */
export const LINK_REQUIRED_TEMPLATES: ReadonlySet<string> = new Set([
  'DUO_INVITATION', 'ACCOUNT_INVITATION',
  // Lot 68C : le rappel J−7 n'a de sens qu'avec son bouton « Gérer mon abonnement sur Stripe ».
  'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER',
]);

/** Lien d'action resté non remplacé (`{{…Url}}`, `{{…Link}}`, hors logo). */
export function missingActionLinks(text: string): string[] {
  return unresolvedPlaceholders(text).filter((n) => /(url|link)$/i.test(n) && n !== 'logoUrl');
}

/**
 * Lot 57A — aucun jeton dans le journal des e-mails. `email_logs.metadata`
 * recopiait les variables, liens d'action compris : lien de vérification
 * signé (ouvre une session), lien d'invitation Duo… Le jeton est remplacé par
 * « [masqué] » ; les clés et le reste de l'URL (hôte, chemin) restent
 * lisibles pour le diagnostic.
 */
export function redactActionLinks(variables: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(variables ?? {})) {
    if (typeof v !== 'string' || !/^https?:\/\//.test(v)) { out[k] = v; continue; }
    out[k] = v
      .replace(/([?&](?:token|inviteToken|transmissionToken|code)=)[^&#]+/gi, '$1[masqué]')
      .replace(/\/(join|invitation|invite|transmission|reset-password|verify-email)\/[^/?#]{8,}/gi, '/$1/[masqué]');
  }
  return out;
}

/**
 * Lot 70A — aucune variable non remplacée dans l'e-mail envoyé : un `{{nom}}`
 * resté sans valeur (appelant qui ne la fournit pas) est retiré du rendu après
 * avoir été signalé dans le journal (lot 49) ; jamais d'accolades chez le
 * destinataire. `{{logoUrl}}` est remplacé avant (bloc logo).
 */
export function stripUnresolvedPlaceholders(text: string): string {
  return text.replace(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g, '');
}

/** Lot 70A — objet sur une seule ligne : aucune injection d'en-tête par une valeur. */
export function sanitizeSubjectHeader(subject: string): string {
  return subject.replace(/[\r\n\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** Rendu complet d'un gabarit (lot 70A : partagé par l'envoi, la prévisualisation et le test). */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /** Variables restées sans valeur (retirées du rendu). */
  unresolved: string[];
  /** Liens d'action restés sans valeur. */
  missingLinks: string[];
}

/** Résultat d'un envoi (lot 57A : identifiants utiles à la reprise et au suivi). */
export interface EmailSendResult {
  success: boolean;
  error?: string;
  /** Ligne `email_logs` écrite pour cette tentative. */
  logId?: number;
  /** Identifiant du message chez Resend (accepté). */
  providerMessageId?: string | null;
}

class EmailService {
  private resend: Resend;
  
  constructor() {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.warn('⚠️ RESEND_API_KEY not configured - emails will be logged but not sent');
      this.resend = new Resend('dummy_key');
    } else {
      this.resend = new Resend(apiKey);
    }
  }
  
  /**
   * Remplace les variables {{variable}} dans le texte
   */
  private replaceVariables(
    text: string,
    variables: Record<string, string>,
    settings: any,
    computedLogo: LogoResult
  ): string {
    let result = text;

    // Si le logo est de type HTML, remplacer tout tag <img ...{{logoUrl}}...> par le bloc HTML du logo
    // Le flag 's' (dotAll) permet de matcher les sauts de ligne dans le tag img
    if (computedLogo.type === 'html') {
      result = result.replace(/<img\b[\s\S]*?\{\{logoUrl\}\}[\s\S]*?>/gi, computedLogo.content);
      // Remplacer aussi {{logoUrl}} seul restant (hors balise img) par le bloc HTML
      result = result.replace(/\{\{logoUrl\}\}/g, computedLogo.content);
    }

    const currentYear = new Date().getFullYear().toString();
    const enrichedVariables: Record<string, string> = {
      ...variables,
      year: variables.year ?? currentYear,
    };

    // Ne pas écraser logoUrl si déjà remplacé ci-dessus
    if (computedLogo.type === 'url') {
      enrichedVariables.logoUrl = variables.logoUrl ?? computedLogo.content;
    }

    Object.entries(enrichedVariables).forEach(([key, value]) => {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`,'g');
      result = result.replace(regex, value || '');
    });
    return result;
  }

  /**
   * Rend une URL absolue si elle est relative
   */
  private makeAbsoluteUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    if (url.startsWith('http')) return url;
    if (url.startsWith('data:')) return url;
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || 'https://app.verebona.fr';
    const cleanUrl = url.startsWith('/') ? url : `/${url}`;
    return `${baseUrl}${cleanUrl}`;
  }

  /**
   * Normalise la taille du logo dans le HTML pour s'assurer qu'il est lisible.
   * Remplace les petites hauteurs fixes (≤60px) par une largeur fixe de 180px.
   */
  private fixLogoSizing(html: string): string {
    // Match img tags that reference the Verebona logo (by URL fragment OR still-unreplaced {{logoUrl}})
    return html.replace(
      /(<img\b[^>]*(?:verebona-logo|\/brand\/|generated_images|\{\{logoUrl\}\})[^>]*>)/gi,
      (imgTag) => {
        // Lot 66C : logo de la charte 2026 (`emailLogoHtml`), déjà dimensionné (160 × 40) et
        // doublé d'une version sombre masquée — ne pas le recalibrer.
        if (/\bdata-vb-logo=/i.test(imgTag)) return imgTag;
        // Rewrite the entire style attribute to enforce proper sizing
        let fixed = imgTag;

        // Replace existing style attribute wholesale
        if (/style="/i.test(fixed)) {
          fixed = fixed.replace(/style="[^"]*"/i, 'style="width:240px;height:auto;max-width:240px;display:block;border:0;"');
        } else {
          fixed = fixed.replace(/<img\b/i, '<img style="width:240px;height:auto;max-width:240px;display:block;border:0;"');
        }

        // Enforce width attribute (respected by Outlook)
        if (/width="[0-9]+"/.test(fixed)) {
          fixed = fixed.replace(/width="[0-9]+"/, 'width="240"');
        } else {
          fixed = fixed.replace(/<img\b/i, '<img width="240"');
        }

        // Remove any stray height attribute
        fixed = fixed.replace(/\s+height="[0-9]+"/, '');

        return fixed;
      }
    );
  }

  /**
   * Détecte si le contenu est déjà du HTML complet
   */
  private isCompleteHTML(content: string): boolean {
    const trimmed = content.trim().toLowerCase();
    return trimmed.startsWith('<!doctype html>') || 
           trimmed.startsWith('<html') ||
           trimmed.includes('<body');
  }
  
  /**
   * Récupère les paramètres globaux depuis la DB
   */
  private async getSettings() {
    try {
      const settings = await db
        .select()
        .from(emailSettings)
        .where(eq(emailSettings.id, 1))
        .limit(1);
      
      return settings[0] || {
        emailsEnabled: true,
        senderName: 'Verebona',
        senderEmail: 'noreply@verebona.com',
        replyToEmail: 'support@verebona.com',
        footerText: null,
        logoUrl: null,
        logoUrlLight: null,
        logoUrlDark: null
      };
    } catch (error) {
      console.error('Failed to fetch email settings:', error);
      return {
        emailsEnabled: true,
        senderName: 'Verebona',
        senderEmail: 'noreply@verebona.com',
        replyToEmail: 'support@verebona.com',
        footerText: null,
        logoUrl: null,
        logoUrlLight: null,
        logoUrlDark: null
      };
    }
  }
  
  /**
   * Retourne le logo Verebona pour les emails.
   * Utilise un HTML inline (tableau avec sigle + texte) pour une compatibilité maximale
   * avec tous les clients email, sans dépendre d'une URL externe.
   */
  private async getVerebonaEmailLogo(): Promise<LogoResult> {
    // Lot 66C : logo de la charte 2026 en IMAGES HÉBERGÉES par l'application (PNG opaques
    // clair / sombre, texte alternatif « Verebona »), à la place du sigle dessiné en
    // tableau (gris et bleu 2025). Remplace aussi `<img src="{{logoUrl}}">` des gabarits
    // HTML en base, personnalisés compris (`replaceVariables`).
    const base = (this.makeAbsoluteUrl('/') ?? 'https://app.verebona.fr/').replace(/\/+$/, '');
    return { content: emailLogoHtml(base), type: 'html' };
  }

  /**
   * Wrapper HTML premium Verebona pour les emails
   */
  private async wrapInHTML(bodyText: string, settings: any, computedLogo: LogoResult): Promise<string> {
    // Lot 66C : mise en page commune « Sérénité » (`email-layout.ts`). La découpe en
    // paragraphes et la détection des liens d'action sont INCHANGÉES (mêmes textes,
    // mêmes libellés, mêmes liens) ; seule la présentation change.
    const lines = bodyText.split('\n').map(line => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      
      // « Libellé : https://… » (convention des gabarits texte : « Accepter :
      // {{actionUrl}} », « Accéder à Verebona : {{actionUrl}} ») → bouton
      // portant le libellé ; une URL seule → bouton « Cliquez ici ».
      const labelled = /^(.{1,60}?)\s*:\s*(https?:\/\/\S+)$/.exec(trimmed);
      const url = labelled ? labelled[2] : (trimmed.startsWith('http://') || trimmed.startsWith('https://')) ? trimmed : null;
      if (url) {
        const label = labelled ? labelled[1].trim() : 'Cliquez ici';
        return emailButton(url, label);
      }
      
      return `<p style="${EMAIL_STYLES.p}">${trimmed}</p>`;
    });
    
    const currentYear = new Date().getFullYear();
    const footerContent = settings.footerText || `© ${currentYear} Verebona. Tous droits réservés.`;
    const appName = settings.senderName || 'Verebona';
    const base = (this.makeAbsoluteUrl('/') ?? 'https://app.verebona.fr/').replace(/\/+$/, '');

    // Génération du Header Logo
    let headerLogoHtml: string;
    
    if (computedLogo.type === 'html') {
      headerLogoHtml = computedLogo.content;
    } else {
      const logoUrl = resolveEmailLogoUrl(
        this.makeAbsoluteUrl(computedLogo.content || settings.logoUrlLight || settings.logoUrl),
        this.makeAbsoluteUrl(EMAIL_LOGO_FALLBACK_PATH)!,
      );
      headerLogoHtml = `<img src="${logoUrl}" alt="${appName}" width="160" style="display:block;width:160px;max-width:100%;height:auto;border:0;outline:none;" />`;
    }

    if (computedLogo.type === 'none' && !settings.logoUrl) {
      headerLogoHtml = `<p class="vb-wordmark" style="margin:0;font-size:22px;font-weight:700;letter-spacing:-0.02em;color:${EMAIL_COLORS.petrole};">${appName}</p>`;
    }

    const footer = `<p class="vb-foot" style="margin:0 0 8px 0;${EMAIL_STYLES.small}">${footerContent}</p>
              <p class="vb-foot" style="margin:0;${EMAIL_STYLES.small}"><a class="vb-link" href="mailto:${settings.replyToEmail}" style="${EMAIL_STYLES.link}">${settings.replyToEmail}</a></p>`;

    return emailDocument({ title: 'Email Verebona', content: lines.join(''), footer, logo: headerLogoHtml, baseUrl: base });
  }

  /**
   * Lot 70A — rendu d'un gabarit tel qu'il part chez le destinataire : variables,
   * enveloppe de la charte pour un gabarit texte, logo. Utilisé par `send`, par
   * la prévisualisation et l'envoi de test de l'éditeur du BO (même chemin).
   */
  async renderTemplate(
    template: { subject: string; body: string },
    variables: Record<string, string>,
    settingsArg?: any,
  ): Promise<RenderedEmail> {
    const settings = settingsArg ?? (await this.getSettings());
    const computedLogo = await this.getVerebonaEmailLogo();
    const variablesForReplacement = {
      ...withActionLinkAliases(variables ?? {}),
      year: new Date().getFullYear().toString(),
    };
    const subjectRaw = this.replaceVariables(template.subject, variablesForReplacement, settings, computedLogo);
    const bodyProcessed = this.replaceVariables(template.body, variablesForReplacement, settings, computedLogo);
    const all = `${subjectRaw}\n${bodyProcessed}`;
    const unresolved = unresolvedPlaceholders(all);
    const missingLinks = missingActionLinks(all);
    const bodyClean = stripUnresolvedPlaceholders(bodyProcessed);
    const subject = sanitizeSubjectHeader(stripUnresolvedPlaceholders(subjectRaw));

    let html = this.isCompleteHTML(bodyClean) ? bodyClean : await this.wrapInHTML(bodyClean, settings, computedLogo);
    // Normalize logo sizing so the full logo (symbol + text) is readable
    html = this.fixLogoSizing(html);
    const text = bodyClean.replace(/<[^>]*>/g, '').replace(/\n\n+/g, '\n\n');
    return { subject, html, text, unresolved, missingLinks };
  }

  async send(options: {
    templateCode: string;
    to: string;
    variables: Record<string, string>;
    userId?: number;
    /**
     * Ignore l'activation par canal (CDC BO COM-011). Réservé à l'envoi de
     * test vers l'administrateur connecté (COM-010) et au moteur de
     * notifications, qui contrôle lui-même le canal par type d'événement.
     */
    skipChannelCheck?: boolean;
    /** Lot 57A : utilisateur à l'origine de l'envoi (titulaire Duo), distinct du destinataire. */
    triggeredByUserId?: number | null;
    /** Lot 57A : clé d'idempotence transmise à Resend (une par tentative). */
    idempotencyKey?: string;
    /** Lot 57A : envoi durable dont cette ligne est une tentative. */
    emailJobId?: number;
    /**
     * Lot 70A : objet et contenu à utiliser À LA PLACE du gabarit en base —
     * réservé à l'envoi de test d'un brouillon de l'éditeur du BO (vers
     * l'administrateur connecté, avec `skipChannelCheck`).
     */
    templateOverride?: { subject: string; body: string };
  }): Promise<EmailSendResult> {
    const logEntry: any = {
      templateCode: options.templateCode,
      recipientEmail: options.to,
      recipientUserId: options.userId || null,
      triggeredByUserId: options.triggeredByUserId ?? null,
      emailJobId: options.emailJobId ?? null,
      subject: '',
      status: 'pending' as const,
      errorMessage: null,
      sentAt: new Date(),
      metadata: JSON.stringify({
        ...redactActionLinks(options.variables),
        // Lot 70A : test d'un brouillon de l'éditeur du BO (contenu non enregistré).
        ...(options.templateOverride ? { _brouillonBo: 'oui' } : {}),
      }),
    };
    const journaliser = async (): Promise<number | undefined> => {
      const [row] = await db.insert(emailLogs).values(logEntry).returning({ id: emailLogs.id });
      return row?.id;
    };
    
    try {
      const settings = await this.getSettings();
      
      if (!settings.emailsEnabled) {
        logEntry.status = 'failed';
        logEntry.errorMessage = 'Emails disabled globally';
        logEntry.subject = `[Disabled] Email ${options.templateCode}`;
        return { success: false, error: 'Emails disabled', logId: await journaliser() };
      }

      // CDC BO COM-011 : e-mail transactionnel désactivé depuis l'écran
      // Communications. Journalisé « skipped » (ni envoi, ni échec, COM-003).
      if (!options.skipChannelCheck && !(await isTransactionalEmailActive(options.templateCode))) {
        logEntry.status = 'skipped';
        logEntry.errorMessage = 'CHANNEL_DISABLED';
        logEntry.subject = `[Désactivé] Email ${options.templateCode}`;
        return { success: false, error: 'CHANNEL_DISABLED', logId: await journaliser() };
      }

      // ══════════════════════════════════════════════════════════════════
      // QUINZE GABARITS ÉTAIENT INTROUVABLES PAR CONSTRUCTION
      //
      // `toUpperCase()` transformait `notif_document_batch_failed` en
      // `NOTIF_DOCUMENT_BATCH_FAILED`. Or la migration 0077 les a enregistrés
      // EN MINUSCULES : aucun des quinze `notif_*` ne pouvait être trouvé.
      //
      // Le journal d'envois le disait depuis le 2 août, une ligne sur deux :
      //
      //   « Template notif_document_batch_failed not found »
      //
      // alors que ce gabarit figure bien en base. Toutes les notifications
      // par email échouaient — échéances, quotas, incidents de paiement,
      // invitations, parrainage.
      //
      // La comparaison est désormais insensible à la casse, plutôt que de
      // renommer quinze lignes : le code appelant emploie les deux
      // conventions, et forcer l'une d'elles casserait l'autre.
      // ══════════════════════════════════════════════════════════════════
      const templates = options.templateOverride
        ? [options.templateOverride]
        : await db
          .select({ subject: emailTemplates.subject, body: emailTemplates.body })
          .from(emailTemplates)
          .where(sql`upper(${emailTemplates.type}) = upper(${options.templateCode})`)
          .limit(1);

      if (templates.length === 0) {
        const error = `Template ${options.templateCode} not found`;
        logEntry.status = 'failed';
        logEntry.errorMessage = error;
        logEntry.subject = `[Error] Template not found`;
        return { success: false, error, logId: await journaliser() };
      }

      const template = templates[0];
      // Lot 70A : rendu partagé avec la prévisualisation et le test de l'éditeur du BO.
      const rendered = await this.renderTemplate(template, options.variables ?? {}, settings);
      const subject = rendered.subject;

      // Variable attendue par le gabarit mais non fournie par l'appelant (ex.
      // bouton d'invitation Duo inopérant, 12/10/2026) : signalé dans les
      // journaux et dans le journal des e-mails (BO), sans bloquer l'envoi —
      // un e-mail critique (mot de passe, sécurité) ne doit jamais être retenu.
      // Lot 70A : la variable est retirée du rendu (aucune accolade envoyée).
      const unresolved = rendered.unresolved;
      if (unresolved.length > 0) {
        console.error(`[EmailService] ${options.templateCode} : variables non fournies ${unresolved.join(', ')}`);
        logEntry.errorMessage = `Variables non fournies : ${unresolved.join(', ')}`;
      }

      logEntry.subject = subject;

      // Lot 53 : une invitation dont le lien n'est pas remplacé est
      // inutilisable (bouton « Accepter » mort) — elle n'est pas envoyée, et
      // l'échec est visible dans le journal des e-mails du BO avec son motif.
      const liensManquants = LINK_REQUIRED_TEMPLATES.has(options.templateCode.toUpperCase())
        ? rendered.missingLinks
        : [];
      if (liensManquants.length > 0) {
        const error = `Lien manquant : ${liensManquants.join(', ')} — e-mail non envoyé`;
        console.error(`[EmailService] ${options.templateCode} : ${error}`);
        logEntry.status = 'failed';
        logEntry.errorMessage = error;
        return { success: false, error: 'MISSING_ACTION_LINK', logId: await journaliser() };
      }

      const htmlBody = rendered.html;
      const bodyText = rendered.text;

      if (!process.env.RESEND_API_KEY) {
        logEntry.status = 'failed';
        logEntry.errorMessage = 'Resend API key not configured';
        return { success: false, error: 'Email provider not configured', logId: await journaliser() };
      }
      
      const { data, error } = await this.resend.emails.send({
        from: `${settings.senderName} <${settings.senderEmail}>`,
        to: options.to,
        subject,
        html: htmlBody,
        text: bodyText,
        replyTo: settings.replyToEmail,
      }, options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined);
      
      if (error) {
        logEntry.status = 'failed';
        // Lot 57A : le CODE Resend (validation_error, invalid_from_address,
        // rate_limit_exceeded…) précède le message — cause lisible dans le BO.
        const code = (error as { name?: string }).name;
        logEntry.errorMessage = `${code ? `[${code}] ` : ''}${error.message || JSON.stringify(error)}`;
        return { success: false, error: error.message, logId: await journaliser() };
      }
      
      // `sent` = ACCEPTÉ par Resend (sens inchangé). La livraison est suivie à
      // part (`delivery_status`, webhooks Resend — lot 57A).
      logEntry.status = 'sent';
      const providerMessageId = (data as { id?: string } | null)?.id ?? null;
      logEntry.providerMessageId = providerMessageId;
      logEntry.deliveryStatus = 'accepted';
      logEntry.deliveryStatusAt = new Date();
      const logId = await journaliser();
      if (providerMessageId) {
        // Webhook arrivé AVANT cette écriture (ordre indifférent) : rejoué ici.
        try {
          const { replayStoredProviderEvents } = await import('@/services/email/email-provider-events.service');
          await replayStoredProviderEvents(providerMessageId);
        } catch (e) {
          console.error('[EmailService] rejeu des événements Resend impossible :', (e as Error)?.message ?? e);
        }
      }
      
      return { success: true, logId, providerMessageId };
      
    } catch (err) {
      console.error('❌ EmailService error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      logEntry.status = 'failed';
      logEntry.errorMessage = errorMessage;
      
      let logId: number | undefined;
      try {
        logId = await journaliser();
      } catch (logError) {}
      
      return { success: false, error: errorMessage, logId };
    }
  }
  
  /**
   * Envoi de test. Les variables sont OBLIGATOIRES : elles proviennent du
   * propre compte de l'administrateur connecté (CDC BO COM-007, SEC-005). Le
   * jeu de données fictives codé en dur a été retiré.
   */
  async sendTest(
    templateCode: string,
    testEmail: string,
    variables: Record<string, string>,
  ): Promise<EmailSendResult> {
    return this.send({ templateCode, to: testEmail, variables, skipChannelCheck: true });
  }

  /**
   * Lot 70A — envoi de test d'un BROUILLON de l'éditeur du BO (objet et contenu
   * en cours d'édition, non enregistrés) vers l'administrateur connecté.
   */
  async sendDraftTest(
    templateCode: string,
    testEmail: string,
    draft: { subject: string; body: string },
    variables: Record<string, string>,
  ): Promise<EmailSendResult> {
    return this.send({ templateCode, to: testEmail, variables, skipChannelCheck: true, templateOverride: draft });
  }
}

export const emailService = new EmailService();