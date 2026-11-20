/**
 * Carte #819 (F) — reprise de l'existant : factures déjà rattachées à une
 * opération dont le bien est connu (rattachement au bien par l'opération,
 * carte « À quel bien rattacher ce document ? » obsolète, date principale de
 * l'achat = date de la facture).
 *
 *   npx tsx scripts/reprise-819-commande-facture.ts --account=<id> [--apply] [--report=reprise-819.json]
 *   npx tsx scripts/reprise-819-commande-facture.ts --all          [--apply] [--report=reprise-819.json]
 *
 * Lancement MANUEL. Sans `--apply` : À BLANC — rapport seul, rien n'est écrit.
 * Bornée (200 documents et 200 opérations par compte et par lancement ; « reste » signalé : relancer).
 * Idempotente (un second passage n'écrit rien). Aucun appel à un fournisseur d'IA. Aucune opération créée,
 * aucun document ni lien dupliqué ; un rattachement, un retrait, un « Aucun » ou une date de l'utilisateur
 * ne sont jamais modifiés.
 * Voir `services/business-operations/consolidation/order-invoice-reprise.ts`.
 */
import '@/lib/load-env';
import { writeFile } from 'node:fs/promises';
import { pgClient } from '@/db';
import { repriseOrderInvoice, type OrderInvoiceRepriseReport } from '@/services/business-operations/consolidation/order-invoice-reprise';

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
      `SELECT DISTINCT account_id FROM business_operations WHERE invalidated_at IS NULL AND merged_into_operation_id IS NULL ORDER BY 1`)) as unknown as Array<{ account_id: number }>)
      .map((x) => Number(x.account_id));
  } else {
    console.error('Usage : reprise-819-commande-facture.ts --account=<id> | --all [--apply] [--report=fichier.json]');
    process.exitCode = 2;
    await pgClient.end();
    return;
  }
  if (comptes.some((c) => !Number.isSafeInteger(c) || c <= 0)) throw new Error('identifiant de compte invalide');
  const rapports: OrderInvoiceRepriseReport[] = [];
  for (const c of comptes) {
    const r = await repriseOrderInvoice(c, { apply });
    if (r.attachments.length || r.dates.length) rapports.push(r);
    const proteges = r.dates.filter((d) => d.protectedByUser).length;
    console.log(`[reprise-819] compte ${c} : ${r.attachments.length} document(s) à rattacher par leur opération, `
      + `${r.attachments.reduce((n, a) => n + a.openCardIds.length, 0)} carte(s) de rattachement ouverte(s), `
      + `${r.dates.length - proteges} date(s) principale(s) à mettre à la date de la facture, ${proteges} conservée(s) (saisie de l'utilisateur)`
      + (r.remaining ? ' — reste à traiter : relancer' : '')
      + (apply ? ` — rattachés ${r.attached}, cartes fermées ${r.cardsClosed}, dates modifiées ${r.datesChanged}${r.skipped ? ` (non traité : ${r.skipped})` : ''}` : ' (à blanc)'));
  }
  const chemin = arg('report') ?? 'reprise-819.json';
  await writeFile(chemin, JSON.stringify(rapports, null, 2));
  console.log(`[reprise-819] ${apply ? 'appliqué' : 'à blanc'} — ${comptes.length} compte(s) examinés, ${rapports.length} concerné(s) (rapport : ${chemin}).`);
  await pgClient.end();
}

main().catch(async (e) => {
  console.error('[reprise-819] échec :', (e as Error).message);
  await pgClient.end().catch(() => {});
  process.exit(1);
});
