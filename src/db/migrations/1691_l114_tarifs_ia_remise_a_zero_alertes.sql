-- ─────────────────────────────────────────────────────────────────────────
-- Migration 1691 : IA — remise à zéro des alertes tarifaires héritées
-- (lot 114, carte Trello #770, §5 « Remise à zéro des alertes tarifaires »).
--
-- Règle nouvelle (#770) : aucun modèle n'est appelé sans tarif officiel
-- vérifié. Les alertes tarifaires ouvertes AVANT cette règle décrivent
-- l'ancienne politique (appels autorisés sans tarif) : elles sont CLÔTURÉES
-- une fois, à la bascule, avec le motif `REBASE_PRICING_POLICY_PRE_MEP`.
--
--   · `ai_pricing_policy_rebase` (nouvelle) : UNE ligne par politique —
--     date de la bascule, décomptes et identifiants des alertes clôturées
--     (avant / après), pour l'audit. La date sert de frontière : un appel
--     non chiffré ANTÉRIEUR est de l'historique financier (visible dans
--     Coûts IA, sans alerte) ; un appel non chiffré POSTÉRIEUR est une
--     anomalie actuelle (alerte ciblée).
--   · alertes clôturées : UNIQUEMENT les cinq codes tarifaires
--     (`ai_pricing_active_unpriced`, `ai_pricing_unpriced_calls`,
--     `ai_pricing_stale`, `ai_pricing_source_unreadable`, ancien
--     `ai_pricing_model_unpriced`), encore non résolues. Aucune autre famille
--     d'alertes n'est touchée. Aucune ligne n'est supprimée : ni alerte, ni
--     trace d'usage, ni prix, ni correction, ni écriture de coût.
--
-- IDEMPOTENTE : la ligne de politique est la garde — un second passage ne
-- clôture rien et ne modifie pas la date de bascule. ADDITIVE : une table
-- nouvelle, aucune colonne modifiée. Sans les tables d'alertes (base neuve
-- incomplète), la bascule est enregistrée avec un décompte nul.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_pricing_policy_rebase (
  policy        TEXT PRIMARY KEY,
  applied_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason        TEXT NOT NULL,
  closed_count  INTEGER NOT NULL DEFAULT 0,
  -- { before: { <code>: n }, after: { <code>: n }, closedIds: [...], otherFamiliesOpenBefore: n, otherFamiliesOpenAfter: n }
  details       JSONB NOT NULL DEFAULT '{}'::jsonb
);

DO $$
DECLARE
  codes     TEXT[] := ARRAY['ai_pricing_active_unpriced', 'ai_pricing_unpriced_calls', 'ai_pricing_stale', 'ai_pricing_source_unreadable', 'ai_pricing_model_unpriced'];
  avant     JSONB := '{}'::jsonb;
  apres     JSONB := '{}'::jsonb;
  ids       JSONB := '[]'::jsonb;
  autres_av INTEGER := 0;
  autres_ap INTEGER := 0;
  n         INTEGER := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM ai_pricing_policy_rebase WHERE policy = 'REBASE_PRICING_POLICY_PRE_MEP') THEN
    RETURN; -- déjà appliquée : aucun effet
  END IF;

  BEGIN
    SELECT COALESCE(jsonb_object_agg(code, c), '{}'::jsonb) INTO avant
      FROM (SELECT code, COUNT(*)::int AS c FROM ai_alerts WHERE code = ANY(codes) AND resolved_at IS NULL GROUP BY code) s;
    SELECT COUNT(*)::int INTO autres_av FROM ai_alerts WHERE NOT (code = ANY(codes)) AND resolved_at IS NULL;

    WITH clos AS (
      UPDATE ai_alerts
         SET resolved_at = NOW(), resolved_by = NULL,
             resolution_code = 'REBASE_PRICING_POLICY_PRE_MEP',
             resolution_reason = 'Remise à zéro à la bascule #770 : alerte de l’ancienne politique tarifaire (appels autorisés sans tarif). L’historique financier reste consultable dans Coûts IA.'
       WHERE code = ANY(codes) AND resolved_at IS NULL
      RETURNING id
    )
    SELECT COUNT(*)::int, COALESCE(jsonb_agg(id ORDER BY id), '[]'::jsonb) INTO n, ids FROM clos;

    SELECT COALESCE(jsonb_object_agg(code, c), '{}'::jsonb) INTO apres
      FROM (SELECT code, COUNT(*)::int AS c FROM ai_alerts WHERE code = ANY(codes) AND resolved_at IS NULL GROUP BY code) s;
    SELECT COUNT(*)::int INTO autres_ap FROM ai_alerts WHERE NOT (code = ANY(codes)) AND resolved_at IS NULL;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    n := 0; -- alertes sans cycle de vie (migration 1521 absente) : rien à clôturer
  END;

  INSERT INTO ai_pricing_policy_rebase (policy, reason, closed_count, details)
  VALUES ('REBASE_PRICING_POLICY_PRE_MEP',
          'Carte Trello #770 : éligibilité tarifaire obligatoire — alertes tarifaires héritées clôturées, historique financier conservé.',
          n,
          jsonb_build_object('before', avant, 'after', apres, 'closedIds', ids,
                             'otherFamiliesOpenBefore', autres_av, 'otherFamiliesOpenAfter', autres_ap))
  ON CONFLICT (policy) DO NOTHING;
END $$;
