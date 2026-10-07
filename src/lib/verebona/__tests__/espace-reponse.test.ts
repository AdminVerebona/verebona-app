/**
 * Espace de réponse Verebona — Direction D v2 §5 à §8.
 *
 * Les réponses RÉELLES de l'assistant (`VerebonaMessage`) sont traduites dans
 * les briques communes de l'espace : nature (pose de la mascotte), liseré,
 * résumé, échanges compressés, demandes précédentes.
 */
import { describe, it, expect } from 'vitest';
import type { VerebonaMessage } from '../useVerebona';
import type { UiResultGroup } from '../assistant-ui';
import {
  answerSummary, buildTurns, classifyAnswer, exchangeCountLabel, fieldPlaceholder, firstSentence,
  mobileFieldLabel, objectsFromCards, olderLabel, poseForKind, railTone,
  resultCards, resumeLabel, showAnswerText, spacePose, splitTurns,
} from '../space';

const card = (id: string, title: string, extra: Partial<UiResultGroup['items'][number]> = {}) => ({
  id, typeLabel: 'Document', title, subtitle: 'Ferrari Testarossa', date: '2024-10-14', status: null, excerpt: null, href: `/documents/${id}`, ...extra,
});
const group = (type: UiResultGroup['type'], items: UiResultGroup['items'], total = items.length): UiResultGroup => ({
  type, label: type, items, total, hasMore: false, moreHref: null,
});
const user = (id: string, content: string, extra: Partial<VerebonaMessage> = {}): VerebonaMessage => ({ id, role: 'user', content, ...extra });
const bot = (id: string, content: string, extra: Partial<VerebonaMessage> = {}): VerebonaMessage => ({ id, role: 'assistant', content, ...extra });

describe('nature d’une réponse et pose de la mascotte (§6.5)', () => {
  it('erreur, action, aucun résultat', () => {
    expect(classifyAnswer(bot('1', 'Oups', { error: { code: 'X', message: 'Oups', recoverable: true } as never }))).toBe('error');
    expect(classifyAnswer(bot('1', 'À confirmer', { commandPlan: { planId: 'p', summary: '', expiresAt: '', actions: [], status: 'PENDING_CONFIRMATION' } }))).toBe('action');
    expect(classifyAnswer(bot('1', 'Lequel ?', { clarification: { clarificationId: 'c', question: 'Lequel ?', choices: [] } }))).toBe('action');
    expect(classifyAnswer(bot('1', 'Je n’ai rien trouvé de correspondant dans votre compte.'))).toBe('empty');
  });

  it('résultat unique selon son type, plusieurs résultats', () => {
    expect(classifyAnswer(bot('1', '', { resultGroups: [group('asset', [card('1', 'Ferrari')])] }))).toBe('asset');
    expect(classifyAnswer(bot('1', '', { resultGroups: [group('document', [card('1', 'CT')])] }))).toBe('doc');
    expect(classifyAnswer(bot('1', '', { resultGroups: [group('agenda', [card('1', 'CT')])] }))).toBe('event');
    expect(classifyAnswer(bot('1', '', { resultGroups: [group('help', [card('1', 'Transférer')])] }))).toBe('help');
    expect(classifyAnswer(bot('1', 'J’ai trouvé 2 documents et 1 échéance :', {
      resultGroups: [group('document', [card('1', 'A'), card('2', 'B')]), group('agenda', [card('3', 'C')])],
    }))).toBe('multi');
  });

  it('sans résultat : l’intention décide (aide, conversation, donnée)', () => {
    expect(classifyAnswer(bot('1', 'Ouvrez la fiche…', { intent: 'PRODUCT_HELP_HOW_TO' }))).toBe('help');
    expect(classifyAnswer(bot('1', 'Votre CT est valable 2 ans.', { intent: 'ACCOUNT_SUMMARY', mode: 'ai' }))).toBe('conv');
    expect(classifyAnswer(bot('1', 'Renouvellement le 28 août 2027.', { intent: 'ACCOUNT_FACT_AGENDA' }))).toBe('fact');
    expect(classifyAnswer(bot('1', 'Rien.', { intent: 'ACCOUNT_SEARCH_DOCUMENT' }))).toBe('empty');
  });

  it('réponse locale : la nature fournie par l’interface', () => {
    expect(classifyAnswer(bot('1', 'Que souhaitez-vous ajouter ?', { local: { kind: 'action' } }))).toBe('action');
  });

  it('table des poses', () => {
    expect(poseForKind('asset')).toBe('property-house');
    expect(poseForKind('multi')).toBe('search-loupe');
    expect(poseForKind('fact')).toBe('info-card');
    expect(poseForKind('help')).toBe('info-card');
    expect(poseForKind('doc')).toBe('document-analysis-pdf');
    expect(poseForKind('event')).toBe('reminder-bell');
    expect(poseForKind('action')).toBe('thumbs-up');
    expect(poseForKind('conv')).toBe('dialogue-bubble');
    expect(poseForKind('empty')).toBe('questioning');
    expect(poseForKind('error')).toBe('questioning');
  });

  it('pose du champ : aucun échange, traitement en cours, réponse arrivée', () => {
    expect(spacePose([])).toBe('welcome-wave');
    expect(spacePose(buildTurns([user('u', 'Ferrari')], true))).toBe('search-loupe');
    expect(spacePose(buildTurns([user('u', 'Ferrari'), bot('b', '', { resultGroups: [group('asset', [card('1', 'Ferrari')])] })], false)))
      .toBe('property-house');
  });
});

describe('liseré (§6.4)', () => {
  it('rouge pour une erreur, vert pour une action réussie, gris sinon', () => {
    expect(railTone(bot('1', 'x', { error: { code: 'X', message: 'x', recoverable: false } as never }))).toBe('error');
    expect(railTone(bot('1', 'x', { commandPlan: { planId: 'p', summary: '', expiresAt: '', actions: [], status: 'EXECUTED' } }))).toBe('success');
    expect(railTone(bot('1', 'x', { local: { tone: 'success' } }))).toBe('success');
    expect(railTone(bot('1', 'x'))).toBe('neutral');
  });
});

describe('échanges (§7)', () => {
  const msgs = [
    user('u1', 'Ferrari Testarossa'), bot('b1', '', { resultGroups: [group('asset', [card('1', 'Ferrari Testarossa')])] }),
    user('u2', 'Prochaine échéance ?'), bot('b2', 'Contrôle technique le 12 octobre 2026.'),
    user('u3', 'Pourquoi ?'), bot('b3', 'Le contrôle technique est valable 2 ans. Le dernier date du 14/10/2024.'),
  ];

  it('regroupe question → réponse(s), marque le traitement en cours', () => {
    const t = buildTurns([...msgs, user('u4', 'Combien ?')], true);
    expect(t).toHaveLength(4);
    expect(t[0].question).toBe('Ferrari Testarossa');
    expect(t[3].pending).toBe(true);
    expect(t[2].pending).toBe(false);
  });

  it('une réponse sans question (historique tronqué) ouvre son propre échange', () => {
    const t = buildTurns([bot('b0', 'Suite'), ...msgs], false);
    expect(t[0].question).toBe('');
    expect(t).toHaveLength(4);
  });

  it('seuls les 2 derniers échanges restent entiers', () => {
    const { recent, older } = splitTurns(buildTurns(msgs, false));
    expect(recent.map((x) => x.question)).toEqual(['Prochaine échéance ?', 'Pourquoi ?']);
    expect(older.map((x) => x.question)).toEqual(['Ferrari Testarossa']);
    expect(olderLabel(8)).toBe('8 échanges précédents sur ce sujet');
    expect(olderLabel(1)).toBe('1 échange précédent');
  });

  it('libellés du champ : placeholder, reprise, mobile', () => {
    const t = buildTurns(msgs, false);
    expect(fieldPlaceholder(0)).toBe('Demander à Verebona');
    expect(fieldPlaceholder(3)).toBe('Poursuivre…');
    expect(resumeLabel(3)).toBe('Reprendre · 3 échanges');
    expect(exchangeCountLabel(0)).toBe('');
    expect(exchangeCountLabel(1)).toBe('1 échange');
    expect(mobileFieldLabel([])).toBe('Demander à Verebona');
    expect(mobileFieldLabel(t)).toBe('Reprendre · Le contrôle technique est valable 2 ans');
  });
});

describe('résumés et objets', () => {
  it('résumé : un objet → son titre ; plusieurs → décompte par type ; sinon 1re phrase', () => {
    expect(answerSummary(bot('1', '', { resultGroups: [group('asset', [card('1', 'Ferrari Testarossa')])] }))).toBe('Ferrari Testarossa');
    expect(answerSummary(bot('1', 'J’ai trouvé :', {
      resultGroups: [group('document', [card('1', 'A'), card('2', 'B')]), group('agenda', [card('3', 'C')])],
    }))).toBe('2 documents, 1 échéance');
    expect(answerSummary(bot('1', 'Renouvellement le 28 août 2027. Voir le contrat.'))).toBe('Renouvellement le 28 août 2027');
    expect(answerSummary(bot('1', 'x', { local: { summary: 'Immatriculation à vérifier' } }))).toBe('Immatriculation à vérifier');
    expect(firstSentence('a'.repeat(80), 20)).toHaveLength(20);
  });

  it('état 4 : un résultat unique s’affiche sans la phrase d’annonce générique', () => {
    const one = { resultGroups: [group('asset', [card('1', 'Ferrari')])] };
    expect(showAnswerText(bot('1', 'J’ai trouvé 1 élément :', one))).toBe(false);
    expect(showAnswerText(bot('1', 'Oui. J’ai trouvé ce document :', one))).toBe(true);
    expect(showAnswerText(bot('1', ''))).toBe(false);
  });

  it('cartes du serveur → objets (href du serveur, bouton par type)', () => {
    const m = bot('1', '', { resultGroups: [group('agenda', [card('9', 'Contrôle technique', { href: '/agenda?tiroir=echeance:9', status: 'Dans 3 semaines', date: '2026-10-12' })])] });
    const [o] = objectsFromCards(resultCards(m));
    expect(o).toMatchObject({ title: 'Contrôle technique', href: '/agenda?tiroir=echeance:9', cta: 'Voir dans l’agenda', meta: '12/10/2026 · Dans 3 semaines', icon: 'calendar-days' });
  });
});

