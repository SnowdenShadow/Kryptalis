import { Module } from '@nestjs/common';
import { ProjectTransferController } from './project-transfer.controller';
import { ProjectTransferService } from './project-transfer.service';
import { ApplicationsModule } from '../applications/applications.module';
import { DatabasesModule } from '../databases/databases.module';
import { ProjectsModule } from '../projects/projects.module';
import { DomainsModule } from '../domains/domains.module';

/**
 * Cross-install project transfer: export a project to an encrypted offline
 * `.dctproj` file and import it into a DIFFERENT DockControl install.
 *
 * Reuses the validated creation paths (Projects/Applications/Databases/Domains)
 * so import re-runs every name/image/compose/port guard. The crypto + manifest
 * live in dctproj-crypto.ts / dctproj-manifest.ts.
 */
@Module({
  imports: [ApplicationsModule, DatabasesModule, ProjectsModule, DomainsModule],
  controllers: [ProjectTransferController],
  providers: [ProjectTransferService],
})
export class ProjectTransferModule {}
