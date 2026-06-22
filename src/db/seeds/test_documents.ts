import { db } from '@/db';
import { users, assets, documents } from '@/db/schema';
import bcrypt from 'bcrypt';

async function main() {
    const currentTimestamp = new Date();
    
    // Hash the test password
    const passwordHash = await bcrypt.hash('Test123!', 10);
    
    // Create test user
    const [testUser] = await db.insert(users).values([
        {
            email: 'test@example.com',
            passwordHash: passwordHash,
            firstName: 'Test',
            lastName: 'User',
            username: 'testuser',
            company: null,
            planType: 'STANDARD',
            isActive: true,
            locale: 'fr-FR',
            role: 'USER',
            status: 'ACTIVE',
            createdAt: currentTimestamp,
            updatedAt: currentTimestamp,
        }
    ]).returning();
    
    // Create test assets
    const testAssets = await db.insert(assets).values([
        {
            userId: testUser.id,
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
            userId: testUser.id,
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
    
    const veloAsset = testAssets[0];
    const peugeotAsset = testAssets[1];
    
    // Create test documents
    const testDocuments = await db.insert(documents).values([
        {
            userId: testUser.id,
            assetId: veloAsset.id,
            fileUrl: '/uploads/test/facture_velo.pdf',
            fileName: 'facture_velo.pdf',
            mimeType: 'application/pdf',
            fileSize: 245800,
            documentType: 'FACTURE',
            documentDate: '2023-05-15',
            description: "Facture d'achat vélo",
            createdAt: currentTimestamp,
        },
        {
            userId: testUser.id,
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
            userId: testUser.id,
            assetId: peugeotAsset.id,
            fileUrl: '/uploads/test/carte_grise_308.jpg',
            fileName: 'carte_grise_308.jpg',
            mimeType: 'image/jpeg',
            fileSize: 1850000,
            documentType: 'CERTIFICAT',
            documentDate: '2022-03-20',
            description: 'Carte grise véhicule',
            createdAt: currentTimestamp,
        },
        {
            userId: testUser.id,
            assetId: peugeotAsset.id,
            fileUrl: '/uploads/test/contrat_achat_308.pdf',
            fileName: 'contrat_achat_308.pdf',
            mimeType: 'application/pdf',
            fileSize: 425000,
            documentType: 'CONTRAT',
            documentDate: '2022-03-20',
            description: 'Contrat de vente véhicule',
            createdAt: currentTimestamp,
        },
        {
            userId: testUser.id,
            assetId: peugeotAsset.id,
            fileUrl: '/uploads/test/manuel_peugeot_308.pdf',
            fileName: 'manuel_peugeot_308.pdf',
            mimeType: 'application/pdf',
            fileSize: 8500000,
            documentType: 'MANUEL',
            documentDate: '2022-03-20',
            description: 'Manuel utilisateur',
            createdAt: currentTimestamp,
        },
        {
            userId: testUser.id,
            assetId: peugeotAsset.id,
            fileUrl: '/uploads/test/photo_voiture.png',
            fileName: 'photo_voiture.png',
            mimeType: 'image/png',
            fileSize: 2400000,
            documentType: 'AUTRE',
            documentDate: '2022-03-20',
            description: 'Photo du véhicule',
            createdAt: currentTimestamp,
        },
        {
            userId: testUser.id,
            assetId: peugeotAsset.id,
            fileUrl: '/uploads/test/assurance_2024.pdf',
            fileName: 'assurance_2024.pdf',
            mimeType: 'application/pdf',
            fileSize: 320000,
            documentType: 'CONTRAT',
            documentDate: '2024-01-01',
            description: 'Contrat assurance 2024',
            createdAt: currentTimestamp,
        },
        {
            userId: testUser.id,
            assetId: veloAsset.id,
            fileUrl: '/uploads/test/photo_velo_1.jpg',
            fileName: 'photo_velo_1.jpg',
            mimeType: 'image/jpeg',
            fileSize: 1950000,
            documentType: 'AUTRE',
            documentDate: '2023-05-15',
            description: 'Photo vélo côté gauche',
            createdAt: currentTimestamp,
        },
        {
            userId: testUser.id,
            assetId: peugeotAsset.id,
            fileUrl: '/uploads/test/revision_2024.xlsx',
            fileName: 'revision_2024.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            fileSize: 85000,
            documentType: 'FACTURE',
            documentDate: '2024-06-10',
            description: 'Facture révision juin 2024',
            createdAt: currentTimestamp,
        },
        {
            userId: testUser.id,
            assetId: veloAsset.id,
            fileUrl: '/uploads/test/entretien_velo.docx',
            fileName: 'entretien_velo.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            fileSize: 45000,
            documentType: 'AUTRE',
            documentDate: '2024-03-15',
            description: 'Notes entretien vélo',
            createdAt: currentTimestamp,
        }
    ]).returning();
    
}

main().catch((error) => {
    console.error('❌ Seeder failed:', error);
});