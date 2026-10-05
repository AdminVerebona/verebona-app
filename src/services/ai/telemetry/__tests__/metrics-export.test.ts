/**
 * Lot 23 — export CSV des métriques agrégées (CDC Assistant §32.6) :
 * échappement anti-injection de formules, période paramétrable, filtres,
 * cloisonnement (aucun identifiant ni contenu).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {}, ensureMigrations: vi.fn(async () => {}) }));

const X = await import('../metrics-export');

describe('CSV sûr', () => {
  it('neutralise les formules (=, +, -, @, tabulation, CR) et échappe guillemets et séparateurs', () => {
    expect(X.csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(X.csvCell('+33')).toBe(`'+33`);
    expect(X.csvCell('-1+1')).toBe(`'-1+1`);
    expect(X.csvCell('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(X.csvCell('\tcmd')).toBe(`'\tcmd`);
    expect(X.csvCell('a;b')).toBe('"a;b"');
    expect(X.csvCell('ligne\nsuite')).toBe('"ligne\nsuite"');
    expect(X.csvCell('ACCOUNT_SEARCH_DOCUMENT')).toBe('ACCOUNT_SEARCH_DOCUMENT');
    expect(X.csvCell(-3)).toBe('-3'); // nombre : jamais une formule
    expect(X.csvCell(Number.NaN)).toBe('');
    expect(X.csvCell(null)).toBe('');
  });

  it('BOM, en-tête fixe, CRLF', () => {
    const csv = X.toCsv([{ section: 's', jour: '2026-10-01', indicateur: 'demandes', valeur: 4 }]);
    expect(csv.startsWith('﻿section;jour;intention;mode;statut;offre;traitement;alias_modele;modele;version_prompt;tache;indicateur;valeur\r\n')).toBe(true);
    expect(csv.endsWith('s;2026-10-01;;;;;;;;;;demandes;4\r\n')).toBe(true);
  });
});

describe('paramètres', () => {
  const q = (s: string) => X.parseMetricsExportQuery(new URLSearchParams(s), new Date('2026-10-05T12:00:00Z'));

  it('défaut : 30 derniers jours en Europe/Paris ; période et filtres lus', () => {
    // 23 h 30 UTC le 5 = déjà le 6 à Paris.
    expect(X.parseMetricsExportQuery(new URLSearchParams(''), new Date('2026-10-05T23:30:00Z'))).toMatchObject({ from: '2026-09-07', to: '2026-10-06' });
    expect(q('')).toEqual({ from: '2026-09-06', to: '2026-10-05', intent: null, model: null, promptVersion: null, plan: null });
    expect(q('from=2026-09-01&to=2026-09-30&intent=ACCOUNT_SUMMARY&model=gemini-3.5-flash-lite&plan=PREMIUM'))
      .toMatchObject({ from: '2026-09-01', to: '2026-09-30', intent: 'ACCOUNT_SUMMARY', model: 'gemini-3.5-flash-lite', plan: 'PREMIUM' });
  });

  it('refuse dates illisibles, période inversée ou trop longue, filtre suspect', () => {
    expect(() => q('from=2026-02-30&to=2026-03-01')).toThrow(expect.objectContaining({ code: 'INVALID_PERIOD' }));
    expect(() => q('from=2026-10-02&to=2026-10-01')).toThrow(expect.objectContaining({ code: 'INVALID_PERIOD' }));
    expect(() => q('from=2025-01-01&to=2026-10-01')).toThrow(expect.objectContaining({ code: 'PERIOD_TOO_LONG' }));
    expect(() => q("intent=x' OR 1=1")).toThrow(expect.objectContaining({ code: 'INVALID_FILTER' }));
  });
});

describe('construction (jour par jour)', () => {
  const fake = (over: { demandes?: number } = {}) => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const run = async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (/FROM verebona_request_runs r LEFT JOIN/.test(sql)) {
        const ligne = { intent: 'ACCOUNT_SUMMARY', mode: 'ai', status: 'ok', demandes: 3, cache_hits: 1, timeouts: 0, p50: 1200.4, p95: 2400, p99: 2600, candidats: 5.333, sources: 2 };
        return Array.from({ length: over.demandes ?? 1 }, () => ligne);
      }
      if (/FROM verebona_ai_runs x/.test(sql)) {
        return [{ alias: 'assistant-default', modele: 'gemini-3.5-flash-lite', tache: '=cmd', status: 'ok', appels: 2, escalades: 0, tin: 4000, tout: 300, cout: 900, p50: 800, p95: 900 }];
      }
      return [{ uc: 'INTELLIGENT_ASSISTANT', plan: '< 5 comptes', master: 't2_master_v1', appels: 2, echecs: 0, tin: 4000, tout: 300, cout: 900 }];
    };
    return { calls, run };
  };
  const Q = { from: '2026-10-01', to: '2026-10-02', intent: 'ACCOUNT_SUMMARY', model: 'gemini-3.5-flash-lite', promptVersion: 'v7', plan: null };

  it('trois requêtes par jour, filtres et masque en paramètres, version maître réelle', async () => {
    const { calls, run } = fake();
    const rows = await X.buildMetricsExport(Q, run);
    expect(calls).toHaveLength(6);
    expect(calls.map((c) => c.params[0])).toEqual(['2026-10-01', '2026-10-01', '2026-10-01', '2026-10-02', '2026-10-02', '2026-10-02']);
    expect(calls[0].params).toEqual(['2026-10-01', '< 5 comptes', null, 'ACCOUNT_SUMMARY', 'gemini-3.5-flash-lite']);
    expect(calls[2].params.at(-1)).toBe('v7');
    expect(calls[2].params).toEqual(['2026-10-01', '< 5 comptes', null, 'gemini-3.5-flash-lite', 'v7']);
    expect(calls[2].sql).toMatch(/e\.master_prompt_version = \$5/);
    // Seuil de 5 comptes sur les TROIS sections ; groupe retiré si filtre d'offre.
    for (const c of calls.slice(0, 3)) {
      expect(c.sql).toMatch(/COUNT\(DISTINCT account_id\)/);
      expect(c.sql).toMatch(/\$3::text IS NULL OR g\.comptes >= 5/);
    }
    // Aucune colonne d'identifiant ni de contenu dans la projection finale.
    for (const c of calls) {
      const finale = c.sql.slice(c.sql.lastIndexOf('SELECT CASE') >= 0 ? c.sql.lastIndexOf('SELECT CASE') : c.sql.lastIndexOf('SELECT b.uc'));
      expect(finale.split(/\bFROM\b/)[0]).not.toMatch(/account_id|user_id|conversation_id|request_id|content|message/i);
    }
    expect(rows.filter((r) => r.section === 'assistant_demandes' && r.jour === '2026-10-01').map((r) => [r.indicateur, r.valeur])).toEqual([
      ['demandes', 3], ['reponses_cache', 1], ['timeouts', 0], ['latence_p50_ms', 1200], ['latence_p95_ms', 2400],
      ['latence_p99_ms', 2600], ['sources_recuperees_moy', 5.33], ['sources_affichees_moy', 2],
    ]);
    const csv = X.toCsv(rows);
    expect(csv).toContain(";'=cmd;"); // tâche neutralisée
    expect(csv).toContain('ia_usage_par_offre;2026-10-01;;;;< 5 comptes;INTELLIGENT_ASSISTANT;;;t2_master_v1;;appels;2');
    // Portée des filtres et troncature signalées dans le fichier.
    expect(csv).toContain('_meta;;;;;;;;;;;filtre_promptVersion;v7 (sections : ia_usage_par_offre)');
    expect(csv).toContain('filtre_intent;ACCOUNT_SUMMARY (sections : assistant_demandes, assistant_appels_modele)');
    expect(rows.at(-1)).toEqual({ section: '_meta', indicateur: 'tronque', valeur: 'non' });
  });

  it('borne par section et par jour : ligne « tronque » et résumé', async () => {
    const { run } = fake({ demandes: X.MAX_GROUPS_PER_SECTION + 1 });
    const { stream, done } = X.metricsExportStream({ ...Q, to: Q.from }, run);
    const texte = await new Response(stream).text();
    const s = await done;
    expect(s).toMatchObject({ truncated: true, truncatedDays: ['2026-10-01'] });
    expect(texte.replace(/^\uFEFF/, '').startsWith('section;')).toBe(true); // BOM retiré par le décodeur
    expect(texte.trim().split('\r\n').at(-1)).toMatch(/^_meta;.*;tronque;oui \(20000 groupes par section et par jour, jours : 2026-10-01\)$/);
    expect(s.rows).toBe(X.MAX_GROUPS_PER_SECTION * 8 + 7 + 5);
  });

  it('erreur en cours de flux : le flux échoue et `done` est rejeté', async () => {
    const { stream, done } = X.metricsExportStream(Q, async () => { throw new Error('délai'); });
    await expect(new Response(stream).text()).rejects.toThrow();
    await expect(done).rejects.toThrow('délai');
  });
});
