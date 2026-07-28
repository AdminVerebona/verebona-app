-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0109 : Reprise des alertes de cohérence vers inconsistency_registry
-- CDC §4.2.9 et §7.1 — critère d'acceptation n°13
--
-- Les contradictions étaient stockées dans le blob JSON
-- `assets.key_characteristics.coherenceAlerts` : ni requêtables, ni historisées,
-- ni rattachables à une preuve. Elles rejoignent le registre, qui alimente la
-- catégorie « À arbitrer » de la page À traiter.
--
-- Les alertes déjà écartées par l'utilisateur (`dismissedCoherenceAlerts`) ne
-- sont PAS reprises : le geste de l'utilisateur est respecté.
-- ──────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  rec       RECORD;
  kc        JSONB;
  alert     JSONB;
  dismissed JSONB;
BEGIN
  FOR rec IN
    SELECT id, account_id, key_characteristics
      FROM assets
     WHERE key_characteristics IS NOT NULL
       AND deleted_at IS NULL
       AND key_characteristics LIKE '%coherenceAlerts%'
  LOOP
    BEGIN
      kc := rec.key_characteristics::jsonb;
    EXCEPTION WHEN others THEN
      CONTINUE;
    END;

    CONTINUE WHEN jsonb_typeof(kc -> 'coherenceAlerts') <> 'array';
    dismissed := COALESCE(kc -> 'dismissedCoherenceAlerts', '[]'::jsonb);

    FOR alert IN SELECT * FROM jsonb_array_elements(kc -> 'coherenceAlerts') LOOP
      CONTINUE WHEN alert ->> 'field' IS NULL;
      CONTINUE WHEN dismissed @> to_jsonb(alert ->> 'field');

      INSERT INTO inconsistency_registry (
        account_id, asset_id, field_key, current_value, proposed_value,
        source_type, source_detail, inconsistency_type, status,
        authority_rule, decision_mode, reason_code, current_origin
      ) VALUES (
        rec.account_id, rec.id, alert ->> 'field',
        alert ->> 'currentValue',
        COALESCE(alert ->> 'aiValue', alert ->> 'suggestedValue'),
        'reconciliation',
        COALESCE(alert ->> 'issue', 'incohérence détectée avant refonte'),
        'probable', 'open',
        'migration-0109', 'deterministic', 'LEGACY_COHERENCE_ALERT', 'UNKNOWN'
      )
      ON CONFLICT (asset_id, field_key) WHERE status = 'open' DO NOTHING;
    END LOOP;

    -- Le blob est vidé : le registre devient l'unique source de vérité.
    UPDATE assets
       SET key_characteristics = (kc - 'coherenceAlerts')::text
     WHERE id = rec.id;
  END LOOP;
END $$;
