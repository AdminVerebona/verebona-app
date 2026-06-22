import postgres from 'postgres';
import * as dotenv from 'dotenv';
dotenv.config();
async function main() {
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
  const r = await sql`SELECT table_name FROM information_schema.tables WHERE table_name = 'plan_limits'`;
  console.log('plan_limits table exists:', r.length > 0);
  if (r.length === 0) {
    // Check what commercial model tables exist  
    const r2 = await sql`SELECT table_name FROM information_schema.tables WHERE table_name LIKE '%plan%' AND table_schema='public'`;
    console.log('plan tables:', r2.map((x:any) => x.table_name).join(', '));
  }
  await sql.end();
}
main().catch(e => console.error(e.message));
