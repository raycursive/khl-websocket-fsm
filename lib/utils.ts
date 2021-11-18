import { promisify } from 'util'
import { inflate as inflateRaw } from 'zlib'

export const backoffDelay = (factor: number, times: number, min: number, max: number): number => {
  return Math.min(min * Math.pow(factor, Math.max(times - 1, 0)), max)
}

export const inflate = promisify(inflateRaw)
