/**
 * CDC BO IA SNP-010 — effets externes neutralisés (courriels, notifications,
 * webhooks, paiements, intégrations externes) et contrôle anti-effets : la
 * préproduction ne se rouvre pas tant qu'il reste un résidu.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Résidus simulés par contrôle (id → nombre, ou Error). */
let residus: Record<string, number | Error> = {};
const appels: Array<{ sql: string; params: unknown[] }> = [];
vi.mock('@/db', () => ({
  pgClient: {
    unsafe: async (sql: string, params: unknown[] = []) => {
      appels.push({ sql, params });
      if (sql.startsWith('SELECT (')) {
        const { neutralizationChecks } = await import('../neutralization-plan');
        const check = neutralizationChecks().find((c) => sql.includes(c.sql))!;
        const r = residus[check.id] ?? 0;
        if (r instanceof Error) throw r;
        return [{ residual: r }];
      }
      return [];
    },
  },
}));

const {
  NEUTRALIZATION_PLAN, neutralizationChecks, affectedTables, renderNeutralizationScript,
  renderReopeningCheckScript, EXTERNAL_INTEGRATION_TABLE_PATTERN,
} = await import('../neutralization-plan');
const {
  verifyNeutralization, assertReopeningAllowed, runNeutralization, NeutralizationRefused,
} = await import('../neutralization.service');

const initial = { ...process.env };
beforeEach(() => { residus = {}; appels.length = 0; });
afterEach(() => { process.env = { ...initial }; });

describe('SNP-010 — périmètre des effets externes', () => {
  const ids = () => NEUTRALIZATION_PLAN.map((s) => s.id);

  it('paiements : tous les rattachements Stripe, pas seulement le compte', () => {
    expect(ids()).toEqual(expect.arrayContaining([
      'stripe_ids', 'stripe_ids_subscriptions', 'stripe_ids_duo', 'stripe_ids_withdrawals',
    ]));
    expect(affectedTables()).toEqual(expect.arrayContaining(['account_subscriptions', 'duo_accounts', 'withdrawal_requests']));
  });

  it('effets différés : courriels coupés, avis RGPD et travaux IA en file annulés', () => {
    expect(ids()).toEqual(expect.arrayContaining(['email_global_switch', 'gdpr_export_notifications', 'ai_pending_jobs']));
    const file = NEUTRALIZATION_PLAN.find((s) => s.id === 'ai_pending_jobs')!;
    expect(file.sql).toContain("status = 'CANCELLED'");
  });

  it('reprise d’analyse : aucun document copié ne repart vers le fournisseur IA', () => {
    const step = NEUTRALIZATION_PLAN.find((s) => s.id === 'analysis_recovery_candidates')!;
    expect(step.tables).toEqual(['asset_files']);
    // Mêmes critères que `analysis-recovery.service` (NULL, UPLOADED, ANALYZING,
    // ANALYSIS_FAILED sous 10 tentatives), sans délai ni filtre de compte.
    for (const sql of [step.sql, step.verify]) {
      expect(sql).toContain('analysis_state IS NULL');
      expect(sql).toContain("analysis_state IN ('UPLOADED', 'ANALYZING')");
      expect(sql).toContain("(analysis_state = 'ANALYSIS_FAILED' AND analysis_retry_count < 10)");
      expect(sql).not.toMatch(/updated_at|deleted_at|upload_status/);
    }
    // État d'arrivée ignoré par la reprise : échec à 10 tentatives.
    expect(step.sql).toContain("analysis_state = 'ANALYSIS_FAILED'");
    expect(step.sql).toContain('GREATEST(analysis_retry_count, 10)');
    expect(neutralizationChecks().map((c) => c.id)).toContain('analysis_recovery_candidates');
    expect(renderNeutralizationScript([])).toContain("' analysis_recovery_candidates='");
    expect(renderReopeningCheckScript([])).toContain("' analysis_recovery_candidates='");
  });

  it('la reprise d’analyse ignore bien l’état d’arrivée (critères relus dans le service)', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/document-ai/analysis-recovery.service.ts'), 'utf8');
    expect(src).toMatch(/eq\(assetFiles\.analysisState, 'ANALYSIS_FAILED'\),\s*lt\(assetFiles\.analysisRetryCount, 10\)/);
  });

  it('un document relançable restant interdit la réouverture', async () => {
    residus = { analysis_recovery_candidates: 4 };
    await expect(assertReopeningAllowed([])).rejects.toMatchObject({
      message: expect.stringContaining('analysis_recovery_candidates=4'),
    });
  });

  it('webhooks et intégrations stockés en base : journaux Stripe et clé du fournisseur IA', () => {
    expect(affectedTables()).toEqual(expect.arrayContaining(['stripe_webhook_logs', 'ai_provider_credential']));
  });

  it('chaque étape porte sa vérification (résidus comptés sur ses tables)', () => {
    for (const s of NEUTRALIZATION_PLAN) {
      expect(s.verify, s.id).toMatch(/^SELECT count\(\*\) FROM /);
      expect(s.tables.some((t) => s.verify.includes(t)), s.id).toBe(true);
    }
  });
});

describe('SNP-010 — contrôle de dérive des intégrations', () => {
  const motif = new RegExp(EXTERNAL_INTEGRATION_TABLE_PATTERN, 'i');

  it('reconnaît une table de webhook, d’intégration ou de secret', () => {
    for (const t of ['outbound_webhooks', 'crm_integration', 'oauth_tokens', 'partner_api_keys', 'vault_secrets']) {
      expect(motif.test(t), t).toBe(true);
    }
  });

  it('ne bloque pas le schéma actuel : toute table concernée est déjà couverte', () => {
    // Tables déclarées par le schéma Drizzle et par les migrations SQL.
    const racine = join(process.cwd(), 'src', 'db');
    const sources = [
      ...['schema.ts', 'ai-schema.ts', 'verebona-schema.ts'].map((f) => join(racine, f)),
      ...readdirSync(join(racine, 'migrations')).filter((f) => f.endsWith('.sql')).map((f) => join(racine, 'migrations', f)),
    ].map((p) => readFileSync(p, 'utf8')).join('\n');
    const tables = new Set([
      ...[...sources.matchAll(/pgTable\('([a-z0-9_]+)'/g)].map((m) => m[1]),
      ...[...sources.matchAll(/create table (?:if not exists )?"?([a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase()),
    ]);
    const nonCouvertes = [...tables].filter((t) => motif.test(t) && !affectedTables().includes(t));
    expect(nonCouvertes).toEqual([]);
  });

  it('les tables couvertes sont exclues du contrôle de dérive', () => {
    const derive = neutralizationChecks().find((c) => c.id === 'uncovered_integrations')!;
    expect(derive.sql).toContain("'stripe_webhook_logs'");
    expect(derive.sql).toContain("'ai_provider_credential'");
  });
});

describe('SNP-010 — scripts pour la chaîne d’exploitation', () => {
  it('le script de neutralisation se contrôle lui-même avant COMMIT', () => {
    const sql = renderNeutralizationScript(['qa@verebona.fr']);
    const controle = sql.indexOf('RAISE EXCEPTION');
    expect(controle).toBeGreaterThan(sql.lastIndexOf('END $snp$;'));
    expect(controle).toBeLessThan(sql.indexOf('COMMIT;'));
    for (const c of neutralizationChecks()) expect(sql).toContain(`' ${c.id}='`);
    expect(sql).not.toMatch(/\$1/);
  });

  it('le script de contrôle avant réouverture est en lecture seule', () => {
    const sql = renderReopeningCheckScript(['qa@verebona.fr']);
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT|BEGIN;|COMMIT;)\b/);
    expect(sql).not.toMatch(/\$1/);
    expect(sql).toContain("ARRAY['qa@verebona.fr']::text[]");
  });
});

describe('SNP-010 — garde de réouverture', () => {
  it('complète quand tous les contrôles sont à 0 (table absente : sans objet)', async () => {
    residus = { gdpr_export_notifications: new Error('relation "gdpr_exports" does not exist') };
    const v = await verifyNeutralization([]);
    expect(v.complete).toBe(true);
    expect(v.checks.find((c) => c.id === 'gdpr_export_notifications')).toMatchObject({ skipped: true });
    await expect(assertReopeningAllowed([])).resolves.toMatchObject({ complete: true });
  });

  it('un seul résidu interdit la réouverture', async () => {
    residus = { notification_outbox: 3 };
    await expect(assertReopeningAllowed([])).rejects.toMatchObject({
      code: 'NEUTRALIZATION_INCOMPLETE',
      message: expect.stringContaining('notification_outbox=3'),
    });
  });

  it('une table d’intégration non couverte interdit la réouverture', async () => {
    residus = { uncovered_integrations: 1 };
    await expect(assertReopeningAllowed([])).rejects.toBeInstanceOf(NeutralizationRefused);
  });

  it('fermé par défaut : un contrôle en échec interdit la réouverture', async () => {
    residus = { email_global_switch: new Error('permission denied') };
    const v = await verifyNeutralization([]);
    expect(v.complete).toBe(false);
    await expect(assertReopeningAllowed([])).rejects.toMatchObject({ code: 'NEUTRALIZATION_INCOMPLETE' });
  });

  it('le paramètre des comptes préservés n’est transmis qu’aux requêtes qui l’attendent', async () => {
    await verifyNeutralization(['qa@verebona.fr']);
    for (const a of appels) {
      expect(a.params, a.sql).toEqual(/\$1\b/.test(a.sql) ? [['qa@verebona.fr']] : []);
    }
    expect(appels.some((a) => a.params.length === 1)).toBe(true);
  });

  it('la neutralisation n’est « ok » que si le contrôle final est complet', async () => {
    process.env.NEXT_PUBLIC_APP_ENV = 'preprod';
    process.env.ALLOW_SNAPSHOT_NEUTRALIZATION = 'true';
    residus = { ai_pending_jobs: 2 };
    const report = await runNeutralization('preprod');
    expect(report.steps.every((s) => !s.error)).toBe(true);
    expect(report.verification.complete).toBe(false);
    expect(report.ok).toBe(false);
  });
});
