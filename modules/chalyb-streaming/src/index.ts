import { NativeModule, requireNativeModule } from "expo";

export interface StartBroadcastInput {
  /** Full RTMP URL including app path. E.g. rtmp://live.twitch.tv/app */
  url: string;
  /** Platform-issued stream key. Stored via secrets KvStore on the JS side. */
  streamKey: string;
  /** Target encoded bitrate (kbps). Defaults to 4500. */
  bitrateKbps?: number;
  /** Target frame rate. Defaults to 30. */
  fps?: number;
  /** Encoder width × height. Defaults to 1280 × 720. */
  width?: number;
  height?: number;
  /** "back" or "front" phone camera. Defaults to "back". */
  facing?: "back" | "front";
}

export interface BroadcastStats {
  bitrateKbps: number;
  fps: number;
  droppedFrames: number;
  uptimeMs: number;
  /** Round-trip time observed on RTMP ack frames; 0 if unknown. */
  rttMs: number;
}

export type BroadcastStatus =
  | "idle"
  | "preparing" // claiming camera + encoder
  | "connecting" // RTMP handshake
  | "live"
  | "reconnecting"
  | "error";

export interface BroadcastError {
  message: string;
  code?: string;
}

export type ChalybStreamingEvents = {
  onStatus: (info: { status: BroadcastStatus }) => void;
  onStats: (info: BroadcastStats) => void;
  onError: (info: BroadcastError) => void;
};

declare class ChalybStreamingModuleType extends NativeModule<ChalybStreamingEvents> {
  /** Returns true once the native module finished loading and Camera2 + the
   *  RTMP publisher are ready to accept a start() call. */
  isReady(): Promise<boolean>;
  start(input: StartBroadcastInput): Promise<void>;
  stop(): Promise<void>;
  /** Live-update the bitrate without tearing down the encoder (ABR). */
  setBitrate(bitrateKbps: number): Promise<void>;
}

const ChalybStreaming = requireNativeModule<ChalybStreamingModuleType>(
  "ChalybStreaming",
);

export default ChalybStreaming;
