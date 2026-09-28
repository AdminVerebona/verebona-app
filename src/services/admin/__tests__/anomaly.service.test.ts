/**
 * Anomalies de supervision — CDC BO SUP-002, SUP-005, SUP-007 à SUP-011,
 * REC-DASH-05, REC-DASH-06, REC-DASH-07, AUD-003.
 *
 * La base est remplacée par un faux client qui interprète les quelques
 * requêtes du service, avec la même contrainte que l'index unique partiel
 * de la migration 0172 (une seule anomalie ouverte par empreinte).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Row {
  id: number; domain: string; fingerprint: string; title: string; status: 'open' | 'resolved';
  account_id: number | null; user_id: number | null; occurrence_count: number;
  previous_anomaly_id: number | null; resolved_at: Date | null; resolution_source: string | null;
  auto_resolution_origin: string | null; corrective_action: string | null; technical_detail: unknown;
}

const store = vi.hoisted(() => ({
  rows: [] as Row[],
  occurrences: [] as Array<{ anomaly_id: number; detail: unknown }>,
  seq: 0,
  clock: 0,
}));

const fake = vi.hoisted(() => {
  const unsafe = async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    const now = () => new Date(Date.UTC(2026, 0, 1) + ++store.clock * 1000);
    if (params[0] === 'other:panne') throw new Error('connexion perdue');
    if (s.startsWith("SELECT id FROM admin_anomalies WHERE fingerprint = $1 AND status = 'open'")) {
      return store.rows.filter((r) => r.fingerprint === params[0] && r.status === 'open').map((r) => ({ id: r.id }));
    }
    if (s.startsWith("SELECT id FROM admin_anomalies WHERE fingerprint = $1 AND status = 'resolved'")) {
      return store.rows.filter((r) => r.fingerprint === params[0] && r.status === 'resolved')
        .sort((a, b) => b.resolved_at!.getTime() - a.resolved_at!.getTime() || b.id - a.id)
        .slice(0, 1).map((r) => ({ id: r.id }));
    }
    if (s.startsWith('UPDATE admin_anomalies SET occurrence_count')) {
      const r = store.rows.find((x) => x.id === params[0])!;
      r.occurrence_count += 1;
      if (params[1]) r.technical_detail = JSON.parse(params[1] as string);
      return [];
    }
    if (s.startsWith('INSERT INTO admin_anomalies ')) {
      if (store.rows.some((x) => x.fingerprint === params[1] && x.status === 'open')) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      const row: Row = {
        id: ++store.seq, domain: params[0] as string, fingerprint: params[1] as string, title: params[2] as string,
        status: 'open', account_id: params[3] as number | null, user_id: params[4] as number | null, occurrence_count: 1,
        technical_detail: params[5] ? JSON.parse(params[5] as string) : null, previous_anomaly_id: params[6] as number | null,
        resolved_at: null, resolution_source: null, auto_resolution_origin: null, corrective_action: null,
      };
      store.rows.push(row);
      return [{ id: row.id }];
    }
    if (s.startsWith('INSERT INTO admin_anomaly_occurrences')) {
      store.occurrences.push({ anomaly_id: params[0] as number, detail: params[3] });
      return [];
    }
    if (s.includes("resolution_source = 'auto'") && s.includes('WHERE fingerprint = $1')) {
      const hit = store.rows.filter((r) => r.fingerprint === params[0] && r.status === 'open');
      for (const r of hit) Object.assign(r, { status: 'resolved', resolved_at: now(), resolution_source: 'auto', auto_resolution_origin: params[1] });
      return hit.map((r) => ({ id: r.id }));
    }
    if (s.includes("resolution_source = 'manual'")) {
      const r = store.rows.find((x) => x.id === params[0] && x.status === 'open');
      if (!r) return [];
      Object.assign(r, { status: 'resolved', resolved_at: now(), resolution_source: 'manual', corrective_action: params[4] });
      return [{ id: r.id, domain: r.domain, fingerprint: r.fingerprint }];
    }
    if (s.startsWith('SELECT id FROM admin_anomalies WHERE id = $1')) {
      return store.rows.filter((r) => r.id === params[0]).map((r) => ({ id: r.id }));
    }
    throw new Error(`requête non simulée : ${s.slice(0, 80)}`);
  };
  return { unsafe, begin: async (fn: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) => fn({ unsafe }) };
});

vi.mock('@/db', () => ({ pgClient: fake, db: {} }));
const logAdminAction = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/admin-audit', () => ({ logAdminAction }));

import {
  ANOMALY_DOMAINS, anomalyOrderBy, autoResolveAnomaly, buildCounters, buildFingerprint, cleanNote, decideReport,
  diagnosticLinkFor, isBackupStale, isReferralRetryExhausted, isStripeRetryExhausted, reportAnomaly,
  resolveAnomalyManually, sanitizeDetail, validateManualResolution,
} from '../anomaly.service';

beforeEach(() => {
  store.rows = [];
  store.occurrences = [];
  store.seq = 0;
  store.clock = 0;
  logAdminAction.mockClear();
});

describe('empreinte et décision (SUP-010, SUP-011)', () => {
  it('empreinte normalisée et stable', () => {
    expect(buildFingerprint('stripe', 'Webhook', ' EVT_1 ')).toBe('stripe:webhook:evt_1');
    expect(buildFingerprint('backups', 'database', null, '')).toBe('backups:database');
    expect(buildFingerprint('other', 'x'.repeat(500)).length).toBe(200);
  });

  it('ouverte → consolidation ; sinon création liée à la dernière résolue', () => {
    expect(decideReport({ id: 4 }, { id: 2 })).toEqual({ action: 'consolidate', anomalyId: 4 });
    expect(decideReport(null, { id: 2 })).toEqual({ action: 'create', previousAnomalyId: 2 });
    expect(decideReport(null, null)).toEqual({ action: 'create', previousAnomalyId: null });
  });
});

describe('cycle de vie', () => {
  const report = (detail?: Record<string, unknown>) => reportAnomaly({
    domain: 'stripe', fingerprint: 'stripe:webhook:evt_1', title: 'Webhook en échec', accountId: 7, detail,
  });

  it('REC-DASH-05 : une anomalie ouverte répétée est consolidée', async () => {
    const a = await report({ error: 'e1' });
    const b = await report({ error: 'e2' });
    const c = await report({ error: 'e3' });
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(c).toBe(1);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].occurrence_count).toBe(3);
    expect(store.rows[0].technical_detail).toEqual({ error: 'e3' });
    expect(store.occurrences).toHaveLength(3); // historique des occurrences
  });

  it('REC-DASH-06 : résolue puis réapparue → nouvelle anomalie liée', async () => {
    await report();
    expect(await autoResolveAnomaly('stripe:webhook:evt_1', { origin: 'stripe_webhook_retry' })).toBe(true);
    expect(store.rows[0]).toMatchObject({ status: 'resolved', resolution_source: 'auto', auto_resolution_origin: 'stripe_webhook_retry' });
    const again = await report();
    expect(again).toBe(2);
    expect(store.rows[1]).toMatchObject({ status: 'open', previous_anomaly_id: 1, occurrence_count: 1 });
  });

  it('SUP-008 : résolution automatique sans anomalie ouverte → sans effet', async () => {
    expect(await autoResolveAnomaly('backups:database', { origin: 'backup_succeeded' })).toBe(false);
  });

  it('ne lève jamais, même si la base échoue', async () => {
    await expect(reportAnomaly({ domain: 'other', fingerprint: 'other:panne', title: 't' })).resolves.toBeNull();
    await expect(autoResolveAnomaly('other:panne', { origin: 'test' })).resolves.toBe(false);
    // Domaine hors liste : ignoré proprement.
    expect(await reportAnomaly({ domain: 'rgpd' as never, fingerprint: 'rgpd:x', title: 't' })).toBeNull();
  });

  it('SUP-007 / AUD-003 : résolution manuelle journalisée et idempotente', async () => {
    await report();
    expect(await resolveAnomalyManually(1, 99, { correctiveAction: '  ' })).toBe('CORRECTIVE_ACTION_REQUIRED');
    expect(await resolveAnomalyManually(1, 99, { cause: 'Clé expirée', correctiveAction: 'Clé renouvelée' })).toBeNull();
    expect(store.rows[0]).toMatchObject({ status: 'resolved', resolution_source: 'manual', corrective_action: 'Clé renouvelée' });
    expect(logAdminAction).toHaveBeenCalledTimes(1);
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      adminId: 99, action: 'ANOMALY_RESOLVE', targetType: 'ANOMALY', targetId: 1, result: 'SUCCESS',
    }));
    // Double clic : aucune seconde résolution ni seconde ligne de journal.
    expect(await resolveAnomalyManually(1, 99, { correctiveAction: 'x' })).toBe('ALREADY_RESOLVED');
    expect(await resolveAnomalyManually(42, 99, { correctiveAction: 'x' })).toBe('NOT_FOUND');
    expect(logAdminAction).toHaveBeenCalledTimes(1);
  });
});

describe('compteurs et listes (SUP-002, SUP-005, SUP-H02)', () => {
  it('tous les domaines, zéros compris, RGPD absent', () => {
    const c = buildCounters([{ domain: 'stripe', open: 2 }, { domain: 'ai', open: 1 }]);
    expect(c.totalOpen).toBe(3);
    expect(c.domains).toHaveLength(ANOMALY_DOMAINS.length);
    expect(c.domains.find((d) => d.domain === 'backups')?.open).toBe(0);
    expect(ANOMALY_DOMAINS.map((d) => d.key)).toEqual(
      expect.arrayContaining(['stripe', 'communications', 'exports', 'backups', 'ai']),
    );
    expect(ANOMALY_DOMAINS.some((d) => /rgpd|gdpr|storage/i.test(d.key))).toBe(false);
  });

  it('tri en liste blanche, départage stable', () => {
    expect(anomalyOrderBy('open', 'date', null)).toBe('an.last_seen_at DESC NULLS LAST, an.id DESC');
    expect(anomalyOrderBy('resolved', 'date', 'asc')).toBe('an.resolved_at ASC NULLS LAST, an.id ASC');
    expect(anomalyOrderBy('open', 'account', null)).toMatch(/^lower\(acc\.name\) ASC/);
    expect(anomalyOrderBy('open', 'user', 'desc')).toMatch(/^lower\(u\.email\) DESC/);
    expect(anomalyOrderBy('open', 'domain', null)).toMatch(/^CASE an\.domain/);
    expect(anomalyOrderBy('open', 'id; DROP TABLE users', 'x')).toBe('an.last_seen_at DESC NULLS LAST, an.id DESC');
  });

  it('les routes n\'acceptent ni recherche ni filtre (SUP-005, REC-DASH-07)', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/api/admin/anomalies/route.ts'), 'utf8');
    const read = [...src.matchAll(/params\.get\('([a-z]+)'\)/g)].map((m) => m[1]).sort();
    expect(read).toEqual(['dir', 'page', 'sort', 'status']);
  });
});

describe('règles des points d\'intégration (SUP-009)', () => {
  it('webhook Stripe : anomalie seulement après une heure de relances', () => {
    const now = new Date('2026-09-26T12:00:00Z');
    const sec = (d: string) => new Date(d).getTime() / 1000;
    expect(isStripeRetryExhausted(sec('2026-09-26T11:59:00Z'), now)).toBe(false);
    expect(isStripeRetryExhausted(sec('2026-09-26T10:59:00Z'), now)).toBe(true);
  });

  it('parrainage : après deux jours d\'échecs quotidiens', () => {
    const cutoff = new Date('2026-09-12T00:00:00Z');
    expect(isReferralRetryExhausted(new Date('2026-09-11T00:00:00Z'), cutoff)).toBe(false);
    expect(isReferralRetryExhausted(new Date('2026-09-09T00:00:00Z'), cutoff)).toBe(true);
    expect(isReferralRetryExhausted(null, cutoff)).toBe(false);
  });

  it('sauvegarde : périmée au-delà de 48 h ou absente', () => {
    const now = new Date('2026-09-26T12:00:00Z');
    expect(isBackupStale(new Date('2026-09-25T12:00:00Z'), now)).toBe(false);
    expect(isBackupStale(new Date('2026-09-24T11:00:00Z'), now)).toBe(true);
    expect(isBackupStale(null, now)).toBe(true);
  });
});

describe('saisies et détail', () => {
  it('action corrective requise, saisies nettoyées', () => {
    expect(validateManualResolution({ correctiveAction: 'ok' })).toBeNull();
    expect(validateManualResolution({ cause: 'x' })).toBe('CORRECTIVE_ACTION_REQUIRED');
    expect(cleanNote('  ')).toBeNull();
    expect(cleanNote(42)).toBeNull();
  });

  it('détail technique borné', () => {
    const d = sanitizeDetail({ a: 'x'.repeat(5000), b: 1, c: undefined, e: new Error('boom') })!;
    expect((d.a as string).length).toBe(2001);
    expect(d).not.toHaveProperty('c');
    expect(d.e).toBe('boom');
  });

  it('AI-001 : lien vers l\'écran IA pertinent', () => {
    expect(diagnosticLinkFor('ai', { operationId: 'op-1' })?.href).toBe('/admin/ai-executions?operationId=op-1');
    expect(diagnosticLinkFor('ai', null)?.href).toBe('/admin/ai-queue');
    expect(diagnosticLinkFor('stripe', { operationId: 'x' })).toBeNull();
  });
});
