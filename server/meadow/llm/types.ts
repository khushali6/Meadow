import type { ProviderId } from "../config";

export type { ProviderId };

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatOptions = { model?: string; maxTokens?: number; temperature?: number; json?: boolean; signal?: AbortSignal };

export type ChatResult = { text: string; model: string; tokensIn: number; tokensOut: number; provider?: ProviderId };

export type Capabilities = { chat: boolean; embeddings: boolean; transcription: boolean; jsonMode: boolean; streaming: boolean };

export type ProviderKind = "local" | "cloud" | "custom";

export type ProviderMetadata = { id: ProviderId; name: string; type: ProviderKind; capabilities: Capabilities };

/** What the rest of Meadow uses. Implemented by the router, which dispatches to the configured providers. */
export interface LlmClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>;
  embed(texts: string[]): Promise<number[][]>;
  transcribe(audio: Buffer, filename: string): Promise<string>;
  models(): Promise<string[]>;
}

/** One concrete provider. Optional methods are absent when the capability is missing. */
export interface LlmProvider {
  readonly id: ProviderId;
  metadata(): ProviderMetadata;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>;
  embed?(texts: string[]): Promise<number[][]>;
  transcribe?(audio: Buffer, filename: string): Promise<string>;
  models(): Promise<string[]>;
}

export type HealthStep = { name: string; ok: boolean; skipped?: boolean; detail: string; errorType?: string };

export type ProviderHealth = { provider: ProviderId; name: string; model: string; ok: boolean; steps: HealthStep[]; capabilities: Capabilities; ms: number };
