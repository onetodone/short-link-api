import { HttpException, HttpStatus } from '@nestjs/common'

import type { DestinationRejectionReason } from '@/modules/urls/destination-rules'

/** A destination rule, or `UNSAFE_DESTINATION` when Google Safe Browsing flags the URL. */
export type DestinationRejectedReason = DestinationRejectionReason | 'UNSAFE_DESTINATION'

const DESTINATION_MESSAGES: Record<DestinationRejectedReason, string> = {
  CREDENTIALS_IN_URL: 'Destination URL must not contain a username or password',
  IP_ADDRESS: 'Destination URL must use a domain name, not an IP address',
  LOCAL_HOST: 'Destination URL must point to a public domain',
  OWN_DOMAIN: 'Destination URL must not be another short link',
  URL_SHORTENER: 'Destination URL must not point to a URL shortener or redirector',
  UNSAFE_DESTINATION: 'Destination URL is flagged as unsafe by Google Safe Browsing',
}

/** `422` with `code: DESTINATION_REJECTED` and why the URL was rejected in `reason`. */
export class DestinationRejectedException extends HttpException {
  constructor(reason: DestinationRejectedReason) {
    super(
      {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        message: DESTINATION_MESSAGES[reason],
        error: 'Unprocessable Entity',
        code: 'DESTINATION_REJECTED',
        reason,
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    )
  }
}

/** `429` with `code: CREATE_QUOTA_EXCEEDED`, the `limit` and the seconds until the window resets in `retryAfter`. */
export class CreateQuotaExceededException extends HttpException {
  constructor(limit: number, retryAfter: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: `You can create at most ${limit} links per 24 hours`,
        error: 'Too Many Requests',
        code: 'CREATE_QUOTA_EXCEEDED',
        limit,
        retryAfter,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    )
  }
}
