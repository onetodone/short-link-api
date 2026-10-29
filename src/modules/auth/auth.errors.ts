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
