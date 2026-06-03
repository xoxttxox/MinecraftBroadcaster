import fs from 'fs'
import path from 'path'
import { gzipSync } from 'node:zlib'

let logsDir = ''
let midnightTimer: ReturnType<typeof setTimeout> | null = null

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Local calendar date `yyyy-MM-dd` (Log4j `%d{yyyy-MM-dd}`). */
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function formatTimeFile(d: Date): string {
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${ms}`
}

/** Next archive index for `logs/{dateKey}-N.log.gz` (N starts at 1). */
function nextArchiveIndex(dir: string, dateKey: string): number {
  const prefix = `${dateKey}-`
  const suffix = '.log.gz'
  let max = 0
  let entries: string[] = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return 1
  }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue
    const mid = name.slice(prefix.length, -suffix.length)
    const n = parseInt(mid, 10)
    if (!Number.isNaN(n) && n > max) max = n
  }
  return max + 1
}

function gzipFileTo(srcPath: string, archivePath: string): void {
  const raw = fs.readFileSync(srcPath)
  const gz = gzipSync(raw)
  fs.writeFileSync(archivePath, gz)
  fs.unlinkSync(srcPath)
}

function rollLatestToGzip(dateKey: string): void {
  const latestPath = path.join(logsDir, 'latest.log')
  if (!fs.existsSync(latestPath)) return
  const st = fs.statSync(latestPath)
  if (st.size === 0) {
    fs.unlinkSync(latestPath)
    return
  }

  const i = nextArchiveIndex(logsDir, dateKey)
  const archivePath = path.join(logsDir, `${dateKey}-${i}.log.gz`)
  gzipFileTo(latestPath, archivePath)
}

function msUntilNextMidnight(): number {
  const now = new Date()
  const next = new Date(now)
  next.setDate(next.getDate() + 1)
  next.setHours(0, 0, 0, 0)
  return Math.max(1, next.getTime() - now.getTime())
}

function scheduleMidnightRotation(): void {
  if (midnightTimer !== null) clearTimeout(midnightTimer)
  midnightTimer = setTimeout(() => {
    midnightTimer = null
    rotateAtMidnight()
    scheduleMidnightRotation()
  }, msUntilNextMidnight())
}

/** Archive “yesterday” at local midnight (time-based policy). */
function rotateAtMidnight(): void {
  if (!logsDir) return
  try {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    rollLatestToGzip(localDateKey(yesterday))
  } catch (e) {
    console.error('[logs] midnight rotation failed', e)
  }
}

/** Log4j {@code OnStartupTriggeringPolicy}: roll non-empty {@code latest.log}. */
function rotateOnStartup(): void {
  const latestPath = path.join(logsDir, 'latest.log')
  if (!fs.existsSync(latestPath)) return
  const st = fs.statSync(latestPath)
  if (st.size === 0) return
  try {
    const d = new Date(st.mtimeMs)
    rollLatestToGzip(localDateKey(d))
  } catch (e) {
    console.error('[logs] startup rotation failed', e)
  }
}

/**
 * Matches standalone {@code log4j2.xml}: {@code logs/latest.log}, rolled to
 * {@code logs/yyyy-MM-dd-%i.log.gz} with time-based + startup policies.
 */
export function initFileLogging(dir: string): void {
  logsDir = path.resolve(dir)
  fs.mkdirSync(logsDir, { recursive: true })
  rotateOnStartup()
  scheduleMidnightRotation()
}

/**
 * File line mirrors Java file appender:
 * {@code [%d{HH:mm:ss.SSS} %t/%level] %msg%n} with thread {@code main}.
 */
export function appendFileLogLine(level: string, prefix: string, message: string, err?: unknown): void {
  if (!logsDir) return
  const ts = formatTimeFile(new Date())
  const prefixPart = prefix ? `[${prefix}] ` : ''
  let body = `${prefixPart}${message}`
  if (err !== undefined) {
    if (err instanceof Error) {
      body += err.stack ? `\n${err.stack}` : ` ${err.message}`
    } else {
      body += ` ${String(err)}`
    }
  }
  const line = `[${ts} main/${level.toUpperCase()}] ${body}`
  try {
    fs.appendFileSync(path.join(logsDir, 'latest.log'), `${line}\n`, 'utf8')
  } catch (e) {
    console.error('[logs] write failed', e)
  }
}
