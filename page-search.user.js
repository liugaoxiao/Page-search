// ==UserScript==
// @name 页面关键字搜索
// @description 页面关键字搜索 + 网页全局翻译：高亮、结果列表、多关键字、正则、快捷键、整页/双语对照翻译与可调磨砂玻璃 UI。
// @match *://*/*
// @run-at document-end
// @grant GM.log
// @grant GM.getValue
// @grant GM.setValue
// @grant GM.registerMenuCommand
// @grant GM.xmlHttpRequest
// @connect translate.googleapis.com
// @connect clients5.google.com
// @connect *
// ==/UserScript==

// @ts-nocheck

  declare const GM: {
  log?: (...args: any[]) => void
  getValue?: (key: string, defaultValue?: any) => any
  setValue?: (key: string, value: any) => any
  registerMenuCommand?: (name: string, callback: () => void) => void
  xmlHttpRequest?: (options: any) => Promise<any>
}

(() => {
  const ROOT_ID = "scripting-page-search-root"
  const QUICK_ID = "scripting-page-search-quick"
  const STYLE_ID = "scripting-page-search-style"
  const MARK_STYLE_ID = "scripting-page-search-mark-style"
  const MARK_CLASS = "scripting-page-search-mark"
  const ACTIVE_CLASS = "scripting-page-search-active"
  const STORAGE_KEY = "scripting-page-search-config-v4"
  const HISTORY_KEY = "scripting-page-search-history-v1"
  const STYLE_MIGRATED_KEY = "scripting-page-search-style-migrated-v1"
  const AUTO_TRANSLATE_KEY = "scripting-page-search-autotranslate-v1"
  const HISTORY_LIMIT = 20
  const RESULT_LIMIT = 100
  const TRANSLATE_LANGUAGES = [
    { code: "auto", name: "自动检测" },
    { code: "zh-CN", name: "中文（简体）" },
    { code: "zh-TW", name: "中文（繁体）" },
    { code: "en", name: "English" },
    { code: "ja", name: "日本語" },
    { code: "ko", name: "한국어" },
    { code: "fr", name: "Français" },
    { code: "de", name: "Deutsch" },
    { code: "es", name: "Español" },
    { code: "ru", name: "Русский" },
    { code: "it", name: "Italiano" },
    { code: "pt", name: "Português" },
    { code: "ar", name: "العربية" },
    { code: "th", name: "ไทย" },
    { code: "vi", name: "Tiếng Việt" },
  ]
  const TRANSLATE_SEGMENT_LIMIT = 1800
  // 节点上限放宽：用户要求整页内容全部翻译（AI 有会话缓存 + 分批限流控制成本）
  const TRANSLATE_NODE_LIMIT = 2000
  const TRANSLATE_PAGE_LIMIT = 5000
  const TRANSLATE_CONCURRENCY = 4
  const PS_TRANSLATION_CLASS = "scripting-page-search-translation"
  // AI 批次：条数与字符数双重限制（参考沉浸式翻译 maxTextLengthPerRequest）
  const AI_BATCH_SIZE = 15
  const AI_BATCH_CHARS = 1500
  const AI_BATCH_SEPARATOR = "\n%%\n"
  const AI_RETRY_TIMES = 2
  // 翻译持久缓存：按 目标语言::原文 存译文，刷新/跨站命中后零请求零 token 直接回显
  const TRANSLATION_CACHE_KEY = "scripting-page-search-translation-cache-v1"
  const TRANSLATION_CACHE_LIMIT = 1500

  const defaultConfig = {
    position: "bottom", // bottom | top | topbar
    caseSensitive: false,
    regex: false,
    multiKeyword: true,
    searchIframes: true,
    showResults: true,
    glass: true,
    opacity: 86,
    blur: 18,
    iconScale: 1,
    uiWidthScale: 1,
    accentColor: "#2563eb",
    highlightColor: "#fde047",
    activeColor: "#fb923c",
    shortcutEnabled: true,
    shortcutKey: "k",
    quickMode: false, // 简介模式：点击图标滑出快捷按钮
    floatingPosition: null,
    translateTarget: "zh-CN",
    translateBilingual: false,
    bilingualStyle: "below", // below | underline | block | dashed | quote | none
    translateProgressToast: true,
    translateEngine: "auto", // auto | apple | google | bing | ai
    aiBaseUrl: "",
    aiApiKey: "",
    aiModel: "gpt-4o-mini",
  }

  let config = { ...defaultConfig }
  let history = []
  let matches = []
  let activeIndex = -1
  let keyword = ""

  function loadJson(key: string, fallback: any) {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)) } catch { return fallback }
  }

  function getUpdatedAt(value: any) {
    const updatedAt = Number(value?.updatedAt)
    return Number.isFinite(updatedAt) ? updatedAt : 0
  }

  async function loadStored(key: string, fallback: any) {
    const localValue = loadJson(key, null)
    try {
      if (GM.getValue) {
        const value = await GM.getValue(key, null)
        const gmValue = typeof value === "string" ? JSON.parse(value) : value
        if (gmValue != null) return localValue != null && getUpdatedAt(localValue) > getUpdatedAt(gmValue) ? localValue : gmValue
      }
    } catch {}
    return localValue ?? fallback
  }

  const SAVE_DEBOUNCE_MS = 120
  const pendingStoredSaves = new Map<string, { value: any; timer: number | null }>()

  function persistStored(key: string, value: any) {
    try {
      const result = GM.setValue?.(key, value)
      if (result?.catch) result.catch(() => {})
    } catch {}
  }

  function flushStored(key?: string) {
    const entries = key ? [[key, pendingStoredSaves.get(key)] as const] : Array.from(pendingStoredSaves.entries())
    entries.forEach(([itemKey, pending]) => {
      if (!pending) return
      if (pending.timer != null) clearTimeout(pending.timer)
      pendingStoredSaves.delete(itemKey)
      persistStored(itemKey, pending.value)
    })
  }

  function saveStored(key: string, value: any) {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
    const previous = pendingStoredSaves.get(key)
    if (previous?.timer != null) clearTimeout(previous.timer)
    const timer = window.setTimeout(() => flushStored(key), SAVE_DEBOUNCE_MS)
    pendingStoredSaves.set(key, { value, timer })
  }

  function saveConfig(options: { renderSettings?: boolean; renderResults?: boolean } = {}) {
    config = normalizeConfig({ ...config, updatedAt: Date.now() })
    saveStored(STORAGE_KEY, config)
    applyAppearance()
    if (options.renderSettings !== false) renderSettings()
    if (options.renderResults !== false) renderResults()
  }

  function saveHistory() {
    history = normalizeHistory(history)
    saveStored(HISTORY_KEY, history)
    renderHistory()
  }

  // ── 本站自动翻译：激活时记住站点，跳转新页面自动续译；恢复原文/停止时移除 ──
  const getAutoTranslateSites = async (): Promise<string[]> => {
    const value = await loadStored(AUTO_TRANSLATE_KEY, [])
    return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : []
  }

  const addAutoTranslateSite = (host: string) => {
    if (!host) return
    void (async () => {
      try {
        const sites = await getAutoTranslateSites()
        if (!sites.includes(host)) saveStored(AUTO_TRANSLATE_KEY, [...sites, host])
      } catch {}
    })()
  }

  const removeAutoTranslateSite = (host: string) => {
    if (!host) return
    void (async () => {
      try {
        const sites = await getAutoTranslateSites()
        const next = sites.filter((item) => item !== host)
        if (next.length !== sites.length) saveStored(AUTO_TRANSLATE_KEY, next)
      } catch {}
    })()
  }

  // ── 翻译持久缓存（引擎无关：AI/Google/必应共用，按 目标语言+原文 命中）──
  let translationCache = new Map<string, string>()
  let translationCacheDirty = false
  let translationCacheFlushTimer: number | null = null

  const initTranslationCache = async () => {
    try {
      const stored = await loadStored(TRANSLATION_CACHE_KEY, [])
      if (Array.isArray(stored)) {
        translationCache = new Map(stored
          .filter((entry: any) => Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string")
          .slice(0, TRANSLATION_CACHE_LIMIT))
      }
    } catch {}
  }

  const cacheKeyFor = (target: string, text: string) => `${target}::${text}`
  const getCachedTranslation = (target: string, text: string) => translationCache.get(cacheKeyFor(target, text))

  const setCachedTranslation = (target: string, text: string, value: string) => {
    const source = String(text || "")
    const translated = String(value || "")
    // 与原文相同的结果不入缓存（失败兑底不会被误存成译文）
    if (!source || !translated || source.trim() === translated.trim()) return
    const key = cacheKeyFor(target, source)
    if (translationCache.has(key)) translationCache.delete(key)
    translationCache.set(key, translated)
    while (translationCache.size > TRANSLATION_CACHE_LIMIT) {
      const oldest = translationCache.keys().next().value
      if (oldest === undefined) break
      translationCache.delete(oldest)
    }
    translationCacheDirty = true
    if (translationCacheFlushTimer == null) {
      translationCacheFlushTimer = window.setTimeout(() => {
        translationCacheFlushTimer = null
        if (!translationCacheDirty) return
        translationCacheDirty = false
        saveStored(TRANSLATION_CACHE_KEY, Array.from(translationCache.entries()))
      }, 1500)
    }
  }

  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const escapeHtml = (value: string) => value
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;")

  const clampNumber = (value: any, min: number, max: number, fallback: number) => {
    const number = Number(value)
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
  }

  const isHexColor = (value: any) => /^#[0-9a-f]{6}$/i.test(String(value || ""))

  const normalizeConfig = (value: any = {}) => {
    const source = value && typeof value === "object" ? value : {}
    const next = { ...defaultConfig, ...source }
    if (!["bottom", "top", "topbar"].includes(next.position)) next.position = defaultConfig.position
    next.opacity = clampNumber(next.opacity, 0, 100, defaultConfig.opacity)
    next.blur = clampNumber(next.blur, 0, 35, defaultConfig.blur)
    next.iconScale = clampNumber(next.iconScale, 1, 2, defaultConfig.iconScale)
    next.uiWidthScale = clampNumber(next.uiWidthScale, 1, 2, defaultConfig.uiWidthScale)
    next.accentColor = isHexColor(next.accentColor) ? next.accentColor : defaultConfig.accentColor
    next.highlightColor = isHexColor(next.highlightColor) ? next.highlightColor : defaultConfig.highlightColor
    next.activeColor = isHexColor(next.activeColor) ? next.activeColor : defaultConfig.activeColor
    next.shortcutKey = (String(next.shortcutKey || defaultConfig.shortcutKey).slice(0, 1).toLowerCase() || defaultConfig.shortcutKey)
    next.floatingPosition = normalizeFloatingPosition(next.floatingPosition)
    if (!TRANSLATE_LANGUAGES.some((item) => item.code === next.translateTarget)) next.translateTarget = defaultConfig.translateTarget
    next.translateBilingual = !!next.translateBilingual
    if (!["below", "underline", "block", "dashed", "quote", "none"].includes(next.bilingualStyle)) next.bilingualStyle = defaultConfig.bilingualStyle
    next.translateProgressToast = next.translateProgressToast !== false
    if (!["auto", "edge", "apple", "google", "bing", "ai"].includes(next.translateEngine)) next.translateEngine = defaultConfig.translateEngine
    next.aiBaseUrl = String(next.aiBaseUrl || "").trim().replace(/\/+$/, "")
    next.aiApiKey = String(next.aiApiKey || "").trim()
    next.aiModel = String(next.aiModel || "").trim() || defaultConfig.aiModel
    ;["caseSensitive", "regex", "multiKeyword", "searchIframes", "showResults", "glass", "shortcutEnabled", "quickMode"].forEach((key) => { next[key] = !!next[key] })
    return next
  }

  const getViewportSize = () => {
    const visual = window.visualViewport
    return {
      width: Math.max(1, Math.round(visual?.width || window.innerWidth || document.documentElement.clientWidth || screen.width || 1)),
      height: Math.max(1, Math.round(visual?.height || window.innerHeight || document.documentElement.clientHeight || screen.height || 1)),
    }
  }

  const normalizeFloatingPosition = (position: any) => {
    if (!position || typeof position !== "object") return null
    const viewport = getViewportSize()
    const assumedWidth = clampNumber(position.width, 24, 520, 36)
    const assumedHeight = clampNumber(position.height, 24, 520, 36)
    const x = Number(position.x)
    const y = Number(position.y)
    const left = Number(position.left)
    const top = Number(position.top)
    const rawX = Number.isFinite(x) ? x : (Number.isFinite(left) ? left : 6)
    const rawY = Number.isFinite(y) ? y : (Number.isFinite(top) ? top : 6)
    const anchorX = position.anchorX === "right" || position.anchorX === "left"
      ? position.anchorX
      : (rawX + assumedWidth / 2 > viewport.width / 2 ? "right" : "left")
    const anchorY = position.anchorY === "bottom" || position.anchorY === "top"
      ? position.anchorY
      : (rawY + assumedHeight / 2 > viewport.height / 2 ? "bottom" : "top")
    const right = Number(position.right)
    const bottom = Number(position.bottom)
    return {
      x: rawX,
      y: rawY,
      left: Number.isFinite(left) ? left : rawX,
      top: Number.isFinite(top) ? top : rawY,
      right: Number.isFinite(right) ? right : Math.max(0, viewport.width - rawX - assumedWidth),
      bottom: Number.isFinite(bottom) ? bottom : Math.max(0, viewport.height - rawY - assumedHeight),
      width: assumedWidth,
      height: assumedHeight,
      vw: clampNumber(position.vw, 1, 10000, viewport.width),
      vh: clampNumber(position.vh, 1, 10000, viewport.height),
      anchorX,
      anchorY,
    }
  }

  const normalizeHistory = (items: any) => {
    const seen = new Set()
    return (Array.isArray(items) ? items : [])
      .map((item) => String(item || "").trim())
      .filter((item) => item && !seen.has(item) && seen.add(item))
      .slice(0, HISTORY_LIMIT)
  }

  const formatScale = (value: any) => `${clampNumber(value, 1, 2, 1).toFixed(2).replace(/\.00$/, "").replace(/0$/, "")}×`

  const getDocs = (includeIframes = config.searchIframes) => {
    const docs = [document]
    if (!includeIframes) return docs
    document.querySelectorAll("iframe, frame").forEach((frame) => {
      try {
        const doc = frame.contentDocument
        if (doc?.body) docs.push(doc)
      } catch {}
    })
    return docs
  }

  const getFrameForDoc = (doc: Document) => {
    if (doc === document) return null
    for (const frame of Array.from(document.querySelectorAll<HTMLIFrameElement | HTMLFrameElement>("iframe, frame"))) {
      try { if (frame.contentDocument === doc) return frame } catch {}
    }
    return null
  }

  // ===== 样式通道：CSP 兼容注入 =====
  // pay.openai.com 等 Stripe 托管页的 CSP 为 style-src 'self' …（无 unsafe-inline），页面运行时插入的
  // 内联 <style> 会被 WebKit 整块拒绝，设置面板/快捷栏因此失去全部样式而“散开”铺满页面。故按序尝试
  // 三条通道：1) 常规 <style>；2) constructable stylesheet（document.adoptedStyleSheets，纯 CSSOM 通道，
  // CSP 拦不住）；3) 极端兑底：用 CSSOM 属性赋值给关键元素内联最小可用样式。每条通道写入后都用探针
  // 元素实测规则是否真正生效，失败自动降级到下一条。
  const UI_PROBE_CLASS = "ps-styleprobe"
  const MARK_PROBE_CLASS = "ps-markstyleprobe"
  type StyleChannel = "style" | "adopted" | "inline"
  let uiStyleChannel: StyleChannel | null = null
  let inlineFallbackObserverStarted = false
  let inlineFallbackTimer: ReturnType<typeof setTimeout> | null = null
  const adoptedUiSheets = new WeakMap<Document, CSSStyleSheet>()
  const adoptedMarkSheets = new WeakMap<Document, CSSStyleSheet>()

  const cssomSheetsSupported = (doc: Document) => {
    try {
      const view = doc.defaultView
      if (!view || typeof (view as any).CSSStyleSheet !== "function") return false
      if (typeof (view as any).CSSStyleSheet.prototype.replaceSync !== "function") return false
      return "adoptedStyleSheets" in doc
    } catch { return false }
  }

  const styleProbeApplied = (doc: Document, probeClass: string) => {
    const view = doc.defaultView
    if (!view) return false
    const host = (doc === document ? root() : null) || doc.documentElement || doc.body
    if (!host) return false
    const probe = doc.createElement("div")
    probe.className = probeClass
    host.appendChild(probe)
    let position = ""
    try { position = view.getComputedStyle(probe).position } catch {}
    probe.remove()
    return position === "absolute"
  }

  const adoptSheet = (doc: Document, sheet: CSSStyleSheet, cache: WeakMap<Document, CSSStyleSheet>) => {
    const docAny = doc as any
    const current: CSSStyleSheet[] = Array.isArray(docAny.adoptedStyleSheets) ? Array.from(docAny.adoptedStyleSheets) : []
    if (!current.includes(sheet)) {
      current.push(sheet)
      docAny.adoptedStyleSheets = current
    }
    cache.set(doc, sheet)
  }

  const applyStylesheetWithFallback = (
    doc: Document,
    styleId: string,
    css: string,
    probeClass: string,
    options: { appendTo?: (d: Document) => Node | null; inlineApplier?: () => void; sheetCache?: WeakMap<Document, CSSStyleSheet> } = {},
  ): StyleChannel => {
    // 1) 常规内联 <style>（绝大多数页面可用，保持既有行为）
    let style = doc.getElementById(styleId) as HTMLStyleElement | null
    if (!style) {
      style = doc.createElement("style")
      style.id = styleId
      const target = options.appendTo ? options.appendTo(doc) : (doc.head || doc.documentElement)
      target?.appendChild(style)
    }
    style.textContent = css
    if (styleProbeApplied(doc, probeClass)) return "style"
    // 2) constructable stylesheet：CSSOM 对象不经过文档解析，页面 CSP 的 style-src 无法拦截
    if (cssomSheetsSupported(doc) && options.sheetCache) {
      try {
        const view = doc.defaultView as any
        let sheet = options.sheetCache.get(doc) || null
        if (!sheet) {
          sheet = new view.CSSStyleSheet()
          options.sheetCache.set(doc, sheet)
        }
        adoptSheet(doc, sheet, options.sheetCache)
        sheet.replaceSync(css)
        if (styleProbeApplied(doc, probeClass)) return "adopted"
      } catch {}
    }
    // 3) 极端兑底：逐元素内联关键样式（style 属性 CSSOM 赋值同样不受 CSP 限制）
    options.inlineApplier?.()
    return "inline"
  }

  const scheduleInlineFallback = () => {
    if (inlineFallbackTimer) clearTimeout(inlineFallbackTimer)
    inlineFallbackTimer = setTimeout(() => { inlineFallbackTimer = null; applyInlineUiFallback() }, 120)
  }

  // 内联兑底模式的持续保鲜：面板重渲染/类名切换/标记增删都会触发，防抖后重新套用关键样式
  const ensureInlineFallbackObserver = () => {
    if (inlineFallbackObserverStarted) return
    inlineFallbackObserverStarted = true
    new MutationObserver(scheduleInlineFallback).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] })
  }

  const setInlineStyles = (el: Element, declarations: Record<string, string>) => {
    const style = (el as HTMLElement).style
    for (const key of Object.keys(declarations)) (style as any)[key] = declarations[key]
  }

  const ensureDocStyle = (doc: Document) => {
    const channel = applyStylesheetWithFallback(
      doc,
      MARK_STYLE_ID,
      `
      .${MARK_PROBE_CLASS} { position: absolute !important; }
      .${MARK_CLASS} { padding: 0 1px; border-radius: 3px; background: ${config.highlightColor} !important; color: #111827 !important; }
      .${MARK_CLASS}.${ACTIVE_CLASS} { background: ${config.activeColor} !important; outline: 2px solid ${config.activeColor}; }
    `,
      MARK_PROBE_CLASS,
      { inlineApplier: () => applyInlineMarkFallback(doc), sheetCache: adoptedMarkSheets },
    )
    if (channel === "inline" && doc === document) ensureInlineFallbackObserver()
  }

  const root = () => document.getElementById(ROOT_ID)
  // light DOM 实现：iOS Safari 对 Shadow DOM 内部元素的点击/拖动不可靠，
  // 悬浮球必须与页面处于同一棵 DOM 树，否则放大镜无法点击、也无法拖动。
  const query = <T extends Element = Element>(selector: string) => root()?.querySelector<T>(selector) ?? null
  const queryAll = (selector: string) => root()?.querySelectorAll(selector) ?? []
  const input = () => query<HTMLInputElement>(".ps-input")
  const status = () => query<HTMLElement>(".ps-status")
  const setStatus = (text: string) => { const el = status(); if (el) el.textContent = text }

  const addStyle = () => {
    uiStyleChannel = applyStylesheetWithFallback(document, STYLE_ID, `
      .${UI_PROBE_CLASS} { position: absolute !important; }
      #${ROOT_ID} {
        position: fixed;
        right: 8px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color-scheme: light;
        --ps-accent: #2563eb;
        --ps-highlight: #fde047;
        --ps-active: #fb923c;
        --ps-panel-bg: rgba(255,255,255,.86);
        --ps-blur: 18px;
        --ps-input-font-size: 16px;
        --ps-ui-panel-width: 171px;
        --ps-ui-topbar-width: min(30.8vw, calc(var(--ps-ui-panel-width, 171px) * .66));
        --ps-ui-panel-padding: 5px;
        --ps-ui-title-font-size: 11px;
        --ps-ui-gap: 7px;
        --ps-ui-tab-width: 25px;
        --ps-ui-tab-height: 22px;
        --ps-ui-icon-size: 18px;
        --ps-ui-toggle-icon-size: 23px;
        --ps-ui-search-size: 28px;
        --ps-ui-nav-size: 27px;
        --ps-ui-input-pad-x: 6px;
        --ps-ui-input-extra-height: 11px;
        --ps-ui-status-font-size: 11px;
        --ps-ui-result-font-size: 11px;
        --ps-ui-setting-font-size: 11px;
        --ps-ui-range-width: 70px;
        transform: translate3d(0,0,0);
        will-change: left, top;
      }
      #${ROOT_ID}.ps-bottom { bottom: 56px; }
      #${ROOT_ID}.ps-top { top: 8px; }
      #${ROOT_ID}.ps-topbar { top: 5px; left: auto; right: 6px; width: var(--ps-ui-topbar-width, min(30.8vw, 113px)); }
      #${ROOT_ID}.ps-manual { right: auto; bottom: auto; }
      #${ROOT_ID} * { box-sizing: border-box; }
      #${ROOT_ID} button, #${ROOT_ID} label { -webkit-tap-highlight-color: transparent; }
      #${ROOT_ID} button { cursor: pointer; }
      #${ROOT_ID} .ps-toggle {
        width: 36px; height: 36px; border: 1px solid rgba(147, 197, 253, .45); border-radius: 999px;
        display: inline-flex; align-items: center; justify-content: center;
        background: rgba(255, 255, 255, .64); color: var(--ps-accent); font-size: 0;
        box-shadow: 0 6px 16px rgba(37, 99, 235, .16), inset 0 1px 0 rgba(255,255,255,.72);
        touch-action: none; -webkit-touch-callout: none; user-select: none; -webkit-user-select: none;
      }
      #${ROOT_ID}.ps-glass .ps-toggle { backdrop-filter: blur(var(--ps-blur)); -webkit-backdrop-filter: blur(var(--ps-blur)); }
      #${ROOT_ID} .ps-toggle svg { width: var(--ps-ui-toggle-icon-size, 23px) !important; min-width: var(--ps-ui-toggle-icon-size, 23px); height: var(--ps-ui-toggle-icon-size, 23px) !important; min-height: var(--ps-ui-toggle-icon-size, 23px); flex: 0 0 var(--ps-ui-toggle-icon-size, 23px); display: block !important; stroke: currentColor; transform: none !important; }
      #${ROOT_ID} .ps-toggle .ps-toggle-icon-quick { display: none !important; }
      /* 简介模式开启后图标固定为齿轮+对勾 */
      #${ROOT_ID}.ps-quick-mode .ps-toggle .ps-toggle-icon-search { display: none !important; }
      #${ROOT_ID}.ps-quick-mode .ps-toggle .ps-toggle-icon-quick { display: block !important; }
      #${ROOT_ID} .ps-toggle svg path { vector-effect: non-scaling-stroke; }
      #${ROOT_ID} .ps-toggle:active { transform: scale(.96); }
      #${ROOT_ID}.ps-topbar .ps-toggle { width: 100%; height: 30px; border-radius: 9px; }
      /* 翻译生效中：图标红色；进行中呼吸脉动 */
      #${ROOT_ID}.ps-translate-active .ps-toggle {
        background: #ef4444; color: #fff; border-color: rgba(239,68,68,.65);
        box-shadow: 0 6px 16px rgba(239,68,68,.3), inset 0 1px 0 rgba(255,255,255,.25);
      }
      #${ROOT_ID}.ps-translating .ps-toggle { animation: ps-translate-pulse 1.1s ease-in-out infinite; }
      @keyframes ps-translate-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.1); } }
      #${ROOT_ID} .ps-panel {
        display: none;
        flex-direction: column;
        width: min(var(--ps-ui-panel-width, 171px), calc(100vw - 12px)); max-height: min(var(--ps-available-panel-height, 56vh), 400px); overflow: hidden;
        padding: var(--ps-ui-panel-padding, 5px); border: 1px solid rgba(148, 163, 184, .38); border-radius: 10px;
        background: var(--ps-panel-bg); box-shadow: 0 8px 18px rgba(15, 23, 42, .2);
      }
      #${ROOT_ID}.ps-glass .ps-panel { backdrop-filter: blur(var(--ps-blur)); -webkit-backdrop-filter: blur(var(--ps-blur)); }
      #${ROOT_ID}.ps-topbar .ps-panel { width: 100%; max-height: min(var(--ps-available-panel-height, 50vh), 360px); }
      #${ROOT_ID}.ps-open .ps-toggle { display: none; }
      #${ROOT_ID}.ps-open .ps-panel { display: flex; }
      /* 简介模式 solo 面板：只显示单功能内容（隐藏标签栏，标题栏精简为仅关闭按钮，搜索页隐藏操作区/结果列表） */
      #${ROOT_ID}.ps-solo .ps-title { min-height: 0; margin-bottom: 0; }
      #${ROOT_ID}.ps-solo .ps-title > span:first-child { display: none; }
      #${ROOT_ID}.ps-solo .ps-close { position: static; margin-left: auto; }
      #${ROOT_ID}.ps-solo .ps-tabs { display: none; }
      #${ROOT_ID}.ps-solo[data-solo="search"] .ps-result-list { max-height: 110px; }
      #${ROOT_ID}.ps-solo[data-solo="settings"] .ps-panel { max-height: min(var(--ps-available-panel-height, 56vh), 400px); }
      /* 简介模式：快捷按钮浮层（独立 fixed 容器，避免 root 的 transform 影响定位） */
      #${QUICK_ID} {
        position: fixed; z-index: 2147483646; display: flex; align-items: center; gap: 6px;
        visibility: hidden; opacity: 0; transform: translateX(-18px);
        transition: opacity .18s ease, transform .22s cubic-bezier(.4,0,.6,1), visibility 0s linear .22s;
        pointer-events: none;
      }
      #${ROOT_ID}.ps-quick-on ~ #${QUICK_ID} {
        visibility: visible; opacity: 1; transform: translateX(0);
        transition: opacity .2s ease, transform .3s cubic-bezier(.22,1,.36,1);
        pointer-events: auto;
      }
      #${QUICK_ID} .ps-quick-btn {
        width: 36px; height: 36px; border: 1px solid rgba(147, 197, 253, .45); border-radius: 999px;
        display: inline-flex; align-items: center; justify-content: center; flex: 0 0 36px;
        background: rgba(255,255,255,.88); color: var(--ps-accent); box-shadow: 0 4px 12px rgba(15,23,42,.14);
      }
      #${ROOT_ID}.ps-quick-on ~ #${QUICK_ID} .ps-quick-btn:nth-child(1) { transition: transform .28s cubic-bezier(.22,1,.36,1); }
      #${ROOT_ID}.ps-quick-on ~ #${QUICK_ID} .ps-quick-btn:nth-child(2) { transition: transform .28s cubic-bezier(.22,1,.36,1) .04s; }
      #${ROOT_ID}.ps-quick-on ~ #${QUICK_ID} .ps-quick-btn:nth-child(3) { transition: transform .28s cubic-bezier(.22,1,.36,1) .08s; }
      #${QUICK_ID} .ps-quick-btn svg { width: 18px !important; min-width: 18px; height: 18px !important; min-height: 18px; display: block !important; stroke: currentColor; fill: none; transform: none !important; }
      #${QUICK_ID} .ps-quick-btn svg path { vector-effect: non-scaling-stroke; }
      /* 翻译激活时：翻译按钮变红并显示停止图标，点击恢复原文 */
      #${QUICK_ID} .ps-quick-translate .ps-qi-stop { display: none !important; }
      #${QUICK_ID} .ps-quick-translate.ps-on { background: #ef4444; color: #fff; border-color: rgba(239,68,68,.65); }
      #${QUICK_ID} .ps-quick-translate.ps-on .ps-qi-translate { display: none !important; }
      #${QUICK_ID} .ps-quick-translate.ps-on .ps-qi-stop { display: block !important; }
      #${QUICK_ID} .ps-quick-btn:active { transform: scale(.93); }
      #${ROOT_ID}.ps-glass ~ #${QUICK_ID} .ps-quick-btn { backdrop-filter: blur(var(--ps-blur)); -webkit-backdrop-filter: blur(var(--ps-blur)); }
      #${ROOT_ID} .ps-title { flex: 0 0 auto; position: relative; display: flex; align-items: center; justify-content: center; margin-bottom: var(--ps-ui-gap, 3px); min-height: calc(var(--ps-ui-tab-height, 22px) + 1px); color: #0f172a; font-size: var(--ps-ui-title-font-size, 11px); font-weight: 800; text-align: center; cursor: move; touch-action: none; -webkit-touch-callout: none; user-select: none; -webkit-user-select: none; }
      #${ROOT_ID} .ps-title > span:first-child { flex: 0 1 auto; min-width: 0; padding: 3px 24px; text-align: center; }
      #${ROOT_ID} .ps-close { position: absolute; right: 0; top: 2px; width: calc(var(--ps-ui-tab-height, 22px) - 2px); height: calc(var(--ps-ui-tab-height, 22px) - 2px); border: 0; border-radius: 999px; background: rgba(241,245,249,.9); color: #334155; font-size: var(--ps-ui-title-font-size, 11px); line-height: 1; }
      #${ROOT_ID} .ps-tabs { flex: 0 0 auto; display: flex; justify-content: space-evenly; gap: 0; padding: 2px; margin-bottom: var(--ps-ui-gap, 3px); border-radius: 8px; background: rgba(241,245,249,.82); }
      #${ROOT_ID} .ps-tab { flex: 1 1 0; width: auto; height: var(--ps-ui-tab-height, 22px); padding: 0; border: 0; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; background: transparent; color: #475569; }
      #${ROOT_ID} .ps-tab.ps-active { background: rgba(255,255,255,.92); color: var(--ps-accent); box-shadow: 0 1px 2px rgba(15,23,42,.08); }
      #${ROOT_ID} .ps-tab svg, #${ROOT_ID} .ps-search svg, #${ROOT_ID} .ps-nav svg { width: var(--ps-ui-icon-size, 14px) !important; min-width: var(--ps-ui-icon-size, 14px); height: var(--ps-ui-icon-size, 14px) !important; min-height: var(--ps-ui-icon-size, 14px); flex: 0 0 var(--ps-ui-icon-size, 14px); display: block !important; stroke: currentColor; fill: none; transform: none !important; }
      #${ROOT_ID} .ps-tab svg path, #${ROOT_ID} .ps-search svg path, #${ROOT_ID} .ps-nav svg path { vector-effect: non-scaling-stroke; }
      #${ROOT_ID} .ps-page { display: none; min-height: 0; overflow: auto; -webkit-overflow-scrolling: touch; }
      #${ROOT_ID} .ps-page.ps-active { display: block; flex: 1 1 auto; }
      #${ROOT_ID} .ps-row { display: flex; gap: var(--ps-ui-gap, 3px); margin-bottom: var(--ps-ui-gap, 3px); }
      #${ROOT_ID} .ps-search-row { justify-content: center; }
      #${ROOT_ID} .ps-search-row .ps-input { flex: 1 1 auto; width: auto; }
      #${ROOT_ID} .ps-actions { justify-content: space-evenly; gap: 0; }
      #${ROOT_ID} input[type="search"], #${ROOT_ID} input[type="text"] {
        flex: 1; min-width: 0; min-height: var(--ps-ui-search-size, 28px); height: calc(var(--ps-input-font-size, 16px) + var(--ps-ui-input-extra-height, 11px)); padding: 0 var(--ps-ui-input-pad-x, 6px); border: 1px solid #cbd5e1; border-radius: 8px;
        outline: none; background: rgba(255,255,255,.92); color: #0f172a; font-size: var(--ps-input-font-size, 16px); line-height: 1.2;
        -webkit-text-size-adjust: 100%;
      }
      #${ROOT_ID} input[type="search"]:focus, #${ROOT_ID} input[type="text"]:focus { border-color: var(--ps-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--ps-accent) 12%, transparent); }
      #${ROOT_ID} .ps-search { flex: 0 0 var(--ps-ui-search-size, 28px); width: var(--ps-ui-search-size, 28px); height: var(--ps-ui-search-size, 28px); padding: 0; border: 0; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; background: var(--ps-accent); color: white; }
      #${ROOT_ID} .ps-nav { flex: 0 0 var(--ps-ui-nav-size, 27px); min-width: 0; width: var(--ps-ui-nav-size, 27px); height: calc(var(--ps-ui-nav-size, 27px) - 2px); padding: 0; border: 0; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--ps-accent) 9%, white); color: var(--ps-accent); }
      #${ROOT_ID} .ps-clear { background: rgba(248,250,252,.9); color: #475569; }
      #${ROOT_ID} .ps-status { min-height: 14px; margin: 0 2px var(--ps-ui-gap, 3px); color: #64748b; font-size: var(--ps-ui-status-font-size, 11px); }
      #${ROOT_ID} .ps-status:empty { display: none; }
      #${ROOT_ID} .ps-result-list, #${ROOT_ID} .ps-history-list { display: none; max-height: 125px; overflow: auto; margin-top: var(--ps-ui-gap, 3px); border: 1px solid #e2e8f0; border-radius: 9px; background: rgba(248,250,252,.8); }
      #${ROOT_ID} .ps-result-list.ps-visible, #${ROOT_ID} .ps-history-list.ps-visible { display: block; }
      #${ROOT_ID} .ps-history-actions { justify-content: flex-end; margin-top: var(--ps-ui-gap, 3px); margin-bottom: 0; }
      #${ROOT_ID} .ps-result, #${ROOT_ID} .ps-history-item { width: 100%; display: block; padding: 6px 7px; border: 0; border-bottom: 1px solid #e2e8f0; background: transparent; color: #334155; text-align: left; line-height: 1.25; font-size: var(--ps-ui-result-font-size, 11px); }
      #${ROOT_ID} .ps-result:last-child, #${ROOT_ID} .ps-history-item:last-child { border-bottom: 0; }
      #${ROOT_ID} .ps-result.ps-current { background: color-mix(in srgb, var(--ps-accent) 14%, white); color: #1e3a8a; }
      #${ROOT_ID} .ps-result-index { font-weight: 900; margin-right: 3px; color: var(--ps-accent); }
      #${ROOT_ID} .ps-setting { display: flex; gap: 6px; align-items: center; justify-content: space-between; padding: 5px 1px; border-bottom: 1px solid #e2e8f0; color: #0f172a; font-size: var(--ps-ui-setting-font-size, 11px); }
      #${ROOT_ID} .ps-setting:last-child { border-bottom: 0; }
      #${ROOT_ID} .ps-setting small { display: block; margin-top: 1px; color: #64748b; font-size: calc(var(--ps-ui-setting-font-size, 11px) - 1px); line-height: 1.2; }
      #${ROOT_ID} input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--ps-accent); }
      #${ROOT_ID} input[type="color"] { width: 32px; height: 23px; border: 0; background: transparent; }
      #${ROOT_ID} input[type="range"] { width: var(--ps-ui-range-width, 70px); accent-color: var(--ps-accent); }
      #${ROOT_ID} select { height: var(--ps-ui-search-size, 28px); padding: 0 5px; border-radius: 7px; border: 1px solid #cbd5e1; background: rgba(255,255,255,.92); color: #0f172a; font-size: var(--ps-ui-setting-font-size, 11px); }
      #${ROOT_ID} .ps-reset-position { flex: 0 0 auto; width: auto; min-width: 52px; padding: 0 6px; font-size: calc(var(--ps-ui-setting-font-size, 11px) - 1px); font-weight: 800; }
      #${ROOT_ID} .ps-translate-actions { justify-content: space-evenly; gap: var(--ps-ui-gap, 3px); align-items: center; }
      #${ROOT_ID} .ps-translate-run { flex: 1 1 auto; width: auto; gap: 4px; font-size: var(--ps-ui-setting-font-size, 11px); font-weight: 700; }
      #${ROOT_ID} .ps-translate-run span { line-height: 1; }
      #${ROOT_ID} button:disabled { opacity: .45; pointer-events: none; }
      #${ROOT_ID} .ps-ai-config { margin-top: var(--ps-ui-gap, 3px); border: 1px solid #e2e8f0; border-radius: 9px; background: rgba(248,250,252,.8); overflow: hidden; }
      #${ROOT_ID} .ps-ai-toggle { width: 100%; padding: 6px 7px; border: 0; background: transparent; color: #334155; font-size: var(--ps-ui-setting-font-size, 11px); font-weight: 700; text-align: left; display: flex; justify-content: space-between; align-items: center; }
      #${ROOT_ID} .ps-ai-body { display: none; padding: 0 7px 7px; }
      #${ROOT_ID} .ps-ai-body .ps-setting { flex-direction: column; align-items: stretch; gap: 3px; }
      #${ROOT_ID} .ps-ai-body .ps-setting > span { display: block; }
      #${ROOT_ID} .ps-ai-body input[type="text"], #${ROOT_ID} .ps-ai-body input[type="password"] { width: 100%; min-height: 26px; height: 26px; font-size: var(--ps-ui-setting-font-size, 11px); }
      #${ROOT_ID} .ps-ai-test { flex: 1 1 auto; width: auto; font-size: calc(var(--ps-ui-setting-font-size, 11px) - 1px); font-weight: 700; }
      #${ROOT_ID} .ps-ai-test-result:empty { display: none; }
      #${ROOT_ID} .ps-model-pick { margin-right: 8px; }
      .${MARK_CLASS} { padding: 0 1px; border-radius: 3px; background: var(--ps-highlight, #fde047) !important; color: #111827 !important; }
      .${MARK_CLASS}.${ACTIVE_CLASS} { background: var(--ps-active, #fb923c) !important; outline: 2px solid var(--ps-active, #ea580c); }
      /* 译文样式：独立下方（默认，译文单独一行显示在原文下方） */
      .${PS_TRANSLATION_CLASS}.ps-style-below { display: block; margin: 4px 0 1px; padding: 0; font-size: .84em; line-height: 1.5; color: #64748b; word-break: break-word; -webkit-text-decoration: none; text-decoration: none; }
      /* 译文样式：下划线（内联，不撑布局） */
      .${PS_TRANSLATION_CLASS} { font-size: .88em; line-height: inherit; color: #475569; -webkit-text-decoration: underline dashed rgba(100,116,139,.55) 1px; text-decoration: underline dashed rgba(100,116,139,.55) 1px; text-underline-offset: 3px; }
      .${PS_TRANSLATION_CLASS}.ps-style-none { font-size: 1em; color: inherit; -webkit-text-decoration: none; text-decoration: none; }
      /* 译文样式：整块（独占一行，间距最大） */
      .${PS_TRANSLATION_CLASS}.ps-style-block { display: block; margin: 3px 0 2px; padding-left: 8px; border-left: 3px solid rgba(37,99,235,.35); word-break: break-word; -webkit-text-decoration: none; text-decoration: none; }
      /* 译文样式：虚线框 */
      .${PS_TRANSLATION_CLASS}.ps-style-dashed { padding: 0 3px; border: 1px dashed rgba(100,116,139,.6); border-radius: 3px; -webkit-text-decoration: none; text-decoration: none; }
      /* 译文样式：引用色 */
      .${PS_TRANSLATION_CLASS}.ps-style-quote { color: #2563eb; -webkit-text-decoration: none; text-decoration: none; }
      /* 翻译进度提示（页面角落） */
      #scripting-page-search-translate-progress { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 2147483647; padding: 5px 12px; border-radius: 999px; background: rgba(15,23,42,.82); color: #fff; font-size: 12px; line-height: 1.5; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity .25s ease; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
      #scripting-page-search-translate-progress.ps-visible { opacity: 1; }
    `, UI_PROBE_CLASS, { appendTo: (doc) => doc.documentElement, inlineApplier: applyInlineUiFallback, sheetCache: adoptedUiSheets })
    if (uiStyleChannel === "inline") ensureInlineFallbackObserver()
  }

  // 内联兑底：给高亮标记设置关键样式（主文档与 iframe 文档各自调用）
  const applyInlineMarkFallback = (doc: Document) => {
    const highlight = config.highlightColor || "#fde047"
    const active = config.activeColor || "#fb923c"
    doc.querySelectorAll("." + MARK_CLASS).forEach((mark) => {
      const isActive = mark.classList.contains(ACTIVE_CLASS)
      setInlineStyles(mark, {
        padding: "0 1px",
        borderRadius: "3px",
        background: isActive ? active : highlight,
        color: "#111827",
        outline: isActive ? `2px solid ${active}` : "none",
      })
    })
  }

  // 极端兑底：<style> 与 constructable 通道全部失效时（老系统 + 严格 CSP），用 CSSOM 属性赋值
  // 给关键元素内联最小可用样式，保证 UI 收拢为可交互浮层，而不是散开铺满页面。
  const applyInlineUiFallback = () => {
    const el = root()
    if (!el) return
    const isOpen = el.classList.contains("ps-open")
    const translating = el.classList.contains("ps-translate-active")
    const rootDeclarations: Record<string, string> = {
      position: "fixed", right: "8px", bottom: "56px", zIndex: "2147483647",
      maxWidth: "calc(100vw - 12px)", color: "#0f172a",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontSize: "12px", lineHeight: "1.4", boxSizing: "border-box", transform: "none",
    }
    if (isOpen) {
      Object.assign(rootDeclarations, {
        width: "171px", padding: "6px", borderRadius: "12px",
        border: "1px solid rgba(148,163,184,.38)", background: "rgba(255,255,255,.94)",
        boxShadow: "0 8px 18px rgba(15,23,42,.2)",
      })
    } else {
      Object.assign(rootDeclarations, { width: "auto", padding: "0", border: "none", background: "transparent", boxShadow: "none" })
    }
    if (el.classList.contains("ps-top")) { rootDeclarations.top = "8px"; rootDeclarations.bottom = "auto" }
    else if (el.classList.contains("ps-topbar")) { rootDeclarations.top = "5px"; rootDeclarations.bottom = "auto"; rootDeclarations.left = "auto"; rootDeclarations.right = "6px"; rootDeclarations.width = "min(30.8vw, 113px)" }
    setInlineStyles(el, rootDeclarations)
    queryAll(".ps-toggle").forEach((toggle) => setInlineStyles(toggle, {
      display: isOpen ? "none" : "inline-flex",
      width: "36px", height: "36px", borderRadius: "999px",
      border: "1px solid rgba(147,197,253,.45)", alignItems: "center", justifyContent: "center",
      background: translating ? "#ef4444" : "rgba(255,255,255,.64)",
      color: translating ? "#fff" : "#2563eb",
    }))
    queryAll(".ps-panel").forEach((panel) => setInlineStyles(panel, {
      display: isOpen ? "flex" : "none",
      flexDirection: "column", overflow: "hidden", width: "100%",
      maxHeight: "min(56vh, 400px)", boxSizing: "border-box",
    }))
    // 通用按钮基础样式必须先于下面各专用样式执行，否则会覆盖关闭/标签按钮的配色
    queryAll("button").forEach((button) => setInlineStyles(button, {
      borderRadius: "7px", border: "0", padding: "4px 8px", background: "#2563eb",
      color: "#fff", fontSize: "11px", fontWeight: "700", cursor: "pointer",
    }))
    queryAll(".ps-ai-body").forEach((body) => { if (!body.style.display) setInlineStyles(body, { display: "none" }) })
    queryAll(".ps-title").forEach((title) => setInlineStyles(title, {
      display: "flex", alignItems: "center", justifyContent: "center", position: "relative",
      minHeight: "23px", marginBottom: "3px", fontSize: "11px", fontWeight: "800", color: "#0f172a",
    }))
    queryAll(".ps-close").forEach((button) => setInlineStyles(button, {
      position: "absolute", right: "0", top: "2px", width: "20px", height: "20px",
      border: "0", borderRadius: "999px", background: "rgba(241,245,249,.9)", color: "#334155",
    }))
    queryAll(".ps-tabs").forEach((tabs) => setInlineStyles(tabs, {
      display: "flex", justifyContent: "space-evenly", padding: "2px", marginBottom: "3px",
      borderRadius: "8px", background: "rgba(241,245,249,.82)",
    }))
    queryAll(".ps-tab").forEach((tab) => setInlineStyles(tab, {
      flex: "1 1 0", height: "22px", border: "0", display: "inline-flex",
      alignItems: "center", justifyContent: "center",
      background: tab.classList.contains("ps-active") ? "rgba(255,255,255,.92)" : "transparent",
      color: tab.classList.contains("ps-active") ? "#2563eb" : "#475569",
    }))
    queryAll(".ps-page").forEach((page) => setInlineStyles(page, {
      display: page.classList.contains("ps-active") ? "block" : "none",
      overflow: "auto", minHeight: "0",
    }))
    queryAll(".ps-row").forEach((row) => setInlineStyles(row, {
      display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px", marginBottom: "4px",
    }))
    queryAll(".ps-setting").forEach((row) => setInlineStyles(row, {
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px",
      padding: "5px 1px", borderBottom: "1px solid #e2e8f0", fontSize: "11px",
    }))
    queryAll(".ps-result-list, .ps-history-list").forEach((list) => setInlineStyles(list, {
      display: list.classList.contains("ps-visible") ? "block" : "none",
      maxHeight: "125px", overflow: "auto", border: "1px solid #e2e8f0", borderRadius: "9px",
      background: "rgba(248,250,252,.8)",
    }))
    queryAll(".ps-status").forEach((statusEl) => setInlineStyles(statusEl, { color: "#64748b", fontSize: "11px", minHeight: "14px" }))
    queryAll("input[type=text], input[type=search], input[type=password]").forEach((field) => setInlineStyles(field, {
      flex: "1 1 auto", minWidth: "0", height: "28px", padding: "0 6px",
      border: "1px solid #cbd5e1", borderRadius: "8px", background: "rgba(255,255,255,.92)",
      color: "#0f172a", fontSize: "16px",
    }))
    queryAll("input[type=checkbox]").forEach((box) => setInlineStyles(box, { width: "16px", height: "16px" }))
    queryAll("input[type=range]").forEach((range) => setInlineStyles(range, { width: "70px" }))
    queryAll("select").forEach((select) => setInlineStyles(select, {
      height: "28px", padding: "0 5px", borderRadius: "7px", border: "1px solid #cbd5e1",
      background: "rgba(255,255,255,.92)", color: "#0f172a", fontSize: "11px",
    }))
    queryAll("svg").forEach((svg) => setInlineStyles(svg, {
      width: "18px", height: "18px", minWidth: "18px", minHeight: "18px",
      display: "block", stroke: "currentColor", fill: "none",
    }))
    // 译文与进度提示：这些元素在页面正文里，样式通道失效时一并兑底
    queryAll("." + PS_TRANSLATION_CLASS).forEach((span) => {
      const below = span.classList.contains("ps-style-below")
      const block = span.classList.contains("ps-style-block")
      const plain = span.classList.contains("ps-style-none")
      setInlineStyles(span, {
        display: below || block ? "block" : "inline",
        margin: below ? "4px 0 1px" : block ? "3px 0 2px" : "0",
        paddingLeft: block ? "8px" : "0",
        borderLeft: block ? "3px solid rgba(37,99,235,.35)" : "none",
        color: below ? "#64748b" : plain ? "inherit" : "#475569",
        fontSize: plain ? "1em" : "0.88em",
        wordBreak: "break-word",
        textDecoration: plain || below || block ? "none" : "underline dashed rgba(100,116,139,.55) 1px",
      })
    })
    const progress = document.getElementById("scripting-page-search-translate-progress")
    if (progress) setInlineStyles(progress, {
      position: "fixed", left: "50%", bottom: "20px", transform: "translateX(-50%)",
      zIndex: "2147483647", padding: "5px 12px", borderRadius: "999px",
      background: "rgba(15,23,42,.82)", color: "#fff", fontSize: "12px",
      whiteSpace: "nowrap", pointerEvents: "none",
      opacity: progress.classList.contains("ps-visible") ? "1" : "0",
    })
    // 快捷栏浮层：内联模式无法用 sibling 选择器，直接按 ps-quick-on 状态显隐
    const quick = document.getElementById(QUICK_ID)
    if (quick) {
      const quickOn = el.classList.contains("ps-quick-on")
      setInlineStyles(quick, {
        position: "fixed", right: "8px", bottom: "104px", zIndex: "2147483646",
        display: "flex", alignItems: "center", gap: "6px",
        visibility: quickOn ? "visible" : "hidden", opacity: quickOn ? "1" : "0",
        pointerEvents: quickOn ? "auto" : "none",
      })
      quick.querySelectorAll(".ps-quick-btn").forEach((button) => {
        const on = button.classList.contains("ps-on")
        setInlineStyles(button, {
          width: "36px", height: "36px", flex: "0 0 36px", display: "inline-flex",
          alignItems: "center", justifyContent: "center", borderRadius: "999px",
          border: "1px solid rgba(147,197,253,.45)",
          background: on ? "#ef4444" : "rgba(255,255,255,.88)",
          color: on ? "#fff" : "#2563eb",
        })
        const translateIcon = button.querySelector(".ps-qi-translate")
        const stopIcon = button.querySelector(".ps-qi-stop")
        if (translateIcon) (translateIcon as HTMLElement).style.display = on ? "none" : "block"
        if (stopIcon) (stopIcon as HTMLElement).style.display = on ? "block" : "none"
      })
    }
    applyInlineMarkFallback(document)
  }

  const getFloatingMetrics = () => {
    const el = root()
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return {
      width: Math.max(rect.width || 36, 36),
      height: Math.max(rect.height || 36, 36),
      viewport: getViewportSize(),
      margin: 6,
    }
  }

  const clampFloatingPosition = (position) => {
    const metrics = getFloatingMetrics()
    if (!metrics || !position) return null
    const { width, height, viewport, margin } = metrics
    return {
      x: Math.min(Math.max(Number(position.x) || margin, margin), Math.max(margin, viewport.width - width - margin)),
      y: Math.min(Math.max(Number(position.y) || margin, margin), Math.max(margin, viewport.height - height - margin)),
    }
  }

  const resolveFloatingPosition = (position) => {
    const metrics = getFloatingMetrics()
    if (!metrics || !position) return null
    const saved = normalizeFloatingPosition(position)
    if (!saved) return null
    const { width, height, viewport, margin } = metrics
    const anchorX = saved.anchorX === "right" || saved.anchorX === "left" ? saved.anchorX : "left"
    const anchorY = saved.anchorY === "bottom" || saved.anchorY === "top" ? saved.anchorY : "top"
    const x = anchorX === "right" ? viewport.width - width - Number(saved.right || 0) : Number(saved.left ?? saved.x)
    const y = anchorY === "bottom" ? viewport.height - height - Number(saved.bottom || 0) : Number(saved.top ?? saved.y)
    return clampFloatingPosition({ x, y })
  }

  const createFloatingPositionSnapshot = (position) => {
    const pos = clampFloatingPosition(position)
    const metrics = getFloatingMetrics()
    if (!pos || !metrics) return null
    const { width, height, viewport } = metrics
    const anchorX = pos.x + width / 2 > viewport.width / 2 ? "right" : "left"
    const anchorY = pos.y + height / 2 > viewport.height / 2 ? "bottom" : "top"
    return {
      x: pos.x,
      y: pos.y,
      left: pos.x,
      top: pos.y,
      right: Math.max(0, viewport.width - pos.x - width),
      bottom: Math.max(0, viewport.height - pos.y - height),
      width,
      height,
      vw: viewport.width,
      vh: viewport.height,
      anchorX,
      anchorY,
    }
  }

  const clampToViewport = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))

  const getVisibleViewportRect = () => {
    const viewport = window.visualViewport
    return {
      left: Math.round(viewport?.offsetLeft || 0),
      top: Math.round(viewport?.offsetTop || 0),
      width: Math.max(1, Math.round(viewport?.width || window.innerWidth || document.documentElement.clientWidth || 1)),
      height: Math.max(1, Math.round(viewport?.height || window.innerHeight || document.documentElement.clientHeight || 1)),
    }
  }

  const keepPanelInVisibleViewport = () => {
    const el = root()
    if (!el) return
    const visible = getVisibleViewportRect()
    const margin = 8
    el.style.setProperty("--ps-available-panel-height", `${Math.max(140, visible.height - margin * 2)}px`)
    const isEditingSearch = document.activeElement === input()
    const isOpen = el.classList.contains("ps-open")
    if (!isEditingSearch || !isOpen) return
    const rect = el.getBoundingClientRect()
    const maxLeft = visible.left + visible.width - rect.width - margin
    const maxTop = visible.top + visible.height - rect.height - margin
    const nextLeft = clampToViewport(rect.left, visible.left + margin, maxLeft)
    const nextTop = clampToViewport(rect.top, visible.top + margin, maxTop)
    if (Math.abs(nextLeft - rect.left) < 1 && Math.abs(nextTop - rect.top) < 1) return
    el.style.left = `${nextLeft}px`
    el.style.top = `${nextTop}px`
    el.style.right = "auto"
    el.style.bottom = "auto"
    el.classList.add("ps-manual")
  }

  const applyAppearance = () => {
    const el = root()
    if (!el) return
    updateZoomCompensation()
    // 简介模式：即使设置了顶部搜索条也按圆形悬浮按钮显示，避免与 topbar 全宽布局冲突
    const isQuick = !!config.quickMode
    const position = isQuick && config.position === "topbar" ? "bottom" : config.position
    const manualPosition = position !== "topbar" ? resolveFloatingPosition(config.floatingPosition) : null
    el.classList.toggle("ps-quick-mode", isQuick)
    el.classList.toggle("ps-top", position === "top")
    el.classList.toggle("ps-topbar", position === "topbar")
    el.classList.toggle("ps-bottom", position === "bottom")
    el.classList.toggle("ps-manual", !!manualPosition)
    el.classList.toggle("ps-glass", !!config.glass)
    if (!isQuick) el.classList.remove("ps-quick-on")
    if (manualPosition) {
      el.style.left = `${manualPosition.x}px`
      el.style.top = `${manualPosition.y}px`
      el.style.right = "auto"
      el.style.bottom = "auto"
    } else {
      el.style.left = ""
      el.style.top = ""
      el.style.right = ""
      el.style.bottom = ""
    }
    el.style.setProperty("--ps-accent", config.accentColor)
    el.style.setProperty("--ps-highlight", config.highlightColor)
    el.style.setProperty("--ps-active", config.activeColor)
    el.style.setProperty("--ps-blur", `${config.blur}px`)
    el.style.setProperty("--ps-panel-bg", config.glass ? `rgba(255,255,255,${Number(config.opacity) / 100})` : "rgba(255,255,255,.98)")
    positionQuickBar()
    keepPanelInVisibleViewport()
  }

  // 简介模式：快捷按钮浮层定位在悬浮图标左侧、垂直居中
  const positionQuickBar = () => {
    const el = root()
    if (!el) return
    const bar = document.getElementById(QUICK_ID)
    const toggle = el.querySelector<HTMLElement>(".ps-toggle")
    if (!bar || !toggle) return
    if (!config.quickMode) { bar.style.left = ""; bar.style.top = ""; return }
    const toggleRect = toggle.getBoundingClientRect()
    const barWidth = bar.offsetWidth || 36 * 3 + 12
    let left = toggleRect.left - barWidth - 8
    if (left < 6) left = toggleRect.right + 8
    const top = toggleRect.top + toggleRect.height / 2 - 18
    bar.style.left = `${Math.round(left)}px`
    bar.style.top = `${Math.round(top)}px`
  }

  const SCALE_LIMITS = {
    minPageScale: 0.42,
    maxBoost: 2.15,
  }

  const clampPx = (value: number, min: number, max: number) => `${Math.min(max, Math.max(min, Math.round(value)))}px`

  const getPageZoomScale = () => {
    const viewport = window.visualViewport
    const layoutWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || screen.width || 1)
    const visibleWidth = Math.max(1, viewport?.width || layoutWidth)
    const screenWidth = Math.max(1, Math.min(Number(screen.width) || layoutWidth, Number(screen.availWidth) || layoutWidth))

    // Safari / desktop zoom usually changes layout viewport width; visualViewport covers pinch/page scale.
    const layoutScale = Math.min(1, screenWidth / layoutWidth)
    const visibleScale = Math.min(1, visibleWidth / layoutWidth)
    const viewportScale = Math.min(1, Number(viewport?.scale) || 1)
    const rawScale = Math.min(layoutScale, visibleScale, viewportScale)

    // Round tiny viewport noise to avoid constant CSS variable rewrites while scrolling/keyboard animating.
    return Math.max(SCALE_LIMITS.minPageScale, Math.min(1, Math.round(rawScale * 100) / 100))
  }

  const updateZoomCompensation = () => {
    const el = root()
    if (!el) return
    const pageScale = getPageZoomScale()
    const boost = Math.min(SCALE_LIMITS.maxBoost, 1 / pageScale)
    const iconScale = clampNumber(config.iconScale, 1, 2, 1)
    const widthScale = clampNumber(config.uiWidthScale, 1, 2, 1)
    const px = (base: number, max = Math.ceil(base * SCALE_LIMITS.maxBoost), multiplier = 1) => clampPx(base * boost * multiplier, base, max)
    const font = (base: number, max = Math.ceil(base * SCALE_LIMITS.maxBoost)) => clampPx(base * boost, base, max)

    el.style.setProperty("--ps-input-font-size", font(16, 36))
    el.style.setProperty("--ps-ui-panel-width", px(171, 520, widthScale))
    el.style.setProperty("--ps-ui-topbar-width", `min(92vw, ${px(113, 420, widthScale)})`)
    el.style.setProperty("--ps-ui-panel-padding", px(5, 11))
    el.style.setProperty("--ps-ui-title-font-size", font(11, 24))
    el.style.setProperty("--ps-ui-gap", px(7, 16))
    el.style.setProperty("--ps-ui-tab-width", px(25, 54))
    el.style.setProperty("--ps-ui-tab-height", px(22, 48))
    el.style.setProperty("--ps-ui-icon-size", px(18, 76, iconScale))
    el.style.setProperty("--ps-ui-toggle-icon-size", px(23, 92, iconScale))
    el.style.setProperty("--ps-ui-search-size", px(28, 60))
    el.style.setProperty("--ps-ui-nav-size", px(27, 58))
    el.style.setProperty("--ps-ui-input-pad-x", px(6, 14))
    el.style.setProperty("--ps-ui-input-extra-height", px(11, 24))
    el.style.setProperty("--ps-ui-status-font-size", font(11, 23))
    el.style.setProperty("--ps-ui-result-font-size", font(11, 23))
    el.style.setProperty("--ps-ui-setting-font-size", font(11, 23))
    el.style.setProperty("--ps-ui-range-width", px(70, 150))
  }

  let viewportMeta: HTMLMetaElement | null = null
  let viewportMetaContent: string | null = null
  let viewportMetaCreated = false

  const lockViewportZoom = () => {
    updateZoomCompensation()
    viewportMeta = document.querySelector('meta[name="viewport"]')
    viewportMetaCreated = !viewportMeta
    if (!viewportMeta) {
      viewportMeta = document.createElement("meta")
      viewportMeta.name = "viewport"
      document.head?.appendChild(viewportMeta)
    }
    viewportMetaContent = viewportMeta.getAttribute("content")
    const content = viewportMetaContent || "width=device-width, initial-scale=1"
    const parts = content.split(",").map((part) => part.trim()).filter((part) => part && !/^(maximum-scale|user-scalable)\s*=/i.test(part))
    parts.push("maximum-scale=1", "user-scalable=no")
    viewportMeta.setAttribute("content", parts.join(", "))
  }

  const unlockViewportZoom = () => {
    setTimeout(() => {
      if (document.activeElement === input()) return
      if (!viewportMeta) return
      if (viewportMetaCreated) viewportMeta.remove()
      else if (viewportMetaContent == null) viewportMeta.removeAttribute("content")
      else viewportMeta.setAttribute("content", viewportMetaContent)
      viewportMeta = null
      viewportMetaContent = null
      viewportMetaCreated = false
    }, 250)
  }

  const setupInputZoomGuard = (el: HTMLElement) => {
    el.addEventListener("focusin", (event) => {
      if (event.target instanceof HTMLInputElement && event.target.classList.contains("ps-input")) {
        lockViewportZoom()
        setTimeout(() => keepPanelInVisibleViewport(), 60)
        setTimeout(() => keepPanelInVisibleViewport(), 280)
      }
    })
    el.addEventListener("focusout", (event) => {
      if (event.target instanceof HTMLInputElement && event.target.classList.contains("ps-input")) {
        unlockViewportZoom()
        setTimeout(() => applyAppearance(), 320)
      }
    })
    window.visualViewport?.addEventListener("resize", applyAppearance)
    window.addEventListener("resize", applyAppearance)
  }

  const switchTab = (tab: string) => {
    queryAll(".ps-tab").forEach((button) => button.classList.toggle("ps-active", button.getAttribute("data-tab") === tab))
    queryAll(".ps-page").forEach((page) => page.classList.toggle("ps-active", page.getAttribute("data-page") === tab))
    if (tab === "settings") renderSettings()
    if (tab === "history") renderHistory()
    if (tab === "translate") renderTranslate()
  }

  const unwrapMark = (mark: HTMLElement) => {
    const doc = mark.ownerDocument
    const parent = mark.parentNode
    if (!parent) return
    parent.replaceChild(doc.createTextNode(mark.textContent ?? ""), mark)
    parent.normalize()
  }

  const isSearchableElement = (element: Element) => {
    // 跨 realm 兼容：iframe 文档的元素不属于主文档的 HTMLElement 原型链，
    // instanceof 恒为 false 会把同源 iframe 内容静默排除，改用 nodeType 判定
    if (!element || element.nodeType !== 1) return false
    let current: HTMLElement | null = element
    while (current && current !== current.ownerDocument.documentElement) {
      if (current.id === ROOT_ID || (current !== element && current.classList?.contains(MARK_CLASS))) return false
      if (current.hidden || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false
      const tag = current.tagName.toLowerCase()
      if (["script", "style", "noscript", "textarea", "input", "select", "option", "template"].includes(tag)) return false
      if (tag === "details" && !(current as HTMLDetailsElement).open && element !== current) return false
      const style = getComputedStyle(current)
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false
      current = current.parentElement
    }
    return true
  }

  const isVisible = (element: HTMLElement) => isSearchableElement(element)

  const shouldSkip = (node: Node) => {
    const parent = node.parentElement
    if (!parent) return true
    return !isSearchableElement(parent)
  }

  const isLocatableMark = (mark: HTMLElement) => {
    if (!mark.isConnected || !mark.ownerDocument.body?.contains(mark)) return false
    if (!isSearchableElement(mark)) return false
    const rects = Array.from(mark.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0)
    return rects.length > 0
  }

  const pruneMatches = () => {
    matches = matches.filter(isLocatableMark)
    if (!matches.length) activeIndex = -1
    else if (activeIndex >= matches.length) activeIndex = matches.length - 1
    else if (activeIndex < 0) activeIndex = 0
  }

  const clear = () => {
    getDocs(true).forEach((doc) => doc.querySelectorAll(`.${MARK_CLASS}`).forEach((mark) => {
      const parent = mark.parentNode
      if (!parent) return
      unwrapMark(mark as HTMLElement)
    }))
    matches = []
    activeIndex = -1
    keyword = ""
    renderResults()
  }

  const parseTerms = (value: string) => {
    if (config.regex || !config.multiKeyword) return [value]
    return value.split(/[，,\n]+|\s{2,}/).map((item) => item.trim()).filter(Boolean)
  }

  const buildMatchers = (value: string) => {
    const flags = config.caseSensitive ? "g" : "gi"
    return parseTerms(value).map((term) => ({ term, regExp: new RegExp(config.regex ? term : escapeRegExp(term), flags) }))
  }

  const textContains = (text: string, matcher) => {
    if (config.regex) { matcher.regExp.lastIndex = 0; return matcher.regExp.test(text) }
    return config.caseSensitive ? text.includes(matcher.term) : text.toLowerCase().includes(matcher.term.toLowerCase())
  }

  const highlightNode = (node: Text, matchers) => {
    const text = node.nodeValue ?? ""
    const ranges = []
    matchers.forEach((matcher, termIndex) => {
      matcher.regExp.lastIndex = 0
      let result
      while ((result = matcher.regExp.exec(text))) {
        if (!result[0]) { matcher.regExp.lastIndex += 1; continue }
        ranges.push({ start: result.index, end: result.index + result[0].length, termIndex, text: result[0] })
      }
    })
    ranges.sort((a, b) => a.start - b.start || b.end - a.end)
    const filtered = []
    let cursor = 0
    ranges.forEach((range) => {
      if (range.start >= cursor) { filtered.push(range); cursor = range.end }
    })
    if (!filtered.length) return

    const parent = node.parentNode
    if (!parent) return
    const fragment = node.ownerDocument.createDocumentFragment()
    const createdMarks: HTMLElement[] = []
    let lastIndex = 0
    filtered.forEach((range) => {
      if (range.start > lastIndex) fragment.appendChild(node.ownerDocument.createTextNode(text.slice(lastIndex, range.start)))
      const mark = node.ownerDocument.createElement("mark")
      mark.className = MARK_CLASS
      mark.textContent = text.slice(range.start, range.end)
      mark.dataset.term = String(range.termIndex)
      fragment.appendChild(mark)
      createdMarks.push(mark)
      lastIndex = range.end
    })
    if (lastIndex < text.length) fragment.appendChild(node.ownerDocument.createTextNode(text.slice(lastIndex)))
    parent.replaceChild(fragment, node)
    createdMarks.forEach((mark) => {
      if (isLocatableMark(mark)) matches.push(mark)
      else unwrapMark(mark)
    })
  }

  const getSnippet = (mark: HTMLElement) => {
    const text = (mark.parentElement?.textContent || mark.textContent || "").replace(/\s+/g, " ").trim()
    const selected = mark.textContent || ""
    const source = config.caseSensitive ? text : text.toLowerCase()
    const needle = config.caseSensitive ? selected : selected.toLowerCase()
    const index = source.indexOf(needle)
    if (index < 0) return text.slice(0, 96)
    const start = Math.max(0, index - 36)
    const end = Math.min(text.length, index + selected.length + 46)
    return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`
  }

  const addToHistory = (value: string) => {
    history = [value, ...history.filter((item) => item !== value)].slice(0, HISTORY_LIMIT)
    saveHistory()
  }

  const renderResults = () => {
    const list = query<HTMLElement>(".ps-result-list")
    if (!list) return
    pruneMatches()
    list.classList.toggle("ps-visible", config.showResults && matches.length > 0)
    if (!config.showResults || !matches.length) { list.innerHTML = ""; return }
    const max = Math.min(matches.length, RESULT_LIMIT)
    list.innerHTML = Array.from({ length: max }, (_, index) => `
      <button class="ps-result ${index === activeIndex ? "ps-current" : ""}" type="button" data-index="${index}">
        <span class="ps-result-index">${index + 1}.</span>${escapeHtml(getSnippet(matches[index]))}
      </button>
    `).join("") + (matches.length > max ? `<button class="ps-result" type="button" disabled>还有 ${matches.length - max} 个结果未显示</button>` : "")
  }

  const renderHistory = () => {
    const list = query<HTMLElement>(".ps-history-list")
    if (!list) return
    list.classList.toggle("ps-visible", history.length > 0)
    list.innerHTML = history.length ? history.map((item, index) => `
      <button class="ps-history-item" type="button" data-index="${index}">${escapeHtml(item)}</button>
    `).join("") : `<div class="ps-status">暂无搜索历史</div>`
  }

  // ── 网页全局翻译引擎 ────────────────────────────────────────
  // 支持双引擎：Apple（WebKit 私有 _appleTranslateBatch，iOS 17.4+ 网页内可用，无需联网接口）
  // 与 Google（translate_a/t 公开接口，走 GM.xmlHttpRequest 跨域）。
  // 翻译过的节点带 data-ps-translated 标记，恢复原文时直接还原 textContent。

  let translationRunning = false
  let translationCancelled = false
  let lastTranslationSummary = ""
  let translateProgress: { done: number; total: number; engineName: string } | null = null
  let translateProgressTimer: number | null = null
  // 持续翻译：激活后自动跟进页面新增/变化的文本
  let translationActive = false
  let translateObserver: MutationObserver | null = null
  let translatePendingNodes: Text[] = []
  let translatePendingTimer: number | null = null
  // 持续翻译的属性文案补翻防抖计时器
  let attrTranslateTimer: number | null = null

  // ── 引擎健康检测：连续全失败的引擎在自动链中临时跳过（冷却后自动重试，成功即恢复）──
  const AUTO_CHAIN = ["ai", "edge", "apple", "bing", "google"]
  const ENGINE_HEALTH_KEY = "scripting-page-search-engine-health-v1"
  const ENGINE_HEALTH_THRESHOLD = 2
  const ENGINE_HEALTH_COOLDOWN_MS = 10 * 60 * 1000
  let engineHealth: Record<string, { fails: number; lastError: string; disabledUntil: number }> = {}
  let engineHealthLoaded = false

  const loadEngineHealth = async () => {
    if (engineHealthLoaded) return
    engineHealthLoaded = true
    try {
      const stored = await loadStored(ENGINE_HEALTH_KEY, {})
      if (stored && typeof stored === "object") engineHealth = stored
    } catch {}
  }

  const recordEngineFailure = (engine: string, message: string) => {
    const state = engineHealth[engine] || { fails: 0, lastError: "", disabledUntil: 0 }
    state.fails += 1
    state.lastError = String(message || "").slice(0, 200)
    if (state.fails >= ENGINE_HEALTH_THRESHOLD) state.disabledUntil = Date.now() + ENGINE_HEALTH_COOLDOWN_MS
    engineHealth[engine] = state
    saveStored(ENGINE_HEALTH_KEY, engineHealth)
  }

  const recordEngineSuccess = (engine: string) => {
    if (!engineHealth[engine]) return
    delete engineHealth[engine]
    saveStored(ENGINE_HEALTH_KEY, engineHealth)
  }

  const engineTemporarilyDisabled = (engine: string) => {
    const state = engineHealth[engine]
    return !!state && !!state.disabledUntil && Date.now() <= state.disabledUntil
  }

  const engineHealthNote = (engine: string) => {
    const state = engineHealth[engine]
    if (!state || !state.disabledUntil || Date.now() > state.disabledUntil) return ""
    const minutes = Math.max(1, Math.round((state.disabledUntil - Date.now()) / 60000))
    return `连续失败，约 ${minutes} 分钟后自动重试`
  }

  const appleBridgeAvailable = () => typeof (document.documentElement as any)?._appleTranslateBatch === "function"
  const engineUsable = (engine: string) => {
    if (engine === "ai") return !!(config.aiBaseUrl && config.aiApiKey)
    if (engine === "apple") return appleBridgeAvailable()
    return true
  }

  // 显式选择的引擎不可用时必须回退，且把回退原因带给 UI 展示；自动档按健康状态跳过连续失败的引擎
  const resolveTranslateEngine = (): { engine: string; note: string } => {
    const preferred = config.translateEngine || "auto"
    if (preferred === "auto") {
      const skippedNotes: string[] = []
      for (const engine of AUTO_CHAIN) {
        if (!engineUsable(engine)) continue
        if (engineTemporarilyDisabled(engine)) {
          const note = engineHealthNote(engine)
          skippedNotes.push(`${getTranslateEngineName(engine)}（${note}）`)
          continue
        }
        return { engine, note: skippedNotes.join("；") }
      }
      return { engine: "bing", note: "没有可用引擎（AI 未配置且其他引擎连续失败被临时跳过）" }
    }
    if (preferred === "ai" && !engineUsable("ai")) return { engine: "edge", note: "AI 接口未配置" }
    if (preferred === "apple" && !engineUsable("apple")) return { engine: "edge", note: "Apple 翻译当前环境不可用" }
    return { engine: preferred, note: "" }
  }

  // 整页翻译的运行时回退顺序：首选引擎失败后按健康链自动换下一个，直到成功或全部失败（每个引擎只试一次，无循环）
  const getEngineRunOrder = (): string[] => {
    const preferred = config.translateEngine || "auto"
    const order: string[] = []
    const push = (engine: string) => {
      if (!order.includes(engine) && engineUsable(engine)) order.push(engine)
    }
    if (preferred === "auto") {
      for (const engine of AUTO_CHAIN) {
        if (engineTemporarilyDisabled(engine)) continue
        push(engine)
      }
    } else {
      // 手动选择的引擎始终第一个尝试（即使被临时标记），失败后按健康链自动回退
      push(preferred)
      for (const engine of AUTO_CHAIN) {
        if (engine !== preferred && engineTemporarilyDisabled(engine)) continue
        push(engine)
      }
    }
    if (!order.length) push("bing")
    return order
  }

  const getTranslateEngine = () => resolveTranslateEngine().engine

  const getTranslateEngineName = (engine: string) =>
    engine === "ai" ? `AI 翻译（${config.aiModel || "自定义模型"}）` : engine === "apple" ? "Apple 系统翻译" : engine === "edge" ? "微软翻译（Edge）" : engine === "bing" ? "必应翻译" : "Google 翻译"

  // 引擎名（含回退原因），用于状态栏与进度 Toast 展示
  const describeTranslateEngine = () => {
    const { engine, note } = resolveTranslateEngine()
    return note ? `${getTranslateEngineName(engine)}（${note}）` : getTranslateEngineName(engine)
  }

  const isTranslatableElement = (element: Element | null) => {
    // 同上：iframe 文档元素跨 realm，instanceof 恒为 false，改用 nodeType 判定
    if (!element || element.nodeType !== 1) return false
    if (element.closest(`#${ROOT_ID}`)) return false
    let current: HTMLElement | null = element
    while (current && current !== current.ownerDocument.documentElement) {
      const tag = current.tagName.toLowerCase()
      if (["script", "style", "noscript", "textarea", "input", "select", "option", "template", "code", "pre", "kbd", "samp", "var", "iframe", "svg", "canvas"].includes(tag)) return false
      if (current.isContentEditable || current.getAttribute("translate") === "no") return false
      if (current.hidden || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false
      const style = getComputedStyle(current)
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false
      current = current.parentElement
    }
    return true
  }

  const collectTranslatableNodes = () => {
    const result: { doc: Document; node: Text; original: string }[] = []
    getDocs().forEach((doc) => {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const text = (node.nodeValue || "").trim()
          if (!text || !/[\p{L}]/u.test(text)) return NodeFilter.FILTER_REJECT
          if ((node.parentElement as HTMLElement | null)?.hasAttribute?.("data-ps-translated")) return NodeFilter.FILTER_REJECT
          if ((node.parentElement as HTMLElement | null)?.closest?.(`.${MARK_CLASS}`)) return NodeFilter.FILTER_REJECT
          if ((node.parentElement as HTMLElement | null)?.closest?.(`.${PS_TRANSLATION_CLASS}`)) return NodeFilter.FILTER_REJECT
          if (!isTranslatableElement(node.parentElement)) return NodeFilter.FILTER_REJECT
          return NodeFilter.FILTER_ACCEPT
        },
      })
      const nodes: Text[] = []
      let node = walker.nextNode()
      while (node) { nodes.push(node as Text); node = walker.nextNode() }
      nodes.forEach((textNode) => {
        if (result.length >= TRANSLATE_PAGE_LIMIT) return
        const parent = textNode.parentElement as HTMLElement | null
        if (parent && !parent.hasAttribute("data-ps-translated")) parent.setAttribute("data-ps-original", textNode.nodeValue || "")
        result.push({ doc, node: textNode, original: textNode.nodeValue || "" })
      })
    })
    return result
  }

  // 属性文案翻译：placeholder（输入框提示）与 title（悬停提示）是常见 UI 文案，一并纳入翻译范围
  const collectTranslatableAttributes = () => {
    const result: { element: Element; attr: string; original: string }[] = []
    getDocs().forEach((doc) => {
      doc.querySelectorAll("input[placeholder], textarea[placeholder], [title]").forEach((el) => {
        if (result.length >= 200) return
        if (el.closest(`#${ROOT_ID}, .${PS_TRANSLATION_CLASS}, .${MARK_CLASS}`)) return
        if (el.hasAttribute("data-ps-attr-translated")) return
        const tag = el.tagName.toLowerCase()
        const attr = (tag === "input" || tag === "textarea") && el.hasAttribute("placeholder") ? "placeholder" : "title"
        const value = (el.getAttribute(attr) || "").trim()
        if (!value || !/[\p{L}]/u.test(value)) return
        // 不能用 isTranslatableElement：它的标签黑名单含 input/textarea，会把 placeholder 宿主全部排除
        if (["script", "style", "noscript", "template", "code", "pre", "svg", "canvas", "iframe"].includes(tag)) return
        if (el.getAttribute("translate") === "no") return
        let current: Element | null = el
        let visible = true
        while (current && current.nodeType === 1) {
          if ((current as HTMLElement).hidden || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) { visible = false; break }
          const style = current.ownerDocument?.defaultView ? getComputedStyle(current) : null
          if (style && (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse")) { visible = false; break }
          current = current.parentElement
        }
        if (!visible) return
        result.push({ element: el, attr, original: el.getAttribute(attr) || "" })
      })
    })
    return result
  }

  // 用指定引擎翻译属性文案（正文成功后补翻；失败不影响主结果）
  const translateAttributes = async (engine: string, target: string) => {
    const attrTasks = collectTranslatableAttributes()
    if (!attrTasks.length) return
    const attrTexts = attrTasks.map((task) => task.original)
    const attrResults = engine === "ai"
      ? await translateAIBatch(attrTexts, target)
      : engine === "edge"
        ? await translateBatchEdge(attrTexts, target)
        : engine === "apple"
          ? await translateBatchApple(attrTexts, target)
          : engine === "bing"
            ? await translateBatchBing(attrTexts, target)
            : await translateBatchGoogle(attrTexts, target)
    attrTasks.forEach((task, index) => {
      const value = String(attrResults[index] || "").trim()
      if (!value || value === task.original.trim()) return
      task.element.setAttribute("data-ps-attr-name", task.attr)
      task.element.setAttribute("data-ps-attr-original", task.original)
      task.element.setAttribute("data-ps-attr-translated", "1")
      task.element.setAttribute(task.attr, value)
    })
  }

  const translateBatchApple = (texts: string[], target: string) =>
    new Promise<string[]>((resolve, reject) => {
      // 扩展端不回调时避免 Promise 永挂卡死持续翻译
      const timer = window.setTimeout(() => reject(new Error("Apple 翻译超时")), 30000)
      const finish = (fn: () => void) => { window.clearTimeout(timer); fn() }
      try {
        const callbackKey = `__psTranslateCb${Date.now()}${Math.random().toString(36).slice(2)}`
        ;(window as any)[callbackKey] = (response: any) => {
          try { delete (window as any)[callbackKey] } catch {}
          if (response && response.error) { finish(() => reject(new Error(String(response.error)))); return }
          finish(() => resolve(Array.isArray(response?.texts) ? response.texts.map((item: any) => String(item ?? "")) : []))
        }
        ;(document.documentElement as any)._appleTranslateBatch(JSON.stringify({ texts, source: "auto", target }), callbackKey)
      } catch (error) { finish(() => reject(error)) }
    })

  const gmRequestText = (url: string, options: { method?: string; headers?: Record<string, string>; data?: string; timeout?: number } = {}) =>
    new Promise<string>((resolve, reject) => {
      if (!GM.xmlHttpRequest) { reject(new Error("当前环境不支持网络翻译请求")); return }
      GM.xmlHttpRequest({
        method: options.method || "GET",
        url,
        headers: options.headers,
        data: options.data,
        timeout: options.timeout || 20000,
        onload: (response: any) => {
          if (response.status >= 200 && response.status < 300) resolve(String(response.responseText || ""))
          else {
            let detail = ""
            try { detail = String(response.responseText || "").slice(0, 200) } catch {}
            reject(new Error(`翻译请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`))
          }
        },
        onerror: () => reject(new Error("翻译请求网络错误")),
        ontimeout: () => reject(new Error("翻译请求超时")),
      })
    })

  // ── AI 翻译（OpenAI 兼容接口 / 中转 API）────────────────────
  // 参考沉浸式翻译的多段批量策略：一次请求发送多段文本，
  // 用 \n%%\n 作为分隔符，返回结果按分隔符拆分回填。

  const getAITargetName = () => TRANSLATE_LANGUAGES.find((item) => item.code === config.translateTarget)?.name || config.translateTarget

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  // 单次 AI 请求（含指数退避重试，429/5xx 时自动重试）
  const translateAIBatchOnce = async (texts: string[], target: string): Promise<string[]> => {
    if (!config.aiBaseUrl || !config.aiApiKey) throw new Error("请先在翻译页配置 AI 接口（Base URL 与 API Key）")
    const toName = TRANSLATE_LANGUAGES.find((item) => item.code === target)?.name || target
    const systemPrompt = [
      `You are a professional ${toName} native translator who needs to fluently translate text into ${toName}.`,
      "",
      "## Translation Rules",
      "1. Output only the translated content, without explanations or additional content (such as \"Here's the translation:\")",
      "2. The returned translation must maintain exactly the same number of paragraphs and format as the original text",
      "3. If the text contains HTML tags, consider where the tags should be placed in the translation while maintaining fluency",
      "4. For content that should not be translated (such as proper nouns, code, URLs, version numbers), keep the original text",
      "5. Adjacent segments come from the same web page; use surrounding segments as context to disambiguate short labels such as buttons and menu items",
      "6. The input contains multiple segments separated by \"%%\". You MUST return exactly the same number of segments, each separated by \"%%\" — never merge or split segments",
      "",
      "## Input-Output Format Examples",
      "### Input Example:",
      "Paragraph A",
      "%%",
      "Paragraph B",
      "### Output Example:",
      "Translation A",
      "%%",
      "Translation B",
    ].join("\n")
    const body = JSON.stringify({
      model: config.aiModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: texts.join(AI_BATCH_SEPARATOR) },
      ],
      temperature: 0.1,
      // 推理类模型（deepseek 系列）关闭思维链提速省 token；严格端点会拒绝未知参数，仅在 deepseek 型号上发送
      ...(config.aiModel.toLowerCase().includes("deepseek") ? { reasoning_effort: "none" } : {}),
    })
    let lastError: any = null
    for (let attempt = 0; attempt <= AI_RETRY_TIMES; attempt++) {
      if (translationCancelled) throw new Error("已取消")
      if (attempt > 0) await sleep(600 * Math.pow(2, attempt - 1))
      try {
        const raw = await gmRequestText(`${config.aiBaseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.aiApiKey}` },
          data: body,
          timeout: 60000,
        })
        const parsed = JSON.parse(raw)
        if (parsed?.error) throw new Error(String(parsed.error.message || parsed.error))
        const content = String(parsed?.choices?.[0]?.message?.content || "")
        if (!content.trim()) throw new Error("AI 返回内容为空")
        // 分隔符容错拆分：兼容 %% 前后的空格/换行/全角变体
        const parts = content.split(/\s*%%\s*/).map((part) => part.trim()).filter((part, index, arr) => part !== "" || arr.length === 1)
        if (parts.length === texts.length) return parts
        if (texts.length === 1) return [content.replace(/^%%|%%$/g, "").trim()]
        // 数量不匹配视为失败抛错，由上层 translateBatchAI 进入逐条重试
        throw new Error(`AI 返回分段数不匹配（期望 ${texts.length} 段，实际 ${parts.length} 段）`)
      } catch (error) {
        if (String((error as any)?.message || error).includes("已取消")) throw error
        lastError = error
      }
    }
    throw lastError || new Error("AI 请求失败")
  }

  const translateAIBatch = async (texts: string[], target: string): Promise<string[]> => {
    if (!texts.length) return []
    // 先查持久缓存（刷新后同文本零 token 直接回显），未命中才请求
    const results = new Array<string>(texts.length).fill("")
    const pendingIndexes: number[] = []
    const pendingTexts: string[] = []
    texts.forEach((text, index) => {
      const cached = getCachedTranslation(target, text)
      if (cached !== undefined) results[index] = cached
      else { pendingIndexes.push(index); pendingTexts.push(text) }
    })
    if (pendingTexts.length) {
      const translated = await translateAIBatchOnce(pendingTexts, target)
      pendingTexts.forEach((text, i) => {
        const value = translated[i] || text
        results[pendingIndexes[i]] = value
        setCachedTranslation(target, text, value)
      })
    }
    return results
  }

  // 从 /models 拉取当前中转站可用模型列表
  const fetchAIModels = async (): Promise<string[]> => {
    if (!config.aiBaseUrl || !config.aiApiKey) throw new Error("请先填写 Base URL 与 API Key")
    const raw = await gmRequestText(`${config.aiBaseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.aiApiKey}` },
      timeout: 30000,
    })
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed?.data) ? parsed.data : []
    return list.map((item: any) => String(item?.id || "")).filter(Boolean)
  }

  const translateBatchAI = async (texts: string[], target: string, onProgress?: (done: number) => void) => {
    // 按条数 + 字符数双重限制分批（字符感知，避免长段落超限、短文本浪费请求）
    const batches: { start: number; texts: string[] }[] = []
    let current: string[] = []
    let currentChars = 0
    let batchStart = 0
    texts.forEach((text, index) => {
      if (current.length && (current.length >= AI_BATCH_SIZE || currentChars + text.length > AI_BATCH_CHARS)) {
        batches.push({ start: batchStart, texts: current })
        current = []
        currentChars = 0
        batchStart = index
      }
      current.push(text)
      currentChars += text.length
    })
    if (current.length) batches.push({ start: batchStart, texts: current })
    const results = new Array(texts.length).fill("")
    let cursor = 0
    let done = 0
    let firstError = ""
    let failures = 0
    const worker = async () => {
      while (cursor < batches.length) {
        if (translationCancelled) throw new Error("已取消")
        const batch = batches[cursor++]
        let translated: string[] = []
        try {
          translated = await translateAIBatch(batch.texts, target)
        } catch (error) {
          if (String((error as any)?.message || error).includes("已取消")) throw error
          // 批量失败时逐条重试；仍失败则保留原文，但必须记录原因（否则全部失败会被伪装成“没有要翻的内容”）
          translated = []
          for (const text of batch.texts) {
            if (translationCancelled) throw new Error("已取消")
            try { translated.push((await translateAIBatch([text], target))[0]) }
            catch (itemError) {
              failures += 1
              if (!firstError) firstError = String((itemError as any)?.message || itemError)
              translated.push(text)
            }
          }
        }
        batch.texts.forEach((_, offset) => { results[batch.start + offset] = translated[offset] || batch.texts[offset] })
        done += batch.texts.length
        onProgress?.(done)
      }
    }
    await Promise.all(Array.from({ length: Math.min(TRANSLATE_CONCURRENCY, batches.length) }, () => worker()))
    if (failures >= texts.length && texts.length > 0) throw new Error(`AI 翻译请求全部失败：${firstError.slice(0, 120)}（可在翻译页点「测试当前引擎」检查接口）`)
    return results
  }

  const translateGoogleSingle = async (text: string, target: string) => {
    const cached = getCachedTranslation(target, text)
    if (cached !== undefined) return cached
    const url = `https://translate.googleapis.com/translate_a/t?client=at&sl=auto&tl=${encodeURIComponent(target)}&q=${encodeURIComponent(text)}`
    // 限流/瞬时网络错误重试一次，避免个别节点静默保留原文
    let lastError: any = null
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(600)
      try {
        const raw = await gmRequestText(url)
        const parsed = JSON.parse(raw)
        const first = Array.isArray(parsed) ? parsed[0] : null
        const segments = Array.isArray(first) ? first : [first]
        const joined = segments.map((segment: any) => (Array.isArray(segment) ? segment[0] : segment) || "").join("")
        setCachedTranslation(target, text, joined)
        return joined
      } catch (error) {
        if (String((error as any)?.message || error).includes("已取消")) throw error
        lastError = error
      }
    }
    throw lastError || new Error("Google 翻译请求失败")
  }

  const translateBatchGoogle = async (texts: string[], target: string, onProgress?: (done: number) => void) => {
    const results = new Array(texts.length).fill("")
    let cursor = 0
    let done = 0
    let firstError = ""
    let failures = 0
    const worker = async () => {
      while (cursor < texts.length) {
        if (translationCancelled) throw new Error("已取消")
        const index = cursor++
        try {
          results[index] = await translateGoogleSingle(texts[index], target)
        } catch (error) {
          // 个别失败用原文兑底；全部失败则抛出真实原因（否则用户只看到“没生效”却不知道为什么）
          failures += 1
          if (!firstError) firstError = String((error as any)?.message || error)
          results[index] = texts[index]
        }
        done += 1
        onProgress?.(done)
      }
    }
    await Promise.all(Array.from({ length: Math.min(TRANSLATE_CONCURRENCY, texts.length) }, () => worker()))
    if (failures >= texts.length && texts.length > 0) throw new Error(`Google 翻译请求全部失败：${firstError.slice(0, 120)}（若在中国大陆网络，Google 接口可能无法直连，可改用必应翻译或 AI）`)
    return results
  }

  // ── Bing（微软必应）翻译：国内网络可直接访问，无需密钥 ──
  // 流程参考 bing-translate-api：先取 /translator 页面令牌（IG/IID/防滥用令牌），再 POST ttranslatev3
  const BING_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0"
  let bingSession: { ig: string; iid: string; token: string; key: string; expires: number } | null = null
  const bingTargetLang = (target: string) => (target === "zh-CN" ? "zh-Hans" : target === "zh-TW" ? "zh-Hant" : target)

  // 中国大陆网络下 www.bing.com 可能间歇不可达：会话记录实际可用主机，失败自动在 www/cn.bing.com 间切换重试
  let bingHost = "www.bing.com"
  const bingFetchSession = async (host: string) => {
    const html = await gmRequestText(`https://${host}/translator`, { headers: { "user-agent": BING_UA }, timeout: 20000 })
    const ig = html.match(/IG:"([^"]+)"/)?.[1] || ""
    const iid = html.match(/data-iid="([^"]+)"/)?.[1] || ""
    const abuse = html.match(/params_AbusePreventionHelper\s*=\s*\[(\d+),"([^"]+)"/)
    if (!ig || !iid || !abuse) throw new Error("Bing 翻译页面结构已变化，令牌获取失败")
    bingHost = host
    bingSession = { ig, iid, token: abuse[2], key: abuse[1], expires: Date.now() + 25 * 60 * 1000 }
  }
  const bingRefreshSession = async () => {
    try {
      await bingFetchSession(bingHost)
    } catch (firstError) {
      try {
        await bingFetchSession(bingHost === "www.bing.com" ? "cn.bing.com" : "www.bing.com")
      } catch {
        throw firstError
      }
    }
  }

  const translateBingSingle = async (text: string, target: string) => {
    const cached = getCachedTranslation(target, text)
    if (cached !== undefined) return cached
    const to = bingTargetLang(target)
    // Bing 单请求上限 1000 字符（国内 5000），超长分段再切块顺序拼接
    const chunks: string[] = []
    for (let i = 0; i < text.length; i += 1000) chunks.push(text.slice(i, i + 1000))
    const post = async (chunk: string) => {
      if (!bingSession || Date.now() > bingSession.expires) await bingRefreshSession()
      const session = bingSession!
      return gmRequestText(`https://${bingHost}/ttranslatev3?isVertical=1&&IG=${encodeURIComponent(session.ig)}&IID=${encodeURIComponent(session.iid)}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", referer: `https://${bingHost}/translator`, "user-agent": BING_UA },
        data: `fromLang=auto&text=${encodeURIComponent(chunk)}&to=${encodeURIComponent(to)}&token=${encodeURIComponent(session.token)}&key=${encodeURIComponent(session.key)}`,
        timeout: 20000,
      })
    }
    let joined = ""
    for (const chunk of chunks) {
      let raw = ""
      try {
        raw = await post(chunk)
      } catch (error) {
        // 会话可能失效：刷新令牌重试一次
        bingSession = null
        raw = await post(chunk)
      }
      const parsed = JSON.parse(raw)
      if (parsed?.statusCode && parsed.statusCode !== 200) {
        bingSession = null
        throw new Error(`Bing 翻译被拒绝（statusCode ${parsed.statusCode}）`)
      }
      const translations = Array.isArray(parsed) ? parsed[0]?.translations : null
      const piece = Array.isArray(translations) ? translations.map((item: any) => String(item?.text || "")).join("") : ""
      if (!piece) throw new Error("Bing 返回内容为空")
      joined += piece
    }
    setCachedTranslation(target, text, joined)
    return joined
  }

  const translateBatchBing = async (texts: string[], target: string, onProgress?: (done: number) => void) => {
    const results = new Array(texts.length).fill("")
    let cursor = 0
    let done = 0
    let firstError = ""
    let failures = 0
    const worker = async () => {
      while (cursor < texts.length) {
        if (translationCancelled) throw new Error("已取消")
        const index = cursor++
        try {
          results[index] = await translateBingSingle(texts[index], target)
        } catch (error) {
          failures += 1
          if (!firstError) firstError = String((error as any)?.message || error)
          results[index] = texts[index]
        }
        done += 1
        onProgress?.(done)
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, texts.length) }, () => worker()))
    if (failures >= texts.length && texts.length > 0) throw new Error(`Bing 翻译请求全部失败：${firstError.slice(0, 120)}`)
    return results
  }

  // ── 微软翻译（Edge）：Edge 浏览器同款后端，免密钥免令牌，批量接口（参考 bing-translate-api MET 实现）──
  const EDGE_TRANSLATE_URL = "https://edge.microsoft.com/translate/translatetext"
  const edgeTargetLang = (target: string) => (target === "zh-CN" ? "zh-Hans" : target === "zh-TW" ? "zh-Hant" : target)

  const translateEdgeChunk = async (texts: string[], target: string): Promise<string[]> => {
    const to = edgeTargetLang(target)
    const params = new URLSearchParams({ to, isEnterpriseClient: "false" })
    const raw = await gmRequestText(`${EDGE_TRANSLATE_URL}?${params.toString()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      data: JSON.stringify(texts),
      timeout: 20000,
    })
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length !== texts.length) throw new Error("Edge 翻译返回结构与请求不一致")
    return parsed.map((item: any) => {
      const list = Array.isArray(item?.translations) ? item.translations : []
      const matched = list.find((t: any) => t?.to === to) || list[0]
      return String(matched?.text || "")
    })
  }

  const translateBatchEdge = async (texts: string[], target: string, onProgress?: (done: number) => void) => {
    const results = new Array(texts.length).fill("")
    const pendingIndexes: number[] = []
    const pendingTexts: string[] = []
    texts.forEach((text, index) => {
      const cached = getCachedTranslation(target, text)
      if (cached !== undefined) results[index] = cached
      else { pendingIndexes.push(index); pendingTexts.push(text) }
    })
    // 分块：单请求 20 条 / 4000 字符双重限制
    const chunks: { start: number; texts: string[] }[] = []
    let current: string[] = []
    let chars = 0
    let start = 0
    pendingTexts.forEach((text, index) => {
      if (current.length && (current.length >= 20 || chars + text.length > 4000)) {
        chunks.push({ start, texts: current })
        current = []
        chars = 0
        start = index
      }
      current.push(text)
      chars += text.length
    })
    if (current.length) chunks.push({ start, texts: current })
    let done = 0
    let failures = 0
    let firstError = ""
    for (const chunk of chunks) {
      try {
        const translated = await translateEdgeChunk(chunk.texts, target)
        chunk.texts.forEach((text, i) => {
          const value = translated[i] || text
          results[chunk.start + i] = value
          setCachedTranslation(target, text, value)
        })
      } catch (error) {
        failures += 1
        if (!firstError) firstError = String((error as any)?.message || error)
        chunk.texts.forEach((text, i) => { results[chunk.start + i] = text })
      }
      done += chunk.texts.length
      onProgress?.(done)
    }
    if (chunks.length && failures >= chunks.length && pendingTexts.length > 0) {
      throw new Error(`微软翻译请求全部失败：${firstError.slice(0, 120)}`)
    }
    return results
  }

  const splitTranslateText = (text: string) => {
    const cleaned = text.replace(/\s+/g, " ").trim()
    if (cleaned.length <= TRANSLATE_SEGMENT_LIMIT) return [cleaned]
    const parts: string[] = []
    let rest = cleaned
    while (rest.length > TRANSLATE_SEGMENT_LIMIT) {
      let cut = TRANSLATE_SEGMENT_LIMIT
      const slice = rest.slice(0, cut)
      const boundary = Math.max(
        slice.lastIndexOf("。"), slice.lastIndexOf("！"), slice.lastIndexOf("？"),
        slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "),
        slice.lastIndexOf("; "), slice.lastIndexOf("；"), slice.lastIndexOf("，"), slice.lastIndexOf(" ")
      )
      if (boundary > TRANSLATE_SEGMENT_LIMIT * 0.4) cut = boundary + 1
      parts.push(rest.slice(0, cut))
      rest = rest.slice(cut).trim()
    }
    if (rest) parts.push(rest)
    return parts.filter(Boolean)
  }

  const applyTranslation = (item: { node: Text; original: string }, translated: string) => {
    if (!translated || !item.node.isConnected) return
    const text = String(translated).trim()
    if (!text || text === item.original.trim()) return
    const parent = item.node.parentElement as HTMLElement | null
    if (!parent) return
    parent.setAttribute("data-ps-translated", "1")
    if (config.translateBilingual) {
      const styleName = ["below", "block", "dashed", "quote", "none"].includes(config.bilingualStyle) ? config.bilingualStyle : "below"
      const span = item.doc.createElement("span")
      span.className = styleName === "underline" ? PS_TRANSLATION_CLASS : `${PS_TRANSLATION_CLASS} ps-style-${styleName}`
      span.textContent = text
      const next = item.node.nextSibling
      if (styleName === "block" || styleName === "below") {
        // 下方/整块样式：译文换行独占一行
        if (next) parent.insertBefore(item.doc.createTextNode("\n"), next)
        else parent.appendChild(item.doc.createTextNode("\n"))
      }
      if (next) parent.insertBefore(span, next)
      else parent.appendChild(span)
    } else {
      item.node.nodeValue = text
    }
  }

  const updateTranslateStatus = () => {
    const el = query<HTMLElement>('[data-page="translate"] > .ps-status')
    if (el) el.textContent = lastTranslationSummary
  }

  // 翻译失败原因的闪现提示：在进度提示位置显示 5 秒，避免“看起来完成了却没中文”却找不到原因
  let translateToastFlash: string | null = null
  let translateToastFlashTimer: number | null = null
  const flashTranslateToast = (message: string) => {
    translateToastFlash = message
    if (translateToastFlashTimer != null) window.clearTimeout(translateToastFlashTimer)
    updateTranslateProgressToast()
    translateToastFlashTimer = window.setTimeout(() => {
      translateToastFlash = null
      translateToastFlashTimer = null
      updateTranslateProgressToast()
    }, 8000)
  }

  // 页面角落的翻译进度提示：翻译时用户可随时看到进度，无需展开面板
  const TRANSLATE_PROGRESS_ID = "scripting-page-search-translate-progress"
  const updateTranslateProgressToast = () => {
    getDocs(true).forEach((doc) => {
      const existing = doc.getElementById(TRANSLATE_PROGRESS_ID)
      const parent = doc.body || doc.documentElement
      // 失败原因必须可见：即使关闭了进度提示也闪现
      if (!translateToastFlash && (!translateProgress || !config.translateProgressToast)) { existing?.remove(); return }
      if (!parent) return
      const el = existing || doc.createElement("div")
      el.id = TRANSLATE_PROGRESS_ID
      if (translateProgress) {
        const { done, total, engineName } = translateProgress
        const percent = total > 0 ? Math.round((done / total) * 100) : 0
        el.textContent = `正在翻译 ${done}/${total} · ${percent}% · ${engineName}`
        el.style.whiteSpace = ""
        el.style.maxWidth = ""
      } else {
        el.textContent = translateToastFlash || ""
        el.style.whiteSpace = "normal"
        el.style.maxWidth = "86vw"
      }
      el.classList.add("ps-visible")
      if (!existing) parent.appendChild(el)
    })
    if (!translateProgress) return
    if (translateProgressTimer != null) window.clearTimeout(translateProgressTimer)
    if (translateProgress.done >= translateProgress.total && translateProgress.total > 0) {
      translateProgressTimer = window.setTimeout(() => {
        translateProgress = null
        updateTranslateProgressToast()
        translateProgressTimer = null
      }, 2600)
    }
  }

  const updateTranslateUI = () => {
    renderTranslate()
    const el = root()
    if (el) el.classList.toggle("ps-page-translated", !!document.querySelector("[data-ps-translated]"))
  }

  const isNodeTranslated = (item: { node: Text; original: string }) => {
    const parent = item.node.parentElement
    if (!parent?.hasAttribute("data-ps-translated")) return false
    return config.translateBilingual || item.node.nodeValue !== item.original
  }

  // ── 持续翻译：激活后自动跟进页面新增/变化的文本，范围覆盖全页 ──
  const syncTranslateQuickBtn = () => {
    const btn = document.querySelector(`#${QUICK_ID} .ps-quick-translate`)
    if (!btn) return
    btn.classList.toggle("ps-on", translationActive)
    btn.title = translationActive ? "停止翻译（恢复原文）" : "自动翻译全局"
    btn.setAttribute("aria-label", btn.title)
  }

  const activateContinuousTranslation = () => {
    translationActive = true
    root()?.classList.add("ps-translate-active")
    syncTranslateQuickBtn()
    // 本站开启自动翻译：跳转到新页面时自动续译（点恢复原文/停止可关）
    addAutoTranslateSite(location.hostname)
    if (translateObserver) return
    translateObserver = new MutationObserver((mutations) => {
      if (!translationActive) return
      mutations.forEach((mutation) => {
        if (mutation.type === "characterData") {
          if (mutation.target instanceof Text) translatePendingNodes.push(mutation.target)
          return
        }
        // 隐藏→显示：class/style/hidden 变化后把子树里未翻译的文本入队（下拉/弹窗/Tab 面板），
        // processContinuousTranslation 会用 isTranslatableElement 重新过滤，只有真正可见的才会翻
        if (mutation.type === "attributes") {
          const target = mutation.target
          if (target.nodeType !== 1) return
          if ((target as Element).closest?.(`#${ROOT_ID}, #${QUICK_ID}, #scripting-page-search-translate-progress, .${PS_TRANSLATION_CLASS}`)) return
          const walker = target.ownerDocument?.createTreeWalker(target, NodeFilter.SHOW_TEXT)
          if (!walker) return
          let current = walker.nextNode()
          while (current) {
            const parent = current.parentElement
            if (parent && !parent.hasAttribute("data-ps-translated")) translatePendingNodes.push(current as Text)
            current = walker.nextNode()
          }
          return
        }
        mutation.addedNodes.forEach((added) => {
          if (added instanceof Text) { translatePendingNodes.push(added); return }
          if (!(added instanceof Element)) return
          if (added.closest(`#${ROOT_ID}, #${QUICK_ID}, .${PS_TRANSLATION_CLASS}`)) return
          const walker = added.ownerDocument?.createTreeWalker(added, NodeFilter.SHOW_TEXT)
          if (!walker) return
          let current = walker.nextNode()
          while (current) { translatePendingNodes.push(current as Text); current = walker.nextNode() }
        })
      })
      if (!translatePendingNodes.length) return
      if (translatePendingTimer != null) window.clearTimeout(translatePendingTimer)
      translatePendingTimer = window.setTimeout(() => {
        translatePendingTimer = null
        void processContinuousTranslation()
      }, 400)
    })
    translateObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden"] })
  }

  const deactivateContinuousTranslation = () => {
    translationActive = false
    translateObserver?.disconnect()
    translateObserver = null
    translatePendingNodes = []
    if (translatePendingTimer != null) { window.clearTimeout(translatePendingTimer); translatePendingTimer = null }
    if (attrTranslateTimer != null) { window.clearTimeout(attrTranslateTimer); attrTranslateTimer = null }
    const el = root()
    el?.classList.remove("ps-translate-active", "ps-translating")
    syncTranslateQuickBtn()
  }

  const processContinuousTranslation = async () => {
    if (!translationActive || translationRunning) return
    // 手动翻译的“停止”不影响持续翻译：每批开始前重置取消标记
    translationCancelled = false
    const seen = new Set<Text>()
    const nodes: { doc: Document; node: Text; original: string }[] = []
    translatePendingNodes.forEach((node) => {
      if (seen.has(node)) return
      seen.add(node)
      if (!node.isConnected) return
      const text = (node.nodeValue || "").trim()
      if (!text || !/[\p{L}]/u.test(text)) return
      const parent = node.parentElement
      if (!parent || parent.hasAttribute("data-ps-translated")) return
      if (parent.closest(`.${PS_TRANSLATION_CLASS}`)) return
      if (parent.closest(`.${MARK_CLASS}`)) return
      if (!isTranslatableElement(parent)) return
      const doc = node.ownerDocument
      if (!doc) return
      if (!parent.hasAttribute("data-ps-original")) parent.setAttribute("data-ps-original", node.nodeValue || "")
      nodes.push({ doc, node, original: node.nodeValue || "" })
    })
    translatePendingNodes = []
    // 大批量变化时分批处理：本批最多 120 节点，剩余放回队列下轮继续
    if (nodes.length > 120) {
      translatePendingNodes = nodes.slice(120).map((item) => item.node)
      nodes.length = 120
    }
    if (!nodes.length) return
    const target = config.translateTarget
    const engine = getTranslateEngine()
    translationRunning = true
    root()?.classList.add("ps-translating")
    try {
      if (engine === "apple") {
        const translations = await translateBatchApple(nodes.map((item) => item.original), target)
        // 批次在途时用户可能已恢复原文：丢弃结果避免回写
        if (!translationActive) return
        nodes.forEach((item, index) => applyTranslation(item, translations[index] || ""))
        return
      }
      const flat: { itemIndex: number; text: string }[] = []
      nodes.forEach((item, itemIndex) => splitTranslateText(item.original).forEach((segment) => flat.push({ itemIndex, text: segment })))
      if (!flat.length) return
      const texts = flat.map((task) => task.text)
      const translations = engine === "ai"
        ? await translateBatchAI(texts, target)
        : engine === "edge"
          ? await translateBatchEdge(texts, target, (done) => {
            lastTranslationSummary = `持续翻译中 ${done}/${texts.length}`
            updateTranslateStatus()
          })
        : engine === "bing"
          ? await translateBatchBing(texts, target, (done) => {
            lastTranslationSummary = `持续翻译中 ${done}/${texts.length}`
            updateTranslateStatus()
          })
          : await translateBatchGoogle(texts, target, (done) => {
            lastTranslationSummary = `持续翻译中 ${done}/${texts.length}`
            updateTranslateStatus()
          })
      const joined = new Map<number, string[]>()
      translations.forEach((translated, index) => {
        const list = joined.get(flat[index].itemIndex) || []
        list.push(translated)
        joined.set(flat[index].itemIndex, list)
      })
      // 批次在途时用户可能已恢复原文：丢弃结果避免回写
      if (!translationActive) return
      joined.forEach((segments, itemIndex) => applyTranslation(nodes[itemIndex], segments.join("")))
      recordEngineSuccess(engine)
      // 动态新增的属性文案（placeholder/title）也跟进：防抖 2 秒内不重复，失败不影响正文
      if (attrTranslateTimer == null) {
        attrTranslateTimer = window.setTimeout(() => {
          attrTranslateTimer = null
          if (!translationActive) return
          void translateAttributes(engine, config.translateTarget).catch(() => {})
        }, 2000)
      }
    } catch (error: any) {
      // 失败的节点未打翻译标记，下次 DOM 变化时会自动重试；但原因要写进状态栏，避免“静默没效果”
      const message = String(error?.message || error)
      if (!message.includes("已取消")) {
        recordEngineFailure(engine, message)
        lastTranslationSummary = `后台翻译失败：${message.slice(0, 140)}`
        updateTranslateStatus()
      }
    } finally {
      translationRunning = false
      root()?.classList.remove("ps-translating")
      // 处理期间又有新节点入队的话继续跟进
      if (translationActive && translatePendingNodes.length) {
        window.setTimeout(() => { if (translationActive) void processContinuousTranslation() }, 300)
      }
    }
  }

  const translatePage = async () => {
    if (translationRunning) return
    const target = config.translateTarget
    translationRunning = true
    translationCancelled = false
    translateProgress = null
    // 用户发起翻译即记住本站：刷新/跳转后自动续译（恢复原文或手动停止会移除）
    addAutoTranslateSite(location.hostname)
    if (translateProgressTimer != null) { window.clearTimeout(translateProgressTimer); translateProgressTimer = null }
    updateTranslateProgressToast()
    renderTranslate()
    root()?.classList.add("ps-translating")
    try {
      const nodes = collectTranslatableNodes()
      if (!nodes.length) {
        // 全部已翻译时给出明确提示（重复点击不再重译也不产生重复译文）
        lastTranslationSummary = document.querySelector("[data-ps-translated]") ? "本页已全部翻译（恢复原文后可重新翻译）" : "未找到可翻译的文本"
        return
      }
      const runOrder = getEngineRunOrder()
      let usedEngine = ""
      const skippedEngines: string[] = []
      let lastRunError: any = null
      // 运行时回退：按健康链依次尝试，某个引擎整体失败自动换下一个（每引擎仅一次，无循环）
      for (const engine of runOrder) {
        if (translationCancelled) { lastTranslationSummary = "已取消"; return }
        const engineName = getTranslateEngineName(engine)
        try {
        if (engine === "ai") {
        // AI：多段批量（%% 分隔），按批次并发，分段过长先拆分
        const queue: { nodeIndex: number; segments: string[] }[] = []
        nodes.slice(0, TRANSLATE_NODE_LIMIT).forEach((item, nodeIndex) => {
          const segments = splitTranslateText(item.original)
          if (segments.length) queue.push({ nodeIndex, segments })
        })
        const flatTasks: { nodeIndex: number; text: string }[] = []
        queue.forEach((entry) => entry.segments.forEach((text) => flatTasks.push({ nodeIndex: entry.nodeIndex, text })))
        if (!flatTasks.length) { lastTranslationSummary = "未找到可翻译的文本"; return }
        const texts = flatTasks.map((task) => task.text)
        const translations = await translateBatchAI(texts, target, (done) => {
          lastTranslationSummary = `翻译中 ${done}/${texts.length} · ${engineName}`
          translateProgress = { done, total: texts.length, engineName }
          updateTranslateStatus()
          updateTranslateProgressToast()
        })
        if (translationCancelled) { lastTranslationSummary = "已取消"; return }
        const segmentResults = new Map<number, string[]>()
        translations.forEach((translated, taskIndex) => {
          const task = flatTasks[taskIndex]
          const list = segmentResults.get(task.nodeIndex) || []
          list.push(translated)
          segmentResults.set(task.nodeIndex, list)
        })
        let applied = 0
        segmentResults.forEach((segments, nodeIndex) => {
          const node = nodes[nodeIndex]
          if (!node) return
          applyTranslation(node, segments.join(""))
          if (isNodeTranslated(node)) applied += 1
        })
        lastTranslationSummary = applied ? `已翻译 ${applied} 处 · ${engineName}` : "翻译未生效：接口返回与原文相同（页面可能已是目标语言，或接口异常），可点「测试当前引擎」确认"
      } else if (engine === "apple") {
        const batch = nodes.slice(0, TRANSLATE_NODE_LIMIT).map((item) => item.original.trim()).filter(Boolean)
        if (!batch.length) { lastTranslationSummary = "未找到可翻译的文本"; return }
        lastTranslationSummary = `Apple 翻译批量处理 ${batch.length} 段…`
        renderTranslate()
        const translations = await translateBatchApple(batch, target)
        if (translationCancelled) { lastTranslationSummary = "已取消"; return }
        let applied = 0
        translations.forEach((translated, index) => {
          const node = nodes[index]
          if (!node) return
          applyTranslation(node, translated)
          if (isNodeTranslated(node)) applied += 1
        })
        lastTranslationSummary = applied ? `已翻译 ${applied} 处 · ${engineName}` : "翻译未生效：接口返回与原文相同（页面可能已是目标语言，或接口异常），可点「测试当前引擎」确认"
      } else if (engine === "bing") {
        // Bing：与 Google 相同的分段分桶策略，逐段请求并实时应用，带进度
        const queue: { nodeIndex: number; segments: string[] }[] = []
        nodes.slice(0, TRANSLATE_NODE_LIMIT).forEach((item, nodeIndex) => {
          const segments = splitTranslateText(item.original)
          if (segments.length) queue.push({ nodeIndex, segments })
        })
        const flatTasks: { nodeIndex: number; text: string }[] = []
        queue.forEach((entry) => entry.segments.forEach((text) => flatTasks.push({ nodeIndex: entry.nodeIndex, text })))
        if (!flatTasks.length) { lastTranslationSummary = "未找到可翻译的文本"; return }
        const segmentResults = new Map<number, string[]>()
        let applied = 0
        const texts = flatTasks.map((task) => task.text)
        const translations = await translateBatchBing(texts, target, (done) => {
          lastTranslationSummary = `翻译中 ${done}/${texts.length} · ${engineName}`
          translateProgress = { done, total: texts.length, engineName }
          updateTranslateStatus()
          updateTranslateProgressToast()
        })
        if (translationCancelled) { lastTranslationSummary = "已取消"; return }
        translations.forEach((translated, taskIndex) => {
          const task = flatTasks[taskIndex]
          const list = segmentResults.get(task.nodeIndex) || []
          list.push(translated)
          segmentResults.set(task.nodeIndex, list)
        })
        segmentResults.forEach((segments, nodeIndex) => {
          const node = nodes[nodeIndex]
          if (!node) return
          applyTranslation(node, segments.join(""))
          if (isNodeTranslated(node)) applied += 1
        })
        lastTranslationSummary = applied ? `已翻译 ${applied} 处 · ${engineName}` : "翻译未生效：接口返回与原文相同（页面可能已是目标语言，或接口异常），可点「测试当前引擎」确认"
      } else if (engine === "edge") {
        // 微软翻译（Edge）：免密钥免令牌，原生批量（translateBatchEdge 内部再按 20 条/4000 字符分块）
        const queue: { nodeIndex: number; segments: string[] }[] = []
        nodes.slice(0, TRANSLATE_NODE_LIMIT).forEach((item, nodeIndex) => {
          const segments = splitTranslateText(item.original)
          if (segments.length) queue.push({ nodeIndex, segments })
        })
        const flatTasks: { nodeIndex: number; text: string }[] = []
        queue.forEach((entry) => entry.segments.forEach((text) => flatTasks.push({ nodeIndex: entry.nodeIndex, text })))
        if (!flatTasks.length) { lastTranslationSummary = "未找到可翻译的文本"; return }
        const segmentResults = new Map<number, string[]>()
        let applied = 0
        const texts = flatTasks.map((task) => task.text)
        const translations = await translateBatchEdge(texts, target, (done) => {
          lastTranslationSummary = `翻译中 ${done}/${texts.length} · ${engineName}`
          translateProgress = { done, total: texts.length, engineName }
          updateTranslateStatus()
          updateTranslateProgressToast()
        })
        if (translationCancelled) { lastTranslationSummary = "已取消"; return }
        translations.forEach((translated, taskIndex) => {
          const task = flatTasks[taskIndex]
          const list = segmentResults.get(task.nodeIndex) || []
          list.push(translated)
          segmentResults.set(task.nodeIndex, list)
        })
        segmentResults.forEach((segments, nodeIndex) => {
          const node = nodes[nodeIndex]
          if (!node) return
          applyTranslation(node, segments.join(""))
          if (isNodeTranslated(node)) applied += 1
        })
        lastTranslationSummary = applied ? `已翻译 ${applied} 处 · ${engineName}` : "翻译未生效：接口返回与原文相同（页面可能已是目标语言，或接口异常），可点「测试当前引擎」确认"
      } else {
        // Google：把多个节点文本按长度分桶，逐段请求并实时应用，带进度。
        const queue: { nodeIndex: number; segments: string[] }[] = []
        nodes.slice(0, TRANSLATE_NODE_LIMIT).forEach((item, nodeIndex) => {
          const segments = splitTranslateText(item.original)
          if (segments.length) queue.push({ nodeIndex, segments })
        })
        const flatTasks: { nodeIndex: number; text: string }[] = []
        queue.forEach((entry) => entry.segments.forEach((text) => flatTasks.push({ nodeIndex: entry.nodeIndex, text })))
        if (!flatTasks.length) { lastTranslationSummary = "未找到可翻译的文本"; return }
        const segmentResults = new Map<number, string[]>()
        let applied = 0
        const texts = flatTasks.map((task) => task.text)
        const translations = await translateBatchGoogle(texts, target, (done) => {
          lastTranslationSummary = `翻译中 ${done}/${texts.length} · ${engineName}`
          translateProgress = { done, total: texts.length, engineName }
          updateTranslateStatus()
          updateTranslateProgressToast()
        })
        if (translationCancelled) { lastTranslationSummary = "已取消"; return }
        translations.forEach((translated, taskIndex) => {
          const task = flatTasks[taskIndex]
          const list = segmentResults.get(task.nodeIndex) || []
          list.push(translated)
          segmentResults.set(task.nodeIndex, list)
        })
        segmentResults.forEach((segments, nodeIndex) => {
          const node = nodes[nodeIndex]
          if (!node) return
          applyTranslation(node, segments.join(""))
          if (isNodeTranslated(node)) applied += 1
        })
        lastTranslationSummary = applied ? `已翻译 ${applied} 处 · ${engineName}` : "翻译未生效：接口返回与原文相同（页面可能已是目标语言，或接口异常），可点「测试当前引擎」确认"
          recordEngineSuccess(engine)
          usedEngine = engine
          break
        }
        } catch (error) {
          const message = String((error as any)?.message || error)
          if (message.includes("已取消")) { lastTranslationSummary = "已取消"; return }
          lastRunError = error
          recordEngineFailure(engine, message)
          skippedEngines.push(engineName)
        }
      }
      if (!usedEngine) {
        const skippedNote = skippedEngines.length ? `（已尝试：${skippedEngines.join("、")}）` : ""
        const reason = lastRunError ? String((lastRunError as any)?.message || lastRunError) : ""
        throw new Error(`所有可用引擎均失败${skippedNote}：${reason.slice(0, 160)}`)
      }
      if (skippedEngines.length) lastTranslationSummary += `（已自动跳过失败的 ${skippedEngines.join("、")}）`
      // 属性文案（placeholder/title）：用当前成功的引擎补翻，失败不影响正文结果
      try { await translateAttributes(usedEngine, target) } catch {}
      // 超过单批上限的节点：短暂延时后自动开下一批（收集器会跳过已翻译内容），直到整页翻完
      if (nodes.length > TRANSLATE_NODE_LIMIT && !translationCancelled) {
        window.setTimeout(() => { if (!translationRunning && !translationCancelled) void translatePage() }, 500)
      }
    } catch (error: any) {
      const message = String(error?.message || error)
      const cancelled = message.includes("已取消")
      lastTranslationSummary = cancelled ? "已取消" : `翻译失败：${message}`
      translateProgress = null
      updateTranslateProgressToast()
      if (!cancelled) flashTranslateToast(`⚠️ 翻译失败：${message.slice(0, 160)}`)
    } finally {
      translationRunning = false
      root()?.classList.remove("ps-translating")
      // 已有翻译结果 → 激活持续翻译，后续新增内容自动跟进
      if (document.querySelector("[data-ps-translated]")) activateContinuousTranslation()
      // 成功/失败都同步快捷翻译按钮：失败或取消时还原启动时预设的红色停止图标
      syncTranslateQuickBtn()
      updateTranslateUI()
    }
  }

  const restoreTranslation = () => {
    translationCancelled = true
    deactivateContinuousTranslation()
    // 恢复原文 = 关闭本站自动翻译，后续页面不再自动续译
    removeAutoTranslateSite(location.hostname)
    translateProgress = null
    if (translateProgressTimer != null) { window.clearTimeout(translateProgressTimer); translateProgressTimer = null }
    updateTranslateProgressToast()
    getDocs(true).forEach((doc) => {
      // 属性译文（placeholder/title）一并还原
      doc.querySelectorAll("[data-ps-attr-translated]").forEach((element) => {
        const name = element.getAttribute("data-ps-attr-name")
        const original = element.getAttribute("data-ps-attr-original")
        if (name && original != null) element.setAttribute(name, original)
        element.removeAttribute("data-ps-attr-name")
        element.removeAttribute("data-ps-attr-original")
        element.removeAttribute("data-ps-attr-translated")
      })
      doc.querySelectorAll("[data-ps-translated]").forEach((element) => {
        const original = element.getAttribute("data-ps-original")
        if (original != null) {
          // 先移除双语模式的译文 span 元素（v1.4.3 起译文为独立元素，只遍历文本节点会残留）
          element.querySelectorAll(`.${PS_TRANSLATION_CLASS}`).forEach((span) => span.remove())
          const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT)
          const firstText = walker.nextNode()
          if (firstText) firstText.nodeValue = original
          while (walker.nextNode()) walker.currentNode.remove()
        }
        element.removeAttribute("data-ps-translated")
        element.removeAttribute("data-ps-original")
      })
    })
    translationRunning = false
    lastTranslationSummary = "已恢复原文"
    updateTranslateUI()
  }

  // 引擎测试：用固定例句实试当前引擎，成功显示译文，失败显示真实原因
  let engineTestRunning = false
  const testTranslateEngine = async () => {
    if (engineTestRunning) return
    engineTestRunning = true
    const sample = "Hello world, this is an engine test."
    lastTranslationSummary = "引擎测试中…"
    updateTranslateStatus()
    try {
      const engine = getTranslateEngine()
      const target = config.translateTarget
      const result = engine === "ai"
        ? (await translateAIBatch([sample], target))[0]
        : engine === "edge"
          ? (await translateEdgeChunk([sample], target))[0]
          : engine === "apple"
            ? (await translateBatchApple([sample], target))[0]
            : engine === "bing"
              ? await translateBingSingle(sample, target)
              : await translateGoogleSingle(sample, target)
      lastTranslationSummary = `✅ ${describeTranslateEngine()}：${String(result || "").trim() || "（空结果）"}`
    } catch (error: any) {
      lastTranslationSummary = `❌ 测试失败：${String(error?.message || error).slice(0, 140)}`
    }
    engineTestRunning = false
    updateTranslateStatus()
    renderTranslate()
  }

  const renderTranslate = () => {
    const page = query<HTMLElement>('[data-page="translate"]')
    if (!page) return
    const engine = getTranslateEngine()
    const engineName = describeTranslateEngine()
    const translatedCount = getDocs(true).reduce((sum, doc) => sum + doc.querySelectorAll("[data-ps-translated]").length, 0)
    const langOptions = TRANSLATE_LANGUAGES.filter((item) => item.code !== "auto").map((item) =>
      `<option value="${item.code}" ${config.translateTarget === item.code ? "selected" : ""}>${item.name}</option>`
    ).join("")
    const aiReady = !!(config.aiBaseUrl && config.aiApiKey)
    const appleAvailable = typeof (document.documentElement as any)?._appleTranslateBatch === "function"
    page.innerHTML = `
      <div class="ps-status">${escapeHtml(lastTranslationSummary || `翻译引擎：${engineName}${translatedCount ? ` · 已翻译 ${translatedCount} 处` : ""}`)}</div>
      <label class="ps-setting"><span>翻译引擎</span><select class="ps-config-translate-engine">
        <option value="auto" ${config.translateEngine === "auto" ? "selected" : ""}>自动（按健康状态选择）</option>
        <option value="ai" ${config.translateEngine === "ai" ? "selected" : ""}>${engineHealthNote("ai") ? `AI 翻译（${engineHealthNote("ai")}）` : "AI 翻译"}</option>
        <option value="edge" ${config.translateEngine === "edge" ? "selected" : ""}>${engineHealthNote("edge") ? `微软翻译（${engineHealthNote("edge")}）` : "微软翻译（Edge·免密钥）"}</option>
        <option value="apple" ${config.translateEngine === "apple" ? "selected" : ""}>${engineHealthNote("apple") ? `Apple 翻译（${engineHealthNote("apple")}）` : `Apple 翻译${appleAvailable ? "" : "（环境不可用）"}`}</option>
        <option value="bing" ${config.translateEngine === "bing" ? "selected" : ""}>${engineHealthNote("bing") ? `必应翻译（${engineHealthNote("bing")}）` : "必应翻译（国内可用）"}</option>
        <option value="google" ${config.translateEngine === "google" ? "selected" : ""}>${engineHealthNote("google") ? `Google 翻译（${engineHealthNote("google")}）` : "Google 翻译"}</option>
      </select></label>
      <label class="ps-setting"><span>目标语言</span><select class="ps-config-translate-target">${langOptions}</select></label>
      <label class="ps-setting"><span>双语对照</span><input class="ps-config-translate-bilingual" type="checkbox" ${config.translateBilingual ? "checked" : ""} /></label>
      <label class="ps-setting"><span>译文样式</span><select class="ps-config-bilingual-style">
        <option value="below" ${config.bilingualStyle === "below" ? "selected" : ""}>独立下方（默认）</option>
        <option value="underline" ${config.bilingualStyle === "underline" ? "selected" : ""}>下划线</option>
        <option value="block" ${config.bilingualStyle === "block" ? "selected" : ""}>整块显示</option>
        <option value="dashed" ${config.bilingualStyle === "dashed" ? "selected" : ""}>虚线边框</option>
        <option value="quote" ${config.bilingualStyle === "quote" ? "selected" : ""}>引用颜色</option>
        <option value="none" ${config.bilingualStyle === "none" ? "selected" : ""}>无样式</option>
      </select></label>
      <label class="ps-setting"><span>翻译进度提示</span><input class="ps-config-translate-progress" type="checkbox" ${config.translateProgressToast !== false ? "checked" : ""} /></label>
      <div class="ps-row ps-translate-actions">
        <button class="ps-search ps-translate-run" type="button" title="翻译本页" aria-label="翻译本页" ${translationRunning ? "disabled" : ""}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h9M8.5 3v2c0 2.5-1.5 5.5-4.5 7M6 8.5c1 2 2.8 3.8 5 4.5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="m12.5 21 4.5-10 4.5 10M14 17.5h6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span>${translationRunning ? "翻译中…" : "翻译"}</span>
        </button>
        <button class="ps-nav ps-translate-stop" type="button" title="停止" aria-label="停止" ${translationRunning ? "" : "disabled"}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" stroke-width="2"/></svg>
        </button>
        <button class="ps-nav ps-translate-restore ps-clear" type="button" title="恢复原文" aria-label="恢复原文" ${translatedCount || translationRunning ? "" : "disabled"}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.35-5.65" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 5.5v4h4" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="ps-nav ps-translate-test" type="button" title="测试当前引擎" aria-label="测试当前引擎">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6M10 3v5.5L5.9 15.7A2.8 2.8 0 0 0 8.4 20h7.2a2.8 2.8 0 0 0 2.5-4.3L14 8.5V3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.5 14h9" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="ps-ai-config">
        <button class="ps-ai-toggle" type="button">AI 接口配置 ${aiReady ? "（已配置）" : "（未配置）"} <span class="ps-ai-arrow">▾</span></button>
        <div class="ps-ai-body">
          <label class="ps-setting ps-setting-col"><span>Base URL</span><input class="ps-config-ai-base ps-input" type="text" placeholder="https://api.openai.com/v1" value="${escapeHtml(config.aiBaseUrl)}" /></label>
          <label class="ps-setting ps-setting-col"><span>API Key</span><input class="ps-config-ai-key ps-input" type="password" placeholder="sk-…" value="${escapeHtml(config.aiApiKey)}" /></label>
          <label class="ps-setting ps-setting-col"><span>模型</span><input class="ps-config-ai-model ps-input" type="text" placeholder="gpt-4o-mini / deepseek-v4-flash …" value="${escapeHtml(config.aiModel)}" /></label>
          <div class="ps-row">
            <button class="ps-nav ps-ai-test" type="button">测试连接</button>
            <button class="ps-nav ps-ai-models" type="button">拉取模型</button>
          </div>
          <div class="ps-status ps-ai-test-result"></div>
        </div>
      </div>
    `
    // AI 配置折叠/展开
    page.querySelector(".ps-ai-toggle")?.addEventListener("click", () => {
      const body = page.querySelector<HTMLElement>(".ps-ai-body")
      const arrow = page.querySelector<HTMLElement>(".ps-ai-arrow")
      if (!body) return
      const visible = getComputedStyle(body).display !== "none"
      body.style.display = visible ? "none" : "block"
      if (arrow) arrow.textContent = visible ? "▾" : "▴"
    })
    // 测试连接
    page.querySelector(".ps-ai-test")?.addEventListener("click", async () => {
      const result = page.querySelector<HTMLElement>(".ps-ai-test-result")
      if (!result) return
      result.textContent = "测试中…"
      try {
        const [translated] = await translateAIBatch(["Hello"], config.translateTarget)
        result.textContent = translated ? `连接成功：Hello → ${translated}` : "连接成功，但返回为空"
      } catch (error: any) {
        result.textContent = `连接失败：${error?.message || error}`
      }
    })
    // 拉取模型列表：将可用模型填入结果区，点击可快速选用
    page.querySelector(".ps-ai-models")?.addEventListener("click", async () => {
      const result = page.querySelector<HTMLElement>(".ps-ai-test-result")
      if (!result) return
      result.textContent = "正在拉取模型列表…"
      try {
        const models = await fetchAIModels()
        if (!models.length) { result.textContent = "未获取到模型列表"; return }
        result.innerHTML = `可用模型（点击填入）：${models.map((m) => `<a href="javascript:void 0" class="ps-model-pick" data-model="${escapeHtml(m)}">${escapeHtml(m)}</a>`).join("")}`
        result.querySelectorAll(".ps-model-pick").forEach((node) => node.addEventListener("click", () => {
          const model = (node as HTMLElement).dataset.model || ""
          const input = page.querySelector<HTMLInputElement>(".ps-config-ai-model")
          if (input) { input.value = model; input.dispatchEvent(new Event("input", { bubbles: true })) }
          result.textContent = `已选择模型：${model}`
        }))
      } catch (error: any) {
        result.textContent = `拉取失败：${error?.message || error}`
      }
    })
  }

  const updateActive = () => {
    pruneMatches()
    matches.forEach((mark) => mark.classList.remove(ACTIVE_CLASS))
    const active = matches[activeIndex]
    if (!active) { renderResults(); return }
    active.classList.add(ACTIVE_CLASS)
    active.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" })
    const frame = getFrameForDoc(active.ownerDocument)
    frame?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" })
    setStatus(`“${keyword}”：第 ${activeIndex + 1} / ${matches.length} 个结果`)
    renderResults()
  }

  const go = (step: number) => {
    pruneMatches()
    if (!matches.length) { setStatus("请先搜索关键字"); renderResults(); return }
    activeIndex = (activeIndex + step + matches.length) % matches.length
    updateActive()
  }

  const jumpTo = (index: number) => {
    pruneMatches()
    if (index < 0 || index >= matches.length) return
    activeIndex = index
    updateActive()
  }

  const search = () => {
    const value = input()?.value.trim() || ""
    clear()
    if (!value) { setStatus("请输入要查找的关键字"); return }

    let matchers
    try { matchers = buildMatchers(value) } catch (error) { setStatus(`正则表达式错误：${error?.message || error}`); return }
    if (!matchers.length) { setStatus("请输入有效关键字"); return }

    keyword = value
    getDocs().forEach((doc) => {
      ensureDocStyle(doc)
      const textNodes = []
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (shouldSkip(node)) return NodeFilter.FILTER_REJECT
          return matchers.some((matcher) => textContains(node.nodeValue ?? "", matcher)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
        },
      })
      let node = walker.nextNode()
      while (node) { textNodes.push(node); node = walker.nextNode() }
      textNodes.forEach((textNode) => highlightNode(textNode, matchers))
    })

    pruneMatches()
    if (!matches.length) { setStatus(`未找到可在当前页面定位的“${value}”`); return }
    addToHistory(value)
    activeIndex = 0
    updateActive()
    GM.log?.(`页面关键字搜索：找到 ${matches.length} 个“${value}”`)
  }

  const copyResult = async () => {
    pruneMatches()
    if (!matches.length) { setStatus("没有可复制的搜索结果"); renderResults(); return }
    const index = activeIndex >= 0 && activeIndex < matches.length ? activeIndex : 0
    const text = [`页面：${document.title}`, `网址：${location.href}`, `关键字：${keyword}`, `序号：${index + 1} / ${matches.length}`, "", getSnippet(matches[index])].join("\n")
    try {
      await navigator.clipboard.writeText(text)
      setStatus(`第 ${index + 1} 个搜索结果已复制到剪贴板`)
    } catch {
      prompt("复制当前搜索结果", text)
    }
  }

  const renderSettings = () => {
    const page = query<HTMLElement>('[data-page="settings"]')
    if (!page) return
    page.innerHTML = `
      <label class="ps-setting"><span>显示位置</span><select class="ps-config-position"><option value="bottom" ${config.position === "bottom" ? "selected" : ""}>底部悬浮</option><option value="top" ${config.position === "top" ? "selected" : ""}>顶部悬浮</option><option value="topbar" ${config.position === "topbar" ? "selected" : ""}>顶部搜索条</option></select></label>
      <label class="ps-setting"><span>手动位置<small>${config.floatingPosition ? "已保存拖动位置" : "未手动移动，默认右下角悬浮"}</small></span><button class="ps-nav ps-reset-position" type="button">重置</button></label>
      <label class="ps-setting"><span>磨砂玻璃 UI</span><input class="ps-config-glass" type="checkbox" ${config.glass ? "checked" : ""} /></label>
      <label class="ps-setting"><span>简介模式<small>开启后点击图标向左滑出搜索 / 翻译 / 设置快捷按钮</small></span><input class="ps-config-quick" type="checkbox" ${config.quickMode ? "checked" : ""} /></label>
      <label class="ps-setting"><span>透明度<small>${config.opacity}%：数值越低越透明</small></span><input class="ps-config-opacity" type="range" min="0" max="100" value="${config.opacity}" /></label>
      <label class="ps-setting"><span>模糊强度<small>${config.blur}px</small></span><input class="ps-config-blur" type="range" min="0" max="35" value="${config.blur}" /></label>
      <label class="ps-setting"><span>图标放大<small>${formatScale(config.iconScale)}</small></span><input class="ps-config-icon-scale" type="range" min="1" max="2" step="0.05" value="${clampNumber(config.iconScale, 1, 2, 1)}" /></label>
      <label class="ps-setting"><span>UI 横向拓宽<small>${formatScale(config.uiWidthScale)}</small></span><input class="ps-config-ui-width" type="range" min="1" max="2" step="0.05" value="${clampNumber(config.uiWidthScale, 1, 2, 1)}" /></label>
      <label class="ps-setting"><span>主题色</span><input class="ps-config-accent" type="color" value="${config.accentColor}" /></label>
      <label class="ps-setting"><span>高亮颜色</span><input class="ps-config-highlight" type="color" value="${config.highlightColor}" /></label>
      <label class="ps-setting"><span>当前结果颜色</span><input class="ps-config-active" type="color" value="${config.activeColor}" /></label>
      <label class="ps-setting"><span>区分大小写<small>关闭时 apple 可匹配 Apple / APPLE</small></span><input class="ps-config-case" type="checkbox" ${config.caseSensitive ? "checked" : ""} /></label>
      <label class="ps-setting"><span>正则搜索<small>开启后输入内容作为 JavaScript 正则表达式</small></span><input class="ps-config-regex" type="checkbox" ${config.regex ? "checked" : ""} /></label>
      <label class="ps-setting"><span>多关键字<small>非正则模式下，用逗号、中文逗号、换行或两个以上空格分隔</small></span><input class="ps-config-multi" type="checkbox" ${config.multiKeyword ? "checked" : ""} /></label>
      <label class="ps-setting"><span>搜索同源 iframe<small>只能搜索浏览器允许访问的同源 iframe</small></span><input class="ps-config-iframes" type="checkbox" ${config.searchIframes ? "checked" : ""} /></label>
      <label class="ps-setting"><span>显示搜索结果列表</span><input class="ps-config-results" type="checkbox" ${config.showResults ? "checked" : ""} /></label>
      <label class="ps-setting"><span>输入框防放大<small>已启用动态字体补偿：页面从 100% 缩小到 50% 时，聚焦搜索框也尽量不触发 iOS Safari 自动放大</small></span><small>自动</small></label>
      <label class="ps-setting"><span>快捷键打开<small>默认 Option/Alt + K</small></span><input class="ps-config-shortcut-enabled" type="checkbox" ${config.shortcutEnabled ? "checked" : ""} /></label>
      <label class="ps-setting"><span>快捷键字母</span><input class="ps-config-shortcut" type="text" maxlength="1" value="${escapeHtml(config.shortcutKey)}" /></label>
    `
  }

  const openPanel = (tab = "search", options: { solo?: boolean } = {}) => {
    const el = root()
    el?.classList.remove("ps-quick-on")
    if (!options.solo) el?.classList.remove("ps-solo")
    el?.classList.add("ps-open")
    el?.classList.toggle("ps-solo", !!options.solo)
    if (options.solo) el?.setAttribute("data-solo", tab)
    else el?.removeAttribute("data-solo")
    applyAppearance()
    switchTab(tab)
    // solo 设置面板没有搜索输入框，不聚焦
    if (!(options.solo && tab === "settings")) setTimeout(() => input()?.focus(), 0)
  }

  // 简介模式：点击悬浮图标，向左滑出搜索 / 翻译 / 设置三个快捷按钮
  const toggleQuickMode = () => {
    const el = root()
    if (!el) return
    if (el.classList.contains("ps-quick-on")) closeQuickMode()
    else {
      el.classList.remove("ps-open")
      el.classList.add("ps-quick-on")
      applyAppearance()
    }
  }
  const closeQuickMode = () => {
    root()?.classList.remove("ps-quick-on")
  }

  // 简介模式：点击面板外或滚动页面时自动收起快捷按钮
  const setupQuickModeDismiss = () => {
    if (quickDismissStarted) return
    quickDismissStarted = true
    // 用 click（冒泡）而非 pointerdown 收起：保证快捷按钮自身的 click 先执行，避免收起抢跑导致按钮无效
    document.addEventListener("click", (event) => {
      const el = root()
      if (!el) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(`#${ROOT_ID}, #${QUICK_ID}`)) return
      if (el.classList.contains("ps-quick-on")) closeQuickMode()
      if (el.classList.contains("ps-solo")) {
        el.classList.remove("ps-open", "ps-quick-on", "ps-solo")
        el.removeAttribute("data-solo")
        applyAppearance()
      }
    })
    const onScrollOrResize = () => {
      if (!root()?.classList.contains("ps-quick-on")) return
      // iOS 点击瞬间可能伴随微小 scroll，延迟收起给按钮 click 留出执行时间
      window.setTimeout(() => {
        if (root()?.classList.contains("ps-quick-on")) closeQuickMode()
      }, 200)
    }
    window.addEventListener("scroll", onScrollOrResize, true)
    window.addEventListener("resize", onScrollOrResize)
  }
  let quickDismissStarted = false

  const createPanel = () => {
    document.getElementById(ROOT_ID)?.remove()
    document.getElementById(QUICK_ID)?.remove()
    document.getElementById(STYLE_ID)?.remove()
    const el = document.createElement("div")
    el.id = ROOT_ID
    el.innerHTML = `
      <button class="ps-toggle" type="button" title="搜索页面关键字" aria-label="搜索页面关键字">
        <svg class="ps-toggle-icon-search" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M10.8 18.1a7.3 7.3 0 1 1 0-14.6 7.3 7.3 0 0 1 0 14.6Z" stroke-width="2.4" stroke-linecap="round"/><path d="m16.2 16.2 4.3 4.3" stroke-width="2.4" stroke-linecap="round"/></svg>
        <svg class="ps-toggle-icon-quick" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" stroke-width="2.1"/><path d="M19.4 13.5a7.8 7.8 0 0 0 0-3l2-1.5-2-3.5-2.4 1a8 8 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A8 8 0 0 0 7 6.5l-2.4-1-2 3.5 2 1.5a7.8 7.8 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a8 8 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5A8 8 0 0 0 17 17.5l2.4 1 2-3.5-2-1.5Z" stroke-width="1.8" stroke-linejoin="round"/><circle cx="17.8" cy="5.6" r="3.4" fill="var(--ps-accent, #2563eb)" stroke="none"/><path d="m15.9 5.6 1.3 1.4 2.6-2.7" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
      </button>
      <div class="ps-panel">
        <div class="ps-title"><span>Page search</span><button class="ps-close" type="button" title="收起">×</button></div>
        <div class="ps-tabs">
          <button class="ps-tab ps-active" type="button" data-tab="search" title="搜索" aria-label="搜索"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.8 18.1a7.3 7.3 0 1 1 0-14.6 7.3 7.3 0 0 1 0 14.6Z" stroke-width="2.2" stroke-linecap="round"/><path d="m16.2 16.2 4.3 4.3" stroke-width="2.2" stroke-linecap="round"/></svg></button>
          <button class="ps-tab" type="button" data-tab="translate" title="翻译" aria-label="翻译"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h9M8.5 3v2c0 2.5-1.5 5.5-4.5 7M6 8.5c1 2 2.8 3.8 5 4.5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="m12.5 21 4.5-10 4.5 10M14 17.5h6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <button class="ps-tab" type="button" data-tab="settings" title="配置" aria-label="配置"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" stroke-width="2.1"/><path d="M19.4 13.5a7.8 7.8 0 0 0 0-3l2-1.5-2-3.5-2.4 1a8 8 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A8 8 0 0 0 7 6.5l-2.4-1-2 3.5 2 1.5a7.8 7.8 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a8 8 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5A8 8 0 0 0 17 17.5l2.4 1 2-3.5-2-1.5Z" stroke-width="1.8" stroke-linejoin="round"/></svg></button>
        </div>
        <div class="ps-page ps-active" data-page="search">
          <div class="ps-row ps-search-row"><input class="ps-input" type="search" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" inputmode="search" /><button class="ps-search" type="button" title="搜索" aria-label="搜索"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.8 18.1a7.3 7.3 0 1 1 0-14.6 7.3 7.3 0 0 1 0 14.6Z" stroke-width="2.2" stroke-linecap="round"/><path d="m16.2 16.2 4.3 4.3" stroke-width="2.2" stroke-linecap="round"/></svg></button></div>
          <div class="ps-status"></div>
          <div class="ps-row ps-actions">
            <button class="ps-nav ps-prev" type="button" title="上一个" aria-label="上一个"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            <button class="ps-nav ps-next" type="button" title="下一个" aria-label="下一个"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            <button class="ps-nav ps-export" type="button" title="复制结果" aria-label="复制结果"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8.5h8a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-8.5a2 2 0 0 1 2-2Z" stroke-width="2" stroke-linejoin="round"/><path d="M9 5a2 2 0 0 1 2-2h5.5a2.5 2.5 0 0 1 2.5 2.5V14" stroke-width="2" stroke-linecap="round"/></svg></button>
            <button class="ps-nav ps-clear" type="button" title="清除" aria-label="清除"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16" stroke-width="2.1" stroke-linecap="round"/><path d="M10 11v6M14 11v6" stroke-width="2.1" stroke-linecap="round"/><path d="M6 7l1 14h10l1-14" stroke-width="2.1" stroke-linejoin="round"/><path d="M9 7V4h6v3" stroke-width="2.1" stroke-linejoin="round"/></svg></button>
          </div>
          <div class="ps-result-list"></div>
        </div>
        <div class="ps-page" data-page="translate"></div>
        <div class="ps-page" data-page="settings"></div>
      </div>
    `
    document.documentElement.appendChild(el)
    // 简介模式快捷按钮浮层：独立 fixed 容器（挂在 documentElement 下，避免 root 的 transform 影响 fixed 定位）
    const quickEl = document.createElement("div")
    quickEl.id = QUICK_ID
    quickEl.setAttribute("role", "toolbar")
    quickEl.setAttribute("aria-label", "快捷操作")
    quickEl.innerHTML = `
      <button class="ps-quick-btn ps-quick-search" type="button" title="搜索" aria-label="搜索"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M10.8 18.1a7.3 7.3 0 1 1 0-14.6 7.3 7.3 0 0 1 0 14.6Z" stroke-width="2.2" stroke-linecap="round"/><path d="m16.2 16.2 4.3 4.3" stroke-width="2.2" stroke-linecap="round"/></svg></button>
      <button class="ps-quick-btn ps-quick-translate" type="button" title="自动翻译全局" aria-label="自动翻译全局"><svg class="ps-qi-translate" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5h9M8.5 3v2c0 2.5-1.5 5.5-4.5 7M6 8.5c1 2 2.8 3.8 5 4.5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="m12.5 21 4.5-10 4.5 10M14 17.5h6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><svg class="ps-qi-stop" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" stroke-width="2.2"/></svg></button>
      <button class="ps-quick-btn ps-quick-settings" type="button" title="进入设置" aria-label="进入设置"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" stroke-width="2.1"/><path d="M19.4 13.5a7.8 7.8 0 0 0 0-3l2-1.5-2-3.5-2.4 1a8 8 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A8 8 0 0 0 7 6.5l-2.4-1-2 3.5 2 1.5a7.8 7.8 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a8 8 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5A8 8 0 0 0 17 17.5l2.4 1 2-3.5-2-1.5Z" stroke-width="1.8" stroke-linejoin="round"/></svg></button>
    `
    document.documentElement.appendChild(quickEl)
    addStyle()
    applyAppearance()
    renderSettings()
    renderHistory()
    renderTranslate()

    // light DOM 下 click 行为可靠：直接绑定放大镜点击，并用 dataset.dragged 区分拖动。
    query(".ps-toggle")?.addEventListener("click", (event) => {
      if (el.dataset.dragged === "true") { event.preventDefault(); el.dataset.dragged = ""; return }
      if (config.quickMode) {
        // 简介模式：点击图标向左滑出 3 个快捷按钮（不展开面板）
        event.preventDefault()
        toggleQuickMode()
        return
      }
      openPanel("search")
    })
    // 简介模式快捷按钮（独立浮层；stopPropagation 防止页面/文档级监听干扰）
    const bindQuickBtn = (cls: string, action: () => void) => {
      document.querySelector(`#${QUICK_ID} ${cls}`)?.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        action()
      })
    }
    bindQuickBtn(".ps-quick-search", () => { closeQuickMode(); openPanel("search", { solo: true }) })
    bindQuickBtn(".ps-quick-translate", () => {
      // 翻译按钮为开关：翻译生效中再次点击即停止（恢复原文）
      if (translationActive) { restoreTranslation(); return }
      // 本轮翻译进行中（尚未激活持续翻译）：点击 = 停止本轮，并关闭本站自动续译
      if (translationRunning) {
        translationCancelled = true
        removeAutoTranslateSite(location.hostname)
        syncTranslateQuickBtn()
        lastTranslationSummary = "正在停止…"
        updateTranslateStatus()
        return
      }
      // 开始翻译：保持快捷栏展开，立即变红+停止图标给出反馈；完成后自动进入持续翻译（失败会在 finally 还原）
      const translateBtn = document.querySelector(`#${QUICK_ID} .ps-quick-translate`)
      translateBtn?.classList.add("ps-on")
      if (translateBtn) {
        translateBtn.title = "翻译中，点击停止"
        translateBtn.setAttribute("aria-label", translateBtn.title)
      }
      void translatePage()
    })
    bindQuickBtn(".ps-quick-settings", () => { closeQuickMode(); openPanel("settings", { solo: true }) })
    query(".ps-close")?.addEventListener("click", () => { el.classList.remove("ps-open", "ps-quick-on", "ps-solo"); el.removeAttribute("data-solo"); applyAppearance() })
    queryAll(".ps-tab").forEach((button) => button.addEventListener("click", () => switchTab(button.getAttribute("data-tab") || "search")))
    query(".ps-search")?.addEventListener("click", search)
    query(".ps-prev")?.addEventListener("click", () => go(-1))
    query(".ps-next")?.addEventListener("click", () => go(1))
    query(".ps-export")?.addEventListener("click", copyResult)
    query(".ps-clear")?.addEventListener("click", () => { clear(); if (input()) input().value = ""; setStatus("已清除高亮"); input()?.focus() })
    // 翻译页事件（事件委托，renderTranslate 会重建页面内容）
    el.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target) return
      if (target.closest(".ps-translate-run")) { void translatePage(); return }
      if (target.closest(".ps-translate-stop")) { translationCancelled = true; removeAutoTranslateSite(location.hostname); lastTranslationSummary = "已取消"; renderTranslate(); return }
      if (target.closest(".ps-translate-test")) { void testTranslateEngine(); return }
      if (target.closest(".ps-translate-restore")) { restoreTranslation(); return }
    })
    el.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest(".ps-reset-position") : null
      if (!target) return
      config.floatingPosition = null
      if (config.position === "topbar") config.position = "bottom"
      saveConfig()
      setStatus("悬浮位置已重置到右下角")
    })
    query(".ps-input")?.addEventListener("keydown", (event) => { if (event.key === "Enter") search(); if (event.key === "Escape") { el.classList.remove("ps-open", "ps-quick-on", "ps-solo"); el.removeAttribute("data-solo"); applyAppearance() } })
    query(".ps-result-list")?.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest(".ps-result") : null
      if (!target || target.hasAttribute("disabled")) return
      jumpTo(Number(target.getAttribute("data-index")))
    })
    query(".ps-history-list")?.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest(".ps-history-item") : null
      if (!target) return
      const value = history[Number(target.getAttribute("data-index"))]
      if (input() && value) input().value = value
      switchTab("search")
      search()
    })
    el.addEventListener("input", handleConfigChange)
    el.addEventListener("change", handleConfigChange)
    setupInputZoomGuard(el)
    setupDrag(el)
    setupQuickModeDismiss()
    setupStyleRecovery()
  }

  let styleRecoveryStarted = false
  const setupStyleRecovery = () => {
    if (styleRecoveryStarted) return
    styleRecoveryStarted = true
    const heal = () => {
      const el = root()
      if (!el) return
      const style = document.getElementById(STYLE_ID)
      const looksUnstyled = getComputedStyle(el).position !== "fixed" || !style || !style.textContent?.includes(`#${ROOT_ID} .ps-panel`)
      if (looksUnstyled) {
        addStyle()
        applyAppearance()
      }
    }
    window.addEventListener("pageshow", heal)
    document.addEventListener("visibilitychange", heal)
    new MutationObserver(heal).observe(document.documentElement, { childList: true })
    setTimeout(heal, 50)
    setTimeout(heal, 500)
  }

  const setupDrag = (el) => {
    const surfaces = [
      el.querySelector<HTMLElement>(".ps-toggle"),
      el.querySelector<HTMLElement>(".ps-title"),
    ].filter(Boolean) as HTMLElement[]
    if (!surfaces.length) return
    let dragging = false
    let moved = false
    let pointerId: number | null = null
    let startX = 0
    let startY = 0
    let baseX = 0
    let baseY = 0

    const begin = (event: PointerEvent) => {
      if (config.position === "topbar" || dragging) return
      const target = event.target instanceof Element ? event.target : null
      if (!target || target.closest(".ps-close")) return
      const rect = el.getBoundingClientRect()
      dragging = true
      moved = false
      pointerId = event.pointerId
      startX = event.clientX
      startY = event.clientY
      baseX = rect.left
      baseY = rect.top
      el.style.left = `${rect.left}px`
      el.style.top = `${rect.top}px`
      el.style.right = "auto"
      el.style.bottom = "auto"
      el.classList.add("ps-manual")
      // 不在按下瞬间 capture，避免 iOS Safari 取消原生 click；超过阈值后才接管拖动。
    }

    const move = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== pointerId) return
      const dx = event.clientX - startX
      const dy = event.clientY - startY
      if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return
      moved = true
      ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
      const pos = clampFloatingPosition({ x: baseX + dx, y: baseY + dy })
      if (!pos) return
      el.style.left = `${pos.x}px`
      el.style.top = `${pos.y}px`
      el.style.right = "auto"
      el.style.bottom = "auto"
      positionQuickBar()
      event.preventDefault()
    }

    const end = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== pointerId) return
      dragging = false
      pointerId = null
      ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
      if (!moved) return
      el.dataset.dragged = "true"
      setTimeout(() => { el.dataset.dragged = "" }, 350)
      config.floatingPosition = createFloatingPositionSnapshot({ x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0 })
      saveConfig()
      event.preventDefault()
    }

    surfaces.forEach((surface) => {
      surface.addEventListener("pointerdown", begin)
      surface.addEventListener("pointermove", move)
      surface.addEventListener("pointerup", end)
      surface.addEventListener("pointercancel", end)
    })
  }

  const shouldHandleConfigEvent = (event) => {
    const target = event.target
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) return false
    if (event.type === "input") return target.matches('input[type="range"], input[type="color"], input[type="text"]')
    if (event.type === "change") return target.matches('input[type="checkbox"], input[type="range"], input[type="color"], select')
    return true
  }

  const handleConfigChange = (event) => {
    if (!shouldHandleConfigEvent(event)) return
    const target = event.target
    if (target.classList.contains("ps-config-position")) {
      config.position = target.value
      if (target.value === "bottom") config.floatingPosition = null
    }
    if (target.classList.contains("ps-config-glass")) config.glass = target.checked
    if (target.classList.contains("ps-config-quick")) config.quickMode = target.checked
    if (target.classList.contains("ps-config-opacity")) config.opacity = clampNumber(target.value, 0, 100, defaultConfig.opacity)
    if (target.classList.contains("ps-config-blur")) config.blur = clampNumber(target.value, 0, 35, defaultConfig.blur)
    if (target.classList.contains("ps-config-icon-scale")) config.iconScale = clampNumber(target.value, 1, 2, 1)
    if (target.classList.contains("ps-config-ui-width")) config.uiWidthScale = clampNumber(target.value, 1, 2, 1)
    if (target.classList.contains("ps-config-accent")) config.accentColor = target.value
    if (target.classList.contains("ps-config-highlight")) config.highlightColor = target.value
    if (target.classList.contains("ps-config-active")) config.activeColor = target.value
    if (target.classList.contains("ps-config-case")) config.caseSensitive = target.checked
    if (target.classList.contains("ps-config-regex")) config.regex = target.checked
    if (target.classList.contains("ps-config-multi")) config.multiKeyword = target.checked
    if (target.classList.contains("ps-config-iframes")) config.searchIframes = target.checked
    if (target.classList.contains("ps-config-results")) config.showResults = target.checked
    if (target.classList.contains("ps-config-shortcut-enabled")) config.shortcutEnabled = target.checked
    if (target.classList.contains("ps-config-shortcut")) config.shortcutKey = (target.value || "k").slice(0, 1).toLowerCase()
    if (target.classList.contains("ps-config-translate-target")) config.translateTarget = target.value
    if (target.classList.contains("ps-config-translate-bilingual")) config.translateBilingual = target.checked
    if (target.classList.contains("ps-config-bilingual-style")) config.bilingualStyle = target.value
    if (target.classList.contains("ps-config-translate-progress")) config.translateProgressToast = target.checked
    if (target.classList.contains("ps-config-translate-engine")) config.translateEngine = target.value
    if (target.classList.contains("ps-config-ai-base")) config.aiBaseUrl = target.value.trim().replace(/\/+$/, "")
    if (target.classList.contains("ps-config-ai-key")) config.aiApiKey = target.value.trim()
    if (target.classList.contains("ps-config-ai-model")) config.aiModel = target.value.trim()
    const affectsSearch = ["ps-config-case", "ps-config-regex", "ps-config-multi", "ps-config-iframes"].some((cls) => target.classList.contains(cls))
    const affectsMarkColors = ["ps-config-highlight", "ps-config-active"].some((cls) => target.classList.contains(cls))
    const isAIField = ["ps-config-ai-base", "ps-config-ai-key", "ps-config-ai-model", "ps-config-translate-engine"].some((cls) => target.classList.contains(cls))
    const isTranslateDisplayField = ["ps-config-bilingual-style", "ps-config-translate-bilingual", "ps-config-translate-progress"].some((cls) => target.classList.contains(cls))
    saveConfig({ renderSettings: false, renderResults: !target.classList.contains("ps-config-shortcut") && !affectsSearch && !isAIField && !isTranslateDisplayField })
    if (affectsMarkColors) getDocs(true).forEach(ensureDocStyle)
    if (affectsSearch && input()?.value.trim()) search()
    if (target.classList.contains("ps-config-translate-engine")) renderTranslate()
    if (target.classList.contains("ps-config-bilingual-style") || target.classList.contains("ps-config-translate-progress")) renderTranslate()
    if (target.classList.contains("ps-config-bilingual-style")) {
      getDocs(true).forEach((doc) => {
        doc.querySelectorAll(`.${PS_TRANSLATION_CLASS}`).forEach((span) => {
          span.classList.remove("ps-style-below", "ps-style-block", "ps-style-dashed", "ps-style-quote", "ps-style-none")
          if (config.bilingualStyle !== "underline") span.classList.add(`ps-style-${config.bilingualStyle}`)
        })
      })
    }
  }

  // 当页面重新可见时，从 GM 存储重新读取配置与历史：
  // App 内的设置界面会直接修改 GM 存储文件，此处保证浏览器端无需刷新页面即可同步。
  const reloadFromStore = async () => {
    try {
      if (!GM.getValue) return
      const storedConfig = await GM.getValue(STORAGE_KEY, null)
      const parsedConfig = typeof storedConfig === "string" ? JSON.parse(storedConfig) : storedConfig
      if (parsedConfig != null && getUpdatedAt(parsedConfig) > getUpdatedAt(config)) {
        config = normalizeConfig(parsedConfig)
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)) } catch {}
        applyAppearance()
        renderSettings()
        renderResults()
      }
      const storedHistory = await GM.getValue(HISTORY_KEY, null)
      const parsedHistory = typeof storedHistory === "string" ? JSON.parse(storedHistory) : storedHistory
      if (parsedHistory != null && JSON.stringify(parsedHistory) !== JSON.stringify(history)) {
        history = normalizeHistory(parsedHistory)
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)) } catch {}
        renderHistory()
      }
    } catch {}
  }

  window.addEventListener("pagehide", () => flushStored())
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushStored()
    if (document.visibilityState === "visible") void reloadFromStore()
  })

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const el = root()
      if (el?.classList.contains("ps-solo") || el?.classList.contains("ps-quick-on")) {
        el.classList.remove("ps-open", "ps-quick-on", "ps-solo")
        el.removeAttribute("data-solo")
        applyAppearance()
      }
      return
    }
    if (!config.shortcutEnabled) return
    if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return
    if (event.key.toLowerCase() !== String(config.shortcutKey || "k").toLowerCase()) return
    event.preventDefault()
    openPanel("search")
  })

  const init = async () => {
    config = normalizeConfig(await loadStored(STORAGE_KEY, {}))
    // 预载翻译持久缓存与引擎健康记录：刷新后命中缓存零请求，连续失败引擎自动跳过
    await initTranslationCache()
    await loadEngineHealth()
    // v1.4.16 起译文样式默认“独立下方”：旧默认“下划线”仅一次性迁移，之后手动选择仍可保留
    if (!(await loadStored(STYLE_MIGRATED_KEY, false))) {
      if (config.bilingualStyle === "underline") {
        config = normalizeConfig({ ...config, bilingualStyle: "below", updatedAt: Date.now() })
        saveStored(STORAGE_KEY, config)
      }
      saveStored(STYLE_MIGRATED_KEY, true)
    }
    history = normalizeHistory(await loadStored(HISTORY_KEY, []))
    createPanel()
    GM.registerMenuCommand?.("打开页面关键字搜索", () => openPanel("search"))
    GM.registerMenuCommand?.("打开网页全局翻译", () => openPanel("translate"))
    GM.registerMenuCommand?.("翻译本页", () => { openPanel("translate"); void translatePage() })
    GM.registerMenuCommand?.("恢复原文", () => restoreTranslation())
    GM.registerMenuCommand?.("打开页面搜索配置", () => openPanel("settings"))
    // 本站开启过自动翻译：进入新页面时自动续译（点击红色停止/恢复原文可关，v1.4.18）
    try {
      const autoSites = await getAutoTranslateSites()
      if (autoSites.includes(location.hostname)) void translatePage()
    } catch {}
  }

  init()
})()
