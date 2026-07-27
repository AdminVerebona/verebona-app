-- ============================================================================
-- 0077 — Templates email des notifications (CDC Notifications §15.2)
--
-- Seede les templates transactionnels `notif_*` référencés par le catalogue.
-- Variables fournies par l'EmailChannel : {{title}}, {{body}}, {{actionUrl}}.
-- Idempotent et non destructif : ON CONFLICT (type) DO NOTHING préserve toute
-- édition faite ensuite dans l'administration.
-- ============================================================================

INSERT INTO email_templates (type, subject, body, placeholders, updated_at) VALUES
  ('notif_deadline_j7', 'Une échéance approche', E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}', '["title","body","actionUrl"]', NOW()),
  ('notif_document_batch_failed', 'Analyse de vos documents', E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}', '["title","body","actionUrl"]', NOW()),
  ('notif_to_process_immediate', 'Un élément est à traiter', E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}', '["title","body","actionUrl"]', NOW()),
  ('notif_to_process_digest', 'Votre récapitulatif Verebona', E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}', '["title","body","actionUrl"]', NOW()),
  ('notif_duo_invitation', 'Invitation Duo', E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}', '["title","body","actionUrl"]', NOW()),
  ('notif_duo_request', 'Une demande nécessite votre décision', E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}', '["title","body","actionUrl"]', NOW()),
  ('notif_duo_result', 'Réponse à votre demande Duo', E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}', '["title","body","actionUrl"]', NOW()),
  ('notif_account_invitation', 'Invitation à un compte Verebona', E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}', '["title","body","actionUrl"]', NOW()),
  ('notif_transmission_received', 'Vous avez reçu une transmission', E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}', '["title","body","actionUrl"]', NOW()),
  ('notif_transmission_result', 'Mise à jour de votre transmission', E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}', '["title","body","actionUrl"]', NOW()),
  ('notif_trial_ending', 'Votre essai se termine bientôt', E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}', '["title","body","actionUrl"]', NOW()),
  ('notif_trial_ended', 'Votre essai est terminé', E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}', '["title","body","actionUrl"]', NOW()),
  ('notif_subscription', 'Votre abonnement Verebona', E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}', '["title","body","actionUrl"]', NOW()),
  ('notif_quota', 'Votre quota d''analyses', E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}', '["title","body","actionUrl"]', NOW()),
  ('notif_referral_reward', 'Votre récompense de parrainage', E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}', '["title","body","actionUrl"]', NOW()),
  ('notif_payment_incident', 'Action requise sur votre paiement', E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}', '["title","body","actionUrl"]', NOW()),
  ('notif_security', 'Sécurité de votre compte', E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}', '["title","body","actionUrl"]', NOW()),
  ('notif_news', 'Actualités Verebona', E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}\n\nPour ne plus recevoir ces actualités, gérez vos préférences dans Mon compte > Notifications.', '["title","body","actionUrl"]', NOW())
ON CONFLICT (type) DO NOTHING;
