/**
 * BO-IA-PROMPTS-01 — le corpus n'est plus une condition de mise en
 * production, mais reste exécutable (BO, CLI, CI).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { MASTER_CORPUS_DIRS, loadMasterCorpusCases, readMasterFileFromRepo } from '../cases';

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('corpus facultatif', () => {
  it('AC04 — aucune activation ne consulte la garde du corpus (versions de configuration, prompts maîtres)', () => {
    expect(src('src/services/ai/config/config-version.service.ts')).not.toMatch(/activation-guard|checkMasterActivation|MASTER_CORPUS_NOT_GREEN|ROLLBACK_JUSTIFICATION/);
    expect(src('src/services/ai/master-prompts/master-prompt.service.ts')).not.toMatch(/activation-guard|latestCorpusRun|fingerprint/);
    expect(existsSync(join(process.cwd(), 'src/services/ai/config/rollback-override.audit.ts'))).toBe(false);
  });

  it('AC04 — `ai:corpus --check-fingerprints` ne lit que les fichiers du dépôt : une activation BO ne peut pas faire échouer la CI', () => {
    const fp = src('src/services/ai/governance/master-corpus/fingerprints.ts');
    expect(fp).not.toMatch(/@\/db|master-prompts|pgClient/);
  });

  it('AC12 — corpus chargeable aussi depuis le serveur Next (répertoires résolus sur le dépôt)', () => {
    for (const d of MASTER_CORPUS_DIRS.slice(0, 4)) expect(existsSync(d), d).toBe(true);
    const cas = loadMasterCorpusCases(readMasterFileFromRepo);
    expect(new Set(cas.map((c) => c.masterPromptCode))).toEqual(new Set(['t1_master_v1', 't2_master_v1', 't3_master_v1', 't4_master_v1', 't5_master_v1', 't6_master_v1']));
  });
});
