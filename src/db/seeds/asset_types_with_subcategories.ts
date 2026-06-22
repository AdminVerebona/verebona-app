import { db } from '@/db';
import { assetTypes, assetTypeSubcategories } from '@/db/schema';
import { eq } from 'drizzle-orm';

async function main() {
    let typesCreated = 0;
    let typesSkipped = 0;
    let subcategoriesCreated = 0;
    let subcategoriesSkipped = 0;

    // Asset Types to create
    const assetTypesData = [
        {
            code: 'IMMOBILIER',
            label: 'Biens immobiliers',
            icon: 'Home',
            isEnabled: true,
            displayOrder: 1,
        },
        {
            code: 'VEHICULE',
            label: 'Véhicule',
            icon: 'Car',
            isEnabled: true,
            displayOrder: 2,
        },
        {
            code: 'MATERIEL_PRO',
            label: 'Matériel professionnel',
            icon: 'Briefcase',
            isEnabled: true,
            displayOrder: 3,
        },
        {
            code: 'OBJECT',
            label: 'Objet',
            icon: 'Package',
            isEnabled: true,
            displayOrder: 5,
        },
    ];

    // Subcategories data structure
    const subcategoriesData = {
        IMMOBILIER: [
            { code: 'MAISON', label: 'Maison', icon: 'Home', displayOrder: 1 },
            { code: 'APPARTEMENT', label: 'Appartement', icon: 'Building', displayOrder: 2 },
            { code: 'STUDIO', label: 'Studio et Appartement', icon: 'Building2', displayOrder: 3 },
            { code: 'TERRAIN', label: 'Terrain', icon: 'Trees', displayOrder: 4 },
            { code: 'LOCAL_COMMERCIAL', label: 'Local commercial', icon: 'Store', displayOrder: 5 },
            { code: 'GARAGE', label: 'Garage', icon: 'ParkingSquare', displayOrder: 6 },
        ],
        VEHICULE: [
            { code: 'VELO', label: 'Vélo', icon: 'Bike', displayOrder: 1 },
            { code: 'VOITURE', label: 'Voiture', icon: 'Car', displayOrder: 2 },
            { code: 'CAMION', label: 'Camion', icon: 'Truck', displayOrder: 3 },
            { code: 'MOTO', label: 'Moto', icon: 'Bike', displayOrder: 4 },
        ],
        MATERIEL_PRO: [
            { code: 'ORDINATEUR', label: 'Ordinateur portable', icon: 'Laptop', displayOrder: 1 },
            { code: 'OUTILLAGE', label: 'Outillage', icon: 'Wrench', displayOrder: 2 },
            { code: 'MACHINE', label: 'Machine/Équipement', icon: 'Cog', displayOrder: 3 },
        ],
        OBJECT: [
            { code: 'OBJECT_CATEGORY_TECH', label: 'Tech / IT / Électronique', icon: 'Laptop', displayOrder: 1 },
            { code: 'OBJECT_CATEGORY_SPORT', label: 'Loisir / Sport', icon: 'Dumbbell', displayOrder: 2 },
            { code: 'OBJECT_CATEGORY_HOME', label: 'Maison & équipement', icon: 'Microwave', displayOrder: 3 },
        ],
    };

    // Insert or fetch asset types
    const assetTypeIds: Record<string, number> = {};

    for (const assetTypeData of assetTypesData) {
        const existing = await db
            .select()
            .from(assetTypes)
            .where(eq(assetTypes.code, assetTypeData.code))
            .limit(1);

        if (existing.length === 0) {
            const result = await db
                .insert(assetTypes)
                .values({
                    ...assetTypeData,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                })
                .returning({ id: assetTypes.id });

            assetTypeIds[assetTypeData.code] = result[0].id;
            typesCreated++;
        } else {
            assetTypeIds[assetTypeData.code] = existing[0].id;
            typesSkipped++;
        }
    }

    // Insert subcategories
    for (const [assetTypeCode, subcategories] of Object.entries(subcategoriesData)) {
        const assetTypeId = assetTypeIds[assetTypeCode];

        if (!assetTypeId) {
            console.error(`❌ Asset type ${assetTypeCode} not found, skipping subcategories`);
            continue;
        }

        for (const subcategoryData of subcategories) {
            const existing = await db
                .select()
                .from(assetTypeSubcategories)
                .where(eq(assetTypeSubcategories.code, subcategoryData.code))
                .limit(1);

            if (existing.length === 0) {
                await db.insert(assetTypeSubcategories).values({
                    assetTypeId,
                    code: subcategoryData.code,
                    label: subcategoryData.label,
                    icon: subcategoryData.icon,
                    isEnabled: true,
                    displayOrder: subcategoryData.displayOrder,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });

                subcategoriesCreated++;
            } else {
                subcategoriesSkipped++;
            }
        }
    }

}

main().catch((error) => {
    console.error('❌ Seeder failed:', error);
    process.exit(1);
});