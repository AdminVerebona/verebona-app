import { db } from '@/db';
import { documentTypes, documentTypeAssetAssociations, documentTypeExportAssociations } from '@/db/schema';
import { eq } from 'drizzle-orm';

async function main() {

    const allDocTypes = await db.select().from(documentTypes);
    
    
    for (const docType of allDocTypes) {
        
        // Check associations
        const assetAssocs = await db.select()
            .from(documentTypeAssetAssociations)
            .where(eq(documentTypeAssetAssociations.documentTypeId, docType.id));
        
        const exportAssocs = await db.select()
            .from(documentTypeExportAssociations)
            .where(eq(documentTypeExportAssociations.documentTypeId, docType.id));
        
    }
    
}

main().catch((error) => {
    console.error('❌ Check failed:', error);
    process.exit(1);
});