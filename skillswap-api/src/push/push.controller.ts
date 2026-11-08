import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { valider } from '../common/erreurs';
import { SessionGuard, Utilisateur } from '../common/session.guard';
import type { UtilisateurCourant } from '../common/session.guard';
import { PushService } from './push.service';

const abonnementSchema = z.object({
  endpoint: z.string().max(600, { error: 'errors.invalide' }),
  keys: z.object({
    p256dh: z
      .string()
      .regex(/^[A-Za-z0-9_-]{20,120}$/, { error: 'errors.invalide' }),
    auth: z
      .string()
      .regex(/^[A-Za-z0-9_-]{10,60}$/, { error: 'errors.invalide' }),
  }),
});
const retraitSchema = z.object({
  endpoint: z.string().max(600, { error: 'errors.invalide' }),
});

/** Notifications sur l'appareil (Web Push). Chaque membre ne gère que ses propres appareils (ES6). */
@UseGuards(SessionGuard)
@Controller()
export class PushController {
  constructor(private readonly service: PushService) {}

  @Get('push/cle')
  cle() {
    return this.service.cle();
  }

  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('moi/push')
  async abonner(@Utilisateur() u: UtilisateurCourant, @Body() corps: unknown) {
    const v = valider(abonnementSchema, corps);
    await this.service.abonner(u.id, {
      endpoint: v.endpoint,
      p256dh: v.keys.p256dh,
      auth: v.keys.auth,
    });
  }

  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('moi/push/retirer')
  async retirer(@Utilisateur() u: UtilisateurCourant, @Body() corps: unknown) {
    await this.service.retirer(u.id, valider(retraitSchema, corps).endpoint);
  }
}
