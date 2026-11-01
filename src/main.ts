import '@/common/load-env'

import { ConfigService } from '@nestjs/config'

import { createApp } from '@/app.factory'

async function bootstrap(): Promise<void> {
  const app = await createApp()
  const config = app.get(ConfigService)
  const host = config.get<string>('app.host', '0.0.0.0')
  const port = config.get<number>('app.port', 3000)

  await app.listen(port, host)
}

void bootstrap()
