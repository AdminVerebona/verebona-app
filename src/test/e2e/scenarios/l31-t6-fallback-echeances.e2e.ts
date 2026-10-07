/**
 * Lot 31 — ticket T6 : fallback déterministe des échéances, base réelle.
 *
 * T6FB-AC1 / AC2 (bout en bout) : le collecteur lit la famille et la
 * catégorie du bien (`assets.category`, `assets.subtype`) ; T6 indisponible,
 * l'accueil affiche « Votre prochaine échéance est le contrôle technique de
 * la Cupra, le … » — jamais le titre technique entre guillemets.
 * T6FB-AC8 : catégorie absente → formulation neutre.
 */
import { it, expect } from 'vitest';
import { scenario } from '../scenario';

async function sansModele() {
  const { setAiProvider } = await import('@/services/ai/gateway/providers');
  setAiProvider({ name: 'absent', isConfigured: () => true, call: async () => { throw new Error('T6 indisponible (simulation)'); } } as never);
}

scenario('L31-T6FB', 'Accueil : fallback naturel des échéances (T6 indisponible)', ({ sql, make }) => {
  const futur = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);

  it('T6FB-AC1 / T6FB-AC2 — voiture « Cupra » : formulation naturelle affichée sans T6', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'VEHICULE', name: 'Cupra' });
    await sql`UPDATE assets SET subtype = 'Voiture' WHERE id = ${bien.id}`;
    await make.agendaItem(compte, { title: 'Prochain contrôle technique — CUPRA LEON E-HYBRID180', startDate: futur, assetIds: [bien.id] });

    const { collectMascotData } = await import('@/services/home/mascot/collector');
    const { formatDateFr } = await import('@/services/home/mascot/signals');
    const { getMascotPresentation } = await import('@/services/home/mascot/mascot.service');
    const { resetT6Breaker } = await import('@/services/home/mascot/t6-runner');
    const raw = await collectMascotData(compte.id);
    expect(raw.agenda?.[0]).toMatchObject({ assetName: 'Cupra', assetCategory: 'VEHICULE', assetSubtype: 'Voiture' });

    resetT6Breaker();
    await sansModele();
    const p = await getMascotPresentation(compte.id, 'display');
    const texte = p.paragraphs.find((x) => x.sourceCode === 'DATE-NEXT')?.text;
    expect(texte).toBe(`Votre prochaine échéance est le contrôle technique de la Cupra, le ${formatDateFr(futur)}.`);
    expect(texte).not.toMatch(/CUPRA LEON|pour Cupra|[«»]/);
  });

  it('T6FB-AC8 — catégorie du bien inconnue : formulation neutre', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'VEHICULE', name: 'Cupra' });
    await make.agendaItem(compte, { title: 'Prochain contrôle technique — CUPRA LEON E-HYBRID180', startDate: futur, assetIds: [bien.id] });
    const { resetT6Breaker } = await import('@/services/home/mascot/t6-runner');
    const { formatDateFr } = await import('@/services/home/mascot/signals');
    const { getMascotPresentation } = await import('@/services/home/mascot/mascot.service');
    resetT6Breaker();
    await sansModele();
    const p = await getMascotPresentation(compte.id, 'display');
    expect(p.paragraphs.find((x) => x.sourceCode === 'DATE-NEXT')?.text)
      .toBe(`Votre prochaine échéance concerne Cupra : contrôle technique, le ${formatDateFr(futur)}.`);
  });
});
