!macro CleanupAtkDesktopShortcuts
  ; 兼容历史上可能遗留在当前用户桌面和公共桌面的快捷方式，避免覆盖安装后出现重复图标。
  SetShellVarContext current
  Delete "$DESKTOP\ATK Battery.lnk"
  Delete "$DESKTOP\atktool.lnk"
  SetShellVarContext all
  Delete "$DESKTOP\ATK Battery.lnk"
  Delete "$DESKTOP\atktool.lnk"
  SetShellVarContext all
!macroend

!macro customInit
  !insertmacro CleanupAtkDesktopShortcuts
!macroend

!macro customUnInstall
  !insertmacro CleanupAtkDesktopShortcuts
!macroend
