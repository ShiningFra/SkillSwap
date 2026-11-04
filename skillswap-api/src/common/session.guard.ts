import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  createParamDecorator,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { Db } from '../db/db.service';
import { ErreurMetier } from './erreurs';

export type UtilisateurCourant = { id: string; role: string };
export const COOKIE_SESSION = 'sid';

export const empreinte = (valeur: string) =>
  createHash('sha256').update(valeur).digest('hex');

/** ES4 et ES6 : toute route protégée exige une session valide, non expirée, non révoquée, d'un compte actif. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly db: Db) {}

  async canActivate(contexte: ExecutionContext): Promise<boolean> {
    const req = contexte
      .switchToHttp()
      .getRequest<Request & { utilisateur?: UtilisateurCourant }>();
    const jeton: unknown = req.cookies?.[COOKIE_SESSION];
    if (typeof jeton !== 'string' || jeton.length < 20)
      throw new ErreurMetier('errors.nonConnecte', HttpStatus.UNAUTHORIZED);
    const { rows } = await this.db.query<UtilisateurCourant>(
      `SELECT u.id, u.role FROM session_connexion s JOIN utilisateur u ON u.id = s.utilisateur_id
        WHERE s.jeton_hash = $1 AND s.revoque_le IS NULL AND s.expire_le > now() AND u.statut = 'ACTIF'`,
      [empreinte(jeton)],
    );
    if (rows.length === 0)
      throw new ErreurMetier('errors.nonConnecte', HttpStatus.UNAUTHORIZED);
    req.utilisateur = rows[0];
    return true;
  }
}

export const Utilisateur = createParamDecorator(
  (_donnee: unknown, contexte: ExecutionContext): UtilisateurCourant => {
    return contexte
      .switchToHttp()
      .getRequest<{ utilisateur: UtilisateurCourant }>().utilisateur;
  },
);
