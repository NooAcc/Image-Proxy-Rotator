' Optionally register label-proxy to start at Windows logon.
' Creates a Startup-folder shortcut that runs start-hidden.vbs via wscript,
' so no console window appears after you sign in.

Option Explicit

Dim shell, fso, dir, startupDir, linkPath, link, quote

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
startupDir = shell.SpecialFolders("Startup")
quote = Chr(34)

If startupDir = "" Then
  MsgBox "Could not find the Windows Startup folder.", vbCritical, "label-proxy"
  WScript.Quit 1
End If

linkPath = fso.BuildPath(startupDir, "Image Proxy Rotator - label-proxy.lnk")
Set link = shell.CreateShortcut(linkPath)
link.TargetPath = shell.ExpandEnvironmentStrings("%WINDIR%") & "\System32\wscript.exe"
link.Arguments = quote & fso.BuildPath(dir, "start-hidden.vbs") & quote
link.WorkingDirectory = dir
link.WindowStyle = 7
link.Description = "Start label-proxy in the background at logon"
link.Save

MsgBox "Auto-start installed." & vbCrLf & vbCrLf & linkPath & vbCrLf & _
       "It will take effect next time you sign in." & vbCrLf & _
       "If you move this repository, run this file again.", _
       vbInformation, "label-proxy"
