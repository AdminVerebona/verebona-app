-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0483 : éditeur des modèles d'e-mails transactionnels dans le BO
-- (lot 70A, décision PO du 19/10 — BO › Communications › E-mails transactionnels).
--
--   1. email_templates : marque de PERSONNALISATION et « texte livré » :
--        · is_customized / customized_at : enregistré depuis l'éditeur du BO ;
--        · shipped_subject / shipped_body : dernier texte LIVRÉ par l'application
--          (amorçages, migrations) — base de « Revenir au texte livré » ;
--        · shipped_updated_at : un texte livré plus récent est arrivé alors que le
--          gabarit était personnalisé (affiché dans le BO, jamais appliqué seul).
--      Reprise : un gabarit déjà enregistré depuis l'ancien écran du BO
--      (updated_by renseigné) est considéré personnalisé — même règle que 0465 ;
--      les autres reçoivent leur texte actuel comme texte livré.
--   2. email_template_versions : historique (qui, quand, quoi), une version
--      initiale par gabarit existant.
--   3. GARDE EN BASE (déclencheurs) : hors éditeur du BO (réglage de transaction
--      `verebona.email_template_edit` posé par le service), une écriture ne peut
--      ni écraser ni supprimer un gabarit personnalisé :
--        · UPDATE (migrations futures, amorçage « DO UPDATE ») → le texte reçu
--          devient le texte livré (shipped_*), le texte personnalisé est conservé ;
--        · INSERT d'un type déjà personnalisé (amorçage « DELETE puis INSERT »)
--          → idem, l'insertion est ignorée ;
--        · DELETE d'un gabarit personnalisé → ignoré.
--      La marque elle-même ne change que par l'éditeur. Les gabarits non
--      personnalisés se comportent comme avant (le texte livré suit).
--
-- Idempotente (IF NOT EXISTS, CREATE OR REPLACE, reprises conditionnelles).
-- Retour arrière : l'ancien code ignore colonnes, table et déclencheurs ; un
-- DROP TRIGGER suffit à rendre les amorçages destructeurs comme avant.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS is_customized boolean NOT NULL DEFAULT false;
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS customized_at timestamptz;
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS shipped_subject text;
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS shipped_body text;
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS shipped_updated_at timestamptz;

CREATE TABLE IF NOT EXISTS email_template_versions (
  id bigserial PRIMARY KEY,
  template_type text NOT NULL,
  version_no integer NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_by_email text,
  restored_from_version integer,
  note text,
  CONSTRAINT email_template_versions_source_check CHECK (source IN ('initial', 'admin_edit', 'restore', 'reset_shipped')),
  CONSTRAINT email_template_versions_type_no_key UNIQUE (template_type, version_no)
);

-- Reprise (avant la pose des déclencheurs, une seule fois : shipped_* encore vides).
UPDATE email_templates
   SET is_customized = true, customized_at = coalesce(updated_at, now())
 WHERE updated_by IS NOT NULL AND is_customized = false AND customized_at IS NULL
   AND shipped_body IS NULL;

UPDATE email_templates
   SET shipped_subject = subject, shipped_body = body
 WHERE is_customized = false AND shipped_body IS NULL;

INSERT INTO email_template_versions (template_type, version_no, subject, body, source, created_at, created_by, note)
SELECT upper(t.type), 1, t.subject, t.body, 'initial', coalesce(t.updated_at, now()), t.updated_by,
       CASE WHEN t.is_customized THEN 'Texte en base au lot 70 (déjà enregistré depuis le back-office)'
            ELSE 'Texte en base au lot 70 (texte livré)' END
  FROM email_templates t
 WHERE NOT EXISTS (SELECT 1 FROM email_template_versions v WHERE v.template_type = upper(t.type));

-- ── Garde : un gabarit personnalisé n'est modifié que par l'éditeur du BO ────────
CREATE OR REPLACE FUNCTION email_templates_admin_edit() RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(current_setting('verebona.email_template_edit', true), '') = 'on'
$fn$;

CREATE OR REPLACE FUNCTION email_templates_guard_update() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF email_templates_admin_edit() THEN
    RETURN NEW;
  END IF;
  -- Hors éditeur : la marque de personnalisation ne change pas.
  NEW.is_customized := OLD.is_customized;
  NEW.customized_at := OLD.customized_at;
  IF OLD.is_customized THEN
    IF NEW.subject IS DISTINCT FROM OLD.subject OR NEW.body IS DISTINCT FROM OLD.body THEN
      -- Texte livré plus récent : conservé à part, jamais appliqué seul.
      NEW.shipped_subject := NEW.subject;
      NEW.shipped_body := NEW.body;
      NEW.shipped_updated_at := now();
      NEW.subject := OLD.subject;
      NEW.body := OLD.body;
      NEW.updated_by := OLD.updated_by;
      NEW.updated_at := OLD.updated_at;
    END IF;
  ELSE
    NEW.shipped_subject := NEW.subject;
    NEW.shipped_body := NEW.body;
    NEW.shipped_updated_at := NULL;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION email_templates_guard_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  existing_id integer;
BEGIN
  IF email_templates_admin_edit() THEN
    RETURN NEW;
  END IF;
  SELECT id INTO existing_id FROM email_templates
   WHERE upper(type) = upper(NEW.type) AND is_customized LIMIT 1;
  IF existing_id IS NOT NULL THEN
    -- Amorçage « DELETE puis INSERT » d'un gabarit personnalisé : le texte reçu
    -- devient le texte livré (déclencheur UPDATE ci-dessus), l'insertion est ignorée.
    UPDATE email_templates SET subject = NEW.subject, body = NEW.body WHERE id = existing_id;
    RETURN NULL;
  END IF;
  NEW.is_customized := false;
  NEW.customized_at := NULL;
  NEW.shipped_subject := NEW.subject;
  NEW.shipped_body := NEW.body;
  NEW.shipped_updated_at := NULL;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION email_templates_guard_delete() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.is_customized AND NOT email_templates_admin_edit() THEN
    RETURN NULL;
  END IF;
  RETURN OLD;
END
$fn$;

DROP TRIGGER IF EXISTS email_templates_guard_update_trg ON email_templates;
CREATE TRIGGER email_templates_guard_update_trg BEFORE UPDATE ON email_templates
  FOR EACH ROW EXECUTE FUNCTION email_templates_guard_update();

DROP TRIGGER IF EXISTS email_templates_guard_insert_trg ON email_templates;
CREATE TRIGGER email_templates_guard_insert_trg BEFORE INSERT ON email_templates
  FOR EACH ROW EXECUTE FUNCTION email_templates_guard_insert();

DROP TRIGGER IF EXISTS email_templates_guard_delete_trg ON email_templates;
CREATE TRIGGER email_templates_guard_delete_trg BEFORE DELETE ON email_templates
  FOR EACH ROW EXECUTE FUNCTION email_templates_guard_delete();
