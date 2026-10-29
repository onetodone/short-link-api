import { createZodDto, ZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { tokenField } from '@/modules/auth/dto/fields'

export const verifyEmailSchema = z.object({
  token: tokenField,
})

const VerifyEmailDtoBase: ZodDto<typeof verifyEmailSchema> = createZodDto(verifyEmailSchema)

export class VerifyEmailDto extends VerifyEmailDtoBase {}
