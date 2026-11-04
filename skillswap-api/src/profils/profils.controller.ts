import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { uuidOuIntrouvable, valider } from '../common/erreurs';
import { SessionGuard, Utilisateur } from '../common/session.guard';
import type { UtilisateurCourant } from '../common/session.guard';
import { creneauSchema, rechercheSchema } from '../shared/schemas';
import { ProfilsService } from './profils.service';

@UseGuards(SessionGuard)
@Controller()
export class ProfilsController {
  constructor(private readonly profils: ProfilsService) {}

  // ES8 et ES13 : 20 recherches par minute au plus, pour empêcher de retrouver une position par recoupements.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('profils')
  rechercher(@Utilisateur() u: UtilisateurCourant, @Query() q: unknown) {
    return this.profils.rechercher(u.id, valider(rechercheSchema, q));
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('profils/:id')
  profil(@Utilisateur() u: UtilisateurCourant, @Param('id') id: string) {
    return this.profils.profil(u.id, uuidOuIntrouvable(id));
  }

  @Get('moi/creneaux')
  mesCreneaux(@Utilisateur() u: UtilisateurCourant) {
    return this.profils.mesCreneaux(u.id);
  }

  @Post('moi/creneaux')
  creer(@Utilisateur() u: UtilisateurCourant, @Body() corps: unknown) {
    return this.profils.creerCreneau(u.id, valider(creneauSchema, corps));
  }
}
