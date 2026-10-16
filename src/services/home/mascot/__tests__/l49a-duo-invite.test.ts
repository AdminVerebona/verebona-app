/**
 * Lot 49A — ticket 13 : un nouvel abonné Premium Duo qui n'a invité personne
 * se voit proposer EN PREMIER « Inviter quelqu'un » par la mascotte.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToProcessActionView } from '@/services/to-process/to-process-query.service';

// ── Doublures : base (lecture Duo), collecteur, questions du catalogue ──────
let duoRows: Array<Record<string, unknown>> = [];
const sqlSeen: Array<{ sql: string; p: unknown[] }> = [];
vi.mock('@/db', () => ({
  pgClient: {
    unsafe: async (sql: string, p: unknown[]) => {
      sqlSeen.push({ sql, p });
      if (/JOIN duo_accounts/.test(sql)) return duoRows;
      return [];
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

const { duoInviteFrom, DUO_INVITE_HREF } = await import('../duo-invite');
const { getMascotPresentation } = await import('../mascot.service');
const { buildPresentation } = await import('../presentation');
const { composeSpeech, homeItems, homePose, duoInviteHomeItem } = await import('../bubble');

const ROOT = process.cwd();
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

let n = 0;
function atp(priority: 'DO_FIRST' | 'DO_NEXT' = 'DO_FIRST'): ToProcessActionView {
  n += 1;
  return {
    publicId: `p-${n}`, targetType: 'DOCUMENT', targetId: 100 + n, fieldKey: 'documentType', relationKey: null,
    actionKind: 'COMPLETE', priority, ruleCode: 'DOC-TYP',
    question: 'Quel est le type de ce document ?', proposals: [], allowNotApplicable: false,
    target: { label: `Document ${n}` },
  } as unknown as ToProcessActionView;
}

function raw(toProcess: ToProcessActionView[] = []) {
  return {
    accountId: 7, today: '2026-10-12',
    processing: { uploads: [], analyses: [], exports: [] },
    onboarding: { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 3 },
    toProcess, toProcessTotal: toProcess.length, toProcessAgendaIds: [], agenda: [], acknowledgments: [],
    rights: { canWrite: true, canAddAsset: true, canAddDocument: true },
  };
}

// Lot 54F : Duo pris HIER (premier mois), aucune invitation envoyée.
const DUO_NEUF = { subscriptionStatus: 'ACTIVE', pendingInviteEmail: null, memberships: 0, startedAt: new Date(Date.now() - 86_400_000), firstInviteSentAt: null, offerActive: true };

beforeEach(() => {
  duoRows = [];
  sqlSeen.length = 0;
  rawData = raw();
});

describe('AC13-1 — Premium Duo pris, personne invitée : « Inviter quelqu’un » EN PREMIER', () => {
  it('condition (pure) : Duo actif, aucune invitation, aucun membre', () => {
    expect(duoInviteFrom(DUO_NEUF)).toMatchObject({ title: 'Inviter quelqu’un', href: DUO_INVITE_HREF, cta: 'Inviter' });
    expect(duoInviteFrom({ ...DUO_NEUF, subscriptionStatus: 'TRIALING' })).not.toBeNull();
  });

  it('accueil : premier élément de la bulle, avant les « À traiter » DO_FIRST', async () => {
    duoRows = [DUO_NEUF];
    rawData = raw([atp(), atp('DO_NEXT')]);
    const p = await getMascotPresentation(7);
    expect(p.duoInvite).toMatchObject({ href: '/mon-compte#duo-invitation' });
    const items = homeItems(p, false);
    expect(items[0]).toMatchObject({ kind: 'duo-invite', title: 'Inviter quelqu’un' });
    expect(items[1]).toMatchObject({ kind: 'todo' });
    // Lecture du Duo du compte demandé, par le payeur (utilisateur du compte).
    const lecture = sqlSeen.find((c) => /JOIN duo_accounts/.test(c.sql))!;
    expect(lecture.sql).toMatch(/JOIN duo_accounts d ON d\.id = a\.duo_account_id AND d\.billing_owner_user_id = a\.owner_user_id/);
    expect(lecture.sql).toMatch(/m\.user_id <> d\.billing_owner_user_id/);
    expect(lecture.sql).toMatch(/WHERE a\.id = \$1/);
    expect(lecture.p).toEqual([7]);
  });

  it('aucune autre action : la bulle compte « Un sujet… » et ne dit jamais « Tout est à jour »', async () => {
    duoRows = [DUO_NEUF];
    const p = await getMascotPresentation(7);
    expect(p.status).toBe('ok');
    expect(composeSpeech({ presentation: p, empty: false }).text).toBe('Un sujet nécessite votre attention aujourd’hui.');
    expect(homePose(p, false)).toBe('reminder-bell');
  });

  it('compte encore vide : proposé avant les tuiles d’amorce (même composant desktop / mobile)', () => {
    const p = buildPresentation({ subjects: [], secondaries: [], degraded: false, messages: null, todo: null, duoInvite: duoInviteFrom(DUO_NEUF) });
    expect(homeItems(p, true)).toEqual([]);
    expect(duoInviteHomeItem(p)).toMatchObject({ kind: 'duo-invite' });
    const ui = src('src/components/home/MascotSpeaks.tsx');
    expect(ui).toMatch(/const emptyInvite = empty \? duoInviteHomeItem\(presentation\) : null/);
    expect(ui.indexOf('{emptyInvite && (')).toBeLessThan(ui.indexOf('{emptyTiles.map('));
  });
});

describe('AC13-2 — hiérarchie DO_FIRST (deux au plus) respectée', () => {
  it('3 DO_FIRST dans la file : « Inviter quelqu’un » + 1 DO_FIRST, « Deux sujets… »', async () => {
    duoRows = [DUO_NEUF];
    rawData = raw([atp(), atp(), atp(), atp('DO_NEXT')]);
    const p = await getMascotPresentation(7);
    expect(p.todo?.items).toHaveLength(1);
    expect(p.todo?.items[0].priority).toBe('DO_FIRST');
    expect(homeItems(p, false).filter((i) => i.kind === 'duo-invite' || i.kind === 'todo')).toHaveLength(2);
    expect(composeSpeech({ presentation: p, empty: false }).text).toMatch(/^Deux sujets nécessitent votre attention aujourd’hui\./);
  });

  it('sans Duo à inviter : comportement inchangé (deux DO_FIRST)', async () => {
    rawData = raw([atp(), atp(), atp()]);
    const p = await getMascotPresentation(7);
    expect(p.duoInvite).toBeUndefined();
    expect(p.todo?.items).toHaveLength(2);
    expect(homeItems(p, false)[0].kind).toBe('todo');
  });

  it('DO_NEXT / CAN_WAIT jamais ajoutés pour compléter', async () => {
    duoRows = [DUO_NEUF];
    rawData = raw([atp('DO_NEXT'), atp('DO_NEXT')]);
    const p = await getMascotPresentation(7);
    expect(p.todo?.items).toEqual([]);
    expect(homeItems(p, false).map((i) => i.kind)).toEqual(['duo-invite']);
  });
});

describe('AC13-3 — clic : parcours d’invitation existant', () => {
  it('« Mon compte » › « 2e utilisateur Duo » (DuoInvitationPanel), ancre et champ e-mail prêts', () => {
    const ui = src('src/components/home/MascotSpeaks.tsx');
    expect(ui).toMatch(/if \(it\.kind === 'duo-invite'\) \{[\s\S]*?router\.push\(it\.invite\.href\)/);
    // Lot 54F : l'ancre est portée par le tiroir « Mon abonnement » (anchorId),
    // le bloc « 2e utilisateur Duo » a son propre identifiant.
    const resume = src('src/components/subscription/SubscriptionSummary.tsx');
    expect(resume).toMatch(/anchorId=\{showDuoInvitation \? DUO_INVITATION_ANCHOR : undefined\}/);
    expect(resume).toMatch(/id=\{DUO_INVITATION_PANEL_ID\}[\s\S]{0,600}?2e utilisateur Duo[\s\S]{0,300}?<DuoInvitationPanel \/>/);
    const panneau = src('src/components/subscription/DuoInvitationPanel.tsx');
    expect(panneau).toContain("export const DUO_INVITATION_ANCHOR = 'duo-invitation'");
    expect(panneau).toContain("window.location.hash !== `#${DUO_INVITATION_ANCHOR}`");
    expect(panneau).toContain("getElementById('invite-email')?.focus");
  });
});

describe('AC13-4 — disparaît dès qu’une invitation est envoyée ou acceptée', () => {
  it('invitation envoyée (même expirée), membre invité / actif / parti : plus rien', async () => {
    expect(duoInviteFrom({ ...DUO_NEUF, pendingInviteEmail: 'ami@exemple.fr' })).toBeNull();
    expect(duoInviteFrom({ ...DUO_NEUF, memberships: 1 })).toBeNull();
    duoRows = [{ ...DUO_NEUF, pendingInviteEmail: 'ami@exemple.fr' }];
    const p = await getMascotPresentation(7);
    expect(p.duoInvite).toBeUndefined();
    expect(homeItems(p, false).some((i) => i.kind === 'duo-invite')).toBe(false);
  });

  it('l’empreinte change : le client remplace la bulle gardée en mémoire', async () => {
    duoRows = [DUO_NEUF];
    const avant = await getMascotPresentation(7);
    duoRows = [{ ...DUO_NEUF, memberships: 1 }];
    const apres = await getMascotPresentation(7);
    expect(avant.contextHash).not.toBe(apres.contextHash);
  });
});

describe('AC13-5 — jamais hors cible', () => {
  it('pas de Duo, Duo résilié ou impayé : rien', async () => {
    expect(duoInviteFrom(null)).toBeNull();
    expect(duoInviteFrom({ ...DUO_NEUF, subscriptionStatus: 'CANCELED' })).toBeNull();
    expect(duoInviteFrom({ ...DUO_NEUF, subscriptionStatus: 'UNPAID_RECOVERY' })).toBeNull();
    const p = await getMascotPresentation(7);
    expect(p.duoInvite).toBeUndefined();
  });

  it('lecture Duo en échec : la mascotte s’affiche normalement, sans l’action', async () => {
    const db = await import('@/db');
    const spy = vi.spyOn(db.pgClient, 'unsafe').mockRejectedValueOnce(new Error('boom'));
    rawData = raw([atp()]);
    const p = await getMascotPresentation(7);
    expect(p.duoInvite).toBeUndefined();
    expect(p.todo?.items).toHaveLength(1);
    spy.mockRestore();
  });

});
