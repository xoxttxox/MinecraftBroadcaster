import { appendFileLogLine } from './fileLogging'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const levels: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
}

export class Logger {
  constructor(
    private readonly prefix: string,
    private min: LogLevel = 'info'
  ) {}

  setDebug(enabled: boolean): void {
    this.min = enabled ? 'debug' : 'info'
  }

  prefixed(p: string): Logger {
    return new Logger(this.prefix ? `${this.prefix} ${p}` : p, this.min)
  }

  private log(level: LogLevel, msg: string, err?: unknown): void {
    if (levels[level] < levels[this.min]) return
    const line = `[${level.toUpperCase()}] ${this.prefix ? `[${this.prefix}] ` : ''}${msg}`
    if (level === 'error') console.error(line, err !== undefined ? err : '')
    else if (level === 'warn') console.warn(line)
    else console.log(line)
    appendFileLogLine(level, this.prefix, msg, level === 'error' ? err : undefined)
  }

  debug(msg: string): void {
    this.log('debug', msg)
  }
  info(msg: string): void {
    this.log('info', msg)
  }
  warn(msg: string): void {
    this.log('warn', msg)
  }
  error(msg: string, err?: unknown): void {
    this.log('error', msg, err)
  }
}
