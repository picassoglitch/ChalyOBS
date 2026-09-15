package expo.modules.usbcamera

data class UvcCapability(
    val widthPx: Int,
    val heightPx: Int,
    val maxFps: Int,
    val format: String,
) {
    val label: String get() = "${widthPx}x${heightPx}@${maxFps} $format"
}
