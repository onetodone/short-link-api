import { createZodDto, ZodDto } from 'nestjs-zod'
import { z } from 'zod'

const MAX_URL_LENGTH = 2048
const MAX_NOTE_LENGTH = 200

export const urlValueSchema = z
  .string()
  .trim()
  .min(1, 'URL must not be empty')
  .max(MAX_URL_LENGTH, `URL must be at most ${MAX_URL_LENGTH} characters`)
  .pipe(z.url({ protocol: /^https?$/, error: 'URL must be a valid http(s) URL' }))
  .transform((value) => new URL(value).href)

/** A blank note or `null` clears the note. */
export const noteValueSchema = z
  .string()
  .trim()
  .max(MAX_NOTE_LENGTH, `Note must be at most ${MAX_NOTE_LENGTH} characters`)
  .nullable()
  .transform((value) => value || null)

export const createUrlSchema = z.object({
  url: urlValueSchema,
  note: noteValueSchema.optional(),
})

const CreateUrlDtoBase: ZodDto<typeof createUrlSchema> = createZodDto(createUrlSchema)

export class CreateUrlDto extends CreateUrlDtoBase {}
