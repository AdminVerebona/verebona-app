-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0704 : réévaluation historique des contrôles de cohérence quand une
-- version de règles change PENDANT une campagne (lot 85B — CDC cohérence §6.4,
-- CA-11, CA-12 ; arbitrages PO C-Q1, C-Q4).
--
-- Le curseur d'une campagne désignait le contrôle courant par sa POSITION dans
-- le registre (`cursor_check_index`). Un déploiement qui ajoute, retire ou
-- réordonne un contrôle en cours de campagne décalait cette position. Le
-- contrôle courant est désormais aussi mémorisé par son IDENTIFIANT
-- (`cursor_check_id`) : à la reprise, la position est recalculée dans le
-- registre du code déployé.
--
-- `rules_changes` : journal des changements de version de règles constatés en
-- cours de campagne (instant, phase, version du registre avant / après,
-- contrôles dont la version a changé, ajoutés, retirés, vérification
-- relancée). Une campagne n'est COMPLETE que si chaque objet attendu a un
-- contrôle RÉUSSI selon la version de règles EN VIGUEUR à sa clôture.
--
-- Colonnes nullables / avec défaut : l'ancien code les ignore. Idempotente,
-- rejouable. Retour arrière : colonnes sans effet pour l'ancien code.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('coherence_campaigns') IS NOT NULL THEN
    ALTER TABLE coherence_campaigns ADD COLUMN IF NOT EXISTS cursor_check_id TEXT;
    ALTER TABLE coherence_campaigns ADD COLUMN IF NOT EXISTS rules_changes JSONB NOT NULL DEFAULT '[]'::jsonb;
    COMMENT ON COLUMN coherence_campaigns.cursor_check_id IS
      'Lot 85B : contrôle courant du curseur, par identifiant (position recalculée si le registre change en cours de campagne).';
    COMMENT ON COLUMN coherence_campaigns.rules_changes IS
      'Lot 85B (CDC §6.4) : changements de version de règles constatés en cours de campagne (contrôles modifiés, ajoutés, retirés ; vérification relancée).';
  END IF;
END $$;
