const STORAGE_KEY = 'aas_fingerprint_v1'

const getStored = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

const setStored = (value: string) => {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // ignore
  }
}

const isBrowser = () => typeof window !== 'undefined' && typeof navigator !== 'undefined'

const stableStringify = (value: unknown) => {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const hexFromBuffer = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

const djb2 = (input: string) => {
  let hash = 5381
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i)
  }
  return (hash >>> 0).toString(16)
}

const buildFingerprintSource = () => {
  if (!isBrowser()) return 'unknown'
  const nav: any = navigator
  const scr: any = window.screen
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      return ''
    }
  })()
  return stableStringify({
    ua: nav.userAgent,
    lang: nav.language,
    langs: nav.languages,
    platform: nav.platform,
    vendor: nav.vendor,
    hc: nav.hardwareConcurrency,
    dm: nav.deviceMemory,
    mtp: nav.maxTouchPoints,
    tz,
    tzOffset: new Date().getTimezoneOffset(),
    screen: {
      w: scr?.width,
      h: scr?.height,
      aw: scr?.availWidth,
      ah: scr?.availHeight,
      cd: scr?.colorDepth,
      pd: scr?.pixelDepth,
      dpr: window.devicePixelRatio
    }
  })
}

let fingerprintPromise: Promise<string> | null = null

export const getFingerprintId = async (): Promise<string> => {
  if (fingerprintPromise) return fingerprintPromise

  fingerprintPromise = (async () => {
    const existing = getStored()
    if (existing) return existing

    const source = buildFingerprintSource()
    let id: string

    try {
      if (isBrowser() && window.crypto?.subtle) {
        const data = new TextEncoder().encode(source)
        const digest = await window.crypto.subtle.digest('SHA-256', data)
        id = `fp_${hexFromBuffer(digest).slice(0, 32)}`
      } else {
        id = `fp_${djb2(source)}`
      }
    } catch {
      id = `fp_${djb2(source)}`
    }

    setStored(id)
    return id
  })()

  return fingerprintPromise
}

