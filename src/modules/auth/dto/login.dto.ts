import { createZodDto, ZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { emailField } from '@/modules/auth/dto/fields'

export const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1, 'Password is required'),
})

const LoginDtoBase: ZodDto<typeof loginSchema> = createZodDto(loginSchema)

export class LoginDto extends LoginDtoBase {}
