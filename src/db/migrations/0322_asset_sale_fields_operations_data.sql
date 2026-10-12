-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0322 : données de vente du bien et migration structurée des
-- Opérations (lot 43, O4 — CDC Opérations V1 ch. 14, 26, B13.1, B13.3,
-- B13.6, B18, C2, C4 TRG-008 à TRG-010, C7.1, C7.3, C7.6, C11.1, C18, C23.1 ;
-- décisions PO Q5, Q6, Q12 du 11/10).
--
-- 1. Champs de vente (décision PO Q5) : clés canoniques du registre
--    `saleDate` et `salePrice` (fiche `key_characteristics`, euros comme
--    `acquisitionPrice` — D-09 ; centimes EUR dans la composante PROCEED de
--    la Cession). Aucune colonne : rien à migrer pour elles. Le prix SOUHAITÉ
--    (`asset_additional_infos`, `desiredSalePriceCents`) reste distinct (C18 :
--    prix souhaité ≠ prix réalisé ≠ valeur estimée).
--
--    Les colonnes ci-dessous ne sont PAS déclarées dans le schéma Drizzle
--    (convention de `db/schema.ts` pour une colonne ajoutée à une table
--    existante) : lues en SQL seulement, une migration différée ne casse
--    aucune écriture de `assets`.
--
-- 2. `status_changed_at` : date du passage au statut courant (C7.6, C11.1 :
--    repli éditable de la date de cession quand aucune date de vente n'est
--    saisie). Posée par le déclencheur ci-dessous à CHAQUE changement de
--    statut, quel que soit le chemin (fiche, « À traiter » ASSET-STATUS,
--    transmission acceptée, ancienne route PUT, assistant) — aucune écriture
--    ne peut l'oublier. Les biens déjà VENDU / TRANSMIS n'en ont pas (date
--    inconnue : jamais inventée).
--
-- 3. `operations_data_changed_at` : dernière modification d'une donnée
--    structurée susceptible d'établir une Opération (statut, colonnes d'achat,
--    fiche `key_characteristics`). Filet de l'état (« l'état fait
--    foi, pas l'événement », lot 41) : la tâche interne
--    `operations-structured-migration` reprend un bien modifié après son
--    dernier passage si l'événement `asset_updated` a été perdu. Aucune
--    écriture Opération ne touche `assets` (pas de boucle fiche ↔ Opération).
--
-- 4. `business_operation_asset_data_marks` : un passage par bien (clé
--    stable bien × version de migration C23.1, natures dans `outcomes`) —
--    empreinte des données structurées examinées, issue par nature. Rejouer
--    un bien déjà marqué sans changement n'écrit rien (C23.1, C27). Aucune
--    donnée visible pour l'utilisateur (P09).
--
-- Idempotente (IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF EXISTS) ;
-- expand seulement. Colonnes nullables sans défaut : ajout instantané. Le
-- déclencheur ne s'exécute que si l'une des colonnes surveillées CHANGE
-- (clause WHEN) : aucune lecture, une affectation en mémoire.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE assets ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS operations_data_changed_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION assets_operations_data_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IN ('VENDU', 'TRANSMIS') AND NEW.status_changed_at IS NULL THEN
      NEW.status_changed_at := now();
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := now();
  END IF;
  NEW.operations_data_changed_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assets_operations_data_touch_ins ON assets;
CREATE TRIGGER assets_operations_data_touch_ins
  BEFORE INSERT ON assets
  FOR EACH ROW EXECUTE FUNCTION assets_operations_data_touch();

DROP TRIGGER IF EXISTS assets_operations_data_touch_upd ON assets;
CREATE TRIGGER assets_operations_data_touch_upd
  BEFORE UPDATE ON assets
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
        OR OLD.purchase_date IS DISTINCT FROM NEW.purchase_date
        OR OLD.purchase_price_cents IS DISTINCT FROM NEW.purchase_price_cents
        OR OLD.key_characteristics IS DISTINCT FROM NEW.key_characteristics)
  EXECUTE FUNCTION assets_operations_data_touch();

CREATE TABLE IF NOT EXISTS business_operation_asset_data_marks (
  asset_id INTEGER PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  migration_version TEXT NOT NULL,
  data_fingerprint TEXT NOT NULL,
  outcomes JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT business_operation_asset_data_marks_outcomes_chk CHECK (jsonb_typeof(outcomes) = 'object')
);
