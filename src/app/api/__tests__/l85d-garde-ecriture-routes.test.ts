/**
 * Lot 85D — garde d'écriture des routes API : audit statique EXHAUSTIF.
 *
 *   L85D-S01  toute méthode d'écriture (POST, PUT, PATCH, DELETE) d'une route
 *             utilisateur applique la garde de lecture seule — sinon elle
 *             figure dans la liste d'exceptions MOTIVÉES ci-dessous
 *   L85D-S02  la liste d'exceptions ne contient que des routes qui existent
 *             (pas d'exception morte qui masquerait une future route)
 *   L85D-S03  chaque garde reconnue par l'audit refuse bien `canWrite = false`
 *   L85D-S04  constat 84B corrigé à la source : `DELETE /api/agenda/:id` et
 *             `PATCH /api/agenda/:id/statut` réutilisent `refuserSiLectureSeule`
 *   L85D-S05  l'audit lui-même détecte une route non gardée (témoin)
 *
 * Opérations « indispensables » (décision 82A, C-Q10 ; `processing-
 * eligibility.ts`) : sécurité, facturation, e-mails légaux, rétractation,
 * suppression de compte, export de données, réactivation, purges — jamais
 * bloquées par la lecture seule. Le reste de ce qui écrit pour l'utilisateur
 * est refusé (403, message de `restrictedRefusal`).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { analyzeRouteFile, auditWriteRoutes, RECOGNIZED_GUARDS, stripComments, WRITE_METHODS } from './write-guard-audit';

/**
 * Exceptions MOTIVÉES. Clé : préfixe de dossier (`billing/`), route entière
 * (`users/me/route.ts`) ou route + méthode (`users/me/route.ts DELETE`).
 * Toute nouvelle route d'écriture utilisateur doit appliquer la garde ; une
 * entrée ici est une décision, pas un oubli.
 */
const WRITE_GUARD_EXCEPTIONS: Readonly<Record<string, string>> = {
  // ── Hors périmètre utilisateur ─────────────────────────────────────────
  'admin/': 'Back-office : route réservée aux administrateurs (SessionService.requireAdmin), pas un compte client.',
  'cron/': 'Tâches internes (CRON_SECRET), jamais appelées par un compte.',
  'webhooks/': 'Fournisseurs externes (Resend), signés, sans session.',
  'public/': 'Aide publique (retour sur un article), sans compte.',
  'contact/route.ts': 'Contact du support : doit rester possible, en particulier pour un compte restreint.',
  'transmission/[token]/route.ts': 'Destinataire d’une transmission, sans compte (jeton).',
  // ── Sécurité, session ───────────────────────────────────────────────────
  'auth/': 'Sécurité et session (connexion, déconnexion, renouvellement, mot de passe, changement d’espace) : indispensable (82A).',
  'users/me/change-password/route.ts': 'Sécurité : indispensable (82A).',
  'users/route.ts': 'Inscription (aucun compte encore).',
  // ── Facturation, rétractation, réactivation ─────────────────────────────
  'billing/': 'Facturation (souscription, régularisation d’un impayé, changement d’offre) : c’est la sortie de la lecture seule (82A).',
  'withdrawal/': 'Rétractation : indispensable (82A).',
  'accounts/personal/route.ts': 'Réactivation : « Créer mon espace » pour une identité sans espace (lot 72D) — opération de compte.',
  // ── Compte, membres, RGPD ───────────────────────────────────────────────
  'users/me/route.ts': 'Compte : profil (PUT) et suppression différée du compte (DELETE) — indispensables (82A).',
  'users/me/deletion/route.ts': 'Suppression de compte et son annulation : indispensables (82A).',
  'users/me/gdpr-export/route.ts': 'Export RGPD : indispensable (82A).',
  'legal/acceptances/route.ts': 'Acceptation des conditions (obligation légale) : indispensable.',
  'accounts/[accountId]/route.ts': 'Compte : nom de l’espace (gestion du compte).',
  'accounts/[accountId]/leave/route.ts': 'Compte : quitter un espace partagé — doit rester possible en mode restreint (récupération Duo, AID-TRANSFER-007).',
  'accounts/[accountId]/members/[membershipId]/route.ts': 'Compte : retirer un membre — doit rester possible en mode restreint.',
  'accounts/[accountId]/transfer-ownership/route.ts': 'Compte : transfert de la titularité (gestion du compte).',
  'accounts/[accountId]/members/invite/route.ts': 'Compte : invitation d’un membre (gestion du compte, décision « compte » 85D) — à confirmer par le PO pour un compte restreint (point ouvert 85D).',
  'duo/': 'Compte Duo : invitation, refus, adhésion, départ, retrait d’un membre (gestion du compte ; départ et refus indispensables en récupération) — invitation en mode restreint : point ouvert 85D.',
  'duos/[id]/leave/route.ts': 'Route retirée (410, lot 72D).',
  // ── Préférences, notifications, appareils, télémétrie ───────────────────
  'notification-preferences/': 'Préférences de communication et consentement (RGPD) : indispensables.',
  'notifications/route.ts': 'État de lecture des notifications (dont alertes de facturation) : aucune donnée du patrimoine.',
  'push/': 'Appareil du compte : reçoit les notifications indispensables (paiement, sécurité).',
  'users/me/upload-notice/route.ts': 'Préférence d’affichage (bandeau d’information masqué).',
  'home/mascot/reminders/route.ts': 'Préférence PERSONNELLE de rappel (aucune donnée métier modifiée, lot 60).',
  'home/mascot/check/route.ts': 'Lecture (revalidation d’une cible) : POST sans écriture.',
  'home/mascot/events/route.ts': 'Télémétrie produit.',
  'home/mascot/pregenerate/route.ts': 'Demande de préparation en arrière-plan : l’éligibilité 82A (processingEligibleSql) est appliquée à la mise en file et au traitement.',
  'analytics/track/route.ts': 'Télémétrie produit.',
  'verebona/usage-events/route.ts': 'Télémétrie de l’assistant.',
  'verebona/messages/[messageId]/feedback/route.ts': 'Avis sur une réponse de l’assistant (télémétrie).',
  'documents/[id]/notify-analyzed/route.ts': 'Notification « analyse terminée » : non indispensable, déjà filtrée pour un compte en lecture seule par le service de notifications (event-service, 82A).',
  'documents/upload-notification/route.ts': 'Notification « Documents ajoutés » après un dépôt (lui-même gardé) : filtrée par le service de notifications (82A).',
  // ── Assistant ───────────────────────────────────────────────────────────
  'verebona/commands/[planId]/confirm/route.ts': 'Garde dans le service : `confirmCommandPlan` vérifie les droits d’écriture à l’instant de la confirmation.',
  'verebona/commands/[planId]/undo/route.ts': 'Garde dans le service : l’annulation vérifie les droits d’écriture (undo.service).',
  'verebona/commands/[planId]/cancel/route.ts': 'Abandon d’une proposition : aucune écriture métier.',
  'verebona/conversations/route.ts': 'Nouveau fil de conversation vide (l’envoi d’un message, lui, est gardé : refuserSiPasDIA).',
  'verebona/conversation/route.ts': 'Effacement de son propre historique de conversation (confidentialité).',
  'verebona/requests/[requestId]/route.ts': 'Annulation d’une demande en cours : aucune écriture métier.',
  // ── Export, transmission, récupération (AID-BILL-004 : « consultables, exportables, transmissibles ») ──
  'assets/[id]/exports/': 'Export de données (préparation, génération, relance, suppression d’un export, résolutions du dossier CIL propres à l’export) : indispensable (82A).',
  'export-generations/': 'Export de données : suppression d’un fichier d’export.',
  'assets/[id]/transmission/': 'Transmission d’un bien : reste permise en mode restreint (AID-BILL-004).',
  'assets/[id]/move-to-space/route.ts': 'Récupération Duo (AID-TRANSFER-007) : la garde porte sur le compte CIBLE, dans le service (asset-space-move, `canWrite`).',
  'referral/': 'Parrainage : relève du compte et de la facturation, aucune donnée du patrimoine.',
  'deadlines/[id]/calendar-additions/route.ts': 'Trace personnelle d’un ajout à un agenda externe (export ICS) : aucune donnée du patrimoine.',
  'echeances/[id]/calendar-additions/route.ts': 'Trace personnelle d’un ajout à un agenda externe (export ICS) : aucune donnée du patrimoine.',
  // ── Routes inertes ──────────────────────────────────────────────────────
  'documents/route.ts DELETE': 'Répond 405 (méthode non prise en charge) : aucune écriture.',
  'assets/[id]/delete-request/route.ts': 'Route retirée (410, lot 72D).',
  'assets/[id]/move-request/route.ts': 'Route retirée (410, lot 72D).',
  'delete-requests/[id]/respond/route.ts': 'Route retirée (410, lot 72D).',
  'move-requests/[id]/respond/route.ts': 'Route retirée (410, lot 72D).',
};

function exceptionFor(route: string, method: string): string | null {
  for (const [key, motif] of Object.entries(WRITE_GUARD_EXCEPTIONS)) {
    if (key.endsWith('/') ? route.startsWith(key) : key === route || key === `${route} ${method}`) return motif;
  }
  return null;
}

describe('L85D-S01 — toute route d’écriture utilisateur applique la garde de lecture seule', () => {
  const handlers = auditWriteRoutes();

  it('l’audit couvre bien l’API (des centaines de méthodes d’écriture)', () => {
    expect(handlers.length).toBeGreaterThan(150);
  });

  it('aucune méthode d’écriture sans garde ni exception motivée', () => {
    const fautives = handlers
      .filter((h) => !h.guarded && !exceptionFor(h.route, h.method))
      .map((h) => `${h.method} /api/${h.route.replace(/\/route\.ts$/, '')}`);
    // Une route listée ici écrit pour l'utilisateur sans vérifier que le
    // compte peut écrire : ajouter `refuserSiLectureSeule(accountId)` (ou
    // `refuserSiPasDIA` pour un traitement IA) — ou, si l'opération est
    // indispensable, une exception MOTIVÉE dans WRITE_GUARD_EXCEPTIONS.
    expect(fautives).toEqual([]);
  });

  it('chaque motif d’exception est rédigé (pas de chaîne vide)', () => {
    for (const [k, v] of Object.entries(WRITE_GUARD_EXCEPTIONS)) expect(v.trim().length, k).toBeGreaterThan(10);
  });
});

describe('L85D-S02 — aucune exception morte', () => {
  it('chaque exception désigne au moins une méthode d’écriture existante', () => {
    const handlers = auditWriteRoutes();
    const mortes = Object.keys(WRITE_GUARD_EXCEPTIONS).filter((key) => !handlers.some((h) =>
      key.endsWith('/') ? h.route.startsWith(key) : key === h.route || key === `${h.route} ${h.method}`));
    expect(mortes).toEqual([]);
  });

  it('une exception ne couvre jamais une route déjà gardée par erreur de préfixe (routes gardées hors exception)', () => {
    // Témoin : les routes Agenda et documents sont gardées, aucune exception ne les vise.
    for (const r of ['agenda/[id]/route.ts', 'agenda/[id]/statut/route.ts', 'documents/[id]/agenda-liens/route.ts', 'web-links/route.ts']) {
      expect(exceptionFor(r, 'POST'), r).toBeNull();
      expect(exceptionFor(r, 'DELETE'), r).toBeNull();
    }
  });
});

describe('L85D-S03 — chaque garde reconnue applique bien `canWrite`', () => {
  const sources = new Map<string, string>();
  const src = (f: string) => {
    if (!sources.has(f)) sources.set(f, stripComments(readFileSync(join(process.cwd(), f), 'utf-8')));
    return sources.get(f)!;
  };
  /** Corps de la fonction exportée `name` (jusqu'à la définition suivante). */
  const corps = (f: string, name: string) => {
    const s = src(f);
    const i = s.search(new RegExp(`export (?:async )?function ${name}\\b`));
    expect(i, `${name} dans ${f}`).toBeGreaterThanOrEqual(0);
    const suite = s.slice(i + 10).search(/\nexport /);
    return s.slice(i, suite < 0 ? undefined : i + 10 + suite);
  };
  const CHAINE = /canWrite|refuserSiLectureSeule|assetModificationDecision|canModifyAssets|canUsePremiumFeature|loadWritableAsset|getEntitlements/;

  it.each(RECOGNIZED_GUARDS.map((g) => [g.name, g.file] as const))('%s (%s)', (name, file) => {
    const body = corps(file, name);
    if (name === 'getEntitlements') {
      // Source unique des droits : `entitlementsFromSubscription` rend `canWrite: false` (et `premiumFeatures: false`) en mode restreint.
      const pure = corps(file, 'entitlementsFromSubscription');
      expect(pure).toMatch(/premiumFeatures: false, canWrite: false/);
      return;
    }
    expect(body).toMatch(CHAINE);
  });
});

describe('L85D-S04 — constat 84B corrigé à la source (même garde que les autres routes)', () => {
  const lire = (p: string) => stripComments(readFileSync(join(process.cwd(), 'src/app/api', p), 'utf-8'));
  it('DELETE /api/agenda/:id', () => {
    const s = lire('agenda/[id]/route.ts');
    const del = s.slice(s.indexOf('export async function DELETE'));
    expect(del).toMatch(/const refus = await refuserSiLectureSeule\(accountId\);\s*if \(refus\) return refus;[\s\S]*deleteAgendaItem\(/);
  });
  it('PATCH /api/agenda/:id/statut', () => {
    const s = lire('agenda/[id]/statut/route.ts');
    expect(s).toMatch(/import \{ refuserSiLectureSeule \} from '@\/lib\/write-access-guard'/);
    expect(s).toMatch(/const refus = await refuserSiLectureSeule\(accountId\);\s*if \(refus\) return refus;[\s\S]*updateManualStatus\(/);
  });
  it('les deux routes sont vues gardées par l’audit', () => {
    const handlers = auditWriteRoutes();
    const get = (route: string, method: string) => handlers.find((h) => h.route === route && h.method === method);
    expect(get('agenda/[id]/route.ts', 'DELETE')?.guarded).toBe(true);
    expect(get('agenda/[id]/statut/route.ts', 'PATCH')?.guarded).toBe(true);
    expect(get('agenda/conflicts/[id]/route.ts', 'PATCH')?.guarded).toBe(true);
  });
});

describe('L85D-S05 — l’audit détecte une route non gardée (témoin)', () => {
  it('route d’écriture sans garde → non gardée ; garde directe, par fonction locale, par alias, par réexport → gardée', () => {
    const root = mkdtempSync(join(tmpdir(), 'l85d-audit-'));
    try {
      const api = join(root, 'src/app/api');
      const ecrire = (p: string, code: string) => { mkdirSync(join(api, p), { recursive: true }); writeFileSync(join(api, p, 'route.ts'), code); };
      ecrire('nue', `import { db } from '@/db';\nexport async function DELETE() {\n  // refuserSiLectureSeule(1) — un commentaire n'est pas une garde\n  await db.delete();\n}\n`);
      ecrire('directe', `import { refuserSiLectureSeule } from '@/lib/write-access-guard';\nexport async function POST() {\n  const refus = await refuserSiLectureSeule(1);\n  if (refus) return refus;\n}\n`);
      ecrire('locale', `import { refuserSiLectureSeule as garde } from '@/lib/write-access-guard';\nasync function ctx() {\n  return garde(1);\n}\nexport async function PATCH() {\n  await ctx();\n}\nexport async function PUT() {\n  return null;\n}\n`);
      ecrire('reexport', `export { PATCH } from '../locale/route';\n`);
      ecrire('entitlements', `import { getEntitlements } from '@/services/entitlements.service';\nexport async function POST() {\n  const e = await getEntitlements(1);\n  return e.plan;\n}\n`);
      const res = auditWriteRoutes(root);
      const g = (route: string, m: string) => res.find((h) => h.route === `${route}/route.ts` && h.method === m)?.guarded;
      expect(g('nue', 'DELETE')).toBe(false);
      expect(g('directe', 'POST')).toBe(true);
      expect(g('locale', 'PATCH')).toBe(true);
      expect(g('locale', 'PUT')).toBe(false);
      expect(g('reexport', 'PATCH')).toBe(true);
      expect(g('entitlements', 'POST')).toBe(false); // getEntitlements sans lecture de canWrite
      expect(WRITE_METHODS).toEqual(['POST', 'PUT', 'PATCH', 'DELETE']);
      expect(analyzeRouteFile(join(api, 'nue/route.ts'), api)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(existsSync(root)).toBe(false);
  });
});
