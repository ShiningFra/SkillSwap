import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { config } from './config';
import { COOKIE_SESSION } from './common/session.guard';

/**
 * ES4 (CSRF) : une requête qui modifie des données doit venir de l'origine du site et porter du JSON.
 * Un formulaire d'un autre site ne peut ni fixer Origin ni envoyer application/json sans pré-requête CORS,
 * et le cookie SameSite=Lax n'accompagne pas ses envois POST.
 */
export function protectionCsrf(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origine = req.headers.origin;
  if (origine !== undefined && origine !== config().allowedOrigin) {
    return res.status(403).json({ cle: 'errors.origine' });
  }
  // Un navigateur envoie toujours Origin sur un POST, PUT ou DELETE : son absence avec un cookie de session est refusée.
  if (
    origine === undefined &&
    req.headers.cookie?.includes(`${COOKIE_SESSION}=`)
  )
    return res.status(403).json({ cle: 'errors.origine' });
  const aUnCorps =
    Number(req.headers['content-length'] ?? 0) > 0 ||
    req.headers['transfer-encoding'] !== undefined;
  if (aUnCorps && !req.is('application/json'))
    return res.status(415).json({ cle: 'errors.invalide' });
  next();
}

/** Configuration commune à main.ts et aux tests : ES1 (HSTS) et ES11 (en-têtes, CORS). */
export function configurerApp(app: INestApplication) {
  (app as NestExpressApplication).set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use(cookieParser());
  app.enableCors({ origin: config().allowedOrigin, credentials: true });
  app.use(protectionCsrf);
}
