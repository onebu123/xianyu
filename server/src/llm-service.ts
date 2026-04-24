/**
 * LLM API 服务模块
 *
 * 通过 OpenAI 兼容接口调用大语言模型（支持 OpenAI / DeepSeek / 通义千问等）。
 * 配置方式：
 *   - 环境变量: APP_LLM_API_KEY, APP_LLM_API_BASE_URL, APP_LLM_MODEL
 *   - 或数据库 secure_settings 表中的 openai_api_key
 */

export interface LlmConfig {
  /** API 密钥 */
  apiKey: string;
  /** API Base URL，默认 https://api.openai.com/v1 */
  baseUrl: string;
  /** 模型名称，默认 gpt-4o-mini */
  model: string;
  /** 最大生成 token 数 */
  maxTokens: number;
  /** 温度参数，0~2 */
  temperature: number;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCallResult {
  success: boolean;
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  error?: string;
}

/** 从环境变量读取 LLM 配置 */
export function resolveLlmConfig(dbApiKey?: string | null): LlmConfig | null {
  // 优先使用环境变量，其次使用数据库中的 key
  const apiKey =
    process.env.APP_LLM_API_KEY?.trim() ||
    dbApiKey?.trim() ||
    null;

  if (!apiKey || apiKey === 'demo-openai-private-key') {
    return null; // 没配置或是演示占位值
  }

  return {
    apiKey,
    baseUrl: (process.env.APP_LLM_API_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(
      /\/+$/,
      '',
    ),
    model: process.env.APP_LLM_MODEL?.trim() || 'gpt-4o-mini',
    maxTokens: Math.max(
      64,
      Math.min(4096, Math.trunc(Number(process.env.APP_LLM_MAX_TOKENS ?? 512))),
    ),
    temperature: Math.max(
      0,
      Math.min(2, Number(process.env.APP_LLM_TEMPERATURE ?? 0.7)),
    ),
  };
}

/**
 * 调用 OpenAI 兼容 Chat Completions API
 *
 * 支持 OpenAI / DeepSeek / 通义千问 / Moonshot 等所有兼容接口。
 */
export async function callLlmChatCompletion(
  config: LlmConfig,
  messages: LlmMessage[],
): Promise<LlmCallResult> {
  const url = `${config.baseUrl}/chat/completions`;
  const body = {
    model: config.model,
    messages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
  };

  try {
    const controller = new AbortController();
    // 30 秒超时
    const timeout = setTimeout(() => controller.abort(), 30_000);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return {
        success: false,
        content: '',
        model: config.model,
        error: `LLM API 返回 ${response.status}: ${errorText.slice(0, 500)}`,
      };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };

    const content = data.choices?.[0]?.message?.content?.trim() ?? '';

    if (!content) {
      return {
        success: false,
        content: '',
        model: data.model ?? config.model,
        error: 'LLM API 返回了空内容。',
      };
    }

    return {
      success: true,
      content,
      model: data.model ?? config.model,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            totalTokens: data.usage.total_tokens ?? 0,
          }
        : undefined,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === 'AbortError'
          ? 'LLM API 请求超时（30秒）。'
          : error.message
        : '未知 LLM 调用错误';

    return {
      success: false,
      content: '',
      model: config.model,
      error: message,
    };
  }
}

/**
 * 构建 AI 客服的 System Prompt
 */
export function buildAiServiceSystemPrompt(context: {
  storeName: string;
  boundaryNote?: string;
  sensitiveWords?: string[];
  knowledgeItems?: Array<{ title: string; content: string }>;
}): string {
  const parts: string[] = [
    `你是闲鱼店铺「${context.storeName}」的 AI 客服助手。`,
    '请遵循以下规则：',
    '1. 用简洁、友好的中文回复买家，不超过 200 字。',
    '2. 如果遇到无法确定的问题，建议买家联系人工客服。',
    '3. 不要编造商品信息、价格或承诺，严格基于已知信息回答。',
    '4. 涉及退款、投诉、纠纷等敏感话题时，态度要特别耐心礼貌，并建议走平台售后流程。',
  ];

  if (context.boundaryNote?.trim()) {
    parts.push(`\n【服务边界】${context.boundaryNote.trim()}`);
  }

  if (context.sensitiveWords && context.sensitiveWords.length > 0) {
    parts.push(`\n【敏感词提醒】以下词汇出现时需格外谨慎：${context.sensitiveWords.join('、')}`);
  }

  if (context.knowledgeItems && context.knowledgeItems.length > 0) {
    parts.push('\n【知识库参考】');
    for (const item of context.knowledgeItems.slice(0, 10)) {
      parts.push(`- ${item.title}：${item.content}`);
    }
  }

  return parts.join('\n');
}

/**
 * 将会话消息历史转换为 LLM messages 格式
 */
export function buildLlmMessagesFromHistory(
  systemPrompt: string,
  chatHistory: Array<{
    senderType: string;
    content: string;
  }>,
): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: 'system', content: systemPrompt }];

  // 只保留最近 20 条消息，避免上下文过长
  const recentHistory = chatHistory.slice(-20);

  for (const message of recentHistory) {
    if (message.senderType === 'customer') {
      messages.push({ role: 'user', content: message.content });
    } else if (message.senderType === 'ai' || message.senderType === 'manual') {
      messages.push({ role: 'assistant', content: message.content });
    }
    // system / suggestion 类型不放入对话历史
  }

  return messages;
}
