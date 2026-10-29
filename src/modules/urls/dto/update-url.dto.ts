import { createZodDto, ZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { noteValueSchema, urlValueSchema } from '@/modules/urls/dto/create-url.dto'

export const updateUrlSchema = z
  .object({
    url: urlValueSchema.optional(),
    note: noteValueSchema.optional(),
  })
  .refine((body) => body.url !== undefined || body.note !== undefined, {
    error: 'At least one of url or note is required',
  })

const UpdateUrlDtoBase: ZodDto<typeof updateUrlSchema> = createZodDto(updateUrlSchema)

export class UpdateUrlDto extends UpdateUrlDtoBase {}
