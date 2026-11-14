/**
 * Lot 114Z (Trello #767) — Documents : les 5 écarts résiduels du lot 113Z (#723), sur PostgreSQL 16
 * réel : routes réelles (session simulée), recherche de l'Assistant réelle, transmission réelle,
 * file des dossiers V12 réelle (rendu Chromium et stockage simulés — le PDF / ZIP réel est prouvé
 * par `l114z-dossiers-notes-rendu.integration.test.ts`), schéma RÉELLEMENT retiré puis rétabli
 * (la base est propre à ce fichier).
 *
 *   L114Z-E2E-01  E01  T2 : ancienne description IA + note corrigée ; note explicitement vide ; note non
 *                      modifiée ; description historique d'origine inconnue ; recherche sur texte ancien et
 *                      nouveau ; réponse T2 juste après l'enregistrement ; aucune fuite entre comptes ;
 *   L114Z-E2E-02  E02  transmission : non cochée ; cochée avec note / description T1 / effacement volontaire ;
 *                      métadonnées absentes ; exception SQL simulée → refus, rien chez le destinataire, nouvel
 *                      essai possible ; charge reçue par le destinataire ; droits du lien ;
 *   L114Z-E2E-03  E03  dossiers tiers (vente, assurance, complet) : exclu par défaut, option omise ou falsifiée,
 *                      inclusion volontaire figée dans l'instantané, texte affiché seul, dossier régénéré ;
 *   L114Z-E2E-04  E04  import et lien web : 0 / 1 / 5 000 / 5 001 caractères, Unicode, ancien champ, rien d'écrit
 *                      en cas de refus ;
 *   L114Z-E2E-05  E05  création, modification, effacement, réouverture, écritures concurrentes (schéma présent) ;
 *   L114Z-E2E-06  E05  migration ABSENTE (colonnes retirées) : écritures d'intention refusées sans écriture
 *                      partielle, inclusions vers un tiers refusées, lectures et recherche disponibles, alerte
 *                      de santé ; migration 1704 rejouée deux fois : tout redevient disponible, aucun NULL
 *                      historique converti en choix de l'utilisateur.
 *
 * Assertions bornées aux comptes créés ici.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';

const h = vi.hoisted(() => {
  process.env.OVH_S3_ACCESS_KEY_ID ??= 'e2e';
  process.env.OVH_S3_SECRET_ACCESS_KEY ??= 'e2e';
  process.env.OVH_S3_BUCKET ??= 'e2e-bucket';
  process.env.OVH_S3_ENDPOINT ??= 'http://127.0.0.1:9';
  process.env.EXPORTS_POST_RATE_LIMIT = '10000';
  return {
    session: { currentAccountId: 0 as number | null, userId: 0 },
    /** Paramètres reçus par le rendu simulé (source et choix réellement utilisés par le job). */
    rendus: [] as Array<{ code: string; source: { documents: Array<{ id: number; notesDescription?: string | null }> }; choices: Record<string, unknown> }>,
  };
});
vi.mock('@/lib/auth-guards', async (o) => ({
  ...(await o<object>()),
  getSession: async () => ({ userId: h.session.userId, currentAccountId: h.session.currentAccountId }),
}));
vi.mock('@/lib/session-service', async (o) => {
  const orig = await o<{ SessionService: object }>();
  return {
    ...orig,
    SessionService: {
      ...orig.SessionService,
      getSession: async () => ({ userId: h.session.userId, currentAccountId: h.session.currentAccountId }),
      tryGetSession: async () => (h.session.userId ? { userId: h.session.userId, currentAccountId: h.session.currentAccountId } : null),
      handleSessionError: (e: unknown) => { throw e; },
    },
  };
});
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
// Confirmation de dépôt : stockage, miniatures, crédit d'analyse et fusion hors périmètre.
vi.mock('@/lib/upload-object-check', () => ({ verificationObjetActive: () => false, verifierObjetDepose: async () => ({ kind: 'ok' }) }));
vi.mock('@/services/documents/thumbnails/thumbnail.service', async (o) => ({
  ...(await o<typeof import('@/services/documents/thumbnails/thumbnail.service')>()), enqueueThumbnails: () => undefined,
}));
vi.mock('@/services/commercial-model.service', async (o) => ({ ...(await o<object>()), canConsumeAnalysis: async () => ({ allowed: false }) }));
vi.mock('@/services/document-ai/fusion-detector', () => ({ detectFusionCandidates: async () => [] }));
// Dossiers V12 : rendu Chromium et stockage simulés (aucun réseau) ; le job, la file et la lecture stricte sont réels.
vi.mock('@/lib/runtime/memory-monitor', async (o) => ({
  ...(await o<object>()), admitHeavyTask: () => true, trackMemory: (_k: string, fn: () => unknown) => fn(),
}));
vi.mock('@/services/exports/export-support-notifier', () => ({ notifySupportOfExportFailure: async () => true }));
vi.mock('@/services/exports/v12/render/render-dossier', () => ({
  renderDossier: async (p: { code: string; source: never; choices: never; onStep: (s: string) => Promise<void>; meta: { reference: string } }) => {
    h.rendus.push({ code: p.code, source: p.source, choices: p.choices });
    await p.onStep('resolve_files'); await p.onStep('render_html'); await p.onStep('render_pdf');
    return {
      pdf: Buffer.from('%PDF-1.7 e2e'), pageCount: 3, passes: 1, data: { export: {} }, plan: { sections: {} }, templateVersion: 'e2e-v1',
      fileBaseName: `Verebona_${p.meta.reference}`, zipEntries: [], items: [], partial: false, warnings: [],
      counts: { integratedPdf: 0, zip: 0, excluded: 0, photos: 0 },
    };
  },
}));
vi.mock('@/services/exports/v12/storage', async (o) => ({ ...(await o<object>()), s3UploadFile: async () => undefined }));

type Compte = { id: number; ownerUserId: number; owner: { id: number; email: string } };
type Json = Record<string, any>;
const APP = 'https://app.e2e.verebona.test';

const IA_ANCIENNE = 'Facture d’un aspirateur balai quetzalcoatl sans fil, 249,90 € TTC.';
const NOTE_CORRIGEE = 'Aspirateur du garage — portail zanzibar';
const IA_EFFACEE = 'Devis de ramonage kumquatier du conduit principal.';
const IA_VISIBLE = 'Attestation d’entretien de la chaudière mirabellier.';
const HISTORIQUE = 'Saisie de l’import yuzuconfit (ancien champ)';

scenario('L114Z', 'Documents — les 5 écarts 113Z : T2, transmissions, dossiers tiers, imports et migration', ({ sql, make }) => {
  useTargetState();

  const as = (c: Compte) => { h.session.userId = c.ownerUserId; h.session.currentAccountId = c.id; };
  const store = () => import('@/services/documents/notes-description/store');
  const ligne = async (id: number) => (await sql<Json[]>`
    SELECT description, notes, notes_user_owned, notes_updated_at, description_source, supplier, upload_status, deleted_at FROM asset_files WHERE id = ${id}`)[0];
  const doc = async (c: Compte, v: { assetId?: number | null; description?: string | null; source?: 'T1' | null; notes?: string | null; owned?: boolean; nom?: string } = {}) => {
    const f = await make.assetFile(c, { assetId: v.assetId ?? null });
    await sql`UPDATE asset_files SET original_filename = ${v.nom ?? `doc-${f.id}.pdf`}, s3_bucket = 'e2e-bucket', upload_status = 'COMPLETED',
        description = ${v.description ?? null}, description_source = ${v.source ?? null}, notes = ${v.notes ?? null}, notes_user_owned = ${v.owned === true}
      WHERE id = ${f.id}`;
    return f.id;
  };
  const lire = async (c: Compte, id: number): Promise<Json> => {
    as(c);
    const { GET } = await import('@/app/api/files/[id]/route');
    const r = await GET(new NextRequest(`http://x/api/files/${id}`), { params: Promise.resolve({ id: String(id) }) });
    expect(r.status).toBe(200);
    return r.json();
  };
  /** Enregistrement du tiroir (mêmes champs que `DocumentDrawer.handleSave`) ; rend le statut et le corps. */
  const enregistrer = async (c: Compte, id: number, extra: Json = {}) => {
    const f = await lire(c, id);
    const { PUT } = await import('@/app/api/documents/[id]/route');
    const body = {
      fileName: f.displayTitle, retainedTitle: f.displayTitle, documentDate: f.documentDate ?? null,
      supplier: f.supplier ?? null, amountCents: f.amountCents ?? null, userEditedFields: f.userEditedFields ?? {}, ...extra,
    };
    const r = await PUT(new NextRequest(`http://x/api/documents/${id}`, { method: 'PUT', body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(id) }) });
    return { status: r.status, json: await r.json() as Json };
  };
  /** Recherche canonique de l'Assistant (adaptateur « documents »). */
  const chercherT2 = async (c: Compte, mot: string) => {
    const { ADAPTATEURS } = await import('@/services/verebona-assistant/registries/retrieval-adapters');
    const { analyserRequeteCanonique } = await import('@/services/verebona-assistant/core/retrieval.service');
    const a = analyserRequeteCanonique(mot);
    return ADAPTATEURS.find((x) => x.name === 'documents')!.search({
      accountId: c.id, normalizedQuery: a.terms.map((t) => t.stem).join(' '), terms: a.terms, intent: 'UNKNOWN', entityFilters: {}, limit: 10,
      period: a.period, documentTypes: a.documentTypes, documentFilters: a.documentFilters, documentTypeFilter: a.documentTypes,
    });
  };
  const chercherDonnees = async (c: Compte, mot: string) => {
    const { accountDataRepository } = await import('@/services/verebona-assistant/core/account-data.repository');
    return accountDataRepository.searchDocuments(c.id, [mot]);
  };
  const creerLien = async (c: Compte, body: Json) => {
    as(c);
    const { POST } = await import('@/app/api/web-links/route');
    const r = await POST(new NextRequest('http://x/api/web-links', { method: 'POST', body: JSON.stringify(body) }));
    return { status: r.status, json: await r.json() as Json };
  };
  const enAttente = async (c: Compte) => (await sql<{ id: number }[]>`
    INSERT INTO asset_files (user_id, account_id, s3_key, s3_bucket, original_filename, filename, mime_type, size, sha256_hash, upload_status)
    VALUES (${c.ownerUserId}, ${c.id}, ${`e2e/${c.id}/${Math.random().toString(36).slice(2)}.pdf`}, 'e2e-bucket', 'scan.pdf', 'scan.pdf',
            'application/pdf', 1234, ${Math.random().toString(16).slice(2).padEnd(64, 'c').slice(0, 64)}, 'PENDING') RETURNING id`)[0].id;
  const confirmer = async (c: Compte, body: Json) => {
    as(c);
    const { POST } = await import('@/app/api/files/confirm/route');
    const r = await POST(new NextRequest('http://x/api/files/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: r.status, json: await r.json() as Json };
  };
  /** Transmission en attente, insérée telle que la route de création l'enregistre. */
  const transmissionEnAttente = async (emetteur: Compte, bien: { id: number }, dest: Compte, payload: Json, documentsInstantane: Json[] = []) => {
    const token = `e2e-l114z-${dest.id}-${Math.random().toString(36).slice(2)}`;
    await sql`INSERT INTO asset_transmissions (asset_id, account_id, initiator_user_id, recipient_email, token, selected_payload, snapshot_payload, keep_active_after, status, sent_at, created_at)
      VALUES (${bien.id}, ${emetteur.id}, ${emetteur.ownerUserId}, ${dest.owner.email}, ${token}, ${JSON.stringify(payload)},
              ${JSON.stringify({ id: bien.id, name: `Bien ${emetteur.id}`, category: 'OBJET', documents: documentsInstantane })}, true, 'pending', now(), now())`;
    return token;
  };
  const accepter = async (dest: Compte, token: string) => {
    as(dest);
    const { POST } = await import('@/app/api/transmission/[token]/route');
    const r = await POST(new NextRequest(`http://x/api/transmission/${token}`, { method: 'POST', body: JSON.stringify({ action: 'accept', confirmDuplicate: true }) }), { params: Promise.resolve({ token }) });
    return { status: r.status, json: await r.json() as Json };
  };
  const recus = (dest: Compte) => sql<Json[]>`
    SELECT original_filename, description, notes, notes_user_owned, description_source FROM asset_files
     WHERE account_id = ${dest.id} AND deleted_at IS NULL ORDER BY original_filename`;
  const selection = (ids: number[], inclure?: unknown) => ({
    includeDocuments: true, selectedDocIds: ids, includeEquipments: false, selectedEquipmentIds: [], includePhotos: false, selectedPhotoIds: [],
    includeEvents: false, selectedEventIds: [], ...(inclure === undefined ? {} : { includeNotesDescription: inclure }),
  });
  const demanderDossier = async (c: Compte, bien: { id: number }, body: Json) => {
    as(c);
    const { POST } = await import('@/app/api/assets/[id]/exports/route');
    const r = await POST(new NextRequest(`${APP}/api/assets/${bien.id}/exports`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: APP }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: String(bien.id) }) });
    return { status: r.status, json: await r.json() as Json };
  };
  const choixDossier = (ids: number[], extra: Json = {}) => ({
    outputFormat: 'PDF', acknowledgements: { pdfOnlyExcludesZipItems: true },
    sections: [{ id: 'documents', enabled: true, items: ids.map((id) => ({ sourceType: 'document', sourceId: id, selected: true, mode: 'PDF' })) }], ...extra,
  });
  /** Exécute la génération en file (job réel, lecture stricte réelle) ; rend l'instantané et ce qu'a reçu le rendu. */
  const executerDossier = async (publicId: string) => {
    const { claimNextGeneration } = await import('@/services/exports/v12/generation/repository');
    const { runGeneration } = await import('@/services/exports/v12/generation/job');
    const pris = await claimNextGeneration('e2e-l114z');
    expect(pris?.publicId).toBe(publicId);
    h.rendus = [];
    const issue = await runGeneration(pris!, 'e2e-l114z');
    const [g] = await sql<Json[]>`SELECT status, error_code, snapshot_json FROM export_generation WHERE public_id = ${publicId}`;
    return { issue, generation: g, rendu: h.rendus[0] ?? null };
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    (await store()).resetNotesDescriptionSchemaCache();
    await sql`UPDATE export_generation SET status = 'failed', locked_by = NULL, locked_until = NULL WHERE status IN ('queued', 'generating')`;
  });

  // ══ E01 ═══════════════════════════════════════════════════════════════════

  it('L114Z-E2E-01 — E01 : T2 respecte la valeur affichée (note corrigée, note vide, note non modifiée, historique) ; aucune fuite entre comptes', async () => {
    const c = await make.account({ plan: 'premium' }) as Compte;
    const autre = await make.account({ plan: 'premium' }) as Compte;
    const corrige = await doc(c, { description: IA_ANCIENNE, source: 'T1', nom: 'corrige.pdf' });
    const efface = await doc(c, { description: IA_EFFACEE, source: 'T1', nom: 'efface.pdf' });
    const intact = await doc(c, { description: IA_VISIBLE, source: 'T1', nom: 'intact.pdf' });
    const historique = await doc(c, { description: HISTORIQUE, source: null, nom: 'historique.pdf' });
    await doc(autre, { description: 'Autre compte : zanzibar quetzalcoatl mirabellier', source: 'T1', notes: 'zanzibar', owned: true, nom: 'autre.pdf' });
    // Extraction T1 persistée (description T1 + contenu réellement extrait du document).
    for (const [id, d, texte] of [[corrige, IA_ANCIENNE, 'Référence produit ASPIBALAI9000'], [efface, IA_EFFACEE, 'Ramoneur agréé RAMONEX42']] as const) {
      await sql`INSERT INTO document_extractions (account_id, file_id, description, full_text, full_text_chars) VALUES (${c.id}, ${id}, ${d}, ${texte}, ${texte.length})`;
    }
    const ids = (r: Array<{ meta?: Record<string, unknown> }>) => r.map((s) => s.meta?.documentId);

    // Avant toute saisie : la description T1 EST le champ courant → trouvée, rendue telle quelle.
    expect(ids(await chercherT2(c, 'quetzalcoatl'))).toEqual([corrige]);
    expect((await chercherDonnees(c, 'kumquatier')).map((d) => d.fileId)).toEqual([efface]);

    // L'utilisateur corrige l'un et efface l'autre (routes réelles, aucun appel T1 : rien n'est en file).
    expect((await enregistrer(c, corrige, { notesDescription: NOTE_CORRIGEE })).status).toBe(200);
    expect((await enregistrer(c, efface, { notesDescription: '' })).status).toBe(200);
    expect(await ligne(corrige)).toMatchObject({ description: IA_ANCIENNE, notes: NOTE_CORRIGEE, notes_user_owned: true });
    expect(await ligne(efface)).toMatchObject({ description: IA_EFFACEE, notes: null, notes_user_owned: true });

    const { USER_NOTE_PREFIX, USER_DECLARED_PROVENANCE } = await import('@/services/verebona-assistant/registries/retrieval-adapters');
    // Réponse T2 immédiatement après l'enregistrement — texte NOUVEAU : trouvé, déclaré par l'utilisateur.
    const nouveau = await chercherT2(c, 'zanzibar');
    expect(ids(nouveau)).toEqual([corrige]);
    expect(nouveau[0].content).toContain(`${USER_NOTE_PREFIX} ${NOTE_CORRIGEE}`);
    expect(nouveau[0].content).not.toContain('quetzalcoatl');
    expect(nouveau[0].meta).toMatchObject({ userNoteProvenance: USER_DECLARED_PROVENANCE });
    expect((await chercherDonnees(c, 'zanzibar')).map((d) => d.fileId)).toEqual([corrige]);
    // Texte ANCIEN (description masquée par la note) : plus trouvé par aucun chemin.
    expect(ids(await chercherT2(c, 'quetzalcoatl'))).toEqual([]);
    expect(await chercherDonnees(c, 'quetzalcoatl')).toEqual([]);
    // Note explicitement vide : la description effacée ne ressuscite pas par la recherche plein texte.
    expect(ids(await chercherT2(c, 'kumquatier'))).toEqual([]);
    expect(await chercherDonnees(c, 'kumquatier')).toEqual([]);
    // Note non modifiée : la description T1 reste le champ courant (pas de note déclarée).
    const visible = await chercherT2(c, 'mirabellier');
    expect(ids(visible)).toEqual([intact]);
    expect(visible[0].content).toContain(IA_VISIBLE);
    expect(visible[0].content).not.toContain(USER_NOTE_PREFIX);
    expect(visible[0].meta).not.toHaveProperty('userNoteProvenance');
    // Description historique d'origine inconnue : conservée et trouvée.
    expect(ids(await chercherT2(c, 'yuzuconfit'))).toEqual([historique]);
    expect((await chercherDonnees(c, 'yuzuconfit')).map((d) => d.fileId)).toEqual([historique]);

    // Faits indépendants : le contenu RÉELLEMENT extrait du document reste exploitable (canal du texte intégral).
    const parContenu = await chercherDonnees(c, 'aspibalai9000');
    expect(parContenu.map((d) => d.fileId)).toEqual([corrige]);
    expect(parContenu[0].snippet).toContain('ASPIBALAI9000');
    expect((await chercherDonnees(c, 'ramonex42')).map((d) => d.fileId)).toEqual([efface]);
    // Contenu passé au modèle pour une synthèse : jamais la description masquée ou effacée.
    const { buildSynthesisContent } = await import('@/services/verebona-assistant/canonical/synthesis-content');
    const synthese = JSON.stringify(await buildSynthesisContent(c.id, { fileIds: [corrige, efface, intact], terms: [] }));
    expect(synthese).toContain('ASPIBALAI9000');
    expect(synthese).not.toContain('quetzalcoatl');
    expect(synthese).not.toContain('kumquatier');

    // Isolation : l'autre compte ne voit rien de `c`, et `c` ne voit rien de l'autre compte.
    expect(ids(await chercherT2(autre, 'zanzibar'))).not.toContain(corrige);
    expect((await chercherDonnees(autre, 'aspibalai9000'))).toEqual([]);
    for (const mot of ['zanzibar', 'mirabellier']) {
      for (const s of await chercherT2(c, mot)) expect(JSON.stringify(s)).not.toContain('Autre compte');
    }
    // Recherche « Mes documents » (V2) : inchangée, la note y est toujours trouvée.
    const { matchingIdsForList } = await import('@/services/search/global-search.service');
    expect(await matchingIdsForList(c.id, 'zanzibar', 'document')).toEqual([corrige]);
    expect(await matchingIdsForList(autre.id, 'zanzibar', 'document')).not.toContain(corrige);
  });

  // ══ E02 ═══════════════════════════════════════════════════════════════════

  it('L114Z-E2E-02 — E02 : transmission fail-closed ; texte effectif seul ; métadonnées absentes ; panne SQL simulée ; droits du lien', async () => {
    const emetteur = await make.account({ plan: 'premium' }) as Compte;
    const bien = await make.asset(emetteur, { category: 'OBJET', name: `Bien ${emetteur.id}` });
    const dNote = await doc(emetteur, { assetId: bien.id, description: IA_ANCIENNE, source: 'T1', notes: NOTE_CORRIGEE, owned: true, nom: 'a-note.pdf' });
    const dT1 = await doc(emetteur, { assetId: bien.id, description: IA_VISIBLE, source: 'T1', nom: 'b-t1.pdf' });
    const dVide = await doc(emetteur, { assetId: bien.id, description: IA_EFFACEE, source: 'T1', owned: true, nom: 'c-vide.pdf' });
    const tous = [dNote, dT1, dVide];
    const nouveauDest = async () => await make.account({ plan: 'premium' }) as Compte;

    // Inclusion NON cochée, omise ou falsifiée : rien n'est transmis.
    for (const v of [undefined, false, 'true', 1]) {
      const dest = await nouveauDest();
      expect((await accepter(dest, await transmissionEnAttente(emetteur, bien, dest, selection(tous, v)))).status).toBe(200);
      const copies = await recus(dest);
      expect(copies).toHaveLength(3);
      for (const x of copies) expect(x).toMatchObject({ description: null, notes: null, notes_user_owned: false, description_source: null });
    }

    // Inclusion cochée : uniquement le texte effectif visible de chaque document.
    const dest = await nouveauDest();
    expect((await accepter(dest, await transmissionEnAttente(emetteur, bien, dest, selection(tous, true)))).status).toBe(200);
    expect((await recus(dest)).map((x) => [x.original_filename, x.description, x.notes, x.notes_user_owned, x.description_source])).toEqual([
      ['a-note.pdf', null, NOTE_CORRIGEE, true, null],      // note prioritaire : jamais la description en parallèle
      ['b-t1.pdf', IA_VISIBLE, null, false, 'T1'],          // description T1 affichée, provenance établie
      ['c-vide.pdf', null, null, false, null],              // effacement explicite : rien
    ]);
    // Charge reçue : aucune trace de l'ancienne description masquée ou effacée, dans aucun champ.
    const charge = JSON.stringify(await sql`SELECT * FROM asset_files WHERE account_id = ${dest.id}`);
    expect(charge).not.toContain('quetzalcoatl');
    expect(charge).not.toContain('kumquatier');

    // Instantané périmé (« tout le bien », figé à l'envoi) : seules les valeurs COURANTES comptent.
    const perime = [
      { id: dNote, originalFilename: 'a-note.pdf', isWebLink: false, description: IA_ANCIENNE, notes: 'Ancienne note de l’instantané' },
      { id: dVide, originalFilename: 'c-vide.pdf', isWebLink: false, description: IA_EFFACEE, notes: null },
      // Métadonnées absentes : document de l'instantané qui n'existe plus dans le compte émetteur.
      { id: 2_000_000_000, originalFilename: 'd-disparu.pdf', isWebLink: false, description: 'Description yuzuconfit disparue', notes: 'Note disparue' },
    ];
    const destSnap = await nouveauDest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await accepter(destSnap, await transmissionEnAttente(emetteur, bien, destSnap, selection([], true), perime))).status).toBe(200);
    expect((await recus(destSnap)).map((x) => [x.original_filename, x.description, x.notes])).toEqual([
      ['a-note.pdf', null, NOTE_CORRIGEE], ['c-vide.pdf', null, null], ['d-disparu.pdf', null, null],
    ]);

    // Exception SQL / délai simulé à la lecture des métadonnées : refus explicite, rien chez le destinataire.
    const destPanne = await nouveauDest();
    const jeton = await transmissionEnAttente(emetteur, bien, destPanne, selection(tous, true));
    const { pgClient } = await import('@/db');
    const reel = pgClient.unsafe.bind(pgClient);
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const panne = vi.spyOn(pgClient, 'unsafe').mockImplementation(((texte: string, ...reste: unknown[]) => {
      if (texte.includes('SELECT id, notes, description, notes_user_owned, description_source')) {
        return Promise.reject(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
      }
      return (reel as (...a: unknown[]) => unknown)(texte, ...reste);
    }) as never);
    const refus = await accepter(destPanne, jeton);
    expect(refus.status).toBe(503);
    expect(refus.json).toMatchObject({ error: 'NOTES_DESCRIPTION_UNAVAILABLE', reason: 'READ_FAILED' });
    expect(refus.json.message).toMatch(/Rien n’a été transmis/);
    expect(await recus(destPanne)).toEqual([]);
    expect(Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM assets WHERE account_id = ${destPanne.id} AND deleted_at IS NULL`)[0].n)).toBe(0);
    expect((await sql<Json[]>`SELECT status, accepted_at FROM asset_transmissions WHERE token = ${jeton}`)[0]).toEqual({ status: 'pending', accepted_at: null });
    // Journal : motif et nombres, jamais le texte documentaire.
    const trace = erreurs.mock.calls.map((a) => a.map(String).join(' ')).join(' ');
    expect(trace).toMatch(/inclusion refusée — lecture des métadonnées en échec \(compte \d+, 3 document\(s\), code 57014\)/);
    for (const t of ['quetzalcoatl', 'kumquatier', 'zanzibar', 'mirabellier']) expect(trace).not.toContain(t);
    panne.mockRestore();
    // La panne passée, le même lien fonctionne (rien n'a été consommé).
    expect((await accepter(destPanne, jeton)).status).toBe(200);
    expect(await recus(destPanne)).toHaveLength(3);

    // Droits du lien : un autre compte que le destinataire invité ne peut pas accepter ; le GET n'expose aucun texte.
    const invite = await nouveauDest();
    const intrus = await nouveauDest();
    const jeton2 = await transmissionEnAttente(emetteur, bien, invite, selection(tous, true));
    expect((await accepter(intrus, jeton2)).status).toBe(403);
    expect(await recus(intrus)).toEqual([]);
    const { GET } = await import('@/app/api/transmission/[token]/route');
    const vue = JSON.stringify(await (await GET(new NextRequest(`http://x/api/transmission/${jeton2}`), { params: Promise.resolve({ token: jeton2 }) })).json());
    for (const t of ['zanzibar', 'quetzalcoatl', 'mirabellier', 'kumquatier']) expect(vue).not.toContain(t);
    // L'émetteur garde tout.
    expect(await ligne(dNote)).toMatchObject({ description: IA_ANCIENNE, notes: NOTE_CORRIGEE, notes_user_owned: true });
  });

  // ══ E03 ═══════════════════════════════════════════════════════════════════

  it('L114Z-E2E-03 — E03 : dossiers tiers — exclu par défaut, option omise ou falsifiée, inclusion volontaire figée, texte affiché seul, régénération', async () => {
    const c = await make.account({ plan: 'premium' }) as Compte;
    const bien = await make.asset(c, { category: 'OBJET', name: 'Vélo cargo' });
    const dNote = await doc(c, { assetId: bien.id, description: IA_ANCIENNE, source: 'T1', notes: NOTE_CORRIGEE, owned: true, nom: 'a-note.pdf' });
    const dT1 = await doc(c, { assetId: bien.id, description: IA_VISIBLE, source: 'T1', nom: 'b-t1.pdf' });
    const dVide = await doc(c, { assetId: bien.id, description: IA_EFFACEE, source: 'T1', owned: true, nom: 'c-vide.pdf' });
    const dHors = await doc(c, { assetId: bien.id, notes: 'Note d’une pièce non retenue yuzuconfit', owned: true, nom: 'd-hors.pdf' });
    const retenus = [dNote, dT1, dVide];
    const texteDe = (r: { source: { documents: Array<{ id: number; notesDescription?: string | null }> } } | null, id: number) => r?.source.documents.find((d) => d.id === id)?.notesDescription ?? null;

    // La source d'un dossier ne porte jamais le texte (défaut du lot 113Z conservé), quel que soit le modèle.
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    for (const exportType of ['VENTE', 'ASSURANCE_SOUSCRIPTION', 'DOSSIER_COMPLET'] as const) {
      const s = await loadExportSource({ assetId: bien.id, accountId: c.id, userId: c.ownerUserId, exportType });
      expect(s.documents.map((d) => d.id)).toEqual(expect.arrayContaining([...retenus, dHors]));
      expect(JSON.stringify(s)).not.toMatch(/zanzibar|quetzalcoatl|mirabellier|kumquatier|yuzuconfit/);
    }

    // Par défaut, option omise (ancien client), falsifiée, ou tiroir historique : exclu, vérifiable dans l'instantané.
    for (const corps of [
      { exportType: 'VENTE', choices: choixDossier(retenus) },
      { exportType: 'VENTE', choices: choixDossier(retenus, { includeNotesDescription: 'true' }) },
      { exportType: 'VENTE', choices: choixDossier(retenus, { includeNotesDescription: 1 }) },
      { exportType: 'VENTE', requestedOutputs: ['PDF'], options: { customDocIds: retenus, includeNotesDescription: true }, includeNotesDescription: true },
    ]) {
      const d = await demanderDossier(c, bien, corps);
      expect(d.status).toBe(202);
      const x = await executerDossier(d.json.publicId);
      expect(x.issue).toBe('ready');
      expect(x.generation.snapshot_json.notesDescription).toEqual({ included: false, documents: 0 });
      for (const id of [...retenus, dHors]) expect(texteDe(x.rendu, id)).toBeNull();
      expect(JSON.stringify(x.generation.snapshot_json)).not.toMatch(/zanzibar|quetzalcoatl|mirabellier|kumquatier/);
    }

    // Inclusion volontaire, pour la vente, l'assurance et le dossier complet.
    for (const exportType of ['VENTE', 'ASSURANCE_SOUSCRIPTION', 'DOSSIER_COMPLET'] as const) {
      const d = await demanderDossier(c, bien, { exportType, choices: choixDossier(retenus, { includeNotesDescription: true }) });
      expect(d.status, exportType).toBe(202);
      const x = await executerDossier(d.json.publicId);
      expect(x.issue, exportType).toBe('ready');
      expect(texteDe(x.rendu, dNote)).toBe(NOTE_CORRIGEE);   // origine utilisateur : la note, jamais l'IA masquée
      expect(texteDe(x.rendu, dT1)).toBe(IA_VISIBLE);        // origine IA : la description affichée
      expect(texteDe(x.rendu, dVide)).toBeNull();            // effacement volontaire
      expect(texteDe(x.rendu, dHors)).toBeNull();            // pièce non retenue
      const snap = x.generation.snapshot_json;
      expect(snap.notesDescription).toEqual({ included: true, documents: 2 });
      expect(snap.choices.includeNotesDescription).toBe(true);
      expect(JSON.stringify(x.rendu)).not.toMatch(/quetzalcoatl|kumquatier|yuzuconfit/);
    }

    // PDF réel (modèle réel, données réelles du job) : le texte affiché une fois, rien d'autre.
    const { planSelection, parseChoicesPayload } = await import('@/services/exports/v12/data/choices');
    const { mapDossierData } = await import('@/services/exports/v12/data/mappers');
    const { renderDossierHtml } = await import('@/services/exports/v12/templates');
    const { attachNotesDescription } = await import('@/services/exports/v12/data/source');
    const brut = await loadExportSource({ assetId: bien.id, accountId: c.id, userId: c.ownerUserId, exportType: 'VENTE' });
    const parsed = parseChoicesPayload('VENTE', choixDossier(retenus, { includeNotesDescription: true }));
    if (!parsed.ok) throw new Error('choix invalides');
    const enrichi = await attachNotesDescription(brut, c.id, retenus, 'e2e');
    const html = renderDossierHtml('VENTE', mapDossierData('VENTE', {
      source: enrichi, plan: planSelection('VENTE', enrichi, parsed.choices, '2026-11-13'), resolved: null,
      meta: { reference: 'VBN-E2E', generatedAt: '2026-11-13T09:00:00+01:00', preparedBy: null, templateLabel: 'e2e', zipName: null, label: 'Vente' },
      today: '2026-11-13',
    }) as never, { sys: 'SYS/', asset: () => null, stylesheets: [], pageMap: null }).html;
    expect(html).toContain('Notes / Description des documents');
    expect(html.split('portail zanzibar').length - 1).toBe(1);
    expect(html.split('mirabellier').length - 1).toBe(1);
    expect(html).not.toMatch(/quetzalcoatl|kumquatier|yuzuconfit/);
    // Lecture stricte bornée au compte : un autre compte n'obtient rien pour ces documents.
    const autre = await make.account({ plan: 'premium' }) as Compte;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await attachNotesDescription(brut, autre.id, retenus, 'e2e')).documents.every((d) => !d.notesDescription)).toBe(true);

    // Dossier régénéré après un changement : l'utilisateur efface sa note → la régénération n'imprime plus rien
    // pour cette pièce (et surtout pas l'ancienne description IA).
    expect((await enregistrer(c, dNote, { notesDescription: '' })).status).toBe(200);
    const premier = await demanderDossier(c, bien, { exportType: 'VENTE', choices: choixDossier(retenus, { includeNotesDescription: true }) });
    const regen = await demanderDossier(c, bien, { exportType: 'VENTE', regenerate: true, choices: choixDossier([dNote, dT1], { includeNotesDescription: true }) });
    expect(regen.status).toBe(202);
    expect(regen.json.replaced.map((r: Json) => r.publicId)).toEqual([premier.json.publicId]);
    const x = await executerDossier(regen.json.publicId);
    expect(x.issue).toBe('ready');
    expect(texteDe(x.rendu, dNote)).toBeNull();
    expect(texteDe(x.rendu, dT1)).toBe(IA_VISIBLE);
    expect(x.generation.snapshot_json.notesDescription).toEqual({ included: true, documents: 1 });

    // Panne de métadonnées pendant la génération : le dossier ÉCHOUE (aucun fichier, aucun texte de repli).
    const d = await demanderDossier(c, bien, { exportType: 'VENTE', choices: choixDossier(retenus, { includeNotesDescription: true }) });
    const { pgClient } = await import('@/db');
    const reel = pgClient.unsafe.bind(pgClient);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const panne = vi.spyOn(pgClient, 'unsafe').mockImplementation(((texte: string, ...reste: unknown[]) => (
      texte.includes('SELECT id, notes, description, notes_user_owned, description_source')
        ? Promise.reject(new Error('connexion perdue'))
        : (reel as (...a: unknown[]) => unknown)(texte, ...reste))) as never);
    await sql`UPDATE export_generation SET generation_attempt_count = 2 WHERE public_id = ${d.json.publicId}`;
    const enPanne = await executerDossier(d.json.publicId);
    panne.mockRestore();
    expect(enPanne.issue).toBe('failed');
    expect(enPanne.rendu).toBeNull();
    expect(enPanne.generation).toMatchObject({ status: 'failed', error_code: 'DB_ERROR' });
  });

  // ══ E04 ═══════════════════════════════════════════════════════════════════

  it('L114Z-E2E-04 — E04 : import et lien web — 0 / 1 / 5 000 / 5 001 caractères, Unicode, ancien champ ; rien d’écrit en cas de refus', async () => {
    const c = await make.account({ plan: 'premium' }) as Compte;
    const de = (n: number, car = 'a') => car.repeat(n);
    const liens = async () => Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${c.id} AND is_web_link`)[0].n);

    // ── Lien web
    const sans = await creerLien(c, { url: 'https://exemple.fr/0', title: 'Zéro', notes: '' });
    expect(sans.status).toBe(201);
    expect(await ligne(sans.json.webLink.id)).toMatchObject({ notes: null, notes_user_owned: false, description: null });
    const un = await creerLien(c, { url: 'https://exemple.fr/1', title: 'Un', notes: 'x' });
    expect(await ligne(un.json.webLink.id)).toMatchObject({ notes: 'x', notes_user_owned: true });
    const max = await creerLien(c, { url: 'https://exemple.fr/5000', title: 'Max', notes: de(5000) });
    expect(max.status).toBe(201);
    expect((await ligne(max.json.webLink.id)).notes).toHaveLength(5000);
    const unicode = `Chaudière — révision ✔ 🏠 ${de(100, 'é')}`;
    const uni = await creerLien(c, { url: 'https://exemple.fr/u', title: 'Unicode', notes: unicode });
    expect((await ligne(uni.json.webLink.id)).notes).toBe(unicode);
    const avant = await liens();
    for (const corps of [
      { url: 'https://exemple.fr/5001', title: 'Trop', notes: `${de(5000)}Z` },                    // 5 001 : la fin « Z » serait perdue
      { url: 'https://exemple.fr/ancien', title: 'Ancien client', description: de(5001) },          // ancien champ : mêmes règles
      { url: 'https://exemple.fr/emoji', title: 'Emoji', notes: de(2501, '🏠') },                   // 5 002 unités UTF-16
    ]) {
      const r = await creerLien(c, corps);
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject({ error: 'NOTES_TOO_LONG', maxLength: 5000, message: 'Notes / Description : 5000 caractères au plus' });
    }
    expect((await creerLien(c, { url: 'https://exemple.fr/type', title: 'Type', notes: { a: 1 } })).status).toBe(400);
    expect(await liens()).toBe(avant); // aucune écriture, même partielle
    // Ancien champ dans la limite : lu comme texte libre de l'utilisateur (→ notes), jamais description T1.
    const ancien = await creerLien(c, { url: 'https://exemple.fr/a', title: 'Ancien', description: 'Ancien « Titre / Description »' });
    expect(await ligne(ancien.json.webLink.id)).toMatchObject({ description: null, notes: 'Ancien « Titre / Description »', notes_user_owned: true });

    // ── Import unitaire (confirmation)
    const f5000 = await enAttente(c);
    expect((await confirmer(c, { fileId: f5000, title: 'Facture chaudière', notes: de(5000) })).status).toBe(200);
    const l5000 = await ligne(f5000);
    expect(l5000).toMatchObject({ upload_status: 'COMPLETED', notes_user_owned: true, description: null });
    expect(l5000.notes).toHaveLength(5000);
    // Le titre reste séparé des notes.
    expect((await sql<{ retained_title: string }[]>`SELECT retained_title FROM asset_files WHERE id = ${f5000}`)[0].retained_title).toBe('Facture chaudière');
    const f5001 = await enAttente(c);
    const refus = await confirmer(c, { fileId: f5001, notes: `${de(5000)}Z` });
    expect(refus.status).toBe(400);
    expect(refus.json).toMatchObject({ error: 'NOTES_TOO_LONG', maxLength: 5000 });
    expect(await ligne(f5001)).toMatchObject({ upload_status: 'PENDING', notes: null, notes_user_owned: false }); // rien d'écrit
    const fAncien = await enAttente(c);
    expect((await confirmer(c, { fileId: fAncien, description: de(5001) })).status).toBe(400);
    expect(await ligne(fAncien)).toMatchObject({ upload_status: 'PENDING', notes: null, description: null });
    const fVide = await enAttente(c);
    expect((await confirmer(c, { fileId: fVide })).status).toBe(200);
    expect(await ligne(fVide)).toMatchObject({ upload_status: 'COMPLETED', notes: null, notes_user_owned: false });
    // Après correction de la saisie, le même fichier se confirme (le refus n'a rien consommé).
    expect((await confirmer(c, { fileId: f5001, notes: de(5000) })).status).toBe(200);

    // ── Modification (appel direct de l'API) : même limite, même message, aucune écriture.
    const d = await doc(c, { description: IA_VISIBLE, source: 'T1' });
    const trop = await enregistrer(c, d, { notesDescription: de(5001), supplier: 'Fournisseur modifié' });
    expect(trop.status).toBe(400);
    expect(trop.json.message).toBe('Notes / Description : 5000 caractères au plus');
    expect(await ligne(d)).toMatchObject({ notes: null, notes_user_owned: false, description: IA_VISIBLE, supplier: null });
    // La description T1 et le stock historique ne sont pas touchés par ces contrôles.
    expect(await ligne(d)).toMatchObject({ description: IA_VISIBLE, description_source: 'T1' });
  });

  // ══ E05 — schéma présent ═════════════════════════════════════════════════

  it('L114Z-E2E-05 — E05 : création, modification, effacement explicite, réouverture, écritures concurrentes — notes, drapeau et date cohérents', async () => {
    const c = await make.account({ plan: 'premium' }) as Compte;
    const d = await doc(c, { description: IA_VISIBLE, source: 'T1' });
    // Modification : les trois colonnes ensemble.
    expect((await enregistrer(c, d, { notesDescription: 'Ma note' })).status).toBe(200);
    const apres = await ligne(d);
    expect(apres).toMatchObject({ notes: 'Ma note', notes_user_owned: true, description: IA_VISIBLE, description_source: 'T1' });
    expect(apres.notes_updated_at).not.toBeNull();
    // Effacement explicite : valeur volontairement vide, description T1 interne préservée, provenance intacte.
    const efface = await enregistrer(c, d, { notesDescription: '' });
    expect(efface.json.notesDescription).toEqual({ text: '', origin: 'USER', userOwned: true, fromNotes: true });
    expect(await ligne(d)).toMatchObject({ notes: null, notes_user_owned: true, description: IA_VISIBLE, description_source: 'T1' });
    // Réouverture : toujours vide.
    expect((await lire(c, d)).notesDescription).toEqual({ text: '', origin: 'USER', userOwned: true, fromNotes: true });
    // Ouvrir / enregistrer sans modifier : aucune écriture (pas de NULL converti en choix).
    const intact = await doc(c, { description: HISTORIQUE, source: null });
    expect((await enregistrer(c, intact, { notesDescription: HISTORIQUE })).status).toBe(200);
    expect(await ligne(intact)).toMatchObject({ notes: null, notes_user_owned: false, notes_updated_at: null, description: HISTORIQUE, description_source: null });

    // Écritures concurrentes : chaque écriture est atomique — l'état final est celui de l'une des deux, complet.
    const conc = await doc(c, { description: IA_ANCIENNE, source: 'T1' });
    const f = await lire(c, conc);
    const { PUT } = await import('@/app/api/documents/[id]/route');
    const envoyer = (texte: string) => PUT(new NextRequest(`http://x/api/documents/${conc}`, {
      method: 'PUT', body: JSON.stringify({ fileName: f.displayTitle, retainedTitle: f.displayTitle, userEditedFields: {}, notesDescription: texte }),
    }), { params: Promise.resolve({ id: String(conc) }) });
    const reponses = await Promise.all(['Note A', 'Note B', ''].map(envoyer));
    expect(reponses.map((r) => r.status)).toEqual([200, 200, 200]);
    const fin = await ligne(conc);
    expect(fin.notes_user_owned).toBe(true);
    expect(['Note A', 'Note B', null]).toContain(fin.notes);
    expect(fin.description).toBe(IA_ANCIENNE);
    // Ce que voit l'utilisateur correspond à ce qui est stocké (jamais l'ancienne description).
    expect((await lire(c, conc)).notesDescription.text).toBe(fin.notes ?? '');

    // Santé : schéma relu en base.
    const { readNotesDescriptionSchemaHealth } = await import('@/services/documents/notes-description/schema-health');
    const sante = await readNotesDescriptionSchemaHealth();
    expect(sante).toMatchObject({ state: 'READY', missingColumns: [], error: null });
    expect(sante.userOwnedDocuments).toBeGreaterThanOrEqual(2);
  });

  // ══ E05 — migration absente (dernier cas : le schéma de la base du fichier est retiré puis rétabli) ══

  it('L114Z-E2E-06 — E05 : migration ABSENTE → refus explicites sans écriture partielle, lectures disponibles, alerte ; 1704 rejouée → rétabli', async () => {
    const c = await make.account({ plan: 'premium' }) as Compte;
    const bien = await make.asset(c, { category: 'OBJET', name: `Bien ${c.id}` });
    const d = await doc(c, { assetId: bien.id, description: IA_VISIBLE, source: 'T1', nom: 'a.pdf' });
    const avecNote = await doc(c, { assetId: bien.id, description: IA_ANCIENNE, source: 'T1', notes: NOTE_CORRIGEE, owned: true, nom: 'b.pdf' });
    const dest = await make.account({ plan: 'premium' }) as Compte;
    const jetonInclus = await transmissionEnAttente(c, bien, dest, selection([d, avecNote], true));
    const fichier = await enAttente(c);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Retour arrière simulé de la migration 1580 (base propre à ce fichier).
    await sql`ALTER TABLE asset_files DROP COLUMN notes_user_owned, DROP COLUMN notes_updated_at, DROP COLUMN description_source,
      DROP COLUMN description_t1_status, DROP COLUMN description_t1_status_at, DROP COLUMN description_t1_run_id`;
    const s = await store();
    s.resetNotesDescriptionSchemaCache();
    expect(await s.notesDescriptionSchemaState()).toBe('MISSING');
    const brut = async (id: number) => (await sql<Json[]>`SELECT notes, description, supplier, upload_status FROM asset_files WHERE id = ${id}`)[0];

    // Alerte de disponibilité (BO › Exploitation › Santé).
    const { readNotesDescriptionSchemaHealth } = await import('@/services/documents/notes-description/schema-health');
    expect(await readNotesDescriptionSchemaHealth()).toMatchObject({
      state: 'MISSING', userOwnedDocuments: null,
      missingColumns: expect.arrayContaining(['notes_user_owned', 'description_source', 'description_t1_status', 'notes_updated_at']),
    });

    // Modification et effacement : refusés, AUCUNE écriture partielle (ni la note, ni l'autre champ de la même demande).
    for (const saisie of ['Nouvelle note', '']) {
      const r = await enregistrer(c, d, { notesDescription: saisie, supplier: 'Fournisseur modifié' });
      expect(r.status).toBe(503);
      expect(r.json).toMatchObject({ error: 'NOTES_INTENT_UNAVAILABLE', reason: 'SCHEMA_MISSING' });
      expect(r.json.message).toMatch(/rien n’a été modifié/);
      expect(await brut(d)).toEqual({ notes: null, description: IA_VISIBLE, supplier: null, upload_status: 'COMPLETED' });
    }
    // Parcours indépendants non bloqués : lecture du document, modification d'un autre champ, création sans note.
    expect((await lire(c, d)).notesDescription).toMatchObject({ text: IA_VISIBLE });
    expect((await enregistrer(c, d, { supplier: 'Fournisseur modifié' })).status).toBe(200);
    expect((await brut(d)).supplier).toBe('Fournisseur modifié');
    expect((await creerLien(c, { url: 'https://exemple.fr/sans', title: 'Sans note' })).status).toBe(201);
    expect((await confirmer(c, { fileId: await enAttente(c) })).status).toBe(200);
    // Création avec une note : refusée, rien n'est créé ni confirmé.
    const liensAvant = Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${c.id} AND is_web_link`)[0].n);
    const lien = await creerLien(c, { url: 'https://exemple.fr/avec', title: 'Avec note', notes: 'Ma note' });
    expect(lien.status).toBe(503);
    expect(lien.json).toMatchObject({ error: 'NOTES_INTENT_UNAVAILABLE' });
    expect(Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${c.id} AND is_web_link`)[0].n)).toBe(liensAvant);
    const imp = await confirmer(c, { fileId: fichier, notes: 'Ma note' });
    expect(imp.status).toBe(503);
    expect(await brut(fichier)).toMatchObject({ upload_status: 'PENDING', notes: null });

    // Sorties vers un tiers avec inclusion : refusées (le schéma incomplet n'augmente pas le risque d'exposition).
    const refusAccept = await accepter(dest, jetonInclus);
    expect(refusAccept.status).toBe(503);
    expect(refusAccept.json).toMatchObject({ error: 'NOTES_DESCRIPTION_UNAVAILABLE', reason: 'SCHEMA_MISSING' });
    expect(Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${dest.id}`)[0].n)).toBe(0);
    expect(Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM assets WHERE account_id = ${dest.id}`)[0].n)).toBe(0);
    expect((await sql<Json[]>`SELECT status, accepted_at FROM asset_transmissions WHERE token = ${jetonInclus}`)[0]).toEqual({ status: 'pending', accepted_at: null });
    as(c);
    const { POST: creerTransmission } = await import('@/app/api/assets/[id]/transmission/route');
    const transmissionsAvant = Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_transmissions WHERE asset_id = ${bien.id}`)[0].n);
    const rc = await creerTransmission(new NextRequest(`http://x/api/assets/${bien.id}/transmission`, { method: 'POST',
      body: JSON.stringify({ recipientEmail: dest.owner.email, keepActiveAfterTransmission: true, selectedPayload: selection([d], true) }) }), { params: Promise.resolve({ id: String(bien.id) }) });
    expect(rc.status).toBe(503);
    expect(await rc.json()).toMatchObject({ error: 'NOTES_DESCRIPTION_UNAVAILABLE', reason: 'SCHEMA_MISSING' });
    expect(Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_transmissions WHERE asset_id = ${bien.id}`)[0].n)).toBe(transmissionsAvant);
    const dossier = await demanderDossier(c, bien, { exportType: 'VENTE', choices: choixDossier([d], { includeNotesDescription: true }) });
    expect(dossier.status).toBe(503);
    expect(dossier.json).toMatchObject({ code: 'NOTES_DESCRIPTION_UNAVAILABLE' });
    expect(Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM export_generation WHERE asset_id = ${bien.id}`)[0].n)).toBe(0);
    // Sans inclusion, transmission et dossier restent possibles (exclusion par défaut : aucun texte).
    const destSans = await make.account({ plan: 'premium' }) as Compte;
    expect((await accepter(destSans, await transmissionEnAttente(c, bien, destSans, selection([d, avecNote])))).status).toBe(200);
    for (const x of await sql<Json[]>`SELECT description, notes FROM asset_files WHERE account_id = ${destSans.id}`) expect(x).toEqual({ description: null, notes: null });
    expect((await demanderDossier(c, bien, { exportType: 'VENTE', choices: choixDossier([d]) })).status).toBe(202);
    // Recherche de l'Assistant : disponible (aucune reprise en main ne peut exister sans les colonnes).
    expect((await chercherT2(c, 'mirabellier')).map((x) => x.meta?.documentId)).toEqual([d]);
    expect((await chercherDonnees(c, 'zanzibar')).map((x) => x.fileId)).toEqual([avecNote]);

    // Migration 1704 (filet de sûreté) rejouée deux fois : idempotente, colonnes rétablies.
    const m1704 = readFileSync(join(process.cwd(), 'src/db/migrations/1704_l114z_notes_description_surete.sql'), 'utf8');
    for (let i = 0; i < 2; i++) await sql.begin(async (tx) => { await tx.unsafe(m1704); });
    s.resetNotesDescriptionSchemaCache();
    expect(await s.notesDescriptionSchemaState()).toBe('READY');
    expect(await readNotesDescriptionSchemaHealth()).toMatchObject({ state: 'READY', missingColumns: [] });
    // Aucun NULL historique converti en choix de l'utilisateur, aucune provenance inventée.
    expect(await sql<Json[]>`SELECT DISTINCT notes_user_owned, description_source, notes_updated_at FROM asset_files WHERE account_id = ${c.id}`)
      .toEqual([{ notes_user_owned: false, description_source: null, notes_updated_at: null }]);
    // Tout redevient possible : effacement explicite enregistré, réouverture vide, inclusion acceptée.
    const efface = await enregistrer(c, d, { notesDescription: '' });
    expect(efface.status).toBe(200);
    expect(await ligne(d)).toMatchObject({ notes: null, notes_user_owned: true, description: IA_VISIBLE });
    expect((await lire(c, d)).notesDescription).toEqual({ text: '', origin: 'USER', userOwned: true, fromNotes: true });
    expect((await accepter(dest, jetonInclus)).status).toBe(200);
    expect((await sql<Json[]>`SELECT original_filename, description, notes FROM asset_files WHERE account_id = ${dest.id} AND deleted_at IS NULL ORDER BY original_filename`))
      .toEqual([{ original_filename: 'a.pdf', description: null, notes: null }, { original_filename: 'b.pdf', description: null, notes: NOTE_CORRIGEE }]);
  });
});
