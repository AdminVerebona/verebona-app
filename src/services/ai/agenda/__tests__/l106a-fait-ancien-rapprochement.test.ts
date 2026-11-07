/**
 * Lot 106A — cause DÉMONTRÉE (ticket « Agenda — doublons DPE ») : un fait de
 * plus de cinq ans sortait de T4 en `propose` DATE_OUT_OF_RANGE AVANT la
 * comparaison aux événements existants et AVANT le droit de création de la
 * source. Désormais : doublon certain → jamais recréé ; source non autorisée
 * (compromis) → proposition, jamais un élément ; sinon comportement inchangé.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../gateway/ai-gateway', () => ({ AiGateway: { execute: vi.fn(async () => { throw new Error('pas de modèle'); }) } }));
import { processAgendaCandidates } from '../agenda-intelligence.service';
import type { ExistingAgendaItem } from '../types';
import { t4Simule } from './support/t4-simule';

const existant: ExistingAgendaItem = { id: 102, title: 'DPE réalisé — DPE', date: '2020-12-22', category: 'information', manual: false, originFieldKey: 'dpeDate', nature: 'CONFIRMED' };
const candidat = (o: Record<string, unknown> = {}) => ({
  title: 'DPE réalisé — Maison', date: '2020-12-22', confidence: 'certain', excerpt: 'DPE réalisé le 22/12/2020', originFieldKey: 'dpeDate',
  nature: 'HISTORICAL', businessType: 'dpe', target: { type: 'ASSET', id: 14 }, occurrence: 'single', sourceFileId: 316, documentType: 'COMPROMIS_VENTE',
  mayCreateAgenda: false, sources: [{ fileId: 316, role: 'SOURCE' }], ...o,
});
const traiter = (c: Record<string, unknown>, existing: ExistingAgendaItem[]) =>
  processAgendaCandidates({ accountId: 13, assetId: 14, candidates: [c as never], existing, sourceFileId: Number(c.sourceFileId), decide: t4Simule });

describe('L106A-U-T4-FAIT-ANCIEN — rapprochement et droit de création avant la qualification « hors plage »', () => {
  it('doublon certain (même champ d’origine, même date) d’un fait de 2020 : jamais recréé (skip_duplicate)', async () => {
    const [d] = await traiter(candidat(), [existant]);
    expect(d).toMatchObject({ action: 'skip_duplicate', reasonCode: 'EXACT_DUPLICATE', existingItemId: 102 });
  });

  it('source non autorisée à créer (compromis) sans élément existant : proposition (carte), jamais un élément', async () => {
    const [d] = await traiter(candidat(), []);
    expect(d).toMatchObject({ action: 'propose', reasonCode: 'SOURCE_TYPE_NOT_AUTHORIZED' });
  });

  it('source autorisée, aucun existant : comportement inchangé (propose DATE_OUT_OF_RANGE, à qualifier)', async () => {
    const [d] = await traiter(candidat({ sourceFileId: 309, documentType: 'DIAGNOSTIC', mayCreateAgenda: true, title: 'DPE réalisé — DPE' }), []);
    expect(d).toMatchObject({ action: 'propose', reasonCode: 'DATE_OUT_OF_RANGE' });
  });

  it('une prévision existante n’est jamais traitée comme doublon certain d’un fait ancien', async () => {
    const [d] = await traiter(candidat({ mayCreateAgenda: true }), [{ ...existant, nature: 'FORECAST' }]);
    expect(d.action).toBe('propose');
  });
});
