import { verify } from './apparatus.mjs'

try {
  await verify('schedule', process.argv[2], process.argv[3], '081947e6836a688fb49fa0429a4a0db27dac6c4b91b945b78cf3e3d03a4d3e90')
  console.log('w-schedule: verified')
} catch (error) {
  console.error('w-schedule: ' + error.message)
  process.exitCode = 1
}
