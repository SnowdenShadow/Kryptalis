import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { DomainsService } from './domains.service';
import { CreateDomainDto } from './dto/create-domain.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Domains')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('domains')
export class DomainsController {
  constructor(private svc: DomainsService) {}

  @Post()
  @ApiOperation({ summary: 'Add domain' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateDomainDto) {
    return this.svc.create(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List domains' })
  findAll(@CurrentUser('id') userId: string) {
    return this.svc.findAll(userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get domain' })
  findOne(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.findOne(userId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update domain' })
  update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() data: { applicationId?: string | null },
  ) {
    return this.svc.update(userId, id, data);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete domain' })
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.remove(userId, id);
  }

  @Post(':id/transfer')
  @ApiOperation({ summary: 'Transfer a domain to another project' })
  transfer(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body('targetProjectId') targetProjectId: string,
  ) {
    return this.svc.transfer(userId, id, targetProjectId);
  }
}
