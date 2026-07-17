import { db } from './index';
import { aiOperation } from './schema';
import { sql } from 'drizzle-orm';

async function main() {
  try {
    const r = await db.execute(sql`SELECT count(*) FROM ai_operation`);
    console.log('direct query OK:', r);
  } catch(e: any) {
    console.error('direct query ERROR:', e.message);
  }
  
  try {
    const r = await db.select({ cnt: sql<number>`count(*)::int` }).from(aiOperation);
    console.log('drizzle query OK:', r);
  } catch(e: any) {
    console.error('drizzle query ERROR:', e.message);
    // Get more details
    console.error('cause:', e.cause?.message);
  }
}
main().catch(e => console.error(e));
