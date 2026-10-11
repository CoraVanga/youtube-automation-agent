const OpenAI = require('openai');
const { Logger } = require('./logger');

const GEMINI_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash-lite',
];
const GEMINI_DEFAULT_MODEL = GEMINI_MODELS[0];

const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6',
    models: ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    envKey: 'OPENAI_API_KEY',
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5.6-sol',
    models: ['openai/gpt-5.6-sol', 'anthropic/claude-fable-5', 'google/gemini-3.7-flash', 'moonshotai/kimi-k3', 'z-ai/glm-5.3'],
    envKey: 'OPENROUTER_API_KEY',
  },
  kimi: {
    name: 'Kimi (Moonshot AI)',
    baseURL: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
    envKey: 'MOONSHOT_API_KEY',
  },
  mimo: {
    name: 'MiMo (Xiaomi)',
    baseURL: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro',
    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
    envKey: 'MIMO_API_KEY',
  },
  glm: {
    name: 'GLM (Zhipu AI)',
    baseURL: 'https://api.z.ai/api/paas/v4/',
    defaultModel: 'glm-5.3',
    models: ['glm-5.3', 'glm-5.2', 'glm-5.1'],
    envKey: 'GLM_API_KEY',
  },
  ollama: {
    name: 'Ollama (local)',
    baseURL: 'http://localhost:11434/v1',
    defaultModel: '',
    // Installed models vary per machine, so the UI lists them from the running
    // server instead of a fixed catalogue.
    models: [],
    envKey: 'OLLAMA_BASE_URL',
    // Ollama needs no credential; the OpenAI SDK still requires a non-empty key.
    local: true,
  },
};

const OLLAMA_PLACEHOLDER_KEY = 'ollama';

function defaultOllamaBaseURL() {
  const configured = String(process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST || '').trim();
  if (!configured) return PROVIDERS.ollama.baseURL;
  const withScheme = /^https?:\/\//i.test(configured) ? configured : `http://${configured}`;
  return withScheme.replace(/\/+$/, '').endsWith('/v1') ? withScheme.replace(/\/+$/, '') : `${withScheme.replace(/\/+$/, '')}/v1`;
}

class AITextService {
  constructor(credentials = {}) {
    this.logger = new Logger('AITextService');
    this.client = null;
    this.gemini = null;
    this.model = null;
    this.providerName = null;

    this._init(credentials);
  }

  _init(credentials) {
    const configured = credentials.aiProvider || {};
    const provider = configured.provider;
    const apiKey = configured.apiKey;
    const model = configured.model;
    const preset = provider ? PROVIDERS[provider] : null;

    // A local provider is selected by its base URL, not by holding a key.
    if (preset?.local) {
      return this._initOpenAICompatible(preset, OLLAMA_PLACEHOLDER_KEY, model, configured);
    }

    if (preset && apiKey) {
      return this._initOpenAICompatible(preset, apiKey, model, configured);
    }

    for (const [, candidate] of Object.entries(PROVIDERS)) {
      if (candidate.local) continue;
      const key = process.env[candidate.envKey];
      if (key) {
        return this._initOpenAICompatible(candidate, key);
      }
    }

    const geminiKey = credentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    if (geminiKey) {
      return this._initGemini(geminiKey, credentials.gemini?.model);
    }

    // Checked last so an explicit cloud key still wins, matching prior behaviour.
    if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST) {
      return this._initOpenAICompatible(PROVIDERS.ollama, OLLAMA_PLACEHOLDER_KEY, process.env.OLLAMA_MODEL);
    }

    this.logger.warn('No AI text provider configured — text generation unavailable');
  }

  _initOpenAICompatible(preset, apiKey, model, configured = {}) {
    const baseURL = preset.local
      ? (configured.baseURL || defaultOllamaBaseURL())
      : preset.baseURL;

    this.client = new OpenAI({ apiKey: apiKey || OLLAMA_PLACEHOLDER_KEY, baseURL });
    this.model = model || preset.defaultModel;
    this.providerName = preset.name;
    this.baseURL = baseURL;
    // Reasoning models emit hidden reasoning tokens that consume the same budget
    // as the answer, so a 1800-token cap can return empty content. 'none' is the
    // only switch the OpenAI-compatible path honours.
    this.reasoningEffort = configured.disableReasoning ? 'none' : null;

    const detail = preset.local ? `${this.model || 'no model selected'} @ ${baseURL}` : `model: ${this.model}`;
    this.logger.info(`${preset.name} initialized (${detail})`);
  }

  _initGemini(apiKey, model) {
    try {
      const { GoogleGenAI } = require('@google/genai');
      this.gemini = new GoogleGenAI({ apiKey });
      this.model = model || GEMINI_DEFAULT_MODEL;
      this.providerName = 'Google Gemini';
      this.logger.info(`Gemini initialized (model: ${this.model})`);
    } catch (error) {
      this.logger.error('Failed to initialize Gemini:', error.message);
    }
  }

  async generateText(prompt, options = {}) {
    const model = options.model || this.model;
    const maxTokens = options.maxTokens || 2048;
    const temperature = options.temperature ?? 0.7;

    if (this.gemini) {
      const config = { maxOutputTokens: maxTokens };
      if (!/^gemini-3\.(?:[5-9]|\d{2,})-/.test(model)) config.temperature = temperature;
      const response = await this.gemini.models.generateContent({
        model,
        contents: prompt,
        config,
      });
      const text = response && response.text;
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error(
          `${this.providerName} returned an empty response. Check the API key and model quota — free-tier Gemini keys are rate-limited and can return empty output.`
        );
      }
      return text;
    }

    if (!this.client) {
      throw new Error('No AI text provider configured');
    }

    const params = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
    };

    const tokenParams = [
      { max_completion_tokens: maxTokens },
      { max_tokens: maxTokens },
    ];

    let lastError = null;
    for (let index = 0; index < tokenParams.length; index++) {
      const request = { ...params, ...tokenParams[index] };
      try {
        const response = await this.client.chat.completions.create(request);
        return this._extractContent(response);
      } catch (error) {
        lastError = error;
        const message = error?.message || '';
        // Providers that have never seen reasoning_effort reject the whole
        // request; drop the hint rather than failing the generation.
        if (error?.status === 400 && /reasoning_effort/i.test(message) && request.reasoning_effort) {
          const { reasoning_effort: _effort, ...withoutEffort } = request;
          try {
            const response = await this.client.chat.completions.create(withoutEffort);
            return this._extractContent(response);
          } catch (retryError) {
            lastError = retryError;
          }
        }

        const unsupportedTemperature =
          error?.status === 400 &&
          /temperature/i.test(message) &&
          /(unsupported value|does not support|only the default)/i.test(message);

        if (unsupportedTemperature) {
          const { temperature: _temperature, ...withoutTemperature } = request;
          try {
            const response = await this.client.chat.completions.create(withoutTemperature);
            return this._extractContent(response);
          } catch (retryError) {
            lastError = retryError;
          }
        }

        // Older models and some providers reject max_completion_tokens with a
        // 400; retry with the legacy max_tokens spelling. This also applies if
        // the temperature-compatible retry exposed the token incompatibility.
        if (
          index === 0 &&
          lastError?.status === 400 &&
          /max(_completion)?_tokens/i.test(lastError.message || '')
        ) {
          continue;
        }
        throw lastError;
      }
    }

    throw lastError;
  }

  _extractContent(response) {
    const message =
      response && response.choices && response.choices[0] ? response.choices[0].message : null;
    const content = message ? message.content : null;

    if (typeof content !== 'string' || !content.trim()) {
      // A null/empty body used to surface as cryptic "Unexpected end of JSON input"
      // in the agents' JSON parsers. Report the real cause instead.
      const reasoning = message && (message.reasoning || message.reasoning_content);
      if (reasoning && !this.reasoningEffort) {
        throw new Error(
          `${this.providerName} spent the whole token budget on reasoning and returned no answer. ` +
          'Turn on "Disable model reasoning" for this provider, or pick a non-reasoning model.'
        );
      }
      throw new Error(
        `${this.providerName} returned an empty response. Check the API key and model quota.`
      );
    }
    return content;
  }

  isAvailable() {
    return !!(this.client || this.gemini);
  }
}

// Lists the models installed on a running Ollama server so the operator picks
// from what actually exists instead of typing a name. Cloud-hosted ":cloud" tags
// are excluded — they are not local inference.
async function listOllamaModels(baseURL) {
  const root = String(baseURL || defaultOllamaBaseURL()).replace(/\/v1\/?$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${root}/api/tags`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Ollama responded with ${response.status}`);
    const body = await response.json();
    return (body.models || [])
      .filter(model => !String(model.name || '').endsWith(':cloud'))
      .map(model => ({
        name: model.name,
        parameterSize: model.details?.parameter_size || null,
        quantization: model.details?.quantization_level || null,
        sizeBytes: model.size ?? null,
      }));
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  AITextService,
  PROVIDERS,
  GEMINI_MODELS,
  GEMINI_DEFAULT_MODEL,
  listOllamaModels,
  defaultOllamaBaseURL,
};
