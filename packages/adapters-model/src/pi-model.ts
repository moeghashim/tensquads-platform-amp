// The real adapter of the model of Petra (decisions D24 and D30). It uses the model layer of pi (pi-ai), which runs
// in the Workers runtime (report of task 01, SP-A6). One adapter serves each provider of the list.
// The provider is the row of the plug-in list. The model, the base URL and the key are settings of the Worker.
// The key is never in an error or a log line (requirement N3).
import type { Api, AssistantMessage, Model as PiModel } from "@earendil-works/pi-ai";
import { createModels, type Models, type Provider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { type Model, type ModelRequest, type Plugin, ports } from "@tensquads/core";

import { answerOf, contextOf } from "./messages.js";

// The providers of decision D24. Meta is Muse, on the API openai-responses at https://api.meta.ai/v1.
// zai is GLM.
const PROVIDERS = {
	openai: openaiProvider,
	anthropic: anthropicProvider,
	xai: xaiProvider,
	meta: metaProvider,
	google: googleProvider,
	deepseek: deepseekProvider,
	zai: zaiProvider,
} as const satisfies Record<string, () => Provider<Api>>;

export type ModelProvider = keyof typeof PROVIDERS;

export const MODEL_PROVIDERS = Object.keys(PROVIDERS) as ModelProvider[];

// The name of the secret of the key of a provider, for example OPENAI_API_KEY.
export const keyName = (provider: ModelProvider): string => `${provider.toUpperCase()}_API_KEY`;

// The settings of the real model. They come from the Worker. A test gives a fetch function and no network is used.
export interface ModelSettings {
	// The name of the model, from the setting PETRA_MODEL.
	model: string;
	// An other address of the provider, from the setting PETRA_MODEL_BASE_URL. For example for GLM.
	baseUrl?: string;
	// Reads one secret of the Worker by its name.
	secret: (name: string) => string | undefined;
	fetch?: typeof globalThis.fetch;
}

export class ModelSettingError extends Error {
	override name = "ModelSettingError";
}

// The HTTP status in the text of a provider error, if the text has one.
const STATUS = /\b([45]\d\d)\b/;

// The error of a failed call. It has the provider, the model, the stop reason and the HTTP status. It never has the
// text of the provider, because that text can have a part of the key.
function callError(model: PiModel<Api>, reason: string, detail: string | undefined): Error {
	const status = detail ? STATUS.exec(detail)?.[1] : undefined;
	const tail = status ? ` The HTTP status is ${status}.` : "";
	return new Error(`The model call to ${model.provider}/${model.id} failed: ${reason}.${tail}`);
}

function modelOf(models: Models, provider: ModelProvider, settings: ModelSettings): PiModel<Api> {
	const found = models.getModel(provider, settings.model);
	if (!found) {
		throw new ModelSettingError(`The provider ${provider} has no model named in the setting PETRA_MODEL.`);
	}
	return settings.baseUrl ? { ...found, baseUrl: settings.baseUrl } : found;
}

export function piModel(options: { provider: ModelProvider } & ModelSettings): Plugin {
	const { provider } = options;
	return {
		name: `model-pi-${provider}`,
		provides: [ports.petraModel],
		needs: [],
		apply: (ctx) => {
			const secret = keyName(provider);
			const apiKey = options.secret(secret);
			// A missing setting stops the start. The message names the setting and never its value (section 10).
			if (!apiKey) throw new ModelSettingError(`The secret ${secret} is missing.`);
			const models = createModels();
			models.setProvider(PROVIDERS[provider]());
			const model = modelOf(models, provider, options);
			let calls = 0;
			const port: Model = {
				id: { provider, model: model.id },
				complete: async (request: ModelRequest) => {
					calls += 1;
					let message: AssistantMessage;
					try {
						message = await models.completeSimple(model, contextOf(model, request), {
							apiKey,
							// Petra tries one more time herself (requirement N6). The provider client does not try again.
							maxRetries: 0,
							...(request.signal ? { signal: request.signal } : {}),
							...(options.fetch ? { fetch: options.fetch } : {}),
						});
					} catch {
						throw callError(model, "the client stopped", undefined);
					}
					if (message.stopReason === "error" || message.stopReason === "aborted") {
						throw callError(model, message.stopReason, message.errorMessage);
					}
					return answerOf(message, `${provider}-${Date.now()}-${calls}`);
				},
			};
			ctx.provide(ports.petraModel, port);
		},
	};
}
