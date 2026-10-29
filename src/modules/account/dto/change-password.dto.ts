import { createZodDto, ZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { currentPasswordField, newPasswordField } from '@/modules/auth/dto/fields'

export const changePasswordSchema = z.object({
  currentPassword: currentPasswordField,
  newPassword: newPasswordField,
})

const ChangePasswordDtoBase: ZodDto<typeof changePasswordSchema> = createZodDto(changePasswordSchema)

export class ChangePasswordDto extends ChangePasswordDtoBase {}
