-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1105 : retrait du statut global de vérification des fournisseurs
-- (lot 109B, ticket « Fournisseurs — Fiche unique, suppression du statut de
-- vérification et retour contextuel », §3).
--
-- Décision produit : un fournisseur existe dans le référentiel, SANS statut
-- « vérifié / non vérifié / partiellement vérifié ». Le code de ce lot ne lit
-- ni n'écrit plus `suppliers.contact_status` (vues, API, services, création
-- manuelle et automatique, tiroir Agenda, transfert entre comptes, schéma
-- Drizzle).
--
-- RETRAIT EN DEUX TEMPS (justification technique) : le `postdeploy` Scalingo
-- s'exécute pendant que l'ANCIENNE version sert encore le trafic
-- (scripts/migrate.mjs). Celle-ci nomme la colonne dans ses requêtes Drizzle
-- (lecture complète d'une fiche, création d'un fournisseur par l'analyse T1) :
-- la supprimer ici ferait échouer ces requêtes jusqu'à la bascule. Ce fichier
-- (temps 1) NEUTRALISE donc la colonne :
--   · plus de valeur par défaut ni d'obligation : aucune création nouvelle ne
--     reçoit « unverified » ;
--   · valeurs existantes CONSERVÉES (intégration lot 109 : migration additive,
--     aucune donnée effacée ; le code ne les lit plus, le temps 2 retire la
--     colonne entière).
-- Le temps 2 (DROP COLUMN, fichier 1106 prêt dans
-- docs/exploitation/recette-109b-fournisseurs-fiche-unique.md) s'applique au
-- déploiement SUIVANT, quand plus aucune version ne la nomme.
--
-- N'affecte PAS la fiabilité des relations : `document_suppliers.is_confirmed`,
-- `confidence_score`, provenances et arbitrages restent inchangés.
--
-- Idempotente, rejouable (colonne absente : rien). Les anciennes migrations
-- restent historiques. Retour arrière : ALTER TABLE suppliers ALTER COLUMN
-- contact_status SET DEFAULT 'unverified' (les anciennes versions lisent une
-- valeur absente comme « non vérifié »).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'suppliers' AND column_name = 'contact_status') THEN
    ALTER TABLE suppliers ALTER COLUMN contact_status DROP DEFAULT;
    ALTER TABLE suppliers ALTER COLUMN contact_status DROP NOT NULL;
  END IF;
END $$;
