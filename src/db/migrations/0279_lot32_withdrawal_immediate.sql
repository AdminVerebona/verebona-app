-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0279 : rétractation immédiate et modèles d'e-mail du lot 32
-- (décisions PO du 07/10/2026).
--
-- 0. Journal de rétractation (`withdrawal_events`, ajout seul, 0118) : la
--    suppression d'un compte dont l'utilisateur a déclaré une rétractation
--    ÉCHOUAIT — la cascade `actor_user_id … ON DELETE SET NULL` est une mise
--    à jour, refusée par le déclencheur « ajout seul ». Défaut latent depuis
--    0118 (la suppression à J+30 aurait échoué de même), bloquant avec la
--    suppression immédiate. Seule exception admise : `actor_user_id` remis à
--    NULL par la suppression de l'utilisateur, toute autre colonne identique.
--    Toute autre modification reste refusée.
--
-- 1. WITHDRAWAL_RECEIPT — accusé de réception ET e-mail d'au revoir (Q2) :
--    la rétractation est désormais traitée immédiatement (accès coupés,
--    abonnement annulé, remboursement intégral lancé, compte supprimé). Le
--    modèle annonçait « données exportables jusqu'au … » (30 jours) et un
--    bouton « Suivre ma demande » : ils disparaissent. Le texte est celui de
--    `src/db/seeds/withdrawal/email_template_withdrawal.ts` (test PO-Q2).
--    ⚠️ Écrase une éventuelle retouche faite en back-office : l'ancien texte
--    annonçait un délai qui n'existe plus.
-- 2. notif_document_upload — e-mail de la notification « Documents ajoutés »
--    (Q18/Q19), envoyé seulement si l'utilisateur active l'e-mail de la
--    catégorie « Documents » (désactivé par défaut). Non écrasé s'il existe.
--
-- Idempotente : UPSERT sur `type` (index unique). Rejouable sans effet.
-- Retour arrière : la fonction de 0118 (sans l'exception) ; reposer l'ancien
-- texte du modèle par le seed du lot 31
-- (`email_template_withdrawal.ts` au tag lot31) ; supprimer
-- `notif_document_upload` est sans conséquence (notification sans e-mail).
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION withdrawal_events_append_only() RETURNS TRIGGER AS $fn$
BEGIN
  -- Pseudonymisation par la suppression de l'utilisateur (FK SET NULL) : seule
  -- `actor_user_id` passe à NULL, tout le reste est inchangé.
  IF OLD.actor_user_id IS NOT NULL AND NEW.actor_user_id IS NULL
     AND (to_jsonb(NEW) - 'actor_user_id') = (to_jsonb(OLD) - 'actor_user_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'Journal de retractation : ajout seul. Une correction s ecrit comme un evenement complementaire (CDC 6 18).'
    USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;

INSERT INTO email_templates (type, subject, body, placeholders, updated_at) VALUES
  ('WITHDRAWAL_RECEIPT',
   $tpl$Votre rétractation est enregistrée et votre compte supprimé — {{publicReference}}$tpl$,
   $tpl$<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Rétractation enregistrée</title>
  </head>
  <body style="margin:0; padding:0; background-color:#F5F5F5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
    <center>
      <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F5F5F5; padding:40px 0;">
        <tr><td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="background-color:#FFFFFF; border-radius:12px; overflow:hidden;">

            <tr><td style="padding:32px 40px 8px;">
              <h1 style="margin:0; font-size:20px; color:#1a1a1a;">Verebona</h1>
            </td></tr>

            <tr><td style="padding:8px 40px 24px; color:#333333; font-size:15px; line-height:1.6;">
              <p style="margin:0 0 16px;">Bonjour {{firstName}} {{lastName}},</p>

              <p style="margin:0 0 16px;">
                Nous avons bien reçu votre déclaration de rétractation. Elle est
                enregistrée et a été traitée immédiatement.
              </p>

              <table width="100%" cellpadding="0" cellspacing="0"
                     style="background-color:#F7F9FB; border-radius:8px; margin:0 0 24px;">
                <tr><td style="padding:16px 20px; font-size:14px; color:#333333;">
                  <p style="margin:0 0 6px;"><strong>Référence :</strong> {{publicReference}}</p>
                  <p style="margin:0 0 6px;"><strong>Reçue le :</strong> {{requestedAtLabel}}</p>
                  <p style="margin:0 0 6px;"><strong>Contrat :</strong> {{contractLabel}}</p>
                  <p style="margin:0;"><strong>Remboursement :</strong> {{amountLabel}}, intégral</p>
                </td></tr>
              </table>

              <p style="margin:0 0 8px;"><strong>Ce qui a été fait</strong></p>
              <ul style="margin:0 0 16px; padding-left:20px;">
                <li style="margin:0 0 6px;">Votre abonnement est annulé : aucun nouveau prélèvement n'interviendra.</li>
                <li style="margin:0 0 6px;">Le remboursement intégral est <strong>lancé</strong> sur votre moyen de paiement d'origine, sans retenue. Selon votre banque, il apparaît sous quelques jours.</li>
                <li style="margin:0;">Votre compte Verebona et ses données (biens, documents, fichiers, échéances, historique de l'assistant) sont <strong>supprimés</strong> : vous ne pouvez plus vous y connecter.</li>
              </ul>

              <p style="margin:0 0 24px; font-size:14px; color:#555555;">
                Seules les informations que la loi nous impose de garder sont conservées,
                détachées de votre compte : les factures, la preuve de cette rétractation
                et celle de votre acceptation des conditions générales.
              </p>

              <p style="margin:0 0 24px;">
                Merci d'avoir essayé Verebona. Au revoir, et à bientôt peut-être.
              </p>

              <p style="margin:0 0 8px; font-size:13px; color:#555555;">
                Conditions générales applicables :
                <a href="{{legalPermalinkUrl}}" style="color:#0b5fff;">consulter</a>.
              </p>
              <p style="margin:0; font-size:13px; color:#555555;">
                Une question ? <a href="mailto:{{contactEmail}}" style="color:#0b5fff;">{{contactEmail}}</a>
              </p>
            </td></tr>

            <tr><td style="padding:16px 40px 32px; border-top:1px solid #eeeeee; font-size:12px; color:#888888;">
              Conservez ce message : il atteste de la date de votre déclaration.<br />
              Verebona — {{year}}
            </td></tr>

          </table>
        </td></tr>
      </table>
    </center>
  </body>
</html>$tpl$,
   '["firstName","lastName","publicReference","requestedAtLabel","contractLabel","amountLabel","legalPermalinkUrl","contactEmail"]', NOW())
ON CONFLICT (type) DO UPDATE
   SET subject = EXCLUDED.subject,
       body = EXCLUDED.body,
       placeholders = EXCLUDED.placeholders,
       updated_at = NOW()
 WHERE email_templates.subject IS DISTINCT FROM EXCLUDED.subject
    OR email_templates.body IS DISTINCT FROM EXCLUDED.body
    OR email_templates.placeholders IS DISTINCT FROM EXCLUDED.placeholders;

INSERT INTO email_templates (type, subject, body, placeholders, updated_at) VALUES
  ('notif_document_upload', 'Documents ajoutés à Verebona',
   E'{{body}}\n\nLes retrouver dans Verebona : {{actionUrl}}',
   '["title","body","actionUrl"]', NOW())
ON CONFLICT (type) DO NOTHING;
