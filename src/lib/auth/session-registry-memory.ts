/**
 * Registre des sessions EN MÉMOIRE — tests unitaires seulement (setup.ts et
 * tests du lot 92). Même contrat que le stockage en base
 * (`session-registry.ts`).
 */
import type { SessionRecord, SessionRegistryStore } from './session-registry';

export function createMemorySessionRegistryStore(): SessionRegistryStore & { rows: Map<string, SessionRecord> } {
  const rows = new Map<string, SessionRecord>();
  const clone = (r: SessionRecord): SessionRecord => ({ ...r });
  return {
    rows,
    async upsert(i) {
      const existing = rows.get(i.sid);
      if (existing) {
        if (existing.userId !== i.userId) return 'foreign';
        if (existing.revokedAt) return 'revoked';
        rows.set(i.sid, {
          ...existing,
          lastSeenAt: i.now,
          expiresAt: i.expiresAt,
          refreshTokenHash: i.refreshTokenHash,
          refreshVersion: existing.refreshVersion + 1,
          deviceKey: existing.deviceKey ?? i.client.deviceKey,
          deviceSource: existing.deviceSource ?? i.client.deviceSource,
          clientType: i.client.clientType,
          appVersion: i.client.appVersion ?? existing.appVersion,
          deviceLabel: i.client.deviceLabel,
          browserLabel: i.client.browserLabel,
        });
        return 'updated';
      }
      rows.set(i.sid, {
        sid: i.sid,
        userId: i.userId,
        deviceKey: i.client.deviceKey,
        deviceSource: i.client.deviceSource,
        clientType: i.client.clientType,
        appVersion: i.client.appVersion,
        deviceLabel: i.client.deviceLabel,
        browserLabel: i.client.browserLabel,
        authMethod: i.authMethod,
        registeredVia: i.registeredVia,
        createdAt: i.now,
        lastSeenAt: i.now,
        expiresAt: i.expiresAt,
        revokedAt: null,
        revocationReason: null,
        refreshTokenHash: i.refreshTokenHash,
        refreshVersion: 1,
      });
      return 'created';
    },
    async get(sid) {
      const r = rows.get(sid);
      return r ? clone(r) : null;
    },
    async listActive(userId, now) {
      return [...rows.values()]
        .filter((r) => r.userId === userId && !r.revokedAt && r.expiresAt > now)
        .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
        .map(clone);
    },
    async revoke(m, reason, now) {
      const out: SessionRecord[] = [];
      for (const r of rows.values()) {
        if (r.userId !== m.userId || r.revokedAt) continue;
        if (m.sid && r.sid !== m.sid) continue;
        if (m.exceptSid && r.sid === m.exceptSid) continue;
        if (m.deviceKey && r.deviceKey !== m.deviceKey) continue;
        r.revokedAt = now;
        r.revocationReason = reason;
        out.push(clone(r));
      }
      return out;
    },
    async hasDevice(userId, deviceKey, exceptSid) {
      return [...rows.values()].some((r) => r.userId === userId && r.deviceKey === deviceKey && r.sid !== exceptSid);
    },
    async purge(now, retentionMs) {
      const limit = now.getTime() - retentionMs;
      let n = 0;
      for (const [sid, r] of rows) {
        if ((r.revokedAt && r.revokedAt.getTime() < limit) || r.expiresAt.getTime() < limit) {
          rows.delete(sid);
          n += 1;
        }
      }
      return n;
    },
  };
}
