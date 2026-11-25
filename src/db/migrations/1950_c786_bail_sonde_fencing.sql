-- ─────────────────────────────────────────────────────────────────────────
-- Migration 1950 : IA — JETON DE CLÔTURE du bail de recontrôle (fencing)
-- (carte Trello #786, écart B03 « Nouvelle route sans réservation ; ancien
-- détenteur non écarté par fencing »).
--
-- Complète les migrations 1692 (#771), 1815 et 1816 (#786) SANS rien défaire :
--   · `probe_lease_generation` : numéro de GÉNÉRATION du bail de recontrôle,
--     incrémenté à CHAQUE réservation obtenue et rendu au détenteur. Ce
--     numéro est le JETON DE CLÔTURE (fencing token) du bail :
--       – `acquireProbeLease` l'incrémente dans l'UPDATE conditionnel qui
--         attribue le bail, et le rend à l'instance qui l'a obtenu ;
--       – `recordOperationalCheck` l'EXIGE des sources de sonde et REJETTE
--         (en l'historisant comme écarté, `discarded_reason = 'lease_fenced'`)
--         tout résultat dont le jeton est inférieur à la génération en cours.
--     Sans ce numéro, un détenteur dont le bail a expiré — processus gelé,
--     réseau lent — pouvait publier son résultat APRÈS la reprise du bail par
--     un autre worker, et écraser un verdict plus récent. Le bail borné de
--     1815 limitait la durée de la réservation ; il ne clôturait pas l'ancien
--     détenteur.
--   · la même colonne sur l'historique (`ai_model_operational_history`) : la
--     recette R13 et le BO peuvent dire SOUS QUEL BAIL chaque contrôle a été
--     envoyé, et donc pourquoi un résultat tardif a été écarté. Traçage
--     seulement : aucune décision ne s'y lit.
--
-- Rappel de l'invariant métier (#786) : un état INCONNU ne retire jamais un
-- modèle. Une réservation refusée ne déclare rien — elle dit seulement que la
-- sonde n'est pas partie, ce que le BO compte à part (« sonde non envoyée »).
--
-- IDEMPOTENTE et NON DESTRUCTIVE : `ADD COLUMN IF NOT EXISTS`,
-- `CREATE INDEX IF NOT EXISTS`. Aucune ligne modifiée ni supprimée, aucune
-- colonne ni contrainte retirée, aucune clé primaire touchée. Les lignes
-- existantes prennent la valeur par défaut 0 — « aucun bail encore attribué » —
-- ce qui n'écarte aucun résultat déjà enregistré. Rejouable sans effet.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('ai_model_operational_status') IS NOT NULL THEN
    -- Jeton de clôture du bail de recontrôle (B03).
    ALTER TABLE ai_model_operational_status
      ADD COLUMN IF NOT EXISTS probe_lease_generation BIGINT NOT NULL DEFAULT 0;
  END IF;

  IF to_regclass('ai_model_operational_history') IS NOT NULL THEN
    -- Traçage : sous quel bail ce contrôle a-t-il été envoyé (B03, R13).
    ALTER TABLE ai_model_operational_history
      ADD COLUMN IF NOT EXISTS probe_lease_generation BIGINT;
  END IF;
END $$;

-- Réservation d'une route NEUVE (B03) : `acquireProbeLease` insère la ligne
-- d'état manquante en `ON CONFLICT DO NOTHING`, puis retente l'UPDATE
-- conditionnel. Cet index sert la lecture du bail en cours par le cron et le BO.
CREATE INDEX IF NOT EXISTS ai_model_operational_status_lease_owner_idx
  ON ai_model_operational_status (provider, probe_lease_until)
  WHERE probe_lease_until IS NOT NULL;

COMMENT ON COLUMN ai_model_operational_status.probe_lease_generation IS
  'Numéro de génération du bail de recontrôle, incrémenté à chaque réservation obtenue (lot 115, carte #786, '
  'écart B03). C''est le JETON DE CLÔTURE du bail : un résultat de sonde dont le jeton est inférieur à cette '
  'génération vient d''un détenteur dépassé — il est rejeté et historisé comme écarté, jamais appliqué. '
  'Valeur 0 : aucun bail encore attribué à cette route.';

COMMENT ON COLUMN ai_model_operational_history.probe_lease_generation IS
  'Génération du bail sous laquelle ce contrôle a été envoyé (lot 115, carte #786, écart B03). Traçage de la '
  'recette R13 et du BO : il dit pourquoi un résultat tardif a été écarté. Vide : contrôle hors réservation '
  '(test de clé, qualification, refus reçu par un appel réel).';
