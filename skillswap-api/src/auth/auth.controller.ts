import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { config } from '../config';
import { valider } from '../common/erreurs';
import {
  COOKIE_SESSION,
  SessionGuard,
  Utilisateur,
} from '../common/session.guard';
import type { UtilisateurCourant } from '../common/session.guard';
import {
  connexionSchema,
  inscriptionSchema,
  suppressionSchema,
} from '../shared/schemas';
import { AuthService } from './auth.service';
import { SuppressionService } from './suppression.service';

/** ES4 : HttpOnly, Secure (hors développement), SameSite=Lax, durée limitée. */
function poserCookie(res: Response, jeton: string) {
  const c = config();
  res.cookie(COOKIE_SESSION, jeton, {
    httpOnly: true,
    secure: c.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: c.sessionJours * 86_400_000,
  });
}

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly suppression: SuppressionService,
  ) {}

  // ES13 : au plus 10 inscriptions par minute et par IP.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('auth/inscription')
  async inscription(
    @Body() corps: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const v = valider(inscriptionSchema, corps);
    const { id, pseudo, jeton } = await this.auth.inscrire(v);
    poserCookie(res, jeton);
    res.status(201);
    return { id, pseudo };
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post('auth/connexion')
  async connexion(
    @Body() corps: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const v = valider(connexionSchema, corps);
    const { id, jeton } = await this.auth.connecter(
      v.email,
      v.motDePasse,
      req.ip ?? 'inconnue',
    );
    poserCookie(res, jeton);
    return { id };
  }

  @HttpCode(204)
  @Post('auth/deconnexion')
  async deconnexion(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const jeton: unknown = req.cookies?.[COOKIE_SESSION];
    if (typeof jeton === 'string') await this.auth.deconnecter(jeton);
    res.clearCookie(COOKIE_SESSION, { path: '/' });
  }

  // RG14 : suppression du compte après confirmation par le mot de passe (5 essais par minute au plus).
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(SessionGuard)
  @HttpCode(204)
  @Post('moi/suppression')
  async supprimer(
    @Utilisateur() u: UtilisateurCourant,
    @Body() corps: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const v = valider(suppressionSchema, corps);
    await this.suppression.supprimer(u.id, v.motDePasse);
    res.clearCookie(COOKIE_SESSION, { path: '/' });
  }

  @UseGuards(SessionGuard)
  @Get('moi')
  moi(@Utilisateur() u: UtilisateurCourant) {
    return this.auth.moi(u.id);
  }
}
