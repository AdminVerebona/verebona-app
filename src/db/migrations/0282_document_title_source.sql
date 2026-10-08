-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0282 : titre MÉTIER des documents — source du titre, contrôle et
-- journal (lot 33C, ticket « T1/T3 : garantir le renommage métier des
-- documents »).
--
-- 1. asset_files.title_source  SYSTEM | USER (défaut SYSTEM). Un titre USER
--    n'est JAMAIS réécrit automatiquement (T1 ni T3). Posé à USER par
--    l'enregistrement d'un titre modifié dans le tiroir (PUT
--    /api/documents/:id) ; remis à SYSTEM par le service de titre quand il
--    écrit (compare-and-set sur titre ET source).
-- 2. asset_files.title_checked_at  dernier contrôle « données insuffisantes »
--    (ou dernière écriture système) : le balayage horaire ne reprend un tel
--    document qu'après une NOUVELLE analyse (pas de boucle horaire). N'est
--    pas un `updated_at` : poser cette date ne « modifie » pas le document.
-- 3. document_title_events  journal (UPDATED, SKIP_USER_TITLE sur titre non
--    conforme, SKIP_INSUFFICIENT_DATA, FAILED ; origine T1 / T3 ; ancien et
--    nouveau titre ; raison ; date). SKIP_VALID_TITLE n'y est jamais écrit.
--
-- 4. REPRISE DE L'HISTORIQUE (titres modifiés à la main avant ce lot) — USER
--    si l'historique le permet ET que le titre n'est pas technique :
--      · marque `user_edited_fields.retainedTitle = true` (tiroir) ;
--      · ou renommage journalisé (`admin_audit_log`, ASSET_UPDATE « Nom: … »)
--        dont le nom est toujours le titre courant.
--    RÈGLE PRUDENTE : la marque du tiroir était aussi posée À TORT quand on
--    réenregistrait un document sans toucher au nom (le champ était prérempli
--    avec le nom de fichier, « <uuid>.pdf », qui écrasait le titre). Un titre
--    TECHNIQUE marqué n'est donc PAS promu USER : il redevient réparable.
--    Le test SQL ci-dessous est un SUR-ENSEMBLE des titres techniques
--    (`technicalTitleSqlPredicate`, src/lib/documents/document-title-rules.ts) ;
--    les rares titres marqués qu'il écarte à tort (ex. « EDF », trois lettres)
--    sont promus USER à l'exécution par le service (règle JS exacte) avant
--    toute écriture. Sans historique, un titre non technique n'est de toute
--    façon jamais réécrit par T3 (seul un titre technique l'est).
--
-- VERROUS : ADD COLUMN avec défaut constant (métadonnées seules, PG ≥ 11) ;
-- contrainte NOT VALID puis VALIDATE (verrou SHARE UPDATE EXCLUSIVE, sans
-- bloquer les écritures) ; table neuve, index créés ici (table vide).
-- Idempotente : IF NOT EXISTS, contrainte testée, UPDATE limité aux lignes
-- encore SYSTEM.
-- Retour arrière : DROP TABLE document_title_events ; les colonnes peuvent
-- rester (l'ancien code les ignore).
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS title_source TEXT NOT NULL DEFAULT 'SYSTEM';
ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS title_checked_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_files_title_source_check') THEN
    ALTER TABLE asset_files ADD CONSTRAINT asset_files_title_source_check
      CHECK (title_source IN ('SYSTEM', 'USER')) NOT VALID;
  END IF;
END
$$;
ALTER TABLE asset_files VALIDATE CONSTRAINT asset_files_title_source_check;

COMMENT ON COLUMN asset_files.title_source IS
  'Source du titre (retained_title) : SYSTEM (titre automatique, réparable) | USER (saisi par l''utilisateur, jamais réécrit automatiquement).';
COMMENT ON COLUMN asset_files.title_checked_at IS
  'Dernier contrôle du titre par le service de titre (données insuffisantes ou écriture système) — pas une modification du document.';

CREATE TABLE IF NOT EXISTS document_title_events (
  id          BIGSERIAL   PRIMARY KEY,
  account_id  INTEGER     NOT NULL,
  file_id     INTEGER     NOT NULL,
  origin      TEXT        NOT NULL CHECK (origin IN ('T1', 'T3')),
  outcome     TEXT        NOT NULL CHECK (outcome IN ('UPDATED', 'SKIP_VALID_TITLE', 'SKIP_USER_TITLE', 'SKIP_INSUFFICIENT_DATA', 'FAILED')),
  reason      TEXT,
  old_title   TEXT,
  new_title   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Table neuve (vide) : index créés ici, sans CONCURRENTLY.
CREATE INDEX IF NOT EXISTS document_title_events_file_idx ON document_title_events (file_id, created_at);
CREATE INDEX IF NOT EXISTS document_title_events_created_idx ON document_title_events (created_at, outcome);

-- 4. Reprise de l'historique (voir en-tête).
UPDATE asset_files f
   SET title_source = 'USER'
 WHERE f.title_source = 'SYSTEM'
   AND f.deleted_at IS NULL
   AND NOT (f.retained_title IS NULL OR btrim(f.retained_title) = '' OR btrim(f.retained_title) ~* '^(verebona|owntrack)/u_[0-9]+/' OR btrim(f.retained_title) ~ '^[0-9]{10,13}_' OR regexp_replace(regexp_replace(regexp_replace(btrim(translate(unaccent(lower(coalesce(f.retained_title, ''))), '_', ' ')), '(\.[a-z0-9]{1,5}){1,2}$', ''), '[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}|[0-9a-f]{16,}|[a-z0-9]{20,}', ' ', 'g'), '\m(telechargement|attachment|screenshot|temporary|documents|uploaded|document|untitled|download|uploads|fichier|scanned|capture|nouveau|storage|upload|export|object|files|image|photo|video|mvimg|copie|titre|temp|file|blob|scan|dscn|dcim|copy|sans|uuid|tmp|doc|img|pic|pxl|dsc|vid|new|key|wa|id)', ' ', 'g') !~ '[a-z]{4,}')
   AND (
        COALESCE((f.user_edited_fields ->> 'retainedTitle') = 'true', false)
     OR (f.retained_title = f.original_filename
         AND EXISTS (SELECT 1 FROM admin_audit_log a
                      WHERE a.action_type = 'ASSET_UPDATE' AND a.target_type = 'document'
                        AND a.target_id = f.id AND a.details LIKE 'Nom: %'))
   );
