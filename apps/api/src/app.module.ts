import { Module } from '@nestjs/common'
import { HealthModule } from './health/health.module'

/** The root module: it only lists the feature modules the API is made of. */
@Module({
  imports: [HealthModule],
})
export class AppModule {}
