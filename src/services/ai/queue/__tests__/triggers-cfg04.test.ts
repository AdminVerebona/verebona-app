/**
 * CDC 15 CFG-04, DOD-19 — déclenchements automatiques soumis à la version
 * effective, ou retirés de l'écran :
 *   · reprise T1 toutes les 5 min (`analysis-recovery-scheduler`) →
 *     déclencheur `analysis_recovery` ;
 *   · revue IA du cron `/api/cron/hourly-enrichment` → `coherence_ai_review`,
 *     RETIRÉ au lot 16b-3 avec la route (reconnu, jamais actif) ;
 *   · `web_link_added`, jamais conditionnant → retiré (reconnu, ignoré).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeTriggerCodes, isTriggerActive, __setTriggerConfigLoader, DEFAULT_TRIGGERS } from '../triggers';
import { listTriggers, triggerCodes, retiredTriggerCodes } from '../../config/catalogs';
import { validateVersion } from '../../config/config-validation.service';
import { emptyTreatmentConfig } from '../../config/config-types';

afterEach(() => {
  __setTriggerConfigLoader(null);
});

describe('catalogue et défauts', () => {
  it('web_link_added : retiré de l’écran, reconnu, jamais actif', () => {
    expect(listTriggers('T1').map((t) => t.code)).not.toContain('web_link_added');
    expect(triggerCodes().has('web_link_added')).toBe(true);
    expect(retiredTriggerCodes().has('web_link_added')).toBe(true);
    expect(DEFAULT_TRIGGERS.T1).not.toContain('web_link_added');
    expect(activeTriggerCodes('T1', [{ kind: 'event', code: 'web_link_added', active: true }]).has('web_link_added')).toBe(false);
  });

  it('analysis_recovery : déclencheur actif par défaut ; coherence_ai_review retiré (lot 16b-3), jamais actif', () => {
    expect(listTriggers('T1').map((t) => t.code)).toContain('analysis_recovery');
    expect(activeTriggerCodes('T1', []).has('analysis_recovery')).toBe(true);
    expect(listTriggers('T3').map((t) => t.code)).not.toContain('coherence_ai_review');
    expect(retiredTriggerCodes().has('coherence_ai_review')).toBe(true);
    expect(activeTriggerCodes('T3', null).has('coherence_ai_review')).toBe(false);
    expect(activeTriggerCodes('T3', [{ kind: 'event', code: 'coherence_ai_review', active: true }]).has('coherence_ai_review')).toBe(false);
  });

  it('version antérieure, liste renseignée SANS le nouveau code : il reste actif (aucune coupure au déploiement)', async () => {
    __setTriggerConfigLoader(async () => ({ triggers: [{ kind: 'event', code: 'source_uploaded', active: true }] }));
    expect(await isTriggerActive('T1', 'analysis_recovery')).toBe(true);
    expect(await isTriggerActive('T1', 'source_uploaded')).toBe(true);
    __setTriggerConfigLoader(async () => ({ triggers: [{ kind: 'event', code: 'source_analyzed', active: true }] }));
    expect(await isTriggerActive('T3', 'coherence_ai_review')).toBe(false);
    // Les codes historiques gardent la règle « la liste fait foi ».
    expect(await isTriggerActive('T3', 'schedule_daily')).toBe(false);
  });

  it('seul un active:false explicite désactive un nouveau code', async () => {
    __setTriggerConfigLoader(async () => ({ triggers: [
      { kind: 'event', code: 'source_uploaded', active: true },
      { kind: 'event', code: 'analysis_recovery', active: false },
    ] }));
    expect(await isTriggerActive('T1', 'analysis_recovery')).toBe(false);
    // Un nouveau code n'est jamais ajouté à un traitement auquel il ne s'applique pas.
    expect(activeTriggerCodes('T4', [{ kind: 'event', code: 'source_analyzed', active: true }]).has('analysis_recovery')).toBe(false);
  });

  it('validation : code retiré signalé sans bloquer', () => {
    const r = validateVersion(
      [{ ...emptyTreatmentConfig('T1'), prompt: 'x', triggers: [{ kind: 'event', code: 'web_link_added', active: true }] }],
      { availableModels: new Set<string>(), pricedModels: new Set<string>(), guardrailCodes: new Set<string>(), triggerCodes: triggerCodes() },
    );
    const retire = r.issues.find((i) => i.field === 'triggers' && i.message.includes('web_link_added'));
    expect(retire?.blocking).toBe(false);
  });
});

describe('reprise T1 toutes les 5 min', () => {
  it('déclencheur inactif : aucune relance ; la purge (non IA) continue', async () => {
    const { runRecoveryTick, RECOVERY_TRIGGER } = await import('@/services/document-ai/analysis-recovery-scheduler');
    const runRecovery = vi.fn(async () => ({ found: 3, retried: 3, errors: 0 }));
    const purge = vi.fn(async () => undefined);
    const isActive = vi.fn(async () => false);
    expect(await runRecoveryTick({ isTriggerActive: isActive, runRecovery, purge })).toEqual({ recovery: 'inactive' });
    expect(isActive).toHaveBeenCalledWith('T1', RECOVERY_TRIGGER);
    expect(runRecovery).not.toHaveBeenCalled();
    expect(purge).toHaveBeenCalledOnce();
  });

  it('déclencheur actif : relance', async () => {
    const { runRecoveryTick } = await import('@/services/document-ai/analysis-recovery-scheduler');
    const runRecovery = vi.fn(async () => ({ found: 0, retried: 0, errors: 0 }));
    expect(await runRecoveryTick({ isTriggerActive: async () => true, runRecovery, purge: async () => undefined }))
      .toEqual({ recovery: 'ran' });
    expect(runRecovery).toHaveBeenCalledOnce();
  });
});

describe('cron hourly-enrichment (supprimé, lot 16b-3)', () => {
  it('route et service absents', async () => {
    const { existsSync } = await import('fs');
    expect(existsSync('src/app/api/cron/hourly-enrichment/route.ts')).toBe(false);
    expect(existsSync('src/services/document-ai/hourly-enrichment.service.ts')).toBe(false);
  });
});
