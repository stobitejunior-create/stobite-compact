; Inno Setup script -> dist\Stobite-Compact-Setup.exe
; Built automatically by .github/workflows/build.yml (or run: iscc installer\windows.iss)
#define AppName "Stobite Compact"
#define AppVersion GetEnv("APP_VERSION")
#if AppVersion == ""
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId={{8C4C2E61-3B7A-4E0B-9C7D-5A1E2F7B9D10}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Stobite
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
OutputDir=..\dist
OutputBaseFilename=Stobite-Compact-Setup
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\{#AppName}.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "..\dist\{#AppName}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppName}.exe"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppName}.exe"; Tasks: desktopicon

[Run]
; let phones on the church Wi-Fi reach the remote (port 8730) and talk to the WING (UDP 2222/2223)
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""Stobite Compact Remote"" dir=in action=allow protocol=TCP localport=8730 profile=private,domain"; Flags: runhidden
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""Stobite Compact WING"" dir=in action=allow program=""{app}\{#AppName}.exe"" protocol=UDP profile=private,domain"; Flags: runhidden
Filename: "{app}\{#AppName}.exe"; Description: "Open {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""Stobite Compact Remote"""; Flags: runhidden; RunOnceId: "fwremote"
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""Stobite Compact WING"""; Flags: runhidden; RunOnceId: "fwwing"
