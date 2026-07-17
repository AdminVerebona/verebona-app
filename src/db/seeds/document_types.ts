
import { db } from '@/db';
import { documentTypes, documentTypeAssetAssociations, documentTypeExportAssociations } from '@/db/schema';

async function main() {
    // Check if document types already exist
    const existingDocTypes = await db.select().from(documentTypes);
    
    if (existingDocTypes.length > 0) {
        return;
    }

    // Create document types
    const sampleDocumentTypes = [
        {
            code: 'FACTURE',
            label: "Facture d'achat",
            description: "Facture d'achat ou de prestation de service liée au bien",
            isActive: true,
            displayOrder: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
        },
        {
            code: 'GARANTIE',
            label: "Certificat de garantie",
            description: "Certificat de garantie constructeur ou étendue",
            isActive: true,
            displayOrder: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
        },
        {
            code: 'MANUEL',
            label: "Manuel d'utilisation",
            description: "Manuel d'utilisation, guide technique ou documentation",
            isActive: true,
            displayOrder: 3,
            createdAt: new Date(),
            updatedAt: new Date(),
        },
        {
            code: 'CONTRAT',
            label: "Contrat",
            description: "Contrat d'assurance, de location ou autre contrat lié au bien",
            isActive: true,
            displayOrder: 4,
            createdAt: new Date(),
            updatedAt: new Date(),
        },
        {
            code: 'ATTESTATION_ASSURANCE',
            label: "Attestation d'assurance",
            description: "Attestation d'assurance du bien (véhicule, habitation, etc.)",
            isActive: true,
            displayOrder: 5,
            createdAt: new Date(),
            updatedAt: new Date(),
        },
        {
            code: 'CERTIFICAT',
            label: "Certificat de conformité",
            description: "Certificat de conformité, attestation technique ou administrative",
            isActive: true,
            displayOrder: 6,
            createdAt: new Date(),
            updatedAt: new Date(),
        },
        {
            code: 'AUTRE',
            label: "Autre document",
            description: "Document non catégorisé ou type spécifique",
            isActive: true,
            displayOrder: 7,
            createdAt: new Date(),
            updatedAt: new Date(),
        },
    ];

    const insertedDocTypes = await db.insert(documentTypes).values(sampleDocumentTypes).returning();

    // Get IDs for associations
    const factureType = insertedDocTypes.find(dt => dt.code === 'FACTURE');
    const garantieType = insertedDocTypes.find(dt => dt.code === 'GARANTIE');
    const manuelType = insertedDocTypes.find(dt => dt.code === 'MANUEL');
    const contratType = insertedDocTypes.find(dt => dt.code === 'CONTRAT');
    const attestationAssuranceType = insertedDocTypes.find(dt => dt.code === 'ATTESTATION_ASSURANCE');
    const certificatType = insertedDocTypes.find(dt => dt.code === 'CERTIFICAT');
    const autreType = insertedDocTypes.find(dt => dt.code === 'AUTRE');

    // Create asset associations (all types applicable to all assets)
    const assetAssociations = [
        {
            documentTypeId: factureType!.id,
            assetTypeId: null,
            assetTypeSubcategoryId: null,
            isRequired: false,
            createdAt: new Date(),
        },
        {
            documentTypeId: garantieType!.id,
            assetTypeId: null,
            assetTypeSubcategoryId: null,
            isRequired: false,
            createdAt: new Date(),
        },
        {
            documentTypeId: manuelType!.id,
            assetTypeId: null,
            assetTypeSubcategoryId: null,
            isRequired: false,
            createdAt: new Date(),
        },
        {
            documentTypeId: contratType!.id,
            assetTypeId: null,
            assetTypeSubcategoryId: null,
            isRequired: false,
            createdAt: new Date(),
        },
        {
            documentTypeId: attestationAssuranceType!.id,
            assetTypeId: null,
            assetTypeSubcategoryId: null,
            isRequired: false,
            createdAt: new Date(),
        },
        {
            documentTypeId: certificatType!.id,
            assetTypeId: null,
            assetTypeSubcategoryId: null,
            isRequired: false,
            createdAt: new Date(),
        },
        {
            documentTypeId: autreType!.id,
            assetTypeId: null,
            assetTypeSubcategoryId: null,
            isRequired: false,
            createdAt: new Date(),
        },
    ];

    await db.insert(documentTypeAssetAssociations).values(assetAssociations);

    // Create export associations
    const exportAssociations = [
        // FACTURE export associations
        {
            documentTypeId: factureType!.id,
            exportTemplateId: null,
            exportType: 'REVENTE',
            includeByDefault: true,
            displayOrder: 1,
            createdAt: new Date(),
        },
        {
            documentTypeId: factureType!.id,
            exportTemplateId: null,
            exportType: 'ASSURANCE_DEVIS',
            includeByDefault: true,
            displayOrder: 1,
            createdAt: new Date(),
        },
        {
            documentTypeId: factureType!.id,
            exportTemplateId: null,
            exportType: 'DOSSIER_COMPLET',
            includeByDefault: true,
            displayOrder: 1,
            createdAt: new Date(),
        },
        // GARANTIE export associations
        {
            documentTypeId: garantieType!.id,
            exportTemplateId: null,
            exportType: 'REVENTE',
            includeByDefault: true,
            displayOrder: 2,
            createdAt: new Date(),
        },
        {
            documentTypeId: garantieType!.id,
            exportTemplateId: null,
            exportType: 'SAV_GARANTIE',
            includeByDefault: true,
            displayOrder: 1,
            createdAt: new Date(),
        },
        {
            documentTypeId: garantieType!.id,
            exportTemplateId: null,
            exportType: 'DOSSIER_COMPLET',
            includeByDefault: true,
            displayOrder: 2,
            createdAt: new Date(),
        },
        // MANUEL export associations
        {
            documentTypeId: manuelType!.id,
            exportTemplateId: null,
            exportType: 'REVENTE',
            includeByDefault: true,
            displayOrder: 3,
            createdAt: new Date(),
        },
        {
            documentTypeId: manuelType!.id,
            exportTemplateId: null,
            exportType: 'SAV_GARANTIE',
            includeByDefault: true,
            displayOrder: 2,
            createdAt: new Date(),
        },
        {
            documentTypeId: manuelType!.id,
            exportTemplateId: null,
            exportType: 'DOSSIER_COMPLET',
            includeByDefault: true,
            displayOrder: 3,
            createdAt: new Date(),
        },
        // CONTRAT export associations
        {
            documentTypeId: contratType!.id,
            exportTemplateId: null,
            exportType: 'REVENTE',
            includeByDefault: false,
            displayOrder: 10,
            createdAt: new Date(),
        },
        {
            documentTypeId: contratType!.id,
            exportTemplateId: null,
            exportType: 'DOSSIER_COMPLET',
            includeByDefault: true,
            displayOrder: 4,
            createdAt: new Date(),
        },
        // ATTESTATION_ASSURANCE export associations
        {
            documentTypeId: attestationAssuranceType!.id,
            exportTemplateId: null,
            exportType: 'ASSURANCE_DEVIS',
            includeByDefault: true,
            displayOrder: 2,
            createdAt: new Date(),
        },
        {
            documentTypeId: attestationAssuranceType!.id,
            exportTemplateId: null,
            exportType: 'ASSURANCE_SINISTRE',
            includeByDefault: true,
            displayOrder: 1,
            createdAt: new Date(),
        },
        {
            documentTypeId: attestationAssuranceType!.id,
            exportTemplateId: null,
            exportType: 'DOSSIER_COMPLET',
            includeByDefault: true,
            displayOrder: 5,
            createdAt: new Date(),
        },
        // CERTIFICAT export associations
        {
            documentTypeId: certificatType!.id,
            exportTemplateId: null,
            exportType: 'REVENTE',
            includeByDefault: true,
            displayOrder: 4,
            createdAt: new Date(),
        },
        {
            documentTypeId: certificatType!.id,
            exportTemplateId: null,
            exportType: 'DOSSIER_COMPLET',
            includeByDefault: true,
            displayOrder: 6,
            createdAt: new Date(),
        },
        {
            documentTypeId: certificatType!.id,
            exportTemplateId: null,
            exportType: 'CIL',
            includeByDefault: true,
            displayOrder: 1,
            createdAt: new Date(),
        },
        // AUTRE export associations
        {
            documentTypeId: autreType!.id,
            exportTemplateId: null,
            exportType: 'DOSSIER_COMPLET',
            includeByDefault: true,
            displayOrder: 10,
            createdAt: new Date(),
        },
    ];

    await db.insert(documentTypeExportAssociations).values(exportAssociations);

}

main().catch((error) => {
    console.error('❌ Seeder failed:', error);
});
