import * as dotenv from 'dotenv';
dotenv.config();
async function main() {
  try {
    const { db } = await import('./index');
    const { sql } = await import('drizzle-orm');
    const r = await db.execute(sql`SELECT 1 as test`);
    console.log('DB OK:', r);
  } catch(e: any) {
    console.error('DB ERROR:', e.message);
    if (e.cause) console.error('CAUSE:', e.cause?.message);
  }
}
main();
