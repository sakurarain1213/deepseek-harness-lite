#!/usr/bin/env node
import { main, type CliIo } from './main.js'

const io: CliIo = {
  cwd: process.cwd(),
  platform: process.platform as CliIo['platform'],
  out: (line) => console.log(line),
  err: (line) => console.error(line),
}

process.exitCode = await main(process.argv.slice(2), io)
