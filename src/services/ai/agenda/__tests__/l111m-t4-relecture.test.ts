/**
 * Lot 111M (ticket « budgets IA », P2 T4, CA-13) — VERIFY_COMPLETION : la
 * preuve n'est plus coupée en silence à 1 000 caractères ; relecture CIBLÉE
 * bornée ; aucune décision définitive sur une preuve lue en partie.
 * Passerelle réelle (contexte structuré T4), fournisseur simulé.
 *
 *  L111M-T4-01  fenêtres successives avec recouvrement (pure), bornes réglables
 *  L111M-T4-02  preuve courte : un seul appel (comportement et coût inchangés)
 *  L111M-T4-03  date de réalisation en FIN d'un long extrait : relue, réalisation prouvée
 *  L111M-T4-04  relecture épuisée avec du texte non lu : `unknown` (EVIDENCE_PARTIALLY_READ), jamais « non réalisé »
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: async () => {},
}));

const { decideCompletion } = await import('../status-reconciler');
const { reconcileStatus } = await import('../status-reconciliation.service');
const { evidenceWindows, t4EvidenceBounds } = await import('../master/verify-completion');
const { FakeProvider, setAiProvider } = await import('../../gateway/providers');
import type { CompletionEvidence } from '../status-reconciler';

const P2 = JSON.parse(readFileSync(join(__dirname, '..', 'master', '__fixtures__', 'p-t4-02-facture-ambigue.json'), 'utf8'));
const ITEM = P2.context.item;
const ev = (excerpt: string): CompletionEvidence => ({ ...(P2.context.evidence as CompletionEvidence), documentDate: new Date(String(P2.context.evidence.documentDate)), excerpt });
const PREUVE = 'Prestation réalisée et acquittée le 14/10/2026.';
const sortie = (evidenceStatus: string) => ({ ...P2.recording.output, evidenceStatus, occurrenceMatch: evidenceStatus === 'proves_completed' ? 'exact' : P2.recording.output.occurrenceMatch, confidence: 'certain' });

let fake: InstanceType<typeof FakeProvider>;
beforeEach(() => { fake = new FakeProvider(); setAiProvider(fake); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); delete process.env.T4_EVIDENCE_MAX_REREADS; });

/** Modèle « honnête » : prouvé si la phrase de preuve figure dans l'extrait transmis, insuffisant sinon. */
const honnete = () => fake.onAny((i) => ({ rawText: JSON.stringify(sortie(i.prompt.includes(PREUVE) ? 'proves_completed' : 'insufficient')), inputTokens: 1, outputTokens: 1 }));

describe('L111M-T4-01 — fenêtres de lecture', () => {
  it('extrait court : une fenêtre ; long : fenêtres consécutives avec recouvrement, rien de perdu', () => {
    expect(evidenceWindows('abc', 1000)).toEqual(['abc']);
    const t = 'x'.repeat(2500);
    const w = evidenceWindows(t, 1000);
    expect(w.length).toBe(3);
    expect(w.every((x) => x.length <= 1000)).toBe(true);
    expect(w.join('').length).toBeGreaterThanOrEqual(t.length);
    expect(t4EvidenceBounds({})).toEqual({ charsPerCall: 1000, maxRereads: 2 });
    expect(t4EvidenceBounds({ T4_EVIDENCE_CHARS_PER_CALL: '5', T4_EVIDENCE_MAX_REREADS: '9' })).toEqual({ charsPerCall: 300, maxRereads: 5 });
  });
});

describe('L111M-T4-02/03/04 — relecture ciblée', () => {
  it('preuve courte : un seul appel', async () => {
    honnete();
    const e = ev(`Facture. ${PREUVE}`);
    expect(decideCompletion(ITEM, e).needsModel).toBe(true);
    const r = await reconcileStatus(ITEM, e, { accountId: 1 });
    expect(fake.calls).toHaveLength(1);
    expect(r.status).toBe('completed');
  });

  it('date de réalisation en fin d’extrait (> 1 000 caractères) : relue, réalisation prouvée (avant : coupée → « non prouvé »)', async () => {
    honnete();
    const e = ev(`${'Conditions de la prestation sans date de réalisation. '.repeat(30)}${PREUVE}`);
    expect(e.excerpt.length).toBeGreaterThan(1600);
    const r = await reconcileStatus(ITEM, e, { accountId: 1 });
    expect(fake.calls.length).toBeGreaterThan(1);
    expect(fake.calls.length).toBeLessThanOrEqual(3);
    expect(r.status).toBe('completed');
  });

  it('relecture épuisée, texte encore non lu : unknown / EVIDENCE_PARTIALLY_READ (jamais une décision définitive)', async () => {
    process.env.T4_EVIDENCE_MAX_REREADS = '1';
    honnete();
    const e = ev(`${'Conditions de la prestation sans date de réalisation. '.repeat(80)}${PREUVE}`);
    const r = await reconcileStatus(ITEM, e, { accountId: 1 });
    expect(fake.calls).toHaveLength(2);
    expect(r).toMatchObject({ status: 'unknown', decision: 'keep', reasonCode: 'EVIDENCE_PARTIALLY_READ' });
  });
});
