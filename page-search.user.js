// ==UserScript==
// @name 页面关键字搜索
// @description 页面关键字搜索：高亮、结果列表、历史、多关键字、正则、快捷键、单条复制、同源 iframe 与可调磨砂玻璃 UI。
// @match *://*/*
// @run-at document-end
// @grant GM.log
// @grant GM.getValue
// @grant GM.setValue
// @grant GM.registerMenuCommand
// ==/UserScript==
(() => {
    const ROOT_ID = "scripting-page-search-root";
    const STYLE_ID = "scripting-page-search-style";
    const MARK_STYLE_ID = "scripting-page-search-mark-style";
    const MARK_CLASS = "scripting-page-search-mark";
    const ACTIVE_CLASS = "scripting-page-search-active";
    const STORAGE_KEY = "scripting-page-search-config-v4";
    const HISTORY_KEY = "scripting-page-search-history-v1";
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
        floatingPosition: null,
    };
    let config = { ...defaultConfig };
    let history = [];
    let matches = [];
    let activeIndex = -1;
    let keyword = "";
    function loadJson(key, fallback) {
        try {
            return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
        }
        catch {
            return fallback;
        }
    }
    async function loadStored(key, fallback) {
        try {
            if (GM.getValue) {
                const value = await GM.getValue(key, null);
                if (value != null)
                    return typeof value === "string" ? JSON.parse(value) : value;
            }
        }
        catch { }
        return loadJson(key, fallback);
    }
    function saveStored(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        }
        catch { }
        try {
            const result = GM.setValue?.(key, value);
            if (result?.catch)
                result.catch(() => { });
        }
        catch { }
    }
    function saveConfig() {
        saveStored(STORAGE_KEY, config);
        applyAppearance();
        renderSettings();
        renderResults();
    }
    function saveHistory() {
        history = history.slice(0, 20);
        saveStored(HISTORY_KEY, history);
        renderHistory();
    }
    const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapeHtml = (value) => value
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    const clampNumber = (value, min, max, fallback) => {
        const number = Number(value);
        return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
    };
    const formatScale = (value) => `${clampNumber(value, 1, 2, 1).toFixed(2).replace(/\.00$/, "").replace(/0$/, "")}×`;
    const getDocs = () => {
        const docs = [document];
        if (!config.searchIframes)
            return docs;
        document.querySelectorAll("iframe, frame").forEach((frame) => {
            try {
                const doc = frame.contentDocument;
                if (doc?.body)
                    docs.push(doc);
            }
            catch { }
        });
        return docs;
    };
    const getFrameForDoc = (doc) => {
        if (doc === document)
            return null;
        for (const frame of Array.from(document.querySelectorAll("iframe, frame"))) {
            try {
                if (frame.contentDocument === doc)
                    return frame;
            }
            catch { }
        }
        return null;
    };
    const ensureDocStyle = (doc) => {
        let style = doc.getElementById(MARK_STYLE_ID);
        if (!style) {
            style = doc.createElement("style");
            style.id = MARK_STYLE_ID;
            (doc.head || doc.documentElement).appendChild(style);
        }
        style.textContent = `
      .${MARK_CLASS} { padding: 0 1px; border-radius: 3px; background: ${config.highlightColor} !important; color: #111827 !important; }
      .${MARK_CLASS}.${ACTIVE_CLASS} { background: ${config.activeColor} !important; outline: 2px solid ${config.activeColor}; }
    `;
    };
    const root = () => document.getElementById(ROOT_ID);
    const input = () => document.querySelector(`#${ROOT_ID} .ps-input`);
    const status = () => document.querySelector(`#${ROOT_ID} .ps-status`);
    const setStatus = (text) => { const el = status(); if (el)
        el.textContent = text; };
    const addStyle = () => {
        if (document.getElementById(STYLE_ID))
            return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
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
      #${ROOT_ID} .ps-toggle svg { width: var(--ps-ui-toggle-icon-size, 23px); height: var(--ps-ui-toggle-icon-size, 23px); display: block; stroke: currentColor; }
      #${ROOT_ID} .ps-toggle:active { transform: scale(.96); }
      #${ROOT_ID}.ps-topbar .ps-toggle { width: 100%; height: 30px; border-radius: 9px; }
      #${ROOT_ID} .ps-panel {
        display: none;
        flex-direction: column;
        width: min(var(--ps-ui-panel-width, 171px), calc(100vw - 12px)); max-height: min(56vh, 400px); overflow: hidden;
        padding: var(--ps-ui-panel-padding, 5px); border: 1px solid rgba(148, 163, 184, .38); border-radius: 10px;
        background: var(--ps-panel-bg); box-shadow: 0 8px 18px rgba(15, 23, 42, .2);
      }
      #${ROOT_ID}.ps-glass .ps-panel { backdrop-filter: blur(var(--ps-blur)); -webkit-backdrop-filter: blur(var(--ps-blur)); }
      #${ROOT_ID}.ps-topbar .ps-panel { width: 100%; max-height: min(50vh, 360px); }
      #${ROOT_ID}.ps-open .ps-toggle { display: none; }
      #${ROOT_ID}.ps-open .ps-panel { display: flex; }
      #${ROOT_ID} .ps-title { flex: 0 0 auto; position: relative; display: flex; align-items: center; justify-content: center; margin-bottom: var(--ps-ui-gap, 3px); min-height: calc(var(--ps-ui-tab-height, 22px) + 1px); color: #0f172a; font-size: var(--ps-ui-title-font-size, 11px); font-weight: 800; text-align: center; cursor: move; touch-action: none; -webkit-touch-callout: none; user-select: none; -webkit-user-select: none; }
      #${ROOT_ID} .ps-title > span:first-child { flex: 0 1 auto; min-width: 0; padding: 3px 24px; text-align: center; }
      #${ROOT_ID} .ps-close { position: absolute; right: 0; top: 2px; width: calc(var(--ps-ui-tab-height, 22px) - 2px); height: calc(var(--ps-ui-tab-height, 22px) - 2px); border: 0; border-radius: 999px; background: rgba(241,245,249,.9); color: #334155; font-size: var(--ps-ui-title-font-size, 11px); line-height: 1; }
      #${ROOT_ID} .ps-tabs { flex: 0 0 auto; display: flex; justify-content: space-evenly; gap: 0; padding: 2px; margin-bottom: var(--ps-ui-gap, 3px); border-radius: 8px; background: rgba(241,245,249,.82); }
      #${ROOT_ID} .ps-tab { flex: 1 1 0; width: auto; height: var(--ps-ui-tab-height, 22px); padding: 0; border: 0; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; background: transparent; color: #475569; }
      #${ROOT_ID} .ps-tab.ps-active { background: rgba(255,255,255,.92); color: var(--ps-accent); box-shadow: 0 1px 2px rgba(15,23,42,.08); }
      #${ROOT_ID} .ps-tab svg, #${ROOT_ID} .ps-search svg, #${ROOT_ID} .ps-nav svg { width: var(--ps-ui-icon-size, 14px); height: var(--ps-ui-icon-size, 14px); display: block; stroke: currentColor; fill: none; }
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
      .${MARK_CLASS} { padding: 0 1px; border-radius: 3px; background: var(--ps-highlight, #fde047) !important; color: #111827 !important; }
      .${MARK_CLASS}.${ACTIVE_CLASS} { background: var(--ps-active, #fb923c) !important; outline: 2px solid var(--ps-active, #ea580c); }
    `;
        document.documentElement.appendChild(style);
    };
    const clampFloatingPosition = (position) => {
        const el = root();
        if (!el || !position)
            return null;
        const rect = el.getBoundingClientRect();
        const width = Math.max(rect.width || 36, 36);
        const height = Math.max(rect.height || 36, 36);
        const margin = 6;
        return {
            x: Math.min(Math.max(Number(position.x) || margin, margin), Math.max(margin, window.innerWidth - width - margin)),
            y: Math.min(Math.max(Number(position.y) || margin, margin), Math.max(margin, window.innerHeight - height - margin)),
        };
    };
    const applyAppearance = () => {
        const el = root();
        if (!el)
            return;
        const manualPosition = config.position !== "topbar" ? clampFloatingPosition(config.floatingPosition) : null;
        el.classList.toggle("ps-top", config.position === "top");
        el.classList.toggle("ps-topbar", config.position === "topbar");
        el.classList.toggle("ps-bottom", config.position === "bottom");
        el.classList.toggle("ps-manual", !!manualPosition);
        el.classList.toggle("ps-glass", !!config.glass);
        if (manualPosition) {
            el.style.left = `${manualPosition.x}px`;
            el.style.top = `${manualPosition.y}px`;
            el.style.right = "auto";
            el.style.bottom = "auto";
        }
        else {
            el.style.left = "";
            el.style.top = "";
            el.style.right = "";
            el.style.bottom = "";
        }
        el.style.setProperty("--ps-accent", config.accentColor);
        el.style.setProperty("--ps-highlight", config.highlightColor);
        el.style.setProperty("--ps-active", config.activeColor);
        el.style.setProperty("--ps-blur", `${config.blur}px`);
        el.style.setProperty("--ps-panel-bg", config.glass ? `rgba(255,255,255,${Number(config.opacity) / 100})` : "rgba(255,255,255,.98)");
        updateZoomCompensation();
    };
    const getPageZoomScale = () => {
        const screenWidth = Number(screen.width) || window.innerWidth || 1;
        const viewportScale = Number(window.visualViewport?.scale) || 1;
        const layoutScale = window.innerWidth > 0 ? Math.min(1, screenWidth / window.innerWidth) : 1;
        return Math.max(0.4, Math.min(1, viewportScale, layoutScale));
    };
    const updateZoomCompensation = () => {
        const el = root();
        if (!el)
            return;
        const scale = getPageZoomScale();
        const boost = Math.max(1, Math.min(2.2, 1 / scale));
        const iconScale = clampNumber(config.iconScale, 1, 2, 1);
        const widthScale = clampNumber(config.uiWidthScale, 1, 2, 1);
        const px = (base, max = Math.ceil(base * 2.2), multiplier = 1) => `${Math.min(max, Math.max(base, Math.round(base * boost * multiplier)))}px`;
        const fontSize = Math.min(40, Math.max(16, Math.ceil(16 / scale)));
        el.style.setProperty("--ps-input-font-size", `${fontSize}px`);
        el.style.setProperty("--ps-ui-panel-width", px(171, 520, widthScale));
        el.style.setProperty("--ps-ui-topbar-width", `min(92vw, ${px(113, 420, widthScale)})`);
        el.style.setProperty("--ps-ui-panel-padding", px(5, 10));
        el.style.setProperty("--ps-ui-title-font-size", px(11, 22));
        el.style.setProperty("--ps-ui-gap", px(7, 15));
        el.style.setProperty("--ps-ui-tab-width", px(25, 52));
        el.style.setProperty("--ps-ui-tab-height", px(22, 46));
        el.style.setProperty("--ps-ui-icon-size", px(18, 76, iconScale));
        el.style.setProperty("--ps-ui-toggle-icon-size", px(23, 92, iconScale));
        el.style.setProperty("--ps-ui-search-size", px(28, 58));
        el.style.setProperty("--ps-ui-nav-size", px(27, 56));
        el.style.setProperty("--ps-ui-input-pad-x", px(6, 14));
        el.style.setProperty("--ps-ui-input-extra-height", px(11, 24));
        el.style.setProperty("--ps-ui-status-font-size", px(11, 22));
        el.style.setProperty("--ps-ui-result-font-size", px(11, 22));
        el.style.setProperty("--ps-ui-setting-font-size", px(11, 22));
        el.style.setProperty("--ps-ui-range-width", px(70, 140));
    };
    let viewportMeta = null;
    let viewportMetaContent = null;
    let viewportMetaCreated = false;
    const lockViewportZoom = () => {
        updateZoomCompensation();
        viewportMeta = document.querySelector('meta[name="viewport"]');
        viewportMetaCreated = !viewportMeta;
        if (!viewportMeta) {
            viewportMeta = document.createElement("meta");
            viewportMeta.name = "viewport";
            document.head?.appendChild(viewportMeta);
        }
        viewportMetaContent = viewportMeta.getAttribute("content");
        const content = viewportMetaContent || "width=device-width, initial-scale=1";
        const parts = content.split(",").map((part) => part.trim()).filter((part) => part && !/^(maximum-scale|user-scalable)\s*=/i.test(part));
        parts.push("maximum-scale=1", "user-scalable=no");
        viewportMeta.setAttribute("content", parts.join(", "));
    };
    const unlockViewportZoom = () => {
        setTimeout(() => {
            if (document.activeElement === input())
                return;
            if (!viewportMeta)
                return;
            if (viewportMetaCreated)
                viewportMeta.remove();
            else if (viewportMetaContent == null)
                viewportMeta.removeAttribute("content");
            else
                viewportMeta.setAttribute("content", viewportMetaContent);
            viewportMeta = null;
            viewportMetaContent = null;
            viewportMetaCreated = false;
        }, 250);
    };
    const setupInputZoomGuard = (el) => {
        el.addEventListener("focusin", (event) => {
            if (event.target instanceof HTMLInputElement && event.target.classList.contains("ps-input"))
                lockViewportZoom();
        });
        el.addEventListener("focusout", (event) => {
            if (event.target instanceof HTMLInputElement && event.target.classList.contains("ps-input"))
                unlockViewportZoom();
        });
        window.visualViewport?.addEventListener("resize", updateZoomCompensation);
        window.addEventListener("resize", updateZoomCompensation);
    };
    const switchTab = (tab) => {
        root()?.querySelectorAll(".ps-tab").forEach((button) => button.classList.toggle("ps-active", button.getAttribute("data-tab") === tab));
        root()?.querySelectorAll(".ps-page").forEach((page) => page.classList.toggle("ps-active", page.getAttribute("data-page") === tab));
        if (tab === "settings")
            renderSettings();
        if (tab === "history")
            renderHistory();
    };
    const isSearchableElement = (element) => {
        let current = element;
        while (current && current !== current.ownerDocument.documentElement) {
            if (current.id === ROOT_ID || (current !== element && current.classList?.contains(MARK_CLASS)))
                return false;
            if (current.hidden || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert"))
                return false;
            const tag = current.tagName.toLowerCase();
            if (["script", "style", "noscript", "textarea", "input", "select", "option", "template"].includes(tag))
                return false;
            if (tag === "details" && !current.open && element !== current)
                return false;
            const style = getComputedStyle(current);
            if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0")
                return false;
            current = current.parentElement;
        }
        return true;
    };
    const isVisible = (element) => isSearchableElement(element);
    const shouldSkip = (node) => {
        const parent = node.parentElement;
        if (!parent)
            return true;
        return !isSearchableElement(parent);
    };
    const isLocatableMark = (mark) => {
        if (!mark.isConnected || !mark.ownerDocument.body?.contains(mark))
            return false;
        if (!isSearchableElement(mark))
            return false;
        const rects = Array.from(mark.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
        return rects.length > 0;
    };
    const pruneMatches = () => {
        matches = matches.filter(isLocatableMark);
        if (!matches.length)
            activeIndex = -1;
        else if (activeIndex >= matches.length)
            activeIndex = matches.length - 1;
        else if (activeIndex < 0)
            activeIndex = 0;
    };
    const clear = () => {
        getDocs().forEach((doc) => doc.querySelectorAll(`.${MARK_CLASS}`).forEach((mark) => {
            const parent = mark.parentNode;
            if (!parent)
                return;
            parent.replaceChild(doc.createTextNode(mark.textContent ?? ""), mark);
            parent.normalize();
        }));
        matches = [];
        activeIndex = -1;
        keyword = "";
        renderResults();
    };
    const parseTerms = (value) => {
        if (config.regex || !config.multiKeyword)
            return [value];
        return value.split(/[，,\n]+|\s{2,}/).map((item) => item.trim()).filter(Boolean);
    };
    const buildMatchers = (value) => {
        const flags = config.caseSensitive ? "g" : "gi";
        return parseTerms(value).map((term) => ({ term, regExp: new RegExp(config.regex ? term : escapeRegExp(term), flags) }));
    };
    const textContains = (text, matcher) => {
        if (config.regex) {
            matcher.regExp.lastIndex = 0;
            return matcher.regExp.test(text);
        }
        return config.caseSensitive ? text.includes(matcher.term) : text.toLowerCase().includes(matcher.term.toLowerCase());
    };
    const highlightNode = (node, matchers) => {
        const text = node.nodeValue ?? "";
        const ranges = [];
        matchers.forEach((matcher, termIndex) => {
            matcher.regExp.lastIndex = 0;
            let result;
            while ((result = matcher.regExp.exec(text))) {
                if (!result[0]) {
                    matcher.regExp.lastIndex += 1;
                    continue;
                }
                ranges.push({ start: result.index, end: result.index + result[0].length, termIndex, text: result[0] });
            }
        });
        ranges.sort((a, b) => a.start - b.start || b.end - a.end);
        const filtered = [];
        let cursor = 0;
        ranges.forEach((range) => {
            if (range.start >= cursor) {
                filtered.push(range);
                cursor = range.end;
            }
        });
        if (!filtered.length)
            return;
        const fragment = node.ownerDocument.createDocumentFragment();
        let lastIndex = 0;
        filtered.forEach((range) => {
            if (range.start > lastIndex)
                fragment.appendChild(node.ownerDocument.createTextNode(text.slice(lastIndex, range.start)));
            const mark = node.ownerDocument.createElement("mark");
            mark.className = MARK_CLASS;
            mark.textContent = text.slice(range.start, range.end);
            mark.dataset.term = String(range.termIndex);
            fragment.appendChild(mark);
            matches.push(mark);
            lastIndex = range.end;
        });
        if (lastIndex < text.length)
            fragment.appendChild(node.ownerDocument.createTextNode(text.slice(lastIndex)));
        node.parentNode?.replaceChild(fragment, node);
    };
    const getSnippet = (mark) => {
        const text = (mark.parentElement?.textContent || mark.textContent || "").replace(/\s+/g, " ").trim();
        const selected = mark.textContent || "";
        const source = config.caseSensitive ? text : text.toLowerCase();
        const needle = config.caseSensitive ? selected : selected.toLowerCase();
        const index = source.indexOf(needle);
        if (index < 0)
            return text.slice(0, 96);
        const start = Math.max(0, index - 36);
        const end = Math.min(text.length, index + selected.length + 46);
        return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
    };
    const addToHistory = (value) => {
        history = [value, ...history.filter((item) => item !== value)].slice(0, 20);
        saveHistory();
    };
    const renderResults = () => {
        const list = document.querySelector(`#${ROOT_ID} .ps-result-list`);
        if (!list)
            return;
        pruneMatches();
        list.classList.toggle("ps-visible", config.showResults && matches.length > 0);
        if (!config.showResults || !matches.length) {
            list.innerHTML = "";
            return;
        }
        const max = Math.min(matches.length, 100);
        list.innerHTML = Array.from({ length: max }, (_, index) => `
      <button class="ps-result ${index === activeIndex ? "ps-current" : ""}" type="button" data-index="${index}">
        <span class="ps-result-index">${index + 1}.</span>${escapeHtml(getSnippet(matches[index]))}
      </button>
    `).join("") + (matches.length > max ? `<button class="ps-result" type="button" disabled>还有 ${matches.length - max} 个结果未显示</button>` : "");
    };
    const renderHistory = () => {
        const list = document.querySelector(`#${ROOT_ID} .ps-history-list`);
        if (!list)
            return;
        list.classList.toggle("ps-visible", history.length > 0);
        list.innerHTML = history.length ? history.map((item, index) => `
      <button class="ps-history-item" type="button" data-index="${index}">${escapeHtml(item)}</button>
    `).join("") : `<div class="ps-status">暂无搜索历史</div>`;
    };
    const updateActive = () => {
        pruneMatches();
        matches.forEach((mark) => mark.classList.remove(ACTIVE_CLASS));
        const active = matches[activeIndex];
        if (!active) {
            renderResults();
            return;
        }
        active.classList.add(ACTIVE_CLASS);
        active.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        const frame = getFrameForDoc(active.ownerDocument);
        frame?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        setStatus(`“${keyword}”：第 ${activeIndex + 1} / ${matches.length} 个结果`);
        renderResults();
    };
    const go = (step) => {
        pruneMatches();
        if (!matches.length) {
            setStatus("请先搜索关键字");
            renderResults();
            return;
        }
        activeIndex = (activeIndex + step + matches.length) % matches.length;
        updateActive();
    };
    const jumpTo = (index) => {
        pruneMatches();
        if (index < 0 || index >= matches.length)
            return;
        activeIndex = index;
        updateActive();
    };
    const search = () => {
        const value = input()?.value.trim() || "";
        clear();
        if (!value) {
            setStatus("请输入要查找的关键字");
            return;
        }
        let matchers;
        try {
            matchers = buildMatchers(value);
        }
        catch (error) {
            setStatus(`正则表达式错误：${error?.message || error}`);
            return;
        }
        if (!matchers.length) {
            setStatus("请输入有效关键字");
            return;
        }
        keyword = value;
        getDocs().forEach((doc) => {
            ensureDocStyle(doc);
            const textNodes = [];
            const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
                acceptNode(node) {
                    if (shouldSkip(node))
                        return NodeFilter.FILTER_REJECT;
                    return matchers.some((matcher) => textContains(node.nodeValue ?? "", matcher)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
                },
            });
            let node = walker.nextNode();
            while (node) {
                textNodes.push(node);
                node = walker.nextNode();
            }
            textNodes.forEach((textNode) => highlightNode(textNode, matchers));
        });
        pruneMatches();
        if (!matches.length) {
            setStatus(`未找到可在当前页面定位的“${value}”`);
            return;
        }
        addToHistory(value);
        activeIndex = 0;
        updateActive();
        GM.log?.(`页面关键字搜索：找到 ${matches.length} 个“${value}”`);
    };
    const copyResult = async () => {
        pruneMatches();
        if (!matches.length) {
            setStatus("没有可复制的搜索结果");
            renderResults();
            return;
        }
        const index = activeIndex >= 0 && activeIndex < matches.length ? activeIndex : 0;
        const text = [`页面：${document.title}`, `网址：${location.href}`, `关键字：${keyword}`, `序号：${index + 1} / ${matches.length}`, "", getSnippet(matches[index])].join("\n");
        try {
            await navigator.clipboard.writeText(text);
            setStatus(`第 ${index + 1} 个搜索结果已复制到剪贴板`);
        }
        catch {
            prompt("复制当前搜索结果", text);
        }
    };
    const renderSettings = () => {
        const page = document.querySelector(`#${ROOT_ID} [data-page="settings"]`);
        if (!page)
            return;
        page.innerHTML = `
      <label class="ps-setting"><span>显示位置</span><select class="ps-config-position"><option value="bottom" ${config.position === "bottom" ? "selected" : ""}>底部悬浮</option><option value="top" ${config.position === "top" ? "selected" : ""}>顶部悬浮</option><option value="topbar" ${config.position === "topbar" ? "selected" : ""}>顶部搜索条</option></select></label>
      <label class="ps-setting"><span>手动位置<small>${config.floatingPosition ? "已保存拖动位置" : "未手动移动，默认右下角悬浮"}</small></span><button class="ps-nav ps-reset-position" type="button">重置</button></label>
      <label class="ps-setting"><span>磨砂玻璃 UI</span><input class="ps-config-glass" type="checkbox" ${config.glass ? "checked" : ""} /></label>
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
    `;
    };
    const openPanel = (tab = "search") => {
        root()?.classList.add("ps-open");
        applyAppearance();
        switchTab(tab);
        setTimeout(() => input()?.focus(), 0);
    };
    const createPanel = () => {
        if (document.getElementById(ROOT_ID))
            return;
        addStyle();
        const el = document.createElement("div");
        el.id = ROOT_ID;
        el.innerHTML = `
      <button class="ps-toggle" type="button" title="搜索页面关键字" aria-label="搜索页面关键字"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M10.8 18.1a7.3 7.3 0 1 1 0-14.6 7.3 7.3 0 0 1 0 14.6Z" stroke-width="2.4" stroke-linecap="round"/><path d="m16.2 16.2 4.3 4.3" stroke-width="2.4" stroke-linecap="round"/></svg></button>
      <div class="ps-panel">
        <div class="ps-title"><span>Page search</span><button class="ps-close" type="button" title="收起">×</button></div>
        <div class="ps-tabs">
          <button class="ps-tab ps-active" type="button" data-tab="search" title="搜索" aria-label="搜索"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.8 18.1a7.3 7.3 0 1 1 0-14.6 7.3 7.3 0 0 1 0 14.6Z" stroke-width="2.2" stroke-linecap="round"/><path d="m16.2 16.2 4.3 4.3" stroke-width="2.2" stroke-linecap="round"/></svg></button>
          <button class="ps-tab" type="button" data-tab="history" title="历史" aria-label="历史"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.35-5.65" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 5.5v4h4" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 7.5V12l3 2" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
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
        <div class="ps-page" data-page="history"><div class="ps-history-list"></div><div class="ps-row ps-history-actions"><button class="ps-nav ps-clear-history" type="button" title="清空历史" aria-label="清空历史"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16" stroke-width="2.1" stroke-linecap="round"/><path d="M10 11v6M14 11v6" stroke-width="2.1" stroke-linecap="round"/><path d="M6 7l1 14h10l1-14" stroke-width="2.1" stroke-linejoin="round"/><path d="M9 7V4h6v3" stroke-width="2.1" stroke-linejoin="round"/></svg></button></div></div>
        <div class="ps-page" data-page="settings"></div>
      </div>
    `;
        document.documentElement.appendChild(el);
        applyAppearance();
        renderSettings();
        renderHistory();
        el.querySelector(".ps-toggle")?.addEventListener("click", (event) => { if (el.dataset.dragged === "true") {
            event.preventDefault();
            el.dataset.dragged = "";
            return;
        } openPanel("search"); });
        el.querySelector(".ps-close")?.addEventListener("click", () => { el.classList.remove("ps-open"); applyAppearance(); });
        el.querySelectorAll(".ps-tab").forEach((button) => button.addEventListener("click", () => switchTab(button.getAttribute("data-tab") || "search")));
        el.querySelector(".ps-search")?.addEventListener("click", search);
        el.querySelector(".ps-prev")?.addEventListener("click", () => go(-1));
        el.querySelector(".ps-next")?.addEventListener("click", () => go(1));
        el.querySelector(".ps-export")?.addEventListener("click", copyResult);
        el.querySelector(".ps-clear")?.addEventListener("click", () => { clear(); if (input())
            input().value = ""; setStatus("已清除高亮"); input()?.focus(); });
        el.querySelector(".ps-clear-history")?.addEventListener("click", () => { history = []; saveHistory(); });
        el.addEventListener("click", (event) => {
            const target = event.target instanceof Element ? event.target.closest(".ps-reset-position") : null;
            if (!target)
                return;
            config.floatingPosition = null;
            if (config.position === "topbar")
                config.position = "bottom";
            saveConfig();
            setStatus("悬浮位置已重置到右下角");
        });
        el.querySelector(".ps-input")?.addEventListener("keydown", (event) => { if (event.key === "Enter")
            search(); if (event.key === "Escape") {
            el.classList.remove("ps-open");
            applyAppearance();
        } });
        el.querySelector(".ps-result-list")?.addEventListener("click", (event) => {
            const target = event.target instanceof Element ? event.target.closest(".ps-result") : null;
            if (!target || target.hasAttribute("disabled"))
                return;
            jumpTo(Number(target.getAttribute("data-index")));
        });
        el.querySelector(".ps-history-list")?.addEventListener("click", (event) => {
            const target = event.target instanceof Element ? event.target.closest(".ps-history-item") : null;
            if (!target)
                return;
            const value = history[Number(target.getAttribute("data-index"))];
            if (input() && value)
                input().value = value;
            switchTab("search");
            search();
        });
        el.addEventListener("input", handleConfigChange);
        el.addEventListener("change", handleConfigChange);
        setupInputZoomGuard(el);
        setupDrag(el);
    };
    const setupDrag = (el) => {
        let dragging = false;
        let startX = 0;
        let startY = 0;
        let baseX = 0;
        let baseY = 0;
        let moved = false;
        let dragPointerId = null;
        const begin = (event) => {
            if (config.position === "topbar")
                return;
            const target = event.target instanceof Element ? event.target : null;
            if (!target?.closest(".ps-toggle, .ps-title"))
                return;
            if (target.closest(".ps-close, input, select, textarea, .ps-tab, .ps-nav, .ps-search, .ps-result, .ps-history-item"))
                return;
            const rect = el.getBoundingClientRect();
            dragging = true;
            moved = false;
            dragPointerId = event.pointerId;
            startX = event.clientX;
            startY = event.clientY;
            baseX = rect.left;
            baseY = rect.top;
            el.style.left = `${rect.left}px`;
            el.style.top = `${rect.top}px`;
            el.style.right = "auto";
            el.style.bottom = "auto";
            el.classList.add("ps-manual");
            target.setPointerCapture?.(event.pointerId);
            event.preventDefault();
            event.stopPropagation();
        };
        const move = (event) => {
            if (!dragging || (dragPointerId != null && event.pointerId !== dragPointerId))
                return;
            event.preventDefault();
            event.stopPropagation();
            const dx = event.clientX - startX;
            const dy = event.clientY - startY;
            if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5)
                return;
            moved = true;
            const pos = clampFloatingPosition({ x: baseX + dx, y: baseY + dy });
            if (!pos)
                return;
            el.style.left = `${pos.x}px`;
            el.style.top = `${pos.y}px`;
            el.style.right = "auto";
            el.style.bottom = "auto";
        };
        const end = (event) => {
            if (!dragging || (dragPointerId != null && event.pointerId !== dragPointerId))
                return;
            event.preventDefault();
            event.stopPropagation();
            dragging = false;
            dragPointerId = null;
            if (moved) {
                config.floatingPosition = clampFloatingPosition({ x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0 });
                el.dataset.dragged = "true";
                saveConfig();
                setTimeout(() => { el.dataset.dragged = ""; }, 350);
            }
        };
        el.addEventListener("pointerdown", begin);
        document.addEventListener("pointermove", move, true);
        document.addEventListener("pointerup", end, true);
        document.addEventListener("pointercancel", end, true);
    };
    const handleConfigChange = (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement))
            return;
        if (target.classList.contains("ps-config-position")) {
            config.position = target.value;
            if (target.value === "bottom")
                config.floatingPosition = null;
        }
        if (target.classList.contains("ps-config-glass"))
            config.glass = target.checked;
        if (target.classList.contains("ps-config-opacity"))
            config.opacity = clampNumber(target.value, 0, 100, defaultConfig.opacity);
        if (target.classList.contains("ps-config-blur"))
            config.blur = Number(target.value);
        if (target.classList.contains("ps-config-icon-scale"))
            config.iconScale = clampNumber(target.value, 1, 2, 1);
        if (target.classList.contains("ps-config-ui-width"))
            config.uiWidthScale = clampNumber(target.value, 1, 2, 1);
        if (target.classList.contains("ps-config-accent"))
            config.accentColor = target.value;
        if (target.classList.contains("ps-config-highlight"))
            config.highlightColor = target.value;
        if (target.classList.contains("ps-config-active"))
            config.activeColor = target.value;
        if (target.classList.contains("ps-config-case"))
            config.caseSensitive = target.checked;
        if (target.classList.contains("ps-config-regex"))
            config.regex = target.checked;
        if (target.classList.contains("ps-config-multi"))
            config.multiKeyword = target.checked;
        if (target.classList.contains("ps-config-iframes"))
            config.searchIframes = target.checked;
        if (target.classList.contains("ps-config-results"))
            config.showResults = target.checked;
        if (target.classList.contains("ps-config-shortcut-enabled"))
            config.shortcutEnabled = target.checked;
        if (target.classList.contains("ps-config-shortcut"))
            config.shortcutKey = (target.value || "k").slice(0, 1).toLowerCase();
        saveConfig();
        if (["ps-config-case", "ps-config-regex", "ps-config-multi", "ps-config-iframes"].some((cls) => target.classList.contains(cls)) && input()?.value.trim())
            search();
    };
    document.addEventListener("keydown", (event) => {
        if (!config.shortcutEnabled)
            return;
        if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey)
            return;
        if (event.key.toLowerCase() !== String(config.shortcutKey || "k").toLowerCase())
            return;
        event.preventDefault();
        openPanel("search");
    });
    const init = async () => {
        config = { ...defaultConfig, ...(await loadStored(STORAGE_KEY, {})) };
        config.opacity = clampNumber(config.opacity, 0, 100, defaultConfig.opacity);
        history = await loadStored(HISTORY_KEY, []);
        createPanel();
        GM.registerMenuCommand?.("打开页面关键字搜索", () => openPanel("search"));
        GM.registerMenuCommand?.("打开搜索历史", () => openPanel("history"));
        GM.registerMenuCommand?.("打开页面搜索配置", () => openPanel("settings"));
    };
    init();
})();
