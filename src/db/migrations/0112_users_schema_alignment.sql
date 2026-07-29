-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0112 — Alignement de la table `users` sur le schema Drizzle
--
-- POURQUOI CETTE MIGRATION EXISTE
--
-- La creation de compte renvoyait systematiquement « Une erreur interne est
-- survenue. » (POST /api/users, code INTERNAL_ERROR). Trois causes cumulees,
-- toutes situees dans le schema de `users` :
--
--   1. `feature_flags` est declaree dans le schema Drizzle mais n'a JAMAIS ete
--      creee par une migration.
--
--   2. `has_seen_upload_notice` est declaree en BOOLEAN dans le schema, mais
--      n'est creee par aucune migration non plus : seule une route
--      d'administration ad hoc (`/api/admin/migrate/upload-notice`) l'ajoutait,
--      et en INTEGER. Une base ou personne n'a appele cette route ne possede
--      pas la colonne.
--
--   Consequence : `db.select().from(users)` — Drizzle enumere TOUTES les
--   colonnes declarees — produit un 42703 `undefined_column`. Le controle
--   d'unicite de l'email, execute avant toute insertion, echouait donc avant
--   meme d'atteindre le bloc de gestion des erreurs de base : d'ou le message
--   generique et le 500 systematique.
--
--   3. La contrainte `chk_users_plan_type` posee par la migration 0054
--      n'autorise que ('FREEMIUM','PREMIUM','DUO','ENTERPRISE'), alors que
--      l'application ecrit 'STANDARD' et connait 'PREMIUM_DUO' / 'PREMIUM_PRO'
--      (cf. VALID_PLAN_TYPES). Meme une fois les colonnes retablies,
--      l'insertion aurait viole cette contrainte (23514).
--
-- Idempotente et sans perte : les valeurs historiques restent autorisees.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Colonnes manquantes ────────────────────────────────────────────────

ALTER TABLE users ADD COLUMN IF NOT EXISTS feature_flags TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS has_seen_upload_notice BOOLEAN NOT NULL DEFAULT FALSE;

-- ── 2. Correction du type pose par la route d'administration ad hoc ───────
-- Sur les bases ou `/api/admin/migrate/upload-notice` a ete appele, la colonne
-- existe en INTEGER. Le schema la lit en BOOLEAN : conversion explicite.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'users'
       AND column_name = 'has_seen_upload_notice'
       AND data_type IN ('integer', 'smallint', 'bigint')
  ) THEN
    ALTER TABLE users
      ALTER COLUMN has_seen_upload_notice DROP DEFAULT;
    ALTER TABLE users
      ALTER COLUMN has_seen_upload_notice TYPE BOOLEAN
      USING (has_seen_upload_notice <> 0);
    ALTER TABLE users
      ALTER COLUMN has_seen_upload_notice SET DEFAULT FALSE;
    ALTER TABLE users
      ALTER COLUMN has_seen_upload_notice SET NOT NULL;
  END IF;
END $$;

-- ── 3. Contrainte de plan alignee sur les codes reellement ecrits ─────────
-- Les anciens codes sont conservees : des lignes existantes les portent, et
-- une contrainte qui invaliderait des donnees deja en base echouerait ici,
-- laissant la migration en echec a chaque demarrage.

ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_plan_type;

ALTER TABLE users
  ADD CONSTRAINT chk_users_plan_type
    CHECK (plan_type IN (
      -- codes actuels (cf. VALID_PLAN_TYPES dans /api/users)
      'STANDARD', 'PREMIUM', 'PREMIUM_DUO', 'PREMIUM_PRO',
      -- codes historiques, conserves pour les lignes deja enregistrees
      'FREEMIUM', 'DUO', 'ENTERPRISE'
    ));

COMMENT ON COLUMN users.feature_flags IS
  'JSON des drapeaux fonctionnels propres a l''utilisateur. Nullable.';
COMMENT ON COLUMN users.has_seen_upload_notice IS
  'Bandeau d''information sur le depot de documents deja vu. BOOLEAN (0112).';
