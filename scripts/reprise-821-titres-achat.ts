/**
 * Carte #821 (§3) — reprise du stock : achats et événements d'achat encore
 * nommés « Achat » alors que leurs sources disent ce qui a été acheté
 * (« Achat de carburant »). CORRECTION DE LIBELLÉ UNIQUEMENT.
 *
 *   npx tsx scripts/reprise-821-titres-achat.ts --account=<id> [--apply] [--report=reprise-821.json]
 *   npx tsx scripts/reprise-821-titres-achat.ts --all          [--apply] [--report=reprise-821.json]
 *
 * Lancement MANUEL. Sans `--apply` : À BLANC — rapport avant / après, rien
 * n'est écrit. Idempotent (un second passage n'écrit rien). Borné par pages de
 * 200 achats (toutes les pages sont parcourues). Aucun événement créé ni
 * supprimé ; dates, statuts, montants et relations inchangés ; un intitulé ou
 * un événement saisi ou modifié par l'utilisateur est conservé.
 * Voir `services/business-operations/agenda-projection/purchase-title-reprise.ts`.
 */
import '@/lib/load-env';
import { writeFile } from 'node:fs/promises';
import { pgClient } from '@/db';
import { reprisePurchaseTitles, type PurchaseTitleRepriseReport } from '@/services/business-operations/agenda-projection/purchase-title-reprise';

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
    console.error('Usage : reprise-821-titres-achat.ts --account=<id> | --all [--apply] [--report=fichier.json]');
    process.exitCode = 2;
    await pgClient.end();
    return;
  }
  if (comptes.some((c) => !Number.isSafeInteger(c) || c <= 0)) throw new Error('identifiant de compte invalide');
  const rapports: PurchaseTitleRepriseReport[] = [];
  for (const c of comptes) {
    let apres = 0;
    const total = { examines: 0, intitules: 0, evenements: 0, conserves: 0, inconnus: 0, intitulesEcrits: 0, evenementsEcrits: 0 };
    let nonTraite: string | null = null;
    for (;;) {
      const r = await reprisePurchaseTitles(c, { apply, afterOperationId: apres });
      if (r.operations.length) rapports.push(r);
      total.examines += r.examined; total.intitules += r.labelsToRename; total.evenements += r.eventsToRename; total.conserves += r.keptUser;
      total.inconnus += r.keptUnknown; // Carte #859 : provenance du titre inconnue — conservé, motif au rapport.
      total.intitulesEcrits += r.labelsRenamed; total.evenementsEcrits += r.eventsRenamed;
      nonTraite = r.skipped ?? nonTraite;
      if (!r.remaining || r.nextAfterOperationId === null) break;
      apres = r.nextAfterOperationId;
    }
    console.log(`[reprise-821] compte ${c} : ${total.examines} achat(s) examiné(s), ${total.intitules} intitulé(s) d'opération à corriger, `
      + `${total.evenements} événement(s) à renommer, ${total.conserves} conservé(s) (titre choisi par l'utilisateur), `
      + `${total.inconnus} conservé(s) (provenance du titre inconnue — motif au rapport)`
      + (apply ? ` — intitulés corrigés ${total.intitulesEcrits}, événements renommés ${total.evenementsEcrits}${nonTraite ? ` (non traité : ${nonTraite})` : ''}` : ' (à blanc)'));
  }
  const chemin = arg('report') ?? 'reprise-821.json';
  await writeFile(chemin, JSON.stringify(rapports, null, 2));
  console.log(`[reprise-821] ${apply ? 'appliqué' : 'à blanc'} — ${comptes.length} compte(s) examinés, ${rapports.length} page(s) de rapport (rapport : ${chemin}).`);
  await pgClient.end();
}

main().catch(async (e) => {
  console.error('[reprise-821] échec :', (e as Error).message);
  await pgClient.end().catch(() => {});
  process.exit(1);
});
