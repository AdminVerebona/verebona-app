/**
 * Lot 54F — « Inviter quelqu'un » (mascotte) limité au PREMIER MOIS de
 * l'abonnement Premium Duo, sans réapparition après une invitation, et
 * ouverture fiable du formulaire (« Mon compte » › « Mon abonnement » ›
 * « 2e utilisateur Duo »). Règles pures, lecture, interface (rendu serveur,
 * même composant ordinateur / mobile). La base réelle (déclencheur 0385,
 * synchronisation Stripe, BO, routes, reprise) est couverte par
 * `src/test/e2e/scenarios/l54f-duo-mascotte.e2e.ts`.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToProcessActionView } from '@/services/to-process/to-process-query.service';

(globalThis as { React?: typeof React }).React = React;

let duoRows: Array<Record<string, unknown>> = [];
const sqlSeen: string[] = [];
vi.mock('@/db', () => ({
  pgClient: {
    unsafe: async (sql: string) => {
      sqlSeen.push(sql);
      return /JOIN duo_accounts/.test(sql) ? duoRows : [];
    },
  },
  db: {},
}));
let rawData: Record<string, unknown> = {};
vi.mock('../collector', () => ({ collectMascotData: async () => rawData }));
vi.mock('@/services/verebona-assistant/core/account-state', () => ({ loadSuggestionContext: async () => ({}) }));
vi.mock('@/services/verebona-assistant/registries/capability-registry', async (orig) => ({
  ...(await orig<typeof import('@/services/verebona-assistant/registries/capability-registry')>()),
  suggestionsForRoute: () => [],
}));
// Interface : « Mon abonnement » d'un titulaire Premium Duo.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useSession', () => ({ useSession: () => ({ user: { duoRole: 'BILLING_OWNER' } }) }));
const quota = { used: 1, limit: 10, ratio: 10, label: '1 / 10', shouldWarn: false, isFull: false };
vi.mock('@/hooks/useEntitlements', () => ({
  useEntitlements: () => ({
    isLoading: false, refresh: async () => undefined,
    entitlements: {
      trial: { status: 'none', daysRemaining: 0, endsAt: null, isUrgent: false },
      plan: 'premium_duo', status: 'ACTIVE', premiumFeatures: true, isRestricted: false, unpaid: null,
      subscription: { planCode: 'premium_duo', billingPeriod: 'monthly', currentPeriodEndAt: null, cancelAtPeriodEnd: false, hasStripeSubscription: true, scheduledChange: null },
      quotas: { assets: quota, documents: quota, users: { limit: 2 } },
    },
  }),
}));
// Tiroir rendu OUVERT (état obtenu par l'ancre au clic) : on vérifie ce qu'il porte.
vi.mock('@/components/ui/collapsible-card', () => ({
  CollapsibleCard: (p: { anchorId?: string; title: React.ReactNode; children: React.ReactNode }) =>
    h('section', { id: p.anchorId, 'data-tiroir': 'ouvert' }, h('h2', null, p.title), p.children),
}));

const { duoInviteFrom, addOneCalendarMonth, readDuoInvite, DUO_INVITE_HREF } = await import('../duo-invite');
const { getMascotPresentation } = await import('../mascot.service');
const { homeItems } = await import('../bubble');
const { SubscriptionSummary } = await import('@/components/subscription/SubscriptionSummary');

const ROOT = process.cwd();
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');

const DEBUT = new Date('2026-10-14T08:30:00.000Z'); // 10 h 30 à Paris
const ECHEANCE = new Date('2026-11-14T09:30:00.000Z'); // 10 h 30 à Paris (heure d'hiver)
const DUO = { subscriptionStatus: 'ACTIVE', pendingInviteEmail: null, memberships: 0, startedAt: DEBUT, firstInviteSentAt: null, offerActive: true };

let n = 0;
function atp(priority: 'DO_FIRST' | 'DO_NEXT' = 'DO_FIRST'): ToProcessActionView {
  n += 1;
  return {
    publicId: `p-${n}`, targetType: 'DOCUMENT', targetId: 100 + n, fieldKey: 'documentType', relationKey: null,
    actionKind: 'COMPLETE', priority, ruleCode: 'DOC-TYP', question: 'Quel est le type de ce document ?',
    proposals: [], allowNotApplicable: false, target: { label: `Document ${n}` },
  } as unknown as ToProcessActionView;
}
function raw(toProcess: ToProcessActionView[] = [], biens = 1) {
  return {
    accountId: 7, today: '2026-10-14',
    processing: { uploads: [], analyses: [], exports: [] },
    onboarding: { activeAssets: biens ? [{ id: 1, name: 'Maison' }] : [], activeAssetCount: biens, documentCount: biens ? 3 : 0 },
    toProcess, toProcessTotal: toProcess.length, toProcessAgendaIds: [], agenda: [], acknowledgments: [],
    rights: { canWrite: true, canAddAsset: true, canAddDocument: true },
  };
}

beforeEach(() => {
  duoRows = [];
  sqlSeen.length = 0;
  rawData = raw();
  vi.useRealTimers();
});

describe('DUO-M1-01 — nouveau Duo actif sans invitation : proposée en premier à J0 et avant l’échéance', () => {
  it('J0, J+15, dernière milliseconde du mois', () => {
    expect(duoInviteFrom(DUO, DEBUT)).toMatchObject({ title: 'Inviter quelqu’un', href: DUO_INVITE_HREF });
    expect(duoInviteFrom(DUO, new Date(DEBUT.getTime() + 15 * 86_400_000))).not.toBeNull();
    expect(duoInviteFrom(DUO, new Date(ECHEANCE.getTime() - 1))).not.toBeNull();
  });

  it('accueil (horloge maîtrisée) : premier élément de la bulle, avant les « À traiter »', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DEBUT);
    duoRows = [DUO];
    rawData = raw([atp(), atp('DO_NEXT')]);
    const p = await getMascotPresentation(7);
    expect(homeItems(p, false)[0]).toMatchObject({ kind: 'duo-invite', title: 'Inviter quelqu’un' });
    // La lecture porte la date de début et la trace durable.
    const lecture = sqlSeen.find((s) => /JOIN duo_accounts/.test(s))!;
    expect(lecture).toMatch(/d\.duo_subscription_started_at AS "startedAt"/);
    expect(lecture).toMatch(/d\.duo_first_invite_sent_at AS "firstInviteSentAt"/);
  });
});

describe('DUO-M1-02 — à l’instant exact d’un mois calendaire : absente (strictement avant)', () => {
  it('début + 1 mois calendaire (heure de Paris), instant exact puis après', () => {
    expect(addOneCalendarMonth(DEBUT).toISOString()).toBe(ECHEANCE.toISOString());
    expect(duoInviteFrom(DUO, ECHEANCE)).toBeNull();
    expect(duoInviteFrom(DUO, new Date(ECHEANCE.getTime() + 1))).toBeNull();
  });

  it('mois calendaire : 31 janvier → dernier jour de février ; changement d’heure ; fin d’année', () => {
    expect(addOneCalendarMonth(new Date('2026-01-31T10:00:00.000Z')).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addOneCalendarMonth(new Date('2028-01-31T10:00:00.000Z')).toISOString()).toBe('2028-02-29T10:00:00.000Z');
    // 15 mars 11 h (hiver) → 15 avril 11 h (été) à Paris.
    expect(addOneCalendarMonth(new Date('2026-03-15T10:00:00.000Z')).toISOString()).toBe('2026-04-15T09:00:00.000Z');
    expect(addOneCalendarMonth(new Date('2026-12-20T07:00:00.123Z')).toISOString()).toBe('2027-01-20T07:00:00.123Z');
  });

  it('au-delà : disparaît au recalcul de la mascotte, sans traitement planifié', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ECHEANCE);
    duoRows = [DUO];
    const p = await getMascotPresentation(7);
    expect(p.duoInvite).toBeUndefined();
    const catalogue = src('src/services/scheduling/scheduled-tasks.catalog.ts');
    expect(catalogue).not.toMatch(/duo[-_ ]?invit/i);
  });

  it('sans date de début fiable : jamais proposée', () => {
    expect(duoInviteFrom({ ...DUO, startedAt: null }, DEBUT)).toBeNull();
    expect(duoInviteFrom({ ...DUO, startedAt: 'pas une date' }, DEBUT)).toBeNull();
  });
});

describe('DUO-M1-03 / DUO-M1-04 — invitation envoyée : disparition, sans réapparition après annulation ou expiration', () => {
  it('trace durable du premier envoi : absente, même lien annulé (pending vidé) ou expiré', () => {
    expect(duoInviteFrom({ ...DUO, firstInviteSentAt: DEBUT }, DEBUT)).toBeNull();
    expect(duoInviteFrom({ ...DUO, pendingInviteEmail: 'ami@exemple.fr' }, DEBUT)).toBeNull();
  });

  it('route : l’envoi pose la trace (sans l’écraser) ; l’annulation ne l’efface pas', () => {
    const route = src('src/app/api/duo/invitation/route.ts');
    // Lot 57A : la trace est posée à l'ACCEPTATION de l'e-mail par Resend
    // (demande durable), jamais avant — toujours sans écraser la première.
    expect(src('src/services/email/transactional-email-jobs.service.ts'))
      .toMatch(/duo_first_invite_sent_at = COALESCE\(duo_first_invite_sent_at, \$3::timestamptz\)/);
    expect(route).not.toMatch(/duoFirstInviteSentAt:/);
    const del = route.slice(route.indexOf('export async function DELETE'));
    expect(del).not.toMatch(/duoFirstInviteSentAt/);
    // Renvoi / annulation / remplacement : inchangés.
    expect(del).toMatch(/pendingInviteSentAt: null/);
    expect(route).toMatch(/const reuse = !!\(resend && duo\.pendingInviteToken && duo\.pendingInviteEmail === email\)/);
  });
});

describe('DUO-M1-06 — Duo impayé, résilié ou membre invité : absente', () => {
  it('statuts hors offre et second membre de la souscription', () => {
    for (const s of ['UNPAID_RECOVERY', 'CANCELED', 'EXPIRED']) expect(duoInviteFrom({ ...DUO, subscriptionStatus: s }, DEBUT)).toBeNull();
    expect(duoInviteFrom({ ...DUO, memberships: 1 }, DEBUT)).toBeNull();
    expect(duoInviteFrom(null, DEBUT)).toBeNull();
  });

  it('membre d’un Duo précédent sorti avant le début : ne compte plus ; sinon compte', async () => {
    duoRows = [DUO];
    await readDuoInvite(7, DEBUT);
    const lecture = sqlSeen.find((s) => /JOIN duo_accounts/.test(s))!;
    expect(lecture).toMatch(/m\.status IN \('INVITED', 'ACTIVE'\) OR m\.left_at IS NULL/);
    expect(lecture).toMatch(/m\.left_at >= d\.duo_subscription_started_at/);
  });
});

describe('DUO-M1-07 — hiérarchie des actions conservée (compte vide ou avec biens)', () => {
  it('compte avec biens : invitation + 1 DO_FIRST ; après le mois : deux DO_FIRST', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DEBUT);
    duoRows = [DUO];
    rawData = raw([atp(), atp(), atp()]);
    let p = await getMascotPresentation(7);
    expect(homeItems(p, false).map((i) => i.kind)).toEqual(['duo-invite', 'todo']);
    vi.setSystemTime(ECHEANCE);
    p = await getMascotPresentation(7);
    expect(p.duoInvite).toBeUndefined();
    expect(p.todo?.items).toHaveLength(2);
  });

  it('compte vide : proposée avant les tuiles d’amorce pendant le mois, plus après', async () => {
    const { duoInviteHomeItem } = await import('../bubble');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DEBUT);
    duoRows = [DUO];
    rawData = raw([], 0);
    expect(duoInviteHomeItem(await getMascotPresentation(7))).toMatchObject({ kind: 'duo-invite' });
    vi.setSystemTime(ECHEANCE);
    expect(duoInviteHomeItem(await getMascotPresentation(7))).toBeNull();
  });
});

describe('DUO-M1-08 — clic : tiroir ouvert, « 2e utilisateur Duo », champ e-mail (ordinateur ET mobile)', () => {
  it('« Mon abonnement » porte l’ancre (anchorId) ; un SEUL élément « duo-invitation »', () => {
    const html = renderToStaticMarkup(h(SubscriptionSummary));
    expect(html.match(/id="duo-invitation"/g)).toHaveLength(1);
    expect(html).toMatch(/<section id="duo-invitation" data-tiroir="ouvert"><h2>Mon abonnement<\/h2>/);
    expect(html).toMatch(/id="duo-invitation-panel"[\s\S]*2e utilisateur Duo/);
  });

  it('mécanisme anchorId de CollapsibleCard : ouverture sur le fragment, puis défilement', () => {
    const carte = src('src/components/ui/collapsible-card.tsx');
    expect(carte).toMatch(/if \(window\.location\.hash !== `#\$\{anchorId\}`\) return\s+setOpen\(true\)/);
    expect(carte).toMatch(/<Card ref=\{ref\} id=\{anchorId\}/);
  });

  it('panneau : après lecture de l’état, bloc amené à l’écran puis focus sur le champ e-mail', () => {
    const panneau = src('src/components/subscription/DuoInvitationPanel.tsx');
    expect(panneau).toMatch(/document\.getElementById\(DUO_INVITATION_PANEL_ID\)\?\.scrollIntoView[\s\S]{0,120}getElementById\('invite-email'\)\?\.focus\(\{ preventScroll: true \}\)/);
    expect(panneau).toMatch(/id="invite-email"/);
    // Clic mascotte (accueil ordinateur et mobile, même composant) : navigation vers l’ancre.
    const ui = src('src/components/home/MascotSpeaks.tsx');
    expect(ui).toMatch(/if \(it\.kind === 'duo-invite'\) \{[\s\S]*?router\.push\(it\.invite\.href\)/);
    expect(DUO_INVITE_HREF).toBe('/mon-compte#duo-invitation');
  });

  it('aucun autre élément de l’application ne porte l’identifiant « duo-invitation »', () => {
    const fichiers = ['src/components/subscription/SubscriptionSummary.tsx', 'src/components/subscription/DuoInvitationPanel.tsx', 'src/app/(dashboard)/mon-compte/page.tsx'];
    for (const f of fichiers) expect(src(f)).not.toMatch(/id="duo-invitation"/);
  });
});

describe('DUO-M1-09 — après le mois : invitation manuelle toujours possible dans « Mon compte »', () => {
  it('le panneau ne dépend pas de la fenêtre de la mascotte', () => {
    const resume = src('src/components/subscription/SubscriptionSummary.tsx');
    expect(resume).toMatch(/const showDuoInvitation = !isDuoMember && data\.plan === 'premium_duo' && user\?\.duoRole === 'BILLING_OWNER';/);
    expect(src('src/app/api/duo/invitation/route.ts')).not.toMatch(/duo_subscription_started_at|duoSubscriptionStartedAt/);
  });
});

describe('DUO-M1-10 — guide de bienvenue et T6 inchangés', () => {
  it('la mascotte ne transmet pas l’invitation à T6 (empreinte T6 : sujets et secondaires)', () => {
    const svc = src('src/services/home/mascot/mascot.service.ts');
    // Lot 55A : secondaires hors questions (les questions viennent de T6 lui-même).
    expect(svc).toMatch(/const contextHash = contextHashOf\(subjects, baseSecondaries, candidates\.degraded\);/);
    expect(src('src/services/home/mascot/t6-contract.ts')).not.toMatch(/duoInvite|duo_subscription/);
  });
});
