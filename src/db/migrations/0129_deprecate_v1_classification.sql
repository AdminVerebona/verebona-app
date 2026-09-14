-- Migration 0129 — Dépréciation du classement V1 (CDC V2 §15)
--
-- ═════════════════════════════════════════════════════════════════════════════
-- CETTE MIGRATION NE SUPPRIME RIEN, ET C'EST DÉLIBÉRÉ
--
-- Le lot 4 est censé retirer les colonnes V1. Une migration qui les
-- supprimerait s'exécuterait automatiquement au déploiement, via
-- `ensureMigrations()` — c'est-à-dire avant que quiconque ait pu constater que
-- la bascule tient sur un compte réel.
--
-- Or la suppression d'une colonne est la seule opération de tout ce chantier
-- qu'un retour arrière de déploiement ne rattrape pas : le code revient, les
-- données non.
--
-- Cette migration se contente donc de DOCUMENTER l'état de dépréciation, dans
-- la base elle-même, là où le prochain développeur regardera. Le retrait
-- effectif est porté par `scripts/drop-v1-classification.ts`, exécuté à la
-- main, après sauvegarde, une fois la bascule tenue.
--
-- Idempotente. Aucune donnée n'est modifiée.
-- ═════════════════════════════════════════════════════════════════════════════

COMMENT ON COLUMN asset_files.document_category_id IS
  'DÉPRÉCIÉ (CDC V2 §15) — remplacé par asset_files.rubric_code. Conservé tant '
  'que la bascule V2 n''est pas tenue sur l''ensemble du parc. Retrait par '
  'scripts/drop-v1-classification.ts.';

COMMENT ON COLUMN asset_files.classification_state IS
  'DÉPRÉCIÉ (CDC V2 §13.1) — l''état est désormais DÉRIVÉ : rubric_code IS NULL '
  '⇒ « Sans rubrique ». Deux sources de vérité pour le même fait finissent '
  'toujours par diverger.';

COMMENT ON COLUMN asset_files.category_user_locked IS
  'DÉPRÉCIÉ — remplacé par rubric_user_validated (CDC V2 §12.2).';

COMMENT ON COLUMN asset_files.type_user_locked IS
  'DÉPRÉCIÉ — remplacé par type_user_validated (CDC V2 §12.2).';

COMMENT ON TABLE document_categories IS
  'DÉPRÉCIÉ (CDC V2 §13.2) — le référentiel est versionné dans le code, à '
  'src/lib/referential/v2. Aucun CRUD back-office n''est requis en V2. La table '
  'sert encore l''affichage V1 pendant la bascule.';

-- ── Contrôle de cohérence, à titre d'observation ─────────────────────────────
--
-- Une vue plutôt qu'une contrainte : à ce stade, un document classé en V1 mais
-- pas encore en V2 est NORMAL — le retraitement du §11.6 est progressif. Poser
-- une contrainte ferait échouer des écritures légitimes ; une vue donne le
-- reste à traiter sans rien bloquer.

CREATE OR REPLACE VIEW v2_classification_progress AS
SELECT
  account_id,
  COUNT(*)                                                        AS total,
  COUNT(*) FILTER (WHERE rubric_code IS NOT NULL)                 AS classes_v2,
  COUNT(*) FILTER (WHERE rubric_code IS NULL)                     AS sans_rubrique,
  COUNT(*) FILTER (WHERE document_category_id IS NOT NULL
                     AND rubric_code IS NULL)                     AS a_retraiter,
  COUNT(*) FILTER (WHERE classification_referential_version IS DISTINCT FROM '2.0.0')
                                                                  AS version_obsolete
FROM asset_files
WHERE deleted_at IS NULL
GROUP BY account_id;

COMMENT ON VIEW v2_classification_progress IS
  'Avancement du retraitement V2 par compte (CDC V2 §11.6). `a_retraiter` doit '
  'atteindre 0 avant d''exécuter scripts/drop-v1-classification.ts.';
