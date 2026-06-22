import { db } from '@/db';
import { assetTypes } from '@/db/schema';

async function main() {
    const sampleAssetTypes = [
        {
            code: 'IMMOBILIER',
            label: 'Bien immobilier',
            icon: 'Home',
            isEnabled: true,
            displayOrder: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
        },
        {
            code: 'VEHICULE',
            label: 'Véhicule',
            icon: 'Car',
            isEnabled: true,
            displayOrder: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
        },
        {
            code: 'MATERIEL_PRO',
            label: 'Matériel professionnel',
            icon: 'Briefcase',
            isEnabled: true,
            displayOrder: 3,
            createdAt: new Date(),
            updatedAt: new Date(),
        }
    ];

    await db.insert(assetTypes).values(sampleAssetTypes);
    
}

main().catch((error) => {
    console.error('❌ Seeder failed:', error);
});