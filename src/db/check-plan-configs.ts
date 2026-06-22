import postgres from 'postgres';
import * as dotenv from 'dotenv';
dotenv.config();
async function main() {
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
  const r = await sql`SELECT * FROM plan_configs LIMIT 5`;
  console.log(JSON.stringify(r, null, 2));
  await sql.end();
}
main().catch(e => console.error(e.message));
