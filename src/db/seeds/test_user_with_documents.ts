import { db } from '@/db';
import { users, assets, documents } from '@/db/schema';
import bcrypt from 'bcrypt';

async function main() {
    const currentTimestamp = new Date();
    
    // 1. Create test user with hashed password
    const hashedPassword = await bcrypt.hash('Test123!', 10);
    
    const [newUser] = await db.insert(users).values({
        email: 'testdocs@example.com',
        passwordHash: hashedPassword,
        firstName: 'Test',
        lastName: 'Documents',
        username: 'testdocs',
        role: 'USER',
        status: 'ACTIVE',
        planType: 'STANDARD',
        isActive: true,
        locale: 'fr-FR',
          company: null,
           lastLoginAt: null,
        createdAt: currentTimestamp,
        updatedAt: currentTimestamp,
    }).returning();

    // 2. Create 2 assets for USER ID 1 (sophie.martin@example.fr)
    const [veloAsset, peugeotAsset] = await db.insert(assets).values([
        {
            userId: 1,
            name: 'Velo Jean Fourche',
            category: 'VEHICULE',
            subtype: 'Vélo',
            purchaseDate: '2023-05-15',
            purchasePriceCents: 85000,
            status: 'EN_SERVICE',
            notes: 'VTT tout terrain',
            createdAt: currentTimestamp,
            updatedAt: currentTimestamp,
        },
        {
            userId: 1,
            name: 'Peugeot 308',
            category: 'VEHICULE',
            subtype: 'Berline',
            purchaseDate: '2022-03-20',
            purchasePriceCents: 2500000,
            status: 'EN_SERVICE',
            notes: 'Essence, 80000 km',
            createdAt: currentTimestamp,
            updatedAt: currentTimestamp,
        }
    ]).returning();

    // 4. Create 10 documents for USER ID 1 (sophie.martin@example.fr)
    const sophieDocuments = [
        {
            userId: 1,
            assetId: veloAsset.id,
            fileUrl: '/uploads/test/facture_velo.pdf',
            fileName: 'facture_velo.pdf',
            mimeType: 'application/pdf',
            fileSize: 245800,
            documentType: 'FACTURE',
            documentDate: '2023-05-15',
            description: 'Facture d\'achat du VTT Jean Fourche',
            createdAt: currentTimestamp,
        },
        {
            userId: 1,
            assetId: veloAsset.id,
            fileUrl: '/uploads/test/garantie_velo.pdf',
            fileName: 'garantie_velo.pdf',
            mimeType: 'application/pdf',
            fileSize: 128000,
            documentType: 'GARANTIE',
            documentDate: '2023-05-15',
            description: 'Certificat de garantie 2 ans',
            createdAt: currentTimestamp,
        },
        {
            userId: 1,
            assetId: veloAsset.id,
            fileUrl: '/uploads/test/photo_velo_1.jpg',
            fileName: 'photo_velo_1.jpg',
            mimeType: 'image/jpeg',
            fileSize: 1950000,
            documentType: 'FACTURE',
            documentDate: '2023-05-16',
            description: 'Photo du vélo après achat',
            createdAt: currentTimestamp,
        },
        {
            userId: 1,
            assetId: veloAsset.id,
            fileUrl: '/uploads/test/entretien_velo.docx',
            fileName: 'entretien_velo.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            fileSize: 45000,
            documentType: 'GARANTIE',
            documentDate: '2023-11-20',
            description: 'Carnet d\'entretien et réparations',
            createdAt: currentTimestamp,
        },
        {
            userId: 1,
            assetId: peugeotAsset.id,
            fileUrl: '/uploads/test/carte_grise_308.jpg',
            fileName: 'carte_grise_308.jpg',
            mimeType: 'image/jpeg',
            fileSize: 1850000,
            documentType: 'CERTIFICAT',
            documentDate: '2022-03-20',
            description: 'Carte grise Peugeot 308',
            createdAt: currentTimestamp,
        },
        {
            userId: 1,
            assetId: peugeotAsset.id,
            fileUrl: '/uploads/test/contrat_achat_308.pdf',
            fileName: 'contrat_achat_308.pdf',
            mimeType: 'application/pdf',
            fileSize: 425000,
            documentType: 'CONTRAT',
            documentDate: '2022-03-20',
            description: 'Contrat d\'achat chez le concessionnaire',
            createdAt: currentTimestamp,
        },
        {
            userId: 1,
            assetId: peugeotAsset.id,
            fileUrl: '/uploads/test/manuel_peugeot_308.pdf',
            fileName: 'manuel_peugeot_308.pdf',
            mimeType: 'application/pdf',
            fileSize: 8500000,
            documentType: 'MANUEL',
            documentDate: '2022-03-20',
            description: 'Manuel d\'utilisation et d\'entretien',
            createdAt: currentTimestamp,
        },
        {
            userId: 1,
            assetId: peugeotAsset.id,
            fileUrl: '/uploads/test/photo_voiture.png',
            fileName: 'photo_voiture.png',
            mimeType: 'image/png',
            fileSize: 2400000,
            documentType: 'AUTRE',
            documentDate: '2022-03-21',
            description: 'Photo de la voiture le jour de l\'achat',
            createdAt: currentTimestamp,
        },
        {
            userId: 1,
            assetId: peugeotAsset.id,
            fileUrl: '/uploads/test/assurance_2024.pdf',
            fileName: 'assurance_2024.pdf',
            mimeType: 'application/pdf',
            fileSize: 320000,
            documentType: 'CONTRAT',
            documentDate: '2024-01-01',
            description: 'Contrat d\'assurance tous risques 2024',
            createdAt: currentTimestamp,
        },
        {
            userId: 1,
            assetId: peugeotAsset.id,
            fileUrl: '/uploads/test/revision_2024.xlsx',
            fileName: 'revision_2024.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            fileSize: 85000,
            documentType: 'FACTURE',
            documentDate: '2024-02-15',
            description: 'Facture révision annuelle garage Peugeot',
            createdAt: currentTimestamp,
        }
    ];

    await db.insert(documents).values(sophieDocuments);

    // 5. Create 2 assets for test user
    const [macbookAsset, appartementAsset] = await db.insert(assets).values([
        {
            userId: newUser.id,
            name: 'MacBook Pro 14',
            category: 'OBJECT',
            subtype: 'Ordinateur portable',
            purchaseDate: '2024-01-10',
            purchasePriceCents: 249900,
            status: 'EN_SERVICE',
            notes: 'MacBook Pro 14 pouces M3 Pro, 18Go RAM',
            createdAt: currentTimestamp,
            updatedAt: currentTimestamp,
        },
        {
            userId: newUser.id,
            name: 'Appartement Paris',
            category: 'IMMOBILIER',
            subtype: 'Appartement',
            purchaseDate: '2023-06-15',
            purchasePriceCents: 32000000,
            status: 'EN_SERVICE',
            notes: 'T3 75m² Paris 15ème arrondissement',
            createdAt: currentTimestamp,
            updatedAt: currentTimestamp,
        }
    ]).returning();

    // Create 5 documents for test user
    const testUserDocuments = [
        {
            userId: newUser.id,
            assetId: macbookAsset.id,
            fileUrl: '/uploads/test/facture_macbook.pdf',
            fileName: 'facture_macbook.pdf',
            mimeType: 'application/pdf',
            fileSize: 125000,
            documentType: 'FACTURE',
            documentDate: '2024-01-10',
            description: 'Facture d\'achat Apple Store',
            createdAt: currentTimestamp,
        },
        {
            userId: newUser.id,
            assetId: macbookAsset.id,
            fileUrl: '/uploads/test/photo_macbook.jpg',
            fileName: 'photo_macbook.jpg',
            mimeType: 'image/jpeg',
            fileSize: 450000,
            documentType: 'FACTURE',
            documentDate: '2024-01-11',
            description: 'Photo du MacBook Pro',
            createdAt: currentTimestamp,
        },
        {
            userId: newUser.id,
            assetId: macbookAsset.id,
            fileUrl: '/uploads/test/garantie_apple.pdf',
            fileName: 'garantie_apple.pdf',
            mimeType: 'application/pdf',
            fileSize: 2100000,
            documentType: 'GARANTIE',
            documentDate: '2024-01-10',
            description: 'AppleCare+ garantie étendue 3 ans',
            createdAt: currentTimestamp,
        },
        {
            userId: newUser.id,
            assetId: appartementAsset.id,
            fileUrl: '/uploads/test/acte_notarie.pdf',
            fileName: 'acte_notarie.pdf',
            mimeType: 'application/pdf',
            fileSize: 680000,
            documentType: 'CONTRAT',
            documentDate: '2023-06-15',
            description: 'Acte de vente notarié',
            createdAt: currentTimestamp,
        },
        {
            userId: newUser.id,
            assetId: appartementAsset.id,
            fileUrl: '/uploads/test/plan_appartement.png',
            fileName: 'plan_appartement.png',
            mimeType: 'image/png',
            fileSize: 95000,
            documentType: 'AUTRE',
            documentDate: '2023-06-10',
            description: 'Plan de l\'appartement avec mesures',
            createdAt: currentTimestamp,
        }
    ];

    await db.insert(documents).values(testUserDocuments);

}

main().catch((error) => {
    console.error('❌ Seeder failed:', error);
});