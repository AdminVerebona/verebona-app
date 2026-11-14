-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1698 : gabarits e-mail « Clé d'accès ajoutée » et « Application
-- d'authentification activée » (lot 114M — Trello #774).
--
-- Deux gabarits DÉDIÉS, distincts au niveau métier, construits sur le gabarit
-- transactionnel COMMUN (`src/lib/email/transactional-template.ts`) : objet,
-- pré-en-tête et titre propres à l'événement, « vous êtes à l'origine » /
-- « vous ne reconnaissez pas », marche à suivre numérotée, bouton « Vérifier
-- la sécurité de mon compte », pied commun.
--
--   notif_mfa_passkey_added : événement MFA_SECURITY_EVENT / passkey_added
--   notif_mfa_totp_enabled  : événement MFA_SECURITY_EVENT / totp_enabled
--
-- Aucun nouvel envoi : ces deux natures de l'événement EXISTANT changent de
-- gabarit (`lib/notifications/catalog.ts`) ; file d'envoi, déduplication,
-- obligation (e-mail non désactivable) et journal inchangés. Les autres
-- natures (clé retirée, application remplacée / retirée, codes de
-- récupération) gardent `notif_security`, qui n'est PAS modifié.
-- Si cette migration n'est pas appliquée, l'e-mail part avec `notif_security`
-- (repli du code) : rien ne casse.
--
-- Variables fournies par l'application : {{eventWhen}} (date et heure réelles
-- de l'événement, Europe/Paris), {{actionUrl}} (Mon compte › Sécurité, sans
-- jeton), {{supportEmail}} (adresse d'assistance des réglages e-mail),
-- {{year}}, {{logoUrl}}. Aucun secret, aucun code, aucun identifiant de clé.
--
-- Corps : ceux de `src/lib/email/security-notification-templates.ts`, à
-- l'octet près (contrôlé par `__tests__/l114m-emails-securite.test.ts`).
-- Texte modifiable dans le BO (Communications, édition par zones de texte) ;
-- idempotente : DO NOTHING pour ne pas écraser un gabarit retouché.
-- Additive (expand seulement) : aucune table, aucune colonne.
-- ──────────────────────────────────────────────────────────────────────────────

INSERT INTO email_templates (type, subject, body, placeholders, updated_at) VALUES
  ('notif_mfa_passkey_added',
   'Une clé d''accès a été ajoutée à votre compte Verebona',
   $l114m$<!DOCTYPE html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Une clé d'accès a été ajoutée à votre compte Verebona</title>
  <style type="text/css">
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body, table, td, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; }
  img { -ms-interpolation-mode:bicubic; }
  a.vb-btn:hover { background-color:#10383E !important; border-color:#10383E !important; }
  @media screen and (max-width:620px) {
    .vb-container { width:100% !important; }
    .vb-pad { padding-left:24px !important; padding-right:24px !important; }
  }
  @media (prefers-color-scheme: dark) {
   .vb-page, .vb-page { background-color:#1B2529 !important; }
   .vb-card { background-color:#26353B !important; border-color:#3A4A51 !important; }
   .vb-head,  .vb-rule { border-color:#3A4A51 !important; }
   .vb-text,  .vb-text p,  .vb-text li,  .vb-text td,  .vb-text span,  .vb-text strong,  .vb-text h1,  .vb-text h2 { color:#F3F1EB !important; }
   .vb-text .vb-muted,  .vb-muted,  .vb-foot,  .vb-foot p { color:#A7B6B9 !important; }
   .vb-text .vb-eyebrow,  .vb-eyebrow { color:#E2896F !important; }
   .vb-wordmark { color:#F3F1EB !important; }
   a,  .vb-text a,  .vb-link { color:#9FD3CC !important; }
   .vb-btn-td { background-color:#9FD3CC !important; }
   a.vb-btn,  .vb-text a.vb-btn { background-color:#9FD3CC !important; border-color:#9FD3CC !important; color:#1B2529 !important; }
   .vb-callout { background-color:#2A4347 !important; border-color:#3E5F63 !important; }
   .vb-attention { background-color:#3D302C !important; border-color:#5A4038 !important; }
    .vb-logo-light { display:none !important; max-height:0 !important; }
    .vb-logo-dark { display:block !important; max-height:none !important; overflow:visible !important; }
  }
  [data-ogsc] .vb-page, [data-ogsc].vb-page { background-color:#1B2529 !important; }
  [data-ogsc] .vb-card { background-color:#26353B !important; border-color:#3A4A51 !important; }
  [data-ogsc] .vb-head, [data-ogsc] .vb-rule { border-color:#3A4A51 !important; }
  [data-ogsc] .vb-text, [data-ogsc] .vb-text p, [data-ogsc] .vb-text li, [data-ogsc] .vb-text td, [data-ogsc] .vb-text span, [data-ogsc] .vb-text strong, [data-ogsc] .vb-text h1, [data-ogsc] .vb-text h2 { color:#F3F1EB !important; }
  [data-ogsc] .vb-text .vb-muted, [data-ogsc] .vb-muted, [data-ogsc] .vb-foot, [data-ogsc] .vb-foot p { color:#A7B6B9 !important; }
  [data-ogsc] .vb-text .vb-eyebrow, [data-ogsc] .vb-eyebrow { color:#E2896F !important; }
  [data-ogsc] .vb-wordmark { color:#F3F1EB !important; }
  [data-ogsc] a, [data-ogsc] .vb-text a, [data-ogsc] .vb-link { color:#9FD3CC !important; }
  [data-ogsc] .vb-btn-td { background-color:#9FD3CC !important; }
  [data-ogsc] a.vb-btn, [data-ogsc] .vb-text a.vb-btn { background-color:#9FD3CC !important; border-color:#9FD3CC !important; color:#1B2529 !important; }
  [data-ogsc] .vb-callout { background-color:#2A4347 !important; border-color:#3E5F63 !important; }
  [data-ogsc] .vb-attention { background-color:#3D302C !important; border-color:#5A4038 !important; }
  [data-ogsc] .vb-logo-light { display:none !important; }
  [data-ogsc] .vb-logo-dark { display:block !important; max-height:none !important; }
  @media screen and (max-width:620px) {
    .vb-outer { padding:12px 8px !important; }
  }
</style>
</head>
<body class="vb-page" data-vb-gabarit="transactionnel-v1" style="margin:0;padding:0;background-color:#F8F6F1;font-family:'Figtree', Arial, Helvetica, sans-serif;color:#26353B;">
  <div data-vb-preheader="1" style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:#F8F6F1;">Vérifiez cet ajout si vous n'en êtes pas à l'origine.</div>
  <table role="presentation" class="vb-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F8F6F1" style="background-color:#F8F6F1;">
    <tr>
      <td class="vb-outer" align="center" style="padding:24px 12px;">
        <!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <table role="presentation" class="vb-container vb-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:100%;max-width:600px;background-color:#FFFFFF;border:1px solid #D5DEDC;border-radius:16px;border-collapse:separate;">
          <tr>
            <td class="vb-pad" align="left" style="padding:20px 24px 0 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>
                <td align="left" valign="middle" style="padding:0;">{{logoUrl}}</td>
                <td class="vb-muted" align="right" valign="middle" style="padding:0 0 0 12px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.4;font-weight:600;color:#52636A;text-align:right;">Notification de sécurité</td>
              </tr></table>
            </td>
          </tr>
          <tr>
            <td class="vb-text vb-pad" align="left" style="padding:20px 24px 8px 24px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">
              <h1 style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-.01em;color:#17474D;">Une nouvelle clé d'accès a été ajoutée</h1>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Une clé d'accès a été enregistrée sur votre compte Verebona {{eventWhen}}.</p>
<h2 style="margin:0 0 12px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#17474D;margin-top:24px;">Vous êtes à l'origine de cet ajout ?</h2>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Aucune action n'est nécessaire.</p>
<h2 style="margin:0 0 12px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#17474D;margin-top:24px;">Vous ne reconnaissez pas cet ajout ?</h2>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Vérifiez immédiatement les méthodes de connexion associées à votre compte :</p>
<ol style="margin:0 0 16px 0;padding:0 0 0 24px;"><li style="margin:0 0 8px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Supprimez toute clé d'accès inconnue.</li><li style="margin:0 0 8px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Déconnectez les appareils/sessions suspects si l'application permet de le faire.</li><li style="margin:0 0 8px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Changez votre mot de passe.</li></ol>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Si vous ne parvenez pas à sécuriser votre compte, contactez l'assistance Verebona.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 24px;border-collapse:separate;"><tr><td class="vb-btn-td" align="center" bgcolor="#17474D" style="border-radius:12px;background-color:#17474D;"><a class="vb-btn" href="{{actionUrl}}" target="_blank" style="display:inline-block;padding:15px 26px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;font-weight:700;line-height:1.2;color:#FFFFFF;text-decoration:none;border-radius:12px;background-color:#17474D;border:1px solid #17474D;">Vérifier la sécurité de mon compte</a></td></tr></table>
<p class="vb-muted" style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:14px;line-height:1.55;color:#52636A;text-align:center;">Vous pouvez également ouvrir Verebona directement et accéder à Mon compte &gt; Sécurité.</p>
            </td>
          </tr>
        </table>
        <table role="presentation" class="vb-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
          <tr>
            <td class="vb-foot vb-pad" align="center" style="padding:16px 24px 8px 24px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;text-align:center;">
              <p class="vb-foot" style="margin:0 0 6px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">Besoin d'aide ? Contactez l'assistance Verebona.</p>
<p class="vb-foot" style="margin:0 0 6px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;"><a class="vb-link" href="mailto:{{supportEmail}}" style="color:#17474D;text-decoration:underline;font-weight:600;">{{supportEmail}}</a></p>
<p class="vb-foot" style="margin:0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">© {{year}} Verebona</p>
            </td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>$l114m$,
   '["eventWhen","actionUrl","supportEmail","year","logoUrl"]', NOW())
ON CONFLICT (type) DO NOTHING;

INSERT INTO email_templates (type, subject, body, placeholders, updated_at) VALUES
  ('notif_mfa_totp_enabled',
   'Une application d''authentification a été activée sur votre compte Verebona',
   $l114m$<!DOCTYPE html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Une application d'authentification a été activée sur votre compte Verebona</title>
  <style type="text/css">
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body, table, td, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; }
  img { -ms-interpolation-mode:bicubic; }
  a.vb-btn:hover { background-color:#10383E !important; border-color:#10383E !important; }
  @media screen and (max-width:620px) {
    .vb-container { width:100% !important; }
    .vb-pad { padding-left:24px !important; padding-right:24px !important; }
  }
  @media (prefers-color-scheme: dark) {
   .vb-page, .vb-page { background-color:#1B2529 !important; }
   .vb-card { background-color:#26353B !important; border-color:#3A4A51 !important; }
   .vb-head,  .vb-rule { border-color:#3A4A51 !important; }
   .vb-text,  .vb-text p,  .vb-text li,  .vb-text td,  .vb-text span,  .vb-text strong,  .vb-text h1,  .vb-text h2 { color:#F3F1EB !important; }
   .vb-text .vb-muted,  .vb-muted,  .vb-foot,  .vb-foot p { color:#A7B6B9 !important; }
   .vb-text .vb-eyebrow,  .vb-eyebrow { color:#E2896F !important; }
   .vb-wordmark { color:#F3F1EB !important; }
   a,  .vb-text a,  .vb-link { color:#9FD3CC !important; }
   .vb-btn-td { background-color:#9FD3CC !important; }
   a.vb-btn,  .vb-text a.vb-btn { background-color:#9FD3CC !important; border-color:#9FD3CC !important; color:#1B2529 !important; }
   .vb-callout { background-color:#2A4347 !important; border-color:#3E5F63 !important; }
   .vb-attention { background-color:#3D302C !important; border-color:#5A4038 !important; }
    .vb-logo-light { display:none !important; max-height:0 !important; }
    .vb-logo-dark { display:block !important; max-height:none !important; overflow:visible !important; }
  }
  [data-ogsc] .vb-page, [data-ogsc].vb-page { background-color:#1B2529 !important; }
  [data-ogsc] .vb-card { background-color:#26353B !important; border-color:#3A4A51 !important; }
  [data-ogsc] .vb-head, [data-ogsc] .vb-rule { border-color:#3A4A51 !important; }
  [data-ogsc] .vb-text, [data-ogsc] .vb-text p, [data-ogsc] .vb-text li, [data-ogsc] .vb-text td, [data-ogsc] .vb-text span, [data-ogsc] .vb-text strong, [data-ogsc] .vb-text h1, [data-ogsc] .vb-text h2 { color:#F3F1EB !important; }
  [data-ogsc] .vb-text .vb-muted, [data-ogsc] .vb-muted, [data-ogsc] .vb-foot, [data-ogsc] .vb-foot p { color:#A7B6B9 !important; }
  [data-ogsc] .vb-text .vb-eyebrow, [data-ogsc] .vb-eyebrow { color:#E2896F !important; }
  [data-ogsc] .vb-wordmark { color:#F3F1EB !important; }
  [data-ogsc] a, [data-ogsc] .vb-text a, [data-ogsc] .vb-link { color:#9FD3CC !important; }
  [data-ogsc] .vb-btn-td { background-color:#9FD3CC !important; }
  [data-ogsc] a.vb-btn, [data-ogsc] .vb-text a.vb-btn { background-color:#9FD3CC !important; border-color:#9FD3CC !important; color:#1B2529 !important; }
  [data-ogsc] .vb-callout { background-color:#2A4347 !important; border-color:#3E5F63 !important; }
  [data-ogsc] .vb-attention { background-color:#3D302C !important; border-color:#5A4038 !important; }
  [data-ogsc] .vb-logo-light { display:none !important; }
  [data-ogsc] .vb-logo-dark { display:block !important; max-height:none !important; }
  @media screen and (max-width:620px) {
    .vb-outer { padding:12px 8px !important; }
  }
</style>
</head>
<body class="vb-page" data-vb-gabarit="transactionnel-v1" style="margin:0;padding:0;background-color:#F8F6F1;font-family:'Figtree', Arial, Helvetica, sans-serif;color:#26353B;">
  <div data-vb-preheader="1" style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:#F8F6F1;">Si vous n'êtes pas à l'origine de cette activation, vérifiez la sécurité de votre compte.</div>
  <table role="presentation" class="vb-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F8F6F1" style="background-color:#F8F6F1;">
    <tr>
      <td class="vb-outer" align="center" style="padding:24px 12px;">
        <!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <table role="presentation" class="vb-container vb-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:100%;max-width:600px;background-color:#FFFFFF;border:1px solid #D5DEDC;border-radius:16px;border-collapse:separate;">
          <tr>
            <td class="vb-pad" align="left" style="padding:20px 24px 0 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>
                <td align="left" valign="middle" style="padding:0;">{{logoUrl}}</td>
                <td class="vb-muted" align="right" valign="middle" style="padding:0 0 0 12px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.4;font-weight:600;color:#52636A;text-align:right;">Notification de sécurité</td>
              </tr></table>
            </td>
          </tr>
          <tr>
            <td class="vb-text vb-pad" align="left" style="padding:20px 24px 8px 24px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">
              <h1 style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-.01em;color:#17474D;">Application d'authentification activée</h1>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Une application d'authentification a été activée sur votre compte Verebona {{eventWhen}}.</p>
<h2 style="margin:0 0 12px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#17474D;margin-top:24px;">Vous êtes à l'origine de cette activation ?</h2>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Aucune action n'est nécessaire.</p>
<h2 style="margin:0 0 12px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:18px;line-height:1.3;font-weight:700;color:#17474D;margin-top:24px;">Vous ne reconnaissez pas cette activation ?</h2>
<ol style="margin:0 0 16px 0;padding:0 0 0 24px;"><li style="margin:0 0 8px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Ouvrez Verebona, puis Mon compte &gt; Sécurité.</li><li style="margin:0 0 8px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Vérifiez les méthodes de connexion et désactivez la méthode d'authentification inconnue.</li><li style="margin:0 0 8px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Vérifiez les appareils ou sessions suspects et révoquez-les si cette fonction existe.</li><li style="margin:0 0 8px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Changez votre mot de passe.</li></ol>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Si vous ne parvenez pas à sécuriser votre compte, contactez l'assistance Verebona.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 24px;border-collapse:separate;"><tr><td class="vb-btn-td" align="center" bgcolor="#17474D" style="border-radius:12px;background-color:#17474D;"><a class="vb-btn" href="{{actionUrl}}" target="_blank" style="display:inline-block;padding:15px 26px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;font-weight:700;line-height:1.2;color:#FFFFFF;text-decoration:none;border-radius:12px;background-color:#17474D;border:1px solid #17474D;">Vérifier la sécurité de mon compte</a></td></tr></table>
<p class="vb-muted" style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:14px;line-height:1.55;color:#52636A;text-align:center;">Vous pouvez également ouvrir Verebona directement et accéder à Mon compte &gt; Sécurité.</p>
            </td>
          </tr>
        </table>
        <table role="presentation" class="vb-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
          <tr>
            <td class="vb-foot vb-pad" align="center" style="padding:16px 24px 8px 24px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;text-align:center;">
              <p class="vb-foot" style="margin:0 0 6px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">Besoin d'aide ? Contactez l'assistance Verebona.</p>
<p class="vb-foot" style="margin:0 0 6px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;"><a class="vb-link" href="mailto:{{supportEmail}}" style="color:#17474D;text-decoration:underline;font-weight:600;">{{supportEmail}}</a></p>
<p class="vb-foot" style="margin:0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">© {{year}} Verebona</p>
            </td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>$l114m$,
   '["eventWhen","actionUrl","supportEmail","year","logoUrl"]', NOW())
ON CONFLICT (type) DO NOTHING;
