import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getModelRegistryApi, refreshModelRegistryApi } from '@/utils/http_apis'

/**
 * 公共端点配置
 * DRY 原则：避免重复定义相同的端点列表
 */
const ENDPOINTS = {
  // Claude 兼容端点（官方、Console、Bedrock、CCR、Antigravity）
  CLAUDE: ['/api/v1/messages', '/claude/v1/messages'],
  // Gemini 原生端点
  GEMINI: ['/gemini/v1/models/{model}:generateContent'],
  // OpenAI 标准端点
  OPENAI: ['/openai/v1/chat/completions'],
  // Droid 复合端点
  DROID: ['/droid/claude/v1/messages', '/droid/openai/v1/chat/completions']
}

/**
 * 模型池配置映射
 *
 * 此配置定义了模型注册表中各账户类型的显示信息和端点。
 * 每个条目对应一种账户类型（由 owned_by/oauthProvider 标识）。
 *
 * 注意：
 * - icon 使用完整类名（fas/fab 前缀），因为品牌图标需要 fab
 * - 未知的池类型会自动回退到 getPoolConfig() 的默认配置
 * - 参考：modelRegistryService.js - 后端如何发现和发布模型
 */
const POOL_CONFIG = {
  // === Claude 系列 ===
  'claude-official': {
    name: 'Claude Official',
    icon: 'fas fa-cloud',
    color: 'orange',
    description: 'Claude OAuth 账户',
    endpoints: ENDPOINTS.CLAUDE
  },
  'claude-console': {
    name: 'Claude Console',
    icon: 'fas fa-terminal',
    color: 'purple',
    description: 'Claude Console API 账户',
    endpoints: ENDPOINTS.CLAUDE
  },
  bedrock: {
    name: 'AWS Bedrock',
    icon: 'fab fa-aws',
    color: 'yellow',
    description: 'AWS Bedrock 账户',
    endpoints: ENDPOINTS.CLAUDE
  },
  ccr: {
    name: 'CCR',
    icon: 'fas fa-server',
    color: 'blue',
    description: 'CCR 账户',
    endpoints: ENDPOINTS.CLAUDE
  },
  // Antigravity: Gemini OAuth 的特殊变体
  // - 在后端被识别为 oauthProvider === 'antigravity'
  // - 支持 Claude 兼容的 API 端点
  // - 在前端账户管理中称为 'gemini-antigravity' 平台
  // 参考：src/services/modelRegistryService.js:144-183
  antigravity: {
    name: 'Antigravity',
    icon: 'fab fa-google',
    color: 'indigo',
    description: 'Google Gemini Antigravity OAuth 账户',
    endpoints: ENDPOINTS.CLAUDE
  },

  // === Gemini 系列 ===
  gemini: {
    name: 'Gemini',
    icon: 'fab fa-google',
    color: 'cyan',
    description: 'Google Gemini OAuth 账户',
    endpoints: ENDPOINTS.GEMINI
  },
  'gemini-api': {
    name: 'Gemini API',
    icon: 'fas fa-key',
    color: 'teal',
    description: 'Gemini API Key 账户',
    endpoints: ENDPOINTS.GEMINI
  },

  // === OpenAI 系列 ===
  'openai-responses': {
    name: 'OpenAI Responses',
    icon: 'fas fa-robot',
    color: 'green',
    description: 'OpenAI Responses (Codex) 账户',
    endpoints: ['/openai/v1/chat/completions', '/openai/v1/responses']
  },
  openai: {
    name: 'OpenAI',
    icon: 'fas fa-brain',
    color: 'emerald',
    description: 'OpenAI 兼容账户',
    endpoints: ENDPOINTS.OPENAI
  },

  // === Azure 系列 ===
  'azure-openai': {
    name: 'Azure OpenAI',
    icon: 'fab fa-microsoft',
    color: 'blue',
    description: 'Azure OpenAI 账户',
    endpoints: ['/azure/openai/deployments/{deployment}/chat/completions']
  },

  // === Droid 系列 ===
  droid: {
    name: 'Droid',
    icon: 'fab fa-android',
    color: 'lime',
    description: 'Factory.ai Droid 账户',
    endpoints: ENDPOINTS.DROID
  }
}

/**
 * 获取池配置
 *
 * 返回指定池 ID 的配置。如果池类型未知，返回默认配置（灰色问号图标）。
 * 这确保 UI 始终有合理的回退，而不是崩溃。
 *
 * @param {string} poolId - 池标识符（通常来自 model.owned_by 或 account.oauthProvider）
 * @returns {Object} 池配置对象
 */
function getPoolConfig(poolId) {
  return (
    POOL_CONFIG[poolId] || {
      name: poolId,
      icon: 'fas fa-question-circle',
      color: 'gray',
      description: '未知账户类型',
      endpoints: []
    }
  )
}

export const useModelsStore = defineStore('models', () => {
  // ==================== 状态 ====================
  const rawModels = ref([])
  const status = ref(null)
  const loading = ref(false)
  const refreshing = ref(false)
  const error = ref(null)
  const lastFetchTime = ref(null)

  // 搜索和过滤
  const searchQuery = ref('')
  const poolFilter = ref('all')

  // 展开状态
  const expandedPools = ref(new Set())

  // ==================== 计算属性 ====================

  // 按池分组
  const groupedByPool = computed(() => {
    const groups = {}

    for (const model of rawModels.value) {
      const poolId = model.owned_by || 'unknown'

      if (!groups[poolId]) {
        const config = getPoolConfig(poolId)
        groups[poolId] = {
          poolId,
          ...config,
          models: [],
          modelCount: 0
        }
      }

      groups[poolId].models.push(model)
      groups[poolId].modelCount++
    }

    // 转换为数组并排序
    return Object.values(groups).sort((a, b) => {
      // 按模型数量降序排列
      return b.modelCount - a.modelCount
    })
  })

  // 过滤后的池列表
  const filteredPools = computed(() => {
    let pools = groupedByPool.value

    // 池过滤
    if (poolFilter.value !== 'all') {
      pools = pools.filter((p) => p.poolId === poolFilter.value)
    }

    // 搜索过滤
    if (searchQuery.value.trim()) {
      const query = searchQuery.value.toLowerCase().trim()
      pools = pools
        .map((pool) => {
          const filteredModels = pool.models.filter(
            (m) =>
              m.id.toLowerCase().includes(query) ||
              (m.permission && m.permission.toLowerCase().includes(query))
          )

          if (filteredModels.length === 0) {
            return null
          }

          return {
            ...pool,
            models: filteredModels,
            modelCount: filteredModels.length
          }
        })
        .filter(Boolean)
    }

    return pools
  })

  // 可用的池列表（用于过滤下拉框）
  const availablePools = computed(() => {
    return groupedByPool.value.map((p) => ({
      value: p.poolId,
      label: p.name,
      count: p.modelCount
    }))
  })

  // 汇总统计
  const summary = computed(() => {
    return {
      totalModels: rawModels.value.length,
      totalPools: groupedByPool.value.length,
      filteredModels: filteredPools.value.reduce((sum, p) => sum + p.modelCount, 0),
      filteredPools: filteredPools.value.length,
      lastUpdated: status.value?.lastUpdated || lastFetchTime.value
    }
  })

  // ==================== 方法 ====================

  // 获取模型列表
  async function fetchModels() {
    if (loading.value) return

    loading.value = true
    error.value = null

    try {
      const response = await getModelRegistryApi()

      if (response.success) {
        rawModels.value = response.models || []
        status.value = response.status || null
        lastFetchTime.value = new Date().toISOString()

        // 默认展开所有池
        expandedPools.value = new Set(groupedByPool.value.map((p) => p.poolId))
      } else {
        throw new Error(response.message || '获取模型列表失败')
      }
    } catch (err) {
      console.error('Failed to fetch models:', err)
      error.value = err.message || '获取模型列表失败'
    } finally {
      loading.value = false
    }
  }

  // 刷新模型列表
  async function refreshModels() {
    if (refreshing.value) return

    refreshing.value = true
    error.value = null

    try {
      const response = await refreshModelRegistryApi()

      if (response.success) {
        rawModels.value = response.models || []
        status.value = response.status || null
        lastFetchTime.value = new Date().toISOString()

        // 更新展开状态
        const currentExpanded = new Set(expandedPools.value)
        const newPools = groupedByPool.value.map((p) => p.poolId)
        expandedPools.value = new Set(newPools.filter((p) => currentExpanded.has(p)))
      } else {
        throw new Error(response.message || '刷新模型列表失败')
      }
    } catch (err) {
      console.error('Failed to refresh models:', err)
      error.value = err.message || '刷新模型列表失败'
    } finally {
      refreshing.value = false
    }
  }

  // 切换池展开状态
  function togglePool(poolId) {
    const newSet = new Set(expandedPools.value)
    if (newSet.has(poolId)) {
      newSet.delete(poolId)
    } else {
      newSet.add(poolId)
    }
    expandedPools.value = newSet
  }

  // 展开所有池
  function expandAll() {
    expandedPools.value = new Set(groupedByPool.value.map((p) => p.poolId))
  }

  // 折叠所有池
  function collapseAll() {
    expandedPools.value = new Set()
  }

  // 检查池是否展开
  function isPoolExpanded(poolId) {
    return expandedPools.value.has(poolId)
  }

  // 设置搜索查询
  function setSearchQuery(query) {
    searchQuery.value = query
  }

  // 设置池过滤
  function setPoolFilter(filter) {
    poolFilter.value = filter
  }

  // 清除过滤
  function clearFilters() {
    searchQuery.value = ''
    poolFilter.value = 'all'
  }

  // ==================== 返回 ====================
  return {
    // 状态
    rawModels,
    status,
    loading,
    refreshing,
    error,
    lastFetchTime,
    searchQuery,
    poolFilter,
    expandedPools,

    // 计算属性
    groupedByPool,
    filteredPools,
    availablePools,
    summary,

    // 方法
    fetchModels,
    refreshModels,
    togglePool,
    expandAll,
    collapseAll,
    isPoolExpanded,
    setSearchQuery,
    setPoolFilter,
    clearFilters,

    // 工具函数
    getPoolConfig
  }
})
