/**
 * Exécution du corpus contre le moteur d'analyse — CDC §11.1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE MOTEUR EST INJECTÉ, PAS IMPORTÉ
 *
 * Ce harnais ne connaît aucun moteur. Il reçoit une fonction `runner` qui
 * prend le contenu d'un document et rend un résultat observé.
 *
 * Cette indirection est ce qui rend la mesure possible. Avant une bascule, la
 * seule question utile est comparative : « le nouveau moteur fait-il mieux ou
 * moins bien que l'ancien ? ». Y répondre suppose d'exécuter le MÊME corpus
 * contre DEUX moteurs, dans les mêmes conditions. Un harnais qui importerait
 * directement l'un des deux ne le permettrait pas.
 *
 * Elle permet aussi d'exécuter le harnais sans clé d'API : un runner de
 * démonstration suffit à vérifier la chaîne de bout en bout avant de dépenser
 * le moindre appel modèle.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { listCorpusCases, type CorpusCase } from './corpus-registry';
import {
  compareCase,
  summarize,
  detectRegressions,
  type CaseComparison,
  type CorpusSummary,
  type ObservedResult,
} from './corpus-comparator';

const FIXTURES_DIR = 'src/services/ai/governance/corpus/fixtures';

/** Un moteur d'analyse, réduit à ce dont le harnais a besoin. */
export type CorpusRunner = (input: {
  corpusCase: CorpusCase;
  /** Contenu brut du document. */
  content: string;
}) => Promise<ObservedResult>;

export interface CorpusRun {
  label: string;
  startedAt: string;
  results: CaseComparison[];
  summary: CorpusSummary;
  /** Cas dont l'exécution a échoué — distincts des cas non conformes. */
  errors: Array<{ caseId: string; message: string }>;
}

export function readFixture(corpusCase: CorpusCase): string {
  return readFileSync(join(process.cwd(), FIXTURES_DIR, corpusCase.fixturePath), 'utf-8');
}

/**
 * Exécute le corpus.
 *
 * Un cas qui lève n'interrompt pas la campagne : il est consigné et la mesure
 * continue. Interrompre au premier incident donnerait une vision partielle —
 * et c'est justement quand un moteur va mal qu'on a besoin de voir l'ensemble.
 */
export async function runCorpus(
  runner: CorpusRunner,
  options: { label: string; categories?: string[]; concurrency?: number } = { label: 'run' },
): Promise<CorpusRun> {
  const cases = listCorpusCases().filter(
    (c) => !options.categories?.length || options.categories.includes(c.category),
  );

  const results: CaseComparison[] = [];
  const errors: Array<{ caseId: string; message: string }> = [];

  // Séquentiel par défaut : les fournisseurs de modèles limitent le débit, et
  // une campagne de vingt-huit documents n'a pas besoin d'être rapide — elle a
  // besoin d'être complète et reproductible.
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const queue = [...cases];

  async function worker() {
    while (queue.length > 0) {
      const corpusCase = queue.shift();
      if (!corpusCase) return;
      try {
        const observed = await runner({ corpusCase, content: readFixture(corpusCase) });
        results.push(compareCase(corpusCase, observed));
      } catch (e) {
        errors.push({ caseId: corpusCase.caseId, message: (e as Error).message });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  // Ordre stable, indépendant de l'ordre d'achèvement : deux campagnes doivent
  // produire des rapports comparables ligne à ligne.
  results.sort((a, b) => a.caseId.localeCompare(b.caseId));

  return {
    label: options.label,
    startedAt: new Date().toISOString(),
    results,
    summary: summarize(results),
    errors,
  };
}

/* ── Rapport ──────────────────────────────────────────────────────────── */

function pct(part: number, total: number): string {
  return total === 0 ? '—' : `${Math.round((part / total) * 100)} %`;
}

function euros(micros: number): string {
  // Les coûts sont en micro-dollars ; à cette échelle, le centime est le grain
  // utile — afficher six décimales rendrait le rapport illisible.
  return `${(micros / 1_000_000).toFixed(4)} $`;
}

/** Rapport lisible d'une campagne. */
export function formatReport(run: CorpusRun): string {
  const s = run.summary;
  const lines: string[] = [];

  lines.push(`\n═══ Corpus de référence — ${run.label} ═══\n`);
  lines.push(`  Cas exécutés        ${s.total}`);
  lines.push(`  Conformes           ${s.passed} (${pct(s.passed, s.total)})`);
  lines.push(`  Champs corrects     ${s.fieldsCorrect}/${s.fieldsCompared} (${pct(s.fieldsCorrect, s.fieldsCompared)})`);
  lines.push(`  Type erroné         ${s.typeErrors}`);
  lines.push(`  Schéma invalide     ${s.schemaFailures}`);
  lines.push(`  Fuites entre biens  ${s.leaks}`);
  lines.push(`  Repli fournisseur   ${s.fallbacks}`);
  lines.push(`  Coût total          ${euros(s.totalCostMicros)}`);
  lines.push(`  Durée moyenne       ${s.avgDurationMs} ms`);

  if (run.errors.length > 0) {
    lines.push(`\n  ⚠ ${run.errors.length} cas en erreur d'exécution :`);
    for (const e of run.errors) lines.push(`      ${e.caseId} — ${e.message}`);
  }

  lines.push('\n  Par famille');
  for (const c of [...s.byCategory].sort((a, b) => a.category.localeCompare(b.category))) {
    const mark = c.passed === c.total ? '✓' : c.passed === 0 ? '✗' : '~';
    lines.push(`    ${mark} ${c.category.padEnd(32)} ${c.passed}/${c.total}`);
  }

  const failed = run.results.filter((r) => !r.expectedMatch);
  if (failed.length > 0) {
    lines.push('\n  Cas non conformes');
    for (const r of failed) {
      lines.push(`    · ${r.caseId}`);
      if (!r.documentTypeCorrect) lines.push('        type documentaire incorrect');
      if (r.crossAssetLeak) {
        // Signalé en premier et nommément : c'est la faute la plus grave, une
        // information d'un bien retrouvée sur un autre.
        lines.push(`        ⚠ FUITE vers ${r.leakedAssets.join(', ')}`);
      }
      if (r.missedAssets.length > 0) {
        lines.push(`        bien(s) non rattaché(s) : ${r.missedAssets.join(', ')}`);
      }
      for (const f of r.fields.filter((x) => x.verdict !== 'match')) {
        const label = f.verdict === 'unexpected' ? 'INVENTÉ' : f.verdict === 'missing' ? 'absent' : 'différent';
        lines.push(`        ${f.field} — ${label} (attendu ${JSON.stringify(f.expected)}, observé ${JSON.stringify(f.observed)})`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

/** Rapport comparatif entre deux campagnes — la seule mesure qui décide. */
export function formatComparison(before: CorpusRun, after: CorpusRun): string {
  const regressions = detectRegressions(before.results, after.results);
  const lost = regressions.filter((r) => r.kind === 'lost');
  const gained = regressions.filter((r) => r.kind === 'gained');
  const newLeaks = regressions.filter((r) => r.kind === 'new_leak');
  const fixedLeaks = regressions.filter((r) => r.kind === 'leak_fixed');

  const lines: string[] = [];
  lines.push(`\n═══ Comparaison — ${before.label} → ${after.label} ═══\n`);

  const delta = (a: number, b: number) => {
    const d = b - a;
    return `${a} → ${b} (${d >= 0 ? '+' : ''}${d})`;
  };

  lines.push(`  Cas conformes       ${delta(before.summary.passed, after.summary.passed)}`);
  lines.push(`  Champs corrects     ${delta(before.summary.fieldsCorrect, after.summary.fieldsCorrect)}`);
  lines.push(`  Fuites entre biens  ${delta(before.summary.leaks, after.summary.leaks)}`);
  lines.push(`  Coût total          ${euros(before.summary.totalCostMicros)} → ${euros(after.summary.totalCostMicros)}`);
  lines.push(`  Durée moyenne       ${before.summary.avgDurationMs} ms → ${after.summary.avgDurationMs} ms`);

  if (newLeaks.length > 0) {
    lines.push(`\n  ⚠ ${newLeaks.length} FUITE(S) APPARUE(S) — bloquant`);
    for (const r of newLeaks) lines.push(`      ${r.caseId} — ${r.detail}`);
  }
  if (lost.length > 0) {
    lines.push(`\n  ⚠ ${lost.length} régression(s)`);
    for (const r of lost) lines.push(`      ${r.caseId} — ${r.detail}`);
  }
  if (gained.length > 0) {
    lines.push(`\n  ✓ ${gained.length} amélioration(s)`);
    for (const r of gained) lines.push(`      ${r.caseId}`);
  }
  if (fixedLeaks.length > 0) {
    lines.push(`\n  ✓ ${fixedLeaks.length} fuite(s) corrigée(s)`);
  }
  if (regressions.length === 0) {
    lines.push('\n  Aucun écart entre les deux campagnes.');
  }

  return lines.join('\n') + '\n';
}

/**
 * Verdict de bascule.
 *
 * Une fuite apparue est bloquante à elle seule : le §4.4 et la question métier
 * n° 6 en font l'erreur à ne pas commettre, parce qu'elle est invisible pour
 * l'utilisateur — il découvre une information fausse sur un bien sans pouvoir
 * en deviner l'origine.
 */
export function isSafeToSwitch(before: CorpusRun, after: CorpusRun): {
  safe: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  // ══════════════════════════════════════════════════════════════════════
  // UNE COMPARAISON N'A DE SENS QU'ENTRE DEUX MESURES RÉELLES
  //
  // Ce verdict a rendu `safe: true` en comparant une vérification à blanc à
  // une référence de zéro cas. Aucune régression n'était détectable — il n'y
  // avait rien à comparer — et le silence a été lu comme une approbation.
  //
  // C'est l'inverse de ce qu'on attend : en l'absence de mesure, la réponse
  // doit être « on ne sait pas », jamais « c'est sûr ».
  // ══════════════════════════════════════════════════════════════════════
  if (before.summary.total === 0) {
    return {
      safe: false,
      reasons: [
        'La référence ne contient aucun cas mesuré : rien à comparer. ' +
        'Relancer la campagne de référence avant de conclure.',
      ],
    };
  }

  if (after.summary.total === 0) {
    return {
      safe: false,
      reasons: ['La campagne courante n’a mesuré aucun cas.'],
    };
  }

  // Une simulation ne mesure pas le moteur : elle compare les résultats
  // attendus à eux-mêmes, et rend toujours cent pour cent.
  if (before.label.includes('à blanc') || after.label.includes('à blanc')) {
    return {
      safe: false,
      reasons: [
        'L’une des campagnes est une vérification à blanc, sans appel modèle. ' +
        'Comparer une simulation à une mesure ne dit rien du moteur.',
      ],
    };
  }

  const regressions = detectRegressions(before.results, after.results);

  const newLeaks = regressions.filter((r) => r.kind === 'new_leak');
  if (newLeaks.length > 0) {
    reasons.push(`${newLeaks.length} fuite(s) d'information entre biens apparue(s).`);
  }

  const lost = regressions.filter((r) => r.kind === 'lost');
  if (lost.length > 0) {
    reasons.push(`${lost.length} cas conforme(s) devenu(s) non conforme(s).`);
  }

  if (after.summary.schemaFailures > before.summary.schemaFailures) {
    reasons.push('Le nouveau moteur produit davantage de sorties hors schéma.');
  }

  if (after.errors.length > 0) {
    reasons.push(`${after.errors.length} cas n'ont pas pu être exécutés.`);
  }

  return { safe: reasons.length === 0, reasons };
}
