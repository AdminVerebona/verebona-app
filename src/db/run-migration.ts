/**
 * Run the agenda migration SQL directly
 * Usage: npx tsx src/db/run-migration.ts
 */
import postgres from 'postgres';
import { readFileSync } from 'fs';
import { join } from 'path';

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

async function main() {
  const migrationSql = readFileSync(join(__dirname, 'migrations/0050_agenda_items.sql'), 'utf-8');

  await sql.unsafe(migrationSql);
  await sql.end();
}

main().catch(err => {
  console.error('[migration] Error:', err.message);
  process.exit(1);
});
