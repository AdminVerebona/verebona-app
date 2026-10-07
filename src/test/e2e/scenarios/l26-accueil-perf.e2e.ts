/**
 * Lot 26 — accueil : vignettes des « Documents récents » (point 16) et
 * prise de parole de la mascotte (point 17) ; base réelle.
 *
 * Les durées mesurées sont journalisées (`[l26-mesure]`) pour le rapport.
 */
import { beforeAll, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { scenario } from '../scenario';

// File des miniatures neutralisée : la génération est pilotée par le test
// (stockage simulé), jamais lancée contre un S3 réel.
const misesEnFile = vi.hoisted(() => [] as number[]);
vi.mock('@/services/documents/thumbnails/thumbnail.service', async (o) => ({
  ...(await o<object>()),
  enqueueThumbnail: (id: number) => { misesEnFile.push(id); return true; },
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fournisseur modèle lent (latence simulée), puis en échec : aucune sortie T6. */
async function installSlowModel(latencyMs: number) {
  const { setAiProvider } = await import('@/services/ai/gateway/providers');
  const calls: number[] = [];
  setAiProvider({
    name: 'lent',
    isConfigured: () => true,
    call: async () => { calls.push(Date.now()); await sleep(latencyMs); throw new Error('modèle lent (simulation)'); },
  } as never);
  return calls;
}

async function chrono<T>(f: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await f();
  return { ms: Math.round(performance.now() - t0), value };
}

scenario('L26-ACCUEIL', 'Accueil : vignettes des documents récents, mascotte immédiate', ({ sql, make }) => {
  beforeAll(() => {
    process.env.OVH_S3_ACCESS_KEY_ID ??= 'e2e';
    process.env.OVH_S3_SECRET_ACCESS_KEY ??= 'e2e';
    process.env.OVH_S3_BUCKET ??= 'e2e-bucket';
    process.env.OVH_S3_ENDPOINT ??= 'http://127.0.0.1:9';
  });

  async function compteGarni() {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'VEHICULE', name: 'Cupra' });
    await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const futur = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
    await make.agendaItem(compte, { title: 'Prochain contrôle technique', startDate: futur, assetIds: [bien.id] });
    const fichiers = [];
    for (let i = 0; i < 5; i++) fichiers.push(await make.assetFile(compte, { assetId: i % 2 ? bien.id : null, name: `doc-${i}.pdf` }));
    await sql`UPDATE asset_files SET upload_status = 'COMPLETED', uploaded_at = now() - (id || ' seconds')::interval WHERE account_id = ${compte.id}`;
    return { compte, bien, fichiers };
  }

  it('MESURE — mascotte : collecte et prise de parole (modèle lent simulé à 1 500 ms)', async () => {
    const { compte } = await compteGarni();
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    const { getMascotPresentation } = await import('@/services/home/mascot/mascot.service');
    await collectMascotData(compte.id); // chauffe (imports, plans de requête)
    const collecte: number[] = [];
    for (let i = 0; i < 5; i++) collecte.push((await chrono(() => collectMascotData(compte.id))).ms);
    await installSlowModel(1_500);
    const affichage = await chrono(() => getMascotPresentation(compte.id, 'display'));
    console.info(`[l26-mesure] collecte mascotte (ms) : ${collecte.join(', ')} ; affichage complet : ${affichage.ms} ms (source ${affichage.value.source})`);
    expect(affichage.value.paragraphs.length).toBeGreaterThan(0);
    // AC17-1 : le modèle (≥ 1,5 s) n'est plus attendu à l'affichage.
    expect(affichage.ms).toBeLessThan(1_000);
    expect(affichage.value.source).toBe('fallback');
  });

  it('AC17-1 / AC17-2 — affichage immédiat, formulation T6 en arrière-plan, servie à l’affichage suivant', async () => {
    const { compte } = await compteGarni();
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    const { buildCandidates } = await import('@/services/home/mascot/signals');
    const { selectSubjects } = await import('@/services/home/mascot/selector');
    const { getMascotPresentation } = await import('@/services/home/mascot/mascot.service');
    const { resetT6Breaker } = await import('@/services/home/mascot/t6-runner');
    resetT6Breaker();
    const sujets = selectSubjects(buildCandidates(await collectMascotData(compte.id)).candidates);
    expect(sujets.length).toBeGreaterThan(0);
    const sortie = {
      schemaVersion: 't6-output-v2',
      messages: sujets.map((x) => ({
        subjectId: x.subjectId, text: x.fallbackText,
        highlight: x.allowedHighlight && x.fallbackText.includes(x.allowedHighlight) ? x.allowedHighlight : null,
      })),
    };
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    let appels = 0;
    setAiProvider({
      name: 'lent-valide', isConfigured: () => true,
      call: async () => { appels++; await sleep(1_500); return { rawText: JSON.stringify(sortie), inputTokens: 10, outputTokens: 10 }; },
    } as never);

    const premier = await chrono(() => getMascotPresentation(compte.id, 'display'));
    expect(premier.ms).toBeLessThan(1_000);
    expect(premier.value.source).toBe('fallback');

    // La génération s'achève en arrière-plan : cache du compte écrit, appel
    // journalisé en pré-génération (non affichée, RUN-011).
    for (let i = 0; i < 40; i++) {
      const [c] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM home_mascot_cache WHERE account_id = ${compte.id}`;
      if (c.n > 0) break;
      await sleep(100);
    }
    await sleep(100);
    const journal = await sql<{ mode: string; status: string }[]>`
      SELECT mode, status FROM home_mascot_generations WHERE account_id = ${compte.id} ORDER BY id`;
    expect(journal).toContainEqual({ mode: 'display', status: 'fallback' });
    expect(journal).toContainEqual({ mode: 'pregen', status: 'generated' });

    const second = await chrono(() => getMascotPresentation(compte.id, 'display'));
    console.info(`[l26-mesure] mascotte : 1er affichage ${premier.ms} ms (secours), affichage suivant ${second.ms} ms (source ${second.value.source})`);
    expect(second.value.source).toBe('t6');
    expect(second.ms).toBeLessThan(1_000);
    expect(appels).toBe(1);
    expect(second.value.contextHash).toBe(premier.value.contextHash);
  });

  it('AC16-3 — résumé : aperçu signé pour la miniature prête, icône et rattrapage pour les autres ; pas de N+1', async () => {
    const { compte, fichiers } = await compteGarni();
    const { generateThumbnail } = await import('@/services/documents/thumbnails/thumbnail.service');
    const png = await sharp({ create: { width: 800, height: 1100, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const objets = new Map<string, Buffer>();
    // Le plus récent des documents (premier de la liste) : image avec miniature prête.
    const recent = fichiers[0];
    await sql`UPDATE asset_files SET mime_type = 'image/png' WHERE id = ${recent.id}`;
    expect(await generateThumbnail(recent.id, {
      readObject: async () => png,
      putObject: async (k, b) => { objets.set(k, b); },
      deleteObject: async () => undefined,
      renderPdf: async () => { throw new Error('non utilisé'); },
    })).toBe('READY');

    const { buildHomeSummary } = await import('@/services/home/HomeSummaryService');
    const { thumbnailUrlStats, resetThumbnailUrlMemo } = await import('@/services/documents/thumbnails/thumbnail-url');
    resetThumbnailUrlMemo();
    misesEnFile.length = 0;
    await buildHomeSummary(compte.id); // chauffe
    const durees: number[] = [];
    let resume = await buildHomeSummary(compte.id);
    for (let i = 0; i < 5; i++) {
      const r = await chrono(() => buildHomeSummary(compte.id));
      durees.push(r.ms);
      resume = r.value;
    }
    const docs = resume.blocks.recentDocuments.items;
    console.info(`[l26-mesure] résumé d'accueil (ms) : ${durees.join(', ')} ; signatures : ${JSON.stringify(thumbnailUrlStats())}`);
    expect(docs).toHaveLength(4);
    const avec = docs.find((d) => d.id === recent.id)!;
    expect(avec.previewUrl).toMatch(/derivatives\/thumbnails\/.*X-Amz-Signature=/);
    expect(docs.filter((d) => d.id !== recent.id).every((d) => d.previewUrl == null)).toBe(true);
    // Les PDF sans miniature sont mis en génération (rattrapage immédiat).
    expect(misesEnFile.length).toBeGreaterThan(0);
    expect(misesEnFile).not.toContain(recent.id);
    // AC16-4 : 7 résumés, UNE signature (mémorisée pour l'heure), URL stable.
    expect(thumbnailUrlStats().signed).toBe(1);
    const encore = await buildHomeSummary(compte.id);
    expect(encore.blocks.recentDocuments.items.find((d) => d.id === recent.id)!.previewUrl).toBe(avec.previewUrl);

    // Même URL que la route de Mes documents (un seul téléchargement pour les deux écrans).
    vi.doMock('@/lib/session-service', () => ({
      SessionService: { getSession: async () => ({ userId: compte.ownerUserId, currentAccountId: compte.id }), handleSessionError: () => new Response(null, { status: 401 }) },
    }));
    vi.resetModules();
    const { NextRequest } = await import('next/server');
    const { GET } = await import('@/app/api/files/[id]/thumbnail/route');
    const res = await GET(new NextRequest(`http://localhost/api/files/${recent.id}/thumbnail`), { params: Promise.resolve({ id: String(recent.id) }) });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(avec.previewUrl);
    vi.doUnmock('@/lib/session-service');
  });
});
