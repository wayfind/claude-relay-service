/**
 * 路由错误诊断工具
 * 根据 v3 设计文档：错误信息要告诉用户怎么解决问题
 */

const ERROR_CODES = {
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NO_AVAILABLE_ACCOUNT: 'NO_AVAILABLE_ACCOUNT'
}

/**
 * 创建路由错误
 * @param {string} code - 错误代码
 * @param {object} context - 上下文信息
 */
function createRoutingError(code, context = {}) {
  const { model, requiredPermission, userPermissions } = context

  const errorInfo = {
    type: 'model_routing_error',
    code,
    message: '',
    suggestion: ''
  }

  switch (code) {
    case ERROR_CODES.MODEL_NOT_FOUND:
      errorInfo.message = `Model "${model}" not found. Check model name or wait for registry refresh.`
      errorInfo.suggestion = 'Use /api/v1/models to list available models.'
      break

    case ERROR_CODES.PERMISSION_DENIED:
      errorInfo.message = `Model "${model}" requires "${requiredPermission}" permission.`
      errorInfo.suggestion = `Contact admin to add "${requiredPermission}" permission to your API key.`
      if (userPermissions) {
        errorInfo.currentPermissions = userPermissions
      }
      break

    case ERROR_CODES.NO_AVAILABLE_ACCOUNT:
      errorInfo.message = `All accounts for model "${model}" are unavailable (rate limited or offline).`
      errorInfo.suggestion = 'Wait a few minutes and retry, or use a different model.'
      break

    default:
      errorInfo.code = 'UNKNOWN_ERROR'
      errorInfo.message = 'An unknown routing error occurred.'
      errorInfo.suggestion = 'Please try again or contact support.'
  }

  const error = new Error(errorInfo.message)
  error.routingError = errorInfo
  error.statusCode = code === ERROR_CODES.PERMISSION_DENIED ? 403 : 404

  return error
}

/**
 * 格式化错误响应
 */
function formatRoutingErrorResponse(error) {
  if (error.routingError) {
    return {
      error: error.routingError
    }
  }

  return {
    error: {
      type: 'model_routing_error',
      code: 'UNKNOWN_ERROR',
      message: error.message || 'An unknown error occurred',
      suggestion: 'Please try again or contact support.'
    }
  }
}

module.exports = {
  ERROR_CODES,
  createRoutingError,
  formatRoutingErrorResponse
}
