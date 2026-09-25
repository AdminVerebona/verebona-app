-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0137 — Email de réinitialisation : phrase de sécurité (rattrapage)
--
-- ── POURQUOI UNE NOUVELLE MIGRATION ───────────────────────────────────────
--
-- La 0130 devait déjà remplacer « Si vous n'avez pas demandé cette
-- réinitialisation, vous pouvez ignorer cet email. » Elle est jouée, mais la
-- phrase part toujours. Deux angles morts de sa clause de sélection :
--
--   1. `WHERE type = 'PASSWORD_RESET'` est sensible à la casse. Or la 0077 a
--      enregistré des gabarits en minuscules (voir le commentaire de
--      `email-service.ts`, qui compare désormais avec `upper()`). Une ligne
--      `password_reset` est bien celle qui est envoyée… et n'était pas visée.
--   2. Un gabarit HTML retouché dans l'administration encode l'apostrophe et
--      les accents sous des formes absentes de la 0130 (`&#039;`, `&#x27;`,
--      `&rsquo;`, `&#8217;`, `&eacute;`…) ou insère `&nbsp;`.
--
-- ── REMPLACEMENT CIBLÉ ────────────────────────────────────────────────────
--
-- Comme la 0130 : on remplace la phrase, pas le gabarit. Variantes acceptées
-- (casse, apostrophes, accents encodés, espaces insécables, « de mot de
-- passe », « simplement », email / e-mail / courriel / message).
-- Rejouable sans effet : une fois remplacée, la phrase n'est plus trouvée.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE email_templates
SET body = regexp_replace(
      body,
      'Si(\s|&nbsp;)+vous(\s|&nbsp;)+n(''|’|ʼ|&#0?39;|&#x27;|&apos;|&rsquo;|&#8217;)avez(\s|&nbsp;)+pas(\s|&nbsp;)+demand(é|&eacute;|&#233;)(\s|&nbsp;)+cette(\s|&nbsp;)+r(é|&eacute;|&#233;)initialisation((\s|&nbsp;)+de(\s|&nbsp;)+(votre(\s|&nbsp;)+)?mot(\s|&nbsp;)+de(\s|&nbsp;)+passe)?(\s|&nbsp;)*,(\s|&nbsp;)*(vous(\s|&nbsp;)+pouvez(\s|&nbsp;)+)?(simplement(\s|&nbsp;)+)?ignorer(\s|&nbsp;)+(cet|ce)(\s|&nbsp;)+(e-?mail|courriel|message)(\s|&nbsp;)*\.?',
      'Si vous n’êtes pas à l’origine de cette demande, ne cliquez pas sur le lien de réinitialisation. Si vous avez un doute concernant la sécurité de votre compte, modifiez votre mot de passe directement depuis Verebona.',
      'gi'
    ),
    updated_at = now()
WHERE upper(type) = 'PASSWORD_RESET'
  AND body ~* 'ignorer(\s|&nbsp;)+(cet|ce)(\s|&nbsp;)+(e-?mail|courriel|message)';
