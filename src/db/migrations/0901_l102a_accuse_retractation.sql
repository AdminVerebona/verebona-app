-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0901 — Lot 102A : accusé de réception de rétractation mis en
-- cohérence avec la décision PO du 31/10/2026 (rétractation : abonnement
-- annulé, remboursement intégral, compte en LECTURE SEULE, données conservées
-- {{retentionDays}} jours puis supprimées sauf nouvelle souscription ;
-- suppression anticipée sur demande). Remplace le texte « compte supprimé »
-- du lot 32 / 66C.
--
-- Corps = `WITHDRAWAL_RECEIPT_HTML` de src/lib/email/email-html-templates.ts
-- (contrôlé par test). Gabarit au contenu VERROUILLÉ dans le BO (L221-21) :
-- « toute modification passe par une livraison » — il est donc remplacé même
-- s'il porte une ancienne marque de personnalisation ; texte livré
-- (shipped_*) aligné et version tracée dans l'historique.
--
-- Idempotente : rejouée, elle ne change rien (aucune version en double).
-- Retour arrière : « Restaurer » la version précédente depuis l'historique.
-- ═══════════════════════════════════════════════════════════════════════════
SET LOCAL lock_timeout = '5s';
SELECT set_config('verebona.email_template_edit', 'on', true);

WITH livre(type, subject, body, placeholders) AS (
  VALUES ('WITHDRAWAL_RECEIPT',
          $l102a$Votre rétractation est enregistrée — {{publicReference}}$l102a$,
          $l102a$<!DOCTYPE html>
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
<ul style="margin:0 0 16px 0;padding:0 0 0 20px;"><li style="margin:0 0 8px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Votre abonnement est annulé : aucun nouveau prélèvement n'interviendra.</li><li style="margin:0 0 8px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Le remboursement intégral est <strong>lancé</strong> sur votre moyen de paiement d'origine, sans retenue. Selon votre banque, il apparaît sous quelques jours.</li><li style="margin:0 0 8px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Votre compte Verebona passe en <strong>lecture seule</strong> : vos biens et documents restent consultables et exportables.</li></ul>
<p class="vb-eyebrow" style="margin:0 0 8px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#AA4E38;">Vos données</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Vos données sont conservées {{retentionDays}} jours, puis supprimées, sauf nouvelle souscription d'ici là. Vous pouvez aussi demander la suppression de votre compte à tout moment depuis Mon compte.</p>
<p style="margin:0 0 16px 0;font-family:'Figtree', Arial, Helvetica, sans-serif;font-size:16px;line-height:1.6;color:#26353B;">Accéder à mon compte : <a class="vb-link" href="{{accountUrl}}" style="color:#17474D;text-decoration:underline;font-weight:600;">Mon compte</a>.</p>
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
</html>$l102a$,
          '["firstName","lastName","publicReference","requestedAtLabel","contractLabel","amountLabel","retentionDays","accountUrl","legalPermalinkUrl","contactEmail"]')
),
maj AS (
  UPDATE email_templates t
     SET subject = l.subject, body = l.body, placeholders = l.placeholders,
         shipped_subject = l.subject, shipped_body = l.body, shipped_updated_at = NULL, updated_at = now()
    FROM livre l
   WHERE upper(t.type) = l.type
     AND (t.body IS DISTINCT FROM l.body OR t.subject IS DISTINCT FROM l.subject
          OR t.placeholders::text IS DISTINCT FROM l.placeholders)
  RETURNING upper(t.type) AS type, t.subject, t.body
),
cree AS (
  INSERT INTO email_templates (type, subject, body, placeholders, shipped_subject, shipped_body, updated_at)
  SELECT l.type, l.subject, l.body, l.placeholders, l.subject, l.body, now()
    FROM livre l
   WHERE NOT EXISTS (SELECT 1 FROM email_templates t WHERE upper(t.type) = l.type)
  RETURNING upper(type) AS type, subject, body
)
INSERT INTO email_template_versions (template_type, version_no, subject, body, source, created_at, note)
SELECT x.type,
       coalesce((SELECT max(v.version_no) FROM email_template_versions v WHERE v.template_type = x.type), 0) + 1,
       x.subject, x.body, 'shipped_update', now(),
       'Lot 102A : rétractation — compte en lecture seule, données conservées, suppression sur demande ou à l''échéance'
  FROM (SELECT * FROM maj UNION ALL SELECT * FROM cree) x;

SELECT set_config('verebona.email_template_edit', '', true);
