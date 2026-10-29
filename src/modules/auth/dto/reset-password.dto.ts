import { createZodDto, ZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { newPasswordField, tokenField } from '@/modules/auth/dto/fields'

export const resetPasswordSchema = z.object({
  token: tokenField,
  password: newPasswordField,
})

const ResetPasswordDtoBase: ZodDto<typeof resetPasswordSchema> = createZodDto(resetPasswordSchema)

export class ResetPasswordDto extends ResetPasswordDtoBase {}
