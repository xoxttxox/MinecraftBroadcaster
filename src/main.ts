import { runStandalone } from './app/standaloneApp'

runStandalone().catch((e) => {
  console.error(e)
  process.exit(1)
})
