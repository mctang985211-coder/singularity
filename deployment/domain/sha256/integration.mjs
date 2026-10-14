import { verify } from './apparatus.mjs'

try {
  await verify('integration', process.argv[2], process.argv[3], '081947e6836a688fb49fa0429a4a0db27dac6c4b91b945b78cf3e3d03a4d3e90')
  console.log('core-integration: verified')
} catch (error) {
  console.error('core-integration: ' + error.message)
  process.exitCode = 1
}
