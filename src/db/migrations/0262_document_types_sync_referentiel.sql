-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0262 : synchronisation de `document_types` avec le référentiel V1
-- du code (lot 30, ticket « Référentiels : supprimer les sources de vérité
-- concurrentes »).
--
-- `document_types` ne contenait que 14 codes (migrations 0051, 0052, 0062,
-- 0124) alors que `src/lib/document-type-constants.ts` en déclare 41 :
--   · le sélecteur du tiroir document (lu en base) ne proposait ni « Rapport
--     d'entretien », ni « Constat sinistre », ni « Expertise », ni « Permis de
--     construire », ni « Certificat loi Carrez » ;
--   · `PUT /api/documents/:id` refusait d'enregistrer un document typé par
--     l'IA en code CIL fin (AMIANTE, PLOMB…) : « Type de document invalide ».
--
-- Ajout des codes manquants UNIQUEMENT (`ON CONFLICT DO NOTHING`) : aucun
-- libellé, statut ni ordre réglé en back-office n'est écrasé ; aucune ligne
-- supprimée (les codes historiques restent lisibles). Les codes de format et
-- CIL fins restent hors sélecteur : la route `/api/document-types` les marque
-- `hideFromPicker` depuis le code.
-- Idempotente (index unique sur `code`). Rejouable sans effet.
-- Retour arrière : inutile (lignes de référence sans dépendance) ; au besoin,
-- désactiver une ligne (`is_active`) depuis le back-office.
-- Un test unitaire (REF-AC03) vérifie que chaque code de la liste V1 est
-- inséré par une migration, et un test e2e que la base migrée les contient.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

INSERT INTO document_types (code, label, description, is_active, display_order, created_at, updated_at) VALUES
  ('FACTURE', 'Facture', 'Facture d''achat, ticket de caisse, justificatif de paiement, facture de travaux', TRUE, 1, NOW(), NOW()),
  ('DEVIS', 'Devis', 'Devis de prestation, estimation de travaux, offre de prix', TRUE, 2, NOW(), NOW()),
  ('CONTRAT', 'Contrat / Bail', 'Contrat de service, bail, mandat, abonnement, contrat d''entretien', TRUE, 3, NOW(), NOW()),
  ('GARANTIE', 'Garantie', 'Certificat ou bon de garantie fabricant / constructeur', TRUE, 4, NOW(), NOW()),
  ('ATTESTATION_ASSURANCE', 'Attestation d''assurance', 'Contrat, attestation ou avis d''échéance d''assurance habitation / sinistre', TRUE, 5, NOW(), NOW()),
  ('MANUEL', 'Notice / Manuel', 'Manuel d''utilisation, notice de fonctionnement, guide technique, mode d''emploi', TRUE, 6, NOW(), NOW()),
  ('RAPPORT_ENTRETIEN', 'Rapport d''entretien', 'Compte-rendu d''entretien, intervention technique, constat d''état', TRUE, 7, NOW(), NOW()),
  ('CERTIFICAT', 'Certificat', 'Certificat, procès-verbal, rapport de contrôle', TRUE, 8, NOW(), NOW()),
  ('AVIS_ECHEANCE', 'Avis d''échéance', 'Avis d''échéance d''assurance ou de cotisation', TRUE, 9, NOW(), NOW()),
  ('ACTE_TRANSACTION', 'Acte / Transaction', 'Titre de propriété, acte notarié, promesse de vente, compromis', TRUE, 10, NOW(), NOW()),
  ('PERMIS_CONSTRUIRE', 'Permis de construire', 'Permis de construire, déclaration de travaux, permis d''aménager', TRUE, 11, NOW(), NOW()),
  ('SURFACE_CARREZ', 'Certificat loi Carrez', 'Mesurage loi Carrez, attestation de surface habitable', TRUE, 12, NOW(), NOW()),
  ('EXPERTISE', 'Expertise / Estimation', 'Rapport d''expertise immobilière, estimation de valeur par un professionnel', TRUE, 13, NOW(), NOW()),
  ('CONSTAT_SINISTRE', 'Constat sinistre', 'Constat amiable, déclaration de sinistre, rapport d''expertise suite sinistre', TRUE, 14, NOW(), NOW()),
  ('DIAGNOSTIC', 'Diagnostic technique', 'DPE, amiante, plomb, gaz, électricité, termites, assainissement, ERNMT et tout diagnostic immobilier', TRUE, 15, NOW(), NOW()),
  ('ANNONCE_COMMERCIALE', 'Annonce', 'Annonce immobilière, fiche produit, page web', TRUE, 16, NOW(), NOW()),
  ('DPE', 'DPE', 'Diagnostic de performance énergétique', TRUE, 20, NOW(), NOW()),
  ('AUDIT_ENERGETIQUE', 'Audit énergétique', 'Audit énergétique réglementaire ou volontaire', TRUE, 21, NOW(), NOW()),
  ('AMIANTE', 'Diagnostic amiante', 'Diagnostic amiante (DTA, DAPP)', TRUE, 22, NOW(), NOW()),
  ('PLOMB', 'Diagnostic plomb (CREP)', 'Constat de risque d''exposition au plomb', TRUE, 23, NOW(), NOW()),
  ('TERMITES', 'Diagnostic termites', 'État relatif à la présence de termites', TRUE, 24, NOW(), NOW()),
  ('GAZ', 'Diagnostic gaz', 'Diagnostic de l''installation intérieure de gaz', TRUE, 25, NOW(), NOW()),
  ('ELECTRICITE', 'Diagnostic électricité', 'Diagnostic de l''installation électrique intérieure', TRUE, 26, NOW(), NOW()),
  ('ASSAINISSEMENT', 'Diagnostic assainissement', 'Diagnostic assainissement non collectif', TRUE, 27, NOW(), NOW()),
  ('ERNMT', 'État des risques (ERNMT)', 'État des risques naturels, miniers et technologiques', TRUE, 28, NOW(), NOW()),
  ('PLAN_CONSTRUCTION', 'Plans de construction', 'Plans, coupes, schémas de construction', TRUE, 30, NOW(), NOW()),
  ('PLAN_CADASTRAL', 'Plan cadastral', 'Extrait de plan cadastral, situation parcellaire', TRUE, 31, NOW(), NOW()),
  ('RE2020', 'Attestation RE2020', 'Attestation de prise en compte de la RE2020', TRUE, 31, NOW(), NOW()),
  ('LABEL_CERTIFICATION', 'Label / Certification bâtiment', 'Label BBC, HQE, Passivhaus, NF Habitat', TRUE, 32, NOW(), NOW()),
  ('ISOLATION_TOITURE', 'Isolation toiture', 'Isolation thermique toiture / combles', TRUE, 33, NOW(), NOW()),
  ('ISOLATION_MURS', 'Isolation murs extérieurs', 'Isolation thermique murs extérieurs (ITE/ITI)', TRUE, 34, NOW(), NOW()),
  ('ISOLATION_VITRAGE', 'Isolation vitrages / portes', 'Parois vitrées et portes donnant sur l''extérieur', TRUE, 35, NOW(), NOW()),
  ('ISOLATION_PLANCHERS', 'Isolation planchers bas', 'Isolation thermique des planchers bas', TRUE, 36, NOW(), NOW()),
  ('EQUIPEMENT_CHAUFFAGE', 'Équipement chauffage', 'Système de chauffage (chaudière, pompe à chaleur…)', TRUE, 37, NOW(), NOW()),
  ('EQUIPEMENT_REFROIDISSEMENT', 'Équipement refroidissement', 'Système de refroidissement / climatisation', TRUE, 38, NOW(), NOW()),
  ('EQUIPEMENT_ECS', 'Eau chaude sanitaire', 'Production d''eau chaude sanitaire', TRUE, 39, NOW(), NOW()),
  ('RESEAU_CHALEUR', 'Réseau de chaleur / froid', 'Réseau de chaleur ou de froid urbain', TRUE, 40, NOW(), NOW()),
  ('EQUIPEMENT_VENTILATION', 'Ventilation', 'Système de ventilation (VMC simple/double flux, VNR)', TRUE, 41, NOW(), NOW()),
  ('AUTRE', 'Autre', 'Document ne rentrant pas dans les catégories ci-dessus', TRUE, 50, NOW(), NOW()),
  ('PHOTO', 'Photo', 'Photo ou image du bien immobilier / mobilier', TRUE, 98, NOW(), NOW()),
  ('VIDEO', 'Vidéo', 'Vidéo du bien immobilier / mobilier ou d''une intervention', TRUE, 99, NOW(), NOW())

ON CONFLICT (code) DO NOTHING;
