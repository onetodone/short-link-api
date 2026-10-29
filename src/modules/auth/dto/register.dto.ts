import { createZodDto, ZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { emailField, newPasswordField } from '@/modules/auth/dto/fields'

export const registerSchema = z.object({
  email: emailField,
  password: newPasswordField,
})

const RegisterDtoBase: ZodDto<typeof registerSchema> = createZodDto(registerSchema)

export class RegisterDto extends RegisterDtoBase {}
