-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1167 : obligation de double authentification — réglages BO
-- (lot 110B, ticket MFA §9). Deux populations DISTINCTES : `users` (tous les
-- comptes) et `admins` (rôles ADMIN / SUPER_ADMIN, activable plus tôt).
-- `enforced_from` NULL = non activée (DÉFAUT) ; date future = programmée
-- (affichable pour la communication) ; date passée = en vigueur, sans
-- période de grâce. Modifiable uniquement par BO › Exploitation › Double
-- authentification (journal BO). Additive, idempotente : DO NOTHING ne
-- remet jamais un réglage posé à son défaut.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mfa_enforcement_settings (
  scope         TEXT        PRIMARY KEY,
  enforced_from TIMESTAMPTZ,
  updated_by    INTEGER,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mfa_enforcement_settings_scope_chk CHECK (scope IN ('users', 'admins'))
);
INSERT INTO mfa_enforcement_settings (scope, enforced_from) VALUES ('users', NULL), ('admins', NULL)
ON CONFLICT (scope) DO NOTHING;
