import { Inject } from '@nestjs/common'

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT')

export const InjectMailTransport = (): ReturnType<typeof Inject> => Inject(MAIL_TRANSPORT)
