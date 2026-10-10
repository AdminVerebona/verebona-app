-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0307 : e-mail « Confirmation de votre abonnement » — montant de
-- l'OPÉRATION (lot 35C, CDC « Migration Stripe vers lookup_key » V4, LK-78).
--
-- Le gabarit PREMIUM_CONFIRMATION affichait en dur « Verebona Premium »,
-- « 59 € / an, TTC, TVA incluse » et « Abonnement annuel » : faux pour un
-- Premium Duo, pour un abonnement mensuel, et pour toute grille autre que
-- l'ancienne. Ces trois mentions deviennent les variables {{planLabel}},
-- {{amountLabel}} et {{periodLabel}}, renseignées depuis le prix CONTRACTUEL
-- de l'abonnement Stripe synchronisé (jamais depuis la grille courante).
--
-- Gabarit retouché dans le BO : seuls les passages visés sont remplacés,
-- espaces / insécables tolérés ; un gabarit qui ne les contient plus est
-- laissé tel quel. Les e-mails déjà envoyés ne sont pas concernés.
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

UPDATE email_templates
SET body = regexp_replace(
      regexp_replace(
        regexp_replace(
          body,
          '(<strong>(\s|&nbsp;)*Offre(\s|&nbsp;)*:(\s|&nbsp;)*</strong>(\s|&nbsp;)*)Verebona(\s|&nbsp;)+Premium',
          '\1Verebona {{planLabel}}',
          'g'
        ),
        '(<strong>(\s|&nbsp;)*Montant(\s|&nbsp;)*:(\s|&nbsp;)*</strong>(\s|&nbsp;)*)59(\s|&nbsp;)*(€|&euro;)(\s|&nbsp;)*/(\s|&nbsp;)*an,(\s|&nbsp;)*TTC,(\s|&nbsp;)*TVA(\s|&nbsp;)+incluse',
        '\1{{amountLabel}}',
        'g'
      ),
      '(<strong>(\s|&nbsp;)*P(é|&eacute;)riodicit(é|&eacute;)(\s|&nbsp;)*:(\s|&nbsp;)*</strong>(\s|&nbsp;)*)Abonnement(\s|&nbsp;)+annuel(\s|&nbsp;)+(à|&agrave;)(\s|&nbsp;)+reconduction(\s|&nbsp;)+tacite',
      '\1{{periodLabel}}',
      'g'
    ),
    placeholders = CASE
      WHEN placeholders IS NULL OR placeholders::text LIKE '%amountLabel%' THEN placeholders
      ELSE replace(placeholders::text, '"nextBillingDate"', '"nextBillingDate", "planLabel", "amountLabel", "periodLabel"')
    END,
    updated_at = now()
WHERE upper(type) = 'PREMIUM_CONFIRMATION'
  AND (body ~ '59(\s|&nbsp;)*(€|&euro;)(\s|&nbsp;)*/(\s|&nbsp;)*an'
       OR body ~ 'Offre(\s|&nbsp;)*:(\s|&nbsp;)*</strong>(\s|&nbsp;)*Verebona(\s|&nbsp;)+Premium'
       OR body ~ 'Abonnement(\s|&nbsp;)+annuel(\s|&nbsp;)+(à|&agrave;)(\s|&nbsp;)+reconduction');
