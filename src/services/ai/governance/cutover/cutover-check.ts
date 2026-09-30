/**
 * Préconditions du RETRAIT des étapes historiques et du relais legacy —
 * CDC 15 §29 étape 15, §32 (« anciens prompts supprimés ou marqués
 * définitivement legacy »), D-02, D-17, HC-06.
 *
 * Calcul PUR : les entrées (architecture de la version ACTIVE, commutateurs,
 * drapeaux, corpus, appels observés) sont lues par le script
 * `check-master-cutover.ts`, en base si possible, sinon « à vérifier ».
 * Rien n'est supprimé : le résultat est la LISTE EXACTE de ce qui peut
 * l'être, opération par opération, avec ses fichiers.
 *
 * Une opération dépréciée est supprimable quand, pour son traitement :
 *   1. la version ACTIVE est en `master` ;
 *   2. le commutateur de déploiement du traitement vaut `enabled` ;
 *   3. le drapeau `AI_*` de l'usage vaut `enabled` (nouveau moteur, D-01) ;
 *   4. le corpus du master de la version ACTIVE est vert ;
 *   5. aucun appel à l'opération dans `ai_usage_event` sur N jours.
 * Son fichier de prompt ne l'est que si TOUTES les opérations qui le citent
 * le sont. Un fichier de prompt qu'aucune opération ne cite est orphelin.
 */
import type { AiOperationDefinition, OperationDeprecation } from '../../registry/operations';
import type { Treatment } from '../../config/treatments';

export type Check = 'ok' | 'bloquant' | 'à vérifier';

export interface Precondition { code: string; status: Check; detail: string }

export interface CutoverOperation {
  operationCode: string;
  treatment: Treatment;
  deprecation: OperationDeprecation;
  preconditions: Precondition[];
  removable: Check;
  /** Fichiers de prompt supprimables AVEC cette opération (chemins relatifs). */
  files: string[];
  /** Fichiers du code qui citent encore l'opération (à adapter avant retrait). */
  callers: string[];
}

export interface CutoverReport {
  mode: 'base' | 'statique';
  days: number;
  operations: CutoverOperation[];
  /** Opérations supprimables (liste exacte). */
  removableOperations: string[];
  /** Fichiers supprimables : prompts des opérations supprimables + orphelins. */
  removableFiles: string[];
  /** Fichiers de prompt qu'aucune opération ne cite ET qu'aucun fichier du dépôt ne référence. */
  orphanPromptFiles: string[];
  /** Orphelins encore référencés (historique, tests) : à vérifier avant retrait. */
  referencedOrphans: Array<{ path: string; references: string[] }>;
  ready: boolean;
}

export interface CutoverInputs {
  operations: AiOperationDefinition[];
  deprecationOf(op: AiOperationDefinition): OperationDeprecation | null;
  treatmentOf(op: AiOperationDefinition): Treatment;
  /** Architecture de la version ACTIVE par traitement ; null : base indisponible. */
  activeArchitecture: Partial<Record<Treatment, 'steps' | 'master'>> | null;
  /** Commutateur de déploiement exigé par traitement (nom → mode lu). */
  switches: Partial<Record<Treatment, { name: string; mode: string }>>;
  /** Drapeau AI_* de l'usage de l'opération. */
  flagOf(op: AiOperationDefinition): { name: string; mode: string };
  /** Corpus du master de la version ACTIVE ; null : non lu. */
  corpusGreen: Partial<Record<Treatment, boolean>> | null;
  /** Appels observés par opération sur la fenêtre ; null : non lu. */
  usage: Record<string, number> | null;
  days: number;
  /** Chemin (relatif) du fichier d'un promptCode, ou null. */
  promptFileOf(promptCode: string, op: AiOperationDefinition): string | null;
  /** Tous les fichiers de prompt du dépôt (relatifs), et leur code. */
  promptFiles: Array<{ promptCode: string; path: string }>;
  /** Appelants de l'opération dans le code. */
  callersOf(operationCode: string): string[];
  /** Fichiers du dépôt (tests compris) qui citent un promptCode. */
  referencesOf(promptCode: string): string[];
}

const pire = (xs: Check[]): Check => (xs.includes('bloquant') ? 'bloquant' : xs.includes('à vérifier') ? 'à vérifier' : 'ok');

export function computeCutover(i: CutoverInputs): CutoverReport {
  const ops: CutoverOperation[] = [];
  for (const op of i.operations) {
    const deprecation = i.deprecationOf(op);
    if (!deprecation) continue;
    const t = i.treatmentOf(op);
    const pre: Precondition[] = [];

    const arch = i.activeArchitecture ? i.activeArchitecture[t] ?? 'steps' : null;
    pre.push(arch === null
      ? { code: 'ACTIVE_MASTER', status: 'à vérifier', detail: `${t} : architecture de la version ACTIVE non lue (base indisponible).` }
      : arch === 'master'
        ? { code: 'ACTIVE_MASTER', status: 'ok', detail: `${t} en master sur la version ACTIVE.` }
        : { code: 'ACTIVE_MASTER', status: 'bloquant', detail: `${t} encore en steps sur la version ACTIVE.` });

    const sw = i.switches[t];
    if (sw) {
      pre.push(sw.mode === 'enabled'
        ? { code: 'SWITCH_ENABLED', status: 'ok', detail: `${sw.name}=enabled.` }
        : { code: 'SWITCH_ENABLED', status: 'bloquant', detail: `${sw.name}=${sw.mode} (enabled requis).` });
    }
    const flag = i.flagOf(op);
    pre.push(flag.mode === 'enabled'
      ? { code: 'AI_FLAG_ENABLED', status: 'ok', detail: `${flag.name}=enabled.` }
      : { code: 'AI_FLAG_ENABLED', status: 'bloquant', detail: `${flag.name}=${flag.mode} (nouveau moteur requis, D-01).` });

    const green = i.corpusGreen ? i.corpusGreen[t] : undefined;
    pre.push(i.corpusGreen === null || green === undefined
      ? { code: 'CORPUS_GREEN', status: i.corpusGreen === null ? 'à vérifier' : 'bloquant', detail: `${t} : corpus du master ${i.corpusGreen === null ? 'non lu' : 'absent'}.` }
      : green
        ? { code: 'CORPUS_GREEN', status: 'ok', detail: `${t} : corpus vert.` }
        : { code: 'CORPUS_GREEN', status: 'bloquant', detail: `${t} : corpus non vert.` });

    const calls = i.usage ? i.usage[op.operationCode] ?? 0 : null;
    pre.push(calls === null
      ? { code: 'NO_RECENT_CALLS', status: 'à vérifier', detail: `appels des ${i.days} derniers jours non lus.` }
      : calls === 0
        ? { code: 'NO_RECENT_CALLS', status: 'ok', detail: `aucun appel sur ${i.days} jours.` }
        : { code: 'NO_RECENT_CALLS', status: 'bloquant', detail: `${calls} appel(s) sur ${i.days} jours.` });

    ops.push({
      operationCode: op.operationCode, treatment: t, deprecation, preconditions: pre, removable: pire(pre.map((p) => p.status)),
      files: [], callers: i.callersOf(op.operationCode),
    });
  }

  // Fichiers : supprimables seulement si toutes les opérations qui citent le
  // promptCode sont elles-mêmes supprimables.
  const statut = new Map(ops.map((o) => [o.operationCode, o.removable]));
  const parCode = new Map<string, AiOperationDefinition[]>();
  for (const op of i.operations) {
    for (const code of [op.promptCode, op.masterPromptCode].filter((x): x is string => Boolean(x))) {
      parCode.set(code, [...(parCode.get(code) ?? []), op]);
    }
  }
  for (const o of ops) {
    const op = i.operations.find((x) => x.operationCode === o.operationCode)!;
    if (!op.promptCode) continue;
    const users = parCode.get(op.promptCode) ?? [];
    const tous = pire(users.map((u) => statut.get(u.operationCode) ?? 'bloquant'));
    const path = i.promptFileOf(op.promptCode, op);
    if (path && tous === o.removable) o.files.push(path);
  }

  const cites = new Set(parCode.keys());
  const orphelins = i.promptFiles.filter((f) => !cites.has(f.promptCode));
  const referencedOrphans = orphelins
    .map((f) => ({ path: f.path, references: i.referencesOf(f.promptCode) }))
    .filter((f) => f.references.length > 0);
  const orphanPromptFiles = orphelins.map((f) => f.path).filter((p) => !referencedOrphans.some((r) => r.path === p)).sort();
  const removableOperations = ops.filter((o) => o.removable === 'ok').map((o) => o.operationCode);
  const removableFiles = [...new Set([...ops.filter((o) => o.removable === 'ok').flatMap((o) => o.files), ...orphanPromptFiles])].sort();
  return {
    mode: i.activeArchitecture === null ? 'statique' : 'base',
    days: i.days,
    operations: ops,
    removableOperations,
    removableFiles,
    orphanPromptFiles,
    referencedOrphans,
    ready: ops.length > 0 && ops.every((o) => o.removable === 'ok'),
  };
}
