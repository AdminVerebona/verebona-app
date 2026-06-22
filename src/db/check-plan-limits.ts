import * as dotenv from 'dotenv';
dotenv.config();
async function main() {
  const { db } = await import('./index');
  const { planLimits } = await import('./schema');
  const { sql } = await import('drizzle-orm');
  
  // Check if planLimits table exists
  try {
    const r = await db.select().from(planLimits).limit(3);
    console.log('planLimits OK:', r.length, 'rows');
  } catch(e: any) {
    console.error('planLimits ERROR:', e.message);
  }
  
  // Check if aiUsageAccountCounter exists
  try {
    const { aiUsageAccountCounter } = await import('./schema');
    const r = await db.select().from(aiUsageAccountCounter).limit(1);
    console.log('aiUsageAccountCounter OK:', r.length, 'rows');
  } catch(e: any) {
    console.error('aiUsageAccountCounter ERROR:', e.message);
  }
}
main().catch(e => console.error('GLOBAL:', e.message));
