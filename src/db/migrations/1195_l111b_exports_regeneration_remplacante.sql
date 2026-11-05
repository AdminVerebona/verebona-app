-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1195 : régénération remplaçante des dossiers V12 (lot 111B,
-- ticket « Exports V12 : régénération »). Services :
-- `src/services/exports/v12/generation/{identity,enqueue,repository,job,worker}.ts`.
--
-- `export_generation` reçoit :
--   identity_key                 clé d'IDENTITÉ MÉTIER du dossier (compte + bien
--                                + type de dossier + contexte métier — sinistre,
--                                variante — + utilisateur). Distincte de
--                                `snapshot_json.request.requestHash` (empreinte
--                                technique, qui change avec les options) ;
--                                jamais posée pour EXPORT_BRUT ;
--   cancel_requested_at          demande d'annulation PERSISTANTE (observée par
--                                le worker pendant les étapes) ;
--   cancel_requested_by_user_id  auteur de la régénération ;
--   cancel_reason                motif structuré (REPLACED_BY_NEW_GENERATION) ;
--   cancelled_at / cancelled_step  arrêt effectif et étape atteinte ;
--   replaced_by_generation_id    génération qui la remplace (lien d'historique).
--
-- Statut terminal `cancelled` : déjà admis par la contrainte de 0212 (valeur
-- historique) — aucune modification de contrainte.
--
-- Reprise : clé posée sur les générations ACTIVES existantes (queued /
-- generating, hors EXPORT_BRUT, sans variante) pour qu'une régénération
-- puisse les remplacer dès le déploiement. Les autres lignes gardent NULL
-- (elles ne sont jamais remplacées : terminées ou historiques).
--
-- Additive, idempotente, rejouable. Retour arrière : colonnes ignorées par
-- l'ancien code (une génération `cancelled` s'y affiche « en échec »).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE export_generation
  ADD COLUMN IF NOT EXISTS identity_key                text,
  ADD COLUMN IF NOT EXISTS cancel_requested_at         timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_requested_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancel_reason               text,
  ADD COLUMN IF NOT EXISTS cancelled_at                timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_step              text,
  ADD COLUMN IF NOT EXISTS replaced_by_generation_id   integer REFERENCES export_generation(id) ON DELETE SET NULL;

ALTER TABLE export_generation DROP CONSTRAINT IF EXISTS export_generation_cancel_reason_check;
ALTER TABLE export_generation ADD CONSTRAINT export_generation_cancel_reason_check CHECK (
  cancel_reason IS NULL OR cancel_reason IN ('REPLACED_BY_NEW_GENERATION')
);

-- Même format que `generationIdentityKey()` (identity.ts) : v1:a{compte}:b{bien}:t{type}:c{sinistre|-}:v-:u{utilisateur}.
UPDATE export_generation
   SET identity_key = 'v1:a' || account_id || ':b' || asset_id || ':t' || export_type
                      || ':c' || COALESCE(NULLIF(snapshot_json -> 'request' ->> 'claimOperationId', ''), '-')
                      || ':v-:u' || user_id
 WHERE identity_key IS NULL
   AND status IN ('queued', 'generating')
   AND export_type <> 'EXPORT_BRUT'
   AND variant IS NULL;
