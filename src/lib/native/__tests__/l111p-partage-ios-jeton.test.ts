/**
 * Lot 111P — partage iOS « Vous n'êtes pas connecté » à tort (correctif du
 * lot 110A) : états distincts du jeton, remise fiable (déclencheurs, reprise
 * bornée, renouvellement après refus serveur et avant échéance, vérification
 * serveur légère), textes, journal technique expurgé.
 * Parcours serveur réels : src/test/e2e/scenarios/l111p-partage-renouvellement.e2e.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  SHARE_IMPORT_EXTENSION_NOTICES, SHARE_IMPORT_PROVISION_RETRY_DELAYS_MS, SHARE_IMPORT_RENEWABLE_REFUSALS, shareImportMessage,
} from '@/lib/mobile/share-import-policy';
import {
  classifyGrantHttp, grantNeed, needsGrant, parseNativeState, provisionResult, provisionRetryDelay, renewalDueAt, serverGrantVerdict,
  type NativeShareState, type ProvisionResult,
} from '@/lib/native/share-import';
import { ShareGrantProvisioner, provisionNotice, type ProvisionStatus } from '@/lib/native/share-grant-provisioner';
import {
  SHARE_IMPORT_JOURNAL_KEY, appendShareImportJournal, mergeNativeShareDiagnostics, readShareImportJournal, sanitizeShareImportDetail,
} from '@/lib/native/share-import-journal';
import { shareFileLine } from '@/components/native/ShareImportStatusCard';

const read = (p: string) => readFileSync(resolve(__dirname, '../../../..', p), 'utf8');
const NOW = Date.parse('2026-11-05T12:00:00Z');
const H = 3600_000;
const grant = (over: Partial<NonNullable<NativeShareState['grant']>> = {}) => ({
  accountKey: 'u1-a1', expiresAt: new Date(NOW + 72 * H).toISOString(), ref: 'a28b9a6a3053', refusedCode: null, ...over,
});
const state = (g: NativeShareState['grant'], extra: Partial<NativeShareState> = {}): NativeShareState => ({ available: true, grant: g, items: [], ...extra });

describe('L111P — état du jeton distinct de la session (règles pures)', () => {
  it('motif du besoin : absent, autre compte, échéance < 24 h, refusé par le serveur, valide ; sans session : rien', () => {
    expect(grantNeed(null, null, NOW)).toBe('NO_SESSION');
    expect(grantNeed(null, 'u1-a1', NOW)).toBe('MISSING');
    expect(grantNeed(grant({ accountKey: 'u1-a2' }), 'u1-a1', NOW)).toBe('OTHER_ACCOUNT');
    expect(grantNeed(grant({ expiresAt: new Date(NOW + 23 * H).toISOString() }), 'u1-a1', NOW)).toBe('EXPIRING');
    for (const c of SHARE_IMPORT_RENEWABLE_REFUSALS) expect(grantNeed(grant({ refusedCode: c }), 'u1-a1', NOW)).toBe('REFUSED');
    expect(grantNeed(grant({ refusedCode: 'ACCOUNT_READ_ONLY' }), 'u1-a1', NOW)).toBe('OK'); // refus définitif de dépôt, pas du jeton
    expect(grantNeed(grant(), 'u1-a1', NOW)).toBe('OK');
    expect(needsGrant(grant({ refusedCode: 'GRANT_REVOKED' }), 'u1-a1', NOW)).toBe(true);
    expect(renewalDueAt(grant())).toBe(NOW + 48 * H);
  });

  it('état natif : statut, code du Keychain, référence, refus et journal validés ; binaire 110A → « unknown »', () => {
    const s = parseNativeState({
      available: true, items: [], grantStatus: 'refused', storeCode: 'OK',
      grant: { accountKey: 'u1-a1', expiresAt: '2026-11-08T12:00:00.000Z', ref: 'a28b9a6a3053', refusedCode: 'GRANT_REVOKED', token: 'vbsi_secret' },
      diagnostics: [{ t: 1, c: 'UPLOAD_AUTH_GRANT_REVOKED', s: 'ext' }, { t: 2, c: 'x y <script>', s: 'app' }],
    });
    expect(s.grant).toEqual({ accountKey: 'u1-a1', expiresAt: '2026-11-08T12:00:00.000Z', ref: 'a28b9a6a3053', refusedCode: 'GRANT_REVOKED' });
    expect(JSON.stringify(s)).not.toMatch(/vbsi_/);
    expect(s.grantStatus).toBe('refused');
    expect(s.diagnostics).toEqual([{ t: 1, c: 'UPLOAD_AUTH_GRANT_REVOKED', s: 'ext' }]);
    expect(parseNativeState({ available: true, items: [] }).grantStatus).toBe('unknown');
    expect(parseNativeState({ available: true, items: [], grantStatus: 'unreadable', storeCode: 'MISSING_ENTITLEMENT' }).storeCode).toBe('MISSING_ENTITLEMENT');
  });

  it('vérification serveur légère : jeton inconnu du serveur, presque épuisé, actif, invérifiable', () => {
    expect(serverGrantVerdict('a28b9a6a3053', [{ ref: 'a28b9a6a3053', usesLeft: 90 }])).toBe('ACTIVE');
    expect(serverGrantVerdict('a28b9a6a3053', [{ ref: 'a28b9a6a3053', usesLeft: 10 }])).toBe('LOW_USES');
    expect(serverGrantVerdict('a28b9a6a3053', [{ ref: 'ffffffffffff', usesLeft: 100 }])).toBe('NOT_ACTIVE');
    expect(serverGrantVerdict(null, [])).toBe('UNVERIFIABLE');
  });

  it('réponse de la route `grant` : catégories stables, passagers retentés, définitifs non', () => {
    expect(classifyGrantHttp(201, null)).toBe('OK');
    expect(classifyGrantHttp(401, 'AUTH_REQUIRED')).toBe('SESSION_UNAVAILABLE');
    expect(classifyGrantHttp(403, 'MFA_REQUIRED')).toBe('MFA_REQUIRED');
    expect(classifyGrantHttp(403, 'CGUV_REACCEPTANCE_REQUIRED')).toBe('CGUV_REACCEPTANCE_REQUIRED');
    expect(classifyGrantHttp(409, 'ACCOUNT_NOT_FOUND')).toBe('ACCOUNT_NOT_FOUND');
    expect(classifyGrantHttp(503, 'UNSUPPORTED')).toBe('FEATURE_OFF');
    expect(classifyGrantHttp(429, 'RATE_LIMIT_EXCEEDED')).toBe('RATE_LIMITED');
    expect(classifyGrantHttp(502, null)).toBe('SERVER_ERROR');
    for (const c of ['NETWORK', 'SESSION_RENEWING', 'RATE_LIMITED', 'SERVER_ERROR', 'INVALID_RESPONSE'] as const) expect(provisionResult(c).retryable).toBe(true);
    for (const c of ['MFA_REQUIRED', 'FEATURE_OFF', 'SESSION_UNAVAILABLE', 'NATIVE_REJECTED', 'KEYCHAIN_WRITE', 'CGUV_REACCEPTANCE_REQUIRED'] as const) {
      expect(provisionResult(c).retryable).toBe(false);
      expect(provisionRetryDelay(provisionResult(c), 0)).toBeNull();
    }
  });

  it('reprise bornée : 5 s, 30 s, 2 min, 10 min puis plus rien', () => {
    const net = provisionResult('NETWORK');
    expect([0, 1, 2, 3, 4].map((a) => provisionRetryDelay(net, a))).toEqual([...SHARE_IMPORT_PROVISION_RETRY_DELAYS_MS, null]);
  });

  it('textes de l’extension : jamais « Vous n’êtes pas connecté » ; texte exact quand le jeton manque', () => {
    expect(SHARE_IMPORT_EXTENSION_NOTICES.token_missing).toBe('L’import se terminera à la prochaine ouverture de Verebona, sans rien resélectionner.');
    for (const t of Object.values(SHARE_IMPORT_EXTENSION_NOTICES)) expect(t).not.toMatch(/pas connecté/);
    for (const c of ['GRANT_INVALID', 'GRANT_EXPIRED', 'GRANT_REVOKED', 'GRANT_EXHAUSTED']) {
      expect(shareImportMessage(c)).not.toMatch(/Connexion à Verebona nécessaire|pas connecté/);
      expect(shareImportMessage(c)).toMatch(/sans rien resélectionner/);
    }
  });
});

// ── Orchestration (horloge et minuteurs simulés) ──────────────────────────

function harness(opts: { results?: ProvisionResult[]; states?: NativeShareState[]; check?: Array<{ ref: string; usesLeft: number }> | null } = {}) {
  let now = NOW;
  const timers: Array<{ at: number; fn: () => void; id: number; done: boolean }> = [];
  let nextId = 1;
  const results = [...(opts.results ?? [])];
  let current: NativeShareState = opts.states?.[0] ?? state(null);
  const journal: Array<{ code: string; detail?: Record<string, unknown> }> = [];
  const statuses: ProvisionStatus[] = [];
  const provision = vi.fn(async () => {
    const r = results.shift() ?? provisionResult('OK');
    if (r.ok) current = state(grant({ ref: `r${String(provision.mock.calls.length).padStart(11, '0')}` }));
    return r;
  });
  const checkServer = vi.fn(async () => opts.check ?? null);
  const resume = vi.fn(async () => undefined);
  const p = new ShareGrantProvisioner({
    now: () => now,
    setTimer: (fn, ms) => { const t = { at: now + ms, fn, id: nextId++, done: false }; timers.push(t); return t.id; },
    clearTimer: (id) => { const t = timers.find((x) => x.id === id); if (t) t.done = true; },
    readState: async () => current,
    provision, checkServer, resume,
    journal: (code, detail) => { journal.push({ code, detail }); },
    onStatus: (s) => { statuses.push(s); },
  });
  const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((t) => !t.done && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at; due.done = true; due.fn(); await flush();
    }
    now = until;
    await flush();
  };
  return {
    p, provision, checkServer, resume, journal, statuses, flush, advance,
    set: (s: NativeShareState) => { current = s; },
    get state() { return current; },
    tick: (ms: number) => { now += ms; },
  };
}

describe('L111P — remise fiable du jeton (ShareGrantProvisioner)', () => {
  it('connexion : jeton demandé une fois, reprise des imports, minuteur de renouvellement anticipé posé', async () => {
    const h = harness();
    h.p.setContext('u1-a1', true);
    await h.flush();
    expect(h.provision).toHaveBeenCalledTimes(1);
    expect(h.resume).toHaveBeenCalledTimes(1);
    expect(h.p.getStatus().phase).toBe('ready');
    expect(h.journal.find((j) => j.code === 'GRANT_PROVISION')?.detail).toMatchObject({ trigger: 'session', reason: 'MISSING', outcome: 'OK' });
    // Événements natifs suivants (jeton présent) : aucune nouvelle demande.
    await h.p.trigger('native', h.state);
    expect(h.provision).toHaveBeenCalledTimes(1);
    // 48 h plus tard (24 h avant l'échéance) : renouvellement anticipé.
    await h.advance(48 * H + 1000);
    expect(h.provision).toHaveBeenCalledTimes(2);
    expect(h.journal.filter((j) => j.code === 'GRANT_PROVISION').at(-1)?.detail).toMatchObject({ trigger: 'renewal', reason: 'EXPIRING' });
  });

  it('échec passager : 4 nouveaux essais temporisés au plus, puis arrêt — aucun essai sur événement natif', async () => {
    const net = provisionResult('NETWORK');
    const h = harness({ results: [net, net, net, net, net, net] });
    h.p.setContext('u1-a1', true);
    await h.flush();
    expect(h.p.getStatus()).toMatchObject({ phase: 'retry_scheduled', code: 'NETWORK' });
    await h.p.trigger('native', h.state); // l'état natif change : pas de nouvel essai hors minuteur
    expect(h.provision).toHaveBeenCalledTimes(1);
    await h.advance(24 * H);
    expect(h.provision).toHaveBeenCalledTimes(5); // 1 + 4 reprises
    expect(h.p.getStatus()).toMatchObject({ phase: 'blocked', code: 'NETWORK' });
    await h.p.trigger('native', h.state);
    expect(h.provision).toHaveBeenCalledTimes(5);
    // Retour au premier plan : un nouvel essai (déclencheur humain).
    await h.p.trigger('resume', h.state);
    expect(h.provision).toHaveBeenCalledTimes(6);
  });

  it('échec passager puis succès : reprise sans resélection (imports relancés)', async () => {
    const h = harness({ results: [provisionResult('SERVER_ERROR', 'HTTP_502')] });
    h.p.setContext('u1-a1', true);
    await h.flush();
    expect(h.resume).not.toHaveBeenCalled();
    await h.advance(SHARE_IMPORT_PROVISION_RETRY_DELAYS_MS[0]);
    expect(h.provision).toHaveBeenCalledTimes(2);
    expect(h.resume).toHaveBeenCalledTimes(1);
    expect(h.p.getStatus().phase).toBe('ready');
  });

  it('refus définitif (double authentification exigée) : aucun nouvel essai automatique ; retour au premier plan espacé de 30 s', async () => {
    const mfa = provisionResult('MFA_REQUIRED', 'HTTP_403:MFA_REQUIRED');
    const h = harness({ results: [mfa, mfa, mfa] });
    h.p.setContext('u1-a1', true);
    await h.flush();
    expect(h.p.getStatus()).toMatchObject({ phase: 'blocked', code: 'MFA_REQUIRED' });
    await h.advance(24 * H);
    expect(h.provision).toHaveBeenCalledTimes(1);
    h.tick(-24 * H + 10_000); // ramené à 10 s après la tentative
    await h.p.trigger('resume', h.state);
    expect(h.provision).toHaveBeenCalledTimes(1); // trop tôt
    h.tick(30_000);
    await h.p.trigger('resume', h.state);
    expect(h.provision).toHaveBeenCalledTimes(2);
    expect(provisionNotice(h.p.getStatus())).toMatch(/double authentification/);
  });

  it('jeton refusé par le serveur : renouvelé UNE fois par jeton, 3 fois au plus par 30 min — jamais de boucle', async () => {
    const h = harness();
    h.p.setContext('u1-a1', true);
    await h.flush();
    expect(h.provision).toHaveBeenCalledTimes(1);
    const refuse = () => { const g = h.state.grant!; h.set(state({ ...g, refusedCode: 'GRANT_REVOKED' })); };
    for (let i = 0; i < 3; i += 1) {
      refuse();
      await h.p.trigger('native', h.state);
    }
    expect(h.provision).toHaveBeenCalledTimes(4);
    refuse();
    await h.p.trigger('native', h.state);
    expect(h.provision).toHaveBeenCalledTimes(4); // limite atteinte
    expect(h.p.getStatus()).toMatchObject({ phase: 'blocked', code: 'REFUSAL_LIMIT' });
    expect(h.journal.some((j) => j.code === 'GRANT_RENEWAL_LIMIT')).toBe(true);
    // Le même jeton refusé, signalé de nouveau : jamais renouvelé deux fois.
    await h.p.trigger('native', h.state);
    expect(h.provision).toHaveBeenCalledTimes(4);
  });

  it('vérification serveur légère au retour au premier plan : jeton inconnu du serveur → renouvelé ; au plus toutes les 10 min', async () => {
    const h = harness({ states: [state(grant())], check: [{ ref: 'ffffffffffff', usesLeft: 100 }] });
    h.p.setContext('u1-a1', true);
    await h.flush();
    expect(h.checkServer).toHaveBeenCalledTimes(1);
    expect(h.provision).toHaveBeenCalledTimes(1);
    expect(h.journal.find((j) => j.code === 'GRANT_CHECK')?.detail).toMatchObject({ verdict: 'NOT_ACTIVE' });
    expect(h.journal.find((j) => j.code === 'GRANT_PROVISION')?.detail).toMatchObject({ reason: 'SERVER_NOT_ACTIVE' });
    h.tick(60_000);
    await h.p.trigger('resume', h.state);
    expect(h.checkServer).toHaveBeenCalledTimes(1);
    h.tick(10 * 60_000);
    await h.p.trigger('resume', h.state);
    expect(h.checkServer).toHaveBeenCalledTimes(2);
  });

  it('vérification impossible (réseau) : rien n’est conclu, aucun renouvellement', async () => {
    const h = harness({ states: [state(grant())], check: null });
    h.p.setContext('u1-a1', true);
    await h.flush();
    expect(h.checkServer).toHaveBeenCalledTimes(1);
    expect(h.provision).not.toHaveBeenCalled();
    expect(h.p.getStatus().phase).toBe('ready');
  });

  it('changement d’espace (Duo) : nouveau jeton pour le nouvel espace ; déconnexion : plus rien', async () => {
    const h = harness();
    h.p.setContext('u1-a1', true);
    await h.flush();
    h.p.setContext('u1-a2', true);
    await h.flush();
    expect(h.provision).toHaveBeenCalledTimes(2);
    expect(h.journal.filter((j) => j.code === 'GRANT_PROVISION').at(-1)?.detail).toMatchObject({ trigger: 'account', reason: 'OTHER_ACCOUNT' });
    h.p.setContext(null, true);
    await h.p.trigger('resume', h.state);
    await h.advance(72 * H);
    expect(h.provision).toHaveBeenCalledTimes(2);
    expect(h.p.getStatus().phase).toBe('idle');
  });

  it('déclencheurs simultanés (démarrage + connexion + natif) : une seule demande à la fois', async () => {
    const h = harness();
    h.p.setContext('u1-a1', true);
    void h.p.trigger('start');
    void h.p.trigger('native');
    await h.flush();
    expect(h.provision).toHaveBeenCalledTimes(1);
  });

  it('fonction coupée par le serveur : aucune demande', async () => {
    const h = harness();
    h.p.setContext(null, false);
    await h.p.trigger('start');
    expect(h.provision).not.toHaveBeenCalled();
  });
});

describe('L111P — demande de jeton : motif rendu, session renouvelée sur 401', () => {
  let setGrant: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    setGrant = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('window', { location: { origin: 'https://app.preprod.verebona.fr' }, Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { VerebonaShareImport: { setGrant } } } });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  const body = { token: `vbsi_${'A'.repeat(43)}`, expiresAt: '2026-11-08T12:00:00.000Z', accountKey: 'u1-a1', uploadPath: '/api/mobile/share-import/upload' };
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

  it('401 (cookie d’accès expiré) → renouvellement commun puis UNE nouvelle demande → jeton remis', async () => {
    const { provisionShareGrant, shareImportAvailable } = await import('@/lib/native/share-import');
    expect(shareImportAvailable()).toBe(true);
    const fetchMock = vi.fn().mockResolvedValueOnce(json(401, { code: 'AUTH_REQUIRED' })).mockResolvedValueOnce(json(201, body));
    vi.stubGlobal('fetch', fetchMock);
    const renew = vi.fn(async () => true as const);
    const r = await provisionShareGrant({}, renew);
    expect(r).toMatchObject({ ok: true, code: 'OK' });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(setGrant).toHaveBeenCalledWith(expect.objectContaining({ uploadUrl: 'https://app.preprod.verebona.fr/api/mobile/share-import/upload' }));
  });

  it('rejet du Keychain → KEYCHAIN_WRITE + code natif ; 403 MFA → MFA_REQUIRED ; réseau → NETWORK', async () => {
    const { provisionShareGrant, shareImportAvailable } = await import('@/lib/native/share-import');
    expect(shareImportAvailable()).toBe(true);
    setGrant.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'KEYCHAIN_MISSING_ENTITLEMENT' }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(201, body)));
    expect(await provisionShareGrant({})).toMatchObject({ ok: false, code: 'KEYCHAIN_WRITE', detail: 'KEYCHAIN_MISSING_ENTITLEMENT', retryable: false });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(403, { code: 'MFA_REQUIRED' })));
    expect(await provisionShareGrant({})).toMatchObject({ ok: false, code: 'MFA_REQUIRED', detail: 'HTTP_403:MFA_REQUIRED' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Load failed')));
    expect(await provisionShareGrant({})).toMatchObject({ ok: false, code: 'NETWORK', retryable: true });
  });
});

describe('L111P — journal technique et carte d’état', () => {
  beforeEach(() => {
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('codes seuls : champs hors liste, jetons, noms de fichiers et valeurs longues écartés ; 40 entrées au plus', () => {
    expect(sanitizeShareImportDetail({ outcome: 'OK', token: 'vbsi_x', name: 'Facture.pdf', detail: 'HTTP_401', reason: 'a b c <x>' }))
      .toEqual({ outcome: 'OK', detail: 'HTTP_401' });
    for (let i = 0; i < 50; i += 1) appendShareImportJournal('GRANT_PROVISION', { attempt: i });
    appendShareImportJournal('bad code', {});
    const list = readShareImportJournal();
    expect(list).toHaveLength(40);
    expect(localStorage.getItem(SHARE_IMPORT_JOURNAL_KEY)).not.toMatch(/vbsi_|Facture/);
  });

  it('événements natifs repris une seule fois (préfixe NATIVE_)', () => {
    expect(mergeNativeShareDiagnostics([{ t: 1, c: 'EXT_SHOWN_MISSING_NOT_FOUND', s: 'ext' }, { t: 2, c: 'APP_SETGRANT_MISSING_ENTITLEMENT', s: 'app' }])).toBe(2);
    expect(mergeNativeShareDiagnostics([{ t: 1, c: 'EXT_SHOWN_MISSING_NOT_FOUND', s: 'ext' }])).toBe(0);
    expect(readShareImportJournal().map((e) => e.c)).toEqual(['NATIVE_EXT_SHOWN_MISSING_NOT_FOUND', 'NATIVE_APP_SETGRANT_MISSING_ENTITLEMENT']);
  });

  it('carte : un import en attente d’autorisation décrit ce que fait l’app, jamais « connectez-vous » sans preuve', () => {
    const waiting = { state: 'waiting_auth' as const, message: 'Ouvrez Verebona et connectez-vous pour terminer l’import.' };
    expect(shareFileLine(waiting, { phase: 'provisioning', code: 'REFUSED', nextRetryAt: null })).toBe('En attente de connexion — Autorisation d’import en cours de renouvellement…');
    expect(shareFileLine(waiting, { phase: 'retry_scheduled', code: 'NETWORK', nextRetryAt: 1 })).toMatch(/nouvel essai automatique/);
    expect(shareFileLine(waiting, { phase: 'blocked', code: 'SESSION_UNAVAILABLE', nextRetryAt: null })).toMatch(/Reconnectez-vous/);
    expect(shareFileLine(waiting, null)).toBe('En attente de connexion');
    expect(shareFileLine({ state: 'failed', message: 'Cet espace Verebona est en lecture seule : le document n’a pas été importé.' }, null)).toMatch(/lecture seule/);
  });
});

describe('L111P — intégration (lecture du code)', () => {
  it('le hook passe par l’orchestrateur ; plus d’appel direct « une fois » ; session renouvelée par le client commun', () => {
    const hook = read('src/components/native/useShareImport.ts');
    expect(hook).toMatch(/new ShareGrantProvisioner\(/);
    expect(hook).toMatch(/trigger\('start'/);
    expect(hook).toMatch(/trigger\('resume'/);
    expect(hook).toMatch(/trigger\('native'/);
    expect(hook).toMatch(/setContext\(/);
    expect(hook).toMatch(/apiClient\.refreshToken\(\)/);
    expect(hook).not.toMatch(/needsGrant\(state\.grant/);
  });

  it('route `grant` : GET de vérification sans jeton ; traces expurgées (jamais le jeton)', () => {
    const route = read('src/app/api/mobile/share-import/grant/route.ts');
    expect(route).toMatch(/export async function GET/);
    expect(route).toMatch(/listActiveShareImportGrants/);
    expect(route).toMatch(/share_import\.\$\{event\}/);
    expect(route).not.toMatch(/trace\([^)]*token/);
    const upload = read('src/app/api/mobile/share-import/upload/route.ts');
    expect(upload).toMatch(/share_import\.grant_rejected/);
    expect(upload).not.toMatch(/console\.info\([^)]*token/);
  });
});
