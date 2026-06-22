/**
 * Script de backfill : classifie les items agenda existants avec homeCategory
 *
 * Usage :
 *   npx ts-node -r tsconfig-paths/register src/db/migrations/backfill-home-category.ts
 *   // ou via bun :
 *   bun run src/db/migrations/backfill-home-category.ts
 *
 * Le script traite les items en batches de 50, avec un délai entre chaque
 * pour ne pas saturer l'API Gemini. Les items déjà classifiés sont ignorés.
 */

import { db } from '@/db';
import { agendaItems } from '@/db/schema';
import { isNull, eq } from 'drizzle-orm';
import { classifyAgendaItem } from '@/services/agenda/AgendaClassificationService';

const BATCH_SIZE = 50;
const DELAY_MS = 100; // délai entre items pour limiter le rate Gemini

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('🔄 Backfill homeCategory pour les items agenda...\n');

  // Récupérer tous les items sans homeCategory
  const unclassified = await db
    .select({
      id: agendaItems.id,
      title: agendaItems.title,
      description: agendaItems.description,
      originType: agendaItems.originType,
      originFieldKey: agendaItems.originFieldKey,
    })
    .from(agendaItems)
    .where(isNull(agendaItems.homeCategory));

  console.log(`📋 ${unclassified.length} items à classifier\n`);

  if (unclassified.length === 0) {
    console.log('✅ Aucun item à traiter.');
    process.exit(0);
  }

  let processed = 0;
  let errors = 0;
  const counts = { action: 0, information: 0 };

  for (let i = 0; i < unclassified.length; i += BATCH_SIZE) {
    const batch = unclassified.slice(i, i + BATCH_SIZE);
    console.log(`\n--- Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(unclassified.length / BATCH_SIZE)} (items ${i + 1}–${Math.min(i + BATCH_SIZE, unclassified.length)}) ---`);

    for (const item of batch) {
      try {
        const category = await classifyAgendaItem(
          item.title,
          item.description,
          item.originType,
          item.originFieldKey,
        );

        await db
          .update(agendaItems)
          .set({ homeCategory: category })
          .where(eq(agendaItems.id, item.id));

        counts[category]++;
        processed++;
        console.log(`  ✓ [${item.id}] "${item.title.slice(0, 50)}" → ${category}`);
      } catch (err) {
        errors++;
        console.error(`  ✗ [${item.id}] "${item.title.slice(0, 50)}" : ${err}`);
      }

      await sleep(DELAY_MS);
    }
  }

  console.log(`\n✅ Terminé !`);
  console.log(`   Traités   : ${processed}/${unclassified.length}`);
  console.log(`   Erreurs   : ${errors}`);
  console.log(`   action    : ${counts.action}`);
  console.log(`   information : ${counts.information}`);

  process.exit(errors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Erreur fatale :', err);
  process.exit(1);
});
