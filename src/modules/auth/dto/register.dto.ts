import { createZodDto, ZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { captchaTokenField, emailField, newPasswordField } from '@/modules/auth/dto/fields'

export const registerSchema = z.object({
  email: emailField,
  password: newPasswordField,
  acceptTerms: z.literal(true, { error: 'You must accept the Terms of Use' }),
  captchaToken: captchaTokenField,
})

const RegisterDtoBase: ZodDto<typeof registerSchema> = createZodDto(registerSchema)

export class RegisterDto extends RegisterDtoBase {}
