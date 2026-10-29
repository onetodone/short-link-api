import { createZodDto, ZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { currentPasswordField } from '@/modules/auth/dto/fields'

export const deleteAccountSchema = z.object({
  password: currentPasswordField,
})

const DeleteAccountDtoBase: ZodDto<typeof deleteAccountSchema> = createZodDto(deleteAccountSchema)

export class DeleteAccountDto extends DeleteAccountDtoBase {}
