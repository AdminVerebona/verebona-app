-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0917 — lot 102C : preuve de l'information et du choix de
-- l'utilisateur sur les relances commerciales, recueillis à l'inscription.
--
-- Ticket conformité légale, P2 « Prospection post-essai » : la collecte de
-- l'adresse est alignée sur la base légale retenue au BO (séquence de fin
-- d'essai, lot 100G) :
--   · base « consentement » : case à cocher NON pré-cochée ;
--   · base « client existant » : information + opposition simple et
--     gratuite (case « je ne souhaite pas » ou mention, réglage BO).
-- Chaque inscription conserve la preuve : base, mécanisme, choix, version et
-- empreinte du libellé présenté, lien Confidentialité affiché, contexte.
--
-- Rattachée à l'utilisateur (CASCADE) : supprimée avec lui. Exportée par
-- l'export RGPD (collecte par schéma).
-- Additive et idempotente.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS marketing_collection_proofs (
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  context text NOT NULL,
  legal_basis text NOT NULL,
  mechanism text NOT NULL,
  choice text NOT NULL,
  notice_version text NOT NULL,
  notice_sha256 text NOT NULL,
  privacy_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketing_collection_proofs_context_check CHECK (context IN ('signup', 'social_signup')),
  CONSTRAINT marketing_collection_proofs_basis_check CHECK (legal_basis IN ('consent', 'soft_opt_in')),
  CONSTRAINT marketing_collection_proofs_mechanism_check CHECK (mechanism IN ('consent_checkbox', 'opt_out_checkbox', 'mention')),
  CONSTRAINT marketing_collection_proofs_choice_check CHECK (choice IN ('consented', 'not_consented', 'opposed', 'not_opposed', 'informed'))
);

CREATE INDEX IF NOT EXISTS marketing_collection_proofs_user_idx ON marketing_collection_proofs (user_id);

COMMENT ON TABLE marketing_collection_proofs IS
  'Lot 102C : preuve de l''information et du choix (consentement / opposition) sur les relances commerciales à l''inscription.';
