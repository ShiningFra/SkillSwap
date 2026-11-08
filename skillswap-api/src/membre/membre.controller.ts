import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
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
import { SemantiqueService } from './semantique.service';
import { MembreService } from './membre.service';

@Controller()
export class MembreController {
  constructor(
    private readonly membre: MembreService,
    private readonly semantique: SemantiqueService,
  ) {}

  @Get('competences')
  catalogue() {
    return this.membre.catalogue();
  }

  /** Compétences voisines par le sens (« faire des gâteaux » → Pâtisserie) ; liste vide si la fonction est coupée. */
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Get('competences/proches')
  proches(@Query('q') q?: string) {
    return this.semantique.proches(typeof q === 'string' ? q : '');
  }

  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('competences')
  proposer(@Utilisateur() u: UtilisateurCourant, @Body() corps: unknown) {
    return this.membre.proposerCompetence(
      u.id,
      valider(
        z.object({
          libelle: z.string().trim().min(2).max(80),
          categorieId: z.uuid({ error: 'errors.competence' }),
        }),
        corps,
      ),
    );
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
