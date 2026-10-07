/**
 * BO-IA-PROMPTS-01 — écran « Prompts maîtres » (contrôle de source :
 * l'environnement de test est Node, sans DOM).
 *
 *   AC07 : aucune commande à exécuter dans le parcours ;
 *   AC08 : empreintes et références techniques seulement dans le volet
 *          « Détails techniques » ;
 *   AC03 à AC05 : « Activer » toujours proposé, badge « Non testé » et
 *          confirmation légère « Activer quand même » ;
 *   AC11 : « Réactiver cette version » depuis l'historique ;
 *   AC12 à AC14 : « Tester avec le corpus », « Voir les résultats »,
 *          « Relancer les tests », « Cette version n’a pas encore été testée ».
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(process.cwd(), 'src/app/admin/ai-config');
const ui = readFileSync(join(dir, '_components/MasterPrompts.tsx'), 'utf8');
const page = readFileSync(join(dir, 'page.tsx'), 'utf8');
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('BO-IA-PROMPTS-01 — écran des prompts maîtres', () => {
  it('AC07 — aucune commande npm ni instruction de terminal dans l’écran', () => {
    for (const src of [sansCommentaires(ui), sansCommentaires(page)]) {
      expect(src).not.toMatch(/npm run|npx |ai:corpus|--record|--live|terminal/);
    }
    // L'ancien encart du corpus (commande à lancer) a disparu.
    expect(existsSync(join(dir, '_components/MasterCorpusStatus.tsx'))).toBe(false);
    expect(page).not.toMatch(/MasterCorpusStatus|MASTER_CORPUS_NOT_GREEN|ROLLBACK_JUSTIFICATION_REQUIRED/);
  });

  it('AC08 — empreinte et version d’exécution seulement dans « Détails techniques »', () => {
    expect(ui).toContain('<summary className="cursor-pointer">Détails techniques</summary>');
    // Hors du volet (et de la déclaration de type), jamais d'empreinte ni de version d'exécution.
    const horsVolet = ui.replace(/function TechnicalDetails[\s\S]*?\n}\n/, '').replace(/technical: \{[^}]*\};/, '');
    expect(horsVolet).not.toMatch(/contentSha256|runtimeVersion/);
  });

  it('AC03 / AC04 / AC05 — Activer reste disponible sans test ni corpus vert ; badge et confirmation légère', () => {
    expect(ui).toContain('Non testé');
    expect(ui).toContain('Cette version n’a pas encore été testée avec le corpus.');
    expect(ui).toContain('Activer quand même');
    // Le bouton « Activer » ne dépend que des contrôles techniques et de l'activité en cours.
    expect(ui).toMatch(/disabled=\{busy !== null \|\| bloquants\.length > 0 \|\| tropLong\}/);
    expect(ui).not.toMatch(/disabled=\{[^}]*test\.state/);
  });

  it('AC01 / AC02 — « Modifier » ouvre un brouillon ; « Enregistrer le brouillon »', () => {
    expect(ui).toContain('Modifier');
    expect(ui).toContain('Enregistrer le brouillon');
    expect(ui).toContain('Le brouillon n’est jamais utilisé par l’application tant qu’il n’est pas activé.');
  });

  it('AC06 — un prompt par bloc, aucune action globale T1 → T6', () => {
    expect(ui).not.toMatch(/Activer tous|tous les prompts/i);
    expect(ui).toContain('Chaque prompt s’administre indépendamment');
  });

  it('AC09 — motifs techniques affichés avant activation', () => {
    expect(ui).toContain('À corriger avant activation');
  });

  it('AC10 / AC11 — historique et « Réactiver cette version »', () => {
    expect(ui).toContain('Historique des versions');
    expect(ui).toContain('Réactiver cette version');
    expect(ui).toContain('Journal des activations');
  });

  it('AC12 / AC13 / AC14 — tests facultatifs, résultats par version, test périmé signalé', () => {
    for (const t of ['Tester avec le corpus', 'Relancer les tests', 'Voir les résultats', 'Dernier test :', 'Résultat attendu :',
      'Résultat obtenu :', 'Cette version n’a pas encore été testée.', 'Il n’empêche jamais l’activation.']) {
      expect(ui).toContain(t);
    }
  });

  it('page : section « Prompts maîtres » branchée ; la configuration ne porte plus l’éditeur du texte master', () => {
    expect(page).toContain('<MasterPrompts refreshKey={promptsKey} />');
    expect(page).toContain('s’administre dans la section « Prompts maîtres »');
    expect(page).not.toContain("set('masterPrompt'");
  });
});
