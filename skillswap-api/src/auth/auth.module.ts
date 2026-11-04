import { Module } from '@nestjs/common';
import { Audit } from '../common/audit.service';
import { SessionGuard } from '../common/session.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, Audit, SessionGuard],
  exports: [Audit, SessionGuard],
})
export class AuthModule {}
