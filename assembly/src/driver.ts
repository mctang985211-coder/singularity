import { createTaskLifecycle } from './driver-execution.ts'
import { createReleaseLifecycle } from './driver-release.ts'
import { createReviewLifecycle } from './driver-review.ts'
import { createRsiLifecycle } from './driver-rsi.ts'
import { openDriverRuntime } from './driver-runtime.ts'
import { seedMethod } from './method.ts'
import type { DriverOptions, TaskDriver } from './task-service.ts'

/** Bind lifecycle ports over the one control store and shutdown scope. */
export async function openDriver(options: DriverOptions): Promise<TaskDriver> {
  const runtime = await openDriverRuntime(options)
  const rsi = createRsiLifecycle(runtime)
  const review = createReviewLifecycle(runtime, rsi.taskSignal)
  const release = createReleaseLifecycle(runtime)
  const { service, execution } = createTaskLifecycle(runtime, review, rsi, release)
  try { await seedMethod(runtime.apparatus, options.initialMethod) }
  catch (error) { await runtime.close(execution, rsi.cancellationReasons()); throw error }
  return { ...service, close: () => runtime.close(execution, rsi.cancellationReasons()) }
}
