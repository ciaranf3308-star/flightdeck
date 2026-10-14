' FlightDeck stop helper — used by the uninstaller.
' Tries the graceful /api/shutdown first, then force-stops only node processes
' whose command line belongs to this FlightDeck install.

Option Explicit

On Error Resume Next
Dim http, sh, ps
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
http.setTimeouts 2000, 2000, 2000, 2000
http.Open "POST", "http://127.0.0.1:8124/api/shutdown", False
http.Send
WScript.Sleep 1500

Set sh = CreateObject("WScript.Shell")
ps = "powershell -NoProfile -ExecutionPolicy Bypass -Command " & _
     Chr(34) & "Get-CimInstance Win32_Process -Filter 'Name=''node.exe'''" & _
     " | Where-Object { $_.CommandLine -like '*FlightDeck*dist\index.js*' }" & _
     " | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" & Chr(34)
sh.Run ps, 0, True
On Error GoTo 0
