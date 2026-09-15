/**
 * Cross-runtime wrapper around the `chalyb-streaming` local Expo Module.
 *
 * In a custom dev client (Phase 1+) the native module loads and `available`
 * is true. In stock Expo Go the import would throw, so we lazy-require with
 * a try/catch and fall back to a stub that returns clear Spanish errors.
 *
 * Consumers should always check `streaming.available` before calling
 * start/stop. The hook layer surfaces this as a "dev build required"
 * banner.
 */
import Constants, { ExecutionEnvironment } from "expo-constants";

export interface StartBroadcastInput {
  url: string;
  streamKey: string;
  bitrateKbps?: number;
  fps?: number;
  width?: number;
  height?: number;
  facing?: "back" | "front";
}

export interface BroadcastStats {
  bitrateKbps: number;
  fps: number;
  droppedFrames: number;
  uptimeMs: number;
  rttMs: number;
}

export type BroadcastStatus =
  | "idle"
  | "preparing"
  | "connecting"
  | "live"
  | "reconnecting"
  | "error";

interface StreamingApi {
  available: boolean;
  /** Reason the module isn't available — Spanish, for UI display. */
  reason: string | null;
  isReady(): Promise<boolean>;
  start(input: StartBroadcastInput): Promise<void>;
  stop(): Promise<void>;
  setBitrate(bitrateKbps: number): Promise<void>;
  addStatusListener(
    handler: (info: { status: BroadcastStatus }) => void,
  ): () => void;
  addStatsListener(handler: (info: BroadcastStats) => void): () => void;
  addErrorListener(
    handler: (info: { message: string; code?: string }) => void,
  ): () => void;
}

const isExpoGo =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

const unavailableMsg =
  "El broadcaster RTMP solo funciona en el dev client. Construye uno con `eas build --profile development --platform android`.";

function buildStub(reason: string): StreamingApi {
  return {
    available: false,
    reason,
    async isReady() {
      return false;
    },
    async start() {
      throw new Error(reason);
    },
    async stop() {},
    async setBitrate() {},
    addStatusListener() {
      return () => {};
    },
    addStatsListener() {
      return () => {};
    },
    addErrorListener() {
      return () => {};
    },
  };
}

let api: StreamingApi;

if (isExpoGo) {
  api = buildStub(unavailableMsg);
} else {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("chalyb-streaming");
    const Native = mod.default;
    api = {
      available: true,
      reason: null,
      isReady: () => Native.isReady(),
      start: (input) => Native.start(input),
      stop: () => Native.stop(),
      setBitrate: (kbps) => Native.setBitrate(kbps),
      addStatusListener: (h) => {
        const sub = Native.addListener("onStatus", h);
        return () => sub.remove();
      },
      addStatsListener: (h) => {
        const sub = Native.addListener("onStats", h);
        return () => sub.remove();
      },
      addErrorListener: (h) => {
        const sub = Native.addListener("onError", h);
        return () => sub.remove();
      },
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? `${unavailableMsg} (load error: ${err.message})`
        : unavailableMsg;
    api = buildStub(message);
  }
}

export const streaming = api;
