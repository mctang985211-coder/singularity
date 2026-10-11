import { verify } from './apparatus.mjs'

try {
  await verify('parent', process.argv[2], process.argv[3], '412d9b4c37147040721bc39df5b0d5dd9fdf252815b212748724093a6db16380')
  console.log('core-functional: verified')
} catch (error) {
  console.error('core-functional: ' + error.message)
  process.exitCode = 1
}
