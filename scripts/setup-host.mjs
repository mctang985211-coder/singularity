#!/usr/bin/env node
import { configureHost } from './host-config.mjs'

try {
  const installed = await configureHost(undefined, process.argv[2])
  console.log(`Private DSH verified and linked: ${installed}`)
} catch (error) {
  console.error(`setup:host: ${error.message}`)
  process.exitCode = 1
}
