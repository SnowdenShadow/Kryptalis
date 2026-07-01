import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RESOURCES, ALL_PERMISSIONS } from '../../common/rbac/permissions';
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

  // Static permission catalog for the custom-role editor UI. Placed before the
  // `:id` routes so "rbac-catalog" isn't captured as a project id.
  @Get('rbac-catalog')
  @ApiOperation({ summary: 'Permission catalog (resources + actions) for custom roles' })
  rbacCatalog() {
    return { resources: RESOURCES, all: ALL_PERMISSIONS };
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

  @Patch(':id/quota')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'SUPERADMIN')
  @ApiOperation({ summary: 'Set per-project storage quota (platform ADMIN only)' })
  setQuota(
    @Param('id') id: string,
    @Body('quotaBytes') quotaBytes: number | string,
  ) {
    return this.projectsService.setQuota(id, quotaBytes);
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

  @Get(':id/usage')
  @ApiOperation({ summary: 'Current resource usage: project totals + per-app breakdown' })
  getResourceUsage(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.projectsService.getResourceUsage(id, userId);
  }

  @Get(':id/usage/history')
  @ApiOperation({ summary: 'Historical project-wide CPU + memory consumption' })
  getResourceHistory(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('period') period?: string,
  ) {
    return this.projectsService.getResourceHistory(id, userId, period);
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

  @Get(':id/my-permissions')
  @ApiOperation({ summary: 'My effective fine-grained permissions on this project' })
  myPermissions(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.projectsService.getMyPermissions(id, userId);
  }

  // ── Custom roles ────────────────────────────────────────────────────

  @Get(':id/roles')
  @ApiOperation({ summary: 'List the project\'s custom roles' })
  listCustomRoles(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.projectsService.listCustomRoles(id, userId);
  }

  @Post(':id/roles')
  @ApiOperation({ summary: 'Create a custom role (ADMIN+)' })
  createCustomRole(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() body: { name: string; baseRole?: ProjectRole; permissions?: string[] },
  ) {
    return this.projectsService.createCustomRole(id, userId, body);
  }

  @Patch(':id/roles/:roleId')
  @ApiOperation({ summary: 'Update a custom role (ADMIN+)' })
  updateCustomRole(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @CurrentUser('id') userId: string,
    @Body() body: { name?: string; baseRole?: ProjectRole; permissions?: string[] },
  ) {
    return this.projectsService.updateCustomRole(id, userId, roleId, body);
  }

  @Delete(':id/roles/:roleId')
  @ApiOperation({ summary: 'Delete a custom role (ADMIN+)' })
  deleteCustomRole(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.projectsService.deleteCustomRole(id, userId, roleId);
  }

  @Patch(':id/members/:memberId/custom-role')
  @ApiOperation({ summary: 'Assign or clear a member\'s custom role (ADMIN+)' })
  assignCustomRole(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @CurrentUser('id') userId: string,
    @Body('roleId') roleId: string | null,
  ) {
    return this.projectsService.assignCustomRole(id, userId, memberId, roleId ?? null);
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
