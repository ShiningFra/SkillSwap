import { Module } from '@nestjs/common';
import { Audit } from '../common/audit.service';
import { SessionGuard } from '../common/session.guard';
import { AuthController } from './auth.controller';
import { MailPort, MailSmtpOuConsole } from '../shared/mail';
import { ReinitialisationService } from './reinitialisation.service';
import { SuppressionService } from './suppression.service';
import { AuthService } from './auth.service';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    SuppressionService,
    ReinitialisationService,
    { provide: MailPort, useClass: MailSmtpOuConsole },
    Audit,
    SessionGuard,
  ],
  exports: [Audit, SessionGuard],
})
export class AuthModule {}
