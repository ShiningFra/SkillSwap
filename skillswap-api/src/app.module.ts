import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { config } from './config';
import { DbModule } from './db/db.module';
import { EchangesModule } from './echanges/echanges.module';
import { MembreModule } from './membre/membre.module';
import { ProfilsModule } from './profils/profils.module';
import { TelephoneModule } from './telephone/telephone.module';

@Module({
  imports: [
    // ES13 : plafond global par IP, resserré route par route avec @Throttle.
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: config().throttleLimit }],
      // Uniquement pour les tests qui ne portent pas sur la limitation ; jamais actif en production.
      skipIf: () =>
        process.env.NODE_ENV === 'test' &&
        process.env.THROTTLE_DISABLED === 'true',
    }),
    DbModule,
    AuthModule,
    TelephoneModule,
    MembreModule,
    ProfilsModule,
    EchangesModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
