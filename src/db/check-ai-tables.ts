import postgres from 'postgres';
import * as dotenv from 'dotenv';
dotenv.config();
async function main() {
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
  // Check the schema columns on the old ai_usage_events vs new ai_usage_event
  const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_usage_event' ORDER BY column_name`;
  console.log('ai_usage_event cols:', cols.map((x:any) => x.column_name).join(', '));
  await sql.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
