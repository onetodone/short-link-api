import '@/common/load-env'

import { ConfigService } from '@nestjs/config'

import { createApp } from '@/app.factory'

async function bootstrap(): Promise<void> {
  const app = await createApp()
  const port = app.get(ConfigService).get<number>('app.port', 3000)

  await app.listen(port, '0.0.0.0')
}

void bootstrap()
