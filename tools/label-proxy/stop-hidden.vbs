' Stop the background label-proxy started by start-hidden.vbs.
' Runs the stop command without showing a console window.

Option Explicit

Dim shell, fso, dir, nodeCheck, command, quote

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
quote = Chr(34)

nodeCheck = shell.Run("cmd.exe /d /c where node >nul 2>&1", 0, True)
If nodeCheck <> 0 Then
  MsgBox "Cannot stop label-proxy: Node.js was not found." & vbCrLf & _
         "Stop it from Task Manager if it is still running.", _
         vbExclamation, "label-proxy"
  WScript.Quit 1
End If

command = quote & "node" & quote & " " & _
          quote & fso.BuildPath(dir, "background.mjs") & quote & " stop"
shell.Run command, 0, False
