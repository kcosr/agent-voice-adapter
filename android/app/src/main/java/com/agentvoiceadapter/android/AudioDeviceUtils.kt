package com.agentvoiceadapter.android

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager

data class MicDeviceOption(
  val id: String,
  val label: String,
)

object AudioDeviceUtils {
  fun listInputDevices(context: Context): List<MicDeviceOption> {
    val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return emptyList()
    return audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).map { device ->
      MicDeviceOption(
        id = device.id.toString(),
        label = describeInputDevice(device),
      )
    }
  }

  fun findInputDevice(context: Context, id: Int): AudioDeviceInfo? {
    val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return null
    return audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).firstOrNull { it.id == id }
  }

  fun describeInputDevice(device: AudioDeviceInfo?): String {
    if (device == null) {
      return "unknown"
    }

    val typeName = when (device.type) {
      AudioDeviceInfo.TYPE_BUILTIN_MIC -> "Phone mic"
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Bluetooth headset mic"
      AudioDeviceInfo.TYPE_BLE_HEADSET -> "BLE headset mic"
      AudioDeviceInfo.TYPE_WIRED_HEADSET -> "Wired headset mic"
      AudioDeviceInfo.TYPE_USB_DEVICE -> "USB mic"
      AudioDeviceInfo.TYPE_USB_HEADSET -> "USB headset mic"
      AudioDeviceInfo.TYPE_TELEPHONY -> "Telephony mic"
      else -> "Input device"
    }

    val product = device.productName?.toString()?.trim().orEmpty()
    return if (product.isEmpty()) {
      "$typeName [id:${device.id}]"
    } else {
      "$typeName ($product) [id:${device.id}]"
    }
  }
}
