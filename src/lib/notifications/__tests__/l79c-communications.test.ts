/**
 * Lot 79C — e-mails et notifications : suppression des communications
 * inutiles et fiabilisation des règles d'envoi (partie pure ; le moteur réel
 * sur PostgreSQL est couvert par `l79c-notifications.e2e.ts`).
 *
 *   L79C-AC01  SECURITY_SESSIONS_REVOKED : e-mail supprimé (non proposé au BO)
 *   L79C-AC02  confirmation d'ajout : e-mail et push supprimés, même avec une ancienne préférence
 *   L79C-AC03  échecs d'analyse : aucun e-mail (catalogue, réémission)
 *   L79C-AC04  un même incident d'analyse / de paiement : un seul message
 *   L79C-AC05  « À traiter » : aucun e-mail ni push immédiat ordinaire
 *   L79C-AC06  récapitulatif facultatif, jamais répété à contenu inchangé
 *   L79C-AC07  indispensables / facultatifs séparés dans les préférences
 *   L79C-AC08  doublons accueil / paiement / abonnement vérifiés
 *   L79C-AC10  le BO reflète les canaux réellement disponibles
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const { NOTIFICATION_CATALOG, getCatalogEntry, failedDocumentsText, PAYMENT_AUTHENTICATION_ACTION } = await import('../catalog');
const { applyRetiredChannels, isChannelRetired } = await import('../retired-channels');
const { categoryEmailScope, categoryPushAvailable, eventEmailExists, EMAIL_EVENT_USER_LABELS } = await import('../preference-matrix');
const { digestHasNews, digestItemKey } = await import('../scheduled/to-process-digest');
const { transactionalRetiredReason, RETIRED_TRANSACTIONAL_EMAILS } = await import('../channel-activation');
const { listEventDefinitions, TRANSACTIONAL_EMAILS } = await import('@/services/admin/communications.service');
const { retirerCanauxSupprimes } = await import('@/services/notifications/notification-reemission.service');
const { invoiceReceiptCovered } = await import('@/lib/billing/invoice-receipt');

const entry = (t: string) => getCatalogEntry(t)!;
const tousCanaux = { bell: true, push: true, email: true };

describe('L79C-AC02 / AC03 / AC05 — canaux supprimés bloqués quelles que soient les préférences', () => {
  it('confirmation d’ajout : e-mail ET push supprimés ; cloche conservée', () => {
    const e = entry('DOCUMENT_UPLOAD_COMPLETED');
    // Ancienne préférence « Documents » e-mail + push activés → canaux résolus à vrai.
    const { channels, retired } = applyRetiredChannels(tousCanaux, e);
    expect(channels).toEqual({ bell: true, push: false, email: false });
    expect(retired.sort()).toEqual(['email', 'push']);
    expect(e.neverBell).toBe(false);
  });

  it.each(['DOCUMENT_BATCH_PARTIALLY_FAILED', 'DOCUMENT_BATCH_FAILED', 'ANALYSIS_FAILED_PERSISTENT'])(
    'échec d’analyse %s : jamais d’e-mail, résultat conservé dans la cloche',
    (t) => {
      const { channels } = applyRetiredChannels(tousCanaux, entry(t));
      expect(channels.email).toBe(false);
      expect(channels.bell).toBe(true);
    },
  );

  it('fin d’analyse réussie : une notification par lot, push facultatif, sans e-mail', () => {
    const e = entry('DOCUMENT_BATCH_COMPLETED');
    expect(isChannelRetired(e, 'email')).toBe(true);
    expect(isChannelRetired(e, 'push')).toBe(false);
    expect(applyRetiredChannels(tousCanaux, e).channels).toEqual({ bell: true, push: true, email: false });
  });

  it('« À traiter » ordinaire : ni e-mail ni push immédiat, jamais de cloche', () => {
    const e = entry('TO_PROCESS_ITEM_CREATED');
    expect(e.neverBell).toBe(true);
    expect(applyRetiredChannels({ bell: false, push: true, email: true }, e).channels).toEqual({ bell: false, push: false, email: false });
  });

  it('renouvellement : plus de push systématique', () => {
    expect(isChannelRetired(entry('SUBSCRIPTION_RENEWED'), 'push')).toBe(true);
  });

  it('aucun canal supprimé sur un e-mail obligatoire (les indispensables restent envoyés)', () => {
    for (const e of Object.values(NOTIFICATION_CATALOG)) {
      if (e?.mandatoryEmail) expect(isChannelRetired(e, 'email')).toBe(false);
    }
  });

  it('réémission BO : un canal supprimé n’est jamais réémis', () => {
    expect(retirerCanauxSupprimes({ canaux: ['bell', 'email'] }, entry('DOCUMENT_BATCH_FAILED'))).toEqual({ canaux: ['bell'] });
    expect(retirerCanauxSupprimes({ canaux: ['email', 'push'], pushSubscriptionIds: ['s1'] }, entry('DOCUMENT_UPLOAD_COMPLETED'))).toEqual({ canaux: [] });
    expect(retirerCanauxSupprimes({ canaux: ['email'] }, entry('PAYMENT_FAILED'))).toEqual({ canaux: ['email'] });
  });
});

describe('L79C-AC04 — un incident, un message (contenu)', () => {
  it('échec de lot : documents concernés et action réellement possible', () => {
    const r = entry('DOCUMENT_BATCH_PARTIALLY_FAILED').render({
      lotId: 1, analysedCount: 2, failedCount: 2,
      documents: [{ assetFileId: 1, title: 'Facture garage' }, { assetFileId: 2, title: 'Devis' }],
    });
    expect(r.bellBody).toContain('Documents concernés : Facture garage, Devis.');
    expect(r.bellBody).toMatch(/relancer l’analyse depuis la fiche du document/);
    expect(failedDocumentsText([{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }, { title: 'e' }])).toBe(' Documents concernés : a, b, c (et 2 autres).');
    expect(failedDocumentsText(undefined)).toBe('');
  });

  it('paiement : échec + authentification de la même facture → message unique (problème, conséquences, action)', () => {
    const r = entry('PAYMENT_FAILED').render({ deadlineAt: '2027-01-20T00:00:00Z', authenticationRequired: true });
    expect(r.bellBody).toMatch(/Un paiement a échoué/);
    expect(r.bellBody).toMatch(/suspendues/);
    expect(r.bellBody).toContain(PAYMENT_AUTHENTICATION_ACTION);
    expect(entry('PAYMENT_FAILED').render({}).bellBody).not.toContain(PAYMENT_AUTHENTICATION_ACTION);
  });
});

describe('L79C-AC06 — récapitulatif « À traiter »', () => {
  it('désactivé par défaut (e-mail et push), activation volontaire conservée par le résolveur', () => {
    expect(entry('TO_PROCESS_DAILY_DIGEST').defaults).toEqual({ push: false, email: false });
  });

  it('nouveauté = une action absente du dernier récapitulatif ; le compteur n’est pas le critère', () => {
    const a = digestItemKey('a', 1); const b = digestItemKey('b', 1); const c = digestItemKey('c', 1);
    expect(digestHasNews([a, b], null)).toBe(true);           // premier récapitulatif
    expect(digestHasNews([a, b], [a, b])).toBe(false);        // contenu inchangé
    expect(digestHasNews([a], [a, b])).toBe(false);           // seulement des résolutions (compteur en baisse)
    expect(digestHasNews([a, c], [a, b])).toBe(true);         // même total, contenu nouveau
    expect(digestHasNews([digestItemKey('a', 2)], [a])).toBe(true); // réapparition (nouveau cycle)
    expect(digestHasNews([], [a])).toBe(false);
  });
});

describe('L79C-AC07 — indispensables et facultatifs séparés', () => {
  it.each(['duo', 'account', 'security'] as const)('catégorie %s : des e-mails indispensables ET facultatifs — le switch n’est plus verrouillé', (cat) => {
    const scope = categoryEmailScope(cat);
    expect(scope.essential.length).toBeGreaterThan(0);
    expect(scope.optional.length).toBeGreaterThan(0);
  });

  it('libellés : ce que couvre le switch et ce qui part toujours', () => {
    expect(categoryEmailScope('security')).toEqual({
      essential: ['mot de passe modifié', 'changement d’adresse e-mail demandé', 'adresse e-mail modifiée', 'mot de passe réinitialisé'],
      optional: ['connexion depuis un nouvel appareil'],
    });
    expect(categoryEmailScope('duo').optional).toEqual(['réponses à vos demandes de transfert ou de suppression']);
    expect(categoryEmailScope('account').essential).toContain('incident de paiement');
    expect(categoryEmailScope('account').optional).toContain('fin d’essai proche');
  });

  it('canaux supprimés non proposés : e-mail « Documents », alerte immédiate « À traiter »', () => {
    expect(categoryEmailScope('documents')).toEqual({ essential: [], optional: [] });
    expect(categoryPushAvailable('documents')).toBe(true); // fin d'analyse : push facultatif
    expect(categoryEmailScope('to_process', 'immediate')).toEqual({ essential: [], optional: [] });
    expect(categoryPushAvailable('to_process', 'immediate')).toBe(false);
    expect(categoryEmailScope('to_process', 'daily_digest').optional).toEqual(['récapitulatif quotidien']);
  });

  it('chaque événement pouvant partir par e-mail a un libellé utilisateur (affichage = moteur)', () => {
    for (const e of Object.values(NOTIFICATION_CATALOG)) {
      if (e && e.category !== 'news' && eventEmailExists(e)) expect(EMAIL_EVENT_USER_LABELS[e.type], e.type).toBeTruthy();
    }
  });

  it('DUO_INVITATION_DECLINED : cloche obligatoire, e-mail jamais imposé par le catalogue', () => {
    const e = entry('DUO_INVITATION_DECLINED');
    expect(e.mandatoryBell).toBe(true);
    expect(e.mandatoryEmail).toBe(false);
    expect(e.render({}).emailTemplateCode).toBeUndefined();
    const sql = readFileSync(join(process.cwd(), 'src/db/migrations/0620_l79c_duo_refus_email_defaut.sql'), 'utf8');
    expect(sql).toMatch(/VALUES \('email:DUO_INVITATION_DECLINED', 'email', false, NULL, now\(\)\)\s*ON CONFLICT \(event_code, channel\) DO NOTHING/);
  });
});

describe('L79C-AC08 — doublons d’accueil, de paiement et d’abonnement', () => {
  /** Fichiers source (hors tests) qui contiennent `motif`. */
  function producteurs(motif: RegExp): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) { if (!/__tests__|test$|e2e/.test(n)) walk(p); continue; }
        if (/\.(ts|tsx)$/.test(n) && motif.test(readFileSync(p, 'utf8'))) out.push(p.replace(`${process.cwd()}/`, ''));
      }
    };
    walk(join(process.cwd(), 'src'));
    return out.sort();
  }

  it('accueil : WELCOME seul déclencheur (vérification de l’adresse) ; TRIAL_CONFIRMATION sans aucun appelant', () => {
    expect(producteurs(/send\(\{\s*templateCode: 'WELCOME'/)).toEqual(['src/app/api/auth/verify-email/route.ts']);
    expect(producteurs(/sendTrialConfirmationEmail\(/)).toEqual(['src/lib/email/billing-emails.ts']);
    expect(TRANSACTIONAL_EMAILS.find((t) => t.templateCode === 'TRIAL_CONFIRMATION')?.label).toMatch(/NON UTILISÉ/);
  });

  it('renouvellement : pas d’e-mail générique quand le reçu Stripe couvre la facture', () => {
    expect(invoiceReceiptCovered({ receipt_number: '2471-1234' })).toBe(true);
    expect(invoiceReceiptCovered({ receipt_number: null })).toBe(false);
    expect(invoiceReceiptCovered({})).toBe(false);
    const e = entry('SUBSCRIPTION_RENEWED');
    expect(e.render({ planCode: 'PREMIUM', receiptCovered: true }).emailTemplateCode).toBeUndefined();
    expect(e.render({ planCode: 'PREMIUM' }).emailTemplateCode).toBe('notif_subscription');
  });

  it('résiliation : un seul e-mail (DOWNGRADE_NOTIFICATION) — la notification garde cloche et push', () => {
    const e = entry('SUBSCRIPTION_CANCELLED');
    expect(e.render({ downgradeEmailSent: true }).emailTemplateCode).toBeUndefined();
    expect(e.render({}).emailTemplateCode).toBe('notif_subscription');
    const webhook = readFileSync(join(process.cwd(), 'src/app/api/billing/stripe-webhook/route.ts'), 'utf8');
    expect(webhook).toMatch(/payload: downgradeEmailSent \? \{ downgradeEmailSent: true \} : \{\}/);
  });

  it('activation / changement : l’e-mail de confirmation contractuel reste unique (existant, inchangé)', () => {
    expect(entry('SUBSCRIPTION_ACTIVATED').render({ planCode: 'PREMIUM', planLabel: 'Premium', confirmationEmailSent: true }).emailTemplateCode).toBeUndefined();
  });

  it('paiement : action requise différée et regroupée avec l’échec de la même facture', () => {
    const webhook = readFileSync(join(process.cwd(), 'src/app/api/billing/stripe-webhook/route.ts'), 'utf8');
    expect(webhook).toMatch(/type: 'PAYMENT_ACTION_REQUIRED'[\s\S]{0,600}scheduledFor: new Date\(Date\.now\(\) \+ PAYMENT_ACTION_GROUPING_DELAY_MS\)/);
    // SUBSCRIPTION_SUSPENDED : aucun producteur (vérifié) — rien à regrouper.
    expect(producteurs(/type: 'SUBSCRIPTION_SUSPENDED'/)).toEqual([]);
  });
});

describe('L79C-AC01 / AC10 — le BO reflète les canaux réellement disponibles', () => {
  const defs = listEventDefinitions([]);
  const def = (code: string) => defs.find((d) => d.code === code)!;

  it('SECURITY_SESSIONS_REVOKED : supprimé, aucun canal ni gabarit proposé', () => {
    expect(transactionalRetiredReason('security_sessions_revoked')).toBeTruthy();
    expect(Object.keys(RETIRED_TRANSACTIONAL_EMAILS)).toEqual(['SECURITY_SESSIONS_REVOKED']);
    const d = def('email:SECURITY_SESSIONS_REVOKED');
    expect(d.channels).toEqual([]);
    expect(d.emailTemplateCode).toBeNull();
    expect(d.retiredChannels).toEqual([{ channel: 'email', reason: expect.stringMatching(/Supprimé/) }]);
  });

  it('gabarit supprimé présent en base : jamais réintroduit comme « e-mail inconnu »', () => {
    const avecBase = listEventDefinitions(['SECURITY_SESSIONS_REVOKED', 'security_sessions_revoked']);
    expect(avecBase.filter((d) => d.code === 'email:SECURITY_SESSIONS_REVOKED')).toHaveLength(1);
  });

  it('catalogue : canaux supprimés retirés des canaux proposés et listés avec leur motif', () => {
    expect(def('DOCUMENT_UPLOAD_COMPLETED').channels.map((c) => c.channel)).toEqual(['in_app']);
    expect(def('DOCUMENT_UPLOAD_COMPLETED').retiredChannels.map((r) => r.channel)).toEqual(['email', 'push']);
    expect(def('DOCUMENT_BATCH_FAILED').channels.map((c) => c.channel)).toEqual(['push', 'in_app']);
    expect(def('DOCUMENT_BATCH_FAILED').emailTemplateCode).toBeNull();
    expect(def('TO_PROCESS_ITEM_CREATED').channels).toEqual([]);
    expect(def('SUBSCRIPTION_RENEWED').channels.map((c) => c.channel)).toEqual(['email', 'in_app']);
    expect(def('DUO_INVITATION_DECLINED').channels.map((c) => c.channel)).toEqual(['push', 'in_app']);
    expect(def('email:DUO_INVITATION_DECLINED').channels).toEqual([{ channel: 'email', locked: false, lockReason: null }]);
  });
});

describe('L79C-AC11 — diagnostic des déconnexions lisible au BO (sans SQL)', async () => {
  const { describeLoginActivity, formatRotationAge } = await import('@/services/admin/user-detail.service');

  it('révocation globale : libellé avec l’âge de la rotation, sans rien conclure', () => {
    expect(formatRotationAge(45_200)).toBe('45 s');
    expect(formatRotationAge(185_000)).toBe('3 min');
    expect(formatRotationAge(2 * 3_600_000 + 5 * 60_000)).toBe('2 h 05');
    expect(describeLoginActivity('AUTH_TOKEN_REUSE_DETECTED', JSON.stringify({ severity: 'security_incident', rotationAgeMs: 45_000, sessionsRevoked: true })))
      .toEqual({ result: 'session_revoked', detail: 'Sessions révoquées par précaution : ancien jeton présenté 45 s après son renouvellement' });
    expect(describeLoginActivity('AUTH_TOKEN_REUSE_DETECTED', JSON.stringify({ severity: 'security_incident', sessionsRevoked: false })).detail)
      .toBe('Sessions révoquées par précaution : ancien jeton présenté (révocation non confirmée)');
  });
});
