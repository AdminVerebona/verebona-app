-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0140 — Email « Confirmation de votre abonnement Verebona Premium »
--
-- Le gabarit envoyé est celui stocké en base (`email_templates`), éventuellement
-- retouché dans l'administration : on corrige les passages visés, sans
-- réécrire le gabarit.
--
--   1. « …depuis votre compte, via le portail Stripe sécurisé accessible depuis
--      la page "Mon abonnement". »  →  « …depuis votre compte. »
--   2. Suppression de « À défaut de renouvellement, votre compte sera
--      automatiquement basculé vers l'offre Standard. » (paragraphe entier).
--   3. Suppression du bouton « Gérer mon abonnement » et de la variable
--      {{manageSubscriptionUrl}} (lien HTML, paragraphe qui le contient, ou
--      forme texte « [{{manageSubscriptionUrl}}]Gérer mon abonnement »).
--
-- Casse du type ignorée (des gabarits ont été enregistrés en minuscules),
-- apostrophes / guillemets / accents encodés et espaces insécables tolérés.
-- Rejouable sans effet.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Phrase de gestion de l'abonnement.
UPDATE email_templates
SET body = regexp_replace(
      body,
      '(depuis(\s|&nbsp;)+votre(\s|&nbsp;)+compte)(\s|&nbsp;)*,(\s|&nbsp;)*via(\s|&nbsp;)+le(\s|&nbsp;)+portail(\s|&nbsp;)+(de(\s|&nbsp;)+gestion(\s|&nbsp;)+)?Stripe[^.<]*?(Mon(\s|&nbsp;)+abonnement)(&quot;|"|»|&raquo;|”|&#8221;)?(\s|&nbsp;)*(\)|&quot;|")?\s*\.',
      '\1.',
      'gi'
    ),
    updated_at = now()
WHERE upper(type) = 'PREMIUM_CONFIRMATION'
  AND body ~* 'portail(\s|&nbsp;)+(de(\s|&nbsp;)+gestion(\s|&nbsp;)+)?Stripe';

-- 2. « À défaut de renouvellement… offre Standard. » — le paragraphe HTML
--    entier s'il est seul dans son <p>, sinon la phrase.
UPDATE email_templates
SET body = regexp_replace(
      regexp_replace(
        body,
        '<p[^>]*>\s*(À|&Agrave;|&#192;|A)(\s|&nbsp;)+d(é|&eacute;|&#233;)faut(\s|&nbsp;)+de(\s|&nbsp;)+renouvellement[^<]*</p>\s*',
        '',
        'gi'
      ),
      '(À|&Agrave;|&#192;|A)(\s|&nbsp;)+d(é|&eacute;|&#233;)faut(\s|&nbsp;)+de(\s|&nbsp;)+renouvellement[^.<]*Standard[^.<]*\.\s*',
      '',
      'gi'
    ),
    updated_at = now()
WHERE upper(type) = 'PREMIUM_CONFIRMATION'
  AND body ~* 'd(é|&eacute;|&#233;)faut(\s|&nbsp;)+de(\s|&nbsp;)+renouvellement';

-- 3. Bouton / lien « Gérer mon abonnement » et variable {{manageSubscriptionUrl}}.
UPDATE email_templates
SET body = regexp_replace(
      regexp_replace(
        regexp_replace(
          body,
          -- paragraphe ne contenant que le lien
          '<p[^>]*>\s*<a[^>]*\{\{\s*manageSubscriptionUrl\s*\}\}[^>]*>[^<]*</a>\s*</p>\s*',
          '',
          'gi'
        ),
        -- lien isolé
        '<a[^>]*\{\{\s*manageSubscriptionUrl\s*\}\}[^>]*>[^<]*</a>',
        '',
        'gi'
      ),
      -- forme texte « [{{manageSubscriptionUrl}}]Gérer mon abonnement » ou variable seule
      '\[?\{\{\s*manageSubscriptionUrl\s*\}\}\]?((\s|&nbsp;)*G(é|&eacute;|&#233;)rer(\s|&nbsp;)+mon(\s|&nbsp;)+abonnement)?',
      '',
      'gi'
    ),
    placeholders = CASE
      WHEN placeholders IS NULL THEN placeholders
      ELSE replace(replace(placeholders::text, ', "manageSubscriptionUrl"', ''), '"manageSubscriptionUrl", ', '')
    END,
    updated_at = now()
WHERE upper(type) = 'PREMIUM_CONFIRMATION'
  AND body ~* 'manageSubscriptionUrl';
