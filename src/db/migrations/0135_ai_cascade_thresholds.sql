-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0135 : seuils de la cascade T2 — CDC BO IA §11.2, SCR-03.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- CE QUE CETTE MIGRATION REND ADMINISTRABLE, ET POURQUOI C'EST UNE DÉCISION
--
-- Le §11.2 définit quatre niveaux de recherche — base structurée, texte,
-- sémantique, LLM — et une règle de non-escalade : « le recours à un niveau plus
-- coûteux n'est autorisé que si le niveau précédent n'apporte pas une confiance
-- ou une pertinence suffisante ».
--
-- Le CDC ne dit nulle part où se règle ce « suffisante », et le SCR-03 ne
-- présente la cascade que comme des indicateurs. L'exposer est donc un ajout
-- assumé, décidé le 18/09/2026 : c'est le levier économique le plus direct du
-- produit, et le laisser dans le code imposerait un déploiement pour arbitrer
-- entre coût et qualité.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- POURQUOI UNE COLONNE JSONB PLUTÔT QUE TROIS COLONNES
--
-- Ces seuils ne concernent QUE T2. Trois colonnes nulles sur les quatre autres
-- traitements laisseraient croire qu'elles peuvent y être renseignées, et il
-- faudrait un contrôle pour l'interdire. Une colonne unique, absente ailleurs,
-- dit d'elle-même qu'elle n'appartient qu'à un traitement.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- LA VALEUR PAR DÉFAUT EST « AUCUN SEUIL », PAS UNE VALEUR NEUTRE
--
-- `NULL` et non un objet pré-rempli : une version existante n'a jamais été
-- configurée pour cette cascade, et lui attribuer des seuils reviendrait à
-- affirmer un arbitrage que personne n'a rendu. Le service retombe alors sur
-- les valeurs du code, comme avant.
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE ai_config_entries
  ADD COLUMN IF NOT EXISTS cascade JSONB;

COMMENT ON COLUMN ai_config_entries.cascade IS
  'Seuils de la cascade coût/qualité — T2 uniquement (CDC BO IA §11.2). '
  'NULL = non configuré, le code décide.';
