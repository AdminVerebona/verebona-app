/**
 * Lot 33 — Recherche T2 sans faux positifs, de bout en bout sur PostgreSQL
 * réel : barre de recherche (`GET /api/search`), adaptateurs de l'assistant
 * (`registries/retrieval-adapters.ts`), lectures SQL de la cascade
 * (`findAssets`, `searchDocuments`) et réponses de l'assistant (boutons
 * « Ouvrir le bien », plus de mention de la source).
 *
 * Cas A à G du ticket (SRCH-A…G) sur biens, documents et échéances.
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander, useTargetState } from '../chain';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));

type Compte = { id: number; ownerUserId: number };
type Ligne = { id: string; category: string; label: string; match: { matchedField: string; matchedValue: string | null; matchType: string; rank: number; eligibilityDecision: string } };
type Trace = { entityType: string; displayName: string; rejected?: true; rejectionReason?: string; matchedField: string | null };

scenario('L33-SRCH', 'Lot 33 — Recherche T2 : correspondance explicable, aucun faux positif', ({ sql, make, useRecordings }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });

  let c: Compte;
  const ids: Record<string, number> = {};

  const bien = async (cpt: Compte, name: string, over: { category?: string; subtype?: string | null; city?: string | null; address?: string | null; kc?: Record<string, unknown> } = {}) => {
    const a = await make.asset({ id: cpt.id, ownerUserId: cpt.ownerUserId } as never, { category: over.category ?? 'VEHICULE', name, keyCharacteristics: over.kc });
    await sql`UPDATE assets SET subtype = ${over.subtype ?? null}, city = ${over.city ?? null}, address = ${over.address ?? null}, status = 'EN_SERVICE' WHERE id = ${a.id}`;
    return a.id;
  };
  const document = async (cpt: Compte, assetId: number | null, titre: string, over: { type?: string | null; texte?: string | null } = {}) => {
    const f = await make.assetFile({ id: cpt.id, ownerUserId: cpt.ownerUserId } as never, { assetId, name: `${titre.replace(/\W+/g, '-')}.pdf` });
    await sql`UPDATE asset_files SET retained_title = ${titre}, original_filename = ${`${titre}.pdf`}, document_type = ${over.type ?? null},
              extracted_text = ${over.texte ?? null}, upload_status = 'COMPLETED', is_draft = false WHERE id = ${f.id}`;
    return f.id;
  };

  beforeAll(async () => {
    const a = await make.account({ plan: 'premium' });
    c = { id: a.id, ownerUserId: a.ownerUserId };
    ids.polo = await bien(c, 'Polo', { subtype: 'Voiture' });
    // Reproduction du ticket : « polo » figure dans la fiche canonique de la
    // Cupra (trace de provenance d'un champ) et dans ses notes / équipements —
    // jamais dans un champ qui l'identifie.
    ids.cupra = await bien(c, 'Cupra', {
      subtype: 'Voiture', city: 'Caluire-et-Cuire',
      address: '8 IMPASSE DE L ECLUSE, 69300 CALUIRE ET CUIRE, FRANCE MÉTROPOLITAINE',
      kc: { mileage: 30000, mileage__source: 'Facture entretien VW Polo', address1: '8 IMPASSE DE L ECLUSE' },
    });
    await sql`UPDATE assets SET notes = 'Achetée pour remplacer la Polo', equipment_list = 'Housse Polo' WHERE id = ${ids.cupra}`;
    ids.apolon = await bien(c, 'Apolon', { subtype: 'Vélo' });
    ids.lyon = await bien(c, 'Maison Lyon', { category: 'IMMOBILIER', subtype: 'Maison', city: 'Lyon' });
    ids.annecy = await bien(c, 'Maison Annecy', { category: 'IMMOBILIER', subtype: 'Maison', city: 'Annecy' });
    ids.toiture = await document(c, ids.lyon, 'Facture toiture', { type: 'FACTURE' });
    ids.assurance = await document(c, ids.lyon, 'Contrat assurance', { type: 'CONTRAT' });
    ids.toyota = await document(c, ids.annecy, 'Scan 0001', { texte: 'Carnet d’entretien Toyota Yaris, vidange 2024.' });
    ids.annecyAutre = await document(c, ids.annecy, 'Relevé de compteur', { texte: 'Index électrique 4521 kWh.' });
    ids.entretien = await document(c, ids.polo, 'Facture entretien', { type: 'FACTURE', texte: 'Révision Volkswagen Polo, 60 000 km.' });
    ids.cupraDoc = await document(c, ids.cupra, 'Carte grise', { texte: 'Certificat d’immatriculation, ancien titulaire M. Apolonio, Caluire.' });
    ids.ct = (await make.agendaItem({ id: c.id, ownerUserId: c.ownerUserId } as never, { title: 'Contrôle technique', startDate: '2027-03-01', assetIds: [ids.polo] })).id;
    ids.ramonage = (await make.agendaItem({ id: c.id, ownerUserId: c.ownerUserId } as never, { title: 'Ramonage', startDate: '2027-01-15', assetIds: [ids.lyon] })).id;
    // Autre compte : jamais visible.
    const b = await make.account({ plan: 'premium' });
    await bien({ id: b.id, ownerUserId: b.ownerUserId }, 'Polo voisin', { subtype: 'Voiture' });
  });

  const chercher = async (q: string, debug = false) => {
    session.currentAccountId = c.id; session.userId = c.ownerUserId;
    const { GET } = await import('@/app/api/search/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest(`http://x/api/search?q=${encodeURIComponent(q)}${debug ? '&debug=1' : ''}`));
    expect(res.status).toBe(200);
    return await res.json() as { results: Ligne[]; trace?: Trace[]; aiPowered: boolean };
  };
  const libelles = (r: { results: Ligne[] }, cat?: string) => r.results.filter((x) => !cat || x.category === cat).map((x) => x.label).sort();

  it('SRCH-A-E2E — « polo » : Polo ✅, documents qui mentionnent Polo ✅, échéance de la Polo ✅ ; Cupra ❌ (trace de fiche, notes), Apolon ❌', async () => {
    const r = await chercher('polo', true);
    expect(libelles(r, 'Bien')).toEqual(['Polo']);
    expect(libelles(r, 'Document')).toEqual(['Facture entretien']);
    expect(libelles(r, 'Agenda')).toEqual(['Contrôle technique']);
    // Chaque résultat est explicable.
    for (const l of r.results) {
      expect(l.match.matchedField).toBeTruthy();
      expect(l.match.matchType).toBeTruthy();
      expect(l.match.eligibilityDecision).toBe('ELIGIBLE');
    }
    expect(r.results.find((x) => x.label === 'Polo')!.match).toMatchObject({ matchedField: 'name', matchedValue: 'Polo', matchType: 'EXACT', rank: 1 });
    expect(r.results.find((x) => x.label === 'Facture entretien')!.match).toMatchObject({ matchedField: 'content', matchType: 'EXACT_TOKEN' });
    expect(r.results.find((x) => x.label === 'Contrôle technique')!.match).toMatchObject({ matchedField: 'assetNames', matchType: 'RELATIONAL' });
    // Le candidat Cupra (généré par la fiche canonique) est tracé comme rejeté, avec sa raison.
    const cupra = r.trace!.find((t) => t.displayName === 'Cupra')!;
    expect(cupra).toMatchObject({ rejected: true, rejectionReason: 'NO_MATCHING_FIELD', matchedField: null });
    expect(r.trace!.find((t) => t.displayName === 'Carte grise')).toMatchObject({ rejected: true });
    expect(r.aiPowered).toBe(false);
  });

  it('SRCH-B-E2E — même catégorie : « Annecy » → Maison Annecy ✅, Maison Lyon ❌ ; documents du bien sans le mot ❌', async () => {
    const r = await chercher('Annecy');
    expect(libelles(r)).toEqual(['Maison Annecy']);
    expect(r.results[0].match).toMatchObject({ matchedField: 'name' });
  });

  it('SRCH-C-E2E — documents du même bien : « toiture » → Facture toiture ✅, Contrat assurance ❌', async () => {
    const r = await chercher('toiture');
    expect(libelles(r)).toEqual(['Facture toiture']);
    expect(r.results[0].match).toMatchObject({ matchedField: 'title', matchType: 'EXACT_TOKEN' });
  });

  it('SRCH-D-E2E — relation indirecte : « toyota » → le document qui le contient ✅ ; son bien et les autres documents du bien ❌', async () => {
    const r = await chercher('toyota', true);
    expect(libelles(r)).toEqual(['Scan 0001']);
    expect(r.results[0].match).toMatchObject({ matchedField: 'content', matchType: 'EXACT_TOKEN' });
    // Recherche de la relation explicite : le bien complète une correspondance directe.
    const f = await chercher('facture lyon');
    expect(libelles(f)).toEqual(['Facture toiture']);
    // Le bien seul ne fait pas remonter ses documents.
    const l = await chercher('lyon', true);
    expect(libelles(l, 'Document')).toEqual([]);
    expect(l.trace!.filter((t) => t.entityType === 'document').map((t) => t.rejectionReason)).toContain('RELATION_ONLY');
    expect(libelles(l, 'Bien')).toEqual(['Maison Lyon']);
  });

  it('SRCH-E-E2E — faute légère : « poloo » → Polo ✅ (FUZZY), rien d’autre', async () => {
    const r = await chercher('poloo');
    expect(libelles(r, 'Bien')).toEqual(['Polo']);
    expect(r.results.find((x) => x.label === 'Polo')!.match.matchType).toBe('FUZZY');
    expect(libelles(r, 'Bien')).not.toContain('Cupra');
    // Accents et pluriels : « maisons annécy ».
    expect(libelles(await chercher('maisons annécy'))).toEqual(['Maison Annecy']);
  });

  it('SRCH-F-E2E — catégorie explicite : « voitures » → Polo et Cupra (catégorie Voiture), jamais le vélo ni les maisons ; « factures » → documents de type facture', async () => {
    const r = await chercher('voitures');
    expect(libelles(r, 'Bien')).toEqual(['Cupra', 'Polo']);
    expect(r.results.filter((x) => x.category === 'Bien').every((x) => x.match.matchType === 'CATEGORY')).toBe(true);
    const f = await chercher('factures');
    expect(libelles(f, 'Document')).toEqual(['Facture entretien', 'Facture toiture']);
    // Une recherche portant sur un NOM n'utilise pas la catégorie.
    expect(libelles(await chercher('voiture polo'), 'Bien')).toEqual(['Polo']);
  });

  it('SRCH-G-E2E — aucune correspondance : terme absent → 0 résultat', async () => {
    expect((await chercher('zanzibar')).results).toEqual([]);
    expect((await chercher('golf')).results).toEqual([]);
  });

  it('SRCH-ASSISTANT-E2E — adaptateurs de l’assistant et lectures SQL de la cascade : mêmes règles (pas de sous-chaîne, catégorie seule rejetée)', async () => {
    const { ADAPTATEURS } = await import('@/services/verebona-assistant/registries/retrieval-adapters');
    const { analyserRequeteCanonique } = await import('@/services/verebona-assistant/core/retrieval.service');
    const chercherAssistant = async (message: string, adaptateur: string) => {
      const a = analyserRequeteCanonique(message);
      const adapter = ADAPTATEURS.find((x) => x.name === adaptateur)!;
      return adapter.search({
        accountId: c.id, normalizedQuery: a.terms.map((t) => t.stem).join(' '), terms: a.terms, intent: 'UNKNOWN', entityFilters: {}, limit: 50,
        period: a.period, documentTypes: a.documentTypes, documentFilters: a.documentFilters, documentTypeFilter: a.documentTypes,
      });
    };
    // SRCH-A : « polo » → Polo seule, avec sa correspondance.
    const biens = await chercherAssistant('polo', 'assets');
    expect(biens.map((s) => s.title)).toEqual(['Polo']);
    expect(biens[0].meta).toMatchObject({ matchedField: 'name', matchType: 'EXACT', retrievalStrategy: 'adapter.assets' });
    // SRCH-F : « facture voiture » → aucun bien par sa seule catégorie.
    expect(await chercherAssistant('facture voiture', 'assets')).toEqual([]);
    // SRCH-C / SRCH-D : documents.
    expect((await chercherAssistant('toiture', 'documents')).map((s) => s.title)).toEqual(['Facture toiture']);
    expect((await chercherAssistant('toyota', 'documents')).map((s) => s.title)).toEqual(['Scan 0001']);
    // SRCH-E : passe tolérante (« résultats proches ») encadrée.
    const a = analyserRequeteCanonique('pola');
    const proches = await ADAPTATEURS.find((x) => x.name === 'assets')!.search({
      accountId: c.id, normalizedQuery: 'pola', terms: a.terms, intent: 'UNKNOWN', entityFilters: {}, limit: 10, tolerant: true,
    });
    expect(proches.map((s) => s.title)).not.toContain('Cupra');
    // SRCH-G.
    expect(await chercherAssistant('zanzibar', 'assets')).toEqual([]);
    expect(await chercherAssistant('zanzibar', 'documents')).toEqual([]);
    // Cascade (account-data) : un MOT du nom, jamais une sous-chaîne.
    const { accountDataRepository } = await import('@/services/verebona-assistant/core/account-data.repository');
    expect((await accountDataRepository.findAssets(c.id, ['polo'])).map((x) => x.name)).toEqual(['Polo']);
    expect((await accountDataRepository.searchDocuments(c.id, ['toit'], null)).map((d) => d.title)).toEqual(['Facture toiture']);
    expect(await accountDataRepository.searchDocuments(c.id, ['iture'], null)).toEqual([]);
  });

  it('ACT-UN-BIEN-E2E — adresse de la maison : un SEUL bouton « Ouvrir le bien », aucune mention de la source', async () => {
    const m = await make.account({ plan: 'premium' });
    const cm = { id: m.id, ownerUserId: m.ownerUserId };
    await bien(cm, 'Maison', { category: 'IMMOBILIER', subtype: 'Maison', kc: { address1: '8 impasse de l’Écluse', postalCode: '69300', city: 'Caluire-et-Cuire' } });
    await useRecordings([]);
    const r = await demander(cm, 'À quelle adresse se situe la maison ?');
    expect(r.answer).toContain('8 impasse de l’Écluse');
    expect(r.answer).not.toMatch(/saisie par vous|Valeur |source|origine|lue dans/i);
    const ouvrir = r.actions.filter((x) => x.type === 'OPEN_ASSET');
    expect(ouvrir).toHaveLength(1);
    expect(ouvrir[0].label).toBe('Ouvrir le bien');
    // Traçabilité interne conservée : claim et sources en base.
    const [claim] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM verebona_message_claims cl JOIN verebona_messages mm ON mm.id = cl.message_id
       WHERE mm.conversation_id = ${r.conversationId!}`;
    expect(claim.n).toBeGreaterThan(0);
    expect(r.sources.length).toBeGreaterThan(0);
  });
});
