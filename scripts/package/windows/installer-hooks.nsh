; Copying over an older runtime leaves stale node_modules files resolvable by Node.
; Remove only the manifest-marked bundled runtime, never the install folder or app data.
!macro RemovePreviousRuntime
  ${If} ${FileExists} "$INSTDIR\runtime\MANIFEST.json"
  ${AndIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
    !insertmacro CheckIfAppIsRunning "$INSTDIR\runtime\node\bin\node.exe" "${PRODUCTNAME}"
    !insertmacro CheckIfAppIsRunning "$INSTDIR\runtime\bin\engram.exe" "${PRODUCTNAME}"
    Push $0
    ; NSIS RMDir /r follows junctions. Windows rd removes the links instead.
    ; Pass the path through a process-local environment value: cmd expands it only
    ; once, preserving literal %NAME% in paths. Disable AutoRun and delayed expansion.
    System::Call 'kernel32::SetEnvironmentVariableW(w "GENTLE_DOT_RUNTIME_CLEANUP", w "$INSTDIR\runtime") i .r0'
    ${If} $0 != 0
      nsExec::ExecToLog '"$SYSDIR\cmd.exe" /d /v:off /c rd /s /q "%GENTLE_DOT_RUNTIME_CLEANUP%" >NUL 2>&1'
      Pop $0
      System::Call 'kernel32::SetEnvironmentVariableW(w "GENTLE_DOT_RUNTIME_CLEANUP", p 0)'
    ${Else}
      StrCpy $0 "error"
    ${EndIf}
    ${If} $0 != 0
    ${OrIf} ${FileExists} "$INSTDIR\runtime\*.*"
      DetailPrint "The previous runtime could not be removed completely. Close programs using it and retry."
      MessageBox MB_OK|MB_ICONSTOP "The previous runtime could not be removed completely. Close programs using it and retry." /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro RemovePreviousRuntime
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro RemovePreviousRuntime
!macroend
