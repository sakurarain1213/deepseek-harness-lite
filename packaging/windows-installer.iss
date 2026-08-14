#ifndef SourceDir
  #error SourceDir must point to a prepared Windows release directory
#endif
#ifndef AppVersion
  #error AppVersion must be the release version
#endif
#ifndef OutputDir
  #error OutputDir must be the artifact output directory
#endif

[Setup]
AppId={{C725A2A2-58EA-4A31-9E4A-E24126413F37}
AppName=DeepSeek Harness Lite
AppVersion={#AppVersion}
AppPublisher=DeepSeek Harness Lite community
AppPublisherURL=https://github.com/sakurarain1213/deepseek-harness-lite
AppSupportURL=https://github.com/sakurarain1213/deepseek-harness-lite/issues
DefaultDirName={localappdata}\Programs\DeepSeek Harness Lite
DefaultGroupName=DeepSeek Harness Lite
DisableProgramGroupPage=yes
LicenseFile={#SourceDir}\LICENSE
OutputDir={#OutputDir}
OutputBaseFilename=deepseek-harness-lite-v{#AppVersion}-windows-x64-setup
Compression=lzma2/max
SolidCompression=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName=DeepSeek Harness Lite
WizardStyle=modern

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\DeepSeek Harness Lite Terminal"; Filename: "{cmd}"; Parameters: "/K set ""PATH={app};%PATH%"" && cd /d ""{%USERPROFILE}"" && echo Run: dsh-lite init --config ""{app}\examples\chat-only\lite.config.json"" --home .dsh-lite"; WorkingDir: "{%USERPROFILE}"
Name: "{userprograms}\DeepSeek Harness Lite README"; Filename: "{app}\README.md"

[Run]
Filename: "{cmd}"; Parameters: "/K set ""PATH={app};%PATH%"" && cd /d ""{%USERPROFILE}"" && echo Run: dsh-lite init --config ""{app}\examples\chat-only\lite.config.json"" --home .dsh-lite"; Description: "Open the DeepSeek Harness Lite terminal"; Flags: postinstall nowait skipifsilent unchecked
