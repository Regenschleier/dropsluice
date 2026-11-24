; DropSluice 安装包脚本（Inno Setup 6）
;
; 用法：
;   1. node scripts/build-desktop.mjs      产出 dist\DropSluice.exe
;   2. 编译本文件（ISCC.exe 路径两处都可能，按实际取）：
;        & "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" installer\dropsluice.iss
;   3. 产物：dist\DropSluice-Setup-<版本>.exe
;
; 安装模式（重要）：
;   PrivilegesRequired=lowest + OverridesAllowed=dialog
;   → 用户双击时可以选择「为这台电脑的所有用户安装」（会弹 UAC，装进 Program Files）
;     或「只为我安装」（不需要管理员，装进 %LOCALAPPDATA%\Programs）。
;   → 静默安装（/VERYSILENT）时沿用当前权限，因此在没有提权的环境里也能装、能测。
;
; 防火墙：需要管理员的那一步只在管理员安装模式里做；普通权限安装装完后由面板/说明文档
; 告诉用户怎么手动放行（netsh 一行命令）。

#define MyAppName "DropSluice"
#define MyAppVersion "1.0.1"
#define MyAppPublisher "DropSluice"
#define MyAppExeName "DropSluice.exe"
#define MyFirewallRule "DropSluice"
#define MyPort "18888"

[Setup]
AppId={{8F2C1B7A-4D3E-4A9C-9C21-6B7E5D2A1F30}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=DropSluice-Setup-{#MyAppVersion}
SetupIconFile=..\build\assets\dropsluice.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline
CloseApplications=yes
RestartApplications=no

[Languages]
; 简体中文语言包不在 Inno 自带列表里，由 scripts/fetch-inno-chinese.mjs 抓到 build\tools\
Name: "chs"; MessagesFile: "..\build\tools\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "在桌面放一个快捷方式"; GroupDescription: "附加任务："
Name: "firewall"; Description: "放行 Windows 防火墙（端口 {#MyPort}）——不做这步手机可能连不上"; GroupDescription: "附加任务："; Check: IsAdminMode

[Files]
Source: "..\dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\desktop\使用说明.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; 放行防火墙：TCP 18888，仅限本地子网（同一 Wi-Fi/局域网），公网连不进来
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#MyFirewallRule}"""; Flags: runhidden waituntilterminated; Tasks: firewall; Check: IsAdminMode
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""{#MyFirewallRule}"" dir=in action=allow protocol=TCP localport={#MyPort} profile=private,public remoteip=localsubnet"; Flags: runhidden waituntilterminated; Tasks: firewall; Check: IsAdminMode

Filename: "{app}\{#MyAppExeName}"; Description: "现在启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#MyFirewallRule}"""; Flags: runhidden waituntilterminated; RunOnceId: "DelFirewallRule"

[Code]
{ 防火墙那两步只有管理员安装模式才有权限做 }
function IsAdminMode: Boolean;
begin
  Result := IsAdminInstallMode;
end;
