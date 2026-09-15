/**
 * Runtime-safe wrapper around the `chalyb-uvc-camera` local Expo Module.
 *
 * In a custom dev client (Phase 2+) the native module loads + `available`
 * is true. In stock Expo Go the require() throws, so we lazy-load with a
 * try/catch and fall back to a stub that returns clear Spanish errors.
 *
 * iOS always returns the stub — Apple platform doesn't allow USB UVC.
 */
import { ComponentType } from "react";
import { Platform } from "react-native";
import type { ViewProps } from "react-native";
import Constants, { ExecutionEnvironment } from "expo-constants";

export interface UsbCameraDevice {
  deviceName: string;
  vendorId: number;
  productId: number;
  vendorHex: string;
  productHex: string;
  productName: string | null;
  manufacturerName: string | null;
  permissionGranted: boolean;
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

interface UsbCameraApi {
  available: boolean;
  reason: string | null;
  PreviewView: ComponentType<ViewProps> | null;
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
  addAttachListener(handler: (device: UsbCameraDevice) => void): () => void;
  addDetachListener(handler: (info: { reason: string }) => void): () => void;
  addPermissionListener(
    handler: (info: { granted: boolean }) => void,
  ): () => void;
  addPumpErrorListener(
    handler: (info: { message: string }) => void,
  ): () => void;
}

const isExpoGo =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
const isIOS = Platform.OS === "ios";

const unavailableExpoGo =
  "El soporte USB UVC solo carga en el dev client. Construye uno con `eas build --profile development --platform android`.";
const unavailableIOS =
  "iOS no soporta cámaras USB UVC (limitación de la plataforma Apple). Solo modo Operador en Android puede capturar la Osmo.";

function buildStub(reason: string): UsbCameraApi {
  return {
    available: false,
    reason,
    PreviewView: null,
    async getCurrentDevice() {
      return null;
    },
    async requestPermission() {
      return false;
    },
    async refresh() {},
    async initialize() {
      return {
        ok: false,
        uvcInterfaces: 0,
        uvcVersion: null,
        message: reason,
      };
    },
    async startPreview() {
      return { ok: false, message: reason };
    },
    async stopPreview() {},
    async release() {},
    addAttachListener() {
      return () => {};
    },
    addDetachListener() {
      return () => {};
    },
    addPermissionListener() {
      return () => {};
    },
    addPumpErrorListener() {
      return () => {};
    },
  };
}

let api: UsbCameraApi;

if (isIOS) {
  api = buildStub(unavailableIOS);
} else if (isExpoGo) {
  api = buildStub(unavailableExpoGo);
} else {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("chalyb-uvc-camera");
    const Native = mod.default;
    api = {
      available: true,
      reason: null,
      PreviewView: mod.UsbCameraPreview,
      getCurrentDevice: () => Native.getCurrentDevice(),
      requestPermission: () => Native.requestPermission(),
      refresh: () => Native.refresh(),
      initialize: () => Native.initialize(),
      startPreview: (w, h, fps) => Native.startPreview(w, h, fps),
      stopPreview: () => Native.stopPreview(),
      release: () => Native.release(),
      addAttachListener: (h) => {
        const sub = Native.addListener("onAttach", h);
        return () => sub.remove();
      },
      addDetachListener: (h) => {
        const sub = Native.addListener("onDetach", h);
        return () => sub.remove();
      },
      addPermissionListener: (h) => {
        const sub = Native.addListener("onPermissionResult", h);
        return () => sub.remove();
      },
      addPumpErrorListener: (h) => {
        const sub = Native.addListener("onPumpError", h);
        return () => sub.remove();
      },
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? `${unavailableExpoGo} (load error: ${err.message})`
        : unavailableExpoGo;
    api = buildStub(message);
  }
}

export const usbCamera = api;
