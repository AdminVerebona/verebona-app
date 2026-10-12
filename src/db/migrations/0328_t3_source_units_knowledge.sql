-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0328 : T3 exploite la couche exhaustive T1 (lot 49B — ticket « T3 :
-- exploiter la couche exhaustive T1 (document_source_units) dans la
-- réconciliation », §5 à §8).
--
-- La couche exhaustive T1 (`document_source_units`, `document_unresolved_facts`,
-- migrations 0295-0297) devient une SOURCE de T3 DOCUMENT_ASSET. Une évolution
-- de cette couche (analyse, reprise ciblée, reprise historique) doit donc
-- rendre les décisions T3 ouvertes POTENTIELLEMENT réévaluables, comme un fait
-- ou une extraction : journal de connaissance 0292 (`account_knowledge_changes`,
-- nature ANALYSIS), par INSTRUCTION (une analyse écrit des centaines d'unités ;
-- une ligne par compte et par instruction suffit).
--
-- La révision n'est qu'un SIGNAL : le balayage T3 recalcule l'empreinte du
-- contexte (seules les unités qui désignent un candidat y entrent) — aucun
-- appel IA sans changement de contexte pertinent.
--
-- VERROUS : déclencheurs seulement (verrou SHARE ROW EXCLUSIVE bref, borné par
-- lock_timeout). Idempotente (CREATE OR REPLACE, DROP TRIGGER IF EXISTS).
-- Tables absentes (0295-0297 non appliquées) : rien n'est créé.
-- Retour arrière : DROP TRIGGER t3_knowledge_source_units_* ON document_source_units ;
-- DROP TRIGGER t3_knowledge_unresolved_* ON document_unresolved_facts ;
-- DROP FUNCTION account_knowledge_source_layer_changed().
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION account_knowledge_source_layer_changed() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO account_knowledge_changes (account_id, kind, object_type)
    SELECT DISTINCT n.account_id, 'ANALYSIS', TG_TABLE_NAME FROM kn_new n WHERE n.account_id IS NOT NULL;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO account_knowledge_changes (account_id, kind, object_type)
    SELECT DISTINCT o.account_id, 'ANALYSIS', TG_TABLE_NAME FROM kn_old o WHERE o.account_id IS NOT NULL;
  ELSE
    INSERT INTO account_knowledge_changes (account_id, kind, object_type)
    SELECT DISTINCT n.account_id, 'ANALYSIS', TG_TABLE_NAME FROM kn_new n WHERE n.account_id IS NOT NULL;
  END IF;
  RETURN NULL;
END
$fn$;

DO $do$
BEGIN
  IF to_regclass('document_source_units') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS t3_knowledge_source_units_ins ON document_source_units;
    CREATE TRIGGER t3_knowledge_source_units_ins AFTER INSERT ON document_source_units
      REFERENCING NEW TABLE AS kn_new FOR EACH STATEMENT EXECUTE FUNCTION account_knowledge_source_layer_changed();
    DROP TRIGGER IF EXISTS t3_knowledge_source_units_del ON document_source_units;
    CREATE TRIGGER t3_knowledge_source_units_del AFTER DELETE ON document_source_units
      REFERENCING OLD TABLE AS kn_old FOR EACH STATEMENT EXECUTE FUNCTION account_knowledge_source_layer_changed();
    DROP TRIGGER IF EXISTS t3_knowledge_source_units_upd ON document_source_units;
    CREATE TRIGGER t3_knowledge_source_units_upd AFTER UPDATE ON document_source_units
      REFERENCING NEW TABLE AS kn_new FOR EACH STATEMENT EXECUTE FUNCTION account_knowledge_source_layer_changed();
  END IF;
  IF to_regclass('document_unresolved_facts') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS t3_knowledge_unresolved_ins ON document_unresolved_facts;
    CREATE TRIGGER t3_knowledge_unresolved_ins AFTER INSERT ON document_unresolved_facts
      REFERENCING NEW TABLE AS kn_new FOR EACH STATEMENT EXECUTE FUNCTION account_knowledge_source_layer_changed();
    DROP TRIGGER IF EXISTS t3_knowledge_unresolved_del ON document_unresolved_facts;
    CREATE TRIGGER t3_knowledge_unresolved_del AFTER DELETE ON document_unresolved_facts
      REFERENCING OLD TABLE AS kn_old FOR EACH STATEMENT EXECUTE FUNCTION account_knowledge_source_layer_changed();
  END IF;
END
$do$;
