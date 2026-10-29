import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'

import { API_PREFIX } from '@/common/api-prefix'
import { CurrentUser } from '@/modules/auth/current-user.decorator'
import { EmailVerifiedGuard } from '@/modules/auth/email-verified.guard'
import { JwtAuthGuard } from '@/modules/auth/jwt-auth.guard'
import { CreateUrlDto } from '@/modules/urls/dto/create-url.dto'
import { ListUrlsDto } from '@/modules/urls/dto/list-urls.dto'
import { UpdateUrlDto } from '@/modules/urls/dto/update-url.dto'
import { SHORT_CODE_PATTERN } from '@/modules/urls/short-code.util'
import { UrlsService } from '@/modules/urls/urls.service'
import type { CreatedUrl, UrlList, UrlSummary } from '@/modules/urls/urls.types'

@Controller(`${API_PREFIX}/urls`)
@UseGuards(JwtAuthGuard)
export class UrlsController {
  constructor(private readonly urls: UrlsService) {}

  @Get()
  list(@CurrentUser('id') userId: string, @Query() query: ListUrlsDto): Promise<UrlList> {
    return this.urls.listForUser(userId, { limit: query.limit, offset: query.offset })
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(EmailVerifiedGuard)
  create(@Body() dto: CreateUrlDto, @CurrentUser('id') userId: string): Promise<CreatedUrl> {
    return this.urls.create(dto, userId)
  }

  @Get(':shortCode')
  findOne(@Param('shortCode') shortCode: string, @CurrentUser('id') userId: string): Promise<UrlSummary> {
    return this.urls.findForUser(userId, this.requireShortCode(shortCode))
  }

  @Patch(':shortCode')
  @UseGuards(EmailVerifiedGuard)
  update(
    @Param('shortCode') shortCode: string,
    @Body() dto: UpdateUrlDto,
    @CurrentUser('id') userId: string,
  ): Promise<UrlSummary> {
    return this.urls.updateForUser(userId, this.requireShortCode(shortCode), dto)
  }

  @Delete(':shortCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('shortCode') shortCode: string, @CurrentUser('id') userId: string): Promise<void> {
    return this.urls.deleteForUser(userId, this.requireShortCode(shortCode))
  }

  private requireShortCode(shortCode: string): string {
    if (!SHORT_CODE_PATTERN.test(shortCode)) {
      throw new NotFoundException('Short code not found')
    }
    return shortCode
  }
}
