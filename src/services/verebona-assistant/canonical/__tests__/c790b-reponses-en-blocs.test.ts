/**
 * Carte #790, relance du 21/11/2026 — E03 « réponses de l'Assistant monobloc » : les réponses écrites par le
 * code DÉCLARENT leur structure, et cette structure arrive au rendu.
 *
 *   C790B-CMP  composeur (`lib/verebona/answer-compose`) : chaque forme du contrat des blocs, aller-retour exact
 *              (texte → blocs), replis sûrs, aucune donnée ne peut casser la forme ;
 *   C790B-POL  « Attendu Polo » : 2 476,41 € seul en chiffre principal, ventilation 559,51 € / 1 115,53 € /
 *              801,37 €, réserves à part — structure exacte, texte à plat exact ;
 *   C790B-IDT  AVANT / APRÈS (référence enregistrée sur le code d'origine, `fixtures/c790b-avant-correctif.json`) :
 *              mêmes montants (aucun ajouté, aucun retiré, aucun en double), mêmes sources, mêmes affirmations,
 *              même stratégie — seule la FORME change ; chaque bloc reste porté par son affirmation ;
 *   C790B-STR  structure de chaque stratégie touchée ;
 *   C790B-DRT  droits : hors offre, aucun montant, aucune lecture du coût de possession ;
 *   C790B-FMT  les trois formats (réponse simple, comparaison, chronologie), voie déterministe et voie IA simulée
 *              (contrat de sortie ANSWER réel : `claims`, `comparison`, `timeline`) ;
 *   C790B-IA   la structure rendue par le modèle arrive au rendu ; sans structure, une affirmation par paragraphe (carte recentrée).
 *
 * Aucun appel à un fournisseur d'IA : les sorties du modèle sont des objets du contrat `T2AnswerOutput`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AnswerBlock } from '@/lib/verebona/answer-blocks';
import type { CasProduit } from './fixtures/c790b-cas';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { answerBlocksFor, answerBlocksText, buildAnswerBlocks, parseAnswerBlocks, isPlainAnswer } = await import('@/lib/verebona/answer-blocks');
const { composeAnswer, composeAnswerText, joinAnswerLines } = await import('@/lib/verebona/answer-compose');
const { answerBlocksForApi } = await import('../../core/api-payload');
const { formatListBlocks, formatList } = await import('../../core/deterministic-format');
const { containsUrlOrMarkup } = await import('../../core/output-safety');
const { toGeneratedAnswer } = await import('../../core/generation.adapter');
const { controlFinalAnswer } = await import('../../core/final-answer-control');
const { t2AnswerLines } = await import('@/services/ai/assistant/master/t2-answer');
const { T2AnswerOutput } = await import('@/services/ai/assistant/master/t2-contract');
const { timelineAnswer } = await import('../../core/synthesis-planner');
const { produireCas } = await import('./fixtures/c790b-cas');
const { POLO, POLO_MONTANTS } = await import('./fixtures/c790b-polo');

const AVANT = JSON.parse(readFileSync(join(__dirname, 'fixtures/c790b-avant-correctif.json'), 'utf8')) as Record<string, CasProduit>;
let APRES: Record<string, CasProduit> = {};
beforeAll(async () => { APRES = await produireCas(); });

/** Espaces insécables ramenés à l'espace simple (lecture des attentes). */
const nb = (s: string) => s.replace(/[  ]/g, ' ');
const serre = (s: string) => s.replace(/\s+/g, ' ').trim();
/** Tous les nombres d'un texte (montants, dates, compteurs), triés : comparaison stricte avant / après. */
const nombres = (s: string) => (nb(s).match(/\d+(?: \d{3})*(?:,\d+)?/g) ?? []).sort();
/** Montants en devise d'un texte, triés. */
const montants = (s: string) => (nb(s).match(/(?:− )?\d+(?: \d{3})*,\d{2} (?:€|[A-Z]{3})/g) ?? []).sort();
const formes = (answer: string) => buildAnswerBlocks(answer).map((b) => b.kind);
const texteDe = (b: AnswerBlock) => answerBlocksText([b]);
const span = (text: string, strong = false) => (strong ? { text, strong: true as const } : { text });

describe('C790B-CMP — composeur : une partie déclarée = un bloc à l’écran, par le texte seul', () => {
  it('chaque forme du contrat : chiffre clé, paragraphe, liste annoncée, liste numérotée, titre, tableau', () => {
    const r = composeAnswer([
      { kind: 'metric', value: '2 476,41 €', caption: 'coût cumulé documenté de Polo' },
      { kind: 'paragraph', text: 'Un paragraphe avec 12,00 €.' },
      { kind: 'list', intro: 'Ventilation', items: ['Entretien : 559,51 €', 'Autres : 801,37 €'] },
      { kind: 'list', ordered: true, items: ['Ouvrir la fiche', 'Ajouter le document'] },
      { kind: 'heading', text: 'Comparaison' },
      { kind: 'table', header: ['Bien', 'Kilométrage'], rows: [['Clio', '82 000 km'], ['Polo', '45 000 km']] },
    ]);
    expect(r.answer).toBe([
      'Chiffre clé : 2 476,41 € — coût cumulé documenté de Polo',
      'Un paragraphe avec 12,00 €.',
      'Ventilation :\n• Entretien : 559,51 €\n• Autres : 801,37 €',
      '1. Ouvrir la fiche\n2. Ajouter le document',
      '## Comparaison',
      '| Bien | Kilométrage |\n| --- | --- |\n| Clio | 82 000 km |\n| Polo | 45 000 km |',
    ].join('\n\n'));
    expect(r.blocks.map((b) => b.kind)).toEqual(['metric', 'paragraph', 'paragraph', 'list', 'list', 'heading', 'table']);
    // Une seule source : les blocs SONT la dérivation du texte (aucune seconde rédaction).
    expect(r.blocks).toEqual(buildAnswerBlocks(r.answer));
    expect(answerBlocksFor(r.answer, r.blocks)).toEqual(r.blocks);
    expect(parseAnswerBlocks(JSON.parse(JSON.stringify(r.blocks)))).toEqual(r.blocks);
    const liste = r.blocks[3];
    expect(liste.kind === 'list' && liste.ordered).toBe(false);
    const etapes = r.blocks[4];
    expect(etapes.kind === 'list' && etapes.ordered).toBe(true);
    const tableau = r.blocks[6];
    expect(tableau.kind === 'table' && tableau.header?.length).toBe(2);
  });

  it('parties vides ignorées ; liste sans élément : rien ; liste d’un élément : toujours une liste', () => {
    expect(composeAnswer([]).answer).toBe('');
    expect(composeAnswer([{ kind: 'paragraph', text: '   ' }, { kind: 'list', intro: 'Limites', items: [] }]).blocks).toEqual([]);
    const un = composeAnswer([{ kind: 'list', intro: 'Limites', items: ['Ce total peut être incomplet.'] }]);
    expect(un.answer).toBe('Limites :\n• Ce total peut être incomplet.');
    expect(un.blocks.map((b) => b.kind)).toEqual(['paragraph', 'list']);
    expect(composeAnswerText([{ kind: 'list', items: ['A', 'B'] }])).toBe('• A\n• B');
  });

  it('replis sûrs : chiffre clé trop long ou sans chiffre → paragraphe ; quatrième chiffre clé → paragraphe ; tableau irrégulier → liste', () => {
    const long = composeAnswer([{ kind: 'metric', value: '2 476,41 €', caption: `coût cumulé documenté de ${'Résidence '.repeat(9)}` }]);
    expect(long.blocks.map((b) => b.kind)).toEqual(['paragraph']);
    expect(nb(long.answer)).toMatch(/^Coût cumulé documenté de Résidence .* : 2 476,41 €\.$/);
    expect(composeAnswer([{ kind: 'metric', value: 'aucun', caption: 'montant' }]).blocks.map((b) => b.kind)).toEqual(['paragraph']);
    const quatre = composeAnswer([1, 2, 3, 4].map((n) => ({ kind: 'metric' as const, value: `${n} €`, caption: 'poste' })));
    expect(quatre.blocks.map((b) => b.kind)).toEqual(['metric', 'metric', 'metric', 'paragraph']);
    expect(quatre.blocks).toEqual(buildAnswerBlocks(quatre.answer));
    const irregulier = composeAnswer([{ kind: 'table', header: ['Bien', 'Valeur'], rows: [['Clio', '1', 'de trop'], ['Polo', '2']] }]);
    expect(irregulier.blocks.map((b) => b.kind)).toEqual(['paragraph', 'list']);
    expect(irregulier.answer).toBe('Bien — Valeur :\n• Clio — 1 — de trop\n• Polo — 2');
  });

  it('une donnée ne casse jamais la forme : retours à la ligne et barres neutralisés, rien d’inventé', () => {
    const r = composeAnswer([
      { kind: 'metric', value: '12,00 €', caption: 'coût de Maison\nde campagne' },
      { kind: 'list', intro: 'Documents :', items: ['« Facture\n2024 »', '  ', '« Devis | toiture »'] },
      { kind: 'table', header: ['Bien', 'Note'], rows: [['Clio | bleue', 'ok'], ['Polo', 'ok']] },
    ]);
    expect(r.blocks.map((b) => b.kind)).toEqual(['metric', 'paragraph', 'list', 'table']);
    expect(r.answer).toContain('Chiffre clé : 12,00 € — coût de Maison de campagne');
    expect(r.answer).toContain('Documents :\n• « Facture 2024 »\n• « Devis | toiture »');
    expect(r.answer).toContain('| Clio / bleue | ok |');
    const liste = r.blocks[2];
    expect(liste.kind === 'list' ? liste.items.length : 0).toBe(2);
  });

  it('formatListBlocks : plusieurs éléments = une annonce et une liste ; un seul = la phrase d’avant ; troncature annoncée', () => {
    expect(formatListBlocks('Vous avez 2 biens', ['Clio', 'Polo'])).toBe('Vous avez 2 biens :\n• Clio\n• Polo');
    expect(formes(formatListBlocks('Vous avez 2 biens', ['Clio', 'Polo']))).toEqual(['paragraph', 'list']);
    expect(formatListBlocks('Vous avez 1 bien', ['Clio'])).toBe(formatList('Vous avez 1 bien', ['Clio']));
    expect(formatListBlocks('Vous avez 0 bien', [])).toBe('Vous avez 0 bien');
    expect(formatListBlocks('Documents', ['a', 'b', 'c', 'd'], 2)).toBe('Documents :\n• a\n• b\n• et 2 autres');
  });
});

describe('C790B-POL — « Quel est le coût de possession de Polo ? » : l’attendu de la carte, exactement', () => {
  const ATTENDU = [
    'Chiffre clé : 2 476,41 € — coût cumulé documenté de Polo',
    '',
    'Ventilation :',
    '• Entretien, réparations et travaux : 559,51 €',
    '• Contrats et assurances : 1 115,53 €',
    '• Autres coûts : 801,37 €',
    '',
    'Limites :',
    '• Coût annuel moyen de possession non calculé : date d’achat du bien inconnue : renseignez-la sur la fiche pour calculer la moyenne.',
    '• Coût net estimé non calculé : aucune estimation de valeur admissible postérieure à l’achat (le prix d’achat n’est jamais une valeur actuelle).',
    '• Ce total peut être incomplet.',
  ].join('\n');

  it('texte à plat exact (copie, lecteur d’écran, exports, journal) — par la fonction et par la question', () => {
    expect(nb(APRES.polo.answer)).toBe(ATTENDU);
    // Carte #880 (R03) : la question porte en plus la trace de lecture métier — la RÉPONSE reste identique.
    const { reading, ...reponse } = APRES.polo_question as typeof APRES.polo_question & { reading?: Record<string, unknown> };
    expect(reponse).toEqual(APRES.polo);
    expect(reading).toMatchObject({ reading: 'OWNERSHIP_COST', outcome: 'ANSWERED', strategyExecuted: 'structured.ownership_cost', assetResolution: 'NAME' });
    expect(POLO.name).toBe('Polo');
    expect(POLO_MONTANTS.entretien + POLO_MONTANTS.contrats + POLO_MONTANTS.autres).toBe(POLO_MONTANTS.total);
  });

  it('blocs exacts : le total SEUL en chiffre principal, la ventilation en liste, les réserves en liste à part', () => {
    const blocs = answerBlocksForApi(APRES.polo.answer)!;
    const sansNb = JSON.parse(nb(JSON.stringify(blocs))) as AnswerBlock[];
    expect(sansNb).toEqual([
      { kind: 'metric', value: [span('2 476,41 €')], caption: [span('coût cumulé documenté de Polo')] },
      { kind: 'paragraph', spans: [span('Ventilation :')] },
      { kind: 'list', ordered: false, items: [
        [span('Entretien, réparations et travaux : 559,51 €')], [span('Contrats et assurances : 1 115,53 €')], [span('Autres coûts : 801,37 €')],
      ] },
      { kind: 'paragraph', spans: [span('Limites :')] },
      { kind: 'list', ordered: false, items: [
        [span('Coût annuel moyen de possession non calculé : date d’achat du bien inconnue : renseignez-la sur la fiche pour calculer la moyenne.')],
        [span('Coût net estimé non calculé : aucune estimation de valeur admissible postérieure à l’achat (le prix d’achat n’est jamais une valeur actuelle).')],
        [span('Ce total peut être incomplet.')],
      ] },
    ]);
    // Le chiffre principal ne porte QUE le total ; les postes n'y figurent pas.
    const principal = blocs[0];
    expect(principal.kind).toBe('metric');
    expect(nb(texteDe(principal))).not.toMatch(/559,51|1 115,53|801,37/);
    // Écran (historique rechargé : aucun bloc reçu) et écran (blocs de l'API) : identiques.
    expect(answerBlocksFor(APRES.polo.answer, undefined)).toEqual(blocs);
    expect(answerBlocksFor(APRES.polo.answer, blocs)).toEqual(blocs);
  });

  it('aucun coût présenté comme exhaustif : « documenté », et la réserve d’incomplétude est dite', () => {
    expect(APRES.polo.answer).toContain('coût cumulé documenté');
    expect(APRES.polo.answer).toContain('Ce total peut être incomplet.');
    expect(APRES.polo.answer).not.toMatch(/exhaustif|coût total de Polo|tout compris/i);
  });
});

describe('C790B-IDT — avant / après : seule la forme change (référence du code d’origine)', () => {
  it('les mêmes cas des deux côtés ; la référence est bien l’ancien paragraphe unique', () => {
    expect(Object.keys(APRES).sort()).toEqual(Object.keys(AVANT).sort());
    expect(Object.keys(AVANT).length).toBeGreaterThanOrEqual(24);
    expect(AVANT.polo.answer).not.toContain('\n');
    expect(nb(AVANT.polo.answer)).toMatch(/^Coût de possession de Polo : coût cumulé documenté 2 476,41 € \(entretien, réparations et travaux 559,51 €, contrats et assurances 1 115,53 €, autres coûts 801,37 €\)\. /);
    expect(formes(AVANT.polo.answer)).toEqual(['paragraph']);
  });

  it('stratégie, nature du résultat, affirmations (clé, sources citées, dérivation) : strictement identiques', () => {
    for (const k of Object.keys(AVANT)) {
      expect(APRES[k].strategy, k).toBe(AVANT[k].strategy);
      expect(APRES[k].kind, k).toBe(AVANT[k].kind);
      expect(APRES[k].claims.map(({ claimKey, sourceIds, derivation }) => ({ claimKey, sourceIds, derivation })), k)
        .toEqual(AVANT[k].claims.map(({ claimKey, sourceIds, derivation }) => ({ claimKey, sourceIds, derivation })));
    }
  });

  it('sources : mêmes identifiants, mêmes types, mêmes titres, mêmes métadonnées (tous les montants en centimes)', () => {
    for (const k of Object.keys(AVANT)) {
      const sans = (c: CasProduit) => c.sources.map(({ content: _c, ...reste }) => reste);
      expect(sans(APRES[k]), k).toEqual(sans(AVANT[k]));
      AVANT[k].sources.forEach((av, i) => {
        const ap = APRES[k].sources[i];
        // Seule la source qui PORTE le texte d'une affirmation (coût de possession) suit sa forme ; toute autre est
        // inchangée, au caractère près.
        const porte = AVANT[k].claims.findIndex((c) => av.content === c.text.slice(0, 1500));
        if (porte >= 0) {
          expect(ap.content, `${k} ${av.id}`).toBe(APRES[k].claims[porte].text.slice(0, 1500));
          expect(nombres(String(ap.content)), `${k} ${av.id}`).toEqual(nombres(String(av.content)));
        } else expect(ap.content, `${k} ${av.id}`).toBe(av.content);
      });
    }
    expect(APRES.polo.sources[0].meta).toMatchObject({ assetId: 41, cumulativeCostCents: 247_641, status: 'INCOMPLETE', documentCount: 7, netEstimatedCents: null, annualAverageCents: null });
  });

  it('montants et nombres : aucun ajouté, aucun retiré, aucun en double (non-double-comptage) — réponse et affirmations', () => {
    for (const k of Object.keys(AVANT)) {
      expect(montants(APRES[k].answer), k).toEqual(montants(AVANT[k].answer));
      expect(nombres(APRES[k].answer), k).toEqual(nombres(AVANT[k].answer));
      APRES[k].claims.forEach((c, i) => expect(nombres(c.text), `${k} ${c.claimKey}`).toEqual(nombres(AVANT[k].claims[i].text)));
    }
    // Polo : chaque montant de la carte figure UNE fois, et aucun autre montant n'apparaît.
    expect(montants(APRES.polo.answer)).toEqual(['1 115,53 €', '2 476,41 €', '559,51 €', '801,37 €']);
  });

  it('chaque bloc reste porté par une affirmation vérifiée (bon bien, bon montant) ; rien hors affirmation', () => {
    for (const k of Object.keys(APRES)) {
      const portes = APRES[k].claims.map((c) => serre(c.text));
      for (const b of buildAnswerBlocks(APRES[k].answer)) {
        const lignes = answerBlocksText([b]).split('\n').map(serre).filter(Boolean);
        for (const l of lignes) expect(portes.some((p) => p.includes(l)), `${k} : « ${l} »`).toBe(true);
      }
      // L'affirmation unique d'une réponse simple EST la réponse ; une réponse composée est la suite de ses affirmations.
      expect(serre(APRES[k].claims.map((c) => c.text).join('\n\n')), k).toBe(serre(APRES[k].answer));
    }
    // Réponse composée (prix d'achat + coût de possession) : chaque partie dans SON affirmation, sur SA source.
    const [achat, possession] = APRES.cout_large_premium.claims;
    expect(achat.claimKey).toBe('acquisition');
    expect(nb(achat.text)).toContain('Prix d’achat de Clio : 18 500,00 €');
    expect(achat.text).not.toContain('Chiffre clé');
    expect(possession.claimKey).toBe('ownership_cost');
    expect(possession.sourceIds).toEqual(['tco:7']);
    expect(nb(possession.text)).toMatch(/^Chiffre clé : 23 456,78 € — coût cumulé documenté de Clio/);
    expect(nb(possession.text)).not.toContain('Prix d’achat de Clio');
  });

  it('ni JSON visible, ni URL, ni balisage ; blocs transmis = blocs recalculés (rejeu, historique)', () => {
    for (const k of Object.keys(APRES)) {
      const a = APRES[k].answer;
      expect(a, k).not.toMatch(/[{}[\]<>]|https?:|"kind"/);
      expect(containsUrlOrMarkup(a), k).toBe(false);
      const api = answerBlocksForApi(a);
      expect(answerBlocksFor(a, api ?? undefined), k).toEqual(buildAnswerBlocks(a));
      // Texte lu dans l'ordre d'affichage : celui de la réponse, sans les puces (lecteur d'écran, copie).
      expect(serre(answerBlocksText(buildAnswerBlocks(a))), k).toBe(serre(a.replace(/^• /gm, '')));
    }
  });
});

describe('C790B-STR — structure de chaque stratégie touchée', () => {
  const attendues: Record<string, AnswerBlock['kind'][]> = {
    polo: ['metric', 'paragraph', 'list', 'paragraph', 'list'],
    tco_riche: ['metric', 'paragraph', 'list', 'paragraph', 'list', 'paragraph', 'list'],
    tco_cede: ['metric', 'paragraph', 'list', 'paragraph', 'list'],
    tco_date_incertaine: ['metric', 'paragraph', 'list', 'paragraph', 'list'],
    verrou_bien: ['paragraph', 'paragraph'],
    verrou_sans_bien: ['paragraph', 'paragraph'],
    verrou_question: ['paragraph', 'paragraph'],
    paiements: ['paragraph', 'paragraph'],
    paiements_aucune_preuve: ['paragraph', 'paragraph'],
    sinistres: ['paragraph', 'list'],
    sinistre_seul: ['paragraph'],
    contrats: ['paragraph', 'list'],
    couts: ['paragraph', 'list'],
    cout_seul: ['paragraph'],
    historique: ['paragraph', 'list'],
    depenses_par_theme: ['paragraph', 'list', 'paragraph', 'paragraph', 'list'],
    depenses_un_theme: ['paragraph', 'paragraph', 'list'],
    depenses_complet: ['paragraph'],
    manquants: ['paragraph', 'list'],
    echeances: ['paragraph', 'list', 'paragraph'],
    cout_large_premium: ['paragraph', 'paragraph', 'paragraph', 'metric', 'paragraph', 'list', 'paragraph', 'list', 'paragraph', 'list'],
    cout_large_standard: ['paragraph', 'paragraph', 'paragraph', 'paragraph'],
    achat_et_depenses: ['paragraph', 'paragraph', 'paragraph', 'paragraph'],
    polo_question: ['metric', 'paragraph', 'list', 'paragraph', 'list'],
  };

  it('toutes les réponses de référence ont leur structure attendue (aucun cas oublié)', () => {
    expect(Object.keys(attendues).sort()).toEqual(Object.keys(APRES).sort());
    for (const [k, f] of Object.entries(attendues)) expect(formes(APRES[k].answer), k).toEqual(f);
  });

  it('coût de possession complet : total seul, ventilation (déductions comprises), indicateurs, limites — dans cet ordre', () => {
    const blocs = buildAnswerBlocks(APRES.tco_riche.answer);
    expect(nb(texteDe(blocs[0]))).toBe('Chiffre clé : 23 456,78 € — coût cumulé documenté de Clio, depuis l’achat du bien le 15 juin 2021');
    expect(blocs.filter((b) => b.kind === 'paragraph').map(texteDe)).toEqual(['Ventilation :', 'Autres indicateurs :', 'Limites :']);
    const [ventilation, indicateurs, limites] = blocs.filter((b) => b.kind === 'list').map((b) => nb(texteDe(b)).split('\n'));
    expect(ventilation).toEqual([
      'Acquisition : 18 500,00 €', 'Entretien, réparations et travaux : 3 123,45 €', 'Contrats et assurances : 2 100,00 €', 'Financement (intérêts et frais) : 433,33 €',
      'Avoirs : − 200,00 €', 'Remboursements : − 150,00 €', 'Indemnités : − 350,00 €',
    ]);
    expect(indicateurs).toHaveLength(6);
    expect(indicateurs[0]).toBe('Coût annuel moyen de possession (hors prix d’achat du bien) : 912,34 € par an.');
    expect(limites).toEqual([
      'Non comptés (devise sans contre-valeur en euros) : 300,00 CHF.',
      'Des montants communs à plusieurs biens ne sont pas ventilés et ne sont pas comptés.',
      'Résultat partiel.',
    ]);
    // Une limite n'est jamais rangée avec les indicateurs, ni l'inverse.
    expect(indicateurs.join(' ')).not.toMatch(/non calculé|peut être incomplet|Résultat partiel|Non comptés/);
    expect(limites.join(' ')).not.toMatch(/\d,\d{2} €/);
  });

  it('point de départ : dans la légende du chiffre principal s’il y tient, sinon en premier indicateur (jamais perdu)', () => {
    expect(nb(APRES.tco_riche.answer)).toContain('— coût cumulé documenté de Clio, depuis l’achat du bien le 15 juin 2021\n');
    expect(nb(APRES.tco_cede.answer)).toContain('Chiffre clé : 12 000,00 € — coût cumulé documenté de Clio\n');
    expect(nb(APRES.tco_cede.answer)).toContain('Autres indicateurs :\n• Coût compté depuis le début de la possession le 2 janvier 2019.\n• Après la vente (prix réalisé 5 000,00 €), coût net final : 7 000,00 €.');
  });

  it('total des dépenses : liste par thème, total, puis les réserves À PART ; réponse sans réserve : un paragraphe', () => {
    expect(nb(APRES.depenses_par_theme.answer)).toBe([
      'Dépenses documentées pour Clio, par thème :\n• entretien 430,00 € (2)\n• réparations 1 250,50 € (1)\n• assurance 612,00 € (1)',
      'Total des dépenses qualifiées : 2 292,50 €.',
      'À noter :\n• Non comptés : 2 documents avec montant ne précisent pas leur nature — le total peut être incomplet.\n• Doublon signalé (fusion possible) écarté : 1 — chaque document n’est compté qu’une fois.\n• Les devis et documents sans valeur de dépense (2) ne sont pas comptés.',
    ].join('\n\n'));
    expect(nb(APRES.depenses_complet.answer)).toBe('Dépenses d’entretien documentées pour Clio : 430,00 € (2 documents).');
    expect(APRES.depenses_complet.answer).toBe(AVANT.depenses_complet.answer);
  });

  it('réponses d’une phrase : inchangées au caractère près (sinistre seul, coût d’une intervention, historique)', () => {
    for (const k of ['sinistre_seul', 'cout_seul', 'historique', 'depenses_complet']) expect(APRES[k].answer, k).toBe(AVANT[k].answer);
  });
});

describe('C790B-DRT — droits : le verrou du coût de possession est inchangé', () => {
  it('hors offre (Standard, lecture seule) : aucun montant, aucune lecture TCO, même source de règle qu’avant', () => {
    for (const k of ['verrou_bien', 'verrou_sans_bien', 'verrou_question']) {
      expect(montants(APRES[k].answer), k).toEqual([]);
      expect(APRES[k].answer, k).not.toMatch(/\d/);
      expect(APRES[k].sources.map((s) => s.id), k).toEqual(['product_rule:tco_premium']);
      expect(APRES[k].kind, k).toBe('no_result');
      expect(APRES[k].answer, k).not.toContain('Chiffre clé');
    }
    // Le jeu `verrou_question` lève une erreur si le coût de possession est lu : il ne l'a pas été.
    expect(APRES.verrou_question.claims.map((c) => c.claimKey)).toEqual(['ownership_cost_locked']);
  });

  it('question large hors offre : prix d’achat et rappel de l’offre, aucun chiffre de possession', () => {
    const r = APRES.cout_large_standard;
    expect(r.strategy).toBe('structured.acquisition_price');
    expect(r.claims.map((c) => c.claimKey)).toEqual(['acquisition', 'ownership_cost_locked']);
    expect(nb(r.answer)).not.toMatch(/23 456,78|Chiffre clé|Ventilation/);
    expect(r.answer.endsWith('\n\nLe coût de possession est disponible avec Premium et Premium Duo.')).toBe(true);
  });
});

/** Sortie du modèle au contrat ANSWER réel (validée par le schéma de production), puis assemblage de production. */
function reponseIa(sortie: unknown, sources: Array<{ id: string; content: string }>) {
  const data = T2AnswerOutput.parse(sortie);
  const l = t2AnswerLines(data);
  const out = toGeneratedAnswer(
    { claims: l.lines, status: l.status, actionIntents: [], derivations: [] },
    sources.map((s) => ({ id: s.id, type: 'document' as const, title: s.id, content: s.content, relevanceScore: 1, meta: {} })),
    [], { verifySupport: true, supportEvents: [], separator: l.separator },
  );
  if (!out) throw new Error('sortie du modèle rejetée');
  return out;
}

describe('C790B-FMT — les trois formats : réponse simple, comparaison, chronologie', () => {
  it('réponse simple — déterministe : un paragraphe, le montant en évidence ; IA simulée : un paragraphe', () => {
    const det = buildAnswerBlocks(APRES.depenses_complet.answer);
    expect(det.map((b) => b.kind)).toEqual(['paragraph']);
    expect(det[0].kind === 'paragraph' && det[0].spans.some((s) => s.strong && /430,00/.test(s.text))).toBe(true);
    const ia = reponseIa(
      { mode: 'ANSWER', format: 'claims', status: 'answered', claims: [{ text: 'Le kilométrage de la Clio est de 82 000 km.', sourceIds: ['s1'] }] },
      [{ id: 's1', content: 'Kilométrage : 82 000 km' }],
    );
    expect(ia.answer).toBe('Le kilométrage de la Clio est de 82 000 km.');
    expect(isPlainAnswer(buildAnswerBlocks(ia.answer))).toBe(true);
    expect(answerBlocksForApi(ia.answer)).toBeNull();
    expect(answerBlocksFor(ia.answer, undefined).map((b) => b.kind)).toEqual(['paragraph']);
  });

  it('comparaison — IA simulée (format `comparison`) : le critère puis une ligne par bien ; absence dite, jamais zéro', () => {
    const ia = reponseIa(
      { mode: 'ANSWER', format: 'comparison', status: 'answered', criterion: 'kilométrage', items: [
        { targetId: 'asset:7', label: 'Clio', value: '82 000 km', sourceIds: ['s1'] },
        { targetId: 'asset:41', label: 'Polo', value: null, sourceIds: ['s2'] },
      ] },
      [{ id: 's1', content: 'Kilométrage : 82 000 km' }, { id: 's2', content: 'Polo' }],
    );
    // Le filtre de sortie du modèle (existant, inchangé) retire l'espace avant « : » ; la forme n'en dépend pas.
    expect(ia.answer).toBe('Critère comparé: kilométrage\n• Clio: 82 000 km\n• Polo: valeur absente des données');
    expect(formes(ia.answer)).toEqual(['paragraph', 'list']);
    expect(answerBlocksForApi(ia.answer)).toEqual(buildAnswerBlocks(ia.answer));
  });

  it('comparaison — déterministe : une liste par bien (dates d’achat), et un tableau quand le code en déclare un', () => {
    expect(formes(formatListBlocks('Dates d’achat enregistrées', ['Clio : 15 juin 2021', 'Polo : 2 janvier 2019']))).toEqual(['paragraph', 'list']);
    const t = composeAnswer([{ kind: 'table', header: ['Bien', 'Date d’achat', 'Prix'], rows: [['Clio', '15 juin 2021', '18 500 €'], ['Polo', '2 janvier 2019', '9 000 €']] }]);
    expect(t.blocks.map((b) => b.kind)).toEqual(['table']);
    const tableau = t.blocks[0];
    expect(tableau.kind === 'table' ? [tableau.header?.length, tableau.rows.length] : null).toEqual([3, 2]);
  });

  it('chronologie — IA simulée (format `timeline`) : une ligne par événement, dans l’ordre du modèle', () => {
    const ia = reponseIa(
      { mode: 'ANSWER', format: 'timeline', status: 'answered', events: [
        { date: '2021-06-15', text: 'Achat de la Clio', sourceIds: ['s1'] },
        { date: null, text: 'Vidange', sourceIds: ['s2'] },
      ] },
      [{ id: 's1', content: 'Achat de la Clio le 15/06/2021' }, { id: 's2', content: 'Vidange' }],
    );
    expect(ia.answer).toBe('15/06/2021 — Achat de la Clio\nDate inconnue — Vidange');
    expect(formes(ia.answer)).toEqual(['paragraph', 'paragraph']);
  });

  it('chronologie — déterministe : annonce, une ligne par événement, mention du reste (texte de la chronologie planifiée)', () => {
    const plan = { kind: 'timeline', assets: [{ id: 7, name: 'Clio' }], timeline: { totalEvents: 3, events: [
      { date: '2021-06-15', label: 'Achat', assetName: 'Clio', detail: null },
      { date: '2026-03-02', label: 'Remplacement embrayage', assetName: 'Clio', detail: 'Garage Martin' },
    ] } };
    const texte = timelineAnswer(plan as never, 2);
    expect(texte).toBe('Chronologie de Clio :\n• 15 juin 2021 : Achat\n• 2 mars 2026 : Remplacement embrayage — Garage Martin\n(1 événement plus ancien non affiché.)');
    expect(formes(texte)).toEqual(['paragraph', 'list', 'paragraph']);
    expect(formes(APRES.historique.answer)).toEqual(['paragraph', 'list']);
  });
});

describe('C790B-IA — voie IA : la structure rendue par le modèle arrive au rendu', () => {
  const SOURCES = [{ id: 'tco:41', content: 'Coût cumulé documenté 2 476,41 € ; entretien 559,51 € ; contrats 1 115,53 € ; autres 801,37 €' }];
  const ligne = (text: string, factual = true) => ({ text, sourceIds: factual ? ['tco:41'] : [], ...(factual ? {} : { factual: false }) });

  it('défaut d’origine : des lignes structurées du modèle étaient réunies par une espace — un seul paragraphe', () => {
    const lignes = ['Chiffre clé : 2 476,41 € — coût cumulé documenté de Polo', 'Ventilation :', '• Entretien : 559,51 €', '• Contrats : 1 115,53 €'];
    // Règle remplacée (carte #790, relance du 21/11) : `phrases.join(' ')`.
    expect(formes(lignes.join(' '))).toEqual(['paragraph']);
    expect(formes(joinAnswerLines(lignes))).toEqual(['metric', 'paragraph', 'list']);
  });

  it('format `claims` avec lignes structurées : chiffre clé, annonce, liste, puis phrase — par le contrat de sortie réel', () => {
    const ia = reponseIa({ mode: 'ANSWER', format: 'claims', status: 'answered', claims: [
      ligne('Chiffre clé : 2 476,41 € — coût cumulé documenté de Polo'),
      ligne('Ventilation :', false),
      ligne('• Entretien : 559,51 €'),
      ligne('• Contrats : 1 115,53 €'),
      ligne('• Autres : 801,37 €'),
      ligne('Ce total peut être incomplet.', false),
    ] }, SOURCES);
    // Le filtre de sortie du modèle (existant, inchangé) retire l'espace avant « : ».
    expect(ia.answer).toBe([
      'Chiffre clé: 2 476,41 € — coût cumulé documenté de Polo',
      'Ventilation:\n• Entretien: 559,51 €\n• Contrats: 1 115,53 €\n• Autres: 801,37 €',
      'Ce total peut être incomplet.',
    ].join('\n\n'));
    expect(formes(ia.answer)).toEqual(['metric', 'paragraph', 'list', 'paragraph']);
    // Chaque ligne factuelle reste UNE affirmation, rattachée à sa source.
    expect(ia.claims.map((c) => [c.text, c.sourceIds])).toEqual([
      ['Chiffre clé: 2 476,41 € — coût cumulé documenté de Polo', ['tco:41']],
      ['• Entretien: 559,51 €', ['tco:41']], ['• Contrats: 1 115,53 €', ['tco:41']], ['• Autres: 801,37 €', ['tco:41']],
    ]);
    expect(answerBlocksFor(ia.answer, answerBlocksForApi(ia.answer))).toEqual(buildAnswerBlocks(ia.answer));
  });

  // Règle remplacée (carte #790 recentrée le 22/11/2026, §2.B) : « les phrases se suivent dans UN paragraphe,
  // exactement comme avant ». La carte exige que deux affirmations distinctes ne soient plus concaténées en un seul
  // bloc : une affirmation par paragraphe (détail et cas limites : `c790c-carte-recentree.test.ts`).
  it('format `claims` sans structure : UNE affirmation par paragraphe, mêmes mots, mêmes montants', () => {
    const phrases = ['Le coût cumulé documenté de Polo est de 2 476,41 €.', 'L’entretien représente 559,51 €.', 'Les contrats représentent 1 115,53 €.'];
    const ia = reponseIa({ mode: 'ANSWER', format: 'claims', status: 'answered', claims: phrases.map((p) => ligne(p)) }, SOURCES);
    expect(ia.answer).toBe(phrases.join('\n\n'));
    expect(joinAnswerLines(phrases)).toBe(phrases.join('\n\n'));
    expect(serre(ia.answer)).toBe(phrases.join(' '));
    expect(formes(ia.answer)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    // Séparateur de liste (comparaison, chronologie) : inchangé.
    expect(joinAnswerLines(['a', ' b ', ''], '\n')).toBe('a\nb');
  });

  it('une ligne du modèle qui porte ses propres retours à la ligne est conservée telle quelle', () => {
    const texte = 'Postes :\n• Entretien : 559,51 €\n• Contrats : 1 115,53 €';
    const ia = reponseIa({ mode: 'ANSWER', format: 'claims', status: 'answered', claims: [ligne('Le coût cumulé documenté est de 2 476,41 €.'), ligne(texte)] }, SOURCES);
    expect(ia.answer).toBe(`Le coût cumulé documenté est de 2 476,41 €.\n\n${texte.replace(/ :/g, ':')}`);
    expect(formes(ia.answer)).toEqual(['paragraph', 'paragraph', 'list']);
  });

  it('ni URL ni balisage ne passent : le filtre de sortie s’applique avant l’assemblage', () => {
    const ia = reponseIa({ mode: 'ANSWER', format: 'claims', status: 'answered', claims: [
      ligne('• Entretien : 559,51 € (voir https://exemple.test/a)'), ligne('• Contrats : <b>1 115,53 €</b>'),
    ] }, SOURCES);
    expect(containsUrlOrMarkup(ia.answer)).toBe(false);
    expect(formes(ia.answer)).toEqual(['list']);
  });

  it('contrôle final : une réponse reconstruite sur les affirmations admissibles garde ses lignes structurées', () => {
    const claims = [
      { claimKey: 'c1', text: '• Entretien : 559,51 €', sourceIds: ['tco:41'], derivation: 'direct' as const },
      { claimKey: 'c2', text: '• Contrats : 1 115,53 €', sourceIds: ['tco:41'], derivation: 'direct' as const },
      { claimKey: 'c3', text: 'Vous avez déjà réglé 801,37 €.', sourceIds: ['tco:41'], derivation: 'direct' as const },
    ];
    const c = controlFinalAnswer({
      focus: null, path: 'generation', answer: claims.map((x) => x.text).join('\n'), claims, rebuild: true,
      sources: [{ id: 'tco:41', type: 'document_extraction', title: 'Coût de possession — Polo', content: SOURCES[0].content }],
    });
    expect(c.rejected).toEqual([{ claimKey: 'c3', reason: 'SETTLEMENT_UNPROVEN' }]);
    expect(c.answer).toBe('• Entretien : 559,51 €\n• Contrats : 1 115,53 €');
  });
});
