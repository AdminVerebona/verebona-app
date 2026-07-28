/**
 * Tests de l'adaptateur lien web — CDC §4.1.5.
 *
 * Le contrôle d'URL est une exigence de sécurité : un lien fourni par un
 * utilisateur ne doit pas permettre de sonder le réseau interne depuis le
 * serveur.
 */
import { describe, it, expect } from 'vitest';
import { assertSafeUrl, extractTextFromHtml } from '../adapters/web-link-source.adapter';

describe('contrôle des URL', () => {
  it('accepte une adresse publique en https', () => {
    expect(() => assertSafeUrl('https://exemple.fr/page')).not.toThrow();
  });

  it.each([
    ['file:///etc/passwd', 'protocole'],
    ['http://localhost:3000/admin', 'interne'],
    ['http://127.0.0.1/', 'interne'],
    ['http://10.0.0.5/', 'interne'],
    ['http://192.168.1.1/', 'interne'],
    ['http://169.254.169.254/latest/meta-data/', 'métadonnées cloud'],
    ['http://172.16.0.1/', 'interne'],
  ])('refuse %s (%s)', (url) => {
    expect(() => assertSafeUrl(url)).toThrow();
  });

  it('refuse une chaîne qui n\'est pas une URL', () => {
    expect(() => assertSafeUrl('pas une url')).toThrow(/URL invalide/);
  });
});

describe('extraction du texte HTML', () => {
  it('retire scripts et styles', () => {
    const html = '<html><head><style>p{color:red}</style></head><body><script>alert(1)</script><p>Contenu utile</p></body></html>';
    const { text } = extractTextFromHtml(html);
    expect(text).toContain('Contenu utile');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
  });

  it('récupère le titre de la page', () => {
    const { title } = extractTextFromHtml('<html><head><title>Facture EDF</title></head><body></body></html>');
    expect(title).toBe('Facture EDF');
  });

  it('décode les entités et normalise les espaces', () => {
    const { text } = extractTextFromHtml('<p>Total&nbsp;: 129&nbsp;&euro;</p><p>TVA &amp; frais</p>');
    expect(text).toContain('Total : 129 €');
    expect(text).toContain('TVA & frais');
  });
});
