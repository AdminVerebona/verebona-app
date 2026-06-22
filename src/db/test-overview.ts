import { db } from './index';
import { aiOperation, aiSecurityLock, accounts } from './schema';
import { sql, gte, eq } from 'drizzle-orm';

async function main() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  const [r1, r2] = await Promise.all([
    db.select({ cnt: sql<number>`count(*)::int` }).from(aiOperation).then(r => r[0]),
    db.select({ cnt: sql<number>`count(*)::int` }).from(aiSecurityLock).where(eq(aiSecurityLock.isResolved, false)).then(r => r[0]),
  ]);
  console.log('operations count:', r1?.cnt, 'active locks:', r2?.cnt);
}
main().catch(e => { console.error('ERROR:', e.message, e.stack?.split('\n')[1]); process.exit(1); });
