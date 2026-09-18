/**
 * Inventaire des usages IA — CDC §9.7 et §12, critères n°1, 2, 3 et 24.
 *
 * « Un inventaire d'exécution recense exactement cinq usages IA actifs »,
 * « les onze usages historiques ne sont plus directement exécutables »,
 * « sans regroupement artificiel ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI DEUX SECTIONS, ET POURQUOI AUCUNE NE SUFFIT SEULE
 *
 * DÉCLARÉ — ce que le code embarqué prétend exécuter, lu dans le référentiel.
 * C'est la preuve qu'aucun sixième usage n'a été introduit, et c'est ce que
 * contrôle la CI, sans base de données.
 *
 * Mais le déclaratif ne peut pas prouver l'exécution. Tant que les cinq
 * drapeaux valent `legacy`, il affiche « 5/5 conforme » alors que les onze
 * moteurs historiques tournent. Il répond au critère n°1 et reste muet sur les
 * critères n°2 et 3.
 *
 * OBSERVÉ — ce qui s'est réellement exécuté, lu dans `ai_usage_event`.
 *
 * Le piège, et la raison pour laquelle le verdict ne peut pas porter sur
 * `use_case_code` : `ai-usage-tracker.ts` estampille les écritures des moteurs
 * HISTORIQUES via `resolveLegacyUseCase()`. Elles remontent donc sous les cinq
 * codes cibles. Un `SELECT DISTINCT use_case_code` renverrait cinq usages et
 * conclurait à la conformité pendant que tout le chemin historique s'exécute —
 * exactement le « regroupement artificiel » que le critère n°24 interdit.
 *
 * Le discriminant est ailleurs : la gateway écrit un `operation_type` pris dans
 * le référentiel (catalogue fermé), tandis que le tracker historique écrit des
 * libellés libres (`operation_complete`…). Le verdict porte donc sur
 * l'appartenance des OPÉRATIONS observées au référentiel. Une seule valeur hors
 * catalogue prouve qu'un moteur historique a tourné.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * FENÊTRE D'OBSERVATION — 30 JOURS PAR DÉFAUT
 *
 * Le CDC ne fixe aucune durée. Trente jours est un choix, motivé ainsi :
 *
 *   · trop court, le silence se confond avec l'extinction. Sept jours ne
 *     suffisent pas à garantir qu'un moteur à faible cadence — enrichissement
 *     différé, campagne de corpus, compte peu actif — a eu l'occasion de se
 *     déclencher. Conclure « éteint » sur un moteur simplement non sollicité
 *     serait la pire erreur possible ici, puisqu'elle autorise la bascule
 *     réglementaire ;
 *   · trop long, une trace ancienne bloque une extinction pourtant acquise et
 *     rend la preuve impossible à produire avant des mois ;
 *   · trente jours recoupe la maille des tableaux de coûts existants, qui
 *     agrègent déjà au mois.
 *
 * Ajustable : `--window=90d`. La valeur retenue figure dans le rapport, parce
 * qu'un verdict sans sa fenêtre ne veut rien dire.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN INVENTAIRE SANS DONNÉES NE CONCLUT PAS
 *
 * Fenêtre vide ⇒ verdict « indéterminé », et code de sortie 1. C'est
 * délibéré : l'absence de preuve n'est pas une preuve d'absence, et un rapport
 * vide ne doit jamais pouvoir être présenté comme un rapport conforme.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE CALCUL EST PARTAGÉ AVEC LA ROUTE
 *
 * `inventory-report.ts` construit les deux sections ; ce script n'en fait que
 * la mise en forme et les codes de sortie. `/api/cron/ai/inventory` rend le
 * même rapport par HTTP, pour la recette qui n'a pas d'accès direct à la base.
 *
 * Un verdict qui dépendrait de la façon dont on l'a demandé ne prouverait rien.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Utilisation :
 *   npx tsx scripts/ai-inventory.ts                 → déclaré seul (CI)
 *   npx tsx scripts/ai-inventory.ts --observed      → déclaré + observé
 *   npx tsx scripts/ai-inventory.ts --observed --window=90d
 *   npx tsx scripts/ai-inventory.ts --json
 */
import '@/lib/load-env';
import {
  buildInventoryReport, parseWindow, DEFAULT_WINDOW_DAYS,
  type InventoryReport,
} from '@/services/ai/registry/inventory-report';

const asJson = process.argv.includes('--json');
const withObserved = process.argv.includes('--observed');

function fenetreEnJours(): number {
  const arg = process.argv.find((a) => a.startsWith('--window='));
  if (!arg) return DEFAULT_WINDOW_DAYS;
  const jours = parseWindow(arg.slice('--window='.length));
  if (jours === null) {
    console.error(`✖ Fenêtre illisible : « ${arg.slice('--window='.length)} ». Attendu : 30d, 90d, 12h.`);
    process.exit(2);
  }
  return jours;
}

function afficher(report: InventoryReport): void {
  const { declare, observe } = report;

  console.log('\n── Déclaré — référentiel embarqué ────────────────────────────────\n');
  for (const uc of declare.useCases) {
    console.log(`  ${uc.code}  —  ${uc.label}`);
    console.log(`     finalité      : ${uc.purpose}`);
    console.log(`     absorbe       : usages historiques ${uc.replacesLegacyUsages.join(', ')}`);
    console.log(`     opérations    : ${uc.operationCount} dont ${uc.llmOperationCount} avec appel modèle`);
    for (const op of uc.operations) {
      console.log(`       · ${op.code.padEnd(22)} ${op.deterministic ? 'déterministe' : op.model}`);
    }
    console.log('');
  }
  console.log(`  Usages déclarés : ${declare.activeUseCaseCount} / ${declare.expectedUseCaseCount}`);
  console.log(`  Bascule         : ${Object.entries(declare.flags).map(([k, v]) => `${k}=${v}`).join('  ')}\n`);

  if (!observe) {
    console.log('── Observé ───────────────────────────────────────────────────────\n');
    console.log('  Section non demandée. `--observed` interroge ai_usage_event et');
    console.log('  contrôle les critères n°2 et 3, que le déclaré ne peut pas couvrir.\n');
    return;
  }

  console.log(`── Observé — ${observe.windowDays} jour(s), depuis ${observe.since.slice(0, 10)} ─────────────\n`);
  if (observe.rows.length === 0) {
    console.log('  (aucun appel enregistré)\n');
  } else {
    for (const l of observe.rows) {
      console.log(
        `  ${l.inRegistry ? ' ' : '✖'} ${l.operationType.padEnd(24)} ${(l.useCaseCode ?? '—').padEnd(22)} ` +
        `${String(l.events).padStart(7)} appel(s)   dernier ${l.lastSeen.slice(0, 10)}`,
      );
    }
    console.log('');
  }
  console.log(`  Appels sur la fenêtre : ${observe.totalEvents}`);
  console.log(`  Usages observés       : ${observe.useCasesSeen.join(', ') || '—'}`);
  if (observe.foreignOperations.length > 0) {
    console.log(`  Hors référentiel      : ${observe.foreignOperations.join(', ')}`);
  }
  console.log('');
}

async function main() {
  let report: InventoryReport;
  try {
    report = await buildInventoryReport({
      observed: withObserved,
      windowDays: withObserved ? fenetreEnJours() : undefined,
    });
  } catch (e) {
    console.error(
      `✖ Section « observé » indisponible : ${(e as Error).message}\n` +
      '  Cette section demande un accès à la base (DATABASE_URL). Sans accès direct, ' +
      'appelez /api/cron/ai/inventory, qui rend le même rapport.',
    );
    process.exit(1);
  }

  if (asJson) console.log(JSON.stringify(report, null, 2));
  else afficher(report);

  if (!report.declare.compliant) {
    console.error(`✖ Déclaré non conforme : ${report.declare.activeUseCaseCount} usages au lieu de 5 (CDC §1.1).`);
    process.exit(1);
  }

  const observe = report.observe;
  if (observe && observe.verdict !== 'conforme') {
    console.error(`✖ Observé ${observe.verdict === 'non_conforme' ? 'non conforme' : 'indéterminé'} : ${observe.reason}`);
    process.exit(1);
  }

  if (observe) console.log(`✓ Conforme sur les deux sections — ${observe.reason}`);
  else console.log('✓ Déclaré conforme : exactement cinq usages IA. Section observée non contrôlée.');
}

main().then(
  () => process.exit(0),
  (e) => { console.error('✖ Inventaire en échec :', (e as Error).message); process.exit(1); },
);
