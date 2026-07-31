-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0121 — Élargissement des contraintes redéfinies hors ordre
--
-- ── POURQUOI UNE MIGRATION DE PLUS ────────────────────────────────────────
--
-- Cinq contraintes sont posées par une migration puis redéfinies par une
-- suivante. Tant que l'ordre est respecté, seule la dernière compte.
--
-- Mais une migration en ÉCHEC n'est pas enregistrée : elle est retentée au
-- démarrage suivant, donc APRÈS celles qui l'ont suivie entre-temps. Une
-- valeur périmée écrase alors une valeur récente.
--
-- C'est ce qui s'est produit en préproduction :
--
--   1. `drizzle-kit push` pose la contrainte de `schema.ts` — correcte ;
--   2. premier démarrage : 0066 s'applique — toujours correcte. 0055 échoue
--      et n'est donc pas enregistrée ;
--   3. 0055 est réparée ; second démarrage : elle s'applique ENFIN, après
--      0066, et rétablit `FREEMIUM/PREMIUM/DUO/ENTERPRISE`.
--
-- L'inscription refusait alors le plan `STANDARD`, avec un `23514`.
--
-- Les migrations 0054, 0055 et 0119 portent désormais leur valeur finale dès
-- leur première définition : l'ordre est devenu indifférent. Mais elles sont
-- déjà enregistrées comme appliquées sur les bases existantes — elles ne
-- seront pas rejouées. D'où cette migration, qui rétablit l'état correct
-- partout, sans intervention manuelle.
--
-- ── SANS DANGER PAR NATURE ────────────────────────────────────────────────
--
-- Les cinq contraintes sont ÉLARGIES : chaque nouvelle liste contient
-- l'ancienne. Aucune ligne existante ne peut devenir non conforme.
--
-- PostgreSQL le confirme d'ailleurs à l'usage : un resserrement violé par une
-- ligne existante est refusé — « is violated by some row ». L'élargissement,
-- lui, ne peut pas échouer pour cette raison.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── accounts.plan_type — aligné sur 0066 ──────────────────────────────────
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_plan_type_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_plan_type_check
    CHECK (plan_type IN (
      -- modèle commercial actuel
      'STANDARD', 'PREMIUM', 'DUO', 'PREMIUM_DUO', 'PRO',
      -- codes historiques, conservés pour les lignes déjà enregistrées
      'FREEMIUM', 'ENTERPRISE'
    ));

-- ── users.plan_type — aligné sur 0112 ─────────────────────────────────────
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_plan_type;
ALTER TABLE users
  ADD CONSTRAINT chk_users_plan_type
    CHECK (plan_type IN (
      'STANDARD', 'PREMIUM', 'PREMIUM_DUO', 'PREMIUM_PRO',
      'FREEMIUM', 'DUO', 'ENTERPRISE'
    ));

-- ── assets.status — aligné sur 0057 ───────────────────────────────────────
ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_status_check;
ALTER TABLE assets
  ADD CONSTRAINT assets_status_check
    CHECK (status IN (
      'EN_SERVICE', 'EN_MAINTENANCE', 'HORS_SERVICE', 'ARCHIVED',
      -- ajouté par 0057
      'TRANSMIS'
    ));

-- ── asset_files : origines de classement — alignées sur 0120 ──────────────
ALTER TABLE asset_files DROP CONSTRAINT IF EXISTS asset_files_category_source_check;
ALTER TABLE asset_files
  ADD CONSTRAINT asset_files_category_source_check
    CHECK (category_source IS NULL OR category_source IN
      ('AI', 'USER', 'REFERENCE_CORRECTION', 'RULE'));

ALTER TABLE asset_files DROP CONSTRAINT IF EXISTS asset_files_type_source_check;
ALTER TABLE asset_files
  ADD CONSTRAINT asset_files_type_source_check
    CHECK (type_source IS NULL OR type_source IN
      ('AI', 'USER', 'REFERENCE_CORRECTION', 'RULE'));
