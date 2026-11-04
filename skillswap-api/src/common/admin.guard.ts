import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { SessionGuard } from './session.guard';
import type { UtilisateurCourant } from './session.guard';
import { ErreurMetier } from './erreurs';

/** Réservé aux comptes de rôle ADMIN : s'appuie sur la session (ES4, ES6) puis vérifie le rôle côté serveur. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly session: SessionGuard) {}

  async canActivate(contexte: ExecutionContext): Promise<boolean> {
    await this.session.canActivate(contexte);
    const u = contexte
      .switchToHttp()
      .getRequest<{ utilisateur: UtilisateurCourant }>().utilisateur;
    if (u.role !== 'ADMIN')
      throw new ErreurMetier('errors.interdit', HttpStatus.FORBIDDEN);
    return true;
  }
}
