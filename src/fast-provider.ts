import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { type Identity, officialBase, requestIdentity } from "./auth.ts";

export interface BoundRequest { model: Model<Api>; identity?: Identity }
const id = "openai-codex";
const api = "openai-codex-responses";

/** Public legacy provider adapter. It intercepts both stream variants; always
 * delegates the FULL original stream, preserving provider-specific options.
 * Only the documented simple reasoning field needs conversion for Codex. */
export function bindFastProvider(
  pi: ExtensionAPI, ctx: ExtensionContext,
  apply: (payload: unknown, request: BoundRequest) => Promise<unknown>,
): { owned(): boolean; close(): void } | undefined {
  const registry = ctx.modelRegistry;
  if (typeof pi.registerProvider !== "function" || !registry.getProvider ||
      registry.getRegisteredNativeProvider?.(id) || registry.getRegisteredProviderConfig?.(id)) return undefined;
  const original = registry.getProvider(id);
  if (!original) return undefined;
  let closed = false;
  const handler: NonNullable<ProviderConfig["streamSimple"]> = (model, context, options) => {
    const actual = { ...model, ...(model.headers ? { headers: { ...model.headers } } : {}) };
    const previous = options?.onPayload;
    const bearer = options?.apiKey;
    const simple = options?.reasoning ? clampThinkingLevel(actual, options.reasoning) : undefined;
    const delegated = { ...options, ...(options?.headers ? { headers: { ...options.headers } } : {}),
      ...(options?.reasoning ? { reasoningEffort: simple === "off" ? undefined : simple } : {}),
      onPayload: async (payload: unknown, actualModel: typeof actual) => {
        const replacement = await previous?.(payload, actualModel);
        const body = replacement === undefined ? payload : replacement;
        if (closed || actualModel.provider !== id || actualModel.api !== api || !officialBase(id, actualModel.baseUrl)) return body;
        let identity: Identity | undefined;
        try { identity = requestIdentity(actualModel, { apiKey: bearer, headers: delegated.headers }); } catch { /* unknown => default */ }
        const result = await apply(body, { model: actualModel, identity });
        return result === undefined ? body : result;
      },
    };
    return original.stream(actual, context, delegated);
  };
  pi.registerProvider(id, { api, streamSimple: handler });
  const owned = () => {
    const current = registry.getRegisteredProviderConfig?.(id);
    return !closed && current?.streamSimple === handler && current.api === api;
  };
  return {
    owned,
    close() {
      if (closed) return;
      closed = true;
      const current = registry.getRegisteredProviderConfig?.(id);
      if (current?.streamSimple !== handler) return;
      const { streamSimple: _removed, ...remaining } = current;
      pi.unregisterProvider(id);
      // Preserve any later merged registration rather than removing its settings.
      if (Object.keys(remaining).some((key) => key !== "api") || remaining.api !== api) {
        pi.registerProvider(id, remaining as ProviderConfig);
      }
    },
  };
}
