-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0134 : credentials fournisseur IA — CDC BO IA SCR-10, WF-21.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- UNE CANDIDATE NE REMPLACE JAMAIS L'ACTIVE AVANT UN TEST RÉUSSI
--
-- C'est la règle du SCR-10, et la raison d'être de ces deux statuts. Une clé
-- saisie puis activée directement, si elle est fausse, arrête toute l'IA de
-- l'environnement — et le diagnostic partira chercher une panne fournisseur.
--
-- Le WF-21 décrit le parcours : saisir en candidate, tester, et seulement en cas
-- de succès complet remplacer l'active. En cas d'échec, « l'ancienne clé reste
-- active ».
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ⚠️ LA CLÉ EST STOCKÉE EN CLAIR — DÉCISION DU CDC, PAS UN CHOIX TECHNIQUE
--
-- Le SCR-10 prévoit une clé « visible en clair conformément à la décision V1 ».
-- Cette migration s'y conforme, et il faut en mesurer les conséquences :
-- quiconque accède à la base — sauvegarde, snapshot, console d'hébergeur —
-- accède au credential.
--
-- Deux garde-fous qui ne contredisent pas la décision :
--   · le SNP-007 exclut déjà les credentials du snapshot vers la préproduction,
--     et la colonne est nommée pour que ce filtrage reste évident ;
--   · le VER-011 les exclut des packages de MEP.
--
-- Chiffrer au repos reste possible sans changer l'interface : ce serait une
-- migration ultérieure, pas une remise en cause de l'écran.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- L'ENVIRONNEMENT RESTE LA SOURCE D'AMORÇAGE
--
-- Aucune ligne au premier démarrage : la gateway lit alors `GEMINI_API_KEY`,
-- comme aujourd'hui. Exiger une saisie en base rendrait tout déploiement neuf
-- muet jusqu'à ce qu'un administrateur se connecte.
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_provider_credential (
  id            SERIAL      PRIMARY KEY,
  provider      TEXT        NOT NULL DEFAULT 'gemini',

  -- ⚠️ Secret. Jamais copié dans un snapshot (SNP-007) ni dans un package
  -- de MEP (VER-011).
  secret        TEXT        NOT NULL,

  status        TEXT        NOT NULL DEFAULT 'CANDIDATE',

  -- Résultat du dernier test : validité, API, modèles, génération minimale.
  -- Conservé pour que l'écran explique un refus d'activation plutôt que de dire
  -- « test échoué ».
  last_test_at      TIMESTAMPTZ,
  last_test_ok      BOOLEAN,
  last_test_detail  JSONB,

  created_by    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  activated_at  TIMESTAMPTZ,
  retired_at    TIMESTAMPTZ,

  CONSTRAINT ai_provider_credential_status_check
    CHECK (status IN ('CANDIDATE', 'ACTIVE', 'RETIRED'))
);

-- Une seule clé active par fournisseur, garantie par la base : deux activations
-- concurrentes laisseraient autrement l'environnement avec deux clés « actives »
-- et un comportement qui dépendrait de l'ordre de lecture.
CREATE UNIQUE INDEX IF NOT EXISTS ai_provider_credential_single_active_idx
  ON ai_provider_credential(provider) WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS ai_provider_credential_status_idx
  ON ai_provider_credential(provider, status);

COMMENT ON TABLE ai_provider_credential IS
  'Credentials fournisseur IA (CDC BO IA SCR-10, WF-21). '
  'Hors versioning et hors package de MEP (VER-011), hors snapshot (SNP-007).';

COMMENT ON COLUMN ai_provider_credential.secret IS
  'Secret en clair — décision V1 du SCR-10. Ne jamais inclure dans un export, '
  'un snapshot ou un journal.';
