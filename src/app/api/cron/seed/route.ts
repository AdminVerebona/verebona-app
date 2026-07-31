/**
 * GET /api/cron/seed — amorçage des données de référence.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CETTE ROUTE EXISTE
 *
 * Les amorçages étaient tous des scripts `npm`, exécutables uniquement depuis
 * un poste ayant accès à la base. Or cet accès n'existe pas en préproduction —
 * l'ouverture réseau y est fermée, et c'est très bien ainsi.
 *
 * Chaque amorçage supposait donc : ouvrir l'accès Internet, copier l'URL,
 * y placer le mot de passe, lancer, refermer. À refaire à chaque rotation de
 * mot de passe. C'est ce qui a fait échouer les tentatives successives.
 *
 * Le serveur a déjà la connexion. Cette route l'emprunte, et rend les scripts
 * inutiles hors développement local.
 *
 * ── TOUS LES AMORÇAGES SONT IDEMPOTENTS ───────────────────────────────────
 *
 * Relancée, cette route ne crée aucun doublon et n'écrase aucune modification
 * faite depuis le back-office. Elle peut être appelée sans précaution.
 *
 * ── L'ORDRE COMPTE ────────────────────────────────────────────────────────
 *
 * Les CGVU d'abord : sans version publiée, la création de compte est refusée
 * par conception — on n'enregistre pas une acceptation rattachée à rien.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations, getMigrationFailures } from '@/db';

interface Amorcage {
  nom: string;
  description: string;
  executer: () => Promise<unknown>;
}

/**
 * Les amorçages, dans leur ordre de dépendance.
 *
 * Importés dynamiquement : un module d'amorçage qui échouerait au chargement
 * ne doit pas empêcher les autres de s'exécuter.
 */
const AMORCAGES: Amorcage[] = [
  // ── Gabarits d'email, EN PREMIER ────────────────────────────────────────
  //
  // `EMAIL_VERIFICATION` en fait partie. Sans lui, la création de compte
  // aboutit — l'utilisateur voit « Vérifiez votre boîte mail » — mais aucun
  // message n'est envoyé : le compte reste inactivable.
  //
  // Ces amorçages n'avaient aucune commande `npm` : rien ne les jouait, et
  // leur absence ne se manifestait qu'au premier envoi.
  {
    nom: 'email-settings',
    description: 'Paramètres d\'expédition',
    executer: async () => (await import('@/db/seeds/email_settings')).seedEmailSettings(),
  },
  {
    nom: 'email-base',
    description: 'Gabarits de base',
    executer: async () => (await import('@/db/seeds/email_templates')).seedBaseEmailTemplates(),
  },
  {
    nom: 'email-system',
    description: 'Gabarits système — dont EMAIL_VERIFICATION, indispensable à l\'inscription',
    executer: async () =>
      (await import('@/db/seeds/email_templates_system')).seedSystemEmailTemplates(),
  },
  {
    nom: 'email-trial',
    description: 'Gabarits du parcours d\'essai',
    executer: async () =>
      (await import('@/db/seeds/email_templates_trial')).seedTrialEmailTemplates(),
  },
  {
    nom: 'email-membership',
    description: 'Gabarits d\'invitation à un compte partagé',
    executer: async () =>
      (await import('@/db/seeds/account_membership_email_templates')).seedAccountMembershipEmailTemplates(),
  },

  // ── Données de référence ────────────────────────────────────────────────
  {
    nom: 'cgvu',
    description: 'Publie la version initiale des CGVU — débloque la création de compte',
    executer: async () => (await import('@/db/seeds/legal/seed-cgvu')).seedCgvuV1(),
  },
  {
    nom: 'cgvu-email',
    description: 'Gabarit de confirmation avec permalien',
    executer: async () =>
      (await import('@/db/seeds/legal/email_template_cgvu')).seedLegalEmailTemplate(),
  },
  {
    nom: 'withdrawal-email',
    description: 'Accusé de réception de rétractation',
    executer: async () =>
      (await import('@/db/seeds/withdrawal/email_template_withdrawal')).seedWithdrawalEmailTemplate(),
  },
  {
    nom: 'doc-categories',
    description: 'Référentiel documentaire : catégories, types, associations',
    executer: async () =>
      (await import('@/db/seeds/documents/seed-document-categories')).seedDocumentCategories(),
  },
];

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();

  // Un schéma incomplet produirait des amorçages partiels, plus difficiles à
  // diagnostiquer qu'un refus net.
  const echecs = getMigrationFailures();
  if (echecs.length > 0) {
    return NextResponse.json(
      {
        error: 'Schéma incomplet : amorçage refusé.',
        code: 'MIGRATIONS_FAILED',
        premiereCause: {
          fichier: echecs[0].filename,
          code: echecs[0].code,
          message: echecs[0].message?.slice(0, 200),
        },
        total: echecs.length,
      },
      { status: 409 },
    );
  }

  // Un amorçage donné, ou tous.
  const cible = req.nextUrl.searchParams.get('only');
  const aExecuter = cible ? AMORCAGES.filter((a) => a.nom === cible) : AMORCAGES;

  if (aExecuter.length === 0) {
    return NextResponse.json(
      { error: `Amorçage inconnu : ${cible}`, disponibles: AMORCAGES.map((a) => a.nom) },
      { status: 400 },
    );
  }

  const resultats: Array<{ nom: string; statut: string; detail?: unknown; erreur?: string }> = [];

  for (const a of aExecuter) {
    try {
      const detail = await a.executer();
      resultats.push({ nom: a.nom, statut: 'ok', detail });
    } catch (e) {
      // Un amorçage en échec n'interrompt pas les suivants : ils sont
      // indépendants, et voir l'ensemble vaut mieux qu'un premier échec seul.
      resultats.push({ nom: a.nom, statut: 'echec', erreur: (e as Error).message });
    }
  }

  const echoues = resultats.filter((r) => r.statut === 'echec');

  return NextResponse.json(
    { resultats, executes: resultats.length, echoues: echoues.length },
    { status: echoues.length > 0 ? 500 : 200 },
  );
}
