import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { ErreurMetier, valider } from '../common/erreurs';
import { SessionGuard, Utilisateur } from '../common/session.guard';
import type { UtilisateurCourant } from '../common/session.guard';
import {
  declarationSchema,
  localisationSchema,
  modificationCompetenceSchema,
  profilSchema,
} from '../shared/schemas';
import { MembreService } from './membre.service';

@Controller()
export class MembreController {
  constructor(private readonly membre: MembreService) {}

  @Get('competences')
  catalogue() {
    return this.membre.catalogue();
  }

  @UseGuards(SessionGuard)
  @HttpCode(204)
  @Put('moi/localisation')
  async localisation(
    @Utilisateur() u: UtilisateurCourant,
    @Body() corps: unknown,
  ) {
    await this.membre.definirLocalisation(
      u.id,
      valider(localisationSchema, corps),
    );
  }

  @UseGuards(SessionGuard)
  @Get('moi/competences')
  declarations(@Utilisateur() u: UtilisateurCourant) {
    return this.membre.declarations(u.id);
  }

  @UseGuards(SessionGuard)
  @Post('moi/competences')
  async declarer(@Utilisateur() u: UtilisateurCourant, @Body() corps: unknown) {
    await this.membre.declarer(u.id, valider(declarationSchema, corps));
    return { ok: true };
  }

  @UseGuards(SessionGuard)
  @HttpCode(204)
  @Delete('moi/competences/:competenceId')
  async retirer(
    @Utilisateur() u: UtilisateurCourant,
    @Param('competenceId') competenceId: string,
  ) {
    if (!z.uuid().safeParse(competenceId).success)
      throw new ErreurMetier('errors.introuvable', 404);
    await this.membre.retirer(u.id, competenceId);
  }

  @UseGuards(SessionGuard)
  @HttpCode(204)
  @Put('moi/competences/:competenceId')
  async modifier(
    @Utilisateur() u: UtilisateurCourant,
    @Param('competenceId') competenceId: string,
    @Body() corps: unknown,
  ) {
    if (!z.uuid().safeParse(competenceId).success)
      throw new ErreurMetier('errors.introuvable', 404);
    await this.membre.modifierCompetence(
      u.id,
      competenceId,
      valider(modificationCompetenceSchema, corps),
    );
  }

  @UseGuards(SessionGuard)
  @HttpCode(204)
  @Put('moi/profil')
  async profil(@Utilisateur() u: UtilisateurCourant, @Body() corps: unknown) {
    await this.membre.modifierProfil(u.id, valider(profilSchema, corps));
  }
}
