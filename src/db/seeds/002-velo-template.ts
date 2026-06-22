import { db } from '../index';
import { exportTemplates } from '../schema';
import { eq } from 'drizzle-orm';

const veloTemplate = {
  code: 'DOSSIER_VENTE_VELO_V1',
  label: 'Dossier de vente - Vélo V1',
  category: 'VEHICULE',
  isActive: true,
  templateContent: {
    page: {
      size: 'A4',
      orientation: 'portrait',
      margins: { top: 40, right: 40, bottom: 40, left: 40 }
    },
    theme: {
      primaryColor: '#1D4ED8',
      fontFamily: 'Helvetica',
      fontSize: { body: 10, h1: 18, h2: 14, h3: 12 }
    },
    sections: [
      {
        id: 'cover',
        type: 'section',
        label: 'Page de couverture',
        pageBreak: 'before',
        components: [
          { type: 'spacer', size: 40 },
          { type: 'heading', level: 1, text: 'Vélo {{default asset.brand "Marque inconnue"}} {{default asset.model "Modèle inconnu"}}', style: 'h1', align: 'center' },
          { type: 'spacer', size: 8 },
          { type: 'text', text: '{{default asset.city "Localisation non renseignée"}}', align: 'center', style: { fontSize: 12, color: '#6B7280' } },
          { type: 'spacer', size: 4 },
          { type: 'text', text: 'Catégorie : {{default asset.bikeType "Type non renseigné"}}', align: 'center', style: { fontSize: 10, color: '#9CA3AF' } },
          { type: 'spacer', size: 20 },
          { type: 'image', src: '{{asset.primaryImageUrl}}', width: 400, height: 300, align: 'center', fallback: 'Image non disponible' }
        ]
      },
      {
        id: 'summary',
        type: 'section',
        label: 'Résumé du vélo',
        pageBreak: 'auto',
        components: [
          { type: 'spacer', size: 16 },
          { type: 'heading', level: 2, text: 'Résumé du vélo', style: 'h2', align: 'left' },
          { type: 'spacer', size: 8 },
          { type: 'text', text: '{{default asset.notes "Aucune note"}}', align: 'left' }
        ]
      },
      {
        id: 'key_infos_vehicle',
        type: 'section',
        label: 'Informations clés',
        pageBreak: 'auto',
        components: [
          { type: 'spacer', size: 16 },
          { type: 'heading', level: 2, text: 'Informations clés', style: 'h2', align: 'left' },
          { type: 'spacer', size: 8 },
          {
            type: 'columns',
            columns: [
              {
                width: '50%',
                components: [
                  {
                    type: 'keyValueList',
                    layout: 'oneColumn',
                    items: [
                      { label: 'Marque', value: '{{default asset.brand "Non renseigné"}}' },
                      { label: 'Modèle', value: '{{default asset.model "Non renseigné"}}' },
                      { label: 'Type', value: '{{default asset.bikeType "Non renseigné"}}' },
                      { label: 'Taille de cadre', value: '{{default asset.frameSize "Non renseigné"}}' }
                    ]
                  }
                ]
              },
              {
                width: '50%',
                components: [
                  {
                    type: 'keyValueList',
                    layout: 'oneColumn',
                    items: [
                      { label: 'Année d\'achat', value: '{{default asset.purchaseYear "NC"}}' },
                      { label: 'Prix d\'achat', value: '{{formatCurrency asset.purchasePriceCents "EUR"}}' },
                      { label: 'État général', value: '{{default asset.conditionLabel "Non renseigné"}}' },
                      { label: 'Kilométrage estimé', value: '{{default asset.estimatedMileage "NC"}} km' }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        id: 'specs_vehicle',
        type: 'section',
        label: 'Spécifications techniques',
        pageBreak: 'auto',
        components: [
          { type: 'spacer', size: 16 },
          { type: 'heading', level: 2, text: 'Spécifications techniques', style: 'h2', align: 'left' },
          { type: 'spacer', size: 8 },
          {
            type: 'keyValueList',
            layout: 'oneColumn',
            items: [
              { label: 'Transmission', value: '{{default asset.transmission "Non renseigné"}}' },
              { label: 'Freins', value: '{{default asset.brakes "Non renseigné"}}' },
              { label: 'Matériau du cadre', value: '{{default asset.frameMaterial "Non renseigné"}}' },
              { label: 'Équipements inclus', value: '{{default asset.equipment "Non renseigné"}}' }
            ]
          }
        ]
      },
      {
        id: 'maintenance_vehicle',
        type: 'section',
        label: 'Entretien',
        pageBreak: 'auto',
        components: [
          { type: 'spacer', size: 16 },
          { type: 'heading', level: 2, text: 'Historique d\'entretien', style: 'h2', align: 'left' },
          { type: 'spacer', size: 8 },
          {
            type: 'keyValueList',
            layout: 'oneColumn',
            items: [
              { label: 'Dernier entretien', value: '{{formatDate asset.lastMaintenanceDate}}' },
              { label: 'Détails', value: '{{default asset.maintenanceDetails "Aucun détail"}}' }
            ]
          }
        ]
      },
      {
        id: 'legal_vehicle',
        type: 'section',
        label: 'Informations légales',
        pageBreak: 'auto',
        components: [
          { type: 'spacer', size: 16 },
          { type: 'heading', level: 2, text: 'Informations légales', style: 'h2', align: 'left' },
          { type: 'spacer', size: 8 },
          {
            type: 'keyValueList',
            layout: 'oneColumn',
            items: [
              { label: 'Numéro de série', value: '{{default asset.serialNumber "Non renseigné"}}' },
              { label: 'Enregistrement Bicycode', value: '{{default asset.bicycodeRegistration "Non renseigné"}}' },
              { label: 'Facture disponible', value: '{{if asset.hasInvoice "Oui" "Non"}}' },
              { label: 'Propriétaire unique', value: '{{if asset.singleOwner "Oui" "Non"}}' }
            ]
          }
        ]
      },
      {
        id: 'legal_notes',
        type: 'section',
        label: 'Mentions légales',
        pageBreak: 'auto',
        components: [
          { type: 'spacer', size: 16 },
          { type: 'heading', level: 3, text: 'Mentions légales', style: 'h3', align: 'left' },
          { type: 'spacer', size: 8 },
          { type: 'text', text: 'Les informations contenues dans ce document sont fournies à titre indicatif et ne constituent pas un engagement contractuel. Le vendeur décline toute responsabilité en cas d\'erreur ou d\'omission.', align: 'left', style: { fontSize: 8, color: '#6B7280' } }
        ]
      }
    ]
  }
};

async function seed() {
  try {

    // Check if template exists
    const existing = await db.select().from(exportTemplates).where(eq(exportTemplates.code, veloTemplate.code));

    if (existing.length > 0) {
      await db.update(exportTemplates)
        .set({
          label: veloTemplate.label,
          category: veloTemplate.category,
          isActive: veloTemplate.isActive,
            templateContent: JSON.stringify(veloTemplate.templateContent),
            updatedAt: new Date()
        })
        .where(eq(exportTemplates.code, veloTemplate.code));
    } else {
        await db.insert(exportTemplates).values({
          ...veloTemplate,
          templateContent: JSON.stringify(veloTemplate.templateContent),
        });
    }

    // Verify
    const result = await db.select().from(exportTemplates).where(eq(exportTemplates.code, veloTemplate.code));
  } catch (error) {
    console.error('❌ Seed error:', error);
    throw error;
  }
}

seed();
