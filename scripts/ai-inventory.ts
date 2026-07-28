/**
 * Inventaire d'exécution des usages IA — CDC §9.7 et §12, critère 1.
 *
 * « Un inventaire d'exécution recense exactement cinq usages IA actifs. »
 *
 * Ce script est la preuve technique attendue par l'outil externe de conformité :
 * il ne lit pas une documentation, il interroge le référentiel réellement
 * embarqué dans le code déployé.
 *
 * Utilisation : npx tsx scripts/ai-inventory.ts [--json]
 * Sortie 0 si et seulement si le décompte est exactement cinq.
 */
import {
  listActiveUseCases, listOperationsByUseCase, listLlmOperations,
} from '../src/services/ai/registry';
import { snapshotFlags } from '../src/services/ai/flags/ai-feature-flags';

const asJson = process.argv.includes('--json');
const useCases = listActiveUseCases();

const report = {
  generatedAt: new Date().toISOString(),
  activeUseCaseCount: useCases.length,
  expectedUseCaseCount: 5,
  compliant: useCases.length === 5,
  useCases: useCases.map((uc) => {
    const ops = listOperationsByUseCase(uc.code);
    return {
      code: uc.code,
      label: uc.label,
      purpose: uc.purpose,
      replacesLegacyUsages: uc.replacesLegacyUsages,
      operationCount: ops.length,
      llmOperationCount: ops.filter((o) => o.provider !== 'none' && o.active).length,
      operations: ops.map((o) => ({
        code: o.operationCode,
        label: o.label,
        deterministic: o.provider === 'none',
        model: o.provider === 'none' ? null : o.primaryModel,
        promptCode: o.promptCode ?? null,
        active: o.active,
      })),
    };
  }),
  totalLlmOperations: listLlmOperations().length,
  flags: snapshotFlags(),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('\n── Inventaire d\'exécution des usages IA ──────────────────────────\n');
  for (const uc of report.useCases) {
    console.log(`  ${uc.code}  —  ${uc.label}`);
    console.log(`     finalité      : ${uc.purpose}`);
    console.log(`     absorbe       : usages historiques ${uc.replacesLegacyUsages.join(', ')}`);
    console.log(`     opérations    : ${uc.operationCount} dont ${uc.llmOperationCount} avec appel modèle`);
    for (const op of uc.operations) {
      const kind = op.deterministic ? 'déterministe' : op.model;
      console.log(`       · ${op.code.padEnd(22)} ${kind}`);
    }
    console.log('');
  }
  console.log(`  Usages actifs : ${report.activeUseCaseCount} / ${report.expectedUseCaseCount}`);
  console.log(`  Bascule       : ${Object.entries(report.flags).map(([k, v]) => `${k}=${v}`).join('  ')}\n`);
}

if (!report.compliant) {
  console.error(`✖ Non conforme : ${report.activeUseCaseCount} usages actifs au lieu de 5 (CDC §1.1).`);
  process.exit(1);
}
console.log('✓ Conforme : exactement cinq usages IA actifs.');
