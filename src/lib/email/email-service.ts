import { Resend } from 'resend';
import { db } from '@/db';
import { emailTemplates, emailSettings, emailLogs, systemLogos } from '@/db/schema';
import { eq, or } from 'drizzle-orm';

// Couleur Verebona fixe
const VEREBONA_PRIMARY_COLOR = '#3B82F6';

type LogoResult = {
  content: string;
  type: 'url' | 'html' | 'none';
};

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
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || 'https://verebona.vercel.app';
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
    const html = `
      <table cellpadding="0" cellspacing="0" border="0" style="margin: 0 auto; border-collapse: collapse;">
        <tr>
          <td valign="middle" style="padding-right: 10px;">
            <!-- Sigle Verebona : grille 3x3 de carrés avec le carré haut-droite en bleu -->
            <table cellpadding="0" cellspacing="2" border="0" style="border-collapse: separate; border-spacing: 2px;">
              <tr>
                <td style="width:10px;height:10px;background-color:#2D3748;border-radius:2px;"></td>
                <td style="width:10px;height:10px;background-color:#2D3748;border-radius:2px;"></td>
                <td style="width:10px;height:10px;background-color:#3B82F6;border-radius:2px;"></td>
              </tr>
              <tr>
                <td style="width:10px;height:10px;background-color:#2D3748;border-radius:2px;"></td>
                <td style="width:10px;height:10px;background-color:#2D3748;border-radius:2px;"></td>
                <td style="width:10px;height:10px;background-color:#2D3748;border-radius:2px;"></td>
              </tr>
              <tr>
                <td style="width:10px;height:10px;background-color:#2D3748;border-radius:2px;"></td>
                <td style="width:10px;height:10px;background-color:#2D3748;border-radius:2px;"></td>
                <td style="width:10px;height:10px;background-color:#2D3748;border-radius:2px;"></td>
              </tr>
            </table>
          </td>
          <td valign="middle">
            <span style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; font-size: 26px; font-weight: 700; color: #2D3748; letter-spacing: -0.5px;">Verebona</span>
          </td>
        </tr>
      </table>
    `;
    return { content: html, type: 'html' };
  }
  
  /**
   * Wrapper HTML premium Verebona pour les emails
   */
  private async wrapInHTML(bodyText: string, settings: any, computedLogo: LogoResult): Promise<string> {
    // Convertir les sauts de ligne en paragraphes
    const lines = bodyText.split('\n').map(line => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return `<p style="margin: 0 0 16px 0; text-align: center;">
          <a href="${trimmed}" style="display: inline-block; background-color: ${VEREBONA_PRIMARY_COLOR}; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600;">
            Cliquez ici
          </a>
        </p>`;
      }
      
      return `<p style="margin: 0 0 16px 0; color: #374151; line-height: 1.6;">${trimmed}</p>`;
    });
    
    const currentYear = new Date().getFullYear();
    const footerContent = settings.footerText || `© ${currentYear} Verebona. Tous droits réservés.`;
    const appName = settings.senderName || 'Verebona';

    // Génération du Header Logo
    let headerLogoHtml = '';
    
    if (computedLogo.type === 'html') {
      // Utiliser directement le bloc HTML (tableau centré)
      headerLogoHtml = `
        <div style="text-align: center; width: 100%;">
          <center>
            ${computedLogo.content}
          </center>
        </div>
      `;
    } else {
      let logoUrl = computedLogo.content || settings.logoUrlLight || settings.logoUrl;
      logoUrl = this.makeAbsoluteUrl(logoUrl);

      // Fallback robuste si SVG ou manquant
      if (!logoUrl || logoUrl.toLowerCase().endsWith('.svg')) {
        logoUrl = 'https://slelguoygbfzlpylpxfs.supabase.co/storage/v1/object/public/project-uploads/5da8aa09-2540-4b03-96bf-bb17130a3250/generated_images/verebona-logo-on-transparent-background--55a5d30d-20251121000738.jpg';
      }

      headerLogoHtml = `
        <div style="text-align: center; width: 100%;">
          <center>
            <table cellpadding="0" cellspacing="0" border="0" style="margin: 0 auto;">
              <tr>
                <td align="center" style="text-align: center;">
                  <img 
                    src="${logoUrl}" 
                    alt="${appName}" 
                    width="400"
                    style="display: block; width: 400px; max-width: 100%; height: auto; border: 0; outline: none; margin-left: auto; margin-right: auto;"
                  />
                </td>
              </tr>
            </table>
          </center>
        </div>
      `;
    }

    if (computedLogo.type === 'none' && !settings.logoUrl) {
      headerLogoHtml = `
        <div style="text-align: center; width: 100%;">
          <center>
            <h1 style="margin: 0; color: ${VEREBONA_PRIMARY_COLOR}; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">
              ${appName}
            </h1>
          </center>
        </div>
      `;
    }
    
    return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Email Verebona</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <center>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f5f5f5; padding: 40px 20px;">
      <tr>
        <td align="center">
          <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); max-width: 600px; margin: 0 auto;">
            
            <!-- Header -->
            <tr>
              <td align="center" style="padding: 30px 20px 20px 20px; border-bottom: 2px solid ${VEREBONA_PRIMARY_COLOR}; text-align: center;">
                ${headerLogoHtml}
              </td>
            </tr>
            
            <!-- Body -->
            <tr>
              <td style="padding: 40px; font-size: 16px;">
                ${lines.join('')}
              </td>
            </tr>
            
            <!-- Footer -->
            <tr>
              <td style="padding: 30px 40px; text-align: center; border-top: 1px solid #e5e7eb; background-color: #f9fafb;">
                <p style="margin: 0 0 8px 0; font-size: 13px; color: #6b7280; line-height: 1.5;">
                  ${footerContent}
                </p>
                <p style="margin: 0; font-size: 12px; color: #9ca3af;">
                  <a href="mailto:${settings.replyToEmail}" style="color: ${VEREBONA_PRIMARY_COLOR}; text-decoration: none;">
                    ${settings.replyToEmail}
                  </a>
                </p>
              </td>
            </tr>
            
          </table>
        </td>
      </tr>
    </table>
  </center>
</body>
</html>`;
  }
  
  async send(options: {
    templateCode: string;
    to: string;
    variables: Record<string, string>;
    userId?: number;
  }): Promise<{success: boolean, error?: string}> {
    const logEntry: any = {
      templateCode: options.templateCode,
      recipientEmail: options.to,
      recipientUserId: options.userId || null,
      subject: '',
      status: 'pending' as const,
      errorMessage: null,
      sentAt: new Date(),
      metadata: JSON.stringify(options.variables),
    };
    
    try {
      const settings = await this.getSettings();
      
      if (!settings.emailsEnabled) {
        logEntry.status = 'failed';
        logEntry.errorMessage = 'Emails disabled globally';
        logEntry.subject = `[Disabled] Email ${options.templateCode}`;
        await db.insert(emailLogs).values(logEntry);
        return { success: false, error: 'Emails disabled' };
      }
      
      const templates = await db
        .select()
        .from(emailTemplates)
        .where(eq(emailTemplates.type, options.templateCode.toUpperCase()))
        .limit(1);
      
      if (templates.length === 0) {
        const error = `Template ${options.templateCode} not found`;
        logEntry.status = 'failed';
        logEntry.errorMessage = error;
        logEntry.subject = `[Error] Template not found`;
        await db.insert(emailLogs).values(logEntry);
        return { success: false, error };
      }
      
      const template = templates[0];
      const computedLogo = await this.getVerebonaEmailLogo();

      const variablesForReplacement = {
        ...options.variables,
        year: new Date().getFullYear().toString(),
      };
      
      const subject = this.replaceVariables(template.subject, variablesForReplacement, settings, computedLogo);
      let bodyProcessed = this.replaceVariables(template.body, variablesForReplacement, settings, computedLogo);

      logEntry.subject = subject;

      let htmlBody = this.isCompleteHTML(bodyProcessed)
        ? bodyProcessed
        : await this.wrapInHTML(bodyProcessed, settings, computedLogo);

      // Normalize logo sizing so the full logo (symbol + text) is readable
      htmlBody = this.fixLogoSizing(htmlBody);
      
      const bodyText = bodyProcessed.replace(/<[^>]*>/g, '').replace(/\n\n+/g, '\n\n');
      
      if (!process.env.RESEND_API_KEY) {
        logEntry.status = 'failed';
        logEntry.errorMessage = 'Resend API key not configured';
        await db.insert(emailLogs).values(logEntry);
        return { success: false, error: 'Email provider not configured' };
      }
      
      const { data, error } = await this.resend.emails.send({
        from: `${settings.senderName} <${settings.senderEmail}>`,
        to: options.to,
        subject,
        html: htmlBody,
        text: bodyText,
        replyTo: settings.replyToEmail,
      });
      
      if (error) {
        logEntry.status = 'failed';
        logEntry.errorMessage = error.message || JSON.stringify(error);
        await db.insert(emailLogs).values(logEntry);
        return { success: false, error: error.message };
      }
      
      logEntry.status = 'sent';
      await db.insert(emailLogs).values(logEntry);
      
      return { success: true };
      
    } catch (err) {
      console.error('❌ EmailService error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      logEntry.status = 'failed';
      logEntry.errorMessage = errorMessage;
      
      try {
        await db.insert(emailLogs).values(logEntry);
      } catch (logError) {}
      
      return { success: false, error: errorMessage };
    }
  }
  
  async sendTest(templateCode: string, testEmail: string): Promise<{success: boolean, error?: string}> {
    const mockVariables: Record<string, string> = {
      // Generic
      firstName: 'John',
      lastName: 'Doe',
      email: testEmail,
      // Auth
      verificationUrl: 'https://verebona.app/verify-email?token=abc123xyz',
      resetUrl: 'https://verebona.app/reset-password?token=def456uvw',
      expiresAt: '1 heure',
      loginUrl: 'https://verebona.app/login',
      // Assets / agenda
      assetName: 'Appartement Paris 15',
      deadlineLabel: 'Assurance habitation',
      deadlineDate: '15 janvier 2025',
      // DUO invitation
      ownerFirstName: 'Geoffroy',
      ownerLastName: 'Maupilier',
      ownerFullName: 'Geoffroy Maupilier',
      inviteUrl: 'https://verebona.app/duo/join/test-token-preview',
      expiresIn: '7 jours',
      // Premium confirmation
      nextBillingDate: '7 avril 2027',
      manageSubscriptionUrl: 'https://verebona.app/mon-compte/offres',
      planType: 'Premium',
      expiryDate: '7 avril 2027',
      renewUrl: 'https://verebona.app/abonnement',
      feature1: 'Biens illimités',
      feature2: 'Documents illimités',
      feature3: 'Partage multi-utilisateurs',
    };
    
    return this.send({
      templateCode,
      to: testEmail,
      variables: mockVariables,
    });
  }
}

export const emailService = new EmailService();