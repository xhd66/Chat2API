/**
 * GLM (chatglm.cn) stream protocol helpers
 *
 * chatglm.cn 流式事件中 parts[].content[] 的文本字段存在两种形态:
 * - 增量 delta:字段只包含本次新增内容(当前线上协议)
 * - 全量快照:收尾事件(part.status === 'finish')携带该 part 截至目前的完整内容
 * reconcileDelta 统一兼容两种形态,避免把全文重复下发或把增量误当全量而截断词元。
 */

export interface GlmReconcileResult {
  /** 归并后该字段的完整内容 */
  state: string
  /** 本次需要下发的增量;快照对账无新内容时为空 */
  delta: string
}

/**
 * 按增量/全量两种语义归并文本。
 * @param accumulated 该字段已累积的完整内容
 * @param incoming 本事件携带的内容
 * @param isSnapshot true 表示 incoming 是全量快照(收尾对账),false 表示纯增量
 *
 * 快照语义仅由 part.status === 'finish' 触发(线上协议以此标记全量事件);
 * 其余事件按当前线上协议视为纯增量追加,不做猜测式判别。
 * 收尾快照的"整体替换"分支可修正任何前序累积误差(非流式场景)。
 */
export function reconcileDelta(accumulated: string, incoming: string, isSnapshot: boolean): GlmReconcileResult {
  if (!incoming) {
    return { state: accumulated, delta: '' }
  }
  if (isSnapshot) {
    if (incoming === accumulated) {
      return { state: accumulated, delta: '' }
    }
    if (incoming.startsWith(accumulated)) {
      return { state: incoming, delta: incoming.slice(accumulated.length) }
    }
    // 全量替换(累积内容对不上/上游编辑):以下发的流无法回撤,记录最新快照
    return { state: incoming, delta: '' }
  }
  return { state: accumulated + incoming, delta: incoming }
}

/** 单个 part(按 logic_id 区分)的流式累积状态 */
export interface GlmPartStreamState {
  logicId: string
  status: string
  text: string
  think: string
  code: string
  codeFenceOpened: boolean
  codeFenceClosed: boolean
  images: any[] | null
  imagesEmitted: boolean
  executionOutput: string | null
  executionEmitted: boolean
}

export function createGlmPartState(logicId: string): GlmPartStreamState {
  return {
    logicId,
    status: 'init',
    text: '',
    think: '',
    code: '',
    codeFenceOpened: false,
    codeFenceClosed: false,
    images: null,
    imagesEmitted: false,
    executionOutput: null,
    executionEmitted: false,
  }
}

/**
 * 联网搜索引用改写:完整形态如 【turn0search5】,可能被 SSE 分块切开。
 * 注意与 zai 适配器的教训:只在确实存在搜索结果(searchMap 非空)时才启用,
 * 扣留的尾部必须严格形如引用前缀,且流结束必定 flush,绝不吞正文。
 */
const GLM_SEARCH_CITATION_COMPLETE_RE = /【?(turn\d+[a-zA-Z]+\d+)】?/g
const GLM_SEARCH_CITATION_PARTIAL_RE = /(【turn\d{0,4}[a-zA-Z]{0,12}\d{0,4}|【|turn\d{1,4}[a-zA-Z]{0,12}\d{0,4})$/

export interface GlmCitationRewriter {
  /** match_key -> 搜索结果 */
  searchMap: Map<string, any>
  /** match_key -> 引用序号 */
  keyToIdMap: Map<string, number>
  counter: { value: number }
  /** 跨块扣留的引用前缀 */
  pending: string
}

export function createGlmCitationRewriter(): GlmCitationRewriter {
  return {
    searchMap: new Map(),
    keyToIdMap: new Map(),
    counter: { value: 1 },
    pending: '',
  }
}

/** 收集 tool_result parts 携带的搜索结果,供引用改写使用 */
export function collectGlmSearchResults(part: any, rewriter: GlmCitationRewriter): void {
  const searchResults = part?.meta_data?.tool_result_extra?.search_results
  if (!Array.isArray(searchResults)) {
    return
  }
  searchResults.forEach((res: any) => {
    if (res?.match_key) {
      rewriter.searchMap.set(res.match_key, res)
    }
  })
}

/** 对完整文本做引用改写(非流式/组装完成时使用) */
export function rewriteGlmCitations(text: string, rewriter: GlmCitationRewriter): string {
  if (rewriter.searchMap.size === 0) {
    return text
  }
  return text.replace(GLM_SEARCH_CITATION_COMPLETE_RE, (match: string, key: string) => {
    const searchInfo = rewriter.searchMap.get(key)
    if (!searchInfo) return match
    if (!rewriter.keyToIdMap.has(key)) {
      rewriter.keyToIdMap.set(key, rewriter.counter.value++)
    }
    return ` [${rewriter.keyToIdMap.get(key)}](${searchInfo.url})`
  })
}

/** 对文本增量做引用改写;跨块分裂的引用前缀先扣留,下个事件续上 */
export function processGlmCitations(delta: string, rewriter: GlmCitationRewriter): string {
  if (rewriter.searchMap.size === 0) {
    return delta
  }
  const work = rewriteGlmCitations(rewriter.pending + delta, rewriter)
  const partial = work.match(GLM_SEARCH_CITATION_PARTIAL_RE)
  if (partial) {
    rewriter.pending = partial[0]
    return work.slice(0, work.length - partial[0].length)
  }
  rewriter.pending = ''
  return work
}

/** 流结束前冲刷扣留的引用前缀;未命中搜索结果则原样输出,保证不丢字 */
export function flushGlmCitations(rewriter: GlmCitationRewriter): string {
  const rest = rewriter.pending
  rewriter.pending = ''
  return rest ? rewriteGlmCitations(rest, rewriter) : ''
}
