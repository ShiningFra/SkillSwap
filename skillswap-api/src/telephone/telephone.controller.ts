import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { valider } from '../common/erreurs';
import { SessionGuard, Utilisateur } from '../common/session.guard';
import type { UtilisateurCourant } from '../common/session.guard';
import { codeSmsSchema, telephoneSchema } from '../shared/schemas';
import { TelephoneService } from './telephone.service';

@UseGuards(SessionGuard)
@Controller('telephone')
export class TelephoneController {
  constructor(private readonly telephone: TelephoneService) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(202)
  @Post('code')
  async code(@Utilisateur() u: UtilisateurCourant, @Body() corps: unknown) {
    await this.telephone.demander(
      u.id,
      valider(telephoneSchema, corps).telephone,
    );
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post('verifier')
  async verifier(@Utilisateur() u: UtilisateurCourant, @Body() corps: unknown) {
    await this.telephone.verifier(u.id, valider(codeSmsSchema, corps).code);
    return { telephoneVerifie: true };
  }
}
