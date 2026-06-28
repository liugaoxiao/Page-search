// ==UserScript==
// @name 页面关键字搜索
// @description 点击悬浮按钮，在当前网页中搜索关键字、高亮匹配文字、结果列表跳转，并支持配置搜索选项。
// @match *://*/*
// @run-at document-end
// @grant GM.log
// @grant GM.registerMenuCommand
// ==/UserScript==

// @ts-nocheck

declare const GM: {
  log?: (...args: any[]) => void
  registerMenuCommand?: (name: string, callback: () => void) => void
}

(() => {
  const ROOT_ID = "scripting-page-search-root"
  const STYLE_ID = "scripting-page-search-style"
  const MARK_CLASS = "scripting-page-search-mark"
  const ACTIVE_CLASS = "scripting-page-search-active"
  const STORAGE_KEY = "scripting-page-search-config-v2"

  const defaultConfig = {
    position: "bottom",
    caseSensitive: false,
    regex: false,
    autoSelection: true,
    showResults: true,
  }

  let config = { ...defaultConfig, ...loadConfig() }
  let marks: HTMLElement[] = []
  let activeIndex = -1
  let keyword = ""
  let currentTab = "search"

  function loadConfig() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")
    } catch {
      return {}
    }
  }

  function saveConfig() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
    applyPosition()
    renderSettings()
    renderResults()
  }

  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

  const addStyle = () => {
    if (document.getElementById(STYLE_ID)) return

    const style = document.createElement("style")
    style.id = STYLE_ID
    style.textContent = `
      #${ROOT_ID} {
        position: fixed;
        right: 14px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color-scheme: light;
      }
      #${ROOT_ID}.ps-bottom { bottom: 82px; }
      #${ROOT_ID}.ps-top { top: 14px; }
      #${ROOT_ID} * { box-sizing: border-box; }
      #${ROOT_ID} button, #${ROOT_ID} label { -webkit-tap-highlight-color: transparent; }
      #${ROOT_ID} button { cursor: pointer; }
      #${ROOT_ID} .ps-toggle {
        width: 48px;
        height: 48px;
        border: 0;
        border-radius: 999px;
        background: #2563eb;
        color: #fff;
        font-size: 22px;
        box-shadow: 0 8px 24px rgba(15, 23, 42, .28);
      }
      #${ROOT_ID} .ps-panel {
        display: none;
        width: min(360px, calc(100vw - 28px));
        max-height: min(76vh, 620px);
        overflow: hidden;
        padding: 12px;
        border: 1px solid rgba(148, 163, 184, .45);
        border-radius: 16px;
        background: rgba(255, 255, 255, .96);
        box-shadow: 0 12px 32px rgba(15, 23, 42, .28);
        backdrop-filter: blur(14px);
      }
      #${ROOT_ID}.ps-open .ps-toggle { display: none; }
      #${ROOT_ID}.ps-open .ps-panel { display: flex; flex-direction: column; }
      #${ROOT_ID} .ps-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
        color: #0f172a;
        font-size: 15px;
        font-weight: 700;
      }
      #${ROOT_ID} .ps-close {
        width: 28px;
        height: 28px;
        border: 0;
        border-radius: 999px;
        background: #f1f5f9;
        color: #334155;
        font-size: 17px;
      }
      #${ROOT_ID} .ps-tabs {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        padding: 3px;
        margin-bottom: 10px;
        border-radius: 12px;
        background: #f1f5f9;
      }
      #${ROOT_ID} .ps-tab {
        height: 32px;
        border: 0;
        border-radius: 10px;
        background: transparent;
        color: #475569;
        font-weight: 700;
      }
      #${ROOT_ID} .ps-tab.ps-active { background: white; color: #1d4ed8; box-shadow: 0 1px 4px rgba(15, 23, 42, .08); }
      #${ROOT_ID} .ps-page { display: none; min-height: 0; }
      #${ROOT_ID} .ps-page.ps-active { display: block; }
      #${ROOT_ID} .ps-row { display: flex; gap: 8px; }
      #${ROOT_ID} input[type="search"] {
        flex: 1;
        min-width: 0;
        height: 38px;
        padding: 0 10px;
        border: 1px solid #cbd5e1;
        border-radius: 10px;
        outline: none;
        background: white;
        color: #0f172a;
        font-size: 15px;
      }
      #${ROOT_ID} input[type="search"]:focus {
        border-color: #2563eb;
        box-shadow: 0 0 0 3px rgba(37, 99, 235, .16);
      }
      #${ROOT_ID} .ps-search {
        height: 38px;
        padding: 0 12px;
        border: 0;
        border-radius: 10px;
        background: #2563eb;
        color: white;
        font-size: 14px;
        font-weight: 600;
      }
      #${ROOT_ID} .ps-nav {
        flex: 1;
        height: 36px;
        border: 0;
        border-radius: 10px;
        background: #eff6ff;
        color: #1d4ed8;
        font-size: 14px;
        font-weight: 600;
      }
      #${ROOT_ID} .ps-clear { background: #f8fafc; color: #475569; }
      #${ROOT_ID} .ps-status {
        min-height: 20px;
        margin: 8px 2px;
        color: #64748b;
        font-size: 13px;
      }
      #${ROOT_ID} .ps-result-list {
        display: none;
        max-height: 220px;
        overflow: auto;
        margin-top: 10px;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        background: #f8fafc;
      }
      #${ROOT_ID} .ps-result-list.ps-visible { display: block; }
      #${ROOT_ID} .ps-result {
        width: 100%;
        display: block;
        padding: 9px 10px;
        border: 0;
        border-bottom: 1px solid #e2e8f0;
        background: transparent;
        color: #334155;
        text-align: left;
        line-height: 1.35;
        font-size: 13px;
      }
      #${ROOT_ID} .ps-result:last-child { border-bottom: 0; }
      #${ROOT_ID} .ps-result.ps-current { background: #dbeafe; color: #1e3a8a; }
      #${ROOT_ID} .ps-result-index { font-weight: 800; margin-right: 5px; color: #2563eb; }
      #${ROOT_ID} .ps-setting {
        display: flex;
        gap: 10px;
        align-items: center;
        justify-content: space-between;
        padding: 10px 2px;
        border-bottom: 1px solid #e2e8f0;
        color: #0f172a;
        font-size: 14px;
      }
      #${ROOT_ID} .ps-setting:last-child { border-bottom: 0; }
      #${ROOT_ID} .ps-setting small { display: block; margin-top: 2px; color: #64748b; font-size: 12px; }
      #${ROOT_ID} input[type="checkbox"] { width: 20px; height: 20px; accent-color: #2563eb; }
      #${ROOT_ID} select {
        height: 34px;
        padding: 0 8px;
        border-radius: 9px;
        border: 1px solid #cbd5e1;
        background: white;
        color: #0f172a;
      }
      .${MARK_CLASS} {
        padding: 0 1px;
        border-radius: 3px;
        background: #fde047 !important;
        color: #111827 !important;
      }
      .${MARK_CLASS}.${ACTIVE_CLASS} {
        background: #fb923c !important;
        outline: 2px solid #ea580c;
      }
    `
    document.documentElement.appendChild(style)
  }

  const root = () => document.getElementById(ROOT_ID)
  const input = () => document.querySelector<HTMLInputElement>(`#${ROOT_ID} .ps-input`)
  const status = () => document.querySelector<HTMLElement>(`#${ROOT_ID} .ps-status`)

  const setStatus = (text: string) => {
    const element = status()
    if (element) element.textContent = text
  }

  const applyPosition = () => {
    const element = root()
    if (!element) return
    element.classList.toggle("ps-top", config.position === "top")
    element.classList.toggle("ps-bottom", config.position !== "top")
  }

  const switchTab = (tab: string) => {
    currentTab = tab
    root()?.querySelectorAll(".ps-tab").forEach((button) => {
      button.classList.toggle("ps-active", button.getAttribute("data-tab") === tab)
    })
    root()?.querySelectorAll(".ps-page").forEach((page) => {
      page.classList.toggle("ps-active", page.getAttribute("data-page") === tab)
    })
    if (tab === "settings") renderSettings()
  }

  const isVisible = (element: HTMLElement) => {
    const style = getComputedStyle(element)
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0"
  }

  const shouldSkip = (node: Node) => {
    const parent = node.parentElement
    if (!parent) return true

    const tag = parent.tagName.toLowerCase()
    return ["script", "style", "noscript", "textarea", "input", "select", "option"].includes(tag)
      || Boolean(parent.closest(`#${ROOT_ID}`))
      || Boolean(parent.closest(`.${MARK_CLASS}`))
      || !isVisible(parent)
  }

  const clear = () => {
    document.querySelectorAll(`.${MARK_CLASS}`).forEach((mark) => {
      const parent = mark.parentNode
      if (!parent) return
      parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark)
      parent.normalize()
    })
    marks = []
    activeIndex = -1
    keyword = ""
    renderResults()
  }

  const buildMatcher = (value: string) => {
    const flags = config.caseSensitive ? "g" : "gi"
    if (config.regex) return new RegExp(value, flags)
    return new RegExp(escapeRegExp(value), flags)
  }

  const textContains = (text: string, value: string, regExp: RegExp) => {
    if (config.regex) {
      regExp.lastIndex = 0
      return regExp.test(text)
    }
    return config.caseSensitive ? text.includes(value) : text.toLowerCase().includes(value.toLowerCase())
  }

  const highlightNode = (node: Text, regExp: RegExp) => {
    const text = node.nodeValue ?? ""
    const fragment = document.createDocumentFragment()
    let lastIndex = 0
    let result: RegExpExecArray | null

    regExp.lastIndex = 0
    while ((result = regExp.exec(text))) {
      if (result[0] === "") {
        regExp.lastIndex += 1
        continue
      }
      if (result.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, result.index)))
      }

      const mark = document.createElement("mark")
      mark.className = MARK_CLASS
      mark.textContent = result[0]
      fragment.appendChild(mark)
      marks.push(mark)

      lastIndex = result.index + result[0].length
    }

    if (lastIndex < text.length) fragment.appendChild(document.createTextNode(text.slice(lastIndex)))
    node.parentNode?.replaceChild(fragment, node)
  }

  const getSnippet = (mark: HTMLElement) => {
    const text = (mark.parentElement?.textContent || mark.textContent || "").replace(/\s+/g, " ").trim()
    const selected = mark.textContent || ""
    const index = text.toLowerCase().indexOf(selected.toLowerCase())
    if (index < 0) return text.slice(0, 88)
    const start = Math.max(0, index - 34)
    const end = Math.min(text.length, index + selected.length + 42)
    return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`
  }

  const renderResults = () => {
    const list = document.querySelector<HTMLElement>(`#${ROOT_ID} .ps-result-list`)
    if (!list) return
    list.classList.toggle("ps-visible", config.showResults && marks.length > 0)
    if (!config.showResults || marks.length === 0) {
      list.innerHTML = ""
      return
    }

    const max = Math.min(marks.length, 80)
    list.innerHTML = Array.from({ length: max }, (_, index) => `
      <button class="ps-result ${index === activeIndex ? "ps-current" : ""}" type="button" data-index="${index}">
        <span class="ps-result-index">${index + 1}.</span>${escapeHtml(getSnippet(marks[index]))}
      </button>
    `).join("") + (marks.length > max ? `<button class="ps-result" type="button" disabled>还有 ${marks.length - max} 个结果未显示，可继续用上/下一个跳转</button>` : "")
  }

  const escapeHtml = (value: string) => value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")

  const updateActive = () => {
    marks.forEach((mark) => mark.classList.remove(ACTIVE_CLASS))
    const active = marks[activeIndex]
    if (!active) return

    active.classList.add(ACTIVE_CLASS)
    active.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" })
    setStatus(`“${keyword}”：第 ${activeIndex + 1} / ${marks.length} 个结果`)
    renderResults()
  }

  const go = (step: number) => {
    if (!marks.length) {
      setStatus("请先搜索关键字")
      return
    }
    activeIndex = (activeIndex + step + marks.length) % marks.length
    updateActive()
  }

  const jumpTo = (index: number) => {
    if (index < 0 || index >= marks.length) return
    activeIndex = index
    updateActive()
  }

  const search = () => {
    const searchInput = input()
    const value = searchInput?.value.trim() || ""
    clear()

    if (!value) {
      setStatus("请输入要查找的关键字")
      return
    }

    let regExp: RegExp
    try {
      regExp = buildMatcher(value)
    } catch (error) {
      setStatus(`正则表达式错误：${error?.message || error}`)
      return
    }

    keyword = value
    const textNodes: Text[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (shouldSkip(node)) return NodeFilter.FILTER_REJECT
        return textContains(node.nodeValue ?? "", value, regExp) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      },
    })

    let node = walker.nextNode()
    while (node) {
      textNodes.push(node as Text)
      node = walker.nextNode()
    }

    textNodes.forEach((textNode) => highlightNode(textNode, regExp))

    if (!marks.length) {
      setStatus(`未找到“${value}”`)
      return
    }

    activeIndex = 0
    updateActive()
    GM.log?.(`页面关键字搜索：找到 ${marks.length} 个“${value}”`)
  }

  const useSelection = () => {
    const selected = String(getSelection()?.toString() || "").trim().replace(/\s+/g, " ")
    if (!selected) {
      setStatus("当前页面没有选中文字")
      return
    }
    const searchInput = input()
    if (searchInput) searchInput.value = selected
    search()
  }

  const renderSettings = () => {
    const page = document.querySelector<HTMLElement>(`#${ROOT_ID} [data-page="settings"]`)
    if (!page) return
    page.innerHTML = `
      <label class="ps-setting">
        <span>搜索栏位置<small>选择悬浮按钮和面板显示在页面顶部或底部</small></span>
        <select class="ps-config-position">
          <option value="bottom" ${config.position !== "top" ? "selected" : ""}>底部</option>
          <option value="top" ${config.position === "top" ? "selected" : ""}>顶部</option>
        </select>
      </label>
      <label class="ps-setting">
        <span>区分大小写<small>关闭时 apple 可以匹配 Apple / APPLE</small></span>
        <input class="ps-config-case" type="checkbox" ${config.caseSensitive ? "checked" : ""} />
      </label>
      <label class="ps-setting">
        <span>正则搜索<small>开启后输入内容会作为 JavaScript 正则表达式</small></span>
        <input class="ps-config-regex" type="checkbox" ${config.regex ? "checked" : ""} />
      </label>
      <label class="ps-setting">
        <span>打开时使用选中文字<small>如果页面已有选中文本，打开面板时自动填入并搜索</small></span>
        <input class="ps-config-selection" type="checkbox" ${config.autoSelection ? "checked" : ""} />
      </label>
      <label class="ps-setting">
        <span>显示搜索结果列表<small>在面板下方显示可点击的匹配片段</small></span>
        <input class="ps-config-results" type="checkbox" ${config.showResults ? "checked" : ""} />
      </label>
    `
  }

  const openPanel = (tab = "search") => {
    const element = root()
    const searchInput = input()
    element?.classList.add("ps-open")
    switchTab(tab)

    const selected = String(getSelection()?.toString() || "").trim().replace(/\s+/g, " ")
    if (tab === "search" && config.autoSelection && selected && searchInput && searchInput.value !== selected) {
      searchInput.value = selected
      setTimeout(search, 0)
    }
    setTimeout(() => searchInput?.focus(), 0)
  }

  const createPanel = () => {
    if (document.getElementById(ROOT_ID)) return

    addStyle()
    const element = document.createElement("div")
    element.id = ROOT_ID
    element.innerHTML = `
      <button class="ps-toggle" type="button" title="搜索页面关键字">🔎</button>
      <div class="ps-panel">
        <div class="ps-title">
          <span>页面关键字搜索</span>
          <button class="ps-close" type="button" title="收起">×</button>
        </div>
        <div class="ps-tabs">
          <button class="ps-tab ps-active" type="button" data-tab="search">搜索</button>
          <button class="ps-tab" type="button" data-tab="settings">配置</button>
        </div>
        <div class="ps-page ps-active" data-page="search">
          <div class="ps-row">
            <input class="ps-input" type="search" placeholder="输入关键字或正则" autocomplete="off" />
            <button class="ps-search" type="button">搜索</button>
          </div>
          <div class="ps-status">输入关键字后点击搜索</div>
          <div class="ps-row">
            <button class="ps-nav ps-prev" type="button">上一个</button>
            <button class="ps-nav ps-next" type="button">下一个</button>
            <button class="ps-nav ps-selection" type="button">选中文字</button>
            <button class="ps-nav ps-clear" type="button">清除</button>
          </div>
          <div class="ps-result-list"></div>
        </div>
        <div class="ps-page" data-page="settings"></div>
      </div>
    `
    document.documentElement.appendChild(element)
    applyPosition()
    renderSettings()

    element.querySelector(".ps-toggle")?.addEventListener("click", () => openPanel("search"))
    element.querySelector(".ps-close")?.addEventListener("click", () => element.classList.remove("ps-open"))
    element.querySelectorAll(".ps-tab").forEach((tabButton) => {
      tabButton.addEventListener("click", () => switchTab(tabButton.getAttribute("data-tab") || "search"))
    })
    element.querySelector(".ps-search")?.addEventListener("click", search)
    element.querySelector(".ps-prev")?.addEventListener("click", () => go(-1))
    element.querySelector(".ps-next")?.addEventListener("click", () => go(1))
    element.querySelector(".ps-selection")?.addEventListener("click", useSelection)
    element.querySelector(".ps-clear")?.addEventListener("click", () => {
      clear()
      const searchInput = input()
      if (searchInput) searchInput.value = ""
      setStatus("已清除高亮")
      searchInput?.focus()
    })
    element.querySelector(".ps-input")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") search()
      if (event.key === "Escape") element.classList.remove("ps-open")
    })
    element.querySelector(".ps-result-list")?.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest(".ps-result") : null
      if (!target || target.hasAttribute("disabled")) return
      jumpTo(Number(target.getAttribute("data-index")))
    })
    element.addEventListener("change", (event) => {
      const target = event.target
      if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) return
      if (target.classList.contains("ps-config-position")) config.position = target.value
      if (target.classList.contains("ps-config-case")) config.caseSensitive = target.checked
      if (target.classList.contains("ps-config-regex")) config.regex = target.checked
      if (target.classList.contains("ps-config-selection")) config.autoSelection = target.checked
      if (target.classList.contains("ps-config-results")) config.showResults = target.checked
      saveConfig()
      if (keyword && input()?.value.trim()) search()
    })
  }

  createPanel()

  GM.registerMenuCommand?.("打开页面关键字搜索", () => openPanel("search"))
  GM.registerMenuCommand?.("打开页面搜索配置", () => openPanel("settings"))
})()
