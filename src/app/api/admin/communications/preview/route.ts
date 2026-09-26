/**
 * GET /api/admin/communications/preview?eventCode=…&channel=email|push|in_app
 * — CDC Back-Office V1 COM-006 à COM-009.
 *
 * Rendu du modèle selon le canal, avec les SEULES données du propre compte de
 * l'administrateur connecté (COM-007, SEC-005). Une donnée absente est
 * remplacée par une mention explicite et la prévisualisation est déclarée
 * incomplète (COM-009) — jamais de donnée fictive ni d'un autre compte.
 *
 * Push / in-app : le contenu est rendu par le catalogue. Il reste générique
 * (vie privée, CDC notifications §4.3) ; lorsqu'il dépend d'un contexte (bien,
 * document, échéance), la prévisualisation l'indique.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getSession, sessionErrorResponse } from '@/lib/auth-guards';
import { getCatalogEntry } from '@/lib/notifications/catalog';
import {
  appBaseUrl,
  fillTemplate,
  findChannelDefinition,
  findEmailTemplate,
  isCommunicationChannel,
  listEventDefinitions,
  loadAdminPreviewContext,
  loadEmailTemplateCodes,
  resolveTemplateVariables,
} from '@/services/admin/communications.service';

export async function GET(request: NextRequest) {
  let adminId: number;
  let currentAccountId: number | undefined;
  try {
    adminId = await requireAdmin(request);
    currentAccountId = (await getSession(request)).currentAccountId;
  } catch (error) {
    return sessionErrorResponse(error);
  }

  const url = new URL(request.url);
  const eventCode = url.searchParams.get('eventCode') ?? '';
  const channel = url.searchParams.get('channel');
  if (!eventCode || !isCommunicationChannel(channel)) {
    return NextResponse.json({ code: 'INVALID_QUERY', message: 'Paramètres eventCode et channel requis.' }, { status: 400 });
  }

  try {
    const defs = listEventDefinitions(await loadEmailTemplateCodes());
    const found = findChannelDefinition(defs, eventCode, channel);
    if (!found) {
      return NextResponse.json({ code: 'UNKNOWN_CHANNEL', message: 'Canal inconnu pour cet événement.' }, { status: 404 });
    }

    if (channel === 'email') {
      const template = found.event.emailTemplateCode ? await findEmailTemplate(found.event.emailTemplateCode) : null;
      if (!template) {
        return NextResponse.json({
          channel,
          available: false,
          message: 'Aucun gabarit e-mail n’est enregistré pour ce modèle : prévisualisation impossible.',
        });
      }
      const ctx = await loadAdminPreviewContext(adminId, currentAccountId);
      const { variables, missingCount } = resolveTemplateVariables([template.subject, template.body], ctx, appBaseUrl());
      const body = fillTemplate(template.body, variables);
      return NextResponse.json({
        channel,
        available: true,
        subject: fillTemplate(template.subject, variables),
        body,
        isHtml: /<[a-z][\s\S]*>/i.test(body),
        recipient: ctx.email,
        incomplete: missingCount > 0,
        missingCount,
      });
    }

    const entry = found.event.kind === 'notification' ? getCatalogEntry(found.event.code) : undefined;
    if (!entry) {
      return NextResponse.json({ channel, available: false, message: 'Aucun rendu disponible pour ce canal.' });
    }
    let rendered: ReturnType<typeof entry.render> | null = null;
    try {
      rendered = entry.render({});
    } catch {
      rendered = null;
    }
    if (!rendered) {
      return NextResponse.json({
        channel,
        available: false,
        message:
          'Ce modèle dépend d’un contexte (bien, document, échéance…) absent du compte administrateur : prévisualisation impossible.',
      });
    }
    const title = channel === 'push' ? rendered.pushTitle : rendered.bellTitle;
    const body = channel === 'push' ? rendered.pushBody : rendered.bellBody;
    const incomplete = /undefined|null|NaN/.test(`${title} ${body}`);
    return NextResponse.json({
      channel,
      available: true,
      title: incomplete ? title.replace(/undefined|null|NaN/g, '[donnée indisponible]') : title,
      body: incomplete ? body.replace(/undefined|null|NaN/g, '[donnée indisponible]') : body,
      incomplete,
      contextual: true,
    });
  } catch (error) {
    console.error('[admin/communications/preview] GET :', error);
    return NextResponse.json({ code: 'PREVIEW_FAILED', message: 'Prévisualisation impossible.' }, { status: 500 });
  }
}
