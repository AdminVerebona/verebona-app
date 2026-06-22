import * as dotenv from 'dotenv';
dotenv.config();
async function main() {
  const { db } = await import('./index');
  const { aiOperation, aiSecurityLock, accounts } = await import('./schema');
  const { sql, gte, eq } = await import('drizzle-orm');

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  try {
    const r1 = await db.select({ cnt: sql<number>`count(*)::int` }).from(aiOperation).where(gte(aiOperation.startedAt, todayStart));
    console.log('ops today:', r1[0]?.cnt);
  } catch(e: any) {
    console.error('ops today ERROR:', e.message);
  }

  try {
    const r2 = await db.select({ cnt: sql<number>`count(*)::int` }).from(aiSecurityLock).where(eq(aiSecurityLock.isResolved, false));
    console.log('active locks:', r2[0]?.cnt);
  } catch(e: any) {
    console.error('active locks ERROR:', e.message);
  }

  try {
    const r3 = await db.select({ businessResult: aiOperation.businessResult, cnt: sql<number>`count(*)::int` }).from(aiOperation).where(gte(aiOperation.startedAt, monthStart)).groupBy(aiOperation.businessResult);
    console.log('by result OK:', r3.length, 'rows');
  } catch(e: any) {
    console.error('by result ERROR:', e.message);
  }
}
main().catch(e => console.error('GLOBAL:', e.message));
