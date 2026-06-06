import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { ProjectRole } from '@prisma/client';

@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('projects')
export class ProjectsController {
  constructor(private projectsService: ProjectsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new project' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateProjectDto) {
    return this.projectsService.create(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all projects' })
  findAll(@CurrentUser('id') userId: string) {
    return this.projectsService.findAll(userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get project by ID' })
  findOne(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.projectsService.findOne(id, userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update project' })
  update(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projectsService.update(id, userId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete project' })
  remove(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.projectsService.remove(id, userId);
  }

  @Post(':id/migrate')
  @ApiOperation({ summary: 'Migrate all apps + DBs to another server' })
  migrate(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body('targetServerId') targetServerId: string,
  ) {
    return this.projectsService.migrate(id, userId, targetServerId);
  }

  @Get(':id/mesh')
  @ApiOperation({ summary: 'Service mesh: internal hostnames + env var suggestions' })
  getServiceMesh(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.projectsService.getServiceMesh(id, userId);
  }

  // ── Members ───────────────────────────────────────────────────────

  @Get(':id/members')
  @ApiOperation({ summary: 'List project members' })
  listMembers(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.projectsService.listMembers(id, userId);
  }

  @Get(':id/my-role')
  @ApiOperation({ summary: 'Get my role on this project' })
  myRole(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.projectsService.getMyRole(id, userId);
  }

  @Post(':id/members')
  @ApiOperation({ summary: 'Add (or upsert) a member by email or userId' })
  addMember(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() body: { email?: string; userId?: string; role: ProjectRole },
  ) {
    return this.projectsService.addMember(id, userId, body);
  }

  @Patch(':id/members/:memberId')
  @ApiOperation({ summary: 'Change a member role' })
  updateMember(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @CurrentUser('id') userId: string,
    @Body('role') role: ProjectRole,
  ) {
    return this.projectsService.updateMember(id, userId, memberId, role);
  }

  @Delete(':id/members/:memberId')
  @ApiOperation({ summary: 'Remove a member' })
  removeMember(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.projectsService.removeMember(id, userId, memberId);
  }

  @Post(':id/transfer-ownership')
  @ApiOperation({ summary: 'Transfer OWNER role to another existing member' })
  transferOwnership(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body('targetUserId') targetUserId: string,
  ) {
    return this.projectsService.transferOwnership(id, userId, targetUserId);
  }
}
