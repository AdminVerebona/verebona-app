/**
 * Politique « données sensibles » — CDC §29.4 (audit P2).
 *
 * Pièces d'identité, coordonnées bancaires, données médicales, données de
 * tiers, secrets et codes d'accès : masqués ou exclus du contexte envoyé au
 * modèle lorsque leur présence n'est pas nécessaire à la réponse.
 */
import { describe, it, expect, vi } from 'vitest';
import { fakeProvider } from '@/test/setup';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => { throw new Error('aucune base en test'); }) },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));

const {
  maskSensitiveText, sensitiveNecessityFor, applySensitiveDataPolicy, sensitiveDocumentCategory, MASKS,
} = await import('../sensitive-data.policy');
const { redact } = await import('../redaction.service');

const m = (t: string, q = '') => maskSensitiveText(t, sensitiveNecessityFor(q));

describe('§29.4 — pièces d’identité', () => {
  it('numéro annoncé par l’intitulé de la pièce, passeport au format français, MRZ, NIR', () => {
    const r = m('Passeport n° 18AB12345 délivré le 02/03/2020. CNI : 123456789012. Titre de séjour numéro X12345678.');
    expect(r.text).not.toMatch(/18AB12345|123456789012|X12345678/);
    expect(r.text).toContain('délivré le 02/03/2020');
    expect(r.report.counts.identity).toBe(3);
    expect(m('P<FRADUPONT<<JEAN<<<<<<<<<<<<<<<<<<<<<<<<<<').text).toBe(MASKS.identity);
    expect(m('NIR 1 85 05 78 006 084 36').text).not.toMatch(/78 006 084/);
  });

  it('une date d’expiration ou une référence sans chiffres suffisants n’est pas masquée', () => {
    expect(m('Mon passeport expire le 12/05/2031.').text).toBe('Mon passeport expire le 12/05/2031.');
    expect(m('Référence du devis DEVIS-ABCDEF').report.counts.identity).toBe(0);
  });

  it('nécessaire : la question demande le numéro de la pièce', () => {
    expect(m('Passeport n° 18AB12345', 'Quel est le numéro de mon passeport ?').text).toContain('18AB12345');
  });
});

describe('§29.4 — coordonnées bancaires (jamais nécessaires au modèle)', () => {
  it('IBAN et carte masqués, même si la question les demande', () => {
    const r = m('IBAN FR76 3000 6000 0112 3456 7890 189, carte 4970 1012 3456 7890', 'donne-moi mon IBAN');
    expect(r.text).not.toMatch(/FR76|4970/);
    expect(r.report.counts.bank).toBe(2);
  });
});

describe('§29.4 — données médicales', () => {
  it('la phrase qui porte la donnée médicale est masquée, le reste conservé', () => {
    const r = m('Chaudière révisée le 3 mars. Arrêt maladie du locataire jusqu’au 10 avril. Prochaine visite en mai.');
    expect(r.text).toBe(`Chaudière révisée le 3 mars. ${MASKS.medical}. Prochaine visite en mai.`);
    expect(r.report.counts.medical).toBe(1);
  });

  it('nécessaire : la question porte explicitement sur la santé', () => {
    expect(m('Ordonnance du Dr X.', 'où est mon ordonnance ?').text).toBe('Ordonnance du Dr X.');
  });

  it('un vocabulaire ordinaire du logement n’est pas pris pour une donnée médicale', () => {
    const t = 'Traitement de charpente réalisé. Diagnostic de performance énergétique classe C.';
    expect(m(t).text).toBe(t);
  });
});

describe('§29.4 — données de tiers', () => {
  it('e-mail, téléphone et date de naissance masqués par défaut', () => {
    const r = m('Contact : jean.dupont@example.com, 06 12 34 56 78. Né le 12/03/1980.');
    expect(r.text).not.toMatch(/jean\.dupont|06 12 34|1980/);
    expect(r.text).toContain('Né le ');
    expect(r.report.counts.thirdParty).toBe(3);
  });

  it('contact demandé : e-mail et téléphone conservés, la date de naissance jamais', () => {
    const r = m('Plombier : 06 12 34 56 78, né le 12/03/1980', 'quel est le téléphone de mon plombier ?');
    expect(r.text).toContain('06 12 34 56 78');
    expect(r.text).not.toContain('1980');
  });
});

describe('§29.4 — secrets et codes d’accès (toujours masqués)', () => {
  it.each([
    ['Digicode : 4521B', '4521B'],
    ['Le mot de passe est Soleil2024!', 'Soleil2024!'],
    ["Code d'accès du portail = 7788", '7788'],
    ['Clé wifi: maBoxWPA-9981', 'maBoxWPA-9981'],
    ['Code alarme 2468', '2468'],
    ['Code d’alarme : 4589', '4589'],
    ["code d'alarme 7531", '7531'],
    ['clé AIzaSyA1234567890abcdefghijklmnopqrstuv', 'AIzaSyA1234567890abcdefghijklmnopqrstuv'],
    ['jeton eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', 'eyJhbGci'],
  ])('%s', (texte, secret) => {
    const r = m(texte, 'quel est mon code ? donne le mot de passe');
    expect(r.text).not.toContain(secret);
    expect(r.report.counts.secret).toBeGreaterThan(0);
  });

  it('un code postal ou un « pin maritime » ne sont pas des secrets', () => {
    const t = 'Code postal 75011. Parquet en pin maritime.';
    expect(m(t).text).toBe(t);
  });
});

describe('§29.4 — sources envoyées au modèle', () => {
  const src = (id: string, title: string, content: string, type: 'document' | 'asset_field' = 'document') => ({ id, type, title, content });

  it('documents d’identité ou médicaux exclus du contexte, sauf nécessité', () => {
    expect(sensitiveDocumentCategory(src('doc_1', 'Passeport Jean', ''))).toBe('identity');
    expect(sensitiveDocumentCategory(src('doc_2', 'Ordonnance pharmacie', ''))).toBe('medical');
    expect(sensitiveDocumentCategory(src('asset_1', 'Passeport énergétique', '', 'asset_field'))).toBeNull();

    const r = applySensitiveDataPolicy([
      src('doc_1', 'Passeport Jean', 'n° 18AB12345'),
      src('doc_2', 'Ordonnance pharmacie', '…'),
      src('doc_3', 'Facture chaudière', 'Contact 06 12 34 56 78 — digicode 1234'),
    ], 'quand a été révisée la chaudière ?');
    expect(r.sources.map((s) => s.id)).toEqual(['doc_3']);
    expect(r.excludedIds).toEqual(['doc_1', 'doc_2']);
    expect(r.sources[0].content).not.toMatch(/06 12|1234/);
    // Trace sans contenu : des compteurs, jamais la donnée.
    expect(r.events).toEqual(['SENSITIVE:MASKED:thirdParty:1', 'SENSITIVE:MASKED:secret:1', 'SENSITIVE:EXCLUDED:2']);
    expect(JSON.stringify(r.events)).not.toMatch(/18AB|1234/);

    const besoin = applySensitiveDataPolicy([src('doc_1', 'Passeport Jean', 'expire le 01/01/2030')], 'quand expire mon passeport ? quel est son numéro de passeport');
    expect(besoin.sources.map((s) => s.id)).toEqual(['doc_1']);
  });

  it('source inchangée : même objet (aucune copie inutile)', () => {
    const s = src('doc_9', 'Facture', 'Remplacement du ballon');
    expect(applySensitiveDataPolicy([s], 'ballon').sources[0]).toBe(s);
  });
});

describe('§29.4 — journaux (questions sans réponse) : même politique', () => {
  it('redact masque aussi pièces d’identité, secrets et données médicales', () => {
    const t = redact('Mon digicode : 4521B, passeport n° 18AB12345. Ordonnance du médecin traitant.');
    expect(t).not.toMatch(/4521B|18AB12345|Ordonnance/);
  });
});

describe('§29.4 — appliqué au prompt réellement envoyé au fournisseur', () => {
  it('document d’identité exclu, secret et téléphone masqués dans DATA et QUESTION ; trace sans contenu', async () => {
    const { generateAssistantAnswerDetailed } = await import('../generation.adapter');
    const { createAiCallBudget } = await import('../ai-call-budget');
    // Branche ANSWER du master T2 (seul moteur depuis le lot 16b-2).
    fakeProvider.onAny(() => ({
      rawText: JSON.stringify({ mode: 'ANSWER', format: 'claims', status: 'answered', claims: [{ text: 'La chaudière a été révisée le 03/03/2025.', sourceIds: ['doc_3'], factual: true }] }),
      inputTokens: 10, outputTokens: 5,
    }));
    const r = await generateAssistantAnswerDetailed(
      {
        intent: 'ACCOUNT_SUMMARY', confidence: 'exact', accountScope: 'server-enforced', entityHints: [],
        requiresRetrieval: true, aiEligible: true, clarificationRequired: false, allowedActionTypes: [], routeReason: 'test',
      },
      [
        { id: 'doc_1', type: 'document', title: 'Passeport Jean', content: 'n° 18AB12345', relevanceScore: 0.9 },
        { id: 'doc_3', type: 'document', title: 'Facture chaudière', content: 'Révisée le 03/03/2025. Technicien 06 12 34 56 78, digicode 4521B.', relevanceScore: 0.8 },
      ],
      {
        accountId: 7, userId: 3, planType: 'PREMIUM', message: 'Résume l’entretien de la chaudière (le code alarme est 2468)',
        clientRequestId: `c-${Math.random()}`, locale: 'fr-FR', aiBudget: createAiCallBudget(2),
        aiReport: { securityEvents: [], events: [] },
      },
    );
    expect('failed' in r).toBe(false);
    const prompt = fakeProvider.calls.at(-1)!.prompt;
    expect(prompt).not.toMatch(/"sourceId": "doc_1"|18AB12345|06 12 34 56 78|4521B|2468/);
    expect(prompt).toContain('Révisée le 03/03/2025');
    expect((r as { generationEvents: string[] }).generationEvents).toEqual(expect.arrayContaining(['SENSITIVE:EXCLUDED:1']));
  });
});

describe('§29.4 — pas de faux positifs (revue)', () => {
  it.each([
    'La toiture diagnostiquée présente des fissures.',
    'Le technicien diagnostique une fuite sur la colonne.',
    'Rapport sur la pathologie du bâtiment : remontées capillaires.',
    'Ordonnance de référé du tribunal judiciaire du 12 mars.',
    'Traitement de charpente réalisé, diagnostic de performance énergétique classe C.',
    'Arrêt de travail du chantier pendant les congés.',
  ])('phrase du bâtiment ou du droit intacte : %s', (t) => {
    expect(m(t).text).toBe(t);
  });

  it('numéro de série au format passeport : conservé sans mention de passeport ; masqué sinon', () => {
    expect(m('Chaudière série 12AB34567, révisée.').text).toBe('Chaudière série 12AB34567, révisée.');
    expect(m('Copie du passeport de M. Martin : 12AB34567').text).not.toContain('12AB34567');
  });

  it('bloc OCR sans ponctuation : seule une zone bornée autour de la donnée médicale est masquée', () => {
    const avant = 'facture entretien chaudiere gaz modele xyz technicien intervenu le 3 mars remplacement joint vanne '.repeat(3);
    const apres = ' devis toiture zinc gouttieres descente eaux pluviales facture numero 2231 reglement par virement'.repeat(3);
    const r = m(`${avant}certificat médical du locataire${apres}`);
    expect(r.text).toContain(MASKS.medical);
    expect(r.text).not.toContain('certificat médical');
    expect(r.text.startsWith('facture entretien chaudiere')).toBe(true);
    expect(r.text.endsWith('reglement par virement')).toBe(true);
    expect(r.text.length).toBeGreaterThan(avant.length);
  });
});

describe('§29.4 — coordonnées des fournisseurs (revue)', () => {
  const fiche = { id: 'supplier_4', type: 'supplier' as const, title: 'Plomberie Durand', content: 'Tél. 01 23 45 67 89 — contact@durand-plomberie.fr' };

  it.each([
    'Quel est le numéro du plombier ?',
    'le tél du chauffagiste ?',
    'Résume la fiche du plombier',
  ])('fiche fournisseur jamais masquée : %s', (q) => {
    const r = applySensitiveDataPolicy([fiche], q);
    expect(r.sources[0].content).toBe(fiche.content);
  });

  it.each([
    ['Quel est le numéro du plombier ?'], ['le tél du chauffagiste ?'], ['son n° ?'], ['adresse mail du syndic'],
    ['comment joindre le couvreur'], ['coordonnées du notaire'],
  ])('besoin de contact reconnu : %s', (q) => {
    expect(sensitiveNecessityFor(q).thirdParty).toBe(true);
  });

  it('dans un document, le téléphone d’un particulier reste masqué sans demande de contact', () => {
    const r = applySensitiveDataPolicy([{ id: 'doc_5', type: 'document', title: 'Bail', content: 'Locataire joignable au 06 12 34 56 78.' }], 'quand finit le bail ?');
    expect(r.sources[0].content).not.toContain('06 12 34 56 78');
  });
});
