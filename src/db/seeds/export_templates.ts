import { db } from '@/db';
import { exportTemplates } from '@/db/schema';

async function main() {
    const sampleData = {
        code: 'DOSSIER_VENTE',
        label: 'Dossier de vente',
        description: 'Template pour générer un dossier de vente complet d\'un bien',
        templateContent: '<html><body><h1>{{assetName}}</h1><p>{{description}}</p></body></html>',
        variables: '["assetName", "description", "purchaseDate", "price"]',
        category: 'GENERAL' as const,
        isActive: true,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        updatedBy: null,
    };

    await db.insert(exportTemplates).values([sampleData]);
    
}

main().catch((error) => {
    console.error('❌ Seeder failed:', error);
});