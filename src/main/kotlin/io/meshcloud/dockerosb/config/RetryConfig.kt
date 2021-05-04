package io.meshcloud.dockerosb.config

import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Configuration

@Configuration
class RetryConfig (
  @Value("\${retry.remote-write.attempts}")
  val remoteWriteAttempts: Int,

  @Value("\${retry.remote-write.backoff-delay}")
  val remoteWriteBackOffDelay: Long
)
