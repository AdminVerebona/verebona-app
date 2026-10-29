/**
 * Lot 63 — décision PO du 16/10 (point 1) : texte de la branche
 * DOCUMENT_NAMING du prompt maître T3 (spécification de l'agent 61F, code
 * livré au lot 61 sans le texte). Tests L63-T3P-xx.
 *
 * Le texte est contrôlé sur ce qu'il DEMANDE (lecture des variables réelles,
 * familles, convention, protections, format, sortie JSON exacte), sur ce
 * qu'il NE contient PAS (nomenclature, fournisseur codé en dur) et sur ce
 * qu'il ne change pas (autres branches identiques au lot 62). Le corpus
 * (P-T3-15 à P-T3-17) rejoue les sorties enregistrées à travers les
 * garde-fous serveur réels.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MASTER_TASKS_TEXT_PENDING, OPTIONAL_MASTER_TASKS, inspectMasterTemplate, isMasterTaskTextPending, renderMasterPrompt,
} from '@/services/ai/prompts/prompt-loader';
import { checkPromptFiles } from '@/services/ai/prompts/prompt-files-check';
import { AI_OPERATIONS, listMasterTasks } from '@/services/ai/registry/operations';
import { checkMasterPromptContent } from '@/services/ai/master-prompts/master-prompt-checks';
import { namingVariables, planChunks, type NamingDoc } from '../context';
import { NAMING_MAX_LENGTH } from '../guards';

const FICHIER = join(process.cwd(), 'src/services/ai/prompts/reconciliation/t3_master_v1.txt');
const texte = () => readFileSync(FICHIER, 'utf8');
const MARQUEUR = 'BRANCHE TASK = DOCUMENT_NAMING';
/** Section DOCUMENT_NAMING seule (jusqu'à la consigne finale commune). */
const section = () => {
  const t = texte();
  return t.slice(t.indexOf(MARQUEUR), t.lastIndexOf('Réponds uniquement par le JSON'));
};

const doc = (id: number, name: string, over: Partial<NamingDoc> = {}): NamingDoc => ({
  id, name, originalName: null, filename: null, s3Key: null, publicId: null, titleSource: 'SYSTEM', legacyUserEdit: false,
  typeCode: 'INVOICE', supplier: 'Fournisseur Test', documentDate: `2024-0${id}-10`, assetId: 1, assetName: 'Maison',
  extractionId: id, extractedAt: `2024-0${id}-11T00:00:00.000Z`, extractionTitle: null, amountCents: null, ...over,
});

describe('L63-T3P — branche DOCUMENT_NAMING du prompt maître T3', () => {
  it('L63-T3P-01 — branche livrée dans le fichier, déclarée dans les valeurs autorisées ; plus « en attente », toujours facultative', () => {
    const t = texte();
    expect(t).toMatch(/TASK = \{\{TASK\}\}\n\nValeurs autorisées : VALUE_CONFLICT \| LINK_AMBIGUITY \| OPERATION_MATCH \| DOCUMENT_NAMING\n/);
    expect(inspectMasterTemplate(t).branches).toEqual(['VALUE_CONFLICT', 'LINK_AMBIGUITY', 'OPERATION_MATCH', 'DOCUMENT_NAMING']);
    expect(t.split(MARQUEUR)).toHaveLength(2);
    // Lot 85F : la branche KNOWLEDGE_QUERY (texte attendu de l'équipe IA) reste en attente ; lot 97A : OPERATION_IDENTITY
    // (T3) et AGENDA_REPRESENTATION (T4), textes dans le guide du PO.
    expect(MASTER_TASKS_TEXT_PENDING).toEqual({ t3_master_v1: ['KNOWLEDGE_QUERY', 'OPERATION_IDENTITY'], t4_master_v1: ['AGENDA_REPRESENTATION'] });
    expect(isMasterTaskTextPending('t3_master_v1', 'DOCUMENT_NAMING')).toBe(false);
    // Compatibilité des versions BO antérieures (sans la section) : jamais bloquant.
    expect(OPTIONAL_MASTER_TASKS.t3_master_v1).toEqual(['OPERATION_MATCH', 'DOCUMENT_NAMING', 'KNOWLEDGE_QUERY', 'OPERATION_IDENTITY']);
    expect(listMasterTasks('t3_master_v1')).toContain('DOCUMENT_NAMING');
  });

  it('L63-T3P-02 — le texte demande de lire les variables réelles du contexte (SUBJECT_CONTEXT, CANDIDATES, RELATION_TYPE)', () => {
    const s = section();
    for (const v of ['SUBJECT_CONTEXT', 'CANDIDATES', 'RELATION_TYPE', '`comparisonSet`', '`previousConventions`', '`constraints`',
      '`maxNameLength`', '`protectedOrigins`', '`role`', 'TO_EXAMINE', 'REFERENCE', '`currentName`', '`originalName`', '`nameOrigin`',
      '`renameAllowed`', '`nameHistory`', '`lastRenamedAt`', '`facts`', '`excerpt`', '`documentDate`', '`operations`']) {
      expect(s, v).toContain(v);
    }
    // Origines de nom réellement produites par le serveur.
    for (const o of ['USER', 'T1', 'T3_HARMONIZATION', 'UPLOAD', 'UNKNOWN']) expect(s).toContain(o);
    // Aucun nouvel emplacement : la branche réutilise ceux de LINK_AMBIGUITY (pas de duplication du contexte).
    expect(s).not.toMatch(/\{\{/);
  });

  it('L63-T3P-03 — règles demandées : familles par contexte, convention des noms existants, stabilité, protections, informations, format, confiance', () => {
    const s = section();
    // Familles : par contexte, jamais « un fournisseur = une famille ».
    expect(s).toMatch(/nature du document, émetteur, contrat ou abonnement, bien, service/);
    expect(s).toMatch(/Ne suppose jamais qu’un émetteur = une famille/);
    // Convention : noms existants, noms utilisateur = référence, previousConventions réutilisées sauf amélioration nette, pas de boucle.
    expect(s).toMatch(/convention des noms EXISTANTS/);
    expect(s).toMatch(/`nameOrigin` = USER\) font référence/);
    expect(s).toMatch(/réutilise-la ; n’en change que pour une amélioration nette/);
    expect(s).toMatch(/aucun renommage en boucle/);
    // Seuls TO_EXAMINE + renameAllowed ; expected_current_name recopié à l'identique.
    expect(s).toMatch(/`role` = TO_EXAMINE dont `renameAllowed` = true/);
    expect(s).toMatch(/`expected_current_name` recopie `currentName` À L’IDENTIQUE/);
    // Informations discriminantes conservées, rien d'inventé.
    expect(s).toMatch(/conserve TOUTES les informations discriminantes/);
    expect(s).toMatch(/il n’invente rien/);
    // Format : ≤ 120 caractères (même borne que le serveur), sans extension ni jeton technique.
    expect(NAMING_MAX_LENGTH).toBe(120);
    expect(s).toMatch(/\(120 au maximum\)/);
    expect(s).toMatch(/sans extension de fichier, sans jeton technique/);
    // Confiance « certain » exigée pour un nom d'origine inconnue.
    expect(s).toMatch(/`nameOrigin` = UNKNOWN[^\n]*`confidence` = certain/);
    // Abstention : document_renames vide.
    expect(s).toMatch(/`document_renames` = \[\]/);
  });

  it('L63-T3P-04 — sortie JSON exacte : {task, families[{label, document_ids, convention, inconsistent}], document_renames[{…}]}', () => {
    const s = section();
    const json = s.slice(s.indexOf('SORTIE DOCUMENT_NAMING') + 'SORTIE DOCUMENT_NAMING'.length);
    const bloc = JSON.parse(json.slice(json.indexOf('{'), json.lastIndexOf('}') + 1)) as Record<string, unknown>;
    expect(Object.keys(bloc)).toEqual(['task', 'families', 'document_renames']);
    expect(bloc.task).toBe('DOCUMENT_NAMING');
    expect(Object.keys((bloc.families as object[])[0])).toEqual(['label', 'document_ids', 'convention', 'inconsistent']);
    expect(Object.keys((bloc.document_renames as object[])[0]))
      .toEqual(['document_id', 'expected_current_name', 'proposed_name', 'reference_document_ids', 'reason', 'confidence']);
  });

  it('L63-T3P-05 — aucune nomenclature, aucun type documentaire, aucun fournisseur codé en dur', () => {
    const s = section();
    // Seuls les jetons en capitales du contrat (variables, rôles, origines, branche) sont admis.
    const admis = new Set(['BRANCHE', 'TASK', 'DOCUMENT_NAMING', 'LINK_AMBIGUITY', 'SUBJECT_CONTEXT', 'CANDIDATES', 'RELATION_TYPE',
      'TO_EXAMINE', 'REFERENCE', 'USER', 'T1', 'T3', 'T3_HARMONIZATION', 'UPLOAD', 'UNKNOWN', 'LOT', 'COMPARAISON', 'EXISTANTS',
      'DOCUMENTS', 'RENOMMABLES', 'IDENTIQUE', 'INFORMATIONS', 'TOUTES', 'FORME', 'CONFIANCE', 'RAISON', 'ET', 'RÉFÉRENCES',
      'ABSTENTION', 'SORTIE', 'FAMILLES', 'CONVENTION', 'UUID', 'CE', 'DE']);
    const jetons = [...new Set(s.match(/(?<!\p{L})[A-ZÀ-Ý][A-ZÀ-Ý0-9_]+(?![\p{L}\d])/gu) ?? [])].filter((j) => !/^N\d$/.test(j));
    expect(jetons.filter((j) => !admis.has(j))).toEqual([]);
    for (const code of ['INVOICE', 'CONTRACT', 'INSURANCE', 'QUOTE', 'RECEIPT']) expect(s).not.toContain(code);
    for (const f of ['Orange', 'EDF', 'Engie', 'SFR', 'Bouygues', 'Free ', 'TotalEnergies', 'Veolia', 'AXA', 'MAIF', 'Allianz', 'Sosh']) {
      expect(s).not.toContain(f);
    }
    // Aucun gabarit de nom imposé (mois/année en dur, format de date).
    expect(s).not.toMatch(/<mois>|<année>|AAAA|MM\/|\bjanvier\b|\bmars\b/);
  });

  it('L63-T3P-06 — les autres branches du prompt T3 sont inchangées (identiques au lot 62)', () => {
    const t = texte();
    const autres = t.slice(t.indexOf('RÈGLES UNIVERSELLES'), t.indexOf(MARQUEUR));
    expect(createHash('sha256').update(autres).digest('hex')).toBe('46f24ae3d65ade5965ee90abd5ef9e090ca99c3570b732931ad64fc9fee1f677');
    expect(t.trimEnd().endsWith('Réponds uniquement par le JSON correspondant au TASK demandé.')).toBe(true);
  });

  it('L63-T3P-07 — rendu réel de la branche avec les variables de production : contexte injecté une seule fois, aucun emplacement résiduel', () => {
    const docs = [doc(1, 'facture_2024-01.pdf'), doc(2, 'Facture — février 2024'), doc(3, 'Mon nom', { titleSource: 'USER' })];
    const variables = namingVariables({
      group: { key: 's:fournisseur test', docs }, chunk: planChunks(docs, docs.slice(0, 2), 40)[0], conventions: [],
      states: new Map([[1, { origin: 'UPLOAD', lastRenamedAt: null }], [2, { origin: 'T1', lastRenamedAt: null }], [3, { origin: 'USER', lastRenamedAt: null }]]),
      details: new Map(), maxLength: 120,
    });
    const rendu = renderMasterPrompt(texte(), { masterPromptCode: 't3_master_v1', task: 'DOCUMENT_NAMING', allowedTasks: listMasterTasks('t3_master_v1'), variables });
    expect(rendu).toContain('TASK = DOCUMENT_NAMING');
    expect(rendu).not.toMatch(/\{\{[A-Z_]+\}\}/);
    const candidats = JSON.stringify(variables.CANDIDATES);
    expect(rendu.split(candidats)).toHaveLength(2);
    expect(rendu).toMatch(/^Objet à rattacher : \{"comparisonSet":/m);
    expect(rendu).toMatch(/^Candidats : \[\{/m);
    expect(rendu).toContain('"role":"REFERENCE"');
    expect(rendu).toContain('"renameAllowed":false');
  });

  it('L63-T3P-08 — prompts:check sans avertissement ni erreur ; contrôle BO du texte livré sans signalement', () => {
    const r = checkPromptFiles({ operations: Object.values(AI_OPERATIONS), root: join(process.cwd(), 'src/services/ai/prompts') });
    expect(r.errors).toEqual([]);
    // Lot 85F : branche KNOWLEDGE_QUERY dont le texte est demandé à l'équipe IA ; lot 97A : OPERATION_IDENTITY (T3) et
    // AGENDA_REPRESENTATION (T4, contexte structuré), textes dans le guide du PO.
    expect(r.warnings).toEqual([
      expect.stringMatching(/KNOWLEDGE_QUERY absente du fichier — texte attendu d’un ticket séparé/),
      expect.stringMatching(/OPERATION_IDENTITY absente du fichier — texte attendu d’un ticket séparé/),
      expect.stringMatching(/TASK facultative AGENDA_REPRESENTATION non autorisée par la configuration du fichier/),
    ]);
    const bo = checkMasterPromptContent('T3', texte());
    expect(bo).toMatchObject({ ok: true, blocking: [] });
    expect(bo.warnings.map((w) => w.message).join(' ')).not.toMatch(/DOCUMENT_NAMING/);
  });
});

describe('L63-T3P — corpus DOCUMENT_NAMING (P-T3-15 à P-T3-17) et empreinte', () => {
  it('L63-T3P-09 — corpus T3 vert sur le fichier du dépôt : trois cas DOCUMENT_NAMING rejoués, empreinte de référence à jour', async () => {
    const { runMasterCorpus } = await import('@/services/ai/governance/master-corpus/runner');
    const { readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const { fingerprintDrift, readFingerprints } = await import('@/services/ai/governance/master-corpus/fingerprints');
    const [r] = await runMasterCorpus({ readMasterFile: readMasterFileFromRepo, treatments: ['T3'] });
    expect(r.status).toBe('PASSED');
    expect(r.branchesPassed).toContain('DOCUMENT_NAMING');
    const nommage = r.cases.filter((c) => c.task === 'DOCUMENT_NAMING');
    // Lot 99C : cas de représentation temporelle (P-T3-18 à P-T3-22 en rôle answer, P-T3-23 garde R1/R6).
    expect(nommage.map((c) => c.id).sort()).toEqual(['P-T3-15', 'P-T3-16', 'P-T3-17', 'P-T3-18', 'P-T3-19', 'P-T3-20', 'P-T3-21', 'P-T3-22', 'P-T3-23']);
    expect(nommage.every((c) => c.passed && c.level === 'full')).toBe(true);
    expect(fingerprintDrift([r], { masters: { t3_master_v1: readFingerprints().masters.t3_master_v1 } })).toEqual([]);
  });

  it('L63-T3P-10 — le corpus détecte une sortie non conforme : famille confondue, contrat renommé, nom utilisateur renommé', async () => {
    const { runMasterCorpus } = await import('@/services/ai/governance/master-corpus/runner');
    const { readMasterFileFromRepo, loadMasterCorpusCases } = await import('@/services/ai/governance/master-corpus/cases');
    const cases = loadMasterCorpusCases(readMasterFileFromRepo).filter((c) => c.id === 'P-T3-16' || c.id === 'P-T3-17');
    expect(cases).toHaveLength(2);
    const fautifs = cases.map((c) => {
      const o = structuredClone(c.output) as { families: Array<{ document_ids: number[] }>; document_renames: Array<Record<string, unknown>> };
      if (c.id === 'P-T3-16') {
        // « Un fournisseur = une famille » : le contrat rejoint les factures et perd sa référence.
        o.families = [{ ...o.families[0], document_ids: [1, 2, 3, 4] }];
        o.document_renames.push({ document_id: 4, expected_current_name: 'Contrat électricité — offre Base n° C-55821',
          proposed_name: 'Facture électricité — décembre 2023', reason: 'Alignement', confidence: 'certain' });
      } else {
        o.document_renames = [{ document_id: 13, expected_current_name: 'Mon avis d’échéance préféré',
          proposed_name: 'Assurance auto — avis d’échéance 2025', reason: 'Alignement', confidence: 'certain' }];
      }
      return { ...c, output: o };
    });
    const [r] = await runMasterCorpus({ readMasterFile: readMasterFileFromRepo, treatments: ['T3'], cases: fautifs });
    const p16 = r.cases.find((c) => c.id === 'P-T3-16')!;
    const p17 = r.cases.find((c) => c.id === 'P-T3-17')!;
    expect(p16.passed).toBe(false);
    expect(p16.errors.join(' ')).toMatch(/refus \{"4":"(DISCRIMINANT_REMOVED|INFORMATION_INVENTED)"\}/);
    expect(p16.errors.join(' ')).toMatch(/familles/);
    expect(p17.passed).toBe(false);
    expect(p17.errors.join(' ')).toMatch(/USER_NAME_PROTECTED/);
  });
});
