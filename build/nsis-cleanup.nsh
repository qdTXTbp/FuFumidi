; ============================================================
; nsis-cleanup.nsh
; Purge stale FuFumidi uninstall registry entries before install.
;
; Root cause (electron-builder assistedInstaller.nsh):
;   The installer checks BOTH HKCU and HKLM uninstall keys to detect
;   a previous installation. If the same app was installed at different
;   privilege scopes over time (per-user -> HKCU, admin -> HKLM), a stale
;   entry remains in the OTHER scope. The installer then thinks BOTH a
;   per-user and a per-machine installation exist -> ambiguous state ->
;   prompts "overwrite / reinstall" on every install.
;
; Fix:
;   preInit is the earliest hook in .onInit (installer.nsi line 56),
;   running before electron-builder's install-mode detection.
;   Delete the FuFumidi uninstall key from every scope, so the installer
;   always starts from a clean "no previous install" state.
;
; Note: the GUID is deterministically derived from appId (com.fufumidi.app)
; by electron-builder and stays identical across versions.
; ============================================================

!macro preInit
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ee90ae64-4313-5a31-857b-d4c295bf71e7"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ee90ae64-4313-5a31-857b-d4c295bf71e7"
  DeleteRegKey HKLM "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\ee90ae64-4313-5a31-857b-d4c295bf71e7"
!macroend
