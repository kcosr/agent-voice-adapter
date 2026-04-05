package com.agentvoiceadapter.android

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.View
import android.view.Window
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView
import androidx.core.view.WindowInsetsControllerCompat

data class AppTheme(
  val id: String,
  val label: String,
  val isDark: Boolean,
  // Surfaces
  val background: Int,
  val surfaceContainer: Int,
  val surface: Int,
  val inputFill: Int,
  // Borders
  val borderSubtle: Int,
  val borderDefault: Int,
  val borderStrong: Int,
  // Text
  val textPrimary: Int,
  val textSecondary: Int,
  val textTertiary: Int,
  val textHint: Int,
  val textOnAccent: Int,
  // Header
  val headerBg: Int,
  val headerText: Int,
  val headerSubBg: Int,
  val headerSubText: Int,
  // Accent
  val accent: Int,
  val accentMuted: Int,
  val accentSubtle: Int,
  // Semantic
  val success: Int,
  val successSubtle: Int,
  val warning: Int,
  val warningSubtle: Int,
  val error: Int,
  val errorSubtle: Int,
  val errorMuted: Int,
  val info: Int,
  // Bubbles
  val bubbleAssistant: Int,
  val bubbleAssistantNoWait: Int,
  val bubbleUser: Int,
  val bubbleSystem: Int,
  val bubbleActiveBorder: Int,
  val bubbleAssistantText: Int,
  val bubbleAssistantHeader: Int,
  val bubbleAssistantNoWaitHeader: Int,
  val bubbleUserText: Int,
  val bubbleUserHeader: Int,
  val bubbleSystemText: Int,
  val bubbleSystemHeader: Int,
  // Link
  val linkColor: Int,
  // Recognition
  val recognitionBg: Int,
  val recognitionBorder: Int,
  val recognitionText: Int,
  // Status chips
  val chipDefault: Int,
  val chipText: Int,
  // Button states
  val activateActiveBg: Int,
  val activateActiveBorder: Int,
  val activateActiveIcon: Int,
  val activateInactiveBg: Int,
  val activateInactiveBorder: Int,
  val activateInactiveIcon: Int,
  val activateDisabledBg: Int,
  val activateDisabledBorder: Int,
  val activateDisabledIcon: Int,
  val voiceReadyBg: Int,
  val voiceReadyBorder: Int,
  val voiceReadyIcon: Int,
  val voiceNotReadyBg: Int,
  val voiceNotReadyBorder: Int,
  val voiceNotReadyIcon: Int,
  val voiceCancelBg: Int,
  val voiceCancelBorder: Int,
  val voiceCancelIcon: Int,
) {
  fun makeCardDrawable(density: Float): GradientDrawable = GradientDrawable().apply {
    shape = GradientDrawable.RECTANGLE
    cornerRadius = 16f * density
    setColor(surface)
    setStroke((1 * density).toInt().coerceAtLeast(1), borderSubtle)
  }

  fun makeInputDrawable(density: Float): GradientDrawable = GradientDrawable().apply {
    shape = GradientDrawable.RECTANGLE
    cornerRadius = 10f * density
    setColor(inputFill)
    setStroke((1 * density).toInt().coerceAtLeast(1), borderDefault)
  }

  fun makePrimaryButtonDrawable(density: Float): GradientDrawable = makeButtonDrawable(density)
  fun makeSecondaryButtonDrawable(density: Float): GradientDrawable = makeButtonDrawable(density)
  fun makeDestructiveButtonDrawable(density: Float): GradientDrawable = makeButtonDrawable(density)

  private fun makeButtonDrawable(density: Float): GradientDrawable = GradientDrawable().apply {
    shape = GradientDrawable.RECTANGLE
    cornerRadius = 12f * density
    setColor(recognitionBg)
    setStroke((1 * density).toInt().coerceAtLeast(1), recognitionBorder)
  }

  fun makeChatAreaDrawable(density: Float): GradientDrawable = GradientDrawable().apply {
    shape = GradientDrawable.RECTANGLE
    cornerRadius = 16f * density
    setColor(surfaceContainer)
    setStroke((1 * density).toInt().coerceAtLeast(1), borderSubtle)
  }

  fun makeStatusChipDrawable(density: Float, color: Int): GradientDrawable = GradientDrawable().apply {
    shape = GradientDrawable.RECTANGLE
    cornerRadius = 8f * density
    setColor(color)
  }

  fun makeRecognitionDrawable(density: Float): GradientDrawable = GradientDrawable().apply {
    shape = GradientDrawable.RECTANGLE
    cornerRadius = 12f * density
    setColor(recognitionBg)
    setStroke((1 * density).toInt().coerceAtLeast(1), recognitionBorder)
  }

  fun applyToSystemBars(window: Window) {
    window.statusBarColor = headerBg
    window.navigationBarColor = if (isDark) background else headerBg
    val controller = WindowInsetsControllerCompat(window, window.decorView)
    controller.isAppearanceLightStatusBars = false
    controller.isAppearanceLightNavigationBars = !isDark
  }

  fun styleHeaderBar(view: View) {
    view.setBackgroundColor(headerBg)
  }

  fun styleHeaderTitle(view: TextView) {
    view.setTextColor(headerText)
  }

  fun styleHeaderSubBar(view: TextView) {
    view.setBackgroundColor(headerSubBg)
    view.setTextColor(headerSubText)
  }

  fun stylePrimaryButton(button: Button, density: Float) {
    button.backgroundTintList = null
    button.background = makePrimaryButtonDrawable(density)
    button.setTextColor(recognitionText)
  }

  fun styleSecondaryButton(button: Button, density: Float) {
    button.backgroundTintList = null
    button.background = makeSecondaryButtonDrawable(density)
    button.setTextColor(recognitionText)
  }

  fun styleDestructiveButton(button: Button, density: Float) {
    button.backgroundTintList = null
    button.background = makeDestructiveButtonDrawable(density)
    button.setTextColor(recognitionText)
  }

  fun styleInput(input: EditText, density: Float) {
    input.background = makeInputDrawable(density)
    input.setTextColor(textPrimary)
    input.setHintTextColor(textHint)
  }

  fun styleSpinner(spinner: Spinner, density: Float) {
    spinner.background = makeInputDrawable(density)
  }

  fun styleSwitch(switch: Switch) {
    switch.setTextColor(textSecondary)
  }

  fun styleSectionLabel(tv: TextView) {
    tv.setTextColor(textTertiary)
  }

  fun styleSectionTitle(tv: TextView) {
    tv.setTextColor(textPrimary)
  }

  fun styleDivider(view: View) {
    view.setBackgroundColor(borderSubtle)
  }

  companion object {
    private const val PREFS_KEY = "selected_theme_id"

    fun save(context: Context, themeId: String) {
      context.getSharedPreferences("agent_voice_adapter_prefs", Context.MODE_PRIVATE)
        .edit()
        .putString(PREFS_KEY, themeId)
        .apply()
    }

    fun loadId(context: Context): String {
      return context.getSharedPreferences("agent_voice_adapter_prefs", Context.MODE_PRIVATE)
        .getString(PREFS_KEY, "slate_light")
        ?: "slate_light"
    }

    fun resolve(context: Context): AppTheme {
      val id = loadId(context)
      return ALL.firstOrNull { it.id == id } ?: ALL.first()
    }

    val ALL: List<AppTheme> = listOf(
      // ── Light: Slate ──
      AppTheme(
        id = "slate_light",
        label = "Slate Light",
        isDark = false,
        background = 0xFFF1F5F9.toInt(),
        surfaceContainer = 0xFFF8FAFC.toInt(),
        surface = 0xFFFFFFFF.toInt(),
        inputFill = 0xFFF8FAFC.toInt(),
        borderSubtle = 0xFFE2E8F0.toInt(),
        borderDefault = 0xFFCBD5E1.toInt(),
        borderStrong = 0xFF94A3B8.toInt(),
        textPrimary = 0xFF0F172A.toInt(),
        textSecondary = 0xFF334155.toInt(),
        textTertiary = 0xFF475569.toInt(),
        textHint = 0xFF94A3B8.toInt(),
        textOnAccent = 0xFFFFFFFF.toInt(),
        headerBg = 0xFF0F172A.toInt(),
        headerText = 0xFFFFFFFF.toInt(),
        headerSubBg = 0xFF1E293B.toInt(),
        headerSubText = 0xFFCBD5E1.toInt(),
        accent = 0xFF2563EB.toInt(),
        accentMuted = 0xFF93C5FD.toInt(),
        accentSubtle = 0xFFDBEAFE.toInt(),
        success = 0xFF16A34A.toInt(),
        successSubtle = 0xFFDCFCE7.toInt(),
        warning = 0xFFF59E0B.toInt(),
        warningSubtle = 0xFFFEF3C7.toInt(),
        error = 0xFFDC2626.toInt(),
        errorSubtle = 0xFFFEE2E2.toInt(),
        errorMuted = 0xFFFCA5A5.toInt(),
        info = 0xFF3B82F6.toInt(),
        bubbleAssistant = 0xFFE2E8F0.toInt(),
        bubbleAssistantNoWait = 0xFFFFF7ED.toInt(),
        bubbleUser = 0xFFDCFCE7.toInt(),
        bubbleSystem = 0xFFF1F5F9.toInt(),
        bubbleActiveBorder = 0xFFEA580C.toInt(),
        bubbleAssistantText = 0xFF0F172A.toInt(),
        bubbleAssistantHeader = 0xFF475569.toInt(),
        bubbleAssistantNoWaitHeader = 0xFF475569.toInt(),
        bubbleUserText = 0xFF052E16.toInt(),
        bubbleUserHeader = 0xFF166534.toInt(),
        bubbleSystemText = 0xFF334155.toInt(),
        bubbleSystemHeader = 0xFF64748B.toInt(),
        linkColor = 0xFF2563EB.toInt(),
        recognitionBg = 0xFFEFF6FF.toInt(),
        recognitionBorder = 0xFFBFDBFE.toInt(),
        recognitionText = 0xFF2563EB.toInt(),
        chipDefault = 0xFFE2E8F0.toInt(),
        chipText = 0xFF334155.toInt(),
        activateActiveBg = 0xFFDCFCE7.toInt(),
        activateActiveBorder = 0xFF16A34A.toInt(),
        activateActiveIcon = 0xFF166534.toInt(),
        activateInactiveBg = 0xFFF8FAFC.toInt(),
        activateInactiveBorder = 0xFF94A3B8.toInt(),
        activateInactiveIcon = 0xFF0F172A.toInt(),
        activateDisabledBg = 0xFFE2E8F0.toInt(),
        activateDisabledBorder = 0xFFCBD5E1.toInt(),
        activateDisabledIcon = 0xFF64748B.toInt(),
        voiceReadyBg = 0xFFDBEAFE.toInt(),
        voiceReadyBorder = 0xFF93C5FD.toInt(),
        voiceReadyIcon = 0xFF2563EB.toInt(),
        voiceNotReadyBg = 0xFFF1F5F9.toInt(),
        voiceNotReadyBorder = 0xFFCBD5E1.toInt(),
        voiceNotReadyIcon = 0xFF64748B.toInt(),
        voiceCancelBg = 0xFFFEE2E2.toInt(),
        voiceCancelBorder = 0xFFFCA5A5.toInt(),
        voiceCancelIcon = 0xFFB91C1C.toInt(),
      ),

      // ── Light: Warm Sand ──
      AppTheme(
        id = "warm_sand",
        label = "Warm Sand",
        isDark = false,
        background = 0xFFFAF7F2.toInt(),
        surfaceContainer = 0xFFFDF9F3.toInt(),
        surface = 0xFFFFFFFF.toInt(),
        inputFill = 0xFFFDF9F3.toInt(),
        borderSubtle = 0xFFE8E0D4.toInt(),
        borderDefault = 0xFFD4C9B8.toInt(),
        borderStrong = 0xFFA89F91.toInt(),
        textPrimary = 0xFF2C1810.toInt(),
        textSecondary = 0xFF5C4033.toInt(),
        textTertiary = 0xFF78685B.toInt(),
        textHint = 0xFFA89F91.toInt(),
        textOnAccent = 0xFFFFFFFF.toInt(),
        headerBg = 0xFF3E2723.toInt(),
        headerText = 0xFFFFF8E1.toInt(),
        headerSubBg = 0xFF4E342E.toInt(),
        headerSubText = 0xFFD7CCC8.toInt(),
        accent = 0xFFD97706.toInt(),
        accentMuted = 0xFFFBBF24.toInt(),
        accentSubtle = 0xFFFEF3C7.toInt(),
        success = 0xFF65A30D.toInt(),
        successSubtle = 0xFFECFCCB.toInt(),
        warning = 0xFFEA580C.toInt(),
        warningSubtle = 0xFFFFF7ED.toInt(),
        error = 0xFFDC2626.toInt(),
        errorSubtle = 0xFFFEE2E2.toInt(),
        errorMuted = 0xFFFCA5A5.toInt(),
        info = 0xFFD97706.toInt(),
        bubbleAssistant = 0xFFF5F0E5.toInt(),
        bubbleAssistantNoWait = 0xFFFFF7ED.toInt(),
        bubbleUser = 0xFFECFCCB.toInt(),
        bubbleSystem = 0xFFFAF7F2.toInt(),
        bubbleActiveBorder = 0xFFD97706.toInt(),
        bubbleAssistantText = 0xFF2C1810.toInt(),
        bubbleAssistantHeader = 0xFF78685B.toInt(),
        bubbleAssistantNoWaitHeader = 0xFF78685B.toInt(),
        bubbleUserText = 0xFF1A2E05.toInt(),
        bubbleUserHeader = 0xFF4D7C0F.toInt(),
        bubbleSystemText = 0xFF5C4033.toInt(),
        bubbleSystemHeader = 0xFF8D6E63.toInt(),
        linkColor = 0xFFD97706.toInt(),
        recognitionBg = 0xFFFEF3C7.toInt(),
        recognitionBorder = 0xFFFDE68A.toInt(),
        recognitionText = 0xFFB45309.toInt(),
        chipDefault = 0xFFE8E0D4.toInt(),
        chipText = 0xFF5C4033.toInt(),
        activateActiveBg = 0xFFECFCCB.toInt(),
        activateActiveBorder = 0xFF65A30D.toInt(),
        activateActiveIcon = 0xFF3F6212.toInt(),
        activateInactiveBg = 0xFFFDF9F3.toInt(),
        activateInactiveBorder = 0xFFA89F91.toInt(),
        activateInactiveIcon = 0xFF2C1810.toInt(),
        activateDisabledBg = 0xFFE8E0D4.toInt(),
        activateDisabledBorder = 0xFFD4C9B8.toInt(),
        activateDisabledIcon = 0xFF8D6E63.toInt(),
        voiceReadyBg = 0xFFFEF3C7.toInt(),
        voiceReadyBorder = 0xFFFDE68A.toInt(),
        voiceReadyIcon = 0xFFD97706.toInt(),
        voiceNotReadyBg = 0xFFFAF7F2.toInt(),
        voiceNotReadyBorder = 0xFFD4C9B8.toInt(),
        voiceNotReadyIcon = 0xFF8D6E63.toInt(),
        voiceCancelBg = 0xFFFEE2E2.toInt(),
        voiceCancelBorder = 0xFFFCA5A5.toInt(),
        voiceCancelIcon = 0xFFB91C1C.toInt(),
      ),

      // ── Dark: Midnight ──
      AppTheme(
        id = "midnight",
        label = "Midnight",
        isDark = true,
        background = 0xFF0B1121.toInt(),
        surfaceContainer = 0xFF111827.toInt(),
        surface = 0xFF1E293B.toInt(),
        inputFill = 0xFF0F172A.toInt(),
        borderSubtle = 0xFF1E293B.toInt(),
        borderDefault = 0xFF334155.toInt(),
        borderStrong = 0xFF475569.toInt(),
        textPrimary = 0xFFF1F5F9.toInt(),
        textSecondary = 0xFFCBD5E1.toInt(),
        textTertiary = 0xFF94A3B8.toInt(),
        textHint = 0xFF64748B.toInt(),
        textOnAccent = 0xFFFFFFFF.toInt(),
        headerBg = 0xFF0B1121.toInt(),
        headerText = 0xFFF1F5F9.toInt(),
        headerSubBg = 0xFF0F172A.toInt(),
        headerSubText = 0xFF94A3B8.toInt(),
        accent = 0xFF3B82F6.toInt(),
        accentMuted = 0xFF60A5FA.toInt(),
        accentSubtle = 0xFF1E3A5F.toInt(),
        success = 0xFF22C55E.toInt(),
        successSubtle = 0xFF0D2818.toInt(),
        warning = 0xFFF59E0B.toInt(),
        warningSubtle = 0xFF2B2306.toInt(),
        error = 0xFFF87171.toInt(),
        errorSubtle = 0xFF3E1318.toInt(),
        errorMuted = 0xFF7F1D1D.toInt(),
        info = 0xFF60A5FA.toInt(),
        bubbleAssistant = 0xFF1E293B.toInt(),
        bubbleAssistantNoWait = 0xFF2A1605.toInt(),
        bubbleUser = 0xFF0E2D18.toInt(),
        bubbleSystem = 0xFF111827.toInt(),
        bubbleActiveBorder = 0xFFF97316.toInt(),
        bubbleAssistantText = 0xFFE2E8F0.toInt(),
        bubbleAssistantHeader = 0xFF94A3B8.toInt(),
        bubbleAssistantNoWaitHeader = 0xFF94A3B8.toInt(),
        bubbleUserText = 0xFFF1F5F9.toInt(),
        bubbleUserHeader = 0xFF4ADE80.toInt(),
        bubbleSystemText = 0xFFCBD5E1.toInt(),
        bubbleSystemHeader = 0xFF64748B.toInt(),
        linkColor = 0xFF60A5FA.toInt(),
        recognitionBg = 0xFF0B1730.toInt(),
        recognitionBorder = 0xFF1E3A5F.toInt(),
        recognitionText = 0xFF60A5FA.toInt(),
        chipDefault = 0xFF1E293B.toInt(),
        chipText = 0xFFCBD5E1.toInt(),
        activateActiveBg = 0xFF0E2D18.toInt(),
        activateActiveBorder = 0xFF22C55E.toInt(),
        activateActiveIcon = 0xFF4ADE80.toInt(),
        activateInactiveBg = 0xFF1E293B.toInt(),
        activateInactiveBorder = 0xFF475569.toInt(),
        activateInactiveIcon = 0xFFF1F5F9.toInt(),
        activateDisabledBg = 0xFF1E293B.toInt(),
        activateDisabledBorder = 0xFF334155.toInt(),
        activateDisabledIcon = 0xFF64748B.toInt(),
        voiceReadyBg = 0xFF1E3A5F.toInt(),
        voiceReadyBorder = 0xFF3B82F6.toInt(),
        voiceReadyIcon = 0xFF60A5FA.toInt(),
        voiceNotReadyBg = 0xFF1E293B.toInt(),
        voiceNotReadyBorder = 0xFF334155.toInt(),
        voiceNotReadyIcon = 0xFF64748B.toInt(),
        voiceCancelBg = 0xFF3E1318.toInt(),
        voiceCancelBorder = 0xFF7F1D1D.toInt(),
        voiceCancelIcon = 0xFFF87171.toInt(),
      ),

      // ── Dark: Charcoal ──
      AppTheme(
        id = "charcoal",
        label = "Charcoal",
        isDark = true,
        background = 0xFF141414.toInt(),
        surfaceContainer = 0xFF1C1C1C.toInt(),
        surface = 0xFF262626.toInt(),
        inputFill = 0xFF1A1A1A.toInt(),
        borderSubtle = 0xFF2A2A2A.toInt(),
        borderDefault = 0xFF3D3D3D.toInt(),
        borderStrong = 0xFF555555.toInt(),
        textPrimary = 0xFFEEEEEE.toInt(),
        textSecondary = 0xFFBBBBBB.toInt(),
        textTertiary = 0xFF999999.toInt(),
        textHint = 0xFF666666.toInt(),
        textOnAccent = 0xFFFFFFFF.toInt(),
        headerBg = 0xFF141414.toInt(),
        headerText = 0xFFEEEEEE.toInt(),
        headerSubBg = 0xFF1A1A1A.toInt(),
        headerSubText = 0xFF999999.toInt(),
        accent = 0xFF3B82F6.toInt(),
        accentMuted = 0xFF60A5FA.toInt(),
        accentSubtle = 0xFF1E2D4A.toInt(),
        success = 0xFF22C55E.toInt(),
        successSubtle = 0xFF152E1B.toInt(),
        warning = 0xFFF59E0B.toInt(),
        warningSubtle = 0xFF2B2306.toInt(),
        error = 0xFFF87171.toInt(),
        errorSubtle = 0xFF3A1515.toInt(),
        errorMuted = 0xFF6B1A1A.toInt(),
        info = 0xFF60A5FA.toInt(),
        bubbleAssistant = 0xFF262626.toInt(),
        bubbleAssistantNoWait = 0xFF2A2010.toInt(),
        bubbleUser = 0xFF152E1B.toInt(),
        bubbleSystem = 0xFF1C1C1C.toInt(),
        bubbleActiveBorder = 0xFFF97316.toInt(),
        bubbleAssistantText = 0xFFDDDDDD.toInt(),
        bubbleAssistantHeader = 0xFFBDBDBD.toInt(),
        bubbleAssistantNoWaitHeader = 0xFFCC8A5A.toInt(),
        bubbleUserText = 0xFFEEEEEE.toInt(),
        bubbleUserHeader = 0xFF4ADE80.toInt(),
        bubbleSystemText = 0xFFBBBBBB.toInt(),
        bubbleSystemHeader = 0xFF666666.toInt(),
        linkColor = 0xFF60A5FA.toInt(),
        recognitionBg = 0xFF1E2D4A.toInt(),
        recognitionBorder = 0xFF2B4070.toInt(),
        recognitionText = 0xFF60A5FA.toInt(),
        chipDefault = 0xFF262626.toInt(),
        chipText = 0xFFBBBBBB.toInt(),
        activateActiveBg = 0xFF152E1B.toInt(),
        activateActiveBorder = 0xFF22C55E.toInt(),
        activateActiveIcon = 0xFF4ADE80.toInt(),
        activateInactiveBg = 0xFF262626.toInt(),
        activateInactiveBorder = 0xFF555555.toInt(),
        activateInactiveIcon = 0xFFEEEEEE.toInt(),
        activateDisabledBg = 0xFF262626.toInt(),
        activateDisabledBorder = 0xFF3D3D3D.toInt(),
        activateDisabledIcon = 0xFF666666.toInt(),
        voiceReadyBg = 0xFF1E2D4A.toInt(),
        voiceReadyBorder = 0xFF3B82F6.toInt(),
        voiceReadyIcon = 0xFF60A5FA.toInt(),
        voiceNotReadyBg = 0xFF262626.toInt(),
        voiceNotReadyBorder = 0xFF3D3D3D.toInt(),
        voiceNotReadyIcon = 0xFF666666.toInt(),
        voiceCancelBg = 0xFF3A1515.toInt(),
        voiceCancelBorder = 0xFF6B1A1A.toInt(),
        voiceCancelIcon = 0xFFF87171.toInt(),
      ),

      // ── Dark: AMOLED ──
      AppTheme(
        id = "amoled",
        label = "AMOLED Black",
        isDark = true,
        background = 0xFF000000.toInt(),
        surfaceContainer = 0xFF0A0A0A.toInt(),
        surface = 0xFF161616.toInt(),
        inputFill = 0xFF0A0A0A.toInt(),
        borderSubtle = 0xFF1A1A1A.toInt(),
        borderDefault = 0xFF2E2E2E.toInt(),
        borderStrong = 0xFF444444.toInt(),
        textPrimary = 0xFFE8E8E8.toInt(),
        textSecondary = 0xFFAAAAAA.toInt(),
        textTertiary = 0xFF888888.toInt(),
        textHint = 0xFF555555.toInt(),
        textOnAccent = 0xFFFFFFFF.toInt(),
        headerBg = 0xFF000000.toInt(),
        headerText = 0xFFE8E8E8.toInt(),
        headerSubBg = 0xFF0A0A0A.toInt(),
        headerSubText = 0xFF888888.toInt(),
        accent = 0xFF3B82F6.toInt(),
        accentMuted = 0xFF60A5FA.toInt(),
        accentSubtle = 0xFF111D33.toInt(),
        success = 0xFF22C55E.toInt(),
        successSubtle = 0xFF0A1F12.toInt(),
        warning = 0xFFF59E0B.toInt(),
        warningSubtle = 0xFF1A1505.toInt(),
        error = 0xFFF87171.toInt(),
        errorSubtle = 0xFF270E0E.toInt(),
        errorMuted = 0xFF501515.toInt(),
        info = 0xFF60A5FA.toInt(),
        bubbleAssistant = 0xFF161616.toInt(),
        bubbleAssistantNoWait = 0xFF1A1208.toInt(),
        bubbleUser = 0xFF0A1F12.toInt(),
        bubbleSystem = 0xFF0A0A0A.toInt(),
        bubbleActiveBorder = 0xFFF97316.toInt(),
        bubbleAssistantText = 0xFFD0D0D0.toInt(),
        bubbleAssistantHeader = 0xFF888888.toInt(),
        bubbleAssistantNoWaitHeader = 0xFF888888.toInt(),
        bubbleUserText = 0xFFE8E8E8.toInt(),
        bubbleUserHeader = 0xFF4ADE80.toInt(),
        bubbleSystemText = 0xFFAAAAAA.toInt(),
        bubbleSystemHeader = 0xFF555555.toInt(),
        linkColor = 0xFF60A5FA.toInt(),
        recognitionBg = 0xFF111D33.toInt(),
        recognitionBorder = 0xFF1E3050.toInt(),
        recognitionText = 0xFF60A5FA.toInt(),
        chipDefault = 0xFF161616.toInt(),
        chipText = 0xFFAAAAAA.toInt(),
        activateActiveBg = 0xFF0A1F12.toInt(),
        activateActiveBorder = 0xFF22C55E.toInt(),
        activateActiveIcon = 0xFF4ADE80.toInt(),
        activateInactiveBg = 0xFF161616.toInt(),
        activateInactiveBorder = 0xFF444444.toInt(),
        activateInactiveIcon = 0xFFE8E8E8.toInt(),
        activateDisabledBg = 0xFF161616.toInt(),
        activateDisabledBorder = 0xFF2E2E2E.toInt(),
        activateDisabledIcon = 0xFF555555.toInt(),
        voiceReadyBg = 0xFF111D33.toInt(),
        voiceReadyBorder = 0xFF3B82F6.toInt(),
        voiceReadyIcon = 0xFF60A5FA.toInt(),
        voiceNotReadyBg = 0xFF161616.toInt(),
        voiceNotReadyBorder = 0xFF2E2E2E.toInt(),
        voiceNotReadyIcon = 0xFF555555.toInt(),
        voiceCancelBg = 0xFF270E0E.toInt(),
        voiceCancelBorder = 0xFF501515.toInt(),
        voiceCancelIcon = 0xFFF87171.toInt(),
      ),

      // ── Dark: Ocean ──
      AppTheme(
        id = "ocean",
        label = "Ocean",
        isDark = true,
        background = 0xFF0A1628.toInt(),
        surfaceContainer = 0xFF0E1D33.toInt(),
        surface = 0xFF162544.toInt(),
        inputFill = 0xFF0C1A2E.toInt(),
        borderSubtle = 0xFF1A3050.toInt(),
        borderDefault = 0xFF264060.toInt(),
        borderStrong = 0xFF3B5575.toInt(),
        textPrimary = 0xFFE0F2FE.toInt(),
        textSecondary = 0xFFBAE6FD.toInt(),
        textTertiary = 0xFF7DD3FC.toInt(),
        textHint = 0xFF38BDF8.toInt(),
        textOnAccent = 0xFFFFFFFF.toInt(),
        headerBg = 0xFF0A1628.toInt(),
        headerText = 0xFFE0F2FE.toInt(),
        headerSubBg = 0xFF0C1A2E.toInt(),
        headerSubText = 0xFF7DD3FC.toInt(),
        accent = 0xFF0EA5E9.toInt(),
        accentMuted = 0xFF38BDF8.toInt(),
        accentSubtle = 0xFF0C2D48.toInt(),
        success = 0xFF2DD4BF.toInt(),
        successSubtle = 0xFF0D2D28.toInt(),
        warning = 0xFFFBBF24.toInt(),
        warningSubtle = 0xFF2B2306.toInt(),
        error = 0xFFF87171.toInt(),
        errorSubtle = 0xFF3E1318.toInt(),
        errorMuted = 0xFF7F1D1D.toInt(),
        info = 0xFF38BDF8.toInt(),
        bubbleAssistant = 0xFF162544.toInt(),
        bubbleAssistantNoWait = 0xFF1A2A15.toInt(),
        bubbleUser = 0xFF0D2D28.toInt(),
        bubbleSystem = 0xFF0E1D33.toInt(),
        bubbleActiveBorder = 0xFF38BDF8.toInt(),
        bubbleAssistantText = 0xFFE0F2FE.toInt(),
        bubbleAssistantHeader = 0xFF7DD3FC.toInt(),
        bubbleAssistantNoWaitHeader = 0xFF7DD3FC.toInt(),
        bubbleUserText = 0xFFE0F2FE.toInt(),
        bubbleUserHeader = 0xFF2DD4BF.toInt(),
        bubbleSystemText = 0xFFBAE6FD.toInt(),
        bubbleSystemHeader = 0xFF38BDF8.toInt(),
        linkColor = 0xFF38BDF8.toInt(),
        recognitionBg = 0xFF0C2D48.toInt(),
        recognitionBorder = 0xFF164E63.toInt(),
        recognitionText = 0xFF38BDF8.toInt(),
        chipDefault = 0xFF162544.toInt(),
        chipText = 0xFFBAE6FD.toInt(),
        activateActiveBg = 0xFF0D2D28.toInt(),
        activateActiveBorder = 0xFF2DD4BF.toInt(),
        activateActiveIcon = 0xFF5EEAD4.toInt(),
        activateInactiveBg = 0xFF162544.toInt(),
        activateInactiveBorder = 0xFF3B5575.toInt(),
        activateInactiveIcon = 0xFFE0F2FE.toInt(),
        activateDisabledBg = 0xFF162544.toInt(),
        activateDisabledBorder = 0xFF264060.toInt(),
        activateDisabledIcon = 0xFF38BDF8.toInt(),
        voiceReadyBg = 0xFF0C2D48.toInt(),
        voiceReadyBorder = 0xFF0EA5E9.toInt(),
        voiceReadyIcon = 0xFF38BDF8.toInt(),
        voiceNotReadyBg = 0xFF162544.toInt(),
        voiceNotReadyBorder = 0xFF264060.toInt(),
        voiceNotReadyIcon = 0xFF38BDF8.toInt(),
        voiceCancelBg = 0xFF3E1318.toInt(),
        voiceCancelBorder = 0xFF7F1D1D.toInt(),
        voiceCancelIcon = 0xFFF87171.toInt(),
      ),
    )
  }
}
