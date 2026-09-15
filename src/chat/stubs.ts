import type { ChatProvider } from "./ChatProvider";
import type { ChatMessage, ChatPlatformId, ChatStatus } from "./types";

/**
 * Phase-0 stub for non-Kick platforms. Throws on connect with a clear
 * Spanish message naming the work each platform still needs. Replace by
 * a real implementation file (TwitchProvider.ts, YouTubeLiveProvider.ts,
 * etc.) when the per-platform OAuth + transport lands.
 */
class StubProvider implements ChatProvider {
  constructor(
    public readonly platformId: ChatPlatformId,
    private readonly reason: string,
  ) {}

  async connect(_channel: string): Promise<void> {
    throw new Error(this.reason);
  }
  disconnect(): void {
    /* nothing to disconnect */
  }
  async sendMessage(_content: string): Promise<void> {
    throw new Error(this.reason);
  }
  onMessage(_handler: (m: ChatMessage) => void): () => void {
    return () => {};
  }
  onStatus(handler: (s: ChatStatus) => void): () => void {
    handler("idle");
    return () => {};
  }
}

export const twitchStub = new StubProvider(
  "twitch",
  "Twitch IRC todavía no está conectado en ChalybOBS. Conexión anónima vía wss://irc-ws.chat.twitch.tv + OAuth para enviar — TODO Fase 0.5.",
);

export const youtubeStub = new StubProvider(
  "youtube",
  "YouTube Live Chat requiere OAuth 2.0 + LiveChatMessages.insert. TODO Fase 0.5.",
);

export const tiktokStub = new StubProvider(
  "tiktok",
  "TikTok Live no expone WebSocket público; necesita un puente como tiktok-live-connector. TODO Fase 1.",
);

export const restreamStub = new StubProvider(
  "restream",
  "Restream Chat usa su propio WebSocket autenticado. TODO Fase 0.5.",
);

export const customStub = new StubProvider(
  "custom",
  "Adaptador genérico (IRC / EventSource / webhook) — aún sin implementar.",
);
