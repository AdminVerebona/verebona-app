/**
 * Carte #812 (reprise après la recette KO du 21/11/2026) — reprise IMMÉDIATE du stock : périodes de
 * validité qui ne sont que la date du document (« Début de validité : 17/11/2026 » sur un bon de commande
 * du 17/11/2026).
 *
 *   npx tsx scripts/reprise-812-validites-artificielles.ts --account=<id> [--file=<id>] [--apply] [--report=reprise-812.json]
 *   npx tsx scripts/reprise-812-validites-artificielles.ts --all                      [--apply] [--report=reprise-812.json]
 *
 * Lancement MANUEL. Sans `--apply` : À BLANC — rapport avant / après prévu, rien n'est écrit. Idempotent
 * (un second passage ne trouve plus rien). Borné par pages de 200 documents (toutes les pages sont
 * parcourues). Passe par le MÊME service que le contrôle de cohérence COH-DOC-BUSINESS-PERIODS
 * (`refreshDocumentBusinessPeriods`) : les lignes sont RETIRÉES (statut SUPERSEDED, motif POINT_DATE_COPY,
 * motif précis, corrélation `reprise-812:…`), jamais supprimées ; une période corrigée par l'utilisateur
 * n'est jamais touchée ; aucune IA, aucune relance d'analyse. N'attend aucune campagne de cohérence.
 * Voir `src/services/documents/business-periods/point-date-reprise.ts`.
 */
import '@/lib/load-env';
import { writeFile } from 'node:fs/promises';
import { pgClient } from '@/db';
import { pointDateRepriseAccounts, reprisePointDateValidities, type PointDateRepriseReport } from '@/services/documents/business-periods/point-date-reprise';

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const apply = process.argv.includes('--apply');

async function main() {
  const un = arg('account');
  const fichier = arg('file');
  let comptes: number[];
  if (un !== null) comptes = [Number(un)];
  else if (process.argv.includes('--all') && fichier === null) comptes = await pointDateRepriseAccounts();
  else {
    console.error('Usage : reprise-812-validites-artificielles.ts --account=<id> [--file=<id>] | --all [--apply] [--report=fichier.json]');
    process.exitCode = 2;
    await pgClient.end();
    return;
  }
  if (comptes.some((c) => !Number.isSafeInteger(c) || c <= 0)) throw new Error('identifiant de compte invalide');
  const fileId = fichier === null ? null : Number(fichier);
  if (fileId !== null && (!Number.isSafeInteger(fileId) || fileId <= 0)) throw new Error('identifiant de document invalide');
  const lancement = new Date().toISOString();
  const rapports: PointDateRepriseReport[] = [];
  for (const c of comptes) {
    const correlationId = `reprise-812:${c}:${lancement}`;
    const total = { examines: 0, aRetirer: 0, retirees: 0, aRevoir: 0, restantes: 0 };
    let apres = 0;
    for (;;) {
      const r = await reprisePointDateValidities(c, { apply, fileId, afterFileId: apres, correlationId });
      if (r.documents.length) rapports.push(r);
      total.examines += r.examined; total.aRetirer += r.toRetire; total.retirees += r.retired; total.aRevoir += r.toReview;
      total.restantes += r.documents.reduce((n, d) => n + (d.after?.remaining.length ?? 0), 0);
      for (const d of r.documents) {
        for (const p of d.before) {
          console.log(`[reprise-812] compte ${c}, document ${d.fileId} — AVANT : période ${p.periodId} (${p.kind}, début ${p.start ?? '–'}, fin ${p.end ?? '–'}) `
            + `= date du document ${p.date} (${p.roles.join(', ')}), motif ${p.reason} — APRÈS : ${d.after ? (d.after.retired.includes(p.periodId) ? 'retirée (conservée en base, SUPERSEDED)' : 'NON retirée') : 'serait retirée (à blanc)'}`);
        }
        for (const p of d.toReview) {
          console.log(`[reprise-812] compte ${c}, document ${d.fileId} — À RÉEXAMINER (conservée) : période ${p.periodId} (${p.kind}, fin ${p.end ?? '–'})`);
        }
      }
      if (!r.remaining || r.nextAfterFileId === null) break;
      apres = r.nextAfterFileId;
    }
    console.log(`[reprise-812] compte ${c} : ${total.examines} document(s) examiné(s), ${total.aRetirer} période(s) artificielle(s), `
      + `${total.aRevoir} à réexaminer (conservée(s))`
      + (apply ? ` — retirées ${total.retirees}, restantes ${total.restantes} (corrélation ${correlationId})` : ' (à blanc : rien n’est écrit)'));
  }
  const chemin = arg('report') ?? 'reprise-812.json';
  await writeFile(chemin, JSON.stringify(rapports, null, 2));
  console.log(`[reprise-812] ${apply ? 'appliqué' : 'à blanc'} — ${comptes.length} compte(s) examinés (rapport : ${chemin}).`);
  await pgClient.end();
}

main().catch(async (e) => {
  console.error('[reprise-812] échec :', (e as Error).message);
  await pgClient.end().catch(() => {});
  process.exit(1);
});
