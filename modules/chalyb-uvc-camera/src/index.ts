import { NativeModule, requireNativeModule, requireNativeView } from "expo";
import type { ViewProps } from "react-native";

export interface UsbCameraDevice {
  deviceName: string;
  vendorId: number;
  productId: number;
  vendorHex: string;
  productHex: string;
  productName: string | null;
  manufacturerName: string | null;
  permissionGranted: boolean;
  /** True for any DJI USB device (Osmo Pocket 3, Action, etc.). */
  isDji: boolean;
}

export interface InitializeResult {
  ok: boolean;
  uvcInterfaces: number;
  uvcVersion: string | null;
  message: string | null;
}

export interface StartPreviewResult {
  ok: boolean;
  width?: number;
  height?: number;
  fps?: number;
  format?: "MJPEG" | "YUY2";
  message: string | null;
}

export type UsbCameraEvents = {
  onAttach: (info: UsbCameraDevice) => void;
  onDetach: (info: { reason: string }) => void;
  onPermissionResult: (info: { granted: boolean }) => void;
  onPumpError: (info: { message: string }) => void;
};

declare class UsbCameraModuleType extends NativeModule<UsbCameraEvents> {
  getCurrentDevice(): Promise<UsbCameraDevice | null>;
  requestPermission(): Promise<boolean>;
  refresh(): Promise<void>;
  initialize(): Promise<InitializeResult>;
  startPreview(
    width: number,
    height: number,
    fps: number,
  ): Promise<StartPreviewResult>;
  stopPreview(): Promise<void>;
  release(): Promise<void>;
}

const UsbCamera = requireNativeModule<UsbCameraModuleType>("UsbCamera");

/** Native SurfaceView wrapper that displays decoded UVC frames. Mount it
 *  once initialize() has succeeded, then call startPreview(w, h, fps). */
export const UsbCameraPreview = requireNativeView<ViewProps>(
  "UsbCamera",
  "UsbCameraPreview",
);

export default UsbCamera;
