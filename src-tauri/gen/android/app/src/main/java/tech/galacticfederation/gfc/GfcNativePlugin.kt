package tech.galacticfederation.gfc

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class OpenUriArgs {
  lateinit var uri: String
  var mode: String = "r"
}

@InvokeArg
class SaveArgs {
  lateinit var path: String
  lateinit var name: String
  var mime: String = "application/octet-stream"
  /** "downloads" (Download/) or "movies" (Movies/GFC) */
  var collection: String = "downloads"
}

@InvokeArg
class ShareArgs {
  lateinit var text: String
  var path: String? = null
  var mime: String? = null
  var title: String = "Share"
}

/**
 * The Android side of GFC's file and sharing commands (called from Rust, src-tauri/src/files.rs):
 * open content:// files the pickers return, save into the shared Downloads / Movies folders,
 * and open the system share sheet with a file, text and link.
 */
@TauriPlugin
class GfcNativePlugin(private val activity: Activity) : Plugin(activity) {

  /** A file descriptor for a content:// (or file://) URI, plus its name, size and type. */
  @Command
  fun openUri(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(OpenUriArgs::class.java)
      val uri = Uri.parse(args.uri)
      val resolver = activity.contentResolver
      var name: String? = null
      var size = -1L
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
          if (!c.isNull(0)) name = c.getString(0)
          if (!c.isNull(1)) size = c.getLong(1)
        }
      }
      val pfd = resolver.openFileDescriptor(uri, args.mode) ?: throw Exception("couldn't open the file")
      if (size < 0) size = pfd.statSize
      val ret = JSObject()
      ret.put("name", name ?: uri.lastPathSegment ?: "upload.bin")
      ret.put("size", size)
      ret.put("mime", resolver.getType(uri) ?: "")
      ret.put("fd", pfd.detachFd()) // Rust owns (and closes) the descriptor now
      invoke.resolve(ret)
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "couldn't open the file")
    }
  }

  /** Copy a file from the app's cache into the shared Downloads (or Movies/GFC) folder. */
  @Command
  fun saveToCollection(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SaveArgs::class.java)
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) throw Exception("Saving needs Android 10 or newer.")
      val movies = args.collection == "movies"
      val folder = if (movies) "${Environment.DIRECTORY_MOVIES}/GFC" else Environment.DIRECTORY_DOWNLOADS
      val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, args.name)
        put(MediaStore.MediaColumns.MIME_TYPE, args.mime)
        put(MediaStore.MediaColumns.RELATIVE_PATH, folder)
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
      val collection = if (movies) MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        else MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
      val resolver = activity.contentResolver
      val item = resolver.insert(collection, values) ?: throw Exception("couldn't create the file")
      try {
        resolver.openOutputStream(item)!!.use { out -> File(args.path).inputStream().use { it.copyTo(out) } }
        values.clear()
        values.put(MediaStore.MediaColumns.IS_PENDING, 0)
        resolver.update(item, values, null, null)
      } catch (ex: Exception) {
        resolver.delete(item, null, null)
        throw ex
      }
      val ret = JSObject()
      ret.put("location", "$folder/${args.name}")
      invoke.resolve(ret)
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "couldn't save the file")
    }
  }

  /** The system share sheet: text (with the link in it) and, optionally, a file from the cache. */
  @Command
  fun share(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ShareArgs::class.java)
      val send = Intent(Intent.ACTION_SEND)
      send.putExtra(Intent.EXTRA_TEXT, args.text)
      val path = args.path
      if (path != null) {
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", File(path))
        send.type = args.mime ?: "video/mp4"
        send.putExtra(Intent.EXTRA_STREAM, uri)
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      } else {
        send.type = "text/plain"
      }
      activity.startActivity(Intent.createChooser(send, args.title))
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "couldn't open the share sheet")
    }
  }
}
