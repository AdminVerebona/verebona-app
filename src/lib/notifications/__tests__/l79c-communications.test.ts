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
const { renewalNotificationPayload } = await import('@/lib/billing/invoice-receipt');

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
    // Lot 81E : documents nommés (texte partagé avec la cloche), jamais « à vérifier ».
    expect(r.bellBody).toBe('2 documents analysés, 2 n’ont pas pu l’être : “Facture garage”, “Devis”. Vous pouvez relancer l’analyse depuis la fiche du document, dans Documents.');
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

  it('renouvellement (lot 81E) : `receipt_number` n’est plus une preuve — l’e-mail générique part selon la préférence', () => {
    const e = entry('SUBSCRIPTION_RENEWED');
    // Ancienne ligne en file portant encore `receiptCovered` : ignoré.
    expect(e.render({ planCode: 'PREMIUM', receiptCovered: true }).emailTemplateCode).toBe('notif_subscription');
    expect(e.render({ planCode: 'PREMIUM' }).emailTemplateCode).toBe('notif_subscription');
    const p = renewalNotificationPayload({ id: 'in_1', receipt_number: '2471-1234', lines: { data: [{ period: { end: 1823385600 } }] } } as never, { planCode: 'PREMIUM', billingPeriod: 'yearly' });
    expect(p).toEqual({ planCode: 'PREMIUM', billingPeriod: 'yearly', nextRenewalAt: new Date(1823385600 * 1000).toISOString(), invoiceId: 'in_1' });
    expect(p).not.toHaveProperty('receiptCovered');
  });

  it('résiliation (lot 81E) : e-mail générique omis seulement si l’e-mail durable de fin d’offre de la même opération est enregistré', () => {
    const e = entry('SUBSCRIPTION_CANCELLED');
    expect(e.render({ endedEmailJobId: 9 }).emailTemplateCode).toBeUndefined();
    expect(e.render({ endedEmailJobId: 9 }).emailSkipReason).toBe('covered_by_end_of_offer_email:9');
    // Ancien drapeau d'intention (heuristique « 24 h ») : plus une preuve.
    expect(e.render({ downgradeEmailSent: true }).emailTemplateCode).toBe('notif_subscription');
    expect(e.render({}).emailTemplateCode).toBe('notif_subscription');
    const webhook = readFileSync(join(process.cwd(), 'src/app/api/billing/stripe-webhook/route.ts'), 'utf8');
    expect(webhook).not.toMatch(/downgradeEmailRecentlySent|interval '24 hours'/);
  });

  it('activation / changement (lot 81E) : confirmation contractuelle durable — l’intention ne vaut plus envoi', () => {
    expect(entry('SUBSCRIPTION_ACTIVATED').render({ planCode: 'PREMIUM', planLabel: 'Premium', confirmationJobId: 3 }).emailTemplateCode).toBeUndefined();
    expect(entry('SUBSCRIPTION_ACTIVATED').render({ planCode: 'PREMIUM', planLabel: 'Premium', confirmationEmailSent: true }).emailTemplateCode).toBe('notif_subscription');
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

// ══════════════════════════════════════════════════════════════════════════
// LOT 81E — écarts résiduels du lot 79C (parties pures ; moteur réel sur
// PostgreSQL 16 : `l79c-notifications.e2e.ts`, scénarios L81E-E2E-*).
// ══════════════════════════════════════════════════════════════════════════

const { classifyLotItem, resolveLotOutcome, resolveLotNotificationType } = await import('@/services/ai/source-analysis/lot-notification');
const { lotFailurePayload, lotFailureText, lotPartialFailureText } = await import('@/services/ai/source-analysis/lot-notification-text');
const { analysisIncidentKey, actionRequiredCoveredBy, invoiceResolvedReason } = await import('../incident-grouping');
const { subscriptionOperationKey, detectSubscriptionTransitions, plannedCommunications } = await import('@/services/billing/subscription-communications.service');
const { digestChanges, digestItemFingerprint } = await import('../scheduled/to-process-digest');
const { aggregateOutboxStatus } = await import('../dispatcher');

const item = (id: number, over: Record<string, unknown> = {}) => ({
  assetFileId: id, title: `Doc ${id}`, analysisState: 'ANALYZED', analysisFailReason: null,
  deleted: false, groupedInto: null, liveJob: false, retryExpected: false, ...over,
});

describe('L81E-U01 — fin d’analyse : résultat établi depuis les états réels', () => {
  it('réussite totale, réussite partielle, échec total — une issue par lot', () => {
    expect(resolveLotOutcome([item(1), item(2)]).type).toBe('DOCUMENT_BATCH_COMPLETED');
    const partiel = resolveLotOutcome([item(1), item(2, { analysisState: 'ANALYSIS_FAILED' })]);
    expect(partiel).toMatchObject({ final: true, type: 'DOCUMENT_BATCH_PARTIALLY_FAILED', failed: [{ assetFileId: 2, title: 'Doc 2' }] });
    // Lot entièrement échoué : plus jamais silencieux.
    expect(resolveLotOutcome([item(1, { analysisState: 'ANALYSIS_FAILED' })]).type).toBe('DOCUMENT_BATCH_FAILED');
    expect(resolveLotNotificationType(0, 1)).toBe('DOCUMENT_BATCH_FAILED');
    expect(resolveLotNotificationType(2, 1)).toBe('DOCUMENT_BATCH_PARTIALLY_FAILED');
  });

  it('doublons et regroupements légitimes ne sont jamais des échecs', () => {
    const r = resolveLotOutcome([
      item(1), item(2, { analysisState: 'FUSION_SUGGESTED' }),
      item(3, { deleted: true, groupedInto: 1, analysisState: 'ANALYZED' }),
    ]);
    expect(r).toMatchObject({ final: true, type: 'DOCUMENT_BATCH_COMPLETED', duplicates: 1, failed: [] });
    expect(r.analysed.map((d) => d.assetFileId)).toEqual([1, 2]);
    expect(classifyLotItem(item(4, { deleted: true }))).toBe('REMOVED');
  });

  it('un traitement en cours ou repris automatiquement n’est jamais présenté comme définitif', () => {
    for (const over of [{ analysisState: 'ANALYSIS_FAILED', liveJob: true }, { analysisState: 'ANALYSIS_FAILED', retryExpected: true },
      { analysisState: 'ANALYZING' }, { analysisState: 'UPLOADED' }, { analysisState: null }]) {
      expect(resolveLotOutcome([item(1), item(2, over)])).toMatchObject({ final: false, type: null });
    }
    // Reporté au mois suivant (plafond de coût IA) : annoncé avec son propre lot.
    const reporte = item(2, { analysisState: 'UPLOADED', analysisFailReason: 'Plafond IA du mois atteint : reprise le 1er novembre' });
    expect(resolveLotOutcome([item(1), reporte])).toMatchObject({ final: true, type: 'DOCUMENT_BATCH_COMPLETED' });
  });

  it('documents concernés nommés, action réellement disponible, document unique ouvert en tiroir', () => {
    const p = lotFailurePayload(7, 0, [{ assetFileId: 42, title: 'Facture garage' }]);
    expect(p).toEqual({ lotId: 7, analysedCount: 0, failedCount: 1, documents: [{ assetFileId: 42, title: 'Facture garage' }], assetFileId: 42 });
    expect(lotFailureText(p)).toBe('Le document “Facture garage” n’a pas pu être analysé. Vous pouvez relancer l’analyse depuis la fiche du document, dans Documents.');
    expect(entry('DOCUMENT_BATCH_FAILED').deepLink(p)).toBe('/documents?tiroir=document%3A42');
    expect(lotPartialFailureText({ analysedCount: 1, failedCount: 1, documents: [{ assetFileId: 2, title: 'Devis' }] }))
      .toBe('1 document analysé, 1 n’a pas pu l’être : “Devis”. Vous pouvez relancer l’analyse depuis la fiche du document, dans Documents.');
    // Canaux du lot 79C conservés : aucun e-mail d'analyse.
    for (const t of ['DOCUMENT_BATCH_COMPLETED', 'DOCUMENT_BATCH_PARTIALLY_FAILED', 'DOCUMENT_BATCH_FAILED']) {
      expect(applyRetiredChannels(tousCanaux, entry(t)).channels).toEqual({ bell: true, push: true, email: false });
    }
  });
});

describe('L81E-U02 — identité des incidents', () => {
  it('analyse : document × lot ; identité incomplète → jamais rapprochée', () => {
    expect(analysisIncidentKey({ assetFileId: 5, lotId: 9 })).toBe('doc:5:lot:9');
    expect(analysisIncidentKey({ assetFileId: 5, lotId: 10 })).not.toBe(analysisIncidentKey({ assetFileId: 5, lotId: 9 }));
    expect(analysisIncidentKey({ assetFileId: 5 })).toBeNull();
  });

  it('paiement : l’authentification n’est absorbée que par un échec qui la porte ou qui n’est pas encore parti', () => {
    expect(actionRequiredCoveredBy(null)).toBe(false);
    expect(actionRequiredCoveredBy({ status: 'pending', authenticationRequired: false })).toBe(true);
    expect(actionRequiredCoveredBy({ status: 'sent', authenticationRequired: true })).toBe(true);
    // Échec déjà envoyé SANS l'action (webhook tardif) : évolution significative, envoyée.
    expect(actionRequiredCoveredBy({ status: 'sent', authenticationRequired: false })).toBe(false);
    // Porteur en échec : jamais.
    expect(actionRequiredCoveredBy({ status: 'failed', authenticationRequired: true })).toBe(false);
    expect(invoiceResolvedReason('paid')).toBe('incident_resolved:invoice_paid');
    expect(invoiceResolvedReason('open')).toBeNull();
  });
});

describe('L81E-U03 — communications d’abonnement : une décision par opération', () => {
  const t = {
    kind: 'PLAN_CHANGE' as const, accountId: 1, subscriptionId: 'sub_1', oldPlan: 'PREMIUM', newPlan: 'PREMIUM_DUO',
    oldStatus: 'ACTIVE', newStatus: 'ACTIVE', effectiveAt: new Date('2026-10-23T08:00:00Z'),
  };
  it('clé stable par opération ; deux opérations distinctes du même utilisateur en moins de 24 h restent distinctes', () => {
    expect(subscriptionOperationKey(t)).toBe(subscriptionOperationKey({ ...t }));
    expect(subscriptionOperationKey({ ...t, effectiveAt: new Date('2026-10-23T09:00:00Z') })).not.toBe(subscriptionOperationKey(t));
    expect(subscriptionOperationKey({ ...t, oldPlan: 'PREMIUM_DUO', newPlan: 'PREMIUM' })).not.toBe(subscriptionOperationKey(t));
    // Prise d'effet : l'abonnement seul (webhook `deleted` et synchronisation → même opération).
    const fin = { ...t, kind: 'CANCELLATION_EFFECTIVE' as const };
    expect(subscriptionOperationKey({ ...fin, oldStatus: 'CANCELED' })).toBe(subscriptionOperationKey({ ...fin, oldStatus: 'ACTIVE', effectiveAt: null }));
    // Résiliation programmée puis reprise puis nouvelle résiliation : deux opérations.
    const prog = { ...t, kind: 'CANCELLATION_SCHEDULED' as const };
    expect(subscriptionOperationKey({ ...prog, requestedAt: new Date('2026-10-23T08:00:00Z') }))
      .not.toBe(subscriptionOperationKey({ ...prog, requestedAt: new Date('2026-10-23T10:00:00Z') }));
  });

  it('résiliation programmée et prise d’effet : deux étapes distinctes', () => {
    const base = {
      before: { planType: 'PREMIUM', status: 'ACTIVE', subscriptionId: 'sub_1', cancelAtPeriodEnd: false },
      after: { planType: 'PREMIUM', status: 'CANCELED' },
      subscription: { id: 'sub_1', cancel_at_period_end: true, cancel_at: 1830000000, canceled_at: 1820000000 },
      isPaid: true, isTerminal: false, withdrawn: false, periodEnd: null, now: new Date(),
    };
    expect(detectSubscriptionTransitions(base).map((x) => x.kind)).toEqual(['CANCELLATION_SCHEDULED']);
    // Rejeu (déjà programmée) : rien.
    expect(detectSubscriptionTransitions({ ...base, before: { ...base.before, cancelAtPeriodEnd: true } })).toEqual([]);
    const fin = detectSubscriptionTransitions({ ...base, after: { planType: 'STANDARD', status: 'EXPIRED' }, isPaid: false, isTerminal: true });
    expect(fin.map((x) => x.kind)).toEqual(['CANCELLATION_EFFECTIVE']);
    // Déjà rétrogradé (autre producteur) : rien.
    expect(detectSubscriptionTransitions({ ...base, before: { ...base.before, planType: 'STANDARD', status: 'EXPIRED' }, after: { planType: 'STANDARD', status: 'EXPIRED' }, isPaid: false, isTerminal: true })).toEqual([]);
  });

  it('confirmation contractuelle : données exactes de l’opération ; Standard jamais présenté comme gratuit', () => {
    const p = plannedCommunications({
      ...t, kind: 'ACTIVATION', ownerUserId: 3, oldPlan: 'STANDARD', newPlan: 'PREMIUM', oldStatus: 'TRIALING',
      billingPeriod: 'yearly', unitAmountCents: 5900, nextBillingDate: new Date('2027-10-23T00:00:00Z'), isPaid: true, notify: true, source: 'x',
    });
    expect(p.email).toEqual({ kind: 'PREMIUM_CONFIRMATION', context: expect.objectContaining({ planLabel: 'Premium', unitAmountCents: 5900, billingPeriod: 'yearly', nextBillingDate: '2027-10-23T00:00:00.000Z' }) });
    expect(p.notification?.type).toBe('SUBSCRIPTION_ACTIVATED');
    const fin = plannedCommunications({ ...t, kind: 'CANCELLATION_EFFECTIVE', ownerUserId: 3, newPlan: 'STANDARD', notify: true, source: 'x' });
    expect(fin.email?.kind).toBe('DOWNGRADE_NOTIFICATION');
    expect(plannedCommunications({ ...t, kind: 'CANCELLATION_EFFECTIVE', ownerUserId: 3, oldPlan: 'STANDARD', newPlan: 'STANDARD', notify: true, source: 'x' }).email).toBeNull();
    const billing = readFileSync(join(process.cwd(), 'src/lib/email/billing-emails.ts'), 'utf8');
    expect(billing).not.toMatch(/Standard gratuite|gratuitement/);
  });
});

describe('L81E-U04 — récapitulatif : nouveautés et évolutions significatives', () => {
  const a = { publicId: 'a', cycleNumber: 1, actionKind: 'ARBITRATE', priority: 'DO_NEXT', question: 'Prix ?' };
  it('nouvelle action, nouveau cycle, priorité ou contenu modifiés → nouveauté ; inchangé ou résolu → rien', () => {
    const fa = digestItemFingerprint(a);
    expect(digestChanges([fa], null, null)).toEqual({ news: true, reasons: ['NEW_ACTION'] });
    expect(digestChanges([fa], [fa], ['a:c1']).news).toBe(false);
    expect(digestChanges([], [fa], ['a:c1']).news).toBe(false);
    expect(digestChanges([digestItemFingerprint({ ...a, priority: 'DO_FIRST' })], [fa], ['a:c1']).reasons).toEqual(['PRIORITY_CHANGED']);
    expect(digestChanges([digestItemFingerprint({ ...a, question: 'Prix d’achat ?' })], [fa], ['a:c1']).reasons).toEqual(['CONTENT_CHANGED']);
    expect(digestChanges([digestItemFingerprint({ ...a, cycleNumber: 2 })], [fa], ['a:c1']).reasons).toEqual(['NEW_CYCLE']);
    // État antérieur au lot 81E (clés seules) : aucun renvoi en masse au déploiement.
    expect(digestChanges([digestItemFingerprint({ ...a, priority: 'DO_FIRST' })], null, ['a:c1']).news).toBe(false);
  });
});

describe('L81E-U05 — statuts de l’outbox fidèles', () => {
  it('« envoyé » exige un canal accepté ; aucun canal envoyé sans échec → ignoré', () => {
    expect(aggregateOutboxStatus(['sent', 'skipped_unavailable'])).toBe('sent');
    expect(aggregateOutboxStatus(['sent', 'failed'])).toBe('partial');
    expect(aggregateOutboxStatus(['failed', 'skipped_unavailable'])).toBe('failed');
    expect(aggregateOutboxStatus(['skipped_unavailable', 'skipped_unavailable'])).toBe('skipped');
    expect(aggregateOutboxStatus(['expired'])).toBe('skipped');
    expect(aggregateOutboxStatus([])).toBe('skipped');
  });
});
