/**
 * Persistance conversationnelle — CDC §28, §19.7, §24.5.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'ASSISTANT RÉPONDAIT SANS RIEN ENREGISTRER
 *
 * `persistResult` était un `console.debug`. Les dix tables du §28 existaient,
 * vides. Aucune conversation ne survivait à un rechargement, aucune citation
 * n'était conservée, et la purge du §31 n'avait rien à purger.
 *
 * Rien ne le signalait : l'assistant fonctionnait, il oubliait.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildExplanation } from '@/services/verebona-assistant/core/source-resolver.service';
import type { ResolvedSource, Claim } from '@/services/verebona-assistant/types/sources';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

/**
 * Retire les commentaires avant analyse.
 *
 * Quatre fois dans ce projet, un test a échoué en attrapant le commentaire
 * qui EXPLIQUAIT la règle : interdire `localStorage`, `@google/genai`,
 * `DocumentCard` ou `undefined as never` dans le code interdisait aussi d'en
 * documenter la raison.
 *
 * Chercher dans le code seul lève l'ambiguïté une fois pour toutes.
 */
const sansCommentaires = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
const SERVICE = read('src/services/verebona-assistant/core/conversation.service.ts');
const RESOLVEUR = read('src/services/verebona-assistant/core/source-resolver.service.ts');
const SCHEMA = sansCommentaires(read('src/db/verebona-schema.ts'));

describe('§28 — les six tables sont écrites', () => {
  it('plus aucun stub', () => {
    expect(SERVICE).not.toContain('persistResult (stub)');
    expect(SERVICE).not.toMatch(/TODO\(CDC §28\)/);
  });

  it('couvre message, sources, citations, liens, actions et trace', () => {
    for (const table of [
      'verebona_messages',
      'verebona_message_sources',
      'verebona_message_claims',
      'verebona_claim_sources',
      'verebona_message_actions',
      'verebona_request_runs',
    ]) {
      expect(SERVICE).toContain(`INSERT INTO ${table}`);
    }
  });

  it('enregistre aussi la question de l’utilisateur', () => {
    // Sans elle, l'historique montrerait des réponses sans questions.
    expect(SERVICE).toMatch(/'user', 'ready'/);
  });

  it('écrit dans une transaction', () => {
    // Une réponse dont les citations manqueraient serait pire qu'une réponse
    // absente : l'utilisateur lirait une affirmation invérifiable (§18.5).
    expect(SERVICE).toMatch(/pgClient\.begin\(/);
  });

  it('ne lève jamais', () => {
    // La réponse est déjà rendue quand cette fonction s'exécute.
    const bloc = SERVICE.slice(SERVICE.indexOf('export async function persistResult'));
    expect(bloc).toMatch(/catch \(e\)[\s\S]{0,300}console\.error/);
  });
});

describe('§18.5 — une citation remonte à sa source', () => {
  it('les sources sont indexées par identifiant, pas par rang', () => {
    // Les citations référencent « doc_128 », jamais un rang d'affichage.
    expect(SERVICE).toContain('ligneParSource');
    expect(SERVICE).toMatch(/ligneParSource\.set\(source\.id/);
  });

  it('l’identifiant de source traverse la résolution', () => {
    // Il était jeté : sans lui, `source_id` — obligatoire — ne pouvait pas
    // être écrit, et aucune citation n'était traçable.
    expect(RESOLVEUR).toMatch(/id: s\.id/);
  });

  it('une source hors affichage ne crée pas de lien inventé', () => {
    expect(SERVICE).toMatch(/if \(ligneId === undefined\) continue/);
  });
});

describe('§19.7 — « Pourquoi ? » montre des titres', () => {
  const sources: ResolvedSource[] = [
    { id: 'doc_128', type: 'document', typeLabel: 'Document', title: 'Acte de vente',
      excerpt: 'surface 78,40 m²', isAvailable: true },
  ];

  it('rapproche l’identifiant de son titre', () => {
    // « doc_128 » ne dit rien à personne.
    const claims: Claim[] = [
      { claimKey: 's', text: 'La surface est de 78,40 m²', sourceIds: ['doc_128'], derivation: 'direct' },
    ];
    expect(buildExplanation(claims, sources)[0].sources).toEqual(['Acte de vente']);
  });

  it('conserve un identifiant sans correspondance', () => {
    // Masquer la source donnerait à croire que l'affirmation sort de nulle
    // part, alors qu'elle est sourcée.
    const claims: Claim[] = [
      { claimKey: 'x', text: 'Autre', sourceIds: ['doc_999'], derivation: 'direct' },
    ];
    expect(buildExplanation(claims, sources)[0].sources).toEqual(['doc_999']);
  });
});

describe('§28.1 — une conversation ACTIVE par compte', () => {
  it('l’index porte enfin son prédicat', () => {
    // `.where(undefined as never)` ne produisait aucun prédicat : `push`
    // créait un index unique sur account_id seul, et un compte ne pouvait
    // avoir qu'UNE conversation — jamais une conversation active.
    expect(SCHEMA).toMatch(/\.where\(sql`status = 'active'`\)/);
    expect(SCHEMA).not.toMatch(/\.where\(\s*undefined as never\s*\)/);
  });

  it('la reprise réaffirme le statut actif (§24.5)', () => {
    // Après un effacement d'historique, l'assistant écrivait dans une
    // conversation marquée supprimée.
    expect(SERVICE).toMatch(/DO UPDATE SET updated_at = now\(\), status = 'active'/);
  });
});
