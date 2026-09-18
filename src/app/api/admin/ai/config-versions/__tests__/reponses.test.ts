/**
 * CDC BO IA §17, NFR-004 — traduction des refus en réponses.
 *
 * Neuf routes partagent cette traduction. Ce qu'elle décide n'est pas
 * cosmétique : l'écran s'appuie sur le statut pour distinguer « votre demande
 * entre en conflit avec l'état courant » de « le serveur est en panne ». Confondre
 * les deux ferait proposer un « réessayer » là où il faut recharger la page.
 */
import { describe, it, expect, vi } from 'vitest';
import { parseVersionId, toErrorResponse } from '../_shared';
import { ConfigOperationRefused } from '@/services/ai/config/config-version.service';

describe("lecture de l'identifiant", () => {
  it('accepte un entier positif', () => {
    expect(parseVersionId('1')).toBe(1);
    expect(parseVersionId('4207')).toBe(4207);
  });

  it('refuse tout le reste plutôt que de laisser passer à la base', () => {
    // `Number()` accepterait « 12abc », « 1e3 » et «  7  » : autant de valeurs
    // qui atteindraient une requête SQL avec un sens inattendu.
    for (const raw of ['0', '-1', '1.5', '12abc', '1e3', ' 7 ', '', 'null']) {
      expect(parseVersionId(raw), raw).toBeNull();
    }
  });
});

describe('traduction des refus', () => {
  it('rend 404 sur une version introuvable', async () => {
    const r = toErrorResponse(
      new ConfigOperationRefused('VERSION_NOT_FOUND', 'Version 9 introuvable.'),
      'test',
    );
    expect(r.status).toBe(404);
    await expect(r.json()).resolves.toMatchObject({ error: 'VERSION_NOT_FOUND' });
  });

  it('rend 409 sur un refus fonctionnel, avec son code stable', async () => {
    // 409 et non 400 : ni la requête ni le serveur ne sont en cause, c'est
    // l'état courant qui rend l'opération impossible.
    const r = toErrorResponse(
      new ConfigOperationRefused('NEVER_ACTIVE', "N'a jamais été active."),
      'test',
    );
    expect(r.status).toBe(409);
    await expect(r.json()).resolves.toMatchObject({ error: 'NEVER_ACTIVE' });
  });

  it('transporte les détails, pour que l’écran affiche les champs fautifs', async () => {
    const details = [{ treatment: 'T3', field: 'prompt' }];
    const r = toErrorResponse(
      new ConfigOperationRefused('VALIDATION_FAILED', 'Contrôles en échec.', details),
      'test',
    );
    await expect(r.json()).resolves.toMatchObject({ details });
  });

  it('rend 409 sur une transition non prévue par la machine à états', async () => {
    const r = toErrorResponse(new Error('[config-version] Transition refusée : « archive » depuis « ACTIVE ».'), 'test');
    expect(r.status).toBe(409);
    await expect(r.json()).resolves.toMatchObject({ error: 'INVALID_TRANSITION' });
  });

  it('rend 500 sur une panne, sans exposer le message interne', async () => {
    const espion = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = toErrorResponse(new Error('ECONNREFUSED 127.0.0.1:5432'), 'test');
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body.error).toBe('CONFIG_OPERATION_FAILED');
    // Le détail part au journal, pas à l'écran : une adresse de base de données
    // n'a rien à faire dans une réponse HTTP.
    expect(JSON.stringify(body)).not.toContain('5432');
    expect(espion).toHaveBeenCalled();
    espion.mockRestore();
  });
});
