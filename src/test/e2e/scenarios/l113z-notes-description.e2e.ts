/**
 * Lot 113Z (Trello #723) — champ unique « Notes / Description », T1 et dossiers tiers, sur
 * PostgreSQL 16 réel : analyse T1 réelle (sortie rejouée), routes réelles (session simulée),
 * recherche de l'Assistant réelle, contrôle de cohérence (orchestrateur unique), transmission réelle.
 * Les numéros suivent la recette obligatoire du ticket (§5).
 *
 *   L113Z-E2E-01  description T1 sans note → champ prérempli, provenance IA établie ;
 *   L113Z-E2E-02  ni description ni note → vide, constat ABSENT, aucune relance ;
 *   L113Z-E2E-03  ouvrir / enregistrer sans modification → aucune écriture, aucune reprise en main, aucune réanalyse ;
 *   L113Z-E2E-04  modifier la suggestion IA → note prioritaire, description d'origine préservée ;
 *   L113Z-E2E-05  effacer volontairement → vide persistant, même après une nouvelle analyse ;
 *   L113Z-E2E-06  modifier un autre champ (client antérieur envoyant `description: null`) → description intacte ;
 *   L113Z-E2E-07  notes seules → aucun appel T1 ; l'Assistant retrouve la note, provenance « déclarée » ;
 *   L113Z-E2E-08  réanalyse T1 ultérieure → la note utilisateur n'est pas remplacée ;
 *   L113Z-E2E-09  description historique d'origine inconnue → conservée, aucune fausse provenance, même après analyse ;
 *   L113Z-E2E-10  lien web → titre et texte libre aux bons champs (client antérieur : `description` lue comme note) ;
 *   L113Z-E2E-11  transmission : « Notes / Description » absent par défaut, inclus seulement sur choix explicite ;
 *   L113Z-E2E-SEC transmission : identifiants d'un autre compte / d'un autre bien injectés → jamais transmis ;
 *   L113Z-E2E-12  dossiers V12 : la source des dossiers ne porte plus aucune description documentaire ;
 *   L113Z-E2E-13  reprise de l'historique (COH-DOC-DESCRIPTION-T1) sans IA + diagnostic BO de la chaîne.
 *
 * Assertions bornées aux comptes créés ici.
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { drainQueues, sortieT1, useTargetState } from '../chain';
import { runCoherenceFor } from '../coherence-run';

const session = vi.hoisted(() => ({ currentAccountId: 0 as number | null, userId: 0 }));
vi.mock('@/lib/auth-guards', async (o) => ({
  ...(await o<object>()),
  getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
}));
vi.mock('@/lib/session-service', async (o) => {
  const orig = await o<{ SessionService: object }>();
  return {
    ...orig,
    SessionService: {
      ...orig.SessionService,
      getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
      tryGetSession: async () => (session.userId ? { userId: session.userId, currentAccountId: session.currentAccountId } : null),
      handleSessionError: (e: unknown) => { throw e; },
    },
  };
});
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number; owner: { id: number; email: string } };
type Json = Record<string, any>;
const DESC_T1 = 'Facture d’achat d’un aspirateur balai sans fil chez LP Marketplace, livraison comprise, 249,90 € TTC.';

scenario('L113Z', 'Documents — « Notes / Description », T1 et dossiers tiers', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();

  const as = (c: Compte) => { session.userId = c.ownerUserId; session.currentAccountId = c.id; };
  const sortie = (description?: unknown) => {
    const o = sortieT1({ title: 'Facture LP MARKETPLACE', date: '2026-05-20', documentTypeCode: 'INVOICE', rubricCode: 'PURCHASE', assets: [], facts: [], texte: ['Aspirateur balai'] });
    if (description !== undefined) (o.document as Json).description = description;
    return o;
  };
  const meta = (d: string) => ({ value: d, confidence: 'certain', evidence: { excerpt: 'Aspirateur balai' } });
  const appelsT1 = { n: 0 };
  const analyser = async (c: Compte, fileId: number, output: Record<string, unknown>) => {
    await sql`UPDATE asset_files SET analysis_state = NULL WHERE id = ${fileId}`;
    const replay = await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output, repeat: true }]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([fileId], c.id, { userId: c.ownerUserId, billable: false, origin: 'e2e/l113z' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
    appelsT1.n += replay.calls.length;
    return replay;
  };
  const doc = async (c: Compte) => {
    const f = await make.assetFile(c, {});
    await sql`UPDATE asset_files SET original_filename = 'facture-lp.pdf', s3_bucket = 'e2e-bucket' WHERE id = ${f.id}`;
    return f.id;
  };
  const ligne = async (id: number) => (await sql<Json[]>`
    SELECT description, notes, notes_user_owned, description_source, description_t1_status, user_edited_fields, updated_at
      FROM asset_files WHERE id = ${id}`)[0];
  const runs = async (id: number) => Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_analysis_runs WHERE asset_file_id = ${id}`)[0].n);
  const lire = async (c: Compte, id: number): Promise<Json> => {
    as(c);
    const { GET } = await import('@/app/api/files/[id]/route');
    const r = await GET(new NextRequest(`http://x/api/files/${id}`), { params: Promise.resolve({ id: String(id) }) });
    expect(r.status).toBe(200);
    return r.json();
  };
  /** Enregistrement du tiroir : mêmes champs que `DocumentDrawer.handleSave`. */
  const enregistrer = async (c: Compte, id: number, extra: Json = {}): Promise<Json> => {
    as(c);
    const f = await lire(c, id);
    const { PUT } = await import('@/app/api/documents/[id]/route');
    const body = {
      fileName: f.displayTitle, retainedTitle: f.displayTitle, documentDate: f.documentDate ?? null,
      supplier: f.supplier ?? null, amountCents: f.amountCents ?? null, userEditedFields: f.userEditedFields ?? {}, ...extra,
    };
    const r = await PUT(new NextRequest(`http://x/api/documents/${id}`, { method: 'PUT', body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(id) }) });
    expect(r.status).toBe(200);
    return r.json();
  };
  /** Aucune analyse T1 lancée en arrière-plan : nombre de runs stable (sondage borné). */
  const aucuneReanalyse = async (id: number, n: number) => {
    for (let i = 0; i < 10; i++) {
      expect(await runs(id)).toBe(n);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  it('L113Z-E2E-01 — description T1 sans note → préremplie, provenance IA établie, constat PRODUCED', async () => {
    const c = await make.account({ plan: 'premium' }) as Compte;
    const id = await doc(c);
    await analyser(c, id, sortie(meta(DESC_T1)));
    expect(await ligne(id)).toMatchObject({ description: DESC_T1, notes: null, notes_user_owned: false, description_source: 'T1', description_t1_status: 'PRODUCED' });
    const f = await lire(c, id);
    expect(f.notesDescription).toEqual({ text: DESC_T1, origin: 'AI', userOwned: false, fromNotes: false });
    // La trace T1 n'est jamais servie à l'application.
    expect(f).not.toHaveProperty('descriptionT1Status');
  });

  it('L113Z-E2E-02 — ni description ni note → vide, constat ABSENT ; description mal formée retirée seule (extraction valide)', async () => {
    const c = await make.account({ plan: 'premium' }) as Compte;
    const id = await doc(c);
    await analyser(c, id, sortie());
    expect(await ligne(id)).toMatchObject({ description: null, notes: null, description_t1_status: 'ABSENT' });
    expect((await lire(c, id)).notesDescription).toEqual({ text: '', origin: null, userOwned: false, fromNotes: false });
    const id2 = await doc(c);
    const autre = sortie('description sans méta');
    (autre.document as Json).title = { value: 'Autre facture', confidence: 'certain', evidence: {} };
    (autre as Json).transcription = 'Autre facture — bon de commande 7781';
    await analyser(c, id2, autre);
    const l2 = await ligne(id2);
    expect(l2).toMatchObject({ description: null, description_t1_status: 'REMOVED_AT_VALIDATION' });
    // L'extraction reste valide : run T1 écrit, analyse non échouée.
    expect((await sql<Json[]>`SELECT analysis_state FROM asset_files WHERE id = ${id2}`)[0].analysis_state).not.toBe('ANALYSIS_FAILED');
    expect(await runs(id2)).toBeGreaterThan(0);
  });

  let partage: { c: Compte; id: number };
  it('L113Z-E2E-03 — ouvrir / enregistrer sans modification → aucune écriture ni reprise en main ni réanalyse', async () => {
    const c = await make.account({ plan: 'premium' }) as Compte;
    const id = await doc(c);
    await analyser(c, id, sortie(meta(DESC_T1)));
    partage = { c, id };
    const avant = await ligne(id);
    const n = await runs(id);
    const r = await enregistrer(c, id, { notesDescription: DESC_T1 });
    expect(r).toMatchObject({ reanalysis: false, notesDescription: { text: DESC_T1, origin: 'AI', userOwned: false } });
    const apres = await ligne(id);
    expect(apres).toMatchObject({ description: DESC_T1, notes: null, notes_user_owned: false, description_source: 'T1' });
    await aucuneReanalyse(id, n);
    // Même chose sans le champ (le tiroir ne l'envoie pas quand rien n'a changé).
    await enregistrer(c, id);
    expect(await ligne(id)).toMatchObject({ notes: null, notes_user_owned: false, description: avant.description });
  });

  it('L113Z-E2E-04 / E2E-07 — modifier la suggestion IA → note prioritaire, description préservée ; aucun appel T1 ; l’Assistant retrouve la note', async () => {
    const { c, id } = partage;
    const n = await runs(id);
    const avantT1 = appelsT1.n;
    const r = await enregistrer(c, id, { notesDescription: `${DESC_T1} Garantie 2 ans, code portail zanzibar.` });
    expect(r).toMatchObject({ reanalysis: false, notesDescription: { origin: 'USER', userOwned: true, fromNotes: true } });
    expect(await ligne(id)).toMatchObject({ description: DESC_T1, notes: `${DESC_T1} Garantie 2 ans, code portail zanzibar.`, notes_user_owned: true });
    await aucuneReanalyse(id, n);
    expect(appelsT1.n).toBe(avantT1);
    // Journal : le fait, jamais le contenu.
    const j = await sql<{ details: string }[]>`SELECT details FROM admin_audit_log WHERE target_type = 'document' AND target_id = ${id} ORDER BY id DESC LIMIT 1`;
    expect(j[0].details).toContain('Notes / Description : modifiées par l’utilisateur');
    expect(j[0].details).not.toContain('zanzibar');
    // Assistant (T2) : la note est cherchée et rendue avec sa provenance déclarée.
    const { ADAPTATEURS, USER_NOTE_PREFIX, USER_DECLARED_PROVENANCE } = await import('@/services/verebona-assistant/registries/retrieval-adapters');
    const { analyserRequeteCanonique } = await import('@/services/verebona-assistant/core/retrieval.service');
    const a = analyserRequeteCanonique('zanzibar');
    const res = await ADAPTATEURS.find((x) => x.name === 'documents')!.search({
      accountId: c.id, normalizedQuery: a.terms.map((t) => t.stem).join(' '), terms: a.terms, intent: 'UNKNOWN', entityFilters: {}, limit: 10,
      period: a.period, documentTypes: a.documentTypes, documentFilters: a.documentFilters, documentTypeFilter: a.documentTypes,
    });
    expect(res.map((s) => s.meta?.documentId)).toEqual([id]);
    expect(res[0].content).toContain(USER_NOTE_PREFIX);
    expect(res[0].meta).toMatchObject({ userNoteProvenance: USER_DECLARED_PROVENANCE });
    const { accountDataRepository } = await import('@/services/verebona-assistant/core/account-data.repository');
    expect((await accountDataRepository.searchDocuments(c.id, ['zanzibar'])).map((d) => d.fileId)).toContain(id);
  });

  it('L113Z-E2E-08 — réanalyse T1 ultérieure → la note utilisateur n’est pas remplacée', async () => {
    const { c, id } = partage;
    const note = (await ligne(id)).notes;
    expect(note).toBeTruthy();
    await analyser(c, id, sortie(meta('Facture LP Marketplace : aspirateur balai, 249,90 €.')));
    const l = await ligne(id);
    // Même version de source : run dédupliqué (description T1 interne inchangée) — la note reste.
    expect(l).toMatchObject({ notes: note, notes_user_owned: true, description_source: 'T1' });
    expect(l.description).toBeTruthy();
    expect((await lire(c, id)).notesDescription).toMatchObject({ text: note, origin: 'USER' });
  });

  it('L113Z-E2E-05 — effacer volontairement → vide persistant, même après une nouvelle analyse', async () => {
    const { c, id } = partage;
    const r = await enregistrer(c, id, { notesDescription: '' });
    expect(r.notesDescription).toEqual({ text: '', origin: 'USER', userOwned: true, fromNotes: true });
    expect(await ligne(id)).toMatchObject({ notes: null, notes_user_owned: true });
    await analyser(c, id, sortie(meta(DESC_T1)));
    expect((await lire(c, id)).notesDescription).toEqual({ text: '', origin: 'USER', userOwned: true, fromNotes: true });
    const j = await sql<{ details: string }[]>`SELECT details FROM admin_audit_log WHERE target_type = 'document' AND target_id = ${id} AND details LIKE '%effacées%'`;
    expect(j).toHaveLength(1);
  });

  it('L113Z-E2E-06 — modifier un autre champ (client antérieur : `description: null`) → description intacte', async () => {
    const c = await make.account({ plan: 'premium' }) as Compte;
    const id = await doc(c);
    await analyser(c, id, sortie(meta(DESC_T1)));
    await enregistrer(c, id, { supplier: 'LP Marketplace SAS', description: null, notes: null });
    const l = await ligne(id);
    expect(l).toMatchObject({ description: DESC_T1, notes: null, notes_user_owned: false, description_source: 'T1' });
    expect((await sql<{ supplier: string }[]>`SELECT supplier FROM asset_files WHERE id = ${id}`)[0].supplier).toBe('LP Marketplace SAS');
  });

  it('L113Z-E2E-09 — description historique d’origine inconnue → conservée, sans provenance, même après analyse', async () => {
    const c = await make.account({ plan: 'premium' }) as Compte;
    const id = await doc(c);
    await sql`UPDATE asset_files SET description = 'Saisie de l’import (ancien champ)' WHERE id = ${id}`;
    expect((await lire(c, id)).notesDescription).toMatchObject({ text: 'Saisie de l’import (ancien champ)', origin: 'UNKNOWN' });
    await analyser(c, id, sortie(meta(DESC_T1)));
    expect(await ligne(id)).toMatchObject({ description: 'Saisie de l’import (ancien champ)', description_source: null, description_t1_status: 'KEPT_UNKNOWN_ORIGIN' });
    // La sortie T1 reste dans l'extraction (exploitable en interne).
    expect((await sql<{ description: string }[]>`SELECT description FROM document_extractions WHERE file_id = ${id}`)[0].description).toBe(DESC_T1);
  });

  it('L113Z-E2E-10 — lien web : nom = titre, texte libre = note de l’utilisateur ; client antérieur : `description` lue comme note', async () => {
    const c = await make.account({ plan: 'premium' }) as Compte;
    as(c);
    const { POST } = await import('@/app/api/web-links/route');
    const creer = async (body: Json) => {
      const r = await POST(new NextRequest('http://x/api/web-links', { method: 'POST', body: JSON.stringify(body) }));
      expect(r.status).toBe(201);
      return (await r.json() as Json).webLink.id as number;
    };
    const a = await creer({ url: 'https://exemple.fr/notice', title: 'Notice en ligne', notes: 'Version 2026' });
    expect(await ligne(a)).toMatchObject({ description: null, notes: 'Version 2026', notes_user_owned: true });
    expect((await sql<{ web_link_title: string }[]>`SELECT web_link_title FROM asset_files WHERE id = ${a}`)[0].web_link_title).toBe('Notice en ligne');
    const b = await creer({ url: 'https://exemple.fr/b', title: 'Autre lien', description: 'Ancien « Titre / Description »' });
    expect(await ligne(b)).toMatchObject({ description: null, notes: 'Ancien « Titre / Description »', notes_user_owned: true });
    const d = await creer({ url: 'https://exemple.fr/c', title: 'Sans texte' });
    expect(await ligne(d)).toMatchObject({ description: null, notes: null, notes_user_owned: false });
  });

  it('L113Z-E2E-11 — transmission : « Notes / Description » absent par défaut, inclus seulement sur choix explicite', async () => {
    const emetteur = await make.account({ plan: 'premium' }) as Compte;
    const bien = await make.asset(emetteur, { category: 'OBJET', name: `Aspirateur ${emetteur.id}` });
    const dIa = await doc(emetteur);
    const dUser = await doc(emetteur);
    await sql`UPDATE asset_files SET asset_id = ${bien.id}, description = ${DESC_T1}, description_source = 'T1' WHERE id = ${dIa}`;
    await sql`UPDATE asset_files SET asset_id = ${bien.id}, description = 'IA masquée', notes = 'Note privée', notes_user_owned = true WHERE id = ${dUser}`;
    const transmettre = async (inclure: boolean | undefined) => {
      const dest = await make.account({ plan: 'premium' }) as Compte;
      const token = `e2e-l113z-${dest.id}`;
      const payload = { includeDocuments: true, selectedDocIds: [dIa, dUser], includeEquipments: false, selectedEquipmentIds: [], includePhotos: false,
        selectedPhotoIds: [], includeEvents: false, selectedEventIds: [], ...(inclure === undefined ? {} : { includeNotesDescription: inclure }) };
      await sql`INSERT INTO asset_transmissions (asset_id, account_id, initiator_user_id, recipient_email, token, selected_payload, snapshot_payload, keep_active_after, status, sent_at, created_at)
        VALUES (${bien.id}, ${emetteur.id}, ${emetteur.ownerUserId}, ${dest.owner.email}, ${token}, ${JSON.stringify(payload)},
                ${JSON.stringify({ id: bien.id, name: `Aspirateur ${emetteur.id}`, category: 'OBJET', documents: [] })}, true, 'pending', now(), now())`;
      as(dest);
      const { POST } = await import('@/app/api/transmission/[token]/route');
      const r = await POST(new NextRequest(`http://x/api/transmission/${token}`, { method: 'POST', body: JSON.stringify({ action: 'accept', confirmDuplicate: true }) }), { params: Promise.resolve({ token }) });
      expect(r.status).toBe(200);
      return sql<Json[]>`SELECT original_filename, description, notes, notes_user_owned, description_source FROM asset_files WHERE account_id = ${dest.id} ORDER BY id`;
    };
    for (const defaut of [undefined, false]) {
      const copies = await transmettre(defaut);
      expect(copies).toHaveLength(2);
      for (const x of copies) expect(x).toMatchObject({ description: null, notes: null, notes_user_owned: false });
    }
    const inclus = await transmettre(true);
    expect(inclus.map((x) => [x.description, x.notes, x.notes_user_owned, x.description_source])).toEqual([
      [DESC_T1, null, false, 'T1'], [null, 'Note privée', true, null]]);
    // L'émetteur garde tout.
    expect(await ligne(dUser)).toMatchObject({ description: 'IA masquée', notes: 'Note privée' });
  });

  it('L113Z-E2E-SEC — transmission : document d’un autre compte / d’un autre bien injecté → jamais transmis (création ET acceptation)', async () => {
    const emetteur = await make.account({ plan: 'premium' }) as Compte;
    const bien = await make.asset(emetteur, { category: 'OBJET', name: `Sécu ${emetteur.id}` });
    const autreBien = await make.asset(emetteur, { category: 'OBJET', name: `Autre ${emetteur.id}` });
    const victime = await make.account({ plan: 'premium' }) as Compte;
    const bienVictime = await make.asset(victime, { category: 'OBJET', name: 'Coffre' });
    const propre = await doc(emetteur);
    const autre = await doc(emetteur);
    const etranger = await doc(victime);
    await sql`UPDATE asset_files SET asset_id = ${bien.id}, original_filename = 'propre.pdf' WHERE id = ${propre}`;
    await sql`UPDATE asset_files SET asset_id = ${autreBien.id}, original_filename = 'autre-bien.pdf' WHERE id = ${autre}`;
    await sql`UPDATE asset_files SET asset_id = ${bienVictime.id}, original_filename = 'secret-victime.pdf', notes = 'secret' WHERE id = ${etranger}`;
    const evtVictime = await make.agendaItem(victime, { title: 'RDV victime', assetIds: [bienVictime.id] });
    const accepter = async (dest: Compte, token: string) => {
      as(dest);
      const { POST } = await import('@/app/api/transmission/[token]/route');
      const r = await POST(new NextRequest(`http://x/api/transmission/${token}`, { method: 'POST', body: JSON.stringify({ action: 'accept', confirmDuplicate: true }) }), { params: Promise.resolve({ token }) });
      expect(r.status).toBe(200);
      return {
        fichiers: (await sql<{ original_filename: string }[]>`SELECT original_filename FROM asset_files WHERE account_id = ${dest.id} ORDER BY id`).map((x) => x.original_filename),
        agenda: (await sql<{ title: string }[]>`SELECT title FROM agenda_items WHERE account_id = ${dest.id}`).map((x) => x.title),
      };
    };
    const selection = { includeDocuments: true, selectedDocIds: [propre, autre, etranger], includePhotos: true, selectedPhotoIds: [etranger],
      includeEvents: true, selectedEventIds: [evtVictime.id], includeEquipments: false, selectedEquipmentIds: [] };

    // 1. Création par la route : la sélection ENREGISTRÉE est déjà filtrée.
    const dest1 = await make.account({ plan: 'premium' }) as Compte;
    as(emetteur);
    const { POST: creer } = await import('@/app/api/assets/[id]/transmission/route');
    const rc = await creer(new NextRequest(`http://x/api/assets/${bien.id}/transmission`, { method: 'POST',
      body: JSON.stringify({ recipientEmail: dest1.owner.email, keepActiveAfterTransmission: true, selectedPayload: selection }) }), { params: Promise.resolve({ id: String(bien.id) }) });
    expect(rc.status).toBeLessThan(300);
    // Anti-énumération : la réponse ne dit rien des éléments écartés.
    expect(JSON.stringify(await rc.json())).not.toMatch(new RegExp(`\\b(${etranger}|${autre})\\b|secret`));
    const [t1] = await sql<{ token: string; selected_payload: string }[]>`SELECT token, selected_payload FROM asset_transmissions WHERE asset_id = ${bien.id} ORDER BY id DESC LIMIT 1`;
    expect(JSON.parse(t1.selected_payload)).toMatchObject({ selectedDocIds: [propre], selectedPhotoIds: [], includePhotos: false, selectedEventIds: [], includeEvents: false });
    expect(await accepter(dest1, t1.token)).toEqual({ fichiers: ['propre.pdf'], agenda: [] });

    // 2. Transmission déjà en base avec une sélection NON filtrée (version antérieure) : l'acceptation filtre.
    const dest2 = await make.account({ plan: 'premium' }) as Compte;
    const token = `e2e-l113z-sec-${dest2.id}`;
    await sql`INSERT INTO asset_transmissions (asset_id, account_id, initiator_user_id, recipient_email, token, selected_payload, snapshot_payload, keep_active_after, status, sent_at, created_at)
      VALUES (${bien.id}, ${emetteur.id}, ${emetteur.ownerUserId}, ${dest2.owner.email}, ${token}, ${JSON.stringify(selection)},
              ${JSON.stringify({ id: bien.id, name: `Sécu ${emetteur.id}`, category: 'OBJET', documents: [] })}, true, 'pending', now(), now())`;
    expect(await accepter(dest2, token)).toEqual({ fichiers: ['propre.pdf'], agenda: [] });

    // 3. Sélection entièrement étrangère : rien n'est copié (jamais un repli sur « tout le bien »).
    const dest3 = await make.account({ plan: 'premium' }) as Compte;
    const token3 = `e2e-l113z-sec3-${dest3.id}`;
    await sql`INSERT INTO asset_transmissions (asset_id, account_id, initiator_user_id, recipient_email, token, selected_payload, snapshot_payload, keep_active_after, status, sent_at, created_at)
      VALUES (${bien.id}, ${emetteur.id}, ${emetteur.ownerUserId}, ${dest3.owner.email}, ${token3},
              ${JSON.stringify({ ...selection, selectedDocIds: [etranger] })},
              ${JSON.stringify({ id: bien.id, name: `Sécu ${emetteur.id}`, category: 'OBJET', documents: [{ id: propre, originalFilename: 'propre.pdf', isWebLink: false }] })}, true, 'pending', now(), now())`;
    expect((await accepter(dest3, token3)).fichiers).toEqual([]);
    // Le document de la victime n'a jamais quitté son compte.
    expect(Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_files WHERE original_filename = 'secret-victime.pdf'`)[0].n)).toBe(1);
  });

  it('L113Z-E2E-12 — dossiers V12 : aucune description documentaire dans la source d’un dossier tiers', async () => {
    const c = await make.account({ plan: 'premium' }) as Compte;
    const bien = await make.asset(c, { category: 'OBJET', name: 'Vélo' });
    const id = await doc(c);
    await sql`UPDATE asset_files SET asset_id = ${bien.id}, description = ${DESC_T1}, notes = 'Note privée', upload_status = 'COMPLETED' WHERE id = ${id}`;
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    for (const exportType of ['VENTE', 'ASSURANCE_SOUSCRIPTION', 'DOSSIER_COMPLET'] as const) {
      const s = await loadExportSource({ assetId: bien.id, accountId: c.id, userId: c.ownerUserId, exportType });
      expect(s.documents.map((d) => d.id)).toContain(id);
      expect(JSON.stringify(s)).not.toMatch(/Note privée|aspirateur balai/i);
    }
  });

  it('L113Z-E2E-13 — reprise de l’historique sans IA (COH-DOC-DESCRIPTION-T1) et diagnostic BO de la chaîne', async () => {
    const c = await make.account({ plan: 'premium' }) as Compte;
    const id = await doc(c);
    await analyser(c, id, sortie(meta(DESC_T1)));
    // Historique : description perdue (cause non tracée) / provenance non qualifiée.
    const id2 = await doc(c);
    await analyser(c, id2, sortie(meta(DESC_T1)));
    await sql`UPDATE asset_files SET description = NULL, description_source = NULL, description_t1_status = NULL WHERE id = ${id}`;
    await sql`UPDATE asset_files SET description_source = NULL, description_t1_status = NULL WHERE id = ${id2}`;
    const { buildEntityDossier } = await import('@/services/admin/account-data/dossier');
    const sectionNotes = async (fileId: number) => {
      const d = await buildEntityDossier(c.id, 'document', fileId);
      const sec = d.sections.find((s) => s.id === 'notes-description');
      expect(sec?.error).toBeUndefined();
      return Object.fromEntries((sec?.fields ?? []).map((f) => [f.column, f.raw]));
    };
    const diag = await sectionNotes(id);
    expect(diag).toMatchObject({ verdict: 'MISSING_UNDETERMINED', run_description: DESC_T1, extraction_description: DESC_T1, asset_files_description: null });
    expect((await sectionNotes(id2)).verdict).toBe('CONSISTENT');
    const avant = appelsT1.n;
    await runCoherenceFor(sql, [c.id]);
    expect(await ligne(id)).toMatchObject({ description: DESC_T1, description_source: 'T1', description_t1_status: 'RECOVERED', notes: null, notes_user_owned: false });
    expect(await ligne(id2)).toMatchObject({ description: DESC_T1, description_source: 'T1' });
    expect((await sectionNotes(id)).verdict).toBe('CONSISTENT');
    expect(appelsT1.n).toBe(avant);
    // Rejouée : rien ne change (idempotente).
    const l1 = await ligne(id);
    await runCoherenceFor(sql, [c.id]);
    expect((await ligne(id)).updated_at).toEqual(l1.updated_at);
  });
});
