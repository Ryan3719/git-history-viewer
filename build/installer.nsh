!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\shell\GitHistoryViewer" "" "查看 Git 历史"
  DeleteRegValue HKCU "Software\Classes\Directory\shell\GitHistoryViewer" "Separator"
  WriteRegDWORD HKCU "Software\Classes\Directory\shell\GitHistoryViewer" "SeparatorBefore" 1
  WriteRegDWORD HKCU "Software\Classes\Directory\shell\GitHistoryViewer" "SeparatorAfter" 1
  WriteRegStr HKCU "Software\Classes\Directory\shell\GitHistoryViewer" "Icon" "$INSTDIR\Git History Viewer.exe,0"
  WriteRegStr HKCU "Software\Classes\Directory\shell\GitHistoryViewer\command" "" "$\"$INSTDIR\Git History Viewer.exe$\" --repo $\"%1$\""

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\GitHistoryViewer" "" "查看 Git 历史"
  DeleteRegValue HKCU "Software\Classes\Directory\Background\shell\GitHistoryViewer" "Separator"
  WriteRegDWORD HKCU "Software\Classes\Directory\Background\shell\GitHistoryViewer" "SeparatorBefore" 1
  WriteRegDWORD HKCU "Software\Classes\Directory\Background\shell\GitHistoryViewer" "SeparatorAfter" 1
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\GitHistoryViewer" "Icon" "$INSTDIR\Git History Viewer.exe,0"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\GitHistoryViewer\command" "" "$\"$INSTDIR\Git History Viewer.exe$\" --repo $\"%V$\""
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\GitHistoryViewer"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\GitHistoryViewer"
!macroend
