' Remove the logon auto-start shortcut created by install-autostart.vbs.

Option Explicit

Dim shell, fso, startupDir, linkPath

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
startupDir = shell.SpecialFolders("Startup")

If startupDir <> "" Then
  linkPath = fso.BuildPath(startupDir, "Image Proxy Rotator - label-proxy.lnk")
  If fso.FileExists(linkPath) Then
    fso.DeleteFile linkPath, True
  End If
End If

MsgBox "Auto-start removed.", vbInformation, "label-proxy"
