package tech.galacticfederation.gfc

import android.graphics.Color
import android.os.Bundle
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Black system bars with light icons, like the app
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.BLACK),
      navigationBarStyle = SystemBarStyle.dark(Color.BLACK),
    )
    super.onCreate(savedInstanceState)
    // Keep the web view clear of the status bar, notch, gesture bar and the keyboard:
    // padding the content by those insets resizes the page, so a focused field stays visible.
    val content = findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }
}
