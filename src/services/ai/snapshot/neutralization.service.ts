/**
 * Exécution de la neutralisation — CDC BO IA SNP-005 à SNP-010.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ TROIS GARDES, ET AUCUNE N'EST FACULTATIVE
 *
 * Ce service applique des `UPDATE` et des `DELETE` sur des données réelles. Une
 * exécution au mauvais endroit détruirait les mots de passe, les adresses et
 * les rattachements de paiement de la PRODUCTION.
 *
 *   1. L'environnement doit être `preprod` ou `local`. Jamais `production`.
 *   2. Une variable d'armement explicite doit être posée. Une seule condition
 *      pourrait être franchie par erreur de configuration ; deux conditions
 *      indépendantes demandent deux erreurs simultanées.
 *   3. L'appelant doit fournir le nom exact de l'environnement qu'il croit
 *      viser. S'il se trompe, rien ne s'exécute — c'est la confirmation
 *      dactylographiée des opérations dangereuses, appliquée au serveur.
 *
 * Aucune de ces gardes ne protège d'une restauration faite au mauvais endroit :
 * elles protègent de l'exécution de CE code au mauvais endroit. La première
 * responsabilité reste celle de la chaîne d'exploitation.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CE SERVICE NE FAIT PAS
 *
 * Ni génération, ni copie, ni restauration, ni transfert S3. Le SNP-008 veut la
 * neutralisation appliquée avant que le snapshot ne quitte le périmètre de
 * production : dans ce cas, c'est la chaîne d'exploitation qui applique ce plan
 * à l'artefact, et non l'application.
 *
 * Ce service existe pour le cas où la neutralisation est appliquée après
 * restauration, dans un environnement de test isolé, avant ouverture. Il est
 * alors la dernière barrière — jamais la seule.
 */
import { pgClient } from '@/db';
import { getAiEnvironment } from '../config/environment';
import {
  NEUTRALIZATION_PLAN, testAccountEmails, affectedTables, neutralizationChecks,
  type NeutralizationStep, type NeutralizationCheck,
} from './neutralization-plan';

export class NeutralizationRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'NeutralizationRefused';
  }
}

export interface StepResult {
  id: string;
  label: string;
  rowsAffected: number;
  skipped: boolean;
  error?: string;
}

export interface CheckResult {
  id: string;
  label: string;
  /** Résidus trouvés ; 0 attendu. */
  residual: number;
  /** Table absente : rien à neutraliser, contrôle sans objet. */
  skipped: boolean;
  error?: string;
}

/** Contrôle anti-effets avant réouverture — SNP-010. */
export interface NeutralizationVerification {
  /** true seulement si TOUS les contrôles sont à 0 et aucun n'a échoué. */
  complete: boolean;
  checks: CheckResult[];
}

export interface NeutralizationReport {
  environment: string;
  startedAt: Date;
  finishedAt: Date;
  preservedAccounts: number;
  steps: StepResult[];
  /** Contrôle anti-effets rejoué après les étapes (SNP-010). */
  verification: NeutralizationVerification;
  /** Étapes sans erreur ET contrôle complet : seule condition de réouverture. */
  ok: boolean;
}

/**
 * Vérifie les trois gardes. Lève au premier manquement, sans rien exécuter.
 *
 * Séparée de l'exécution pour être appelable seule : l'écran doit pouvoir dire
 * pourquoi le bouton est indisponible, sans risquer de déclencher quoi que ce
 * soit pour le savoir.
 */
export function assertNeutralizationAllowed(confirmEnvironment: string): void {
  const environment = getAiEnvironment();

  if (environment === 'production') {
    throw new NeutralizationRefused(
      'PRODUCTION_FORBIDDEN',
      'La neutralisation ne s’exécute jamais en production : elle détruirait les mots de '
      + 'passe, les adresses et les rattachements de paiement réels.',
    );
  }

  if (process.env.ALLOW_SNAPSHOT_NEUTRALIZATION !== 'true') {
    throw new NeutralizationRefused(
      'NOT_ARMED',
      'ALLOW_SNAPSHOT_NEUTRALIZATION doit valoir « true » sur cet environnement. '
      + 'Cette variable est le second verrou : une seule condition pourrait être '
      + 'franchie par une erreur de configuration.',
    );
  }

  if (confirmEnvironment !== environment) {
    throw new NeutralizationRefused(
      'CONFIRMATION_MISMATCH',
      `Confirmation attendue : « ${environment} ». Reçu : « ${confirmEnvironment} ».`,
    );
  }
}

/**
 * Applique le plan, étape par étape.
 *
 * Une étape qui échoue n'interrompt pas les suivantes, et c'est délibéré :
 * s'arrêter à la première erreur laisserait une base à moitié neutralisée —
 * les mots de passe effacés mais les identifiants de paiement encore attachés,
 * par exemple. Mieux vaut appliquer tout ce qui peut l'être et rendre un rapport
 * qui dit exactement ce qui a échoué.
 *
 * Une table absente est ignorée plutôt que traitée en erreur : le schéma évolue,
 * et une étape qui vise une table supprimée n'est pas un incident.
 */
export async function runNeutralization(confirmEnvironment: string): Promise<NeutralizationReport> {
  assertNeutralizationAllowed(confirmEnvironment);

  const environment = getAiEnvironment();
  const preserved = testAccountEmails();
  const startedAt = new Date();
  const steps: StepResult[] = [];

  console.warn(
    `[snapshot] Neutralisation lancée sur « ${environment} ». `
    + `${preserved.length} compte(s) de test préservé(s). `
    + `Tables concernées : ${affectedTables().join(', ')}.`,
  );

  for (const step of NEUTRALIZATION_PLAN) {
    steps.push(await runStep(step, preserved));
  }

  // SNP-010 : une étape « sans erreur » ne prouve pas l'absence de résidu
  // (table recréée entre-temps, ligne ajoutée par un travail resté actif) :
  // l'état est relu, contrôle par contrôle.
  const verification = await verifyNeutralization(preserved);

  const report: NeutralizationReport = {
    environment,
    startedAt,
    finishedAt: new Date(),
    preservedAccounts: preserved.length,
    steps,
    verification,
    ok: steps.every((s) => !s.error) && verification.complete,
  };

  const total = steps.reduce((n, s) => n + s.rowsAffected, 0);
  console.warn(`[snapshot] Neutralisation terminée — ${total} ligne(s) modifiée(s) ou supprimée(s).`);

  return report;
}

async function runStep(step: NeutralizationStep, preserved: string[]): Promise<StepResult> {
  try {
    // Les adresses préservées passent en paramètre : interpolées, une apostrophe
    // suffirait à casser — ou détourner — une requête destructrice.
    // Paramètre transmis seulement si l'étape l'attend : un paramètre en trop
    // est refusé par le protocole étendu de Postgres (« bind message supplies
    // 1 parameters, but prepared statement requires 0 »).
    const rows = await pgClient.unsafe(`${step.sql} RETURNING 1`, paramsFor(step.sql, preserved));
    return {
      id: step.id,
      label: step.label,
      rowsAffected: (rows as unknown[]).length,
      skipped: false,
    };
  } catch (e) {
    const message = (e as Error).message ?? '';
    // Table absente : le schéma a évolué depuis l'écriture du plan. Ce n'est pas
    // un incident, et le signaler comme tel ferait croire à un échec.
    if (/relation .* does not exist/i.test(message)) {
      return { id: step.id, label: step.label, rowsAffected: 0, skipped: true };
    }
    return { id: step.id, label: step.label, rowsAffected: 0, skipped: false, error: message.slice(0, 300) };
  }
}

// ── Contrôle anti-effets avant réouverture — SNP-010 ─────────────────────────

/**
 * Relit l'état de la base, contrôle par contrôle. LECTURE SEULE : aucune
 * garde d'environnement n'est nécessaire, et l'écran comme la chaîne
 * d'exploitation peuvent l'appeler autant qu'il le faut.
 *
 * Fermé par défaut : un contrôle qui échoue (autre qu'une table absente)
 * rend la vérification incomplète — on ne rouvre pas sur un doute.
 */
export async function verifyNeutralization(
  preserved: string[] = testAccountEmails(),
): Promise<NeutralizationVerification> {
  const checks: CheckResult[] = [];
  for (const check of neutralizationChecks()) {
    checks.push(await runCheck(check, preserved));
  }
  return {
    complete: checks.every((c) => !c.error && c.residual === 0),
    checks,
  };
}

/**
 * Garde de réouverture (SNP-010) : lève `NEUTRALIZATION_INCOMPLETE` tant
 * qu'un contrôle n'est pas à 0. À appeler — ou à interroger par
 * `GET /api/admin/ai/snapshot?check=reopening` — avant de rendre la
 * préproduction à ses utilisateurs et de rallumer ses tâches planifiées.
 */
export async function assertReopeningAllowed(
  preserved: string[] = testAccountEmails(),
): Promise<NeutralizationVerification> {
  const verification = await verifyNeutralization(preserved);
  if (!verification.complete) {
    const residus = verification.checks
      .filter((c) => c.error || c.residual > 0)
      .map((c) => (c.error ? `${c.id} (contrôle en échec)` : `${c.id}=${c.residual}`))
      .join(', ');
    throw new NeutralizationRefused(
      'NEUTRALIZATION_INCOMPLETE',
      `Neutralisation incomplète, réouverture interdite : ${residus}.`,
    );
  }
  return verification;
}

async function runCheck(check: NeutralizationCheck, preserved: string[]): Promise<CheckResult> {
  try {
    const rows = await pgClient.unsafe(
      `SELECT (${check.sql})::int AS residual`,
      paramsFor(check.sql, preserved),
    ) as unknown as Array<{ residual: number | string }>;
    return { id: check.id, label: check.label, residual: Number(rows[0]?.residual ?? 0), skipped: false };
  } catch (e) {
    const message = (e as Error).message ?? '';
    if (/relation .* does not exist/i.test(message)) {
      return { id: check.id, label: check.label, residual: 0, skipped: true };
    }
    return { id: check.id, label: check.label, residual: 0, skipped: false, error: message.slice(0, 300) };
  }
}

/** `[$1]` pour une requête qui épargne les comptes de test, rien sinon. */
function paramsFor(sql: string, preserved: string[]): never[] {
  return (/\$1\b/.test(sql) ? [preserved] : []) as never[];
}
