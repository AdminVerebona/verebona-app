/**
 * Preuves de réauthentification EN MÉMOIRE — tests unitaires seulement
 * (setup.ts, tests du lot 92). Même contrat que le stockage en base (`reauth.ts`).
 */
import type { ReauthProofRecord, ReauthProofStore } from './reauth';

export function createMemoryReauthProofStore(): ReauthProofStore & { rows: ReauthProofRecord[] } {
  const rows: ReauthProofRecord[] = [];
  return {
    rows,
    async insert(p) {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].sid === p.sid) rows.splice(i, 1);
      rows.push({ ...p });
    },
    async latest(userId, sid) {
      const r = rows.filter((x) => x.userId === userId && x.sid === sid).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      return r ? { ...r } : null;
    },
    async consume(id, action, now) {
      const r = rows.find((x) => x.id === id);
      if (!r || r.consumedAt || r.expiresAt <= now) return false;
      r.consumedAt = now;
      r.consumedFor = action;
      return true;
    },
    async invalidate(userId, sid) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].userId === userId && (!sid || rows[i].sid === sid)) rows.splice(i, 1);
      return before - rows.length;
    },
    async purge(now) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].expiresAt.getTime() < now.getTime() - 86_400_000) rows.splice(i, 1);
      return before - rows.length;
    },
  };
}
