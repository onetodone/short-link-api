import { HttpException, HttpStatus } from '@nestjs/common'

/** `403` with `code: EMAIL_NOT_VERIFIED`: the action needs a confirmed email address. */
export class EmailNotVerifiedException extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.FORBIDDEN,
        message: 'Confirm your email address to continue',
        error: 'Forbidden',
        code: 'EMAIL_NOT_VERIFIED',
      },
      HttpStatus.FORBIDDEN,
    )
  }
}

/** `400` with `code: INVALID_TOKEN`: the emailed link is unknown, already used or expired. */
export class InvalidTokenException extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'This link is invalid or has expired',
        error: 'Bad Request',
        code: 'INVALID_TOKEN',
      },
      HttpStatus.BAD_REQUEST,
    )
  }
}

/** `429` with `code: EMAIL_COOLDOWN` and the seconds until another email can be sent in `retryAfter`. */
export class EmailCooldownException extends HttpException {
  constructor(retryAfter: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: 'An email was sent recently, please wait before asking for another one',
        error: 'Too Many Requests',
        code: 'EMAIL_COOLDOWN',
        retryAfter,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    )
  }
}

/** `403` with `code: INVALID_PASSWORD`: the confirming password of a signed-in account is wrong. */
export class InvalidPasswordException extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.FORBIDDEN,
        message: 'Password is incorrect',
        error: 'Forbidden',
        code: 'INVALID_PASSWORD',
      },
      HttpStatus.FORBIDDEN,
    )
  }
}

/** `403` with `code: ACCOUNT_SUSPENDED`: the operator suspended the account; `supportEmail` is the way back. */
export class AccountSuspendedException extends HttpException {
  constructor(supportEmail: string) {
    super(
      {
        statusCode: HttpStatus.FORBIDDEN,
        message: `This account is suspended. Contact ${supportEmail} for details`,
        error: 'Forbidden',
        code: 'ACCOUNT_SUSPENDED',
        supportEmail,
      },
      HttpStatus.FORBIDDEN,
    )
  }
}

/** `401` for a wrong email or password; `captchaRequired` says whether the next attempt needs a Turnstile token. */
export class InvalidCredentialsException extends HttpException {
  constructor(captchaRequired: boolean) {
    super(
      {
        statusCode: HttpStatus.UNAUTHORIZED,
        message: 'Invalid email or password',
        error: 'Unauthorized',
        captchaRequired,
      },
      HttpStatus.UNAUTHORIZED,
    )
  }
}

/** `400` with `code: CAPTCHA_REQUIRED`: the form needs a Turnstile token in `captchaToken`. */
export class CaptchaRequiredException extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Complete the verification to continue',
        error: 'Bad Request',
        code: 'CAPTCHA_REQUIRED',
      },
      HttpStatus.BAD_REQUEST,
    )
  }
}

/** `400` with `code: CAPTCHA_FAILED`: Turnstile rejected the token, or it was issued for another form. */
export class CaptchaFailedException extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Verification failed, please try again',
        error: 'Bad Request',
        code: 'CAPTCHA_FAILED',
      },
      HttpStatus.BAD_REQUEST,
    )
  }
}

/** `503` with `code: CAPTCHA_UNAVAILABLE`: Turnstile couldn't be reached, so the form is refused. */
export class CaptchaUnavailableException extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message: 'Verification is unavailable, please try again in a few minutes',
        error: 'Service Unavailable',
        code: 'CAPTCHA_UNAVAILABLE',
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    )
  }
}
