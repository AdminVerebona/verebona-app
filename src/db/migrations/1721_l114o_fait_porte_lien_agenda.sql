-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1721 : le FAIT PORTÉ par un lien N↔N remplace le rôle « principal »
-- (lot 114O, carte Trello #744, CDC « Opérations / Agenda V2.0 » §4, §12, §13,
-- §16, §20, §22 ; AC16, AC22 à AC27, AC31, AC40, AC52, AC61, AC65 ; travaux F
-- de la carte — abandon du rôle par le traitement T4 et ses projections).
--
-- AVANT : l'élément d'Agenda qui REPRÉSENTAIT une Opération portait le rôle
-- `agenda_items.operation_role = 'PRINCIPAL'` (au plus un par Opération, index
-- `agenda_items_operation_principal_uidx`), écrit par la projection T4. Ce rôle
-- hiérarchisait les éléments d'un même regroupement (un « principal », des
-- « liés »), ne pouvait rien dire d'un élément PARTAGÉ par deux Opérations (une
-- seule colonne, une seule Opération) et le CDC V2.0 l'interdit : « Opération--
-- événement : N↔N, lien facultatif des deux côtés, SANS "principal" » (§4) ;
-- « l'ancien événement "principal" et son rôle PRINCIPAL/RELATED ne constituent
-- plus la condition d'existence ou d'affichage d'une opération » (§16).
--
-- CIBLE — le FAIT PORTÉ (`business_operation_agenda_links.fact_key`) : le lien
-- N↔N dit QUEL FAIT de l'événement de référence cet élément porte (la clé de
-- projection, sans sa partie datée : ACQUISITION, INTERVENTION, CLAIM,
-- DISPOSAL, CONTRACT:END, ou UNQUALIFIED quand le fait n'est pas qualifié).
-- C'est une QUALIFICATION DE LA RELATION, prévue par le CDC (§4 : « pour chaque
-- relation : identifiants des extrémités, compte, rôle/nature, origine […],
-- version […] »), et non un rang entre les éléments :
--   · aucun ordre, aucun « au plus un par Opération » : un événement de
--     référence a 0..N porteurs, AU PLUS UN PAR FAIT, et tous ses autres liens
--     sont des membres de plein droit (AC23, AC26, AC27) ;
--   · le fait est porté PAR LE LIEN : le même élément d'Agenda peut porter le
--     fait d'une Opération et celui d'une autre (événement partagé, AC24,
--     AC31) — impossible avec une colonne de rôle unique ;
--   · un élément sans fait porté reste exactement aussi visible, à sa date,
--     avec son rappel et sa fiche (AC21 à AC25) ;
--   · il ne sert qu'à l'IDEMPOTENCE de la projection T4 (« le fait est déjà
--     porté : ne rien créer ») et à la propagation des documents de
--     l'Opération déjà livrée (provenance `OPERATION_PRINCIPAL`, §7.4, nom de
--     valeur historique conservé — contrainte CHECK existante).
--
-- 1. `business_operation_agenda_links.fact_key TEXT NULL` (additive).
--    Pas d'index unique : l'unicité « un porteur par fait » est tenue par le
--    service unique de regroupement (`business-operations/grouping`), pour ne
--    JAMAIS faire échouer un écrivain existant hors de ce service (fusion,
--    transfert de bien, réparateurs) ; un doublon éventuel est détecté et
--    réparé par l'invariant O1-FAIT-PORTE-UNIQUE.
-- 2. REPRISE DÉTERMINISTE, rejouable, sans décision nouvelle (AC61, AC64) :
--    chaque lien ACTIF reçoit le fait qu'il porte DÉJÀ —
--      a. la clé de projection portée par l'élément lui-même
--         (`agenda_items.functional_key = 'bo:v1:<opération>:<clé>'`) :
--         c'est la propre projection de l'Opération ;
--      b. à défaut, pour l'élément qui porte ENCORE le rôle historique
--         `operation_role = 'PRINCIPAL'` de cette Opération : le fait déduit du
--         TYPE de l'Opération (seule lecture du rôle de tout le chantier, ici,
--         une fois, pour ne perdre aucune désignation existante — y compris
--         celles de l'utilisateur).
--    Aucun événement n'est créé, daté, modifié ni supprimé ; aucun rappel n'est
--    touché ; aucun rôle n'est écrit ; la colonne `operation_role` reste EN
--    PLACE, inchangée (retrait seulement après recette, §22).
-- 3. Le déclencheur de compatibilité `agenda_items_operation_link_sync` (1716)
--    est reposé À L'IDENTIQUE, avec une seule addition : il efface le fait
--    porté quand il passe un lien à REMOVED (la colonne historique
--    `agenda_items.business_operation_id` reste tenue à l'identique dans le
--    graphe — un élément détaché ne porte plus aucun fait).
--
-- Additive, idempotente, rejouable. Retour arrière : ALTER TABLE
-- business_operation_agenda_links DROP COLUMN fact_key, puis reposer la
-- fonction `agenda_items_operation_link_sync` de la migration 1716 — la colonne
-- `agenda_items.operation_role`, intacte, redevient la seule désignation.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE business_operation_agenda_links ADD COLUMN IF NOT EXISTS fact_key TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_operation_agenda_links_fact_key_chk') THEN
    ALTER TABLE business_operation_agenda_links ADD CONSTRAINT business_operation_agenda_links_fact_key_chk
      CHECK (fact_key IS NULL OR (fact_key <> '' AND length(fact_key) <= 80));
  END IF;
END $$;

-- Lecture « qui porte ce fait ? » et « quel fait porte ce lien ? », bornées au compte.
CREATE INDEX IF NOT EXISTS business_operation_agenda_links_fact_idx
  ON business_operation_agenda_links (account_id, operation_id, fact_key)
  WHERE fact_key IS NOT NULL;

-- Compatibilité : le graphe suit la colonne historique (1716), et un lien retiré ne porte plus de fait.
CREATE OR REPLACE FUNCTION agenda_items_operation_link_sync() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.business_operation_id IS NOT DISTINCT FROM NEW.business_operation_id THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.business_operation_id IS NOT NULL THEN
    UPDATE business_operation_agenda_links
       SET state = 'REMOVED', legacy_column = false, fact_key = NULL, ended_at = now(), version = version + 1, updated_at = now(),
           reason_code = 'LEGACY_COLUMN_DETACHED'
     WHERE operation_id = OLD.business_operation_id AND agenda_item_id = NEW.id AND state = 'ACTIVE' AND legacy_column;
  END IF;
  IF NEW.business_operation_id IS NOT NULL THEN
    INSERT INTO business_operation_agenda_links (account_id, operation_id, agenda_item_id, state, origin, legacy_column, reason_code)
    SELECT NEW.account_id, o.id, NEW.id, 'ACTIVE',
           CASE NEW.operation_role_origin WHEN 'USER' THEN 'USER' WHEN 'T4' THEN 'AI' WHEN 'T3' THEN 'AI' ELSE 'SYSTEM' END,
           true, 'LEGACY_COLUMN_ATTACHED'
      FROM business_operations o
     WHERE o.id = NEW.business_operation_id AND o.account_id = NEW.account_id
    ON CONFLICT (operation_id, agenda_item_id) DO UPDATE
       SET state = 'ACTIVE', legacy_column = true, ended_at = NULL, account_id = EXCLUDED.account_id,
           -- Un lien RETIRÉ qui revient ne ramène pas le fait qu'il portait (seul le service de regroupement le repose).
           fact_key = CASE WHEN business_operation_agenda_links.state = 'REMOVED' THEN NULL ELSE business_operation_agenda_links.fact_key END,
           origin = CASE WHEN business_operation_agenda_links.state = 'ACTIVE' THEN business_operation_agenda_links.origin ELSE EXCLUDED.origin END,
           reason_code = CASE WHEN business_operation_agenda_links.state = 'ACTIVE' THEN business_operation_agenda_links.reason_code ELSE EXCLUDED.reason_code END,
           version = business_operation_agenda_links.version + 1, updated_at = now()
     WHERE NOT (business_operation_agenda_links.state = 'ACTIVE' AND business_operation_agenda_links.legacy_column);
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS agenda_items_operation_link_sync ON agenda_items;
CREATE TRIGGER agenda_items_operation_link_sync
  AFTER INSERT OR UPDATE OF business_operation_id ON agenda_items
  FOR EACH ROW EXECUTE FUNCTION agenda_items_operation_link_sync();

-- Reprise a : la propre projection de l'Opération porte son fait (clé de projection, partie datée retirée).
-- `NULLIF` : une clé fonctionnelle inattendue (partie datée SEULE) laisse le lien SANS fait porté
-- plutôt que de violer la contrainte `fact_key <> ''` — la migration ne peut pas échouer sur une donnée.
UPDATE business_operation_agenda_links l
   SET fact_key = NULLIF(regexp_replace(substring(ai.functional_key from '^bo:v1:' || l.operation_id || ':(.+)$'), ':[0-9]{4}-[0-9]{2}-[0-9]{2}$', ''), ''),
       updated_at = now()
  FROM agenda_items ai
 WHERE ai.id = l.agenda_item_id AND ai.account_id = l.account_id
   AND l.state = 'ACTIVE' AND l.fact_key IS NULL
   AND ai.functional_key ~ ('^bo:v1:' || l.operation_id || ':.+$');

-- Reprise b : désignation historique encore portée par le rôle (T4 ou utilisateur) → fait du TYPE de l'Opération.
UPDATE business_operation_agenda_links l
   SET fact_key = CASE o.type_code
                    WHEN 'CONTRACT' THEN 'CONTRACT:END'
                    WHEN 'INTERVENTION' THEN 'INTERVENTION'
                    WHEN 'CLAIM' THEN 'CLAIM'
                    WHEN 'ACQUISITION' THEN 'ACQUISITION'
                    WHEN 'DISPOSAL' THEN 'DISPOSAL'
                    WHEN 'FINANCING' THEN 'FINANCING'
                    WHEN 'OTHER' THEN 'OTHER'
                    ELSE 'UNQUALIFIED'
                  END,
       updated_at = now()
  FROM agenda_items ai, business_operations o
 WHERE ai.id = l.agenda_item_id AND ai.account_id = l.account_id
   AND o.id = l.operation_id AND o.account_id = l.account_id
   AND l.state = 'ACTIVE' AND l.fact_key IS NULL
   AND ai.business_operation_id = l.operation_id
   AND ai.operation_role = 'PRINCIPAL';
