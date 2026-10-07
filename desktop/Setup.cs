using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Reflection;
using System.Windows.Forms;
class Setup {
 [STAThread] static void Main() {
  try {
   string target=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","Caidan");
   if(MessageBox.Show("将安装采单客户端并创建桌面快捷方式。\n安装位置："+target,"采单安装",MessageBoxButtons.OKCancel,MessageBoxIcon.Information)!=DialogResult.OK)return;
   foreach(var process in Process.GetProcessesByName("Caidan")) {
    try {if(process.MainModule.FileName.StartsWith(target,StringComparison.OrdinalIgnoreCase)){MessageBox.Show("请从托盘退出已安装的采单客户端后再安装。");return;}}catch{}
   }
   Directory.CreateDirectory(target);
   using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload"))
   using(var archive=new ZipArchive(stream,ZipArchiveMode.Read)) {
    foreach(var entry in archive.Entries) {
     string dest=Path.GetFullPath(Path.Combine(target,entry.FullName));
     if(!dest.StartsWith(target+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new Exception("安装包路径无效");
     if(String.IsNullOrEmpty(entry.Name)){Directory.CreateDirectory(dest);continue;}
     Directory.CreateDirectory(Path.GetDirectoryName(dest));entry.ExtractToFile(dest,true);
    }
   }
   string exe=Path.Combine(target,"Caidan.exe");
   Type shellType=Type.GetTypeFromProgID("WScript.Shell");dynamic shell=Activator.CreateInstance(shellType);
   foreach(string folder in new[]{Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),"Programs")}) {
    dynamic link=shell.CreateShortcut(Path.Combine(folder,"采单客户端.lnk"));link.TargetPath=exe;link.WorkingDirectory=target;link.IconLocation=exe+",0";link.Save();
   }
   if(MessageBox.Show("安装完成。是否立即打开？\n开机自启可在托盘图标右键菜单中设置。","采单安装",MessageBoxButtons.YesNo)==DialogResult.Yes)Process.Start(exe);
  }catch(Exception e){MessageBox.Show(e.Message,"安装失败",MessageBoxButtons.OK,MessageBoxIcon.Error);}
 }
}
