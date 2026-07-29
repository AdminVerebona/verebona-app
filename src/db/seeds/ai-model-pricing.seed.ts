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
import { pgClient } from '@/db';

/** Micro-dollars par jeton = prix par million ÷ 1 000 000 × 1 000 000. */
interface PublicPrice {
  provider: string;
  model: string;
  /** Prix par million de jetons d'entrée, en dollars. */
  inputPerMillion: number;
  outputPerMillion: number;
  /** Date de retrait annoncée par le fournisseur, si connue. */
  retiresOn?: string;
  note?: string;
}

/**
 * Modèles du référentiel, et eux seuls.
 *
 * Un modèle absent de `registry/operations.ts` n'a pas à figurer ici : le
 * catalogue tarifaire décrit ce que l'application appelle, pas le catalogue du
 * fournisseur.
 */
export const PUBLIC_PRICES: PublicPrice[] = [
  {
    provider: 'gemini', model: 'gemini-3.1-flash-lite',
    inputPerMillion: 0.25, outputPerMillion: 1.50,
    note: 'modèle principal documentaire',
  },
  {
    provider: 'gemini', model: 'gemini-3.5-flash',
    inputPerMillion: 1.50, outputPerMillion: 9.00,
    note: 'premier repli documentaire',
  },
  {
    provider: 'gemini', model: 'gemini-2.5-pro',
    inputPerMillion: 2.00, outputPerMillion: 12.00,
    retiresOn: '2026-10-16',
    note: 'second repli documentaire ET modèle principal de gouvernance — RETRAIT ANNONCÉ',
  },
  {
    provider: 'gemini', model: 'gemini-2.5-flash-lite',
    inputPerMillion: 0.10, outputPerMillion: 0.40,
    retiresOn: '2026-10-16',
    note: 'modèle principal assistant — RETRAIT ANNONCÉ',
  },
];

/** Conversion en micro-dollars par jeton, unité de `ai_model_pricing`. */
export function toMicrosPerToken(pricePerMillion: number): number {
  // 1 $ par million de jetons = 1 micro-dollar par jeton.
  return Math.round(pricePerMillion * 1_000_000) / 1_000_000;
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
    if (options.dryRun) { inserted++; continue; }

    await pgClient.unsafe(
      `INSERT INTO ai_model_pricing
         (provider, model, input_micros, output_micros, currency,
          source, source_reference, verified, fetched_at, effective_from)
       VALUES ($1, $2, $3, $4, 'USD', 'public_list',
               'ai.google.dev/gemini-api/docs/pricing — relevé 2026-07-29',
               FALSE, NOW(), NOW())`,
      [
        p.provider, p.model,
        toMicrosPerToken(p.inputPerMillion),
        toMicrosPerToken(p.outputPerMillion),
      ] as never[],
    );
    inserted++;
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
