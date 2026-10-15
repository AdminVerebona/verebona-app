-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0398 : rattrapage initial — factures d'un même contrat (lot 55B,
-- ticket P1 « T3 / Opérations : rattacher automatiquement toutes les factures
-- d'un même contrat », développement C).
--
-- Aucune donnée métier n'est modifiée ici : la migration MARQUE seulement, pour
-- le passage T3 existant (balayage horaire interne, file T3, aucun nouveau
-- worker), les documents à réexaminer :
--
--   1. échéances DÉJÀ consolidées seules sur leur Opération (CREATE_NEW / M2 :
--      une seule source active, la leur), porteuses d'une période facturée
--      réelle ou d'un montant INSTALLMENT, ou qualifiées CONTRACT par T1, dont
--      une AUTRE Opération active du MÊME compte (contrat / intervention /
--      autre / non qualifiée) partage le prestataire ou un bien :
--      `t3_pending` + `t3_detail.retroRequested` (examen rétroactif :
--      consolidator.ts / retro.ts — M0, M1 ou verdict IA M3 certain, jamais le
--      seul prestataire ou montant) ;
--   2. rapprochements NON RÉSOLUS (attente / arbitrage, hors erreur technique)
--      de ces mêmes échéances : `t3_pending` (réexamen avec les règles 55B).
--
-- Idempotente : un candidat déjà marqué, en examen, ou déjà en file n'est pas
-- remarqué. Reprise après interruption : l'état est porté par chaque candidat
-- (le balayage traite 200 documents par passage et enchaîne). Comptes sans
-- échéance concernée : rien n'est marqué, aucun recalcul, aucun appel IA.
-- Isolation : chaque voisinage est cherché dans le compte du candidat.
-- Retour arrière : aucun (marques de travail ; sans le code 55B le passage T3
-- les consomme comme un réexamen ordinaire).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

UPDATE document_operation_candidates c
   SET t3_pending = true,
       t3_detail = COALESCE(c.t3_detail, '{}'::jsonb) || jsonb_build_object('retroRequested', jsonb_build_object('by', '0398', 'at', now()))
  FROM business_operations x
 WHERE x.id = c.t3_operation_id AND x.account_id = c.account_id
   AND c.status = 'ACTIVE' AND c.established AND NOT c.t3_pending
   AND c.t3_outcome IN ('CREATE_NEW', 'MATCH_AND_ENRICH')
   AND NOT (COALESCE(c.t3_detail, '{}'::jsonb) ? 'retroRequested')
   AND NOT (COALESCE(c.t3_detail, '{}'::jsonb) ? 'retro')
   AND x.invalidated_at IS NULL AND x.merged_into_operation_id IS NULL
   AND (x.type_code IS NULL OR x.type_code IN ('CONTRACT', 'INTERVENTION', 'OTHER'))
   -- Échéance (même règle que hasRecurringPeriod) ou qualification CONTRACT.
   AND (c.type_hint = 'CONTRACT' OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload->'financialHints') = 'array' THEN c.payload->'financialHints' ELSE '[]'::jsonb END) h
          WHERE h->>'amountScope' = 'INSTALLMENT'
             OR (h->>'periodStart' ~ '^\d{4}-\d{2}-\d{2}$' AND h->>'periodEnd' ~ '^\d{4}-\d{2}-\d{2}$' AND h->>'periodStart' < h->>'periodEnd')))
   -- Seule source active de son Opération.
   AND (SELECT count(*) FROM business_operation_sources s WHERE s.operation_id = x.id AND s.account_id = x.account_id AND s.active) = 1
   AND EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = x.id AND s.account_id = x.account_id AND s.active
                  AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = c.file_id::text AND s.locator->>'candidateKey' = c.candidate_key)
   -- Une autre Opération du MÊME compte partage le prestataire ou un bien.
   AND EXISTS (
         SELECT 1 FROM business_operations y
          WHERE y.account_id = x.account_id AND y.id <> x.id AND y.invalidated_at IS NULL AND y.merged_into_operation_id IS NULL
            AND (y.type_code IS NULL OR y.type_code IN ('CONTRACT', 'INTERVENTION', 'OTHER'))
            AND ((NULLIF(lower(btrim(y.provider)), '') = lower(btrim(x.provider)))
                 OR EXISTS (SELECT 1 FROM business_operation_asset_links l1
                              JOIN business_operation_asset_links l2 ON l2.asset_id = l1.asset_id AND l2.active AND l2.operation_id = y.id
                             WHERE l1.operation_id = x.id AND l1.active)));

-- Rapprochements non résolus des échéances : réexamen avec les règles 55B.
UPDATE document_operation_candidates c
   SET t3_pending = true
 WHERE c.status = 'ACTIVE' AND NOT c.t3_pending
   AND c.t3_outcome IN ('HOLD_UNRESOLVED', 'ARBITRATION_REQUIRED')
   AND (c.t3_reason IS NULL OR c.t3_reason NOT LIKE 'TECHNICAL_ERROR:%')
   AND NOT (COALESCE(c.t3_detail, '{}'::jsonb) ? 'retro')
   AND (c.type_hint = 'CONTRACT' OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload->'financialHints') = 'array' THEN c.payload->'financialHints' ELSE '[]'::jsonb END) h
          WHERE h->>'amountScope' = 'INSTALLMENT'
             OR (h->>'periodStart' ~ '^\d{4}-\d{2}-\d{2}$' AND h->>'periodEnd' ~ '^\d{4}-\d{2}-\d{2}$' AND h->>'periodStart' < h->>'periodEnd')));
