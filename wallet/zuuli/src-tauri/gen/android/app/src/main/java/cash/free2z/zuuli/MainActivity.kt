package cash.free2z.zuuli

import android.graphics.Color
import android.os.Bundle
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      // On three-button navigation Android may need an opaque-enough scrim
      // behind light controls; gesture navigation remains edge-to-edge.
      navigationBarStyle = SystemBarStyle.dark(Color.argb(0x80, 0x0A, 0x0A, 0x0F)),
    )
    super.onCreate(savedInstanceState)
    // ZUULI chrome is fixed-dark regardless of the device theme. Keep the
    // transparent edge-to-edge system bars legible on light-system devices.
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = false
      isAppearanceLightNavigationBars = false
    }
  }
}
