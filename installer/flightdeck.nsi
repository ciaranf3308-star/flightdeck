; FlightDeck Windows installer (NSIS 3)
; Per-user install — no admin rights, no UAC prompt.
; Installs to %LOCALAPPDATA%\Programs\FlightDeck with desktop + start-menu
; shortcuts that launch the app hidden (no console, no terminal).
;
; Build:  makensis /DVERSION=1.2.3 installer\flightdeck.nsi
;         (or run installer/build.sh on Linux)

!define APPNAME "FlightDeck"
!define COMPANY "FlightDeck"
!define WEBURL "https://github.com/ciaranf3308-star"

Name "${APPNAME}"
OutFile "/home/hatch/workspace/your_files/FlightDeck-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\${APPNAME}"
InstallDirRegKey HKCU "Software\${COMPANY}\${APPNAME}" "InstallDir"
RequestExecutionLevel user
Icon "flightdeck.ico"
UninstallIcon "flightdeck.ico"

!include "MUI2.nsh"
!define MUI_ABORTWARNING
!define MUI_ICON "flightdeck.ico"
!define MUI_UNICON "flightdeck.ico"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Launch FlightDeck now"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function LaunchApp
  Exec '"$WINDIR\System32\wscript.exe" "$INSTDIR\launch.vbs"'
FunctionEnd

Section "FlightDeck" SecMain
  ; Upgrades: stop a running backend first, or files are locked.
  IfFileExists "$INSTDIR\stop.vbs" 0 +2
    ExecWait '"$WINDIR\System32\wscript.exe" "$INSTDIR\stop.vbs"'
  SetOutPath "$INSTDIR"
  File /r "staging\FlightDeck\*.*"

  ; Shortcuts: wscript.exe runs the .vbs hidden — never a console window.
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" \
    "$WINDIR\System32\wscript.exe" '"$INSTDIR\launch.vbs"' \
    "$INSTDIR\flightdeck.ico" 0 SW_SHOWNORMAL "" "MSFS 2024 planning companion"
  SetOutPath "$INSTDIR" ; working dir for the shortcut
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" \
    "$WINDIR\System32\wscript.exe" '"$INSTDIR\launch.vbs"' \
    "$INSTDIR\flightdeck.ico" 0 SW_SHOWNORMAL "" "MSFS 2024 planning companion"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Uninstall.lnk" "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "Software\${COMPANY}\${APPNAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" \
    "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" \
    "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" \
    "Publisher" "${COMPANY}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" \
    "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" \
    "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" \
    "NoRepair" 1
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Silent update installs (/S): reopen the app when done.
  IfSilent 0 +2
    Exec '"$WINDIR\System32\wscript.exe" "$INSTDIR\launch.vbs"'
SectionEnd

Section "Uninstall"
  ; Stop a running backend first (best effort).
  ExecWait '"$WINDIR\System32\wscript.exe" //nologo //e:vbscript "$INSTDIR\stop.vbs"'
  Delete "$DESKTOP\${APPNAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APPNAME}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"
  DeleteRegKey HKCU "Software\${COMPANY}\${APPNAME}"
SectionEnd
