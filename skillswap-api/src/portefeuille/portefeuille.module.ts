import { Module } from '@nestjs/common';
import { config } from '../config';
import { AuthModule } from '../auth/auth.module';
import { PortefeuilleController } from './portefeuille.controller';
import { PortefeuilleService } from './portefeuille.service';
import {
  PrestataireAbsent,
  PrestatairePaiement,
  PrestataireSimule,
} from './prestataire';

@Module({
  imports: [AuthModule],
  controllers: [PortefeuilleController],
  providers: [
    PortefeuilleService,
    {
      // Hors production, le faux prestataire ; en production, PAIEMENT_PRESTATAIRE=simule le force explicitement.
      provide: PrestatairePaiement,
      useFactory: () =>
        !config().production || process.env.PAIEMENT_PRESTATAIRE === 'simule'
          ? new PrestataireSimule()
          : new PrestataireAbsent(),
    },
  ],
})
export class PortefeuilleModule {}
