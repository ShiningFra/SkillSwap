import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProfilsModule } from '../profils/profils.module';
import { ConversationsService } from './conversations.service';
import { EchangesController } from './echanges.controller';
import { SessionsService } from './sessions.service';
import { SignalementsService } from './signalements.service';

@Module({
  imports: [AuthModule, ProfilsModule],
  controllers: [EchangesController],
  providers: [ConversationsService, SessionsService, SignalementsService],
})
export class EchangesModule {}
