-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0124 — Types documentaires de base
--
-- ── LE CLASSEMENT ÉCHOUAIT SUR TOUS LES DOCUMENTS ─────────────────────────
--
-- Journaux de la première campagne pipeline :
--
--   [source-analysis] classement du fichier 25 impossible : Type inconnu : FACTURE.
--   [source-analysis] classement du fichier 27 impossible : Type inconnu : ANNONCE_COMMERCIALE.
--   [source-analysis] classement du fichier 29 impossible : Type inconnu : DPE.
--
-- Le modèle classait correctement. `updateClassification` refusait d'écrire,
-- parce que `document_types` ne contenait aucun de ces codes.
--
-- Ces types vivaient dans `src/db/seeds/document_types.ts`, un script sans
-- commande `npm`, appelé par personne. Le même défaut que les gabarits
-- d'email : un amorçage écrit mais jamais joué.
--
-- ── CE QUE ÇA COÛTAIT EN PRODUCTION ───────────────────────────────────────
--
-- Tout document analysé restait « à classer », sans que rien ne l'explique à
-- l'utilisateur. L'échec était journalisé côté serveur — par conception, pour
-- ne pas faire échouer une analyse réussie — et donc invisible.
--
-- ── POURQUOI UNE MIGRATION PLUTÔT QU'UN SEED ──────────────────────────────
--
-- Le référentiel documentaire n'est pas une donnée d'exemple : le §2.3 en
-- fait une condition d'affichage. Sans lui, l'application ne peut pas
-- fonctionner. Une migration le garantit à chaque déploiement, là où un seed
-- suppose qu'on pense à l'exécuter.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO document_types (code, label, description, is_active, display_order, created_at, updated_at) VALUES
  ('FACTURE',               'Facture',                'Facture d''achat, de travaux ou de service',        TRUE,  10, NOW(), NOW()),
  ('GARANTIE',              'Garantie',               'Bon de garantie, extension de garantie',            TRUE,  20, NOW(), NOW()),
  ('MANUEL',                'Notice',                 'Manuel d''utilisation, notice technique',           TRUE,  30, NOW(), NOW()),
  ('CONTRAT',               'Contrat',                'Contrat de location, de prestation, de crédit',     TRUE,  40, NOW(), NOW()),
  ('ATTESTATION_ASSURANCE', 'Attestation d''assurance','Attestation ou avis d''échéance d''assurance',      TRUE,  50, NOW(), NOW()),
  ('CERTIFICAT',            'Certificat',             'Certificat, procès-verbal, rapport de contrôle',    TRUE,  60, NOW(), NOW()),
  -- Types rendus par le modèle lors de la campagne, absents du référentiel.
  ('DPE',                   'Diagnostic de performance énergétique', 'DPE et diagnostics réglementaires', TRUE,  70, NOW(), NOW()),
  ('AVIS_ECHEANCE',         'Avis d''échéance',        'Avis d''échéance d''assurance ou de cotisation',    TRUE,  80, NOW(), NOW()),
  ('ANNONCE_COMMERCIALE',   'Annonce',                'Annonce immobilière, fiche produit, page web',      TRUE,  90, NOW(), NOW()),
  -- `AUTRE` reste en dernier : c'est le repli, et le §6.2 le déclare
  -- compatible avec toutes les catégories.
  ('AUTRE',                 'Autre',                  'Document ne relevant d''aucun autre type',          TRUE, 999, NOW(), NOW())

-- Rejouable : `code` porte un index unique. `DO UPDATE` sur le libellé
-- seulement — `is_active` et `display_order` se règlent en back-office, un
-- déploiement n'a pas à écraser un choix d'exploitation.
ON CONFLICT (code) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      updated_at = NOW();
