/**
 * Carte #806 — AUDIT DU STOCK des opérations et de l'Agenda (données créées
 * avant les règles de la carte) : simulation, rapport anonymisé, correction des
 * seuls cas certains.
 *
 *   npx tsx scripts/audit-806-stock-operations.ts --account=<id> [--apply] [--report=audit-806.json]
 *   npx tsx scripts/audit-806-stock-operations.ts --all [--from=<id>] [--apply] [--report=audit-806.json]
 *
 * Lancement MANUEL. Sans `--apply` : SIMULATION — chaque compte est lu dans une
 * transaction en lecture seule, rien n'est écrit en base. Avec `--apply` : seule
 * la correction CERTAINE est faite (lien du graphe manquant pour un événement
 * rattaché par la colonne historique, sans refus de l'utilisateur) ; tout le
 * reste est listé pour arbitrage. Idempotent : un second passage n'écrit rien.
 * Reprise après interruption : relancer tel quel, ou `--from=<dernier compte>`
 * (le fichier `<rapport>.ndjson` garde une ligne par compte déjà traité).
 * Aucun document, aucun lien direct, aucun événement, aucune opération ni
 * aucune relation n'est supprimé. Le rapport ne contient que des codes, des
 * nombres et des identifiants techniques.
 * Voir `services/business-operations/migration-744/stock-audit.ts`.
 */
import '@/lib/load-env';
import { appendFile, writeFile } from 'node:fs/promises';
import { pgClient } from '@/db';
import { auditStock, stockAuditAccounts } from '@/services/business-operations/migration-744/stock-audit';

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const apply = process.argv.includes('--apply');

async function main() {
  const un = arg('account');
  let comptes: number[];
  if (un !== null) comptes = [Number(un)];
  else if (process.argv.includes('--all')) comptes = await stockAuditAccounts(Number(arg('from') ?? 0) || 0);
  else {
    console.error('Usage : audit-806-stock-operations.ts --account=<id> | --all [--from=<id>] [--apply] [--report=fichier.json]');
    process.exitCode = 2;
    await pgClient.end();
    return;
  }
  if (comptes.some((c) => !Number.isSafeInteger(c) || c <= 0)) throw new Error('identifiant de compte invalide');
  const chemin = arg('report') ?? 'audit-806.json';
  const fil = `${chemin}.ndjson`;
  const { reports, failed, summary } = await auditStock(comptes, {
    apply,
    onReport: async (r) => {
      // Une ligne par compte, écrite au fil de l'eau : un passage interrompu garde ce qui est déjà fait.
      await appendFile(fil, `${JSON.stringify(r)}\n`);
      const anomalies = r.anomalies.filter((a) => a.count > 0).map((a) => `${a.code}=${a.count}`).join(', ') || 'aucune anomalie de stock';
      console.log(`[audit-806] compte ${r.accountId} : ${anomalies} ; écarts du graphe ${r.graphFindings.length} ; `
        + `liens à poser ${r.fixes.legacyLinksToRestore}${apply ? `, posés ${r.fixes.legacyLinksRestored}` : ' (simulation)'} ; à arbitrer ${r.arbitration}`);
    },
  });
  for (const f of failed) console.error(`[audit-806] compte ${f.accountId} NON TRAITÉ (rien n'a été écrit) : ${f.error}`);
  await writeFile(chemin, JSON.stringify({ summary, failed, reports }, null, 2));
  console.log(`[audit-806] ${apply ? 'appliqué' : 'simulation'} — ${summary.accounts} compte(s), ${summary.accountsWithAnomalies} avec anomalie, `
    + `${summary.failedAccounts.length} en échec ; liens à poser ${summary.legacyLinksToRestore}, posés ${summary.legacyLinksRestored} ; `
    + `à arbitrer ${summary.arbitration} (rapport : ${chemin}).`);
  if (failed.length) process.exitCode = 1;
  await pgClient.end();
}

main().catch(async (e) => {
  console.error('[audit-806] échec :', (e as Error).message);
  await pgClient.end().catch(() => {});
  process.exit(1);
});
