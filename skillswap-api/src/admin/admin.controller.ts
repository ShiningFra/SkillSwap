import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../common/admin.guard';
import { valider } from '../common/erreurs';
import { Utilisateur } from '../common/session.guard';
import type { UtilisateurCourant } from '../common/session.guard';
import { AdminService } from './admin.service';

const decisionSchema = z.object({
  decision: z.enum(['AVERTIR', 'SUSPENDRE', 'REJETER'], {
    error: 'errors.invalide',
  }),
  commentaire: z
    .string()
    .trim()
    .max(500, { error: 'errors.commentaire' })
    .optional(),
});

/** Toutes les routes exigent le rôle ADMIN, vérifié côté serveur. */
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly service: AdminService) {}

  @Get('indicateurs')
  indicateurs() {
    return this.service.indicateurs();
  }

  @Get('signalements')
  lister() {
    return this.service.lister();
  }

  @Get('signalements/:id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.detail(id);
  }

  @HttpCode(204)
  @Post('signalements/:id/decision')
  async decider(
    @Utilisateur() u: UtilisateurCourant,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() corps: unknown,
  ) {
    const v = valider(decisionSchema, corps);
    await this.service.decider(u.id, id, v.decision, v.commentaire);
  }
}
