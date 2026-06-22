import postgres from 'postgres';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
  
  // Check which migrations are registered
  const applied = await sql`SELECT filename FROM _migrations ORDER BY filename`;
  console.log('Applied migrations:', applied.map((x:any) => x.filename).join(', '));
  
  // Check if 0067 is there
  const has0067 = applied.some((x:any) => x.filename === '0067_ai_usage_tracking.sql');
  if (!has0067) {
    await sql`INSERT INTO _migrations (filename) VALUES ('0067_ai_usage_tracking.sql') ON CONFLICT DO NOTHING`;
    console.log('Registered 0067_ai_usage_tracking.sql');
  } else {
    console.log('0067 already registered');
  }
  
  await sql.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
