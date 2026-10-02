/**
 * Reliquat R5 (CDC 15 §26) — branche TEMPORAL_AMBIGUITY de t4_master.
 *
 *   · détection (pure) : lecture mm/jj contraire à la convention française,
 *     mention relative sans date complète ;
 *   · appel dès qu'une date est incertaine (lot 16b-2 : master T4 seul,
 *     AI_T4_EFFECTS retiré) ;
 *   · candidat certain de la liste → appliqué ; abstention, hors liste ou
 *     échec → décision `propose` TEMPORAL_AMBIGUITY avec les dates possibles.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectTemporalAmbiguity, interpretDate } from '../rules/date-interpreter';
import { resoudreAmbiguiteTemporelle, __resetTemporalCacheForTests, cleCacheTemporel } from '../agenda-intelligence.service';
import { translateTemporalAmbiguity, temporalAmbiguityVariables } from '../master/temporal-ambiguity';
import { AGENDA_PROPOSAL_REASONS } from '@/services/to-process/agenda-proposal-cards';

describe('detectTemporalAmbiguity', () => {
  it('jj/mm ↔ mm/jj : signalée seulement si l’extraction a retenu la lecture mm/jj (les deux dates valides)', () => {
    expect(detectTemporalAmbiguity('2027-03-04', 'Prochain entretien le 03/04/2027')).toEqual({
      kind: 'DAY_MONTH_ORDER', dates: ['2027-03-04', '2027-04-03'], mention: '03/04/2027',
    });
    // Lecture française retenue : pas d'ambiguïté à trancher (pas d'appel pour chaque date ≤ 12).
    expect(detectTemporalAmbiguity('2027-04-03', 'Prochain entretien le 03/04/2027')).toBeNull();
    // Jour > 12 : une seule lecture possible.
    expect(detectTemporalAmbiguity('2027-05-15', 'Échéance : 15/05/2027')).toBeNull();
    // Même jour et mois : identique dans les deux lectures.
    expect(detectTemporalAmbiguity('2027-05-05', 'le 05/05/2027')).toBeNull();
    // Année sur deux chiffres.
    expect(detectTemporalAmbiguity('2027-03-04', 'avant le 03.04.27')).toMatchObject({ kind: 'DAY_MONTH_ORDER', dates: ['2027-03-04', '2027-04-03'] });
  });

  it('mention relative sans date complète → une date incertaine', () => {
    expect(detectTemporalAmbiguity('2027-03-31', 'Ramonage à faire avant fin mars.')).toEqual({
      kind: 'RELATIVE_MENTION', dates: ['2027-03-31'], mention: 'avant fin mars',
    });
    expect(detectTemporalAmbiguity('2027-03-30', 'Prochaine visite dans six mois')).toMatchObject({ kind: 'RELATIVE_MENTION' });
    expect(detectTemporalAmbiguity('2026-10-30', 'Paiement sous 30 jours')).toMatchObject({ kind: 'RELATIVE_MENTION' });
    // Date complète présente : la mention relative n'est qu'un commentaire.
    expect(detectTemporalAmbiguity('2027-03-31', 'avant fin mars, soit le 31/03/2027')).toBeNull();
    expect(detectTemporalAmbiguity('2027-03-31', 'avant le 31 mars 2027')).toBeNull();
    // Rien de relatif : « fin de garantie » n'est pas une mention de mois.
    expect(detectTemporalAmbiguity('2028-12-31', 'Fin de garantie constructeur')).toBeNull();
    expect(detectTemporalAmbiguity('2027-03-31', '')).toBeNull();
    expect(detectTemporalAmbiguity(null, 'avant fin mars')).toBeNull();
  });

  it('interpretDate inchangé (comportement historique)', () => {
    expect(interpretDate('2027-03-04', new Date('2026-10-01T00:00:00Z'))).toMatchObject({ qualification: 'explicit', iso: '2027-03-04' });
  });
});

describe('resoudreAmbiguiteTemporelle', () => {
  beforeEach(() => __resetTemporalCacheForTests());
  const cand = { title: 'Prochain entretien', date: '2027-03-04', confidence: 'certain' as const, excerpt: 'Prochain entretien le 03/04/2027', originFieldKey: 'maintenanceDueDate' };
  const input = { accountId: 1, userId: 2, sourceFileId: 55 };

  it('date certaine : aucun appel, candidat inchangé', async () => {
    const resolve = vi.fn();
    const certain = { ...cand, date: '2027-05-15', excerpt: 'le 15/05/2027' };
    expect(await resoudreAmbiguiteTemporelle(certain, input, { resolve })).toEqual({ kind: 'keep', candidate: certain });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('candidat certain de la liste → date appliquée', async () => {
    const resolve = vi.fn(async (_ctx: unknown, c: Array<{ candidateId: number; date: string; interpretation: string }>) => ({ chosen: c[1], warning: null }));
    const r = await resoudreAmbiguiteTemporelle(cand, input, { resolve: resolve as never });
    expect(r).toEqual({ kind: 'keep', candidate: { ...cand, date: '2027-04-03' } });
    const [ctx, candidats, appel] = resolve.mock.calls[0] as unknown as [Record<string, unknown>, Array<{ date: string }>, Record<string, unknown>];
    expect(candidats.map((c) => c.date)).toEqual(['2027-03-04', '2027-04-03']);
    expect(ctx).toMatchObject({ extractedDate: '2027-03-04', kind: 'DAY_MONTH_ORDER', mention: '03/04/2027' });
    expect(appel).toEqual({ accountId: 1, userId: 2, sourceFileId: 55 });
  });

  it('abstention, hors liste ou échec → proposition TEMPORAL_AMBIGUITY avec les dates possibles, aucune création', async () => {
    const resolve = vi.fn(async () => ({ chosen: null, warning: 'UNKNOWN_CANDIDATE_ID:9' }));
    const r = await resoudreAmbiguiteTemporelle(cand, input, { resolve: resolve as never });
    expect(r).toMatchObject({
      kind: 'propose',
      decision: { action: 'propose', reasonCode: 'TEMPORAL_AMBIGUITY', date: '2027-03-04', temporalCandidates: ['2027-03-04', '2027-04-03'], sourceFileId: 55, deterministic: false },
    });
    expect(AGENDA_PROPOSAL_REASONS.has('TEMPORAL_AMBIGUITY')).toBe(true);
  });
});

describe('traduction (monde fermé U1)', () => {
  const c = [{ candidateId: 1, date: '2027-03-04', interpretation: 'a' }, { candidateId: 2, date: '2027-04-03', interpretation: 'b' }];
  it('choix probable dans la liste → retenu ; hors liste ou ambigu → aucun', () => {
    expect(translateTemporalAmbiguity({ task: 'TEMPORAL_AMBIGUITY', decision: 'choose', candidateId: 2, confidence: 'probable', reason: 'x' }, c).chosen?.date).toBe('2027-04-03');
    expect(translateTemporalAmbiguity({ task: 'TEMPORAL_AMBIGUITY', decision: 'choose', candidateId: 9, confidence: 'probable', reason: 'x' }, c)).toMatchObject({ chosen: null, warning: 'UNKNOWN_CANDIDATE_ID:9' });
    expect(translateTemporalAmbiguity({ task: 'TEMPORAL_AMBIGUITY', decision: 'choose', candidateId: 1, confidence: 'ambiguous', reason: 'x' }, c).chosen).toBeNull();
  });
  it('variables : candidats triés, autres variables du master à null', () => {
    const v = temporalAmbiguityVariables({ title: 't' }, [c[1], c[0]]);
    expect((v.TEMPORAL_CANDIDATES as Array<{ candidateId: number }>).map((x) => x.candidateId)).toEqual([1, 2]);
    expect(v.EVENT_CONTEXT).toBeNull();
  });
});

describe('R5 — coût : mentions relatives sans modèle, cache des arbitrages', () => {
  const cand = { title: 'Prochain entretien', date: '2027-03-04', confidence: 'certain' as const, excerpt: 'Prochain entretien le 03/04/2027', originFieldKey: 'maintenanceDueDate' };
  const input = { accountId: 1, userId: 2, sourceFileId: 55 };
  beforeEach(() => __resetTemporalCacheForTests());

  it('mention relative : aucun appel modèle, proposition TEMPORAL_AMBIGUITY avec la date déduite', async () => {
    const resolve = vi.fn();
    const rel = { title: 'Paiement', date: '2026-10-31', confidence: 'certain' as const, excerpt: 'Paiement sous 30 jours' };
    const r = await resoudreAmbiguiteTemporelle(rel, input, { resolve });
    expect(resolve).not.toHaveBeenCalled();
    expect(r).toMatchObject({ kind: 'propose', decision: { reasonCode: 'TEMPORAL_AMBIGUITY', temporalCandidates: ['2026-10-31'], deterministic: true } });
  });

  it('même source, même clé, même extrait : un seul appel ; autre source ou autre extrait : nouvel appel', async () => {
    const resolve = vi.fn(async () => ({ chosen: null, warning: null }));
    const go = (c = cand, i = input) => resoudreAmbiguiteTemporelle(c, i, { resolve: resolve as never });
    await go(); await go();
    expect(resolve).toHaveBeenCalledTimes(1);
    await go(cand, { ...input, sourceFileId: 56 });
    await go({ ...cand, excerpt: 'Entretien conseillé le 03/04/2027' });
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(cleCacheTemporel(cand, 55)).not.toBe(cleCacheTemporel({ ...cand, originFieldKey: 'lastRevision' }, 55));
  });

  it('échec du modèle : pas mis en cache (réessai à la prochaine analyse)', async () => {
    const resolve = vi.fn(async () => ({ chosen: null, warning: 'MODEL_UNAVAILABLE' }));
    await resoudreAmbiguiteTemporelle(cand, input, { resolve: resolve as never });
    await resoudreAmbiguiteTemporelle(cand, input, { resolve: resolve as never });
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
