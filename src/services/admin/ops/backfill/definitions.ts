/**
 * Rattrapages de données pilotés depuis le BO « Exploitation » (lot 25,
 * chantier B) — catalogue PUR (aucun import serveur) : partagé par les routes
 * `/api/admin/ops/backfills` et par la page (`/admin/exploitation`).
 *
 * Ordre recommandé (celui de l'affichage) :
 *   1. fusion pièces → sous-structures (`npm run db:merge-rooms`) ;
 *   2. liens document ↔ bien (`scripts/backfill-document-asset-links.ts`) ;
 *   3. agenda (`scripts/agenda-backfill.ts`, `source-links` puis `dedupe`) ;
 *   4. rattrapage CDC 15 (`scripts/cdc15-backfill.ts --step all`).
 *
 * Chaque bloc n'offre que ce que le script permet (simulation, application,
 * restauration). Les scripts CLI restent utilisables et appellent les mêmes
 * services.
 */

export type BackfillScript = 'merge-rooms' | 'document-asset-links' | 'agenda' | 'cdc15';
export type BackfillAction = 'simulate' | 'apply' | 'restore';
export type BackfillStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';

export interface BackfillDefinition {
  script: BackfillScript;
  order: number;
  label: string;
  /** Équivalent en ligne de commande (référence pour l'exploitation). */
  command: string;
  description: string;
  actions: BackfillAction[];
  /** Étapes successives (agenda) ; chacune a ses propres actions. */
  steps?: Array<{ code: string; label: string; description: string }>;
  /** Filtre « compte » accepté (exécution limitée à un compte). */
  accountFilter: boolean;
  /** Avertissement affiché sur le bloc (ex. écriture directe). */
  warning?: string;
}

export const BACKFILL_DEFINITIONS: readonly BackfillDefinition[] = [
  {
    script: 'merge-rooms',
    order: 1,
    label: 'Fusion des pièces dans les sous-structures',
    command: 'npm run db:merge-rooms',
    description: 'Reprise des pièces (rooms) dans les sous-structures (décision D-G). La simulation écrit seulement son rapport ; '
      + 'l’application est journalisée ligne à ligne et restaurable par son identifiant d’exécution.',
    actions: ['simulate', 'apply', 'restore'],
    accountFilter: true,
  },
  {
    script: 'document-asset-links',
    order: 2,
    label: 'Liens document ↔ bien',
    command: 'npx tsx scripts/backfill-document-asset-links.ts',
    description: 'Rattrapage de la relation document ↔ bien (CDC 15 X-01) depuis les anciennes colonnes et propositions. '
      + 'Les cas ambigus vont au rapport, jamais tranchés.',
    actions: ['apply'],
    accountFilter: false,
    warning: 'Pas de simulation : ce rattrapage écrit directement. Il est idempotent — relancé, il ne crée aucun doublon.',
  },
  {
    script: 'agenda',
    order: 3,
    label: 'Agenda',
    command: 'npx tsx scripts/agenda-backfill.ts <source-links|dedupe> [--apply]',
    description: 'Rattrapages de l’agenda (CDC 15 §14 points 5 et 6), dans l’ordre : liens vers les documents sources, puis '
      + 'dédoublonnage des éléments automatiques. Aucun élément manuel ni modifié par l’utilisateur n’est touché.',
    actions: ['simulate', 'apply'],
    steps: [
      { code: 'source-links', label: '1. Liens sources', description: 'Liens document et traces de source des éléments d’agenda.' },
      { code: 'dedupe', label: '2. Dédoublonnage', description: 'Retrait des doublons automatiques (mêmes source, champ et date).' },
    ],
    accountFilter: false,
  },
  {
    script: 'cdc15',
    order: 4,
    label: 'Rattrapage CDC 15 (toutes étapes)',
    command: 'npx tsx scripts/cdc15-backfill.ts --step all',
    description: 'Étapes MIG-01, 03, 02, 04, 07, 08, 05, 06 dans cet ordre. La simulation écrit seulement son rapport ; '
      + 'l’application sauvegarde chaque valeur modifiée et se restaure par son identifiant d’exécution.',
    actions: ['simulate', 'apply', 'restore'],
    accountFilter: true,
  },
];

export const ACTION_LABELS: Record<BackfillAction, string> = {
  simulate: 'Simuler',
  apply: 'Appliquer',
  restore: 'Restaurer',
};

export const STATUS_LABELS: Record<BackfillStatus, string> = {
  running: 'En cours',
  succeeded: 'Terminé',
  failed: 'Échec',
  interrupted: 'Interrompu',
};

export const REASON_MIN = 5;
export const REASON_MAX = 500;

export function backfillDefinition(script: string): BackfillDefinition | null {
  return BACKFILL_DEFINITIONS.find((d) => d.script === script) ?? null;
}

/** Le motif est obligatoire pour toute écriture (application, restauration). */
export function reasonRequired(action: BackfillAction): boolean {
  return action !== 'simulate';
}

export interface BackfillRequest {
  script: BackfillScript;
  action: BackfillAction;
  step: string | null;
  /** Identifiant d'exécution du script à restaurer (`--restore <runId>`). */
  runId: string | null;
  accountId: number | null;
  reason: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validation d'une demande (pure). */
export function validateBackfillRequest(body: unknown): { ok: true; value: BackfillRequest } | { ok: false; code: string; message: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const def = backfillDefinition(String(b.script ?? ''));
  if (!def) return { ok: false, code: 'UNKNOWN_SCRIPT', message: 'Rattrapage inconnu.' };
  const action = String(b.action ?? '') as BackfillAction;
  if (!def.actions.includes(action)) {
    return { ok: false, code: 'ACTION_NOT_SUPPORTED', message: `« ${def.label} » ne permet pas l’action « ${action || '?'} ».` };
  }
  let step: string | null = null;
  if (def.steps) {
    step = String(b.step ?? '');
    if (!def.steps.some((s) => s.code === step)) return { ok: false, code: 'INVALID_STEP', message: 'Étape inconnue.' };
  }
  let runId: string | null = null;
  if (action === 'restore') {
    runId = String(b.runId ?? '').trim();
    if (!UUID.test(runId)) return { ok: false, code: 'INVALID_RUN_ID', message: 'Identifiant d’exécution à restaurer invalide.' };
  }
  let accountId: number | null = null;
  if (b.accountId !== undefined && b.accountId !== null && b.accountId !== '') {
    if (!def.accountFilter || action === 'restore') {
      return { ok: false, code: 'ACCOUNT_FILTER_NOT_SUPPORTED', message: 'Ce rattrapage ne se limite pas à un compte.' };
    }
    const n = Number(b.accountId);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, code: 'INVALID_ACCOUNT', message: 'Identifiant de compte invalide.' };
    accountId = n;
  }
  const brut = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (reasonRequired(action) && brut.length < REASON_MIN) {
    return { ok: false, code: 'REASON_REQUIRED', message: `Motif obligatoire (${REASON_MIN} caractères au moins).` };
  }
  if (brut.length > REASON_MAX) return { ok: false, code: 'REASON_TOO_LONG', message: `Motif limité à ${REASON_MAX} caractères.` };
  return { ok: true, value: { script: def.script, action, step, runId, accountId, reason: brut || null } };
}
