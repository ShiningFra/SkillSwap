import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { valider } from '../common/erreurs';
import { SessionGuard, Utilisateur } from '../common/session.guard';
import type { UtilisateurCourant } from '../common/session.guard';
import {
  paginationSchema,
  rechargeSchema,
  retraitSchema,
  simulationSchema,
} from '../shared/schemas';
import { PortefeuilleService } from './portefeuille.service';

@UseGuards(SessionGuard)
@Controller('portefeuille')
export class PortefeuilleController {
  constructor(private readonly service: PortefeuilleService) {}

  @Get()
  solde(@Utilisateur() u: UtilisateurCourant) {
    return this.service.solde(u.id);
  }

  @Get('historique')
  historique(@Utilisateur() u: UtilisateurCourant, @Query() q: unknown) {
    const p = valider(paginationSchema, q);
    return this.service.historique(u.id, p.limite, p.decalage);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('recharges')
  recharger(@Utilisateur() u: UtilisateurCourant, @Body() corps: unknown) {
    return this.service.initierRecharge(u.id, valider(rechargeSchema, corps));
  }

  @Get('recharges/:reference')
  recharge(
    @Utilisateur() u: UtilisateurCourant,
    @Param('reference') reference: string,
  ) {
    return this.service.rechargeDe(u.id, reference);
  }

  @HttpCode(204)
  @Post('recharges/:reference/simulation')
  async simuler(
    @Utilisateur() u: UtilisateurCourant,
    @Param('reference') reference: string,
    @Body() corps: unknown,
  ) {
    await this.service.simuler(
      u.id,
      reference,
      valider(simulationSchema, corps).issue === 'REUSSIE',
    );
  }

  @HttpCode(204)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('retraits')
  async retirer(@Utilisateur() u: UtilisateurCourant, @Body() corps: unknown) {
    await this.service.retirer(u.id, valider(retraitSchema, corps));
  }
}
