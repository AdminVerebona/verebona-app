/**
 * Non-régression du résolveur de références (relecture lot 17). Lot 16b-2 :
 * lecture canonique seule (ASSISTANT_CANONICAL_READ retiré). Chaque message ×
 * contexte rend ce que rendait le tag `lot16` (attendus figés), SAUF les
 * ajouts E2E-T2-12 (« son statut », « son état », « est-il réalisé ? » sur
 * une échéance choisie), désormais toujours actifs.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolveThreadReference } from '../core/reference-resolver';

const DOCS = [1, 2, 3].map((i) => ({ position: i, type: 'document' as const, id: i * 100, label: `D${i}` }));
const base = { conversationId: 1, messages: [], currentAssetId: null, currentDocumentId: null, pendingClarification: null };
const CTX = {
  liste: { ...base, presentedLists: [DOCS], lastPresentedEntities: DOCS, lastSelected: null },
  selDoc: { ...base, presentedLists: [DOCS], lastPresentedEntities: DOCS, lastSelected: { type: 'document' as const, id: 200 } },
  selAgenda: { ...base, presentedLists: [], lastPresentedEntities: [], lastSelected: { type: 'agenda_item' as const, id: 77 } },
  unique: { ...base, presentedLists: [[DOCS[0]]], lastPresentedEntities: [DOCS[0]], lastSelected: null },
  vide: { ...base, presentedLists: [], lastPresentedEntities: [], lastSelected: null },
} as const;

/** [message, contexte, résultat du tag lot16] */
const LOT16: Array<[string, keyof typeof CTX, unknown]> = [["Quel est son statut ?","liste",{"kind": "none"}],["Quel est son statut ?","selDoc",{"kind": "none"}],["Quel est son statut ?","selAgenda",{"kind": "none"}],["Quel est son statut ?","unique",{"kind": "none"}],["Quel est son statut ?","vide",{"kind": "none"}],["Et son état ?","liste",{"kind": "none"}],["Et son état ?","selDoc",{"kind": "none"}],["Et son état ?","selAgenda",{"kind": "none"}],["Et son état ?","unique",{"kind": "none"}],["Et son état ?","vide",{"kind": "none"}],["Quel est l’état de sa facture ?","liste",{"kind": "none"}],["Quel est l’état de sa facture ?","selDoc",{"kind": "none"}],["Quel est l’état de sa facture ?","selAgenda",{"kind": "none"}],["Quel est l’état de sa facture ?","unique",{"kind": "none"}],["Quel est l’état de sa facture ?","vide",{"kind": "none"}],["Est-il réalisé ?","liste",{"kind": "none"}],["Est-il réalisé ?","selDoc",{"kind": "none"}],["Est-il réalisé ?","selAgenda",{"kind": "none"}],["Est-il réalisé ?","unique",{"kind": "none"}],["Est-il réalisé ?","vide",{"kind": "none"}],["A-t-il été fait ?","liste",{"kind": "none"}],["A-t-il été fait ?","selDoc",{"kind": "none"}],["A-t-il été fait ?","selAgenda",{"kind": "none"}],["A-t-il été fait ?","unique",{"kind": "none"}],["A-t-il été fait ?","vide",{"kind": "none"}],["Est-elle faite ?","liste",{"kind": "none"}],["Est-elle faite ?","selDoc",{"kind": "none"}],["Est-elle faite ?","selAgenda",{"kind": "none"}],["Est-elle faite ?","unique",{"kind": "none"}],["Est-elle faite ?","vide",{"kind": "none"}],["Le contrôle technique de la Clio est-il passé ?","liste",{"kind": "none"}],["Le contrôle technique de la Clio est-il passé ?","selDoc",{"kind": "none"}],["Le contrôle technique de la Clio est-il passé ?","selAgenda",{"kind": "none"}],["Le contrôle technique de la Clio est-il passé ?","unique",{"kind": "none"}],["Le contrôle technique de la Clio est-il passé ?","vide",{"kind": "none"}],["Mon assurance habitation est-elle à jour ?","liste",{"kind": "none"}],["Mon assurance habitation est-elle à jour ?","selDoc",{"kind": "none"}],["Mon assurance habitation est-elle à jour ?","selAgenda",{"kind": "none"}],["Mon assurance habitation est-elle à jour ?","unique",{"kind": "none"}],["Mon assurance habitation est-elle à jour ?","vide",{"kind": "none"}],["Et sa date ?","liste",{"kind": "ambiguous","candidates": [{"position": 1,"type": "document","id": 100,"label": "D1"},{"position": 2,"type": "document","id": 200,"label": "D2"},{"position": 3,"type": "document","id": 300,"label": "D3"}],"detected": "sa date"}],["Et sa date ?","selDoc",{"kind": "resolved","entity": {"type": "document","id": 200},"method": "pronoun","detected": "sa date"}],["Et sa date ?","selAgenda",{"kind": "resolved","entity": {"type": "agenda_item","id": 77},"method": "pronoun","detected": "sa date"}],["Et sa date ?","unique",{"kind": "resolved","entity": {"position": 1,"type": "document","id": 100,"label": "D1"},"method": "pronoun","detected": "sa date"}],["Et sa date ?","vide",{"kind": "none"}],["Ouvre le deuxième","liste",{"kind": "resolved","entity": {"position": 2,"type": "document","id": 200,"label": "D2"},"method": "ordinal","detected": "deuxieme"}],["Ouvre le deuxième","selDoc",{"kind": "resolved","entity": {"position": 2,"type": "document","id": 200,"label": "D2"},"method": "ordinal","detected": "deuxieme"}],["Ouvre le deuxième","selAgenda",{"kind": "none"}],["Ouvre le deuxième","unique",{"kind": "none"}],["Ouvre le deuxième","vide",{"kind": "none"}],["Et son montant ?","liste",{"kind": "ambiguous","candidates": [{"position": 1,"type": "document","id": 100,"label": "D1"},{"position": 2,"type": "document","id": 200,"label": "D2"},{"position": 3,"type": "document","id": 300,"label": "D3"}],"detected": "son montant"}],["Et son montant ?","selDoc",{"kind": "resolved","entity": {"type": "document","id": 200},"method": "pronoun","detected": "son montant"}],["Et son montant ?","selAgenda",{"kind": "resolved","entity": {"type": "agenda_item","id": 77},"method": "pronoun","detected": "son montant"}],["Et son montant ?","unique",{"kind": "resolved","entity": {"position": 1,"type": "document","id": 100,"label": "D1"},"method": "pronoun","detected": "son montant"}],["Et son montant ?","vide",{"kind": "none"}],["Quel est le statut de mon document ?","liste",{"kind": "none"}],["Quel est le statut de mon document ?","selDoc",{"kind": "none"}],["Quel est le statut de mon document ?","selAgenda",{"kind": "none"}],["Quel est le statut de mon document ?","unique",{"kind": "none"}],["Quel est le statut de mon document ?","vide",{"kind": "none"}],["Ses statuts ?","liste",{"kind": "none"}],["Ses statuts ?","selDoc",{"kind": "none"}],["Ses statuts ?","selAgenda",{"kind": "none"}],["Ses statuts ?","unique",{"kind": "none"}],["Ses statuts ?","vide",{"kind": "none"}],["celui-ci","liste",{"kind": "ambiguous","candidates": [{"position": 1,"type": "document","id": 100,"label": "D1"},{"position": 2,"type": "document","id": 200,"label": "D2"},{"position": 3,"type": "document","id": 300,"label": "D3"}],"detected": "celui-ci"}],["celui-ci","selDoc",{"kind": "resolved","entity": {"type": "document","id": 200},"method": "pronoun","detected": "celui-ci"}],["celui-ci","selAgenda",{"kind": "resolved","entity": {"type": "agenda_item","id": 77},"method": "pronoun","detected": "celui-ci"}],["celui-ci","unique",{"kind": "resolved","entity": {"position": 1,"type": "document","id": 100,"label": "D1"},"method": "pronoun","detected": "celui-ci"}],["celui-ci","vide",{"kind": "none"}],["Ouvre ce document","liste",{"kind": "ambiguous","candidates": [{"position": 1,"type": "document","id": 100,"label": "D1"},{"position": 2,"type": "document","id": 200,"label": "D2"},{"position": 3,"type": "document","id": 300,"label": "D3"}],"detected": "ce document"}],["Ouvre ce document","selDoc",{"kind": "resolved","entity": {"type": "document","id": 200},"method": "demonstrative","detected": "ce document"}],["Ouvre ce document","selAgenda",{"kind": "none"}],["Ouvre ce document","unique",{"kind": "resolved","entity": {"position": 1,"type": "document","id": 100,"label": "D1"},"method": "demonstrative","detected": "ce document"}],["Ouvre ce document","vide",{"kind": "none"}],["Et l’autre ?","liste",{"kind": "ambiguous","candidates": [{"position": 1,"type": "document","id": 100,"label": "D1"},{"position": 2,"type": "document","id": 200,"label": "D2"},{"position": 3,"type": "document","id": 300,"label": "D3"}],"detected": "et l'autre"}],["Et l’autre ?","selDoc",{"kind": "ambiguous","candidates": [{"position": 1,"type": "document","id": 100,"label": "D1"},{"position": 3,"type": "document","id": 300,"label": "D3"}],"detected": "et l'autre"}],["Et l’autre ?","selAgenda",{"kind": "none"}],["Et l’autre ?","unique",{"kind": "none"}],["Et l’autre ?","vide",{"kind": "none"}]];

afterEach(() => { delete process.env.ASSISTANT_CANONICAL_READ; });

/** Ajouts E2E-T2-12 : seuls cas où le résultat diffère de lot16. */
const AJOUT_T2_12 = (msg: string, c: keyof typeof CTX) =>
  (['Quel est son statut ?', 'Et son état ?'].includes(msg) && c !== 'vide')
  || (['Est-il réalisé ?', 'A-t-il été fait ?', 'Est-elle faite ?'].includes(msg) && c === 'selAgenda');

describe('résolveur de références — non-régression avec lot16', () => {
  it(`${LOT16.length} cas : identiques au tag lot16 hors ajouts E2E-T2-12`, () => {
    let ajouts = 0;
    for (const [msg, c, attendu] of LOT16) {
      const r = resolveThreadReference(msg, CTX[c] as never);
      if (AJOUT_T2_12(msg, c)) { ajouts += 1; expect(r, `${msg} / ${c}`).not.toEqual({ kind: 'none' }); continue; }
      expect(r, `${msg} / ${c}`).toEqual(attendu);
    }
    expect(ajouts).toBe(11);
  });

  it('variable retirée encore posée (legacy) : sans effet', () => {
    process.env.ASSISTANT_CANONICAL_READ = 'legacy';
    expect(resolveThreadReference('Quel est son statut ?', CTX.selAgenda as never)).toMatchObject({ kind: 'resolved', entity: { type: 'agenda_item', id: 77 } });
  });

  it('« son statut » vise l’élément sélectionné (E2E-T2-12)', () => {
    expect(resolveThreadReference('Quel est son statut ?', CTX.selAgenda as never)).toMatchObject({ kind: 'resolved', entity: { type: 'agenda_item', id: 77 } });
    expect(resolveThreadReference('Et son état ?', CTX.selDoc as never)).toMatchObject({ kind: 'resolved', entity: { id: 200 } });
  });
});
