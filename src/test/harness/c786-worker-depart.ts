/**
 * WORKER du harnais DEUX PROCESSUS — carte Trello #786, écarts B01 et B03.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN VRAI PROCESSUS
 *
 * La recette R03 et R13 l'exigent, et l'audit du 22/11/2026 le dit sans
 * détour : « Tests actuels de concurrence dans un processus insuffisants ».
 * Deux `Promise` dans le même processus partagent le cache d'instance, la
 * mémoire des verdicts fiables et l'horloge — elles ne peuvent donc pas
 * démontrer qu'une publication faite par un AUTRE worker arrête un départ.
 *
 * Ce fichier est le worker. Il est lancé par
 * `provider/__tests__/c786-deux-processus.test.ts` avec `node:child_process`,
 * se connecte au PostgreSQL RÉEL et parle à un faux fournisseur HTTP
 * instrumenté (qui compte les POST) — jamais au fournisseur réel.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PROTOCOLE
 *
 * Argument 1 : un JSON `{ mode, model, secret, providerUrl, holdMs }`.
 * Le worker écrit sur la sortie standard des lignes `#C786 <json>` :
 *   · `{ step: 'guarded', admitted, publishedVersion }` — garde franchie ;
 *   · `{ step: 'departed', departed, posts }`           — issue du départ ;
 *   · `{ step: 'lease', acquired, reason, generation }` — réservation ;
 *   · `{ step: 'posted' }`                              — un POST est parti ;
 *   · `{ step: 'done', ... }`                           — bilan.
 *
 * Trois modes :
 *   · `guard-hold-send` (B01) — garde, PUIS attente de `holdMs`, PUIS
 *     confirmation de départ et POST seulement si elle l'autorise. C'est
 *     l'arrêt « entre garde et réseau » que demande R03 ;
 *   · `publish-refusal` (B01) — publie un refus confirmé sur la route, comme
 *     le ferait n'importe quelle autre instance ;
 *   · `probe-once` (B03) — réserve la route et, SI et SEULEMENT SI le bail est
 *     obtenu, envoie UN POST puis enregistre le résultat avec le jeton de
 *     clôture du bail.
 *
 * Aucun secret n'est journalisé : seules des empreintes circulent (#786,
 * contrainte 5). Aucune donnée client n'est employée.
 */
import { keyFingerprint } from '@/services/ai/provider/access-identity';

interface Config {
  mode: 'guard-hold-send' | 'publish-refusal' | 'probe-once';
  model: string;
  secret: string;
  providerUrl: string;
  holdMs?: number;
}

const dire = (o: Record<string, unknown>): void => { process.stdout.write(`#C786 ${JSON.stringify(o)}\n`); };

/** Un POST vers le FAUX fournisseur instrumenté : c'est lui qui compte les départs réels. */
async function poster(cfg: Config, marqueur: string): Promise<number> {
  const r = await fetch(`${cfg.providerUrl}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-C786-Worker': marqueur },
    body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] }),
  });
  dire({ step: 'posted', status: r.status, worker: marqueur });
  return r.status;
}

async function main(): Promise<void> {
  const cfg = JSON.parse(process.argv[2] ?? '{}') as Config;
  const marqueur = `${process.pid}`;
  const A = await import('@/services/ai/provider/operational-admission');
  const O = await import('@/services/ai/provider/model-operational.service');
  const { setProviderSecretResolver } = await import('@/services/ai/provider/provider-secret');
  // La clé est celle du scénario : aucune lecture de la clé réelle, aucun appel au fournisseur réel.
  setProviderSecretResolver(async () => cfg.secret);
  // La dimension « disponibilité » doit être ACTIVE : ce processus a une vraie base.
  A.__enableAdmissionDbForTests(true);

  if (cfg.mode === 'publish-refusal') {
    const etat = await O.recordOperationalCheck({
      model: cfg.model, secret: cfg.secret, source: 'catalog_refresh',
      checkId: `c786-2p-publish:${marqueur}`,
      outcome: {
        status: 'failed', kind: 'model_access_closed', definitive: true,
        error: `{"error":{"code":404,"message":"This model models/${cfg.model} is no longer available to new users","status":"NOT_FOUND"}}`,
      },
    });
    dire({ step: 'done', mode: cfg.mode, persistence: etat.persistence, ok: etat.ok, changed: etat.changed });
    return;
  }

  if (cfg.mode === 'probe-once') {
    const bail = await O.acquireProbeLease({
      model: cfg.model, secret: cfg.secret, owner: `c786-2p:${marqueur}`, immediate: true,
    });
    dire({ step: 'lease', acquired: bail.acquired, reason: bail.reason, generation: bail.generation });
    if (!bail.acquired) {
      dire({ step: 'done', mode: cfg.mode, posted: false });
      return;
    }
    try {
      await poster(cfg, marqueur);
      const etat = await O.recordOperationalCheck({
        model: cfg.model, secret: cfg.secret, source: 'catalog_refresh', outcome: { status: 'ok' },
        checkId: `c786-2p-probe:${marqueur}`,
        ...(bail.generation === null ? {} : { leaseGeneration: bail.generation }),
      });
      dire({ step: 'done', mode: cfg.mode, posted: true, persistence: etat.persistence, stale: etat.stale ?? false });
    } finally {
      await O.releaseProbeLease({ model: cfg.model, secret: cfg.secret, owner: `c786-2p:${marqueur}` });
    }
    return;
  }

  // ── B01 : garde, arrêt dans la fenêtre garde → réseau, puis confirmation ──
  const admission = await A.guardSend({ model: cfg.model, point: 'gateway_send', access: { secret: cfg.secret } });
  dire({
    step: 'guarded', admitted: admission.admitted,
    publishedVersion: admission.admitted ? admission.publishedVersion ?? null : null,
    fingerprint: keyFingerprint(cfg.secret).slice(0, 8),
  });
  if (!admission.admitted) {
    dire({ step: 'done', mode: cfg.mode, posted: false, code: admission.code });
    return;
  }
  // ARRÊT VOLONTAIRE dans la fenêtre : le second worker publie le refus pendant ce temps.
  await new Promise((r) => setTimeout(r, Math.max(0, cfg.holdMs ?? 1_500)));
  const depart = await A.confirmDeparture(admission);
  dire({ step: 'departed', departed: depart.departed, version: depart.version });
  if (depart.departed) await poster(cfg, marqueur);
  dire({ step: 'done', mode: cfg.mode, posted: depart.departed });
}

main().then(
  async () => {
    // La connexion est fermée explicitement : sans quoi le processus ne rendrait pas la main.
    try { await (await import('@/db')).pgClient.end({ timeout: 5 }); } catch { /* déjà fermée */ }
    process.exit(0);
  },
  (e: unknown) => {
    dire({ step: 'error', message: String((e as Error)?.message ?? e).slice(0, 300) });
    process.exit(1);
  },
);
