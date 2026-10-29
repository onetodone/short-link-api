import { createZodDto, ZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { tokenField } from '@/modules/auth/dto/fields'

export const confirmEmailSchema = z.object({
  token: tokenField,
})

const ConfirmEmailDtoBase: ZodDto<typeof confirmEmailSchema> = createZodDto(confirmEmailSchema)

export class ConfirmEmailDto extends ConfirmEmailDtoBase {}
