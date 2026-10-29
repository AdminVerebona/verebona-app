/**
 * Lot 99B — déclencheurs de la mise en conformité automatique des prompts :
 *
 *   · démarrage / déploiement et passage périodique : tâche planifiée
 *     `ai-prompt-conformity` (scheduled-tasks.catalog) ;
 *   · toute activation ou modification de configuration IA (prompt maître
 *     activé ou réactivé, version de configuration enregistrée, activée,
 *     importée) : `notifyConfigurationChanged`, appelé après validation de
 *     la transaction. Passage DIFFÉRÉ (rafales regroupées), un seul à la fois
 *     par instance ; le bail partagé `ai-prompt-conformity:<env>` évite deux
 *     passages simultanés entre instances. Ne lève jamais.
 *
 * Tests (NODE_ENV=test) : aucun passage en tâche de fond — les tests
 * appellent `runPromptConformityPass` explicitement.
 */
const DEBOUNCE_MS = 30_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: string[] = [];
let running: Promise<unknown> | null = null;

export function notifyConfigurationChanged(reason: string): void {
  if (process.env.NODE_ENV === 'test' && process.env.AI_PROMPT_CONFORMITY_TEST_TRIGGERS !== '1') return;
  pending.push(reason.slice(0, 80));
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const raisons = [...new Set(pending)].slice(0, 5).join(', ');
    pending = [];
    if (running) { pending.push(raisons); return; }
    running = import('./service')
      .then(({ runPromptConformityPass }) => runPromptConformityPass({ trigger: `config_change:${raisons}`.slice(0, 120) }))
      .catch((e) => console.error('[prompt-conformity] passage après changement de configuration :', (e as Error).message))
      .finally(() => { running = null; });
  }, DEBOUNCE_MS);
  timer.unref?.();
}
