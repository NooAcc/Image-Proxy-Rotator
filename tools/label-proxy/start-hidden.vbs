' Start label-proxy in the background without keeping a console window open.
' Double-click this file (or schedule it at logon). All output goes to run\label-proxy.log.

Option Explicit

Dim shell, fso, dir, nodeCheck, command, quote

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
quote = Chr(34)

' Fail with a visible message when Node.js is missing; otherwise the hidden
' window would swallow the "node is not recognized" error.
nodeCheck = shell.Run("cmd.exe /d /c where node >nul 2>&1", 0, True)
If nodeCheck <> 0 Then
  MsgBox "label-proxy needs Node.js 18 or newer." & vbCrLf & _
         "Install Node.js first, then run this file again.", _
         vbExclamation, "label-proxy"
  WScript.Quit 1
End If

command = quote & "node" & quote & " " & _
          quote & fso.BuildPath(dir, "background.mjs") & quote & " start"

' Window style 0 = hidden; bWaitOnReturn False = do not wait for the script to exit.
shell.Run command, 0, False
