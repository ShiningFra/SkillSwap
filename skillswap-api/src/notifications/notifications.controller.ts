import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { SessionGuard, Utilisateur } from '../common/session.guard';
import type { UtilisateurCourant } from '../common/session.guard';
import { NotificationsService } from './notifications.service';

/** ES6 : chaque membre ne voit et ne modifie que ses propres notifications. */
@UseGuards(SessionGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  lister(@Utilisateur() u: UtilisateurCourant) {
    return this.service.lister(u.id);
  }

  @HttpCode(204)
  @Post('lues')
  async marquerLues(@Utilisateur() u: UtilisateurCourant) {
    await this.service.toutMarquerLu(u.id);
  }
}
