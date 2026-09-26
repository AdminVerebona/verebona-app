/**
 * Invitation Premium Duo — parcours de l'invité (voir `lib/duo/pending-duo-join.ts`).
 *
 *   - la page `/duo/join/[token]` transmet le jeton à `GET /api/duo/join`
 *     (il manquait : « Lien invalide » pour tous) ;
 *   - l'invitation est mémorisée avant inscription/connexion puis consommée
 *     une fois connecté (page ou accueil) ;
 *   - `POST /api/duo/join` refuse un compte dont l'adresse n'est pas celle
 *     invitée.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const FUTURE = new Date(Date.now() + 86_400_000);
let duoRow: Record<string, unknown> | null = null;
const writes: string[] = [];

vi.mock('@/db', async () => {
  const { getTableName } = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  const select = () => {
    let table = '';
    const c: Record<string, unknown> = {
      from: (t: never) => { table = getTableName(t); return c; },
      where: () => c,
      limit: async () => (table === 'duo_accounts' ? (duoRow ? [duoRow] : []) : []),
    };
    return c;
  };
  const write = (kind: string) => (t: never) => {
    writes.push(`${kind}:${getTableName(t)}`);
    const c: Record<string, unknown> = {};
    for (const m of ['values', 'set', 'where']) c[m] = () => c;
    c.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res);
    return c;
  };
  return { db: { select, insert: write('insert'), update: write('update') } };
});
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async (req: NextRequest) => {
      const email = req.headers.get('x-test-email');
      if (!email) throw new Error('AUTH_REQUIRED');
      return { userId: 5, email };
    },
    handleSessionError: (e: Error) => new Response(JSON.stringify({ code: e.message }), { status: 401 }),
  },
}));

const { GET, POST } = await import('../join/route');

const post = (email: string | null) => new NextRequest('http://x/api/duo/join', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(email ? { 'x-test-email': email } : {}) },
  body: JSON.stringify({ token: 'tok' }),
});

beforeEach(() => {
  writes.length = 0;
  duoRow = {
    id: 3, billingOwnerUserId: 1, pendingInviteEmail: 'Invite@Exemple.fr',
    pendingInviteTokenExpiresAt: FUTURE, subscriptionStatus: 'ACTIVE',
  };
});

describe('page /duo/join/[token]', () => {
  const PAGE = readFileSync(join(process.cwd(), 'src/app/duo/join/[token]/page.tsx'), 'utf8');

  it('vérifie le lien AVEC le jeton', () => {
    expect(PAGE).toMatch(/\/api\/duo\/join\?token=\$\{encodeURIComponent\(token\)\}/);
  });

  it('mémorise l’invitation avant inscription ou connexion, et la consomme une fois connecté', () => {
    expect(PAGE).toContain('rememberPendingDuoJoin(token)');
    expect(PAGE).toContain('/login?returnUrl=');
    const ACCUEIL = readFileSync(join(process.cwd(), 'src/app/(dashboard)/accueil/page.tsx'), 'utf8');
    expect(ACCUEIL).toContain('takePendingDuoJoin()');
  });
});

describe('GET /api/duo/join', () => {
  it('sans jeton : 400 MISSING_TOKEN (d’où l’ancien « Lien invalide »)', async () => {
    expect((await GET(new NextRequest('http://x/api/duo/join'))).status).toBe(400);
  });

  it('avec le jeton : invitation valide', async () => {
    const res = await GET(new NextRequest('http://x/api/duo/join?token=tok'));
    expect(res.status).toBe(200);
    expect((await res.json()).valid).toBe(true);
  });
});

describe('POST /api/duo/join', () => {
  it('compte de l’adresse invitée (casse ignorée) : rattaché', async () => {
    const res = await POST(post('invite@exemple.fr'));
    expect(res.status).toBe(200);
    expect(writes).toContain('insert:duo_memberships');
  });

  it('autre adresse : 403 INVITE_EMAIL_MISMATCH, aucune écriture', async () => {
    const res = await POST(post('intrus@exemple.fr'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('INVITE_EMAIL_MISMATCH');
    expect(writes).toEqual([]);
  });

  it('sans session : refusé', async () => {
    expect((await POST(post(null))).status).toBe(401);
  });
});

describe('invitation mémorisée (stockage local)', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('usage unique : retirée à la première lecture', async () => {
    const m = await import('@/lib/duo/pending-duo-join');
    m.rememberPendingDuoJoin('tok');
    expect(m.peekPendingDuoJoin()).toBe('tok');
    expect(m.takePendingDuoJoin()).toBe('tok');
    expect(m.takePendingDuoJoin()).toBeNull();
  });
});
