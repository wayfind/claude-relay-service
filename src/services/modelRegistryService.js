const logger = require('../utils/logger')

/**
 * 模型注册表服务
 * 根据 v3 设计文档实现统一模型路由
 *
 * 设计原则：
 * 1. 不猜测 - 让账户告诉你它支持什么模型
 * 2. 不模糊 - 每个决策都有明确策略
 * 3. 错误有用 - 告诉用户怎么解决，不只是出了什么问题
 */

// 刷新间隔：5 分钟
const REFRESH_INTERVAL = 5 * 60 * 1000

// 池默认权限（兜底）
const POOL_DEFAULT_PERMISSION = {
  'claude-official': 'claude',
  antigravity: 'claude',
  gemini: 'gemini',
  bedrock: 'claude',
  ccr: 'claude',
  'claude-console': 'claude',
  droid: 'claude',
  'openai-responses': 'openai',
  'azure-openai': 'openai'
}

class ModelRegistryService {
  constructor() {
    // model -> { pools: [{ pool, accountId, priority }], permission }
    this.registry = new Map()
    this.refreshTimer = null
    this.initialized = false
    this.lastRefreshTime = null
    this.lastRefreshError = null

    // 防抖刷新：避免短时间内多次刷新（如批量导入账户）
    this._pendingRefresh = null
    this._refreshDebounceMs = 2000 // 2秒防抖
  }

  /**
   * 请求刷新（防抖）
   * 多次调用会合并为一次刷新，避免刷新风暴
   */
  scheduleRefresh() {
    if (this._pendingRefresh) {
      return this._pendingRefresh
    }

    this._pendingRefresh = new Promise((resolve) => {
      setTimeout(async () => {
        try {
          await this.refreshAll()
          logger.info('🔄 ModelRegistryService refreshed (debounced)')
        } catch (err) {
          logger.warn('Failed to refresh ModelRegistryService', { error: err.message })
        } finally {
          this._pendingRefresh = null
          resolve()
        }
      }, this._refreshDebounceMs)
    })

    return this._pendingRefresh
  }

  /**
   * 初始化服务
   * 启动失败时记录日志，空注册表运行，等下次刷新
   */
  async initialize() {
    try {
      await this.refreshAll()
      this._startPeriodicRefresh()
      this.initialized = true
      logger.success(`ModelRegistryService initialized with ${this.registry.size} models`)
    } catch (err) {
      this.lastRefreshError = err.message
      logger.error('ModelRegistryService initialization failed, running with empty registry', {
        error: err.message
      })
      // 仍然启动定时刷新，等待下次成功
      this._startPeriodicRefresh()
      this.initialized = true
    }
  }

  /**
   * 启动定时刷新
   */
  _startPeriodicRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
    }
    this.refreshTimer = setInterval(() => {
      this.refreshAll().catch((err) => {
        this.lastRefreshError = err.message
        logger.error('Failed to refresh model registry', { error: err.message })
      })
    }, REFRESH_INTERVAL)
  }

  /**
   * 关闭服务
   */
  shutdown() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    logger.info('ModelRegistryService shutdown')
  }

  /**
   * 全量刷新注册表
   */
  async refreshAll() {
    const newRegistry = new Map()

    // 并行加载各池的模型
    await Promise.all([
      this._loadAntigravityModels(newRegistry),
      this._loadClaudeOfficialModels(newRegistry),
      this._loadGeminiModels(newRegistry),
      this._loadBedrockModels(newRegistry),
      this._loadCcrModels(newRegistry)
    ])

    // 对每个模型的 pools 按 priority 排序
    for (const [_model, entry] of newRegistry) {
      entry.pools.sort((a, b) => a.priority - b.priority)
    }

    this.registry = newRegistry
    this.lastRefreshTime = new Date().toISOString()
    this.lastRefreshError = null

    logger.info(`Model registry refreshed: ${this.registry.size} models`)
  }

  /**
   * 加载 Antigravity 模型
   */
  async _loadAntigravityModels(registry) {
    try {
      const geminiAccountService = require('./geminiAccountService')
      const accounts = await geminiAccountService.getAllAccounts()

      logger.debug(`Found ${accounts.length} Gemini accounts for Antigravity check`)

      for (const account of accounts) {
        // 只处理 antigravity 账户
        if (account.oauthProvider !== 'antigravity') {
          continue
        }

        logger.debug(
          `Checking Antigravity account: ${account.id}, status=${account.status}, schedulable=${account.schedulable}`
        )

        if (account.status !== 'active' || account.schedulable === false) {
          continue
        }

        // 获取账户支持的模型
        const models = await this._fetchAntigravityAccountModels(account)

        logger.debug(`Antigravity account ${account.id} returned ${models.length} models`)

        for (const modelId of models) {
          this._registerModel(registry, modelId, {
            pool: 'antigravity',
            accountId: account.id,
            priority: account.priority || 50,
            defaultPermission: account.defaultPermission,
            permissionOverrides: account.permissionOverrides
          })
        }
      }
    } catch (err) {
      logger.error('Failed to load Antigravity models', { error: err.message })
    }
  }

  /**
   * 获取 Antigravity 账户的模型列表
   */
  async _fetchAntigravityAccountModels(account) {
    try {
      const geminiAccountService = require('./geminiAccountService')
      // 使用 getAccount 获取解密后的 token
      const accountData = await geminiAccountService.getAccount(account.id)
      if (!accountData || !accountData.accessToken) {
        logger.warn(`Antigravity account ${account.id} has no accessToken`)
        return []
      }

      logger.debug(
        `Fetching models for Antigravity account ${account.id}, hasRefreshToken=${!!accountData.refreshToken}`
      )

      // 使用 fetchAvailableModelsAntigravity，它会自动刷新 token
      const data = await geminiAccountService.fetchAvailableModelsAntigravity(
        accountData.accessToken,
        accountData.proxy,
        accountData.refreshToken
      )

      logger.debug(`Antigravity API response: ${JSON.stringify(data).substring(0, 200)}...`)

      const models = []

      // fetchAvailableModelsAntigravity 返回的是数组格式 [{id, object, ...}, ...]
      if (Array.isArray(data)) {
        for (const modelObj of data) {
          if (modelObj && modelObj.id) {
            models.push(modelObj.id)
          }
        }
      } else if (data?.models && typeof data.models === 'object') {
        // 兼容旧格式 { models: {...} }
        for (const modelId of Object.keys(data.models)) {
          models.push(modelId)
        }
      }

      return [...new Set(models)]
    } catch (err) {
      logger.warn(`Failed to fetch models for Antigravity account ${account.id}`, {
        error: err.message
      })
      return []
    }
  }

  /**
   * 加载 Claude 官方模型（包括 OAuth 和 Console 账户）
   */
  async _loadClaudeOfficialModels(registry) {
    // Claude 官方支持的模型列表（兜底）
    const defaultClaudeModels = [
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-1-20250805',
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'claude-3-7-sonnet-20250219',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
      'claude-3-haiku-20240307'
    ]

    // 1. 加载 Claude OAuth 账户（使用固定列表）
    try {
      const claudeAccountService = require('./claudeAccountService')
      const accounts = await claudeAccountService.getAllAccounts()

      for (const account of accounts) {
        if (account.status !== 'active') {
          continue
        }

        const supportedModels = this._filterModelsBySubscription(
          defaultClaudeModels,
          account.subscriptionInfo
        )

        for (const modelId of supportedModels) {
          this._registerModel(registry, modelId, {
            pool: 'claude-official',
            accountId: account.id,
            priority: account.priority || 50,
            defaultPermission: 'claude'
          })
        }
      }
    } catch (err) {
      logger.error('Failed to load Claude OAuth models', { error: err.message })
    }

    // 2. 加载 Claude Console 账户（动态模型发现）
    try {
      const claudeConsoleAccountService = require('./claudeConsoleAccountService')
      const accounts = await claudeConsoleAccountService.getAllAccounts()

      for (const account of accounts) {
        if (account.status !== 'active') {
          continue
        }

        // 动态获取模型列表，失败时使用默认列表
        const models = await this._fetchClaudeConsoleModels(account, defaultClaudeModels)

        for (const modelId of models) {
          this._registerModel(registry, modelId, {
            pool: 'claude-console',
            accountId: account.id,
            priority: account.priority || 50,
            defaultPermission: 'claude'
          })
        }
      }
    } catch (err) {
      logger.error('Failed to load Claude Console models', { error: err.message })
    }
  }

  /**
   * 动态获取 Claude Console 账户支持的模型列表
   */
  async _fetchClaudeConsoleModels(account, defaultModels) {
    try {
      const claudeConsoleAccountService = require('./claudeConsoleAccountService')
      const accountData = await claudeConsoleAccountService.getAccount(account.id)

      if (!accountData || !accountData.apiKey) {
        logger.warn(`Claude Console account ${account.id} has no apiKey`)
        return defaultModels
      }

      // 构建 API URL：优先使用账户配置的 apiUrl，否则使用默认值
      const baseUrl = accountData.apiUrl || 'https://api.anthropic.com'
      const modelsUrl = `${baseUrl.replace(/\/$/, '')}/v1/models`

      const axios = require('axios')
      const axiosConfig = {
        headers: {
          'x-api-key': accountData.apiKey,
          'anthropic-version': '2023-06-01'
        },
        timeout: 10000
      }

      // 添加代理支持
      if (accountData.proxy) {
        const ProxyHelper = require('../utils/proxyHelper')
        const agent = ProxyHelper.createProxyAgent(accountData.proxy)
        if (agent) {
          axiosConfig.httpsAgent = agent
          axiosConfig.httpAgent = agent
        }
      }

      const response = await axios.get(modelsUrl, axiosConfig)

      if (response.data?.data && Array.isArray(response.data.data)) {
        const models = response.data.data.map((m) => m.id).filter(Boolean)
        logger.debug(`Claude Console account ${account.id} supports ${models.length} models`)
        return models.length > 0 ? models : defaultModels
      }

      return defaultModels
    } catch (err) {
      logger.warn(`Failed to fetch models for Claude Console account ${account.id}`, {
        error: err.message
      })
      return defaultModels
    }
  }

  /**
   * 根据订阅级别过滤模型
   */
  _filterModelsBySubscription(models, subscriptionInfo) {
    if (!subscriptionInfo) {
      return models
    }

    const tier = subscriptionInfo.tier || subscriptionInfo.plan || 'free'

    // Opus 模型需要 pro 或 max 订阅
    if (tier === 'free') {
      return models.filter((m) => !m.includes('opus'))
    }

    return models
  }

  /**
   * 加载 Gemini OAuth 模型
   */
  async _loadGeminiModels(registry) {
    try {
      const geminiAccountService = require('./geminiAccountService')
      const accounts = await geminiAccountService.getAllAccounts()

      for (const account of accounts) {
        // 只处理 gemini-cli 账户
        if (account.oauthProvider === 'antigravity') {
          continue
        }
        if (account.status !== 'active' || account.schedulable === false) {
          continue
        }

        // Gemini OAuth 支持的模型
        const models = account.supportedModels || ['gemini-2.5-flash', 'gemini-2.5-pro']

        for (const modelId of models) {
          this._registerModel(registry, modelId, {
            pool: 'gemini',
            accountId: account.id,
            priority: account.priority || 50,
            defaultPermission: 'gemini'
          })
        }
      }
    } catch (err) {
      logger.error('Failed to load Gemini models', { error: err.message })
    }
  }

  /**
   * 加载 Bedrock 模型
   */
  async _loadBedrockModels(registry) {
    try {
      const bedrockAccountService = require('./bedrockAccountService')
      const result = await bedrockAccountService.getAllAccounts()

      // bedrockAccountService 返回 { success, data } 格式
      if (!result.success || !Array.isArray(result.data)) {
        logger.warn('Bedrock accounts not available', { error: result.error })
        return
      }

      for (const account of result.data) {
        if (!account.isActive) {
          continue
        }

        const models = account.supportedModels || []

        for (const modelId of models) {
          this._registerModel(registry, modelId, {
            pool: 'bedrock',
            accountId: account.id,
            priority: account.priority || 50,
            defaultPermission: 'claude'
          })
        }
      }
    } catch (err) {
      logger.error('Failed to load Bedrock models', { error: err.message })
    }
  }

  /**
   * 加载 CCR 模型
   */
  async _loadCcrModels(registry) {
    try {
      const ccrAccountService = require('./ccrAccountService')
      const accounts = await ccrAccountService.getAllAccounts()

      for (const account of accounts) {
        if (account.status !== 'active') {
          continue
        }

        const models = account.supportedModels || []

        for (const modelId of models) {
          this._registerModel(registry, modelId, {
            pool: 'ccr',
            accountId: account.id,
            priority: account.priority || 50,
            defaultPermission: 'claude'
          })
        }
      }
    } catch (err) {
      logger.error('Failed to load CCR models', { error: err.message })
    }
  }

  /**
   * 注册模型到注册表
   */
  _registerModel(registry, modelId, accountInfo) {
    const { pool, accountId, priority, defaultPermission, permissionOverrides } = accountInfo

    // 确定权限
    const permission = this._getPermissionForModel(modelId, {
      pool,
      defaultPermission,
      permissionOverrides
    })

    if (!registry.has(modelId)) {
      registry.set(modelId, {
        pools: [],
        permission
      })
    }

    const entry = registry.get(modelId)

    // 检查是否已存在相同账户
    const existing = entry.pools.find((p) => p.accountId === accountId)
    if (!existing) {
      entry.pools.push({ pool, accountId, priority })
    }

    // 权限冲突处理：使用优先级最高的账户的权限
    // 如果新账户优先级更高，更新权限
    const highestPriority = Math.min(...entry.pools.map((p) => p.priority))
    if (priority <= highestPriority) {
      entry.permission = permission
    }
  }

  /**
   * 获取模型的权限
   * 优先级：permissionOverrides > defaultPermission > 池默认值
   */
  _getPermissionForModel(model, accountConfig) {
    const { pool, defaultPermission, permissionOverrides } = accountConfig

    // 1. 检查权限覆盖
    if (permissionOverrides && permissionOverrides[model]) {
      return permissionOverrides[model]
    }

    // 2. 使用账户默认权限
    if (defaultPermission) {
      return defaultPermission
    }

    // 3. 使用池默认权限
    return POOL_DEFAULT_PERMISSION[pool] || 'all'
  }

  /**
   * 查询模型信息
   * 支持精确匹配和多种别名匹配
   */
  get(model) {
    // 1. 精确匹配
    if (this.registry.has(model)) {
      return this.registry.get(model)
    }

    // 2. 尝试多种别名匹配
    for (const alias of this._getModelAliases(model)) {
      if (this.registry.has(alias)) {
        return this.registry.get(alias)
      }
    }

    return null
  }

  /**
   * 获取模型的所有可能别名
   */
  _getModelAliases(model) {
    const aliases = []

    // 1. 去掉日期后缀 (claude-sonnet-4-5-20250929 -> claude-sonnet-4-5)
    const withoutDate = model.replace(/-\d{8}$/, '')
    if (withoutDate !== model) {
      aliases.push(withoutDate)
    }

    // 2. 尝试添加 -thinking 后缀 (claude-opus-4-5 -> claude-opus-4-5-thinking)
    aliases.push(`${withoutDate}-thinking`)

    return aliases
  }

  /**
   * 从模型名称推断能力等级
   * @param {string} model - 模型名称
   * @returns {string} - 'fast' | 'balanced' | 'powerful' | 'unknown'
   */
  inferModelTier(model) {
    const m = model.toLowerCase()

    // Fast tier: 快速、低成本
    // 注意：使用单词边界匹配，避免 gemini 中的 mini 被误匹配
    if (m.includes('haiku') || m.includes('flash') || m.includes('lite')) {
      return 'fast'
    }
    // mini 需要特殊处理，排除 gemini
    if (m.includes('mini') && !m.includes('gemini')) {
      return 'fast'
    }

    // Powerful tier: 最强能力
    if (m.includes('opus')) {
      return 'powerful'
    }

    // Balanced tier: 平衡性能
    if (m.includes('sonnet') || m.includes('pro')) {
      return 'balanced'
    }

    return 'unknown'
  }

  /**
   * 在 registry 中查找指定等级的可用模型（按优先级排序）
   * @param {string} tier - 能力等级
   * @param {string} excludeModel - 排除的模型（原始请求模型）
   * @returns {string|null} - 找到的模型ID或null
   */
  _findModelByTier(tier, excludeModel) {
    const excludeBase = excludeModel.replace(/-\d{8}$/, '').toLowerCase()
    const candidates = []

    for (const [modelId, entry] of this.registry) {
      // 跳过与原始请求相同的模型
      if (modelId.toLowerCase() === excludeBase) {
        continue
      }

      const modelTier = this.inferModelTier(modelId)
      if (modelTier !== tier) {
        continue
      }

      candidates.push({
        modelId,
        priority: entry.pools[0]?.priority || 50
      })
    }

    if (candidates.length === 0) {
      return null
    }

    // 按优先级排序（数字越小优先级越高）
    candidates.sort((a, b) => a.priority - b.priority)

    return candidates[0].modelId
  }

  /**
   * 获取模型，支持智能 fallback
   * 当请求的模型不存在时，自动查找同能力等级的替代模型
   * @param {string} model - 请求的模型名称
   * @returns {object|null} - { entry, model, fallback: boolean, originalModel? }
   */
  getWithFallback(model) {
    // 1. 先尝试精确查找（包括别名匹配）
    const entry = this.get(model)
    if (entry) {
      return {
        entry,
        model: this._getMatchedModelId(model),
        fallback: false
      }
    }

    // 2. 推断请求模型的能力等级
    const tier = this.inferModelTier(model)
    if (tier === 'unknown') {
      return null
    }

    // 3. 在同等级中查找替代模型
    const fallbackModel = this._findModelByTier(tier, model)
    if (!fallbackModel) {
      return null
    }

    const fallbackEntry = this.registry.get(fallbackModel)
    if (!fallbackEntry) {
      return null
    }

    logger.info(`🔄 Model fallback: "${model}" → "${fallbackModel}" (tier: ${tier})`)

    return {
      entry: fallbackEntry,
      model: fallbackModel,
      fallback: true,
      originalModel: model,
      tier
    }
  }

  /**
   * 获取实际匹配到的模型ID（用于别名匹配场景）
   */
  _getMatchedModelId(model) {
    if (this.registry.has(model)) {
      return model
    }
    for (const alias of this._getModelAliases(model)) {
      if (this.registry.has(alias)) {
        return alias
      }
    }
    return model
  }

  /**
   * 检查模型是否存在
   */
  has(model) {
    return this.get(model) !== null
  }

  /**
   * 获取模型所属的池
   */
  getPoolForModel(model) {
    const entry = this.registry.get(model)
    if (!entry || entry.pools.length === 0) {
      return null
    }
    return entry.pools[0].pool
  }

  /**
   * 获取所有注册的模型
   */
  getAllModels() {
    const models = []
    const now = Math.floor(Date.now() / 1000)

    for (const [modelId, entry] of this.registry) {
      const pool = entry.pools[0]?.pool || 'unknown'
      models.push({
        id: modelId,
        object: 'model',
        created: now,
        owned_by: pool,
        permission: entry.permission
      })
    }

    return models.sort((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * 获取服务状态
   */
  getStatus() {
    return {
      initialized: this.initialized,
      totalModels: this.registry.size,
      lastRefreshTime: this.lastRefreshTime,
      lastRefreshError: this.lastRefreshError,
      refreshInterval: REFRESH_INTERVAL
    }
  }
}

module.exports = new ModelRegistryService()
