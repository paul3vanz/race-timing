package expo.modules.volumekeys

import android.content.Context
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Turns the hardware volume buttons into finish-line taps.
//
// A tiny focusable view is added to the activity's content root and takes
// keyboard focus. Key events are dispatched down the view hierarchy to the
// focused view *before* the window's default handling, so returning `true`
// for the volume keys here consumes them: the media volume doesn't change and
// the system volume slider never appears. That's what makes this safe to use
// as a tap button, unlike just listening for volume changes.
class VolumeKeysView(
  context: Context,
  private val onVolumeKey: (direction: String, at: Long) -> Unit,
) : View(context) {

  init {
    isFocusable = true
    isFocusableInTouchMode = true
  }

  private fun isVolumeKey(keyCode: Int) =
    keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN

  override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
    if (isVolumeKey(keyCode)) {
      // Holding a button auto-repeats; only the first press is a tap.
      if ((event?.repeatCount ?: 0) == 0) {
        val direction = if (keyCode == KeyEvent.KEYCODE_VOLUME_UP) "up" else "down"
        // Stamped here, as close to the physical press as we can get, so the
        // time doesn't include the hop across to JS.
        onVolumeKey(direction, System.currentTimeMillis())
      }
      return true
    }
    return super.onKeyDown(keyCode, event)
  }

  override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
    if (isVolumeKey(keyCode)) return true
    return super.onKeyUp(keyCode, event)
  }
}

class VolumeKeysModule : Module() {
  private var listenerView: VolumeKeysView? = null

  override fun definition() = ModuleDefinition {
    Name("VolumeKeys")

    Events("onVolumeKey")

    // Safe to call repeatedly: re-requests focus if the view already exists
    // (focus can be lost to a text field or another window).
    Function("startListening") {
      val activity = appContext.currentActivity ?: return@Function false

      activity.runOnUiThread {
        val existing = listenerView
        if (existing != null) {
          existing.requestFocus()
        } else {
          val root = activity.findViewById<ViewGroup>(android.R.id.content)
          val view = VolumeKeysView(activity) { direction, at ->
            sendEvent("onVolumeKey", mapOf("direction" to direction, "at" to at.toDouble()))
          }
          // 1x1 so it never intercepts touches meant for the app underneath.
          root.addView(view, ViewGroup.LayoutParams(1, 1))
          view.requestFocus()
          listenerView = view
        }
      }
      return@Function true
    }

    Function("stopListening") {
      val activity = appContext.currentActivity ?: return@Function null
      activity.runOnUiThread {
        listenerView?.let { view -> (view.parent as? ViewGroup)?.removeView(view) }
        listenerView = null
      }
      return@Function null
    }

    OnActivityEntersForeground {
      listenerView?.requestFocus()
    }
  }
}
