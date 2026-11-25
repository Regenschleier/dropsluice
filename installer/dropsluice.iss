; DropSluice 安装包脚本（Inno Setup 6）
;
; 用法：
;   1. node scripts/build-desktop.mjs      产出 dist\DropSluice.exe
;   2. 编译本文件（ISCC.exe 路径两处都可能，按实际取）：
;        & "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" installer\dropsluice.iss
;   3. 产物：dist\DropSluice-Setup-<版本>.exe
;
; 安装模式（重要）：
;   PrivilegesRequired=lowest + OverridesAllowed=dialog commandline
;   → 默认「只为我安装」，不弹 UAC，装进 %LOCALAPPDATA%\Programs\DropSluice。
;   → 想给这台电脑所有用户装的人，可以在向导里选「为所有用户安装」
;     （/VERYSILENT 时可传 /PRIVILEGESREQUIRED=admin），那时才写 Program Files。
;   → 为什么默认改成当前用户：1.0.6 及更早默认是 lowest，但升级时会沿用上次的安装目录
;     （UsePreviousAppDir=yes）。旧版一旦装在 D:\ 根或 Program Files 这类当前用户写不了的
;     地方，升级就会「创建目录失败：拒绝访问」（错误 5）然后整个回滚。现在
;     UsePreviousAppDir=no + 默认落在用户可写的 %LOCALAPPDATA%\Programs，这条故障不复现。
;
; 防火墙：需要管理员的那一步只在管理员安装模式里做；普通权限安装装完后由面板/说明文档
; 告诉用户怎么手动放行（netsh 一行命令）。

#define MyAppName "DropSluice"
; 版本号默认值；release.mjs 会用 ISCC 的 /DMyAppVersion=… 覆盖，保持和 scripts/version.mjs 一致
#ifndef MyAppVersion
  #define MyAppVersion "1.0.8"
#endif
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
; 不沿用上一次装过的目录：旧版可能落在 D:\ 根目录或 Program Files 这类
; 当前用户写不了的地方，沿用就是「创建目录失败：拒绝访问」然后整个回滚
; （1.0.6 用户升上来时踩到的就是这一条）。默认改到用户自己可写的位置。
UsePreviousAppDir=no
; 同理，也不沿用上一次「只为我安装 / 为所有用户安装」的选择。
UsePreviousPrivileges=no
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
