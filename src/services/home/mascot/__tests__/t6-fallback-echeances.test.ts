/**
 * Lot 31 — ticket T6 : fallback déterministe des échéances naturel et
 * indépendant des libellés techniques (DATE-NEXT, DATE-NEXT-2).
 *
 * T6FB-AC1  : « Prochain contrôle technique — CUPRA LEON E-HYBRID180 » + Cupra
 *             (voiture), date confirmée → « Votre prochaine échéance est le
 *             contrôle technique de la Cupra, le 18 avril 2028. » — ni titre
 *             brut, ni « pour Cupra ».
 * T6FB-AC2  : T6 indisponible : ce texte est affiché tel quel et reste
 *             présentable (il passe lui-même les contrôles de sortie T6).
 * T6FB-AC3  : une date prévisionnelle reste explicitement estimée.
 * T6FB-AC4  : DATE-NEXT-2 applique les mêmes règles (texte et boutons).
 * T6FB-AC5  : aucun traitement propre à Cupra ou à un modèle : la même règle
 *             vaut pour tout bien.
 * T6FB-AC6  : aucun nom de bien retiré par recherche / remplacement non
 *             maîtrisé ; préfixe « Prochain(e) » retiré en tête seulement.
 * T6FB-AC7  : titres simples (Ramonage, Révision, Entretien chaudière,
 *             Contrôle technique) correctement traités.
 * T6FB-AC8  : sans donnée certaine pour l'article du bien (ou du libellé) :
 *             formulation neutre, jamais d'article deviné.
 * T6FB-AC9  : contrat T6 : faits structurés conservés, fallbackText = même
 *             formulation ; prompt maître T6 inchangé.
 * T6FB-AC10 : genre grammatical déclaré dans la taxonomie des biens (source
 *             unique) ; fixtures P-T6 mises à jour et toujours conformes.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildCandidates, type MascotAgendaRow, type MascotRawData } from '../signals';
import { selectSubjects, buildSecondaries } from '../selector';
import { buildPresentation } from '../presentation';
import { buildT6Input, evaluateT6CorpusCase, validateT6MasterOutput, validateT6Output } from '../t6-contract';
import { deadlineDisplayLabel, deadlineNextText, deadlinePairText } from '../deadline-label';
import { ASSET_FAMILIES, assetNameGrammar } from '@/lib/asset-taxonomy';

const TODAY = '2026-10-07';
const CUPRA_TITLE = 'Prochain contrôle technique — CUPRA LEON E-HYBRID180';

const raw = (agenda: MascotAgendaRow[]): MascotRawData => ({
  accountId: 7, today: TODAY,
  processing: { uploads: [], analyses: [], exports: [] },
  onboarding: { activeAssets: [{ id: 1, name: 'Cupra' }, { id: 2, name: 'Maison' }], activeAssetCount: 2, documentCount: 3 },
  toProcess: [], agenda, acknowledgments: [],
});
const row = (over: Partial<MascotAgendaRow>): MascotAgendaRow => ({
  id: 1, title: CUPRA_TITLE, date: '2028-04-18', forecast: false, requiresQualification: false,
  assetId: 1, assetName: 'Cupra', assetCategory: 'VEHICULE', assetSubtype: 'Voiture', ...over,
});
const subjectsOf = (agenda: MascotAgendaRow[]) => selectSubjects(buildCandidates(raw(agenda)).candidates);
const textOf = (agenda: MascotAgendaRow[]) => subjectsOf(agenda)[0].fallbackText;

describe('T6FB-AC1 : échéance confirmée, titre technique', () => {
  it('formulation naturelle, sans titre brut ni « pour Cupra »', () => {
    const t = textOf([row({})]);
    expect(t).toBe('Votre prochaine échéance est le contrôle technique de la Cupra, le 18 avril 2028.');
    expect(t).not.toContain('Prochain contrôle technique — CUPRA LEON E-HYBRID180');
    expect(t).not.toContain('CUPRA LEON');
    expect(t).not.toContain('pour Cupra');
    expect(t).not.toMatch(/[«»]/);
  });

  it('deadlineDisplayLabel({ title, assetName }) → « contrôle technique »', () => {
    expect(deadlineDisplayLabel({ title: CUPRA_TITLE, assetName: 'Cupra' })).toBe('contrôle technique');
  });
});

describe('T6FB-AC2 : T6 indisponible — le texte déterministe est présentable', () => {
  it('affiché tel quel quand T6 ne rend rien', () => {
    const c = buildCandidates(raw([row({})]));
    const subjects = selectSubjects(c.candidates);
    const p = buildPresentation({ subjects, secondaries: buildSecondaries(c, subjects), degraded: c.degraded, messages: null });
    expect(p.source).toBe('fallback'); // T6 n'a rien rendu : texte de secours
    expect(p.paragraphs[0].text).toBe('Votre prochaine échéance est le contrôle technique de la Cupra, le 18 avril 2028.');
  });

  it('il passerait lui-même les contrôles de sortie T6 (longueur, dates, nombres, nuances)', () => {
    for (const forecast of [false, true]) {
      const input = buildT6Input(subjectsOf([row({ forecast })]));
      const sortie = { schemaVersion: 't6-output-v2', messages: input.subjects.map((s) => ({ subjectId: s.subjectId, text: s.fallbackText, highlight: s.allowedHighlight })) };
      expect(validateT6Output(input, sortie).ok).toBe(true);
      expect(validateT6MasterOutput(input, sortie, { kinds: ['info'] })).toMatchObject({ ok: true, fallbackSubjects: [] });
    }
  });
});

describe('T6FB-AC3 : date prévisionnelle toujours signalée', () => {
  it('formulation privilégiée', () => {
    expect(textOf([row({ forecast: true })]))
      .toBe('Votre prochaine échéance est le contrôle technique de la Cupra, prévu autour du 18 avril 2028 (date estimée).');
  });

  it('formulation neutre et féminin', () => {
    expect(textOf([row({ forecast: true, assetCategory: null, assetSubtype: null })]))
      .toBe('Votre prochaine échéance concerne Cupra : contrôle technique, autour du 18 avril 2028 (date estimée).');
    expect(textOf([row({ forecast: true, title: 'Prochaine révision' })]))
      .toBe('Votre prochaine échéance est la révision de la Cupra, prévue autour du 18 avril 2028 (date estimée).');
  });
});

describe('T6FB-AC4 : DATE-NEXT-2, mêmes règles', () => {
  const chaudiere = row({ id: 2, title: 'Entretien chaudière — Maison', assetId: 2, assetName: 'Maison', assetCategory: 'IMMOBILIER', assetSubtype: 'Maison' });

  it('deux échéances le même jour : libellés naturels, jamais les titres bruts', () => {
    const s = subjectsOf([row({}), chaudiere])[0];
    expect(s.sourceCode).toBe('DATE-NEXT-2');
    expect(s.fallbackText).toBe('Deux échéances sont prévues le 18 avril 2028 : le contrôle technique de la Cupra et l’entretien chaudière de la maison.');
    expect(s.fallbackText).not.toMatch(/CUPRA LEON|[«»]|Prochain/);
    expect(s.actions.map((a) => a.label)).toEqual(['Voir « Contrôle technique »', 'Voir « Entretien chaudière »']);
    expect(s.secondaryLabel).toBe('Voir « Contrôle technique »');
  });

  it('prévisionnelle : estimée ; bien sans genre certain : neutre', () => {
    const s = subjectsOf([row({ forecast: true }), row({ id: 2, title: 'Ramonage', assetId: 3, assetName: 'Chez Mamie', assetCategory: 'IMMOBILIER', assetSubtype: 'Maison' })])[0];
    expect(s.fallbackText).toBe('Deux échéances sont prévues autour du 18 avril 2028 (date estimée) : le contrôle technique de la Cupra et le ramonage (Chez Mamie).');
  });
});

describe('T6FB-AC5 : générique, aucun cas codé pour Cupra', () => {
  it('le code ne nomme aucune marque ni aucun modèle', () => {
    for (const f of ['deadline-label.ts', 'signals.ts']) {
      // Le code, hors commentaires (les exemples documentés y restent permis).
      const code = readFileSync(join(process.cwd(), 'src/services/home/mascot', f), 'utf8')
        .replace(/\/\*[^]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toMatch(/cupra|leon|hybrid|clio|peugeot/i);
    }
  });

  it.each([
    ['Prochaine révision — PEUGEOT 3008 GT HYBRID', 'Peugeot', 'Voiture', 'Votre prochaine échéance est la révision de la Peugeot, le 18 avril 2028.'],
    ['Prochain entretien - Yamaha MT-07', 'Yamaha MT-07', 'Moto', 'Votre prochaine échéance est l’entretien de la Yamaha MT-07, le 18 avril 2028.'],
    ['Contrôle technique (Hymer B-Class)', 'Hymer', 'Camping-car', 'Votre prochaine échéance est le contrôle technique du Hymer, le 18 avril 2028.'],
    ['Révision Audi', 'Audi', 'Voiture', 'Votre prochaine échéance est la révision de l’Audi, le 18 avril 2028.'],
    ['Prochain entretien', 'Vélo', 'Vélo', 'Votre prochaine échéance est l’entretien du vélo, le 18 avril 2028.'],
  ])('%s (%s)', (title, assetName, subtype, attendu) => {
    expect(textOf([row({ title, assetName, assetSubtype: subtype })])).toBe(attendu);
  });
});

describe('T6FB-AC6 : aucune suppression non maîtrisée', () => {
  it('un segment qui ne désigne pas le bien est conservé (sans séparateur)', () => {
    expect(deadlineDisplayLabel({ title: 'Assurance — Matmut', assetName: 'Cupra' })).toBe('assurance Matmut');
    expect(deadlineDisplayLabel({ title: 'Contrôle technique — CUPRA LEON', assetName: 'Clio' })).toBe('contrôle technique CUPRA LEON');
  });

  it('le nom du bien n’est retiré qu’en fin de titre, mot entier, ou en segment séparé', () => {
    expect(deadlineDisplayLabel({ title: 'Révision Clio', assetName: 'Clio' })).toBe('révision');
    expect(deadlineDisplayLabel({ title: 'Révision de la Clio', assetName: 'Clio' })).toBe('révision');
    expect(deadlineDisplayLabel({ title: 'Clio : vidange', assetName: 'Clio' })).toBe('vidange');
    expect(deadlineDisplayLabel({ title: 'Révision Clio Sport', assetName: 'Clio' })).toBe('révision Clio Sport');
    expect(deadlineDisplayLabel({ title: 'Révision Cliométrie', assetName: 'Clio' })).toBe('révision Cliométrie');
    // Titre réduit au nom du bien : rien n'est retiré.
    expect(deadlineDisplayLabel({ title: 'Cupra', assetName: 'Cupra' })).toBe('Cupra');
  });

  it('« Prochain(e) » : en tête seulement, jamais s’il ne reste rien ; « Prochainement » intact', () => {
    expect(deadlineDisplayLabel({ title: 'Prochaine révision' })).toBe('révision');
    expect(deadlineDisplayLabel({ title: 'Prochain entretien' })).toBe('entretien');
    expect(deadlineDisplayLabel({ title: 'Prochain' })).toBe('Prochain');
    expect(deadlineDisplayLabel({ title: 'Prochainement : vidange' })).toBe('Prochainement vidange');
    expect(deadlineDisplayLabel({ title: 'Révision du prochain trimestre' })).toBe('révision du prochain trimestre');
  });

  it('un nom inconnu en tête garde sa casse (nom propre, sigle)', () => {
    expect(deadlineDisplayLabel({ title: 'CT' })).toBe('CT');
    expect(deadlineDisplayLabel({ title: 'Linky : relève' })).toBe('Linky relève');
    expect(deadlineDisplayLabel({ title: 'CONTRÔLE TECHNIQUE' })).toBe('contrôle technique');
  });
});

describe('T6FB-AC7 : titres simples', () => {
  it.each([
    ['Ramonage', 'ramonage', 'Votre prochaine échéance est le ramonage de la maison, le 18 avril 2028.'],
    ['Révision', 'révision', 'Votre prochaine échéance est la révision de la maison, le 18 avril 2028.'],
    ['Entretien chaudière', 'entretien chaudière', 'Votre prochaine échéance est l’entretien chaudière de la maison, le 18 avril 2028.'],
    ['Contrôle technique', 'contrôle technique', 'Votre prochaine échéance est le contrôle technique de la maison, le 18 avril 2028.'],
  ])('%s', (title, label, attendu) => {
    expect(deadlineDisplayLabel({ title, assetName: 'Maison' })).toBe(label);
    expect(textOf([row({ title, assetName: 'Maison', assetCategory: 'IMMOBILIER', assetSubtype: 'Maison' })])).toBe(attendu);
  });

  it('sans bien', () => {
    expect(deadlineNextText({ title: 'Ramonage', assetName: null, forecast: false }, '15 octobre 2026'))
      .toBe('Votre prochaine échéance est le ramonage, le 15 octobre 2026.');
  });
});

describe('T6FB-AC8 : formulation neutre sans donnée certaine', () => {
  it('catégorie du bien inconnue : « concerne Cupra : … »', () => {
    expect(textOf([row({ assetCategory: null, assetSubtype: null })]))
      .toBe('Votre prochaine échéance concerne Cupra : contrôle technique, le 18 avril 2028.');
  });

  it('logement nommé, nom avec déterminant : aucun genre deviné', () => {
    expect(textOf([row({ title: 'Ramonage', assetName: 'Chez Mamie', assetCategory: 'IMMOBILIER', assetSubtype: 'Maison' })]))
      .toBe('Votre prochaine échéance concerne Chez Mamie : ramonage, le 18 avril 2028.');
    expect(textOf([row({ title: 'Révision', assetName: 'Ma Clio' })]))
      .toBe('Votre prochaine échéance concerne Ma Clio : révision, le 18 avril 2028.');
  });

  it('nom d’échéance hors lexique : pas d’article, ni d’élision devinée', () => {
    expect(textOf([row({ title: 'Audit énergétique' })]))
      .toBe('Votre prochaine échéance concerne la Cupra : Audit énergétique, le 18 avril 2028.');
    expect(deadlineNextText({ title: 'Linky', assetName: null, forecast: true }, '2 mai 2027'))
      .toBe('Votre prochaine échéance : Linky, autour du 2 mai 2027 (date estimée).');
    expect(deadlinePairText({ title: 'CT', assetName: 'Cupra' }, { title: 'Ramonage', assetName: null }, '2 mai 2027', false))
      .toBe('Deux échéances sont prévues le 2 mai 2027 : CT (Cupra) et le ramonage.');
  });
});

describe('T6FB-AC9 : contrat T6', () => {
  it('DATE-NEXT : faits structurés inchangés, fallbackText naturel transmis', () => {
    const [s] = buildT6Input(subjectsOf([row({})])).subjects;
    expect(s.facts).toEqual({ title: CUPRA_TITLE, date: '2028-04-18', dateLabel: '18 avril 2028', dateNature: 'confirmée', assetName: 'Cupra' });
    expect(s.fallbackText).toBe('Votre prochaine échéance est le contrôle technique de la Cupra, le 18 avril 2028.');
    expect(s.allowedHighlight).toBe('18 avril 2028');
  });

  it('DATE-NEXT-2 : faits structurés inchangés', () => {
    const [s] = buildT6Input(subjectsOf([row({}), row({ id: 2, title: 'Ramonage', assetId: 2, assetName: 'Maison', assetCategory: 'IMMOBILIER', assetSubtype: 'Maison' })])).subjects;
    expect(s.facts).toEqual({
      date: '2028-04-18', dateLabel: '18 avril 2028', dateNature: 'confirmée',
      firstTitle: CUPRA_TITLE, firstAssetName: 'Cupra', secondTitle: 'Ramonage', secondAssetName: 'Maison',
    });
  });

  it('prompt maître T6 inchangé (empreinte de référence)', () => {
    const texte = readFileSync(join(process.cwd(), 'src/services/ai/prompts/mascot/t6_master_v1.txt'));
    const ref = JSON.parse(readFileSync(join(process.cwd(), 'src/services/ai/governance/master-corpus/fingerprints.json'), 'utf8'));
    expect(createHash('sha256').update(texte).digest('hex')).toBe(ref.masters.t6_master_v1);
  });
});

describe('T6FB-AC10 : taxonomie et fixtures', () => {
  it('genre déclaré dans la taxonomie des biens (source unique)', () => {
    const vehicule = ASSET_FAMILIES.find((f) => f.code === 'VEHICULE')!;
    expect(vehicule.namesTakeCategoryGender).toBe(true);
    expect(Object.fromEntries(vehicule.categories.map((c) => [c.value, c.grammaticalGender])))
      .toEqual({ Voiture: 'f', Moto: 'f', 'Vélo': 'm', 'Camping-car': 'm', Bateau: 'm', Camion: 'm' });
    expect(ASSET_FAMILIES.find((f) => f.code === 'IMMOBILIER')!.namesTakeCategoryGender).toBeUndefined();
    expect(assetNameGrammar({ name: 'Cupra', category: 'VEHICULE', subtype: 'Voiture' })).toEqual({ gender: 'f', name: 'Cupra' });
    expect(assetNameGrammar({ name: 'Cupra', category: 'VEHICULE', subtype: null })).toBeNull();
    expect(assetNameGrammar({ name: 'Cupra', category: null })).toBeNull();
    expect(assetNameGrammar({ name: 'Vélo', category: null })).toEqual({ gender: 'm', name: 'vélo' });
    expect(assetNameGrammar({ name: 'Résidence du lac', category: 'IMMOBILIER', subtype: 'Maison' })).toBeNull();
  });

  it('fixtures P-T6 : nouvelle formulation, toujours conformes au corpus', () => {
    const dir = join(process.cwd(), 'src/services/home/mascot/__fixtures__');
    const fichiers = readdirSync(dir).filter((f) => /^p-t6-.*\.json$/.test(f));
    expect(fichiers.length).toBeGreaterThan(0);
    for (const f of fichiers) {
      const brut = readFileSync(join(dir, f), 'utf8');
      expect(brut).not.toMatch(/« Contrôle technique » pour/);
      const c = JSON.parse(brut);
      expect(c.context.input.subjects[0].fallbackText)
        .toBe('Votre prochaine échéance est le contrôle technique de la Clio, prévu autour du 14 novembre 2026 (date estimée).');
      expect(JSON.parse(c.context.variables.INPUT_JSON)).toEqual(c.context.input);
      expect(evaluateT6CorpusCase(c.context, c.recording.output, c.expected ?? null)).toEqual([]);
    }
  });
});
