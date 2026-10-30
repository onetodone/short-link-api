import { z } from 'zod'

const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 128
const MAX_EMAIL_LENGTH = 254
const MAX_TOKEN_LENGTH = 256
const MAX_CAPTCHA_TOKEN_LENGTH = 2048

export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'A valid email address is required')
  .max(MAX_EMAIL_LENGTH, `Email must be at most ${MAX_EMAIL_LENGTH} characters`)
  .pipe(z.email('A valid email address is required'))

export const newPasswordField = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`)

export const tokenField = z.string().min(1, 'Token is required').max(MAX_TOKEN_LENGTH, 'Token is invalid')

export const currentPasswordField = z
  .string()
  .min(1, 'Password is required')
  .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`)

export const captchaTokenField = z
  .string()
  .max(MAX_CAPTCHA_TOKEN_LENGTH, 'Verification token is invalid')
  .optional()
  .transform((value) => value || undefined)
