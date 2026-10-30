import { createZodDto, ZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { captchaTokenField, emailField } from '@/modules/auth/dto/fields'

export const forgotPasswordSchema = z.object({
  email: emailField,
  captchaToken: captchaTokenField,
})

const ForgotPasswordDtoBase: ZodDto<typeof forgotPasswordSchema> = createZodDto(forgotPasswordSchema)

export class ForgotPasswordDto extends ForgotPasswordDtoBase {}
