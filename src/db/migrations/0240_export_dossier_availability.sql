-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0240 : disponibilité des dossiers prêts à l'emploi (BO « Modèles
-- d'export », 2 oct. 2026).
--
-- Les modèles sont les six dossiers V12 définis dans le code
-- (services/exports/catalog.ts) : contenu et versions restent dans le code.
-- Seule leur DISPONIBILITÉ est administrée depuis le back-office. Une ligne
-- n'existe que pour un dossier dont l'état a été changé ; sans ligne, le
-- dossier est actif.
--
-- L'ancienne table `export_templates` (modèles PDFMonkey) n'est plus lue par
-- le back-office ; son `is_active` n'a jamais été pris en compte par le moteur
-- V12. Elle est conservée (historique), sans reprise de ses valeurs.
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS export_dossier_availability (
  code        TEXT        PRIMARY KEY,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  updated_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
