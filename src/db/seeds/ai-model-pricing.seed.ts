/**
 * Amorçage du catalogue tarifaire — CDC Assistant §15.14.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TARIFS PUBLICS, PAS VOS TARIFS
 *
 * Les montants ci-dessous sont les prix de liste publiés par Google, relevés le
 * 29 juillet 2026. Ils sont chargés avec `verified = false`, ce qui les fait
 * apparaître en administration comme non confirmés (`listUnverifiedPricing`).
 *
 * Ils ne sont PAS votre facture. Cinq écarts possibles, tous invisibles d'ici :
 *   • formule Prepay ou Postpay (introduites le 23 mars 2026) ;
 *   • remises d'engagement négociées ;
 *   • API directe ou Vertex AI, dont les grilles diffèrent ;
 *   • mode Batch, facturé à moitié prix ;
 *   • jetons de raisonnement, facturés au tarif de SORTIE — c'est l'écart le
 *     plus fréquemment sous-estimé, et il peut être important.
 *
 * L'objectif n'est donc pas l'exactitude, c'est de passer de chiffres FAUX à
 * des chiffres approximativement justes et signalés comme tels. Quelqu'un
 * ouvre ensuite la console de facturation et corrige : dix minutes, une fois
 * qu'on sait quoi regarder.
 *
 * Utilisation :
 *   npm run db:seed:pricing
 *   npm run db:seed:pricing -- --dry-run
 * ══════════════════════════════════════════════════════════════════════════
 */
// ⚠️ EN PREMIER : `@/db` lit `process.env.DATABASE_URL` au chargement du
// module, et les imports ES sont évalués dans l'ordre de déclaration. Placé
// après, ce chargement arriverait trop tard — le pilote se rabattrait sur ses
// valeurs par défaut et échouerait sous le compte système courant, avec un
// message qui n'évoque en rien une variable manquante.
import '@/lib/load-env';
import { pgClient } from '@/db';
import { findCatalogEntry, toModelPrice } from '@/services/ai/gateway/pricing/gemini-public-catalog';
import { AI_OPERATIONS } from '@/services/ai/registry/operations';

/**
 * Tarif à insérer, dérivé du catalogue de la passerelle.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * IL N'Y A PLUS QU'UNE SEULE GRILLE, ET C'EST LE BUT
 *
 * Ce fichier portait sa propre liste de modèles et de prix. Le §18.2 du CDC
 * BO IA demandait qu'elle disparaisse — « aucune grille tarifaire codée en dur
 * concurrente » — et le 18/09/2026 a montré pourquoi, deux fois :
 *
 *   · le modèle par défaut de l'assistant est passé à `gemini-3.5-flash-lite`,
 *     présent dans le catalogue de la passerelle et absent d'ici. Le contrôle
 *     tarifaire a refusé le démarrage, et le seed censé le réparer ne
 *     contenait pas le modèle manquant ;
 *   · les deux listes se contredisaient sur `gemini-2.5-pro` : 2,00 contre
 *     1,25 $/M en entrée, sur un modèle réellement employé. Le coût d'un même
 *     appel dépendait de celle qui avait écrit la ligne en base.
 *
 * Deux listes cohérentes chacune avec elle-même, et incohérentes entre elles.
 * Le même défaut, exactement, que le prompt et le schéma désaccordés du matin.
 */
interface PublicPrice {
  provider: string;
  model: string;
  inputPerMillion: number;
  outputPerMillion: number;
  retiresOn?: string;
  note?: string;
}

/**
 * Rôle d'un modèle, dérivé du référentiel.
 *
 * Écrit à la main, ce libellé se périmait au premier changement de modèle — et
 * la note « modèle principal documentaire » a effectivement survécu à deux
 * bascules. Le déduire coûte trois lignes et ne ment jamais.
 */
function roleOf(model: string): string | undefined {
  const roles: string[] = [];
  for (const op of Object.values(AI_OPERATIONS)) {
    if (op.provider === 'none') continue;
    if (op.primaryModel === model) roles.push(`principal ${op.operationCode}`);
    const rang = op.fallbackModels.indexOf(model);
    if (rang >= 0) roles.push(`repli ${rang + 1} ${op.operationCode}`);
  }
  return roles.length > 0 ? roles.join(', ') : undefined;
}

/**
 * Modèles du référentiel, et eux seuls — la règle d'origine de ce fichier,
 * désormais appliquée par le code plutôt que tenue à la main.
 *
 * Un modèle du référentiel absent du catalogue n'est PAS inventé : il
 * n'apparaît simplement pas, et le test de cohérence le signale. Fabriquer un
 * tarif reviendrait à afficher des coûts faux.
 */
export const PUBLIC_PRICES: PublicPrice[] = ((): PublicPrice[] => {
  const modeles = new Set<string>();
  for (const op of Object.values(AI_OPERATIONS)) {
    if (op.provider === 'none') continue;
    modeles.add(op.primaryModel);
    for (const f of op.fallbackModels) modeles.add(f);
  }

  return [...modeles]
    .sort()
    .map((model): PublicPrice | null => {
      const entry = findCatalogEntry(model);
      if (!entry) return null;
      return {
        provider: 'gemini',
        model,
        inputPerMillion: entry.inputPerMillion,
        outputPerMillion: entry.outputPerMillion,
        retiresOn: entry.retiresOn,
        note: roleOf(model),
      };
    })
    .filter((p): p is PublicPrice => p !== null);
})();

/** 1 $ par million de jetons = 1 micro-dollar par jeton : la conversion est l'identité. */
export function toMicrosPerToken(pricePerMillion: number): number {
  return Math.round(pricePerMillion * 1_000_000) / 1_000_000;
}

/** Le modèle a-t-il déjà été évalué par la synchronisation tarifaire (0304) ? */
async function alreadyEvaluated(provider: string, model: string): Promise<boolean> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT 1 FROM ai_model_price_status WHERE provider = $1 AND model = $2 LIMIT 1`,
      [provider, model] as never[],
    )) as unknown as unknown[];
    return rows.length > 0;
  } catch { return false; /* table absente (0304) */ }
}

export interface PricingSeedSummary {
  inserted: number;
  skipped: number;
  /** Modèles du référentiel programmés pour être retirés. */
  retiring: { model: string; on: string }[];
}

/**
 * Insère les tarifs manquants. N'écrase JAMAIS un tarif existant : un tarif
 * confirmé à partir de la console de facturation a plus de valeur que le prix
 * de liste, et le seed ne doit pas pouvoir le remplacer par mégarde.
 */
export async function seedModelPricing(
  options: { dryRun?: boolean } = {},
): Promise<PricingSeedSummary> {
  let inserted = 0;
  let skipped = 0;

  for (const p of PUBLIC_PRICES) {
    const rows = (await pgClient.unsafe(
      `SELECT 1 FROM ai_model_pricing
        WHERE provider = $1 AND model = $2 AND effective_from <= NOW() LIMIT 1`,
      [p.provider, p.model] as never[],
    )) as unknown as unknown[];

    if (rows.length > 0) { skipped++; continue; }
    // Lot 109L : un modèle déjà ÉVALUÉ par la synchronisation (KNOWN, STALE ou
    // UNKNOWN) n'est jamais réamorcé depuis le relevé embarqué — même règle
    // que `cost-catalog.ts` (seedFromPublicCatalog) : une seule grille.
    if (await alreadyEvaluated(p.provider, p.model)) { skipped++; continue; }
    if (options.dryRun) { inserted++; continue; }

    // Lot 109L : `public_catalog` (contrainte 0114 : billing_api | public_catalog
    // | manual) — l'ancien `public_list` faisait échouer l'insertion. Référence
    // unique, celle du catalogue embarqué (date de son relevé).
    const ref = toModelPrice(findCatalogEntry(p.model)!).sourceReference;
    await pgClient.unsafe(
      `INSERT INTO ai_model_pricing
         (provider, model, input_micros, output_micros, currency,
          source, source_reference, verified, fetched_at, effective_from)
       VALUES ($1, $2, $3, $4, 'USD', 'public_catalog', $5, FALSE, NOW(), NOW())`,
      [
        p.provider, p.model,
        toMicrosPerToken(p.inputPerMillion),
        toMicrosPerToken(p.outputPerMillion),
        ref ?? null,
      ] as never[],
    );
    inserted++;
  }
  if (inserted > 0 && !options.dryRun) {
    const { bumpPricingVersion } = await import('@/services/ai/gateway/pricing/pricing.repository');
    await bumpPricingVersion('seed public_catalog');
  }

  return {
    inserted,
    skipped,
    retiring: PUBLIC_PRICES
      .filter((p) => p.retiresOn)
      .map((p) => ({ model: p.model, on: p.retiresOn as string })),
  };
}

if (process.argv[1]?.includes('ai-model-pricing.seed')) {
  const dryRun = process.argv.includes('--dry-run');

  seedModelPricing({ dryRun })
    .then((s) => {
      console.log(`\n${dryRun ? 'Simulation' : 'Amorçage'} du catalogue tarifaire\n`);
      console.log(`  ${s.inserted} tarif(s) inséré(s), ${s.skipped} déjà présent(s).`);
      console.log('\n⚠️ Tarifs PUBLICS, marqués non confirmés. Comparez-les à votre');
      console.log('   console de facturation : formule, remises, Vertex, Batch et');
      console.log('   surtout les jetons de raisonnement, facturés au tarif de sortie.');
      if (s.retiring.length > 0) {
        console.log('\n⚠️ Modèles du référentiel dont le retrait est annoncé :');
        for (const r of s.retiring) console.log(`   · ${r.model} — ${r.on}`);
        console.log('   Prévoir leur remplacement dans registry/operations.ts.');
      }
      process.exit(0);
    })
    .catch((e) => {
      console.error('\n✖ Amorçage impossible :', (e as Error).message);
      process.exit(1);
    });
}
