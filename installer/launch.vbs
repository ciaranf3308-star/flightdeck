' FlightDeck launcher — starts the backend hidden, waits for it, opens the app.
' Installed by the FlightDeck NSIS installer; run via the desktop shortcut.
' No console window, no terminal, no npm.

Option Explicit

Const API_URL = "http://127.0.0.1:8124"
' NB: VBScript Const initializers must be literals — a Const may not reference
' another Const (that is compile error 800A0415 "Expected literal constant").
Const HEALTH_URL = "http://127.0.0.1:8124/api/health"
Const MAX_WAIT_MS = 45000

Dim sh, fso, installDir, nodeExe, apiMain, profileDir, edgePath, chromePath

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' The shortcut sets the working directory to the install dir.
installDir = sh.CurrentDirectory
If Not fso.FolderExists(installDir & "\resources\api\dist") Then
  ' Fallback: resolve relative to this script.
  installDir = fso.GetParentFolderName(WScript.ScriptFullName)
End If

nodeExe = installDir & "\resources\node\node.exe"
apiMain = installDir & "\resources\api\dist\index.js"
profileDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\FlightDeck\webapp-profile"

If Not fso.FileExists(nodeExe) Then
  MsgBox "FlightDeck is damaged: node.exe is missing." & vbCrLf & installDir, vbCritical, "FlightDeck"
  WScript.Quit 1
End If
If Not fso.FileExists(apiMain) Then
  MsgBox "FlightDeck is damaged: the API bundle is missing." & vbCrLf & installDir, vbCritical, "FlightDeck"
  WScript.Quit 1
End If

' If the API is already running (e.g. launched twice), just open the window.
If ApiHealthy() Then
  OpenAppWindow
  WScript.Quit 0
End If

' Start the API hidden.
Dim env
Set env = sh.Environment("PROCESS")
env("FLIGHTDECK_PACKAGED") = "1"
sh.Run """" & nodeExe & """ """ & apiMain & """", 0, False

' Wait for the backend AND the frontend to become ready.
Dim waited, apiOk, webOk
waited = 0
apiOk = False
webOk = False
Do While waited < MAX_WAIT_MS
  WScript.Sleep 500
  waited = waited + 500
  If Not apiOk Then apiOk = ApiHealthy()
  If apiOk And Not webOk Then webOk = FrontendReady()
  If apiOk And webOk Then Exit Do
Loop

If Not apiOk Then
  MsgBox "FlightDeck's backend did not start within 45 seconds." & vbCrLf & _
         "Check that port 8124 is free and reinstall if the problem persists.", vbCritical, "FlightDeck"
  WScript.Quit 1
End If
If Not webOk Then
  MsgBox "FlightDeck's backend started, but the application files are missing or damaged." & vbCrLf & _
         "Reinstall FlightDeck to repair them.", vbCritical, "FlightDeck"
  WScript.Quit 1
End If

OpenAppWindow
WScript.Quit 0

Function ApiHealthy()
  On Error Resume Next
  Dim http
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 2000, 2000, 2000, 2000
  http.Open "GET", HEALTH_URL, False
  http.Send
  ApiHealthy = (Err.Number = 0 And http.Status = 200)
  On Error GoTo 0
End Function

' The frontend must serve real HTML, not an API error page. The 0.2.0
' installer 404'd every static file on Windows (path-separator bug), so the
' launcher now refuses to open a window on {"error":"Not found."}.
Function FrontendReady()
  On Error Resume Next
  Dim http
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 2000, 2000, 2000, 2000
  http.Open "GET", API_URL & "/", False
  http.Send
  FrontendReady = (Err.Number = 0 And http.Status = 200 _
    And InStr(1, http.responseText, "<div id=""root""", 1) > 0)
  On Error GoTo 0
End Function

Sub OpenAppWindow()
  On Error Resume Next
  Dim appUrl, launched
  appUrl = API_URL & "/"
  launched = False
  ' Prefer a dedicated app window (no browser chrome) via Edge, then Chrome.
  edgePath = sh.RegRead("HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe\")
  If Err.Number = 0 And edgePath <> "" Then
    sh.Run """" & edgePath & """ --app=" & appUrl & " --user-data-dir=""" & profileDir & """", 1, False
    launched = True
  Else
    Err.Clear
    chromePath = sh.RegRead("HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe\")
    If Err.Number = 0 And chromePath <> "" Then
      sh.Run """" & chromePath & """ --app=" & appUrl & " --user-data-dir=""" & profileDir & """", 1, False
      launched = True
    End If
  End If
  On Error GoTo 0
  If Not launched Then
    ' Fallback: default browser.
    sh.Run appUrl, 1, False
  End If
End Sub
