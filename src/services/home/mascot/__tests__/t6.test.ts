/**
 * T6 — contrat, validation, cache, repli (CDC Mascotte §13, §14, §19, recette T6-01 à T6-06,
 * CACHE-01 à CACHE-04, BO-01, BO-02, UI-01, UI-02, LOG-02).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const execute = vi.fn();
const unsafe = vi.fn(async (_sql: string, _p?: unknown[]): Promise<unknown[]> => []);
vi.mock('@/services/ai/gateway/ai-gateway', () => ({ AiGateway: { execute: (r: unknown) => execute(r) } }));
vi.mock('@/db', () => ({ pgClient: { unsafe: (s: string, p: unknown[]) => unsafe(s, p) } }));
vi.mock('@/services/ai/config/config-resolver', () => ({ resolveOperationConfig: async () => ({ promptPreamble: 'voix', configVersionId: 3 }) }));
vi.mock('@/services/ai/prompts/prompt-loader', () => ({ resolvePrompt: async () => ({ text: '', version: 'mascot_t6_v1@file' }) }));
vi.mock('@/services/ai/queue/job-queue.repository', () => ({ canStart: async () => true }));

const { buildT6Input, validateT6Output } = await import('../t6-contract');
const { formulateWithT6, t6CacheKey, resetT6Breaker } = await import('../t6-runner');
const { greetingWord } = await import('@/lib/mascot-greeting');

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const subject = (id: string, facts: Record<string, string | number | boolean | null>, fallbackText: string) => ({
  subjectId: id, sourceFamily: 'DATE' as const, sourceCode: 'DATE-NEXT' as const, accountId: 7,
  priority: null, requiresAttention: false, intent: 'deadline' as const, facts, actions: [],
  fallbackText, allowedHighlight: '15 octobre 2026', occurrenceKey: id, dedupeKeys: [], secondaryLabel: '',
});

const input = buildT6Input([
  subject('DATE-NEXT:1', { title: 'Ramonage', dateLabel: '15 octobre 2026', date: '2026-10-15', dateNature: 'confirmée' },
    'Votre prochaine échéance est « Ramonage », le 15 octobre 2026.'),
]);
const deux = buildT6Input([
  subject('DATE-NEXT:1', { title: 'Ramonage', dateLabel: '15 octobre 2026', date: '2026-10-15', dateNature: 'confirmée' },
    'Votre prochaine échéance est « Ramonage », le 15 octobre 2026.'),
  { ...subject('ATP:x', { question: 'Quel est le type ?' }, 'Quel est le type ?'), sourceCode: 'ATP-DOC-TYP' as const },
]);
const ok = (text = 'Votre prochain rendez-vous, le ramonage, est fixé au 15 octobre 2026.', highlight: string | null = '15 octobre 2026') =>
  ({ schemaVersion: 't6-output-v1', messages: [{ subjectId: 'DATE-NEXT:1', text, highlight }] });

describe('validation de sortie (T6-011, JSON-001 à JSON-003)', () => {
  it('T6-01 — un sujet, un paragraphe, aucun fait ajouté', () => {
    expect(validateT6Output(input, ok())).toMatchObject({ ok: true });
    expect(validateT6Output(input, ok('Votre ramonage du 15 octobre 2026 coûtera 120 euros.'))).toEqual({ ok: false, reason: 'invented_number:0' });
  });

  it('T6-02 — deux sujets : deux paragraphes, même ordre', () => {
    const bon = { messages: [
      { subjectId: 'DATE-NEXT:1', text: 'Le ramonage est prévu le 15 octobre 2026.' },
      { subjectId: 'ATP:x', text: 'Pouvez-vous préciser le type de ce document ?' },
    ] };
    expect(validateT6Output(deux, bon)).toMatchObject({ ok: true });
    expect(validateT6Output(deux, { messages: [...bon.messages].reverse() })).toEqual({ ok: false, reason: 'order:0' });
    expect(validateT6Output(deux, { messages: [bon.messages[0]] })).toEqual({ ok: false, reason: 'count' });
  });

  it('T6-03 — une action inventée ne crée jamais de bouton', () => {
    const r = validateT6Output(input, { ...ok(), actions: [{ label: 'Payer' }], messages: [{ ...ok().messages[0], action: 'x' }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.messages[0])).toEqual(['subjectId', 'text', 'highlight']);
  });

  it('T6-04 — date relative : sortie invalide', () => {
    expect(validateT6Output(input, ok('Le ramonage a lieu demain, le 15 octobre 2026.'))).toEqual({ ok: false, reason: 'relative_date:0' });
    expect(validateT6Output(input, ok('Le ramonage a lieu dans trois jours.', null))).toEqual({ ok: false, reason: 'relative_date:0' });
  });

  it('T6-06 — JSON invalide, tutoiement, emoji : invalides', () => {
    expect(validateT6Output(input, 'pas du json')).toEqual({ ok: false, reason: 'schema' });
    expect(validateT6Output(input, ok('Ton ramonage est fixé au 15 octobre 2026.')).ok).toBe(false);
    expect(validateT6Output(input, ok('Ramonage le 15 octobre 2026 🔥 pensez-y.')).ok).toBe(false);
    // JSON-002 : une mise en valeur absente du texte (ou vide) est abandonnée, pas le texte.
    const r = validateT6Output(input, ok(undefined, 'le 16 octobre'));
    expect(r.ok && r.messages[0].highlight).toBe(null);
    const vide = validateT6Output(input, ok(undefined, ''));
    expect(vide.ok && vide.messages[0].highlight).toBe(null);
  });

  it('DAT-003 — une date prévisionnelle présentée comme certaine est rejetée', () => {
    const prev = buildT6Input([subject('DATE-NEXT:1', { dateLabel: '15 octobre 2026', dateNature: 'prévisionnelle' }, 'Prévue autour du 15 octobre 2026.')]);
    expect(validateT6Output(prev, ok('Le ramonage aura lieu le 15 octobre 2026.', null)).ok).toBe(false);
    expect(validateT6Output(prev, ok('Le ramonage est prévu autour du 15 octobre 2026.', null)).ok).toBe(true);
  });
});

describe('cache (RUN-003 à RUN-006)', () => {
  it('CACHE-01 — même compte, même contexte : même clé (Duo), sans prénom', () => {
    expect(t6CacheKey({ accountId: 7, input, promptVersion: 'v1' })).toBe(t6CacheKey({ accountId: 7, input, promptVersion: 'v1' }));
    expect(t6CacheKey({ accountId: 8, input, promptVersion: 'v1' })).not.toBe(t6CacheKey({ accountId: 7, input, promptVersion: 'v1' }));
    expect(JSON.stringify(input)).not.toMatch(/prénom|firstName|Bonjour|Bonsoir/);
  });

  it('CACHE-02 — nouvelle version du prompt : nouvelle clé', () => {
    expect(t6CacheKey({ accountId: 7, input, promptVersion: 'v2' })).not.toBe(t6CacheKey({ accountId: 7, input, promptVersion: 'v1' }));
  });

  it('CACHE-04 — une génération tardive écrit sous SA clé (jamais celle d’un contexte plus récent)', () => {
    const src = read('src/services/home/mascot/t6-runner.ts');
    expect(src).toMatch(/ON CONFLICT \(account_id, cache_key\) DO NOTHING/);
    expect(read('src/components/home/useMascotPresentation.ts')).toMatch(/if \(mine !== seq\.current\) return; \/\/ réponse obsolète/);
  });
});

describe('exécution et repli (RUN-001, RUN-002, BO-006, BO-007)', () => {
  const deps = (over: Partial<Parameters<typeof formulateWithT6>[1]> = {}) => ({
    flagEnabled: () => true, treatmentAvailable: async () => true, promptVersion: async () => 'v1', ...over,
  });
  const p = { accountId: 7, input, contextHash: 'h', mode: 'display' as const };

  beforeEach(() => { execute.mockReset(); unsafe.mockClear(); resetT6Breaker(); });

  it('formule, valide et met en cache', async () => {
    execute.mockResolvedValue({ data: ok(), model: 'm', usedFallback: false, costMicros: 1, traceId: 't' });
    const o = await formulateWithT6(p, deps());
    expect(o.status).toBe('generated');
    expect(o.messages?.[0].text).toContain('15 octobre 2026');
    expect(unsafe.mock.calls.some(([sql]) => /INSERT INTO home_mascot_cache/.test(sql))).toBe(true);
  });

  it('T6-05 — délai dépassé : repli immédiat, un seul appel', async () => {
    vi.useFakeTimers();
    execute.mockImplementation(() => new Promise(() => {}));
    const run = formulateWithT6({ ...p, contextHash: 'lent' }, deps());
    await vi.advanceTimersByTimeAsync(7_000);
    const o = await run;
    vi.useRealTimers();
    expect(o.messages).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('T6-06 — sortie invalide : repli + statut validation_failed', async () => {
    execute.mockResolvedValue({ data: ok('Demain, ramonage.', null), model: 'm', usedFallback: false, costMicros: 0, traceId: 't' });
    const o = await formulateWithT6({ ...p, input: buildT6Input([{ ...subject('DATE-NEXT:1', {}, 'x'), subjectId: 'DATE-NEXT:1' }]) }, deps());
    expect(o).toMatchObject({ status: 'validation_failed', messages: null });
  });

  it('BO-01 / BO-02 — T6 désactivé ou arrêt d’urgence : aucun appel', async () => {
    const o = await formulateWithT6(p, deps({ treatmentAvailable: async () => false }));
    expect(o).toMatchObject({ status: 'disabled', messages: null });
    expect(execute).not.toHaveBeenCalled();
  });

  it('bascule de recette (MIG-007) : drapeau coupé, déterministe seul', async () => {
    const o = await formulateWithT6(p, deps({ flagEnabled: () => false }));
    expect(o.status).toBe('skipped');
    expect(execute).not.toHaveBeenCalled();
  });

  it('BO-007 — disjoncteur : après trois échecs, plus d’appel', async () => {
    execute.mockRejectedValue(new Error('provider'));
    for (let i = 0; i < 3; i++) await formulateWithT6({ ...p, contextHash: `c${i}`, input: buildT6Input([subject(`DATE-NEXT:${i}`, {}, 'Texte de secours assez long.')]) }, deps());
    execute.mockClear();
    const o = await formulateWithT6({ ...p, input: buildT6Input([subject('DATE-NEXT:9', {}, 'Texte de secours assez long.')]) }, deps());
    expect(o.status).toBe('disabled');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('salutation (UX-002, MIG-004)', () => {
  it('UI-01 — 17:59 : Bonjour ; UI-02 — 18:00 : Bonsoir', () => {
    expect(greetingWord(new Date(2026, 8, 25, 17, 59))).toBe('Bonjour');
    expect(greetingWord(new Date(2026, 8, 25, 18, 0))).toBe('Bonsoir');
  });
});

describe('télémétrie et gouvernance', () => {
  it('la migration rend T6 promouvable (niveau de raisonnement renseigné)', () => {
    const sql = read('src/db/migrations/0166_home_mascot_t6.sql');
    expect(sql).toMatch(/reasoning_primary/);
    expect(sql).toMatch(/'minimal', 'minimal', 1024/);
  });

  it('RUN-001 — même contexte : le texte affiché n’est pas remplacé', () => {
    expect(read('src/components/home/useMascotPresentation.ts'))
      .toMatch(/prev && prev\.contextHash === data\.contextHash \? prev : data/);
  });

  it('LOG-02 — un seul « affiché » par occurrence et par visite', () => {
    expect(read('src/db/migrations/0166_home_mascot_t6.sql'))
      .toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS home_mascot_events_displayed_uidx\s+ON home_mascot_events \(visit_id, occurrence_key\)\s+WHERE event_type = 'displayed'/);
  });

  it('LOG-01 — pré-génération : aucune télémétrie d’exposition', () => {
    const src = read('src/services/home/mascot/mascot.service.ts');
    expect(src).not.toMatch(/recordMascotEvents/);
  });

  it('MIG-002 — plus de message concurrent dans le résumé de l’accueil', () => {
    const src = read('src/services/home/HomeSummaryService.ts');
    expect(src).not.toMatch(/richMessage\??:|let situationMessage|message: situationMessage/);
  });

  it('le prompt T6 porte le contrat : un paragraphe par sujet, dates absolues, vouvoiement', () => {
    const p = read('src/services/ai/prompts/mascot/mascot_t6_v1.txt');
    for (const s of ['{{INPUT_JSON}}', '"t6-output-v1"', '"messages"', '"subjectId"', '"highlight"', 'Vouvoiement', 'Aucun emoji']) expect(p).toContain(s);
  });
});
