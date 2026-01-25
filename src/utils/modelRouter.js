/**
 * 统一模型路由器
 * 根据 v3 设计文档实现自动路由决策
 */

const logger = require('../utils/logger')
const { parseVendorPrefixedModel } = require('../utils/modelHelper')
const { ERROR_CODES, createRoutingError } = require('../utils/routingErrorHelper')

/**
 * 路由请求到正确的账户池
 * @param {object} options - 路由选项
 * @param {object} options.req - Express 请求对象
 * @param {string} options.model - 请求的模型名称
 * @param {array} options.apiKeyPermissions - API Key 的权限列表
 * @returns {object} - { pool, accountId, model, forced }
 */
async function routeRequest({ req, model, apiKeyPermissions }) {
  const modelRegistryService = require('../services/modelRegistryService')
  const apiKeyService = require('../services/apiKeyService')

  // 1. 路径强制指定优先
  const forcedVendor = req._anthropicVendor || null
  if (forcedVendor) {
    return {
      pool: forcedVendor,
      model,
      forced: true,
      accountId: null
    }
  }

  // 2. CCR 前缀优先
  const { vendor, baseModel } = parseVendorPrefixedModel(model)
  if (vendor === 'ccr') {
    return {
      pool: 'ccr',
      model: baseModel,
      forced: true,
      accountId: null
    }
  }

  // 3. 查询注册表
  const entry = modelRegistryService.get(model)
  if (!entry) {
    throw createRoutingError(ERROR_CODES.MODEL_NOT_FOUND, { model })
  }

  // 4. 权限检查
  const requiredPermission = entry.permission
  if (!apiKeyService.hasPermission(apiKeyPermissions, requiredPermission)) {
    throw createRoutingError(ERROR_CODES.PERMISSION_DENIED, {
      model,
      requiredPermission,
      userPermissions: apiKeyPermissions
    })
  }

  // 5. 按 priority 顺序选择第一个可用账户
  for (const { pool, accountId } of entry.pools) {
    const isAvailable = await isAccountAvailable(pool, accountId)
    if (isAvailable) {
      return {
        pool,
        accountId,
        model,
        forced: false
      }
    }
  }

  // 所有账户不可用
  throw createRoutingError(ERROR_CODES.NO_AVAILABLE_ACCOUNT, { model })
}

/**
 * 检查账户是否可用
 */
async function isAccountAvailable(pool, accountId) {
  try {
    switch (pool) {
      case 'antigravity':
      case 'gemini': {
        const geminiAccountService = require('../services/geminiAccountService')
        const account = await geminiAccountService.getAccount(accountId)
        return account && account.status === 'active' && account.schedulable !== false
      }

      case 'claude-official': {
        const claudeAccountService = require('../services/claudeAccountService')
        const isRateLimited = await claudeAccountService.isAccountRateLimited(accountId)
        if (isRateLimited) {
          return false
        }
        const account = await claudeAccountService.getAccount(accountId)
        return account && account.status === 'active'
      }

      case 'bedrock': {
        const bedrockAccountService = require('../services/bedrockAccountService')
        const result = await bedrockAccountService.getAccount(accountId)
        // bedrockAccountService.getAccount 返回 { success, data } 格式
        return result?.success && result.data?.isActive
      }

      case 'ccr': {
        const ccrAccountService = require('../services/ccrAccountService')
        const account = await ccrAccountService.getAccount(accountId)
        return account && account.status === 'active'
      }

      default:
        return false
    }
  } catch (err) {
    logger.warn(`Failed to check account availability: ${pool}/${accountId}`, {
      error: err.message
    })
    return false
  }
}

/**
 * 检测并记录跨池切换
 */
async function detectPoolSwitch(sessionHash, currentPool) {
  if (!sessionHash) {
    return
  }

  try {
    const redisClient = require('../models/redis')
    const key = `session_pool:${sessionHash}`
    const previousPool = await redisClient.get(key)

    if (previousPool && previousPool !== currentPool) {
      logger.warn(`Session ${sessionHash} switching pool: ${previousPool} → ${currentPool}`, {
        previousPool,
        currentPool,
        note: 'Context may be lost due to pool switch'
      })
    }

    // 记录当前池，TTL 与粘性会话相同（1小时）
    const ttl = 3600
    await redisClient.setex(key, ttl, currentPool)
  } catch (err) {
    // 非关键操作，记录警告但不阻断请求
    logger.warn('Failed to detect/record pool switch', { error: err.message })
  }
}

module.exports = {
  routeRequest,
  isAccountAvailable,
  detectPoolSwitch
}
