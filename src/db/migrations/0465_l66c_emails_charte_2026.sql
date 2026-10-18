-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0465 — Lot 66C : e-mails transactionnels à la charte « Sérénité » 2026
--
-- Met à jour la MISE EN PAGE des gabarits HTML complets livrés par Verebona
-- (amorçages /api/cron/seed ; WITHDRAWAL_RECEIPT aussi par 0279) avec le corps
-- de `src/lib/email/email-html-templates.ts` — mêmes textes, mêmes variables,
-- mêmes liens (contrôlé par src/lib/email/__tests__/l66c-email-charte.test.ts).
--
-- JAMAIS d'écrasement d'une personnalisation : un gabarit n'est remplacé que si
--   · son corps est, octet pour octet, celui livré au lot 65 (md5), OU
--   · il n'a jamais été enregistré depuis le back-office (updated_by IS NULL) ET
--     son TEXTE visible (balises, <head> et commentaires retirés, espaces
--     normalisés) est exactement celui livré au lot 65 — cas d'un corps plus
--     ancien retouché en place par 0140 / 0307 sans changement de texte.
-- Tout autre corps (texte modifié, enregistré depuis le BO) est laissé tel quel.
--
-- Les gabarits TEXTE (vérification d'adresse, mot de passe, Duo, notifications…)
-- ne sont pas touchés : leur mise en page est l'enveloppe du code (wrapInHTML).
-- Idempotente : un corps déjà à jour ne correspond plus à aucune empreinte.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION l66c_email_text(b text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT btrim(regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(b, '<head.*?</head>', ' ', 'gi'),
             '<!--.*?-->', ' ', 'g'),
           '<[^>]*>', ' ', 'g'),
         '\s+', ' ', 'g'))
$fn$;

-- WELCOME
UPDATE email_templates
SET body = $l66c$<!DOCTYPE html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Bienvenue sur Verebona</title>
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
</style>
</head>
<body class="vb-page" style="margin:0;padding:0;background-color:#F8F6F1;font-family:'Figtree', Arial, Helvetica, sans-serif;color:#26353B;">
  <table role="presentation" class="vb-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F8F6F1" style="background-color:#F8F6F1;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" class="vb-container vb-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:600px;max-width:600px;background-color:#FFFFFF;border:1px solid #D5DEDC;border-radius:16px;border-collapse:separate;">
          <tr>
            <td class="vb-head vb-pad" align="left" style="padding:28px 40px 22px 40px;border-bottom:1px solid #E2EBE9;">
              {{logoUrl}}
            </td>
          </tr>
          <tr>
            <td class="vb-text vb-pad" align="left" style="padding:32px 40px 16px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">
              <p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Bonjour {{firstName}},</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Bienvenue sur <strong>Verebona</strong> — votre espace personnel pour organiser, suivre et valoriser l'ensemble de vos biens et documents importants.</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Votre compte est maintenant activé. Vous pouvez vous connecter dès maintenant :</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 24px;border-collapse:separate;"><tr><td class="vb-btn-td" align="center" bgcolor="#17474D" style="border-radius:12px;background-color:#17474D;"><a class="vb-btn" href="{{loginUrl}}" target="_blank" style="display:inline-block;padding:15px 26px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;font-weight:700;line-height:1.2;color:#FFFFFF;text-decoration:none;border-radius:12px;background-color:#17474D;border:1px solid #17474D;">Accéder à mon espace</a></td></tr></table>
<p class="vb-muted" style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:14px;line-height:1.55;color:#52636A;">Si vous n'êtes pas à l'origine de cette inscription, vous pouvez ignorer ce message.</p>
            </td>
          </tr>
        </table>
        <table role="presentation" class="vb-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
          <tr>
            <td class="vb-foot vb-pad" align="center" style="padding:20px 40px 8px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;text-align:center;">
              <p class="vb-foot" style="margin:0 0 6px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">© {{year}} Verebona • Tous droits réservés</p>
<p class="vb-foot" style="margin:0 0 0px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">One place. Higher value</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>$l66c$,
    updated_at = now()
WHERE upper(type) = 'WELCOME'
  AND (md5(body) = '551f6a8019e11ab3572dbdf9dbc3c872'
       OR (updated_by IS NULL AND md5(l66c_email_text(body)) = 'f7e9effc0ccfb10041c645673e665ec0'));

-- PREMIUM_CONFIRMATION
UPDATE email_templates
SET body = $l66c$<!DOCTYPE html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Confirmation de votre abonnement Verebona Premium</title>
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
</style>
</head>
<body class="vb-page" style="margin:0;padding:0;background-color:#F8F6F1;font-family:'Figtree', Arial, Helvetica, sans-serif;color:#26353B;">
  <table role="presentation" class="vb-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F8F6F1" style="background-color:#F8F6F1;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" class="vb-container vb-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:600px;max-width:600px;background-color:#FFFFFF;border:1px solid #D5DEDC;border-radius:16px;border-collapse:separate;">
          <tr>
            <td class="vb-head vb-pad" align="left" style="padding:28px 40px 22px 40px;border-bottom:1px solid #E2EBE9;">
              {{logoUrl}}
            </td>
          </tr>
          <tr>
            <td class="vb-text vb-pad" align="left" style="padding:32px 40px 16px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">
              <p class="vb-eyebrow" style="margin:0 0 8px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#AA4E38;">Verebona Premium</p>
<h1 style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-.01em;color:#17474D;">✨ Abonnement activé</h1>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Bonjour {{firstName}},</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Nous vous confirmons l'activation de votre abonnement <strong>Verebona Premium</strong>. Vous avez désormais accès à toutes les fonctionnalités Premium de la plateforme.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="vb-callout" style="background-color:#F8F6F1;border:1px solid #D5DEDC;border-radius:12px;margin:8px 0 24px 0;border-collapse:separate;"><tr><td class="vb-text" style="padding:16px 20px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:15px;line-height:1.6;color:#26353B;"><p class="vb-eyebrow" style="margin:0 0 8px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#AA4E38;">Détails de votre abonnement</p><p style="margin:0 0 6px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:15px;line-height:1.6;color:#26353B;"><strong>Offre :</strong> Verebona {{planLabel}}</p><p style="margin:0 0 6px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:15px;line-height:1.6;color:#26353B;"><strong>Montant :</strong> {{amountLabel}}</p><p style="margin:0 0 6px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:15px;line-height:1.6;color:#26353B;"><strong>Périodicité :</strong> {{periodLabel}}</p><p style="margin:0 0 0px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:15px;line-height:1.6;color:#26353B;"><strong>Prochaine échéance :</strong> {{nextBillingDate}}</p></td></tr></table>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Votre abonnement sera automatiquement renouvelé à la date d'échéance, sauf résiliation de votre part.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="vb-callout" style="background-color:#F8F6F1;border:1px solid #D5DEDC;border-radius:12px;margin:8px 0 24px 0;border-collapse:separate;"><tr><td class="vb-text" style="padding:16px 20px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:15px;line-height:1.6;color:#26353B;">Vous pouvez gérer ou résilier votre abonnement à tout moment depuis votre compte.</td></tr></table>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Merci de votre confiance et bienvenue dans l'univers Premium de Verebona !</p>
            </td>
          </tr>
        </table>
        <table role="presentation" class="vb-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
          <tr>
            <td class="vb-foot vb-pad" align="center" style="padding:20px 40px 8px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;text-align:center;">
              <p class="vb-foot" style="margin:0 0 6px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">© {{year}} Verebona • Tous droits réservés</p>
<p class="vb-foot" style="margin:0 0 6px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">One place. Higher value</p>
<p class="vb-foot" style="margin:0 0 0px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">Des questions ? Contactez-nous à support@verebona.com</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>$l66c$,
    updated_at = now()
WHERE upper(type) = 'PREMIUM_CONFIRMATION'
  AND (md5(body) = 'f00480296452fa7613c72eb884cb0312'
       OR (updated_by IS NULL AND md5(l66c_email_text(body)) = '3879943c6832ceebf206d04c78db877e'));

-- TRIAL_REMINDER_J3
UPDATE email_templates
SET body = $l66c$<!DOCTYPE html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Votre essai Verebona</title>
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
</style>
</head>
<body class="vb-page" style="margin:0;padding:0;background-color:#F8F6F1;font-family:'Figtree', Arial, Helvetica, sans-serif;color:#26353B;">
  <table role="presentation" class="vb-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F8F6F1" style="background-color:#F8F6F1;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" class="vb-container vb-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:600px;max-width:600px;background-color:#FFFFFF;border:1px solid #D5DEDC;border-radius:16px;border-collapse:separate;">
          <tr>
            <td class="vb-head vb-pad" align="left" style="padding:28px 40px 22px 40px;border-bottom:1px solid #E2EBE9;">
              {{logoUrl}}
            </td>
          </tr>
          <tr>
            <td class="vb-text vb-pad" align="left" style="padding:32px 40px 16px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">
              <h1 style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-.01em;color:#17474D;">Plus que {{daysRemaining}} jours d'essai</h1>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Bonjour {{firstName}},</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Votre essai Premium se termine le {{trialEndsAt}}. D'ici la, vous continuez a profiter de l'ensemble des fonctionnalites : analyse automatique de vos documents, agenda de vos echeances, dossiers prets a utiliser et reponses a vos questions.</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Si Verebona vous est utile, choisissez des maintenant l'offre qui vous convient — mensuelle ou annuelle, sans engagement.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 24px;border-collapse:separate;"><tr><td class="vb-btn-td" align="center" bgcolor="#17474D" style="border-radius:12px;background-color:#17474D;"><a class="vb-btn" href="{{offersUrl}}" target="_blank" style="display:inline-block;padding:15px 26px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;font-weight:700;line-height:1.2;color:#FFFFFF;text-decoration:none;border-radius:12px;background-color:#17474D;border:1px solid #17474D;">Voir les offres</a></td></tr></table>
            </td>
          </tr>
        </table>
        <table role="presentation" class="vb-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
          <tr>
            <td class="vb-foot vb-pad" align="center" style="padding:20px 40px 8px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;text-align:center;">
              <p class="vb-foot" style="margin:0 0 6px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">Aucune carte bancaire n'a ete enregistree et aucun prelevement automatique n'aura lieu.</p>
<p class="vb-foot" style="margin:0 0 0px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">Vos donnees restent conservees. Pour continuer a ajouter et modifier vos biens et documents, il vous suffit de choisir une offre.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>$l66c$,
    updated_at = now()
WHERE upper(type) = 'TRIAL_REMINDER_J3'
  AND (md5(body) = '51ac16168c86bb48931abc546841b0fb'
       OR (updated_by IS NULL AND md5(l66c_email_text(body)) = '948de5abfef0175ceb1d56285dcb9e71'));

-- TRIAL_REMINDER_J1
UPDATE email_templates
SET body = $l66c$<!DOCTYPE html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Votre essai Verebona</title>
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
</style>
</head>
<body class="vb-page" style="margin:0;padding:0;background-color:#F8F6F1;font-family:'Figtree', Arial, Helvetica, sans-serif;color:#26353B;">
  <table role="presentation" class="vb-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F8F6F1" style="background-color:#F8F6F1;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" class="vb-container vb-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:600px;max-width:600px;background-color:#FFFFFF;border:1px solid #D5DEDC;border-radius:16px;border-collapse:separate;">
          <tr>
            <td class="vb-head vb-pad" align="left" style="padding:28px 40px 22px 40px;border-bottom:1px solid #E2EBE9;">
              {{logoUrl}}
            </td>
          </tr>
          <tr>
            <td class="vb-text vb-pad" align="left" style="padding:32px 40px 16px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">
              <h1 style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-.01em;color:#17474D;">Votre essai se termine demain</h1>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Bonjour {{firstName}},</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Votre essai Premium prend fin le {{trialEndsAt}}. Passe cette date, l'ajout et la modification de vos biens et documents seront suspendus, mais vous garderez l'acces a tout ce que vous avez enregistre.</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Pour continuer sans interruption, choisissez votre offre en quelques instants.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 24px;border-collapse:separate;"><tr><td class="vb-btn-td" align="center" bgcolor="#17474D" style="border-radius:12px;background-color:#17474D;"><a class="vb-btn" href="{{offersUrl}}" target="_blank" style="display:inline-block;padding:15px 26px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;font-weight:700;line-height:1.2;color:#FFFFFF;text-decoration:none;border-radius:12px;background-color:#17474D;border:1px solid #17474D;">Choisir une offre</a></td></tr></table>
            </td>
          </tr>
        </table>
        <table role="presentation" class="vb-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
          <tr>
            <td class="vb-foot vb-pad" align="center" style="padding:20px 40px 8px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;text-align:center;">
              <p class="vb-foot" style="margin:0 0 6px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">Aucune carte bancaire n'a ete enregistree et aucun prelevement automatique n'aura lieu.</p>
<p class="vb-foot" style="margin:0 0 0px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">Vos donnees restent conservees. Pour continuer a ajouter et modifier vos biens et documents, il vous suffit de choisir une offre.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>$l66c$,
    updated_at = now()
WHERE upper(type) = 'TRIAL_REMINDER_J1'
  AND (md5(body) = '20c729e5b4f08b523eb197b7c90df18d'
       OR (updated_by IS NULL AND md5(l66c_email_text(body)) = 'e1f7bc928756fe2b9473b79f0e7796b9'));

-- TRIAL_ENDED
UPDATE email_templates
SET body = $l66c$<!DOCTYPE html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Votre essai Verebona</title>
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
</style>
</head>
<body class="vb-page" style="margin:0;padding:0;background-color:#F8F6F1;font-family:'Figtree', Arial, Helvetica, sans-serif;color:#26353B;">
  <table role="presentation" class="vb-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F8F6F1" style="background-color:#F8F6F1;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" class="vb-container vb-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:600px;max-width:600px;background-color:#FFFFFF;border:1px solid #D5DEDC;border-radius:16px;border-collapse:separate;">
          <tr>
            <td class="vb-head vb-pad" align="left" style="padding:28px 40px 22px 40px;border-bottom:1px solid #E2EBE9;">
              {{logoUrl}}
            </td>
          </tr>
          <tr>
            <td class="vb-text vb-pad" align="left" style="padding:32px 40px 16px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">
              <h1 style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-.01em;color:#17474D;">Votre essai gratuit est termine</h1>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Bonjour {{firstName}},</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Votre essai Premium de 7 jours vient de s'achever. Vos biens, vos documents et vos echeances sont intacts et restent consultables.</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Pour reprendre l'ajout et la modification, ainsi que les fonctionnalites Premium, choisissez l'offre adaptee a vos besoins. Trois formules sont disponibles, en paiement mensuel ou annuel.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 24px;border-collapse:separate;"><tr><td class="vb-btn-td" align="center" bgcolor="#17474D" style="border-radius:12px;background-color:#17474D;"><a class="vb-btn" href="{{offersUrl}}" target="_blank" style="display:inline-block;padding:15px 26px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;font-weight:700;line-height:1.2;color:#FFFFFF;text-decoration:none;border-radius:12px;background-color:#17474D;border:1px solid #17474D;">Decouvrir les offres</a></td></tr></table>
            </td>
          </tr>
        </table>
        <table role="presentation" class="vb-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
          <tr>
            <td class="vb-foot vb-pad" align="center" style="padding:20px 40px 8px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;text-align:center;">
              <p class="vb-foot" style="margin:0 0 6px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">Aucune carte bancaire n'a ete enregistree et aucun prelevement automatique n'aura lieu.</p>
<p class="vb-foot" style="margin:0 0 0px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">Vos donnees restent conservees. Pour continuer a ajouter et modifier vos biens et documents, il vous suffit de choisir une offre.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>$l66c$,
    updated_at = now()
WHERE upper(type) = 'TRIAL_ENDED'
  AND (md5(body) = 'c3765c03feae9889cdcb06797502de82'
       OR (updated_by IS NULL AND md5(l66c_email_text(body)) = '04cd973f1426aa470fcdf79f44605d54'));

-- ACCOUNT_INVITATION
UPDATE email_templates
SET body = $l66c$<!DOCTYPE html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Invitation à rejoindre un compte Verebona</title>
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
</style>
</head>
<body class="vb-page" style="margin:0;padding:0;background-color:#F8F6F1;font-family:'Figtree', Arial, Helvetica, sans-serif;color:#26353B;">
  <table role="presentation" class="vb-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F8F6F1" style="background-color:#F8F6F1;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" class="vb-container vb-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:600px;max-width:600px;background-color:#FFFFFF;border:1px solid #D5DEDC;border-radius:16px;border-collapse:separate;">
          <tr>
            <td class="vb-head vb-pad" align="left" style="padding:28px 40px 22px 40px;border-bottom:1px solid #E2EBE9;">
              {{logoUrl}}
            </td>
          </tr>
          <tr>
            <td class="vb-text vb-pad" align="left" style="padding:32px 40px 16px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">
              <h1 style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-.01em;color:#17474D;">Invitation à rejoindre un compte</h1>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Bonjour,</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;"><strong>{{inviterName}}</strong> vous invite à rejoindre le compte <strong>{{accountName}}</strong> sur Verebona avec le rôle <strong>{{role}}</strong>.</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">En rejoignant ce compte, vous aurez accès aux biens, documents et événements partagés par les membres du compte.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 24px;border-collapse:separate;"><tr><td class="vb-btn-td" align="center" bgcolor="#17474D" style="border-radius:12px;background-color:#17474D;"><a class="vb-btn" href="{{invitationLink}}" target="_blank" style="display:inline-block;padding:15px 26px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;font-weight:700;line-height:1.2;color:#FFFFFF;text-decoration:none;border-radius:12px;background-color:#17474D;border:1px solid #17474D;">Accepter l'invitation</a></td></tr></table>
<p class="vb-muted" style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:14px;line-height:1.55;color:#52636A;">Si vous ne souhaitez pas accepter cette invitation, vous pouvez simplement ignorer cet email.</p>
<p class="vb-muted" style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:14px;line-height:1.55;color:#52636A;">Si le bouton ne fonctionne pas, copiez-collez ce lien dans votre navigateur :<br><a class="vb-link" href="{{invitationLink}}" style="color:#17474D;text-decoration:underline;word-break:break-all;">{{invitationLink}}</a></p>
            </td>
          </tr>
        </table>
        <table role="presentation" class="vb-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
          <tr>
            <td class="vb-foot vb-pad" align="center" style="padding:20px 40px 8px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;text-align:center;">
              <p class="vb-foot" style="margin:0 0 0px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">© {{year}} Verebona. Tous droits réservés.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>$l66c$,
    updated_at = now()
WHERE upper(type) = 'ACCOUNT_INVITATION'
  AND (md5(body) = '4c670351c54fb38c4b2dabdae08868da'
       OR (updated_by IS NULL AND md5(l66c_email_text(body)) = 'e143e03355539af0e62bbea99089e4a0'));

-- ACCOUNT_MEMBER_REMOVED
UPDATE email_templates
SET body = $l66c$<!DOCTYPE html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Retrait d'un compte Verebona</title>
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
</style>
</head>
<body class="vb-page" style="margin:0;padding:0;background-color:#F8F6F1;font-family:'Figtree', Arial, Helvetica, sans-serif;color:#26353B;">
  <table role="presentation" class="vb-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F8F6F1" style="background-color:#F8F6F1;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" class="vb-container vb-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:600px;max-width:600px;background-color:#FFFFFF;border:1px solid #D5DEDC;border-radius:16px;border-collapse:separate;">
          <tr>
            <td class="vb-head vb-pad" align="left" style="padding:28px 40px 22px 40px;border-bottom:1px solid #E2EBE9;">
              {{logoUrl}}
            </td>
          </tr>
          <tr>
            <td class="vb-text vb-pad" align="left" style="padding:32px 40px 16px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">
              <h1 style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-.01em;color:#17474D;">Retrait d'un compte</h1>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Bonjour {{memberName}},</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Vous avez été retiré du compte <strong>{{accountName}}</strong> par <strong>{{removedByName}}</strong>.</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Vous n'avez plus accès aux biens, documents et événements de ce compte.</p>
<p class="vb-muted" style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:14px;line-height:1.55;color:#52636A;">Si vous pensez qu'il s'agit d'une erreur, veuillez contacter le propriétaire du compte.</p>
            </td>
          </tr>
        </table>
        <table role="presentation" class="vb-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
          <tr>
            <td class="vb-foot vb-pad" align="center" style="padding:20px 40px 8px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;text-align:center;">
              <p class="vb-foot" style="margin:0 0 0px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">© {{year}} Verebona. Tous droits réservés.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>$l66c$,
    updated_at = now()
WHERE upper(type) = 'ACCOUNT_MEMBER_REMOVED'
  AND (md5(body) = '2037e73bf2a11a8f56ca7154622290e2'
       OR (updated_by IS NULL AND md5(l66c_email_text(body)) = '3ba5e01eec494df48867fe6e99c2ff4f'));

-- MEMBER_REMOVED_DUE_TO_DOWNGRADE
UPDATE email_templates
SET body = $l66c$<!DOCTYPE html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Modification de votre accès Verebona</title>
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
</style>
</head>
<body class="vb-page" style="margin:0;padding:0;background-color:#F8F6F1;font-family:'Figtree', Arial, Helvetica, sans-serif;color:#26353B;">
  <table role="presentation" class="vb-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F8F6F1" style="background-color:#F8F6F1;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" class="vb-container vb-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:600px;max-width:600px;background-color:#FFFFFF;border:1px solid #D5DEDC;border-radius:16px;border-collapse:separate;">
          <tr>
            <td class="vb-head vb-pad" align="left" style="padding:28px 40px 22px 40px;border-bottom:1px solid #E2EBE9;">
              {{logoUrl}}
            </td>
          </tr>
          <tr>
            <td class="vb-text vb-pad" align="left" style="padding:32px 40px 16px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">
              <h1 style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-.01em;color:#17474D;">Modification de votre accès</h1>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Bonjour {{memberName}},</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Votre accès au compte <strong>{{accountName}}</strong> a été automatiquement retiré suite à un changement d'abonnement.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="vb-attention" style="background-color:#F6E4DE;border:1px solid #E8C4B9;border-radius:12px;margin:8px 0 24px 0;border-collapse:separate;"><tr><td class="vb-text" style="padding:16px 20px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:15px;line-height:1.6;color:#26353B;"><strong>Raison :</strong><br>{{reason}}</td></tr></table>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Vous n'avez plus accès aux biens, documents et événements de ce compte. Si le propriétaire du compte décide de passer à une offre Premium permettant plusieurs membres, il pourra vous réinviter.</p>
<p class="vb-muted" style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:14px;line-height:1.55;color:#52636A;">Pour toute question, n'hésitez pas à contacter le propriétaire du compte.</p>
            </td>
          </tr>
        </table>
        <table role="presentation" class="vb-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
          <tr>
            <td class="vb-foot vb-pad" align="center" style="padding:20px 40px 8px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;text-align:center;">
              <p class="vb-foot" style="margin:0 0 0px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">© {{year}} Verebona. Tous droits réservés.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>$l66c$,
    updated_at = now()
WHERE upper(type) = 'MEMBER_REMOVED_DUE_TO_DOWNGRADE'
  AND (md5(body) = '961922e5278bab79a9a0efe0bfa36066'
       OR (updated_by IS NULL AND md5(l66c_email_text(body)) = '91785a69135afd2eb3b6e93fd431bac1'));

-- ACCOUNT_OWNERSHIP_TRANSFERRED
UPDATE email_templates
SET body = $l66c$<!DOCTYPE html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Transfert de propriété Verebona</title>
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
</style>
</head>
<body class="vb-page" style="margin:0;padding:0;background-color:#F8F6F1;font-family:'Figtree', Arial, Helvetica, sans-serif;color:#26353B;">
  <table role="presentation" class="vb-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F8F6F1" style="background-color:#F8F6F1;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" class="vb-container vb-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:600px;max-width:600px;background-color:#FFFFFF;border:1px solid #D5DEDC;border-radius:16px;border-collapse:separate;">
          <tr>
            <td class="vb-head vb-pad" align="left" style="padding:28px 40px 22px 40px;border-bottom:1px solid #E2EBE9;">
              {{logoUrl}}
            </td>
          </tr>
          <tr>
            <td class="vb-text vb-pad" align="left" style="padding:32px 40px 16px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">
              <h1 style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-.01em;color:#17474D;">Transfert de propriété</h1>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Bonjour {{newOwnerName}},</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;"><strong>{{previousOwnerName}}</strong> vous a transféré la propriété du compte <strong>{{accountName}}</strong>.</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">En tant que propriétaire, vous avez maintenant tous les droits sur ce compte : gestion des membres, modification des paramètres, et gestion complète des données.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 24px;border-collapse:separate;"><tr><td class="vb-btn-td" align="center" bgcolor="#17474D" style="border-radius:12px;background-color:#17474D;"><a class="vb-btn" href="{{dashboardLink}}" target="_blank" style="display:inline-block;padding:15px 26px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;font-weight:700;line-height:1.2;color:#FFFFFF;text-decoration:none;border-radius:12px;background-color:#17474D;border:1px solid #17474D;">Accéder au compte</a></td></tr></table>
            </td>
          </tr>
        </table>
        <table role="presentation" class="vb-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
          <tr>
            <td class="vb-foot vb-pad" align="center" style="padding:20px 40px 8px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;text-align:center;">
              <p class="vb-foot" style="margin:0 0 0px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">© {{year}} Verebona. Tous droits réservés.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>$l66c$,
    updated_at = now()
WHERE upper(type) = 'ACCOUNT_OWNERSHIP_TRANSFERRED'
  AND (md5(body) = 'a04184ea0b412335957a7407bf72ccae'
       OR (updated_by IS NULL AND md5(l66c_email_text(body)) = '2ccaa872cdfaa470abe190c3645e2ec7'));

-- LEGAL_CONFIRMATION
UPDATE email_templates
SET body = $l66c$<!DOCTYPE html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Confirmation — vos conditions générales Verebona</title>
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
</style>
</head>
<body class="vb-page" style="margin:0;padding:0;background-color:#F8F6F1;font-family:'Figtree', Arial, Helvetica, sans-serif;color:#26353B;">
  <table role="presentation" class="vb-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F8F6F1" style="background-color:#F8F6F1;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" class="vb-container vb-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:600px;max-width:600px;background-color:#FFFFFF;border:1px solid #D5DEDC;border-radius:16px;border-collapse:separate;">
          <tr>
            <td class="vb-head vb-pad" align="left" style="padding:28px 40px 22px 40px;border-bottom:1px solid #E2EBE9;">
              <p class="vb-wordmark" style="margin:0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#17474D;">Verebona</p>
            </td>
          </tr>
          <tr>
            <td class="vb-text vb-pad" align="left" style="padding:32px 40px 16px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">
              <p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Bonjour {{firstName}},</p>
{{subscriptionBlockHtml}}
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;"><strong>Conditions générales applicables :</strong> version {{legalVersionCode}}.</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Vous pouvez les consulter, les enregistrer ou les imprimer à tout moment :</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 24px;border-collapse:separate;"><tr><td class="vb-btn-td" align="center" bgcolor="#17474D" style="border-radius:12px;background-color:#17474D;"><a class="vb-btn" href="{{legalPermalinkUrl}}" target="_blank" style="display:inline-block;padding:15px 26px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;font-weight:700;line-height:1.2;color:#FFFFFF;text-decoration:none;border-radius:12px;background-color:#17474D;border:1px solid #17474D;">Consulter la version {{legalVersionCode}}</a></td></tr></table>
<p class="vb-muted" style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:14px;line-height:1.55;color:#52636A;">Ce lien pointe vers la version exacte que vous avez acceptée. Elle ne sera jamais modifiée et restera accessible, y compris si vous fermez votre compte.</p>
{{withdrawalBlockHtml}}
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Vous pouvez gérer votre abonnement depuis votre compte.</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Une question ? Écrivez-nous à <a class="vb-link" href="mailto:{{contactEmail}}" style="color:#17474D;text-decoration:underline;font-weight:600;">{{contactEmail}}</a>.</p>
            </td>
          </tr>
        </table>
        <table role="presentation" class="vb-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
          <tr>
            <td class="vb-foot vb-pad" align="center" style="padding:20px 40px 8px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;text-align:center;">
              <p class="vb-foot" style="margin:0 0 0px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">Verebona — {{year}}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>$l66c$,
    updated_at = now()
WHERE upper(type) = 'LEGAL_CONFIRMATION'
  AND (md5(body) = '4f6f8e53f690c023ab4840645b61701e'
       OR (updated_by IS NULL AND md5(l66c_email_text(body)) = 'dae2faa66537fece6753b6e1ae5b4521'));

-- WITHDRAWAL_RECEIPT
UPDATE email_templates
SET body = $l66c$<!DOCTYPE html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Rétractation enregistrée — Verebona</title>
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
</style>
</head>
<body class="vb-page" style="margin:0;padding:0;background-color:#F8F6F1;font-family:'Figtree', Arial, Helvetica, sans-serif;color:#26353B;">
  <table role="presentation" class="vb-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F8F6F1" style="background-color:#F8F6F1;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" class="vb-container vb-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:600px;max-width:600px;background-color:#FFFFFF;border:1px solid #D5DEDC;border-radius:16px;border-collapse:separate;">
          <tr>
            <td class="vb-head vb-pad" align="left" style="padding:28px 40px 22px 40px;border-bottom:1px solid #E2EBE9;">
              <p class="vb-wordmark" style="margin:0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#17474D;">Verebona</p>
            </td>
          </tr>
          <tr>
            <td class="vb-text vb-pad" align="left" style="padding:32px 40px 16px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">
              <p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Bonjour {{firstName}} {{lastName}},</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Nous avons bien reçu votre déclaration de rétractation. Elle est enregistrée et a été traitée immédiatement.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="vb-callout" style="background-color:#F8F6F1;border:1px solid #D5DEDC;border-radius:12px;margin:8px 0 24px 0;border-collapse:separate;"><tr><td class="vb-text" style="padding:16px 20px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:15px;line-height:1.6;color:#26353B;"><p style="margin:0 0 6px 0;"><strong>Référence :</strong> {{publicReference}}</p><p style="margin:0 0 6px 0;"><strong>Reçue le :</strong> {{requestedAtLabel}}</p><p style="margin:0 0 6px 0;"><strong>Contrat :</strong> {{contractLabel}}</p><p style="margin:0;"><strong>Remboursement :</strong> {{amountLabel}}, intégral</p></td></tr></table>
<p class="vb-eyebrow" style="margin:0 0 8px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#AA4E38;">Ce qui a été fait</p>
<ul style="margin:0 0 16px 0;padding:0 0 0 20px;"><li style="margin:0 0 8px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Votre abonnement est annulé : aucun nouveau prélèvement n'interviendra.</li><li style="margin:0 0 8px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Le remboursement intégral est <strong>lancé</strong> sur votre moyen de paiement d'origine, sans retenue. Selon votre banque, il apparaît sous quelques jours.</li><li style="margin:0 0 8px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Votre compte Verebona et ses données (biens, documents, fichiers, échéances, historique de l'assistant) sont <strong>supprimés</strong> : vous ne pouvez plus vous y connecter.</li></ul>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Seules les informations que la loi nous impose de garder sont conservées, détachées de votre compte : les factures, la preuve de cette rétractation et celle de votre acceptation des conditions générales.</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Merci d'avoir essayé Verebona. Au revoir, et à bientôt peut-être.</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Conditions générales applicables : <a class="vb-link" href="{{legalPermalinkUrl}}" style="color:#17474D;text-decoration:underline;font-weight:600;">consulter</a>.</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Une question ? <a class="vb-link" href="mailto:{{contactEmail}}" style="color:#17474D;text-decoration:underline;font-weight:600;">{{contactEmail}}</a></p>
            </td>
          </tr>
        </table>
        <table role="presentation" class="vb-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
          <tr>
            <td class="vb-foot vb-pad" align="center" style="padding:20px 40px 8px 40px;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;text-align:center;">
              <p class="vb-foot" style="margin:0 0 0px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:13px;line-height:1.5;color:#52636A;">Conservez ce message : il atteste de la date de votre déclaration.<br />Verebona — {{year}}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>$l66c$,
    updated_at = now()
WHERE upper(type) = 'WITHDRAWAL_RECEIPT'
  AND (md5(body) = 'cd5d720913ae23be04c3bda895619104'
       OR (updated_by IS NULL AND md5(l66c_email_text(body)) = '384753217e347735da537c7ad9723ce1'));

DROP FUNCTION IF EXISTS l66c_email_text(text);
