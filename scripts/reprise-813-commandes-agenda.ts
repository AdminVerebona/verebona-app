/**
 * Carte #813 (critère 9) — reprise du stock : événements « Achat » et cartes
 * « À quelle date… » créés à tort pour un achat dont la seule preuve est un
 * bon de commande.
 *
 *   npx tsx scripts/reprise-813-commandes-agenda.ts --account=<id> [--apply] [--report=reprise-813.json]
 *   npx tsx scripts/reprise-813-commandes-agenda.ts --all          [--apply] [--report=reprise-813.json]
 *
 * Lancement MANUEL. Sans `--apply` : À BLANC — rapport seul, rien n'est écrit.
 * Idempotent (un second passage n'écrit rien). Aucun document, aucune
 * opération, aucune relation ni aucune correction de l'utilisateur n'est
 * supprimé ; un événement saisi ou modifié par l'utilisateur est conservé.
 * Voir `services/business-operations/agenda-projection/order-only-reprise.ts`.
 */
import '@/lib/load-env';
import { writeFile } from 'node:fs/promises';
import { pgClient } from '@/db';
import { repriseOrderOnlyPurchases, type OrderOnlyRepriseReport } from '@/services/business-operations/agenda-projection/order-only-reprise';

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const apply = process.argv.includes('--apply');

async function main() {
  const un = arg('account');
  let comptes: number[];
  if (un !== null) comptes = [Number(un)];
  else if (process.argv.includes('--all')) {
    comptes = ((await pgClient.unsafe(
      `SELECT DISTINCT account_id FROM business_operations WHERE type_code = 'ACQUISITION' AND invalidated_at IS NULL ORDER BY 1`)) as unknown as Array<{ account_id: number }>)
      .map((x) => Number(x.account_id));
  } else {
    console.error('Usage : reprise-813-commandes-agenda.ts --account=<id> | --all [--apply] [--report=fichier.json]');
    process.exitCode = 2;
    await pgClient.end();
    return;
  }
  if (comptes.some((c) => !Number.isSafeInteger(c) || c <= 0)) throw new Error('identifiant de compte invalide');
  const rapports: OrderOnlyRepriseReport[] = [];
  for (const c of comptes) {
    const r = await repriseOrderOnlyPurchases(c, { apply });
    if (r.operations.length) rapports.push(r);
    console.log(`[reprise-813] compte ${c} : ${r.operations.length} achat(s) sur commande seule, ${r.toRemove} événement(s) à retirer, `
      + `${r.keptUserTouched} conservé(s) (touchés par l'utilisateur), ${r.openCards} carte(s) de date ouverte(s)`
      + (apply ? ` — retirés ${r.removed}, cartes fermées ${r.cardsClosed}${r.skipped ? ` (non traité : ${r.skipped})` : ''}` : ' (à blanc)'));
  }
  const chemin = arg('report') ?? 'reprise-813.json';
  await writeFile(chemin, JSON.stringify(rapports, null, 2));
  console.log(`[reprise-813] ${apply ? 'appliqué' : 'à blanc'} — ${comptes.length} compte(s) examinés, ${rapports.length} concerné(s) (rapport : ${chemin}).`);
  await pgClient.end();
}

main().catch(async (e) => {
  console.error('[reprise-813] échec :', (e as Error).message);
  await pgClient.end().catch(() => {});
  process.exit(1);
});
