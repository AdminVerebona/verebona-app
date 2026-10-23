/**
 * Lot 82C — capture complète à la source : construction de la ligne (pure)
 * et écriture JAMAIS BLOQUANTE, visible et reprise (file locale bornée).
 *
 *   L82C-ROW-01  statuts de contenu : capturé / masqué / aucun envoi / aucune réponse
 *   L82C-ROW-02  pièces jointes par référence : sans paramètre signé, empreinte des données en ligne
 *   L82C-ROW-03  variables sans doublon : valeur longue présente dans le prompt → référence
 *   L82C-ROW-04  essais internes : prompt d'un essai distinct conservé, secret masqué dans l'erreur
 *   L82C-Q-01    échec d'écriture : le traitement n'est pas bloqué, la capture est reprise
 *   L82C-Q-02    reprises épuisées : ligne NOT_CAPTURED motivée (visible), sans contenu
 *   L82C-Q-03    file pleine : abandon motivé, borne respectée
 *   L82C-Q-04    écriture qui ne répond pas : attente bornée
 *   L82C-Q-05    coupure d'urgence AI_CALL_CAPTURE=off : ligne « non capturé (capture désactivée) »
 *   L82C-REF-01  rattachement d'une conversation T2 (clé d'idempotence de l'assistant)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

process.env.DATABASE_URL ??= 'postgres://test-sans-connexion/aucune';
const m = await import('../call-capture');
const { buildCaptureRow, attachmentRef, dedupeVariables, notCapturedRow, recordCallCapture, flushCaptureRetries,
  setCaptureWriterForTests, resetCaptureQueueForTests, captureHealth, subjectRefOfIdempotencyKey, RETRY_DELAYS_MS, RETRY_MAX_ITEMS } = m;
type CaptureRow = import('../call-capture').CaptureRow;

const ctx = { usageEventId: 9, traceId: 't-1', accountId: 7, userId: 3, useCaseCode: 'SOURCE_ANALYSIS', operationCode: 't1_group_upload', model: 'm-a', modelRank: 'primary' };
const base = (over: Partial<Parameters<typeof buildCaptureRow>[1]> = {}) => ({
  origin: 'gateway' as const, callKind: 'analysis' as const,
  sent: [{ kind: 'initial', prompt: 'Analyse ce document.', generationConfig: { temperature: 0 }, outcome: 'SUCCESS' as const }],
  responseRaw: '{"ok":true}', attemptDurationMs: 12, executionElapsedMs: 40, ...over,
});

describe('L82C-ROW — ligne de capture (pure)', () => {
  it('L82C-ROW-01 — statuts : capturé, masqué, aucun envoi, aucune réponse', () => {
    const ok = buildCaptureRow(ctx, base());
    expect(ok).toMatchObject({ capture_status: 'CAPTURED', prompt_status: 'CAPTURED', response_status: 'CAPTURED', prompt_text: 'Analyse ce document.', attempt_duration_ms: 12, execution_elapsed_ms: 40 });
    expect(ok.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
    const masque = buildCaptureRow(ctx, base({ variableMasks: { '[IBAN_MASQUE]': 1 }, responseRaw: 'IBAN FR76 3000 6000 0112 3456 7890 189' }));
    expect(masque).toMatchObject({ prompt_status: 'MASKED', response_status: 'MASKED', response_raw: 'IBAN [IBAN_MASQUE]' });
    expect(masque.masking).toMatchObject({ prompt: { '[IBAN_MASQUE]': 1 }, response: { '[IBAN_MASQUE]': 1 } });
    const refus = buildCaptureRow(ctx, base({ sent: [], responseRaw: null }));
    expect(refus).toMatchObject({ prompt_status: 'NOT_SENT', prompt_text: null, response_status: 'NO_RESPONSE', response_raw: null, messages: [] });
  });

  it('L82C-ROW-02 — pièces jointes : référence sans jeton signé, empreinte des données en ligne, jamais le contenu', () => {
    const a = attachmentRef({ url: 'https://b.s3.amazonaws.com/docs/42.pdf?X-Amz-Signature=SECRET', mimeType: 'application/pdf', displayName: 'f.pdf' }, 0, 'files_api');
    expect(a).toEqual({ index: 0, mimeType: 'application/pdf', displayName: 'f.pdf', storage: 'https://b.s3.amazonaws.com/docs/42.pdf', transport: 'files_api' });
    const inline = attachmentRef({ url: 'chunk', mimeType: 'application/pdf', data: Buffer.from('%PDF-page').toString('base64') }, 1);
    expect(inline).toMatchObject({ inlineBytes: 9, inlineSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(inline)).not.toContain(Buffer.from('%PDF-page').toString('base64'));
    const row = buildCaptureRow(ctx, base({ attachments: [{ url: 'https://x/y.pdf?sig=1', mimeType: 'application/pdf' }] }), () => 'files_api');
    expect(row.messages).toEqual([
      expect.objectContaining({ order: 1, type: 'text', source: 'prompt' }),
      expect.objectContaining({ order: 2, type: 'attachment', attachmentIndex: 0, transport: 'files_api' }),
    ]);
  });

  it('L82C-ROW-03 — variables sans doublon : valeur longue reprise du prompt par référence (sans perte)', () => {
    const long = 'x'.repeat(5000);
    const prompt = `Début ${long} fin`;
    const v = dedupeVariables({ EXTRACTED_CONTENT: long, COURT: 'abc', ABSENT: 'y'.repeat(3000) }, prompt)!;
    expect(v.COURT).toBe('abc');
    expect(v.ABSENT).toBe('y'.repeat(3000));
    expect(v.EXTRACTED_CONTENT).toMatchObject({ $ref: 'prompt', offset: 6, length: 5000 });
    const ref = v.EXTRACTED_CONTENT as { offset: number; length: number };
    expect(prompt.slice(ref.offset, ref.offset + ref.length)).toBe(long);
  });

  it('L82C-ROW-04 — essais internes : prompt distinct conservé, erreur masquée', () => {
    const row = buildCaptureRow(ctx, base({ sent: [
      { kind: 'initial', prompt: 'P1', outcome: 'FAILED', error: 'clé AIzaBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB refusée' },
      { kind: 'schema_rejected_retry', prompt: 'P2', outcome: 'SUCCESS' },
    ] }));
    expect(row.prompt_text).toBe('P2');
    const steps = row.provider_steps as Array<Record<string, unknown>>;
    expect(steps[0]).toMatchObject({ step: 1, kind: 'initial', promptText: 'P1' });
    expect(steps[1].promptText).toBeUndefined();
    expect(String(steps[0].error)).toContain('[CLE_API_MASQUEE]');
  });

  it('notCapturedRow : aucun contenu, motif et nombre de tentatives', () => {
    const r = notCapturedRow(buildCaptureRow(ctx, base()), 'base indisponible', 6);
    expect(r).toMatchObject({ capture_status: 'NOT_CAPTURED', capture_reason: 'base indisponible', capture_attempts: 6, prompt_text: null, response_raw: null, prompt_status: 'NOT_CAPTURED', response_status: 'NOT_CAPTURED' });
  });
});

describe('L82C-Q — écriture jamais bloquante, visible et reprise', () => {
  let ecrites: CaptureRow[];
  beforeEach(() => { ecrites = []; resetCaptureQueueForTests(); delete process.env.AI_CALL_CAPTURE; });
  afterEach(() => { setCaptureWriterForTests(null); resetCaptureQueueForTests(); });

  it('L82C-Q-01 — échec d’écriture : ne lève pas, reprise sans rappeler le modèle', async () => {
    let echecs = 1;
    setCaptureWriterForTests(async (row) => { if (echecs-- > 0) throw Object.assign(new Error('connexion perdue'), { code: '57P01' }); ecrites.push(row); });
    await expect(recordCallCapture(ctx, base())).resolves.toBeUndefined();
    expect(captureHealth()).toMatchObject({ pending: 1, written: 0 });
    expect(await flushCaptureRetries({ force: true })).toBe(1);
    expect(ecrites).toHaveLength(1);
    expect(ecrites[0]).toMatchObject({ capture_status: 'CAPTURED', capture_attempts: 2, prompt_text: 'Analyse ce document.' });
    expect(captureHealth()).toMatchObject({ pending: 0, recovered: 1 });
  });

  it('L82C-Q-02 — reprises épuisées : ligne NOT_CAPTURED motivée, sans contenu', async () => {
    setCaptureWriterForTests(async (row) => { if (row.capture_status === 'CAPTURED') throw new Error('disque plein'); ecrites.push(row); });
    await recordCallCapture(ctx, base());
    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) await flushCaptureRetries({ force: true });
    expect(captureHealth()).toMatchObject({ pending: 0, dropped: 1 });
    expect(ecrites).toHaveLength(1);
    expect(ecrites[0]).toMatchObject({ capture_status: 'NOT_CAPTURED', prompt_text: null, response_raw: null });
    expect(ecrites[0].capture_reason).toMatch(/tentatives d’écriture en échec : .*disque plein/);
  });

  it('L82C-Q-03 — file pleine : abandon motivé, borne respectée', async () => {
    setCaptureWriterForTests(async (row) => { if (row.capture_status === 'CAPTURED') throw new Error('KO'); ecrites.push(row); });
    for (let i = 0; i <= RETRY_MAX_ITEMS; i++) await recordCallCapture(ctx, base());
    await new Promise((r) => setTimeout(r, 0));
    expect(captureHealth().pending).toBe(RETRY_MAX_ITEMS);
    expect(ecrites.filter((r) => /file de reprise pleine/.test(String(r.capture_reason)))).toHaveLength(1);
  });

  it('L82C-Q-04 — écriture qui ne répond pas : le traitement attend au plus 1,5 s', async () => {
    setCaptureWriterForTests(() => new Promise(() => { /* jamais résolue */ }));
    const t0 = Date.now();
    await recordCallCapture(ctx, base());
    expect(Date.now() - t0).toBeLessThan(2_500);
  });

  it('L82C-Q-05 — coupure d’urgence : ligne « non capturé (capture désactivée) »', async () => {
    process.env.AI_CALL_CAPTURE = 'off';
    setCaptureWriterForTests(async (row) => { ecrites.push(row); });
    await recordCallCapture(ctx, base());
    expect(ecrites).toEqual([expect.objectContaining({ capture_status: 'NOT_CAPTURED', capture_reason: expect.stringMatching(/AI_CALL_CAPTURE=off/), prompt_text: null })]);
  });
});

describe('L82C-REF — rattachement pour suppression ciblée', () => {
  it('L82C-REF-01 — conversation T2 de la clé d’idempotence de l’assistant', () => {
    expect(subjectRefOfIdempotencyKey('assistant:c55:abc')).toBe('t2-conversation:55');
    expect(subjectRefOfIdempotencyKey('assistant:c55:abc:escalation')).toBe('t2-conversation:55');
    expect(subjectRefOfIdempotencyKey('t1:42')).toBeNull();
    expect(subjectRefOfIdempotencyKey(undefined)).toBeNull();
  });
});
