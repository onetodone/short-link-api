import { createZodDto, ZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { currentPasswordField, emailField } from '@/modules/auth/dto/fields'

export const changeEmailSchema = z.object({
  newEmail: emailField,
  password: currentPasswordField,
})

const ChangeEmailDtoBase: ZodDto<typeof changeEmailSchema> = createZodDto(changeEmailSchema)

export class ChangeEmailDto extends ChangeEmailDtoBase {}
