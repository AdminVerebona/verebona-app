/**
 * Contexte utile du fil courant et références déjà présentées — CDC §16.4.
 *
 * « Ouvre le deuxième », « et sa date ? », « cette maison », « l'autre »…
 * résolus sans modèle, à partir de l'ordre RÉELLEMENT affiché dans ce fil,
 * avant le routage. Jamais depuis un autre fil ni l'autre membre d'un Duo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  resolveThreadReference,
  formatConversationForPrompt,
  type ThreadContext,
} from '@/services/verebona-assistant/core/reference-resolver';
import { buildEntityClarification } from '@/services/verebona-assistant/core/clarification-builder';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const DOCS = [
  { position: 1, type: 'document' as const, id: 123, label: 'Facture 2024' },
  { position: 2, type: 'document' as const, id: 456, label: 'Facture 2025' },
  { position: 3, type: 'document' as const, id: 789, label: 'Devis 2026' },
];

const ctx = (over: Partial<ThreadContext> = {}): ThreadContext => ({
  conversationId: 1,
  messages: [],
  presentedLists: [DOCS],
  lastPresentedEntities: DOCS,
  lastSelected: null,
  currentAssetId: null,
  currentDocumentId: null,
  pendingClarification: null,
  ...over,
});

const resolved = (msg: string, c = ctx()) => {
  const r = resolveThreadReference(msg, c);
  return r.kind === 'resolved' ? r.entity.id : r.kind;
};

describe('ordinaux : l’ordre affiché fait foi', () => {
  it.each([
    ['Ouvre le deuxième', 456], ['le premier', 123], ['Et le troisième ?', 789],
    ['Ouvre la dernière', 789], ['la deuxième facture', 456],
  ])('« %s »', (msg, id) => expect(resolved(msg)).toBe(id));

  it('une liste plus récente d’un seul élément ne masque pas la liste de trois', () => {
    const c = ctx({ presentedLists: [[DOCS[1]], DOCS], lastPresentedEntities: [DOCS[1]] });
    expect(resolved('Et le troisième ?', c)).toBe(789);
  });

  it('« mon dernier document », « la première échéance de 2027 » ne sont pas des renvois', () => {
    expect(resolved('Quel est mon dernier document ?')).toBe('none');
    expect(resolved('Quelle est la première échéance de 2027 ?')).toBe('none');
  });

  it('nouveau fil : rien à reprendre', () => {
    expect(resolved('Ouvre le deuxième', ctx({ presentedLists: [], lastPresentedEntities: [] }))).toBe('none');
  });
});

describe('pronoms, démonstratifs, « l’autre », « le précédent »', () => {
  const sel = ctx({ lastSelected: { type: 'document', id: 456, label: 'Facture 2025' } });

  it('« sa date » désigne l’élément sélectionné', () => expect(resolved('Et sa date ?', sel)).toBe(456));
  it('« ce document » désigne l’élément sélectionné', () => expect(resolved('Ouvre ce document', sel)).toBe(456));
  it('« le précédent » : l’élément affiché avant', () => expect(resolved('Et le précédent ?', sel)).toBe(123));

  it('« l’autre » parmi deux, l’un sélectionné', () => {
    const deux = ctx({ presentedLists: [DOCS.slice(0, 2)], lastPresentedEntities: DOCS.slice(0, 2), lastSelected: { type: 'document', id: 123 } });
    expect(resolved('Et pour l’autre ?', deux)).toBe(456);
  });

  it('« l’autre » avec plusieurs possibilités : ambiguïté, pas de choix arbitraire', () => {
    const r = resolveThreadReference('Ouvre l’autre', sel);
    expect(r.kind).toBe('ambiguous');
    expect(r.kind === 'ambiguous' && r.candidates.map((c) => c.id)).toEqual([123, 789]);
  });

  it('« ce document » sans sélection parmi trois : ambiguïté', () => {
    expect(resolveThreadReference('Ouvre ce document', ctx()).kind).toBe('ambiguous');
  });

  it('« cette maison » : bien courant du fil (choix de clarification)', () => {
    const c = ctx({ presentedLists: [], lastPresentedEntities: [], lastSelected: { type: 'asset', id: 42 }, currentAssetId: 42 });
    expect(resolved('Montre-moi les documents de cette maison', c)).toBe(42);
  });
});

describe('ambiguïté → clarification T2-10', () => {
  it('candidats = entités présentées, dans l’ordre', () => {
    const e = buildEntityClarification({
      entities: DOCS, accountId: 1, userId: 2, conversationId: 3,
      originalMessage: 'Ouvre ce document', originalMessageId: 'm', originalIntent: 'NAVIGATION_OPEN', chainDepth: 1,
    });
    expect(e.candidateType).toBe('document');
    expect(e.candidates.map((c) => c.id)).toEqual(['doc_123', 'doc_456', 'doc_789']);
    expect(e.question).toBe('De quel document parlez-vous ?');
  });
});

describe('contexte borné pour le modèle', () => {
  it('messages du fil + référence résolue, rien d’autre', () => {
    const t = formatConversationForPrompt(ctx({ messages: [{ role: 'user', content: 'Montre-moi les factures' }] }), { type: 'document', id: 456, label: 'Facture 2025' });
    expect(t).toContain('Utilisateur : Montre-moi les factures');
    expect(t).toContain('« Facture 2025 »');
  });

  it('le prompt v2 reçoit {{CONVERSATION}} et interdit d’en tirer des faits', () => {
    const p = read('src/services/ai/prompts/assistant/generate_answer_v2.txt');
    expect(p).toContain('{{CONVERSATION}}');
    expect(p).toMatch(/R9 — LE CONTEXTE SERT À COMPRENDRE, PAS À AFFIRMER/);
    expect(read('src/services/ai/registry/operations.ts')).toMatch(/promptCode: 'generate_answer_v2'/);
    expect(read('src/services/verebona-assistant/core/generation.adapter.ts')).toMatch(/CONVERSATION: input\.threadContextText/);
  });
});

describe('câblage', () => {
  const O = read('src/services/verebona-assistant/core/assistant-orchestrator.service.ts');
  const S = read('src/services/verebona-assistant/core/conversation.service.ts');

  it('le contexte est chargé et résolu AVANT le routage', () => {
    expect(O.indexOf('applyThreadMemory(input, ports, trace)')).toBeLessThan(O.indexOf('routeDeterministic({'));
  });

  it('une référence n’est jamais une autorisation : re-vérification en base', () => {
    expect(O).toMatch(/ports\.describeEntity\(input\.accountId, res\.entity\)/);
    expect(O).toMatch(/plus disponible dans votre compte/);
  });

  it('ordre d’affichage persisté, contexte limité au fil de l’utilisateur', () => {
    expect(S).toMatch(/INSERT INTO verebona_presented_entities/);
    expect(S).toMatch(/WHERE id = \$1 AND account_id = \$2 AND user_id = \$3 AND status = 'active' AND expires_at > now\(\)/);
    expect(S).toMatch(/LIMIT 8/);
  });

  it('la référence est tracée (méthode, entité)', () => {
    expect(O).toMatch(/trace\.reference = \{/);
    expect(O).toMatch(/trace\.reference\.entity = \{ type: res\.entity\.type, id: res\.entity\.id \}/);
  });
});
