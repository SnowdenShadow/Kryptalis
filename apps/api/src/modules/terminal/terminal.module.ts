import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TerminalGateway } from './terminal.gateway';
import { TerminalService } from './terminal.service';
import { SftpModule } from '../sftp/sftp.module';

/**
 * Interactive terminal: a WebSocket gateway (`/ws/terminal`) that bridges an
 * xterm.js client to a real PTY inside an app's container — `docker exec` for
 * local apps, an SSH bridge to the agent's :2522 shell channel for remote ones.
 * Bound to the existing HTTP server from main.ts (no extra port).
 */
@Module({
  imports: [
    SftpModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET')!,
      }),
    }),
  ],
  providers: [TerminalGateway, TerminalService],
  exports: [TerminalGateway],
})
export class TerminalModule {}
