-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0130 — Textes des gabarits d'email déjà en base
--
-- ── POURQUOI UNE MIGRATION ────────────────────────────────────────────────
--
-- Les nouveaux textes étaient déjà dans `email-defaults.ts` et dans les
-- amorçages. Mais les amorçages n'écrasent pas une ligne existante : la base
-- conservait l'ancien gabarit, et c'est lui qui part. D'où l'email de
-- réinitialisation qui disait toujours « vous pouvez ignorer cet email ».
--
-- ── REMPLACEMENT CIBLÉ ────────────────────────────────────────────────────
--
-- On remplace la phrase, pas le gabarit entier : un gabarit retouché depuis
-- l'administration garde ses autres modifications. Les apostrophes sont
-- acceptées sous leurs trois formes (droite, typographique, entité HTML).
-- Rejouable sans effet : une fois remplacée, la phrase n'est plus trouvée.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Réinitialisation du mot de passe
UPDATE email_templates
SET body = regexp_replace(
      body,
      'Si vous n(''|’|&#39;|&apos;)avez pas demandé cette réinitialisation,\s*vous pouvez (simplement\s+)?ignorer cet (e-)?mail\.?',
      'Si vous n’êtes pas à l’origine de cette demande, ne cliquez pas sur le lien de réinitialisation. Si vous avez un doute concernant la sécurité de votre compte, modifiez votre mot de passe directement depuis Verebona.',
      'gi'
    ),
    updated_at = now()
WHERE type = 'PASSWORD_RESET'
  AND body ~* 'Si vous n(''|’|&#39;|&apos;)avez pas demandé cette réinitialisation';

-- 2. « Choisir mon abonnement » → « Choisir une offre » (emails de fin d'essai)
UPDATE email_templates
SET body = replace(body, 'Choisir mon abonnement', 'Choisir une offre'),
    updated_at = now()
WHERE body LIKE '%Choisir mon abonnement%';
