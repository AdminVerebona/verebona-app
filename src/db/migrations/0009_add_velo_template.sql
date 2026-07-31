-- Migration: Add DOSSIER_VENTE_VELO_V1 export template
-- Created: 2025-11-30
--
-- ═══════════════════════════════════════════════════════════════════════════
-- CONVERTIE DEPUIS LA SYNTAXE SQLITE
--
-- Cette migration n'a JAMAIS pu s'appliquer : elle employait quatre formes
-- propres à SQLite, refusées par PostgreSQL.
--
--   INSERT OR REPLACE  →  INSERT ... ON CONFLICT ... DO UPDATE
--   json('...')        →  littéral de chaîne, la colonne étant en TEXT
--   datetime('now')    →  now()
--   1 / 0 booléens     →  TRUE / FALSE
--
-- L'echec remontait en `42601 syntax error at or near "OR"`, sans que rien
-- ne signale qu'il s'agissait d'un dialecte étranger.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO export_templates (
  code,
  label,
  description,
  template_content,
  category,
  export_type,
  is_active,
  version,
  created_at,
  updated_at
) VALUES (
  'DOSSIER_VENTE_VELO_V1',
  'Dossier de vente - Vélo V1',
  'Template dédié pour la vente de vélos avec sections adaptées',
  '{
    "page": {
      "size": "A4",
      "orientation": "portrait",
      "margins": { "top": 40, "right": 30, "bottom": 40, "left": 30 }
    },
    "theme": {
      "fonts": { "primary": "Inter", "fallback": "Helvetica" },
      "colors": {
        "primary": "#2563EB",
        "text": "#111827",
        "mutedText": "#6B7280",
        "border": "#E5E7EB"
      },
      "typography": {
        "h1": { "size": 22, "weight": "bold", "lineHeight": 1.2 },
        "h2": { "size": 16, "weight": "bold", "lineHeight": 1.3 },
        "h3": { "size": 12, "weight": "semibold", "lineHeight": 1.4 },
        "body": { "size": 10, "weight": "normal", "lineHeight": 1.4 },
        "small": { "size": 8, "weight": "normal", "lineHeight": 1.3 }
      }
    },
    "sections": [
      {
        "id": "cover",
        "type": "section",
        "label": "Couverture",
        "pageBreak": "auto",
        "components": [
          { "type": "spacer", "size": 40 },
          { "type": "heading", "level": 1, "text": "Vélo {{asset.name}}", "align": "center", "style": "h1" },
          { "type": "spacer", "size": 8 },
          { "type": "text", "text": "{{default asset.address.full \"Localisation non renseignée\"}}", "align": "center", "style": "body" },
          { "type": "spacer", "size": 4 },
          { "type": "text", "text": "Catégorie : {{default asset.subtype \"Vélo\"}}", "align": "center", "style": "body" },
          { "type": "spacer", "size": 20 }
        ]
      },
      {
        "id": "summary",
        "type": "section",
        "label": "Résumé du vélo",
        "pageBreak": "auto",
        "components": [
          { "type": "spacer", "size": 16 },
          { "type": "heading", "level": 2, "text": "Résumé du vélo", "style": "h2", "align": "left" },
          { "type": "spacer", "size": 8 },
          { "type": "text", "text": "{{default asset.notes \"Aucune note disponible.\"}}", "align": "left", "style": "body" }
        ]
      },
      {
        "id": "key_infos_vehicle",
        "type": "section",
        "label": "Informations clés - Vélo",
        "pageBreak": "auto",
        "components": [
          { "type": "spacer", "size": 16 },
          { "type": "heading", "level": 2, "text": "Informations clés", "style": "h2", "align": "left" },
          { "type": "spacer", "size": 8 },
          {
            "type": "columns",
            "columns": [
              {
                "width": "50%",
                "components": [
                  {
                    "type": "keyValueList",
                    "layout": "oneColumn",
                    "items": [
                      { "label": "Nom", "value": "{{asset.name}}" },
                      { "label": "Catégorie", "value": "{{default asset.subtype \"Vélo\"}}" },
                      { "label": "Lieu d''achat", "value": "{{default asset.purchaseLocation \"Non renseigné\"}}" }
                    ]
                  }
                ]
              },
              {
                "width": "50%",
                "components": [
                  {
                    "type": "keyValueList",
                    "layout": "oneColumn",
                    "items": [
                      { "label": "Date d''achat", "value": "{{formatDate asset.purchaseDate}}" },
                      { "label": "Prix d''achat", "value": "{{formatCurrency asset.purchasePriceCents \"EUR\"}}" },
                      { "label": "État général", "value": "{{default asset.generalCondition \"Non renseigné\"}}" }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        "id": "specs_vehicle",
        "type": "section",
        "label": "Spécifications",
        "pageBreak": "auto",
        "visibility": {
          "condition": "asset.equipmentList"
        },
        "components": [
          { "type": "spacer", "size": 16 },
          { "type": "heading", "level": 2, "text": "Spécifications techniques", "style": "h2", "align": "left" },
          { "type": "spacer", "size": 8 },
          {
            "type": "keyValueList",
            "layout": "oneColumn",
            "items": [
              { "label": "Équipements", "value": "{{default asset.equipmentList \"Non renseigné\"}}" },
              { "label": "Dimensions", "value": "{{default asset.dimensions \"Non renseigné\"}}" },
              { "label": "Caractéristiques clés", "value": "{{default asset.keyCharacteristics \"Non renseigné\"}}" }
            ]
          }
        ]
      },
      {
        "id": "maintenance_vehicle",
        "type": "section",
        "label": "Entretien",
        "pageBreak": "auto",
        "visibility": {
          "condition": "asset.lastMaintenanceDate"
        },
        "components": [
          { "type": "spacer", "size": 16 },
          { "type": "heading", "level": 2, "text": "Historique d''entretien", "style": "h2", "align": "left" },
          { "type": "spacer", "size": 8 },
          {
            "type": "keyValueList",
            "layout": "oneColumn",
            "items": [
              { "label": "Dernier entretien", "value": "{{formatDate asset.lastMaintenanceDate}}" }
            ]
          }
        ]
      },
      {
        "id": "legal_vehicle",
        "type": "section",
        "label": "Informations légales",
        "pageBreak": "auto",
        "components": [
          { "type": "spacer", "size": 16 },
          { "type": "heading", "level": 2, "text": "Informations légales", "style": "h2", "align": "left" },
          { "type": "spacer", "size": 8 },
          { "type": "text", "text": "Document généré le {{formatDate generationDate \"DD/MM/YYYY\"}} pour le bien \"{{asset.name}}\".", "align": "left", "style": "small" },
          { "type": "spacer", "size": 4 },
          { "type": "text", "text": "Les informations contenues dans ce document sont fournies à titre indicatif et ne sauraient engager la responsabilité du vendeur au-delà des obligations légales.", "align": "left", "style": "small" }
        ]
      }
    ]
  }',
  'VEHICULE',
  'DOSSIER_VENTE',
  TRUE,
  1,
  now(),
  now()
)
-- `code` porte un index unique : le conflit se résout par une mise à jour,
-- ce que `INSERT OR REPLACE` faisait implicitement sous SQLite.
ON CONFLICT (code) DO UPDATE SET
  label            = EXCLUDED.label,
  description      = EXCLUDED.description,
  template_content = EXCLUDED.template_content,
  category         = EXCLUDED.category,
  export_type      = EXCLUDED.export_type,
  is_active        = EXCLUDED.is_active,
  version          = EXCLUDED.version,
  updated_at       = now();
