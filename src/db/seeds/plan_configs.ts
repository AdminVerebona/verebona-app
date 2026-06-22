import { db } from '@/db';
import { planConfigs } from '@/db/schema';

async function main() {
    const samplePlanConfigs = [
        {
            planType: 'STANDARD' as const,
            maxAssets: 3,
            pdfDossierEnabled: false,
            pdfCarnetEnabled: false,
            zipExportEnabled: true,
            maintenanceTracking: 'manual',
            updatedAt: new Date(),
        },
        {
            planType: 'PREMIUM' as const,
            maxAssets: -1,
            pdfDossierEnabled: true,
            pdfCarnetEnabled: true,
            zipExportEnabled: true,
            maintenanceTracking: 'manual',
            updatedAt: new Date(),
        }
    ];

    await db.insert(planConfigs).values(samplePlanConfigs);
    
}

main().catch((error) => {
    console.error('❌ Seeder failed:', error);
});