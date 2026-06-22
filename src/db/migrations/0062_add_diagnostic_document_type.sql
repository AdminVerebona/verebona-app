-- Ajoute le type fonctionnel DIAGNOSTIC (regroupement des diagnostics techniques immobiliers)
-- Les codes fins (DPE, AMIANTE, etc.) restent en DB pour la compatibilité CIL,
-- mais DIAGNOSTIC est le type choisi manuellement par l'utilisateur.

INSERT INTO document_types (code, label, description, display_order, is_active, created_at, updated_at)
VALUES (
  'DIAGNOSTIC',
  'Diagnostic technique',
  'DPE, amiante, plomb, gaz, électricité, termites, assainissement, ERNMT et tout diagnostic immobilier',
  15,
  true,
  NOW(),
  NOW()
)
ON CONFLICT (code) DO NOTHING;
