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
 * Utilisation :
 *   npx tsx scripts/ai-inventory.ts                 → déclaré seul (CI)
 *   npx tsx scripts/ai-inventory.ts --observed      → déclaré + observé
 *   npx tsx scripts/ai-inventory.ts --observed --window=90d
 *   npx tsx scripts/ai-inventory.ts --json
 */
import '@/lib/load-env';
import {
  listActiveUseCases, listOperationsByUseCase, listLlmOperations,
} from '@/services/ai/registry';
import {
  concludeExecutionInventory, knownOperationCodes,
  type InventoryVerdict,
} from '@/services/ai/registry/execution-inventory';
import { snapshotFlags } from '@/services/ai/flags/ai-feature-flags';

const asJson = process.argv.includes('--json');
const withObserved = process.argv.includes('--observed');

/** `--window=30d` | `--window=12h`. Défaut : 30 jours. */
function fenetreEnJours(): number {
  const arg = process.argv.find((a) => a.startsWith('--window='));
  if (!arg) return 30;
  const brut = arg.slice('--window='.length).trim();
  const m = /^(\d+)\s*([dhj])?$/i.exec(brut);
  if (!m) {
    console.error(`✖ Fenêtre illisible : « ${brut} ». Attendu : 30d, 90d, 12h.`);
    process.exit(2);
  }
  const n = Number(m[1]);
  const jours = (m[2] ?? 'd').toLowerCase() === 'h' ? n / 24 : n;
  if (!(jours > 0)) {
    console.error('✖ La fenêtre doit être strictement positive.');
    process.exit(2);
  }
  return jours;
}

// ── Section 1 : déclaré ──────────────────────────────────────────────────────

const useCases = listActiveUseCases();

const declare = {
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

// ── Section 2 : observé ──────────────────────────────────────────────────────

interface LigneObservee {
  operationType: string;
  useCaseCode: string | null;
  events: number;
  firstSeen: string;
  lastSeen: string;
  /** L'opération appartient-elle au référentiel embarqué ? */
  inRegistry: boolean;
}

interface Observe {
  windowDays: number;
  since: string;
  totalEvents: number;
  rows: LigneObservee[];
  /** Opérations hors référentiel : la preuve qu'un moteur historique a tourné. */
  foreignOperations: string[];
  useCasesSeen: string[];
  verdict: InventoryVerdict;
  reason: string;
}

async function observer(windowDays: number): Promise<Observe> {
  const { pgClient } = await import('@/db');

  // Fenêtre passée en paramètre, jamais interpolée : ce script tourne en
  // recette, sur des bases réelles.
  const rows = await pgClient.unsafe(
    `SELECT operation_type,
            use_case_code,
            COUNT(*)::int      AS events,
            MIN(created_at)    AS first_seen,
            MAX(created_at)    AS last_seen
       FROM ai_usage_event
      WHERE created_at >= NOW() - ($1 || ' days')::interval
      GROUP BY operation_type, use_case_code
      ORDER BY events DESC`,
    [String(windowDays)] as never[],
  );

  const connues = knownOperationCodes();

  const lignes: LigneObservee[] = (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    operationType: String(r.operation_type),
    useCaseCode: r.use_case_code == null ? null : String(r.use_case_code),
    events: Number(r.events),
    firstSeen: new Date(String(r.first_seen)).toISOString(),
    lastSeen: new Date(String(r.last_seen)).toISOString(),
    inRegistry: connues.has(String(r.operation_type)),
  }));

  // Le verdict vit dans `execution-inventory.ts`, hors du script : c'est lui
  // qui autorise ou refuse la bascule réglementaire, et il est testé à part.
  const conclusion = concludeExecutionInventory(lignes);

  return {
    windowDays,
    since: new Date(Date.now() - windowDays * 86_400_000).toISOString(),
    totalEvents: conclusion.totalEvents,
    rows: lignes,
    foreignOperations: conclusion.foreignOperations,
    useCasesSeen: conclusion.useCasesSeen,
    verdict: conclusion.verdict,
    reason: conclusion.reason,
  };
}

// ── Rapport ──────────────────────────────────────────────────────────────────

async function main() {
  let observe: Observe | null = null;

  if (withObserved) {
    try {
      observe = await observer(fenetreEnJours());
    } catch (e) {
      console.error(
        `✖ Section « observé » indisponible : ${(e as Error).message}\n` +
        '  Cette section demande un accès à la base (DATABASE_URL). Sans elle, ' +
        'seul le critère n°1 est contrôlé.',
      );
      process.exit(1);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    declare,
    observe,
    // Le verdict global n'est « conforme » que si les deux sections le sont.
    // Sans section observée, il ne porte que sur le déclaré — et le dit.
    compliant: declare.compliant && (observe === null || observe.verdict === 'conforme'),
    scope: observe === null ? 'declare' : 'declare+observe',
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
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

    if (observe) {
      console.log(`── Observé — ${observe.windowDays} jour(s), depuis ${observe.since.slice(0, 10)} ─────────────\n`);
      if (observe.rows.length === 0) {
        console.log('  (aucun appel enregistré)\n');
      } else {
        for (const l of observe.rows) {
          const marque = l.inRegistry ? ' ' : '✖';
          const usage = l.useCaseCode ?? '—';
          console.log(
            `  ${marque} ${l.operationType.padEnd(24)} ${usage.padEnd(22)} ` +
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
    } else {
      console.log('── Observé ───────────────────────────────────────────────────────\n');
      console.log('  Section non demandée. `--observed` interroge ai_usage_event et');
      console.log('  contrôle les critères n°2 et 3, que le déclaré ne peut pas couvrir.\n');
    }
  }

  if (!declare.compliant) {
    console.error(`✖ Déclaré non conforme : ${declare.activeUseCaseCount} usages au lieu de 5 (CDC §1.1).`);
    process.exit(1);
  }

  if (observe && observe.verdict === 'non_conforme') {
    console.error(`✖ Observé non conforme : ${observe.reason}`);
    process.exit(1);
  }

  if (observe && observe.verdict === 'indetermine') {
    console.error(`✖ Observé indéterminé : ${observe.reason}`);
    process.exit(1);
  }

  if (observe) {
    console.log(`✓ Conforme sur les deux sections — ${observe.reason}`);
  } else {
    console.log('✓ Déclaré conforme : exactement cinq usages IA. Section observée non contrôlée.');
  }
}

main().then(
  () => process.exit(0),
  (e) => { console.error('✖ Inventaire en échec :', (e as Error).message); process.exit(1); },
);
