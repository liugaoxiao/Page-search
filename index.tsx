import {
  Button,
  Color,
  ColorPicker,
  fetch,
  GlassEffectContainer,
  HStack,
  Image,
  List,
  Navigation,
  NavigationStack,
  NamespaceReader,
  Picker,
  Script,
  Section,
  Slider,
  Spacer,
  Text,
  TextField,
  Toggle,
  VStack,
  ZStack,
  useEffect,
  useState,
} from "scripting"

// ─────────────────────────────────────────────────────────────
// 与浏览器脚本（browser.tsx / page-search.user.js）双向同步的存储层
//
// 机制：
// - 浏览器端通过 GM.getValue/GM.setValue 读写 storages/<脚本名>.json。
// - App 内通过 FileManager.safariBrowserStorageDirectory 直接读写同一个文件。
// - 配置对象带 updatedAt 时间戳，任何一端保存时刷新；加载时比较时间戳取最新。
// ─────────────────────────────────────────────────────────────

const CONFIG_KEY = "scripting-page-search-config-v4"
const HISTORY_KEY = "scripting-page-search-history-v1"
const HISTORY_LIMIT = 20

const defaultConfig = {
  position: "bottom",
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
  quickMode: false,
  floatingPosition: null as any,
  translateTarget: "zh-CN",
  translateBilingual: false,
  bilingualStyle: "below",
  translateProgressToast: true,
  translateEngine: "auto",
  aiBaseUrl: "",
  aiApiKey: "",
  aiModel: "gpt-4o-mini",
  updatedAt: 0,
}

type PageSearchConfig = typeof defaultConfig

const clampNumber = (value: any, min: number, max: number, fallback: number) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

const isHexColor = (value: any) => /^#[0-9a-f]{6}$/i.test(String(value || ""))

function normalizeConfig(value: any = {}): PageSearchConfig {
  const source = value && typeof value === "object" ? value : {}
  const next: any = { ...defaultConfig, ...source }
  if (!["bottom", "top", "topbar"].includes(next.position)) next.position = defaultConfig.position
  next.opacity = clampNumber(next.opacity, 0, 100, defaultConfig.opacity)
  next.blur = clampNumber(next.blur, 0, 35, defaultConfig.blur)
  next.iconScale = clampNumber(next.iconScale, 1, 2, defaultConfig.iconScale)
  next.uiWidthScale = clampNumber(next.uiWidthScale, 1, 2, defaultConfig.uiWidthScale)
  next.accentColor = isHexColor(next.accentColor) ? next.accentColor : defaultConfig.accentColor
  next.highlightColor = isHexColor(next.highlightColor) ? next.highlightColor : defaultConfig.highlightColor
  next.activeColor = isHexColor(next.activeColor) ? next.activeColor : defaultConfig.activeColor
  next.shortcutKey = (String(next.shortcutKey || defaultConfig.shortcutKey).slice(0, 1).toLowerCase() || defaultConfig.shortcutKey)
  next.floatingPosition = next.floatingPosition && typeof next.floatingPosition === "object" ? next.floatingPosition : null
  next.updatedAt = Number.isFinite(Number(next.updatedAt)) ? Number(next.updatedAt) : 0
  ;["caseSensitive", "regex", "multiKeyword", "searchIframes", "showResults", "glass", "shortcutEnabled", "translateBilingual", "translateProgressToast", "quickMode"].forEach((key) => {
    next[key] = !!next[key]
  })
  if (!["below", "underline", "block", "dashed", "quote", "none"].includes(next.bilingualStyle)) next.bilingualStyle = defaultConfig.bilingualStyle
  if (!TRANSLATE_LANGUAGES.some((l) => l.code === next.translateTarget)) next.translateTarget = defaultConfig.translateTarget
  if (!["auto", "edge", "apple", "google", "bing", "ai"].includes(next.translateEngine)) next.translateEngine = defaultConfig.translateEngine
  next.aiBaseUrl = String(next.aiBaseUrl || "").trim().replace(/\/+$/, "")
  next.aiApiKey = String(next.aiApiKey || "").trim()
  next.aiModel = String(next.aiModel || "").trim() || defaultConfig.aiModel
  return next as PageSearchConfig
}

function normalizeHistory(items: any): string[] {
  const seen = new Set<string>()
  return (Array.isArray(items) ? items : [])
    .map((item) => String(item || "").trim())
    .filter((item) => item && !seen.has(item) && seen.add(item))
    .slice(0, HISTORY_LIMIT)
}

function storeFilePath(): string {
  return `${FileManager.safariBrowserStorageDirectory}/${encodeURIComponent(Script.name)}.json`
}

async function readStore(): Promise<Record<string, any>> {
  try {
    const text = await FileManager.readAsString(storeFilePath())
    const json = JSON.parse(text)
    return json && typeof json === "object" ? json : {}
  } catch {
    return {}
  }
}

async function writeStore(store: Record<string, any>): Promise<void> {
  await FileManager.writeAsString(storeFilePath(), JSON.stringify(store))
}

async function loadConfigFromStore(): Promise<PageSearchConfig> {
  const store = await readStore()
  return normalizeConfig(store[CONFIG_KEY])
}

async function loadHistoryFromStore(): Promise<string[]> {
  const store = await readStore()
  return normalizeHistory(store[HISTORY_KEY])
}

async function saveConfigToStore(next: PageSearchConfig): Promise<void> {
  const store = await readStore()
  const existing = normalizeConfig(store[CONFIG_KEY])
  if (existing.updatedAt > next.updatedAt) return
  store[CONFIG_KEY] = next
  await writeStore(store)
}

async function saveHistoryToStore(next: string[]): Promise<void> {
  const store = await readStore()
  store[HISTORY_KEY] = normalizeHistory(next)
  await writeStore(store)
}

const formatScale = (value: any) => `${clampNumber(value, 1, 2, 1).toFixed(2).replace(/\.00$/, "").replace(/0$/, "")}×`

function formatSyncTime(updatedAt: number): string {
  if (!updatedAt) return "尚未同步"
  const date = new Date(updatedAt)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// ─────────────────────────────────────────────────────────────
// 翻译支持的语言
// ─────────────────────────────────────────────────────────────

const TRANSLATE_LANGUAGES: { code: string; name: string }[] = [
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

// ─────────────────────────────────────────────────────────────
// Tab 定义
// ─────────────────────────────────────────────────────────────

type TabKey = "appearance" | "search" | "translate"

const TABS: { key: TabKey; title: string; icon: string }[] = [
  { key: "appearance", title: "外观", icon: "paintpalette.fill" },
  { key: "search", title: "搜索", icon: "magnifyingglass" },
  { key: "translate", title: "翻译", icon: "character.bubble.fill" },
]

// ─────────────────────────────────────────────────────────────
// 页面一：外观设置
// ─────────────────────────────────────────────────────────────

function AppearancePage(props: {
  config: PageSearchConfig
  updateConfig: (patch: Partial<PageSearchConfig>) => void
  onResetPosition: () => void
}) {
  const { config, updateConfig, onResetPosition } = props
  return (
    <List>
      <Section title="悬浮按钮">
        <Picker title="显示位置" value={config.position} onChanged={(v: string) => updateConfig({ position: v })}>
          <Text tag="bottom">底部悬浮</Text>
          <Text tag="top">顶部悬浮</Text>
          <Text tag="topbar">顶部搜索条</Text>
        </Picker>
        <HStack>
          <VStack alignment="leading">
            <Text>手动位置</Text>
            <Text font="caption" foregroundStyle={"gray" as Color}>
              {config.floatingPosition ? "已在浏览器中保存拖动位置" : "未手动移动，默认右下角悬浮"}
            </Text>
          </VStack>
          <Spacer />
          <Button title="重置" action={onResetPosition} />
        </HStack>
        <Toggle title="简介模式" value={config.quickMode} onChanged={(v: boolean) => updateConfig({ quickMode: v })} />
        <Text font="caption" foregroundStyle={"gray" as Color}>
          开启后 Safari 中的悬浮图标变为齿轮对勾样式，点击向左滑出「搜索 / 翻译 / 设置」三个快捷按钮。
        </Text>
      </Section>

      <Section title="材质与尺寸">
        <Toggle title="磨砂玻璃 UI" value={config.glass} onChanged={(v: boolean) => updateConfig({ glass: v })} />
        <VStack alignment="leading">
          <HStack>
            <Text>透明度</Text>
            <Spacer />
            <Text foregroundStyle={"gray" as Color}>{config.opacity}%</Text>
          </HStack>
          <Slider min={0} max={100} step={1} value={config.opacity} onChanged={(v: number) => updateConfig({ opacity: Math.round(v) })} />
        </VStack>
        <VStack alignment="leading">
          <HStack>
            <Text>模糊强度</Text>
            <Spacer />
            <Text foregroundStyle={"gray" as Color}>{config.blur}px</Text>
          </HStack>
          <Slider min={0} max={35} step={1} value={config.blur} onChanged={(v: number) => updateConfig({ blur: Math.round(v) })} />
        </VStack>
        <VStack alignment="leading">
          <HStack>
            <Text>图标放大</Text>
            <Spacer />
            <Text foregroundStyle={"gray" as Color}>{formatScale(config.iconScale)}</Text>
          </HStack>
          <Slider min={1} max={2} step={0.05} value={config.iconScale} onChanged={(v: number) => updateConfig({ iconScale: v })} />
        </VStack>
        <VStack alignment="leading">
          <HStack>
            <Text>UI 横向拓宽</Text>
            <Spacer />
            <Text foregroundStyle={"gray" as Color}>{formatScale(config.uiWidthScale)}</Text>
          </HStack>
          <Slider min={1} max={2} step={0.05} value={config.uiWidthScale} onChanged={(v: number) => updateConfig({ uiWidthScale: v })} />
        </VStack>
      </Section>

      <Section title="颜色">
        <ColorPicker title="主题色" value={config.accentColor as Color} onChanged={(v: Color) => updateConfig({ accentColor: String(v) })} />
        <ColorPicker title="高亮颜色" value={config.highlightColor as Color} onChanged={(v: Color) => updateConfig({ highlightColor: String(v) })} />
        <ColorPicker title="当前结果颜色" value={config.activeColor as Color} onChanged={(v: Color) => updateConfig({ activeColor: String(v) })} />
      </Section>

      <Section title="快捷键">
        <Toggle title="快捷键打开" value={config.shortcutEnabled} onChanged={(v: boolean) => updateConfig({ shortcutEnabled: v })} />
        <HStack>
          <Text>快捷键字母</Text>
          <Spacer />
          <Picker
            title="快捷键字母"
            value={config.shortcutKey}
            onChanged={(v: string) => updateConfig({ shortcutKey: v })}
            pickerStyle="menu"
          >
            {["k", "f", "s", "g", "j", "h", "l", "p", "m", "n"].map((letter) => (
              <Text key={letter} tag={letter}>{letter.toUpperCase()}</Text>
            ))}
          </Picker>
        </HStack>
        <Text font="caption" foregroundStyle={"gray" as Color}>在 Safari 页面中按 Option/Alt + 快捷键字母打开搜索面板。</Text>
      </Section>
    </List>
  )
}

// ─────────────────────────────────────────────────────────────
// 页面二：搜索行为 + 历史
// ─────────────────────────────────────────────────────────────

function SearchPage(props: {
  config: PageSearchConfig
  updateConfig: (patch: Partial<PageSearchConfig>) => void
  history: string[]
  onRemoveHistory: (item: string) => void
  onClearHistory: () => void
}) {
  const { config, updateConfig, history, onRemoveHistory, onClearHistory } = props
  return (
    <List>
      <Section title="搜索行为">
        <Toggle title="区分大小写" value={config.caseSensitive} onChanged={(v: boolean) => updateConfig({ caseSensitive: v })} />
        <Toggle title="正则搜索" value={config.regex} onChanged={(v: boolean) => updateConfig({ regex: v })} />
        <Toggle title="多关键字" value={config.multiKeyword} onChanged={(v: boolean) => updateConfig({ multiKeyword: v })} />
        <Toggle title="搜索同源 iframe" value={config.searchIframes} onChanged={(v: boolean) => updateConfig({ searchIframes: v })} />
        <Toggle title="显示搜索结果列表" value={config.showResults} onChanged={(v: boolean) => updateConfig({ showResults: v })} />
      </Section>

      <Section title="搜索历史">
        {history.length === 0 ? (
          <Text foregroundStyle={"gray" as Color}>暂无搜索历史</Text>
        ) : (
          history.map((item, index) => (
            <HStack key={`${index}-${item}`}>
              <Text lineLimit={1}>{item}</Text>
              <Spacer />
              <Button title="删除" action={() => onRemoveHistory(item)} />
            </HStack>
          ))
        )}
        {history.length > 0 ? (
          <Button title="清空全部历史" action={onClearHistory} />
        ) : null}
        <Text font="caption" foregroundStyle={"gray" as Color}>与 Safari 浏览器端共用同一份历史记录（最多 {HISTORY_LIMIT} 条），任一端修改都会同步。</Text>
      </Section>
    </List>
  )
}

// ─────────────────────────────────────────────────────────────
// 页面三：网页全局翻译设置（与 Safari 面板中的翻译页双向同步）
// ─────────────────────────────────────────────────────────────

function TranslatePage(props: {
  config: PageSearchConfig
  updateConfig: (patch: Partial<PageSearchConfig>) => void
}) {
  const { config, updateConfig } = props
  const targetName = TRANSLATE_LANGUAGES.find((l) => l.code === config.translateTarget)?.name || config.translateTarget
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState("")
  const [fetchingModels, setFetchingModels] = useState(false)
  const [modelList, setModelList] = useState<string[]>([])
  const aiReady = !!(config.aiBaseUrl && config.aiApiKey)

  const fetchModels = async () => {
    setFetchingModels(true)
    setModelList([])
    setTestResult("")
    try {
      const response = await fetch(`${config.aiBaseUrl}/models`, {
        headers: { Authorization: `Bearer ${config.aiApiKey}` },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = await response.json()
      const list = Array.isArray((json as any)?.data) ? (json as any).data : []
      const ids = list.map((item: any) => String(item?.id || "")).filter(Boolean)
      if (!ids.length) throw new Error("未获取到模型")
      setModelList(ids)
    } catch (error: any) {
      setTestResult(`拉取模型失败：${error?.message || error}`)
    } finally {
      setFetchingModels(false)
    }
  }

  const testConnection = async () => {
    setTesting(true)
    setTestResult("")
    try {
      const url = `${config.aiBaseUrl}/chat/completions`
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.aiApiKey}`,
        },
        body: JSON.stringify({
          model: config.aiModel,
          messages: [
            { role: "system", content: "You are a translator. Output only the translation." },
            { role: "user", content: `Translate "Hello" into ${targetName}.` },
          ],
          temperature: 0.3,
          reasoning_effort: "none",
        }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = await response.json()
      const text = String((json as any)?.choices?.[0]?.message?.content || "").trim()
      setTestResult(text ? `连接成功：Hello → ${text}` : "连接成功，但返回为空")
    } catch (error: any) {
      setTestResult(`连接失败：${error?.message || error}`)
    } finally {
      setTesting(false)
    }
  }

  return (
    <List>
      <Section title="网页全局翻译">
        <HStack>
          <Text>翻译引擎</Text>
          <Spacer />
          <Picker
            title="翻译引擎"
            value={config.translateEngine}
            onChanged={(v: string) => updateConfig({ translateEngine: v })}
            pickerStyle="menu"
          >
            <Text tag="auto">自动（按健康状态选择）</Text>
            <Text tag="ai">AI 翻译</Text>
            <Text tag="edge">微软翻译（Edge·免密钥）</Text>
            <Text tag="apple">Apple 翻译</Text>
            <Text tag="bing">必应翻译（国内可用）</Text>
            <Text tag="google">Google 翻译</Text>
          </Picker>
        </HStack>
        <HStack>
          <Text>目标语言</Text>
          <Spacer />
          <Picker
            title="目标语言"
            value={config.translateTarget}
            onChanged={(v: string) => updateConfig({ translateTarget: v })}
            pickerStyle="menu"
          >
            {TRANSLATE_LANGUAGES.map((lang) => (
              <Text key={lang.code} tag={lang.code}>{lang.name}</Text>
            ))}
          </Picker>
        </HStack>
        <Toggle
          title="双语对照"
          value={config.translateBilingual}
          onChanged={(v: boolean) => updateConfig({ translateBilingual: v })}
        />
        <HStack>
          <Text>译文样式</Text>
          <Spacer />
          <Picker
            title="译文样式"
            value={config.bilingualStyle}
            onChanged={(v: string) => updateConfig({ bilingualStyle: v })}
            pickerStyle="menu"
          >
            <Text tag="below">独立下方（默认）</Text>
            <Text tag="underline">下划线</Text>
            <Text tag="block">整块显示</Text>
            <Text tag="dashed">虚线边框</Text>
            <Text tag="quote">引用颜色</Text>
            <Text tag="none">无样式</Text>
          </Picker>
        </HStack>
        <Toggle
          title="翻译进度提示"
          value={config.translateProgressToast}
          onChanged={(v: boolean) => updateConfig({ translateProgressToast: v })}
        />
      </Section>

      <Section title="AI 接口配置（中转 API）">
        <TextField
          title="Base URL"
          prompt="https://api.openai.com/v1"
          value={config.aiBaseUrl}
          onChanged={(v: string) => updateConfig({ aiBaseUrl: v })}
        />
        <TextField
          title="API Key"
          prompt="sk-…"
          value={config.aiApiKey}
          onChanged={(v: string) => updateConfig({ aiApiKey: v })}
        />
        <TextField
          title="模型"
          prompt="gpt-4o-mini / deepseek-v4-flash …"
          value={config.aiModel}
          onChanged={(v: string) => updateConfig({ aiModel: v })}
        />
        <HStack>
          <Button
            title={testing ? "测试中…" : "测试连接"}
            action={() => void testConnection()}
            disabled={testing || fetchingModels || !aiReady}
            buttonStyle="glassProminent"
            tint="blue"
          />
          <Button
            title={fetchingModels ? "拉取中…" : "拉取模型"}
            action={() => void fetchModels()}
            disabled={testing || fetchingModels || !aiReady}
            buttonStyle="glass"
          />
        </HStack>
        {modelList.length ? (
          <HStack>
            <Text font="caption" foregroundStyle={"gray" as Color}>模型</Text>
            <Spacer />
            <Picker
              title="选择模型"
              value={config.aiModel}
              onChanged={(v: string) => updateConfig({ aiModel: v })}
              pickerStyle="menu"
            >
              {modelList.map((m) => (
                <Text key={m} tag={m}>{m}</Text>
              ))}
            </Picker>
          </HStack>
        ) : null}
        {testResult ? (
          <Text font="caption" foregroundStyle={"gray" as Color}>{testResult}</Text>
        ) : null}
      </Section>
    </List>
  )
}

// ─────────────────────────────────────────────────────────────
// 主视图：iOS 26 Liquid Glass 胶囊导航
// ─────────────────────────────────────────────────────────────

export default function MainView() {
  const dismiss = Navigation.useDismiss()
  const [tab, setTab] = useState<TabKey>("appearance")
  const [config, setConfig] = useState<PageSearchConfig>(defaultConfig)
  const [history, setHistory] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [suppressSave, setSuppressSave] = useState(true)

  const reload = async () => {
    setSuppressSave(true)
    const [cfg, his] = await Promise.all([loadConfigFromStore(), loadHistoryFromStore()])
    setConfig(cfg)
    setHistory(his)
    setLoaded(true)
    setTimeout(() => setSuppressSave(false), 50)
  }

  useEffect(() => {
    void reload()
  }, [])

  const updateConfig = (patch: Partial<PageSearchConfig>) => {
    setConfig((prev) => {
      const next = normalizeConfig({ ...prev, ...patch, updatedAt: Date.now() })
      if (!suppressSave) void saveConfigToStore(next)
      return next
    })
  }

  const resetPosition = () => {
    updateConfig({
      floatingPosition: null,
      position: config.position === "topbar" ? "bottom" : config.position,
    })
    void Dialog.alert({ title: "已重置", message: "悬浮按钮位置已重置到右下角" })
  }

  const removeHistoryItem = async (item: string) => {
    const next = history.filter((h) => h !== item)
    setHistory(next)
    await saveHistoryToStore(next)
  }

  const clearHistory = async () => {
    const ok = await Dialog.confirm({ title: "清空搜索历史", message: "将删除全部搜索历史记录，且与浏览器端同步。", confirmLabel: "清空", cancelLabel: "取消" })
    if (!ok) return
    setHistory([])
    await saveHistoryToStore([])
  }

  const tabTitle = TABS.find((t) => t.key === tab)?.title || ""

  return (
    <NavigationStack>
      <ZStack
        alignment="bottom"
        navigationTitle={tabTitle}
        navigationBarTitleDisplayMode="inline"
        toolbar={{
          cancellationAction: <Button title="完成" action={dismiss} />,
          primaryAction: (
            <HStack>
              <Text font="caption" foregroundStyle={"gray" as Color}>
                {loaded ? formatSyncTime(config.updatedAt) : "…"}
              </Text>
              <Button title="重新读取" systemImage="arrow.clockwise" action={() => void reload()} />
            </HStack>
          ),
        }}
      >
        {/* 页面内容（带淡入淡出过渡） */}
        <VStack
          key={tab}
          animation={{ animation: Animation.spring({ response: 0.3, dampingFraction: 0.85 }), value: tab }}
        >
          {tab === "appearance" ? (
            <AppearancePage config={config} updateConfig={updateConfig} onResetPosition={resetPosition} />
          ) : tab === "search" ? (
            <SearchPage
              config={config}
              updateConfig={updateConfig}
              history={history}
              onRemoveHistory={(item) => void removeHistoryItem(item)}
              onClearHistory={() => void clearHistory()}
            />
          ) : (
            <TranslatePage config={config} updateConfig={updateConfig} />
          )}
        </VStack>

        {/* iOS 26 Liquid Glass 底部胶囊导航（带 matchedGeometry 平滑过渡） */}
        <HStack padding={{ horizontal: 24, bottom: 8 }}>
          <Spacer />
          <NamespaceReader>
            {(ns) => (
              <GlassEffectContainer spacing={8}>
                <HStack
                  padding={{ horizontal: 8, vertical: 8 }}
                  glassEffect={{
                    glass: UIGlass.regular().interactive(),
                    shape: "capsule",
                  }}
                >
                  {TABS.map((t) => {
                    const active = tab === t.key
                    const accent = (config.accentColor || "#2563eb") as Color
                    return (
                      <Button
                        key={t.key}
                        action={() => {
                          // 用 spring 动画让激活指示器平滑滑动过去
                          void withAnimation(Animation.spring({ response: 0.35, dampingFraction: 0.7 }), () => {
                            setTab(t.key)
                          })
                        }}
                      >
                        <HStack
                          padding={{ horizontal: 16, vertical: 10 }}
                          glassEffect={active ? {
                            glass: UIGlass.regular().tint(accent),
                            shape: "capsule",
                          } : undefined}
                          glassEffectID={active ? { id: "tab-pill", namespace: ns } : undefined}
                          glassEffectTransition="matchedGeometry"
                        >
                          <Image
                            systemName={t.icon}
                            font="body"
                            foregroundStyle={active ? ("white" as Color) : ("gray" as Color)}
                          />
                          {active ? (
                            <Text font="subheadline" foregroundStyle={"white" as Color}>{t.title}</Text>
                          ) : null}
                        </HStack>
                      </Button>
                    )
                  })}
                </HStack>
              </GlassEffectContainer>
            )}
          </NamespaceReader>
          <Spacer />
        </HStack>
      </ZStack>
    </NavigationStack>
  )
}

async function run() {
  await Navigation.present(<MainView />)
  Script.exit()
}

run()
