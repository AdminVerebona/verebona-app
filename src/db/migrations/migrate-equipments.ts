import { db } from '../index';
import { assets, equipments } from '../schema';
import { isNotNull, and, ne } from 'drizzle-orm';

async function migrate() {

  const allAssets = await db.select({
    id: assets.id,
    equipmentList: assets.equipmentList,
  }).from(assets).where(isNotNull(assets.equipmentList));

  let migratedCount = 0;

  for (const asset of allAssets) {
    if (!asset.equipmentList || asset.equipmentList.trim() === '') continue;

    // Split by newlines or commas
    const lines = asset.equipmentList.split(/[\n,]+/).map(l => l.trim()).filter(l => l !== '');

    for (const line of lines) {
      await db.insert(equipments).values({
        assetId: asset.id,
        name: line,
        status: 'EN_SERVICE',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      migratedCount++;
    }

    // Optional: Clear the equipmentList field in assets table
    // await db.update(assets).set({ equipmentList: null }).where(eq(assets.id, asset.id));
  }

}

migrate().catch(console.error);
